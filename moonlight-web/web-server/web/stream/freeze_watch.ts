import { StreamAudioDiagnostics } from "./index.js"

// FreezeWatcher — always-on freeze forensics.
//
// The stats overlay only samples while it is visible (2s granularity) and only
// sees decoder-side freezes (inbound-rtp freezeCount). That leaves two blind
// spots that made past freeze hunts guesswork:
//   1. Freezes that happen with the overlay closed are never attributed.
//   2. In direct-render mode (useVideoWorker=false, the default) a main-thread
//      stall freezes the canvas WITHOUT moving freezeCount — the decoder keeps
//      delivering frames that nobody draws.
//
// This watcher runs for the whole stream session and detects both:
//   - "video-freeze": inbound-rtp freezeCount increments (decoder-side gap —
//     network loss, sender gap, or decode stall)
//   - "render-stall": a requestAnimationFrame gap > RENDER_STALL_MS (main
//     thread / compositor stalled; user-visible freeze in direct-render mode)
//
// Every event is classified from 1Hz getStats deltas and reported through a
// callback — the page sends them to the server console via ClientLog (works
// without devtools, which the Tesla browser doesn't have) and shows them in
// the stats overlay.
//
// Cost when nothing freezes: one getStats()/s + one empty rAF callback per
// frame — negligible next to the ~100 audio DataChannel messages/s the main
// thread already handles.

export type FreezeWatchEvent = {
    /** ms since session start (performance.now() based) */
    atMs: number
    kind: "video-freeze" | "render-stall"
    durationMs: number
    cause: string
    detail: string
}

export type FreezeWatchSummary = {
    videoFreezes: number
    renderStalls: number
    totalFreezeMs: number
    byCause: Record<string, number>
    lastEvent: FreezeWatchEvent | null
}

type StatsSample = {
    at: number
    freezeCount: number
    totalFreezesDuration: number
    packetsLost: number
    nackCount: number
    pliCount: number
    framesReceived: number
    framesDecoded: number
    framesDropped: number
    keyFramesDecoded: number
    totalDecodeTime: number
    jitter: number
    jitterBufferDelay: number
    jitterBufferEmittedCount: number
    fecPacketsReceived: number
    fecPacketsDiscarded: number
    audioUnderruns: number
}

const SAMPLE_INTERVAL_MS = 1000
/** rAF gap above this is reported as a render stall (a 60Hz frame is ~16.7ms). */
const RENDER_STALL_MS = 250
/** Minimum spacing between render-stall reports so a stall storm can't flood the log. */
const RENDER_STALL_REPORT_COOLDOWN_MS = 3000

export class FreezeWatcher {
    private peerGetter: () => RTCPeerConnection | null
    private audioDiagGetter: (() => StreamAudioDiagnostics | null) | null = null
    private audioStatsPoller: (() => void) | null = null
    private eventCallback: ((event: FreezeWatchEvent, summary: FreezeWatchSummary) => void) | null = null

    private intervalId: ReturnType<typeof setInterval> | null = null
    private rafId: number = 0
    private running = false
    private statsInFlight = false

    private startedAt = 0
    private prev: StatsSample | null = null

    // Rolling baselines (EMA) for spike detection
    private emaFrameRate = 0        // framesReceived per second
    private emaDecodeMsPerFrame = 0
    private emaJbDelayMs = 0        // avg jitter-buffer delay per emitted frame

    // rAF heartbeat state
    private lastRafAt = 0
    private maxRafGapMs = 0         // max gap since last stats tick (event detail)
    private lastRenderStallReportAt = 0

    // Session totals
    private videoFreezes = 0
    private renderStalls = 0
    private totalFreezeMs = 0
    private byCause: Record<string, number> = {}
    private lastEvent: FreezeWatchEvent | null = null

    constructor(peerGetter: () => RTCPeerConnection | null) {
        this.peerGetter = peerGetter
        this.rafTick = this.rafTick.bind(this)
        this.onVisibilityChange = this.onVisibilityChange.bind(this)
    }

    // rAF is suspended while the page is hidden, so without this reset the
    // first tick after the page becomes visible again would measure the whole
    // hidden period as one giant "stall" (the in-tick document.hidden check
    // never runs while hidden — no ticks fire there).
    private onVisibilityChange() {
        this.lastRafAt = 0
        this.maxRafGapMs = 0
    }

    /** Audio diagnostics let events flag concurrent audio underruns — the signature of a whole-renderer stall. */
    setAudioDiagnosticsGetter(getter: () => StreamAudioDiagnostics | null) {
        this.audioDiagGetter = getter
    }

    /** Called once per tick so the audio worklet posts fresh underrun counters (they're push-based). */
    setAudioStatsPoller(poller: () => void) {
        this.audioStatsPoller = poller
    }

    onEvent(callback: (event: FreezeWatchEvent, summary: FreezeWatchSummary) => void) {
        this.eventCallback = callback
    }

    start() {
        if (this.running) return
        this.running = true
        this.startedAt = performance.now()
        this.lastRafAt = 0
        document.addEventListener("visibilitychange", this.onVisibilityChange)
        this.intervalId = setInterval(() => void this.sampleTick(), SAMPLE_INTERVAL_MS)
        this.rafId = requestAnimationFrame(this.rafTick)
    }

    stop() {
        this.running = false
        document.removeEventListener("visibilitychange", this.onVisibilityChange)
        if (this.intervalId) {
            clearInterval(this.intervalId)
            this.intervalId = null
        }
        if (this.rafId) {
            cancelAnimationFrame(this.rafId)
            this.rafId = 0
        }
    }

    getSummary(): FreezeWatchSummary {
        return {
            videoFreezes: this.videoFreezes,
            renderStalls: this.renderStalls,
            totalFreezeMs: this.totalFreezeMs,
            byCause: this.byCause,
            lastEvent: this.lastEvent,
        }
    }

    /** One-line summary for the stats overlay / periodic dumps. */
    getSummaryLine(): string {
        const total = this.videoFreezes + this.renderStalls
        if (total === 0) return "none"
        const causes = Object.keys(this.byCause)
            .sort((a, b) => this.byCause[b] - this.byCause[a])
            .map((cause) => `${cause}=${this.byCause[cause]}`)
            .join(", ")
        return `${this.videoFreezes} video / ${this.renderStalls} render, ${Math.round(this.totalFreezeMs)} ms total (${causes})`
    }

    getLastEventLine(): string {
        const e = this.lastEvent
        if (!e) return "—"
        const ageS = ((performance.now() - this.startedAt - e.atMs) / 1000).toFixed(0)
        return `${e.kind} ${Math.round(e.durationMs)} ms, ${e.cause}, ${ageS}s ago`
    }

    // -- rAF heartbeat: detects main-thread / compositor stalls ---------------

    private rafTick(now: number) {
        if (!this.running) return
        this.rafId = requestAnimationFrame(this.rafTick)

        // Don't measure across hidden periods — rAF legitimately pauses there.
        if (document.hidden) {
            this.lastRafAt = 0
            return
        }

        if (this.lastRafAt > 0) {
            const gap = now - this.lastRafAt
            if (gap > this.maxRafGapMs) this.maxRafGapMs = gap

            if (gap >= RENDER_STALL_MS && now - this.lastRenderStallReportAt >= RENDER_STALL_REPORT_COOLDOWN_MS) {
                this.lastRenderStallReportAt = now
                this.emitEvent({
                    atMs: now - this.startedAt,
                    kind: "render-stall",
                    durationMs: gap,
                    cause: "main-thread-stall",
                    detail: `rAF gap ${gap.toFixed(0)} ms`,
                })
            }
        }
        this.lastRafAt = now
    }

    // -- 1Hz stats sampling: detects decoder-side freezes and classifies them -

    private async sampleTick() {
        if (!this.running || this.statsInFlight) return
        const peer = this.peerGetter()
        if (!peer || peer.connectionState === "closed") return

        // Ask the worklet to post fresh underrun counters; the value lands in
        // the audio diagnostics before the NEXT tick reads it (1s lag is fine).
        this.audioStatsPoller?.()

        this.statsInFlight = true
        let stats: RTCStatsReport
        try {
            stats = await peer.getStats()
        } catch {
            this.statsInFlight = false
            return
        }
        this.statsInFlight = false
        if (!this.running) return

        let sample: StatsSample | null = null
        stats.forEach((report: any) => {
            if (report.type === "inbound-rtp" && report.kind === "video") {
                sample = {
                    at: performance.now(),
                    freezeCount: report.freezeCount ?? 0,
                    totalFreezesDuration: report.totalFreezesDuration ?? 0,
                    packetsLost: report.packetsLost ?? 0,
                    nackCount: report.nackCount ?? 0,
                    pliCount: report.pliCount ?? 0,
                    framesReceived: report.framesReceived ?? 0,
                    framesDecoded: report.framesDecoded ?? 0,
                    framesDropped: report.framesDropped ?? 0,
                    keyFramesDecoded: report.keyFramesDecoded ?? 0,
                    totalDecodeTime: report.totalDecodeTime ?? 0,
                    jitter: report.jitter ?? 0,
                    jitterBufferDelay: report.jitterBufferDelay ?? 0,
                    jitterBufferEmittedCount: report.jitterBufferEmittedCount ?? 0,
                    fecPacketsReceived: report.fecPacketsReceived ?? 0,
                    fecPacketsDiscarded: report.fecPacketsDiscarded ?? 0,
                    audioUnderruns: this.audioDiagGetter?.()?.underruns ?? 0,
                }
            }
        })
        if (!sample) return
        const cur: StatsSample = sample

        const prev = this.prev
        this.prev = cur
        if (!prev) return

        // Track/SSRC reset (e.g. reconnection) — counters went backwards, resync.
        if (cur.freezeCount < prev.freezeCount || cur.framesReceived < prev.framesReceived) {
            this.emaFrameRate = 0
            this.emaDecodeMsPerFrame = 0
            this.emaJbDelayMs = 0
            this.maxRafGapMs = 0
            return
        }

        const elapsedS = Math.max(0.001, (cur.at - prev.at) / 1000)
        const rxRate = (cur.framesReceived - prev.framesReceived) / elapsedS
        const decodedDelta = cur.framesDecoded - prev.framesDecoded
        const decodeMsPerFrame = decodedDelta > 0
            ? ((cur.totalDecodeTime - prev.totalDecodeTime) / decodedDelta) * 1000
            : 0
        // Avg time frames spent in the jitter buffer this window — the direct
        // signature of a network delay burst (packets late but not lost).
        const jbEmittedDelta = cur.jitterBufferEmittedCount - prev.jitterBufferEmittedCount
        const jbAvgMs = jbEmittedDelta > 0
            ? ((cur.jitterBufferDelay - prev.jitterBufferDelay) / jbEmittedDelta) * 1000
            : 0

        const freezeDelta = cur.freezeCount - prev.freezeCount
        const rafGapMs = this.maxRafGapMs
        this.maxRafGapMs = 0

        if (freezeDelta > 0) {
            const freezeMs = Math.max(0, (cur.totalFreezesDuration - prev.totalFreezesDuration) * 1000)
            const lostDelta = cur.packetsLost - prev.packetsLost
            const nackDelta = cur.nackCount - prev.nackCount
            const pliDelta = cur.pliCount - prev.pliCount
            const keyDelta = cur.keyFramesDecoded - prev.keyFramesDecoded
            const underrunDelta = cur.audioUnderruns - prev.audioUnderruns
            const rxDropped = this.emaFrameRate > 0 && rxRate < this.emaFrameRate * 0.5
            // Frames arriving in a catch-up burst (well above baseline) right at
            // a freeze means the downlink paused and then flushed — the cellular
            // radio micro-outage signature (handover/DRX pause: nothing is lost,
            // RTCP's heavily-smoothed jitter barely moves, the pipe just stops
            // for 100-300ms and then bursts). Confirmed on Tesla 2026-07-15:
            // rx spiked to 66-69/s (avg 57) with 0 loss and a healthy rAF.
            // Threshold 1.05: this flag is only consulted DURING a freeze tick,
            // where any rx meaningfully above baseline means delivery caught up
            // within the window — the link-stall signature by definition. Two
            // real catch-up bursts straddled earlier thresholds (67/s vs a
            // 66.7 cutoff at 1.15; 64/s vs 64.9 at 1.10), landing in
            // "unattributed". 1.05 still clears 1Hz sampling noise (~±2
            // frames at 60fps ≈ 1.03).
            const rxBurst = this.emaFrameRate > 0 && rxRate > this.emaFrameRate * 1.05
            const decodeSpike = this.emaDecodeMsPerFrame > 0
                && decodeMsPerFrame > Math.max(this.emaDecodeMsPerFrame * 2, this.emaDecodeMsPerFrame + 8)
            // Frames waited noticeably longer than usual in the jitter buffer:
            // a delay burst (late packets, not lost). With jitterBufferMs=0
            // this is the typical signature of short "clean" freezes.
            const jbSpike = this.emaJbDelayMs > 0
                && jbAvgMs > Math.max(this.emaJbDelayMs * 2, this.emaJbDelayMs + 20)

            // Priority order matters: loss explains rx gaps and decode spikes
            // (waiting for retransmit/IDR), so check it first.
            let cause: string
            if (lostDelta > 0 || pliDelta > 0) {
                cause = "packet-loss"
            } else if (nackDelta > 0) {
                // A retransmit was requested AND recovered (packetsLost never
                // moved): the freeze is pure recovery latency — the reference
                // chain stalls for ~RTT while late frames get discarded.
                // Remedy: jitterBufferMs ≳ 2×RTT hides these entirely.
                cause = "nack-recovery"
            } else if (keyDelta > 0) {
                // A keyframe arrived that the browser never asked for (no
                // PLI, no loss on the WebRTC leg): the Sunshine→streamer leg
                // dropped a frame and moonlight-common requested recovery.
                // Matches streamer-side "Network dropped 1 frame" log lines
                // (Tesla field 2026-07-16). Remedy is host-side: RFI
                // capability shortens these to a single-frame gap.
                cause = "host-frame-drop"
            } else if (rxDropped) {
                cause = "receive-gap" // sender/encoder produced no frames — host-side or uplink stall
            } else if (jbSpike) {
                cause = "network-jitter" // delay burst absorbed by the jitter buffer — raise jitterBufferMs to hide these
            } else if (decodeSpike) {
                cause = "decode-spike"
            } else if (rafGapMs >= 200) {
                cause = "main-thread-stall" // renderer stalled — rAF gap is direct evidence
            } else if (rxBurst || underrunDelta > 0) {
                // Downlink micro-outage: audio (same radio link) drains and
                // underruns and/or video catches up in a burst, while the
                // renderer itself (rAF) stayed healthy. Remedy: buffer depth
                // (video jitterBufferMs, audio worklet prime), not CPU.
                cause = "link-stall"
            } else {
                cause = "unattributed"
            }

            const flags: string[] = []
            if (rafGapMs >= 200) flags.push(`rafGap=${rafGapMs.toFixed(0)}ms`)
            if (underrunDelta > 0) flags.push(`audioUnderruns=+${underrunDelta}`)

            const detail =
                `lost=+${lostDelta} nack=+${nackDelta} pli=+${pliDelta} keyframes=+${keyDelta}` +
                ` rx=${rxRate.toFixed(0)}/s(avg ${this.emaFrameRate.toFixed(0)})` +
                ` dropped=+${cur.framesDropped - prev.framesDropped}` +
                ` decode=${decodeMsPerFrame.toFixed(1)}ms(avg ${this.emaDecodeMsPerFrame.toFixed(1)})` +
                ` jb=${jbAvgMs.toFixed(1)}ms(avg ${this.emaJbDelayMs.toFixed(1)})` +
                ` jitter=${(cur.jitter * 1000).toFixed(0)}ms` +
                ` fecRx=+${cur.fecPacketsReceived - prev.fecPacketsReceived}` +
                (flags.length > 0 ? ` ${flags.join(" ")}` : "")

            this.totalFreezeMs += freezeMs
            this.emitEvent({
                atMs: cur.at - this.startedAt,
                kind: "video-freeze",
                durationMs: freezeDelta > 0 ? freezeMs / freezeDelta : freezeMs,
                cause,
                detail: `${freezeDelta} freeze(s), ${detail}`,
            })
        }

        // Update rolling baselines AFTER classification so a freeze interval
        // doesn't poison its own baseline.
        if (rxRate > 0) {
            this.emaFrameRate = this.emaFrameRate === 0 ? rxRate : this.emaFrameRate * 0.8 + rxRate * 0.2
        }
        if (decodeMsPerFrame > 0) {
            this.emaDecodeMsPerFrame = this.emaDecodeMsPerFrame === 0
                ? decodeMsPerFrame
                : this.emaDecodeMsPerFrame * 0.8 + decodeMsPerFrame * 0.2
        }
        if (jbAvgMs > 0) {
            this.emaJbDelayMs = this.emaJbDelayMs === 0
                ? jbAvgMs
                : this.emaJbDelayMs * 0.8 + jbAvgMs * 0.2
        }
    }

    private emitEvent(event: FreezeWatchEvent) {
        if (event.kind === "video-freeze") {
            this.videoFreezes++
        } else {
            this.renderStalls++
            this.totalFreezeMs += event.durationMs
        }
        this.byCause[event.cause] = (this.byCause[event.cause] ?? 0) + 1
        this.lastEvent = event
        this.eventCallback?.(event, this.getSummary())
    }
}
