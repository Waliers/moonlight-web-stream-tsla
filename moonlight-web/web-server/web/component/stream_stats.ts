import { Stream, StreamAudioDiagnostics } from "../stream/index.js"
import { FreezeWatcher } from "../stream/freeze_watch.js"
import { InputDiagnostics } from "../stream/input.js"
import { Component } from "./index.js"

type WorkerDiagnosticsSnapshot = {
    stream: {
        audioDecoderMode: "worker" | "main-thread" | "not-ready"
        audioWorkerAttempted: boolean
        audioWorkerActive: boolean
        audioWorkerError: string | null
        audioDecodeEngine: "native" | "wasm" | null
    } | null
    canvas: {
        attempted: boolean
        active: boolean
        hasWorkerInstance: boolean
        error: string | null
        rafMissedFrames: number
        drawnFrameCount: number
        arrivedCount: number
        supersededCount: number
        jumpCount: number
        minGapMs: number
        avgGapMs: number
        maxGapMs: number
        videoElementMode?: boolean
    } | null
    canvasRendererEnabled: boolean
    workersAllowedBySettings: boolean
}

export class StreamStatsOverlay implements Component {
    private root = document.createElement("div")
    private intervalId: ReturnType<typeof setInterval> | null = null
    private reportIntervalId: ReturnType<typeof setInterval> | null = null
    private peerGetter: (() => RTCPeerConnection | null) | null = null
    private streamGetter: (() => Stream | null) | null = null
    private workerDiagnosticsGetter: (() => WorkerDiagnosticsSnapshot | null) | null = null
    private inputDiagnosticsGetter: (() => InputDiagnostics | null) | null = null
    private freezeWatchGetter: (() => FreezeWatcher | null) | null = null
    private statsEnabledCallback: ((enabled: boolean) => void) | null = null
    private statsReportCallback: ((text: string) => void) | null = null
    // How often to push the full stats dump to the server's console while the
    // overlay is open — independent of the 2s on-screen refresh rate.
    private static readonly REPORT_INTERVAL_MS = 5 * 60 * 1000

    // [label, element] pairs, in display order — reused to build the full
    // text dump sent to the server, so that list only needs to be maintained
    // in one place.
    private statRows: Array<[string, HTMLSpanElement]> = []

    // Cached DOM elements for fast updates (avoid querySelector each tick)
    private elVideoRes = document.createElement("span")
    private elCodec = document.createElement("span")
    private elFps = document.createElement("span")
    private elBitrate = document.createElement("span")
    private elRtt = document.createElement("span")
    private elPacketLoss = document.createElement("span")
    private elJitter = document.createElement("span")
    private elDecodeTime = document.createElement("span")
    private elFramesDropped = document.createElement("span")
    private elNackPli = document.createElement("span")
    private elFreeze = document.createElement("span")
    private elFreezeDetail = document.createElement("span")
    private elFreezeWatch = document.createElement("span")
    private elFreezeWatchLast = document.createElement("span")
    private elAssembly = document.createElement("span")
    private elInput = document.createElement("span")
    private elAudioBitrate = document.createElement("span")
    private elAudioPackets = document.createElement("span")
    private elAudioGap = document.createElement("span")
    private elAudioDropReason = document.createElement("span")
    private elAudioBuffer = document.createElement("span")
    private elAudioPipeline = document.createElement("span")
    private elWorkerAudio = document.createElement("span")
    private elWorkerVideo = document.createElement("span")

    // Previous snapshot for delta calculations
    private prevTimestamp = 0
    private prevBytesReceived = 0
    private prevFramesReceived = 0
    private prevFramesDropped = 0
    private prevAudioBytesReceived = 0
    private prevPacketsReceived = 0
    private prevPacketsLost = 0
    private prevAudioMessagesReceived = 0
    private prevNackCount = 0
    private prevPliCount = 0
    private prevFecPacketsReceived = 0
    private prevKeyFramesDecoded = 0
    private prevFramesDecoded = 0
    private prevTotalAssemblyTime = 0
    private prevFramesAssembled = 0
    private prevJitterBufferDelay = 0
    private prevJitterBufferEmittedCount = 0
    private prevJitterBufferMinimumDelay = 0
    private prevCanvasArrivedCount = 0
    private prevFreezeCount = 0
    private freezeCorrelationJitterSpikes = 0  // freezes that coincided with jitter spike
    private freezeCorrelationReceiveDrop = 0   // freezes that coincided with frame receive rate drop
    private freezeCorrelationSlowGpPoll = 0    // freezes that coincided with a slow (>20ms) getGamepads() call
    private prevInputEventsSent = 0
    private prevAvgJbDelayMs = 0  // rolling avg jitter buffer delay for spike detection
    private rollingFrameRateReceived = 0  // EMA of frames received per second

    constructor() {
        this.root.classList.add("stream-stats-overlay")

        // Header with refresh button
        const header = document.createElement("div")
        header.classList.add("stream-stats-row")
        header.style.cursor = "pointer"
        header.style.userSelect = "none"
        header.style.opacity = "0.8"
        header.style.textAlign = "center"
        header.textContent = "[ stream stats — auto-refresh 2s ]"
        header.addEventListener("click", (e) => {
            e.stopPropagation()
            this.scheduleUpdate()
        })
        header.addEventListener("touchend", (e) => {
            e.stopPropagation()
            this.scheduleUpdate()
        })
        this.root.appendChild(header)

        const rows: Array<[string, HTMLSpanElement]> = [
            ["Resolution", this.elVideoRes],
            ["Codec", this.elCodec],
            ["FPS", this.elFps],
            ["Video Bitrate", this.elBitrate],
            ["Network RTT", this.elRtt],
            ["Packet Loss", this.elPacketLoss],
            ["Network Jitter", this.elJitter],
            ["Decode Time", this.elDecodeTime],
            ["Frames Dropped", this.elFramesDropped],
            ["NACK / PLI", this.elNackPli],
            ["Freeze", this.elFreeze],
            ["Freeze Detail", this.elFreezeDetail],
            ["Freeze Watch", this.elFreezeWatch],
            ["Watch Last", this.elFreezeWatchLast],
            ["Frame Assembly", this.elAssembly],
            ["Input", this.elInput],
            ["Audio Bitrate", this.elAudioBitrate],
            ["Audio Messages", this.elAudioPackets],
            ["Audio Gap", this.elAudioGap],
            ["Audio Drops", this.elAudioDropReason],
            ["Audio Buffer", this.elAudioBuffer],
            ["Audio Pipeline", this.elAudioPipeline],
            ["Worker Audio", this.elWorkerAudio],
            ["Worker Video", this.elWorkerVideo],
        ]

        for (const [label, valueEl] of rows) {
            const row = document.createElement("div")
            row.classList.add("stream-stats-row")

            const labelEl = document.createElement("span")
            labelEl.classList.add("stream-stats-label")
            labelEl.textContent = label

            valueEl.classList.add("stream-stats-value")
            valueEl.textContent = "—"

            row.appendChild(labelEl)
            row.appendChild(valueEl)
            this.root.appendChild(row)
        }

        this.statRows = rows
    }

    setPeerGetter(getter: () => RTCPeerConnection | null) {
        this.peerGetter = getter
    }

    setStreamGetter(getter: () => Stream | null) {
        this.streamGetter = getter
    }

    setWorkerDiagnosticsGetter(getter: () => WorkerDiagnosticsSnapshot | null) {
        this.workerDiagnosticsGetter = getter
    }

    setInputDiagnosticsGetter(getter: () => InputDiagnostics | null) {
        this.inputDiagnosticsGetter = getter
    }

    setFreezeWatchGetter(getter: () => FreezeWatcher | null) {
        this.freezeWatchGetter = getter
    }

    setStatsEnabledCallback(cb: (enabled: boolean) => void) {
        this.statsEnabledCallback = cb
    }

    /** Called every REPORT_INTERVAL_MS while the overlay is visible, with a full text dump of the current stats. */
    setStatsReportCallback(cb: (text: string) => void) {
        this.statsReportCallback = cb
    }

    show() {
        this.root.style.display = ""
        this.statsEnabledCallback?.(true)
        this.scheduleUpdate()
        // Auto-refresh every 2 seconds while visible
        if (!this.intervalId) {
            this.intervalId = setInterval(() => this.scheduleUpdate(), 2000)
        }
        // Periodically push the full stats dump to the server's console, so
        // it can be inspected without opening devtools on the client.
        if (!this.reportIntervalId) {
            this.reportIntervalId = setInterval(() => this.reportStats(), StreamStatsOverlay.REPORT_INTERVAL_MS)
        }
    }

    hide() {
        this.root.style.display = "none"
        this.statsEnabledCallback?.(false)
        if (this.intervalId) {
            clearInterval(this.intervalId)
            this.intervalId = null
        }
        if (this.reportIntervalId) {
            clearInterval(this.reportIntervalId)
            this.reportIntervalId = null
        }
    }

    /** Builds a plaintext dump of every currently-displayed stat and hands it to the report callback, if any. */
    private reportStats() {
        if (!this.statsReportCallback) return
        const lines = this.statRows.map(([label, valueEl]) => `${label}: ${valueEl.textContent}`)
        this.statsReportCallback(`[Stream Stats]\n${lines.join("\n")}`)
    }

    isVisible(): boolean {
        return this.root.style.display !== "none"
    }

    private statsProcessingMs: number = 0
    private updatePending = false

    private scheduleUpdate() {
        if (this.updatePending) return
        this.updatePending = true
        // Use requestIdleCallback if available (not in all workers/old browsers)
        if (typeof (globalThis as any).requestIdleCallback === "function") {
            ;(globalThis as any).requestIdleCallback(() => {
                this.updatePending = false
                this.update()
            }, { timeout: 2000 })
        } else {
            // Fallback: setTimeout with a small delay to yield to the current frame
            setTimeout(() => {
                this.updatePending = false
                this.update()
            }, 50)
        }
    }

    private async update() {
        if (!this.isVisible()) return

        const peer = this.peerGetter?.()
        if (!peer) return

        const stats = await peer.getStats()
        const now = Date.now()
        const elapsed = (now - this.prevTimestamp) / 1000 // seconds
        this.prevTimestamp = now

        let videoWidth = 0
        let videoHeight = 0
        let bytesReceived = 0
        let framesReceived = 0
        let framesDropped = 0
        let framesPerSecond = 0
        let totalDecodeTime = 0
        let framesDecoded = 0
        let jitter = 0
        let rtt = 0
        let packetsReceived = 0
        let packetsLost = 0
        let audioBytesReceived = 0
        let audioMessagesReceived = 0
        let nackCount = 0
        let pliCount = 0
        let fecPacketsReceived = 0
        let fecPacketsDiscarded = 0
        let keyFramesDecoded = 0
        let freezeCount = 0
        let totalFreezesDuration = 0
        let totalAssemblyTime = 0
        let framesAssembledFromMultiplePackets = 0
        let jitterBufferDelay = 0
        let jitterBufferEmittedCount = 0
        let jitterBufferMinimumDelay = 0

        // Single-pass direct iteration — no intermediate Map allocation.
        // Codec is resolved inline since RTCStatsReport.get() does the lookup for us.
        let codec = ""
        stats.forEach((report: any) => {
            if (report.type === "inbound-rtp" && report.kind === "video") {
                bytesReceived = report.bytesReceived ?? 0
                framesReceived = report.framesReceived ?? 0
                framesDropped = report.framesDropped ?? 0
                framesPerSecond = report.framesPerSecond ?? 0
                totalDecodeTime = report.totalDecodeTime ?? 0
                framesDecoded = report.framesDecoded ?? 0
                jitter = report.jitter ?? 0
                packetsReceived = report.packetsReceived ?? 0
                packetsLost = report.packetsLost ?? 0
                nackCount = report.nackCount ?? 0
                pliCount = report.pliCount ?? 0
                fecPacketsReceived = report.fecPacketsReceived ?? 0
                fecPacketsDiscarded = report.fecPacketsDiscarded ?? 0
                keyFramesDecoded = report.keyFramesDecoded ?? 0
                freezeCount = report.freezeCount ?? 0
                totalFreezesDuration = report.totalFreezesDuration ?? 0
                totalAssemblyTime = report.totalAssemblyTime ?? 0
                framesAssembledFromMultiplePackets = report.framesAssembledFromMultiplePackets ?? 0
                jitterBufferDelay = report.jitterBufferDelay ?? 0
                jitterBufferEmittedCount = report.jitterBufferEmittedCount ?? 0
                jitterBufferMinimumDelay = report.jitterBufferMinimumDelay ?? 0
                if (report.frameWidth && report.frameHeight) {
                    videoWidth = report.frameWidth
                    videoHeight = report.frameHeight
                }
                // Resolve codec inline via RTCStatsReport.get()
                if (report.codecId) {
                    const codecReport = stats.get(report.codecId)
                    if (codecReport) codec = codecReport.mimeType ?? ""
                }
            } else if (report.type === "data-channel" && report.label === "audio") {
                audioBytesReceived = report.bytesReceived ?? 0
                audioMessagesReceived = report.messagesReceived ?? 0
            } else if (report.type === "candidate-pair" && (report.state === "succeeded" || report.nominated)) {
                rtt = report.currentRoundTripTime ?? rtt
            }
        })

        // Calculate deltas (all rates are per-second regardless of update interval)
        if (elapsed > 0) {
            const videoBitrateMbps = ((bytesReceived - this.prevBytesReceived) * 8) / elapsed / 1_000_000
            this.elBitrate.textContent = `${videoBitrateMbps.toFixed(2)} Mbps`

            const audioBitrate = ((audioBytesReceived - this.prevAudioBytesReceived) * 8) / elapsed / 1_000
            this.elAudioBitrate.textContent = `${audioBitrate.toFixed(0)} kbps`

            const audioMessageDelta = audioMessagesReceived - this.prevAudioMessagesReceived
            const audioBytesDelta = audioBytesReceived - this.prevAudioBytesReceived
            const avgBytesPerMessage = audioMessageDelta > 0 ? (audioBytesDelta / audioMessageDelta) : 0
            const audioMsgPerSec = Math.round(audioMessageDelta / elapsed)
            this.elAudioPackets.textContent = audioMessageDelta >= 0
                ? `${audioMsgPerSec}/s (${avgBytesPerMessage.toFixed(1)} B/msg, ${audioMessagesReceived} total)`
                : `${audioMessagesReceived} total`

            const droppedDelta = framesDropped - this.prevFramesDropped
            this.elFramesDropped.textContent = `${framesDropped} (+${droppedDelta})`

            const nackDelta = nackCount - this.prevNackCount
            const pliDelta  = pliCount  - this.prevPliCount
            const keyDelta  = keyFramesDecoded - this.prevKeyFramesDecoded
            const fecDelta  = fecPacketsReceived - this.prevFecPacketsReceived
            this.elNackPli.textContent = `NACK ${Math.round(nackDelta / elapsed)}/s, PLI ${Math.round(pliDelta / elapsed)}/s, keyframes ${Math.round(keyDelta / elapsed)}/s (${keyFramesDecoded} total), FEC ${Math.round(fecDelta / elapsed)}/s (${fecPacketsReceived} rx, ${fecPacketsDiscarded} disc)`

            const assembledDelta = framesAssembledFromMultiplePackets - this.prevFramesAssembled
            const assemblyTimeDelta = totalAssemblyTime - this.prevTotalAssemblyTime
            const avgAssemblyMs = assembledDelta > 0 ? (assemblyTimeDelta / assembledDelta * 1000) : 0
            this.elAssembly.textContent = `${Math.round(assembledDelta / elapsed)}/s multi-pkt, avg ${avgAssemblyMs.toFixed(1)} ms`

            const totalPacketsDelta = (packetsReceived - this.prevPacketsReceived) + (packetsLost - this.prevPacketsLost)
            const lostDelta = packetsLost - this.prevPacketsLost
            const lossPercent = totalPacketsDelta > 0 ? (lostDelta / totalPacketsDelta * 100) : 0
            this.elPacketLoss.textContent = `${lossPercent.toFixed(1)}% (${packetsLost} total)`
        }

        // Decode time: average ms per frame
        let decodeTime = 0
        if (framesDecoded > 0) {
            decodeTime = (totalDecodeTime / framesDecoded) * 1000
        }

        this.elFreeze.textContent = freezeCount > 0
            ? `${freezeCount} events, ${(totalFreezesDuration * 1000).toFixed(0)} ms total`
            : `0`

        // Input activity + gamepad poll timing for this interval. Fetched here
        // (before the freeze block) so freezes can be correlated with slow
        // navigator.getGamepads() calls — Tesla's BT HID stack is a suspected
        // renderer-stall source.
        const inputDiag = this.inputDiagnosticsGetter?.() ?? null
        if (inputDiag) {
            const eventsDelta = inputDiag.eventsSent - this.prevInputEventsSent
            this.prevInputEventsSent = inputDiag.eventsSent
            const eventsRate = elapsed > 0 ? Math.round(eventsDelta / elapsed) : 0
            this.elInput.textContent =
                `${eventsRate}/s sent, gp poll max ${inputDiag.gamepadPollIntervalMaxMs.toFixed(1)} ms` +
                ` (worst ${inputDiag.gamepadPollSessionMaxMs.toFixed(1)} ms, >20ms: ${inputDiag.gamepadPollSlowCount})`
        }

        // Freeze cause correlation: detect if freezes coincide with jitter buffer spikes
        // A "jitter spike" means the avg jitter buffer delay this interval is >2× the rolling avg.
        const jbDelayDeltaForFreeze   = jitterBufferDelay        - this.prevJitterBufferDelay
        const jbEmittedDeltaForFreeze = jitterBufferEmittedCount - this.prevJitterBufferEmittedCount
        const curAvgJbMs = jbEmittedDeltaForFreeze > 0 ? (jbDelayDeltaForFreeze / jbEmittedDeltaForFreeze * 1000) : 0
        const freezeDelta = freezeCount - this.prevFreezeCount

        // Detect receive-rate drop: if framesReceived/s this interval is <50% of rolling avg
        const framesReceivedDelta = framesReceived - this.prevFramesReceived
        const curFrameRate = elapsed > 0 ? framesReceivedDelta / elapsed : 0
        if (this.rollingFrameRateReceived === 0 && curFrameRate > 0) {
            this.rollingFrameRateReceived = curFrameRate
        } else if (curFrameRate > 0) {
            this.rollingFrameRateReceived = this.rollingFrameRateReceived * 0.8 + curFrameRate * 0.2
        }
        const receiveRateDropped = curFrameRate > 0 && this.rollingFrameRateReceived > 0 && curFrameRate < this.rollingFrameRateReceived * 0.5

        if (freezeDelta > 0) {
            if (this.prevAvgJbDelayMs > 0 && curAvgJbMs > this.prevAvgJbDelayMs * 2) {
                this.freezeCorrelationJitterSpikes += freezeDelta
            }
            if (receiveRateDropped) {
                this.freezeCorrelationReceiveDrop += freezeDelta
            }
            if (inputDiag && inputDiag.gamepadPollIntervalMaxMs > 20) {
                this.freezeCorrelationSlowGpPoll += freezeDelta
            }
        }
        this.prevFreezeCount = freezeCount
        // Update rolling average (EMA with α=0.2)
        if (curAvgJbMs > 0) {
            this.prevAvgJbDelayMs = this.prevAvgJbDelayMs === 0
                ? curAvgJbMs
                : this.prevAvgJbDelayMs * 0.8 + curAvgJbMs * 0.2
        }
        const avgFreezeDurationMs = freezeCount > 0 ? ((totalFreezesDuration * 1000) / freezeCount).toFixed(0) : "0"
        // Determine likely cause label
        let freezeCause = "unknown (browser/decode stall?)"
        if (freezeCount > 0) {
            const jitterPct = Math.round(this.freezeCorrelationJitterSpikes / freezeCount * 100)
            const receivePct = Math.round(this.freezeCorrelationReceiveDrop / freezeCount * 100)
            if (jitterPct > 50) freezeCause = "network jitter bursts"
            else if (receivePct > 50) freezeCause = "encoder/sender stall"
            else freezeCause = "browser decode/render stall"
        }
        this.elFreezeDetail.textContent = freezeCount > 0
            ? `avg ${avgFreezeDurationMs} ms, cause: ${freezeCause} | jitter: ${this.freezeCorrelationJitterSpikes}/${freezeCount}, rx-drop: ${this.freezeCorrelationReceiveDrop}/${freezeCount}, gp-poll: ${this.freezeCorrelationSlowGpPoll}/${freezeCount}`
            : `—`

        // FreezeWatcher (always-on forensics) — per-event cause attribution,
        // including render stalls the inbound-rtp freezeCount can't see.
        const freezeWatcher = this.freezeWatchGetter?.() ?? null
        if (freezeWatcher) {
            this.elFreezeWatch.textContent = freezeWatcher.getSummaryLine()
            this.elFreezeWatchLast.textContent = freezeWatcher.getLastEventLine()
        } else {
            this.elFreezeWatch.textContent = "—"
            this.elFreezeWatchLast.textContent = "—"
        }

        this.elVideoRes.textContent = videoWidth > 0 ? `${videoWidth}×${videoHeight}` : "—"
        this.elCodec.textContent = codec || "—"
        this.elFps.textContent = framesPerSecond > 0 ? `${framesPerSecond}` : "—"
        this.elRtt.textContent = rtt > 0 ? `${(rtt * 1000).toFixed(1)} ms` : "—"

        this.elDecodeTime.textContent = decodeTime > 0 ? `${decodeTime.toFixed(1)} ms` : "—"

        // Jitter buffer delay: avg time each frame waited in the buffer before reaching the decoder.
        // This is the definitive measure of end-to-end decode latency budget consumed by the jitter buffer.
        // Both jitterBufferDelay and jitterBufferMinimumDelay are CUMULATIVE
        // sums over all emitted frames (W3C webrtc-stats), so each must be
        // divided by the emitted-count delta. Per spec, the "minimum" variant
        // purposefully IGNORES jitterBufferTarget: it is the delay the buffer
        // could achieve from network conditions alone. So `avg` is what frames
        // really waited (\u2248 the jitterBufferMs setting once ramped), `floor` is
        // the network minimum, and avg \u2212 floor = latency deliberately spent on
        // smoothing.
        const jbDelayDelta   = jitterBufferDelay        - this.prevJitterBufferDelay
        const jbEmittedDelta = jitterBufferEmittedCount - this.prevJitterBufferEmittedCount
        const jbMinDelta     = jitterBufferMinimumDelay - this.prevJitterBufferMinimumDelay
        const avgJbDelayMs   = jbEmittedDelta > 0 ? (jbDelayDelta / jbEmittedDelta * 1000) : -1
        const floorJbMs      = jbEmittedDelta > 0 ? (jbMinDelta / jbEmittedDelta * 1000) : -1
        this.elJitter.textContent = jitter > 0
            ? `net ${(jitter * 1000).toFixed(1)} ms, buf avg ${avgJbDelayMs >= 0 ? avgJbDelayMs.toFixed(1) : "?"} ms (floor ${floorJbMs >= 0 ? floorJbMs.toFixed(1) : "?"} ms)`
            : "\u2014"

        const stream = this.streamGetter?.()
        const audioDiag: StreamAudioDiagnostics | null = stream ? stream.getAudioDiagnostics() : null
        const workerDiag = this.workerDiagnosticsGetter?.() ?? null
        if (audioDiag) {
            this.elAudioBuffer.textContent = `${audioDiag.bufferLeadMs.toFixed(1)} ms lead, ctx=${audioDiag.audioContextState}`
            this.elAudioGap.textContent = `last ${audioDiag.lastPacketGapMs.toFixed(1)} ms, avg ${audioDiag.avgPacketGapMs.toFixed(1)} ms, max ${audioDiag.maxPacketGapMs.toFixed(1)} ms, late ${audioDiag.latePacketGaps}`
            this.elAudioDropReason.textContent = `worklet drops ${audioDiag.resyncs}, latency flush ${audioDiag.droppedLatencyFlushes}, cleanup ${audioDiag.droppedCleanupSources}`
            this.elAudioPipeline.textContent = `rx ${audioDiag.receivedPackets}, dec ${audioDiag.decodedPackets}, err ${audioDiag.decodeErrors}, underrun ${audioDiag.underruns}`
        } else {
            this.elAudioGap.textContent = "—"
            this.elAudioDropReason.textContent = "—"
            this.elAudioBuffer.textContent = "—"
            this.elAudioPipeline.textContent = "—"
        }

        if (workerDiag) {
            if (workerDiag.stream) {
                this.elWorkerAudio.textContent = `mode=${workerDiag.stream.audioDecoderMode}, engine=${workerDiag.stream.audioDecodeEngine ?? "?"}, active=${workerDiag.stream.audioWorkerActive}, attempted=${workerDiag.stream.audioWorkerAttempted}, err=${workerDiag.stream.audioWorkerError ?? "none"}`
            } else {
                this.elWorkerAudio.textContent = "unavailable"
            }

            if (workerDiag.canvasRendererEnabled) {
                if (workerDiag.canvas) {
                    const c = workerDiag.canvas
                    const modeLabel = c.videoElementMode ? "vidElem" : (c.active ? "worker" : "main")
                    const dropLabel = c.active ? "dropped" : "rafMiss"
                    const gapStr = c.minGapMs >= 0
                        ? `, gaps: ${c.minGapMs.toFixed(1)}/${c.avgGapMs.toFixed(1)}/${c.maxGapMs.toFixed(1)} ms`
                        : ""
                    const srcGapStr = (c as any).srcGapMs ? `, src: ${(c as any).srcGapMs} ms` : ""
                    const supersededStr = c.supersededCount > 0 ? `, skip=${c.supersededCount}` : ""
                    const jumpsStr = c.jumpCount > 0 ? `, jumps=${c.jumpCount}` : ""
                    // Worker mode: `arrivedCount` is an interval count over the
                    // worker's fixed 2s reporting window (it resets every post),
                    // so the rate is simply count/2 — diffing it like the
                    // cumulative main-thread counter yields garbage (~1/s).
                    let arrivedRate: number
                    if (c.active) {
                        arrivedRate = Math.round(c.arrivedCount / 2)
                    } else {
                        arrivedRate = elapsed > 0 ? Math.round((c.arrivedCount - this.prevCanvasArrivedCount) / elapsed) : 0
                        this.prevCanvasArrivedCount = c.arrivedCount
                    }
                    this.elWorkerVideo.textContent = `mode=${modeLabel}, arrived=${arrivedRate}/s, drawn=${c.drawnFrameCount}, ${dropLabel}=${c.rafMissedFrames}${supersededStr}${jumpsStr}${gapStr}${srcGapStr}, err=${c.error ?? "none"}`
                } else {
                    this.elWorkerVideo.textContent = "canvas diagnostics unavailable"
                }
            } else {
                this.elWorkerVideo.textContent = "canvas renderer disabled"
            }
        } else {
            this.elWorkerAudio.textContent = "—"
            this.elWorkerVideo.textContent = "—"
        }

        // Save for next delta
        this.prevBytesReceived = bytesReceived
        this.prevFramesReceived = framesReceived
        this.prevFramesDropped = framesDropped
        this.prevAudioBytesReceived = audioBytesReceived
        this.prevPacketsReceived = packetsReceived
        this.prevPacketsLost = packetsLost
        this.prevAudioMessagesReceived = audioMessagesReceived
        this.prevNackCount = nackCount
        this.prevPliCount = pliCount
        this.prevFecPacketsReceived = fecPacketsReceived
        this.prevKeyFramesDecoded = keyFramesDecoded
        this.prevFramesDecoded = framesDecoded
        this.prevTotalAssemblyTime = totalAssemblyTime
        this.prevFramesAssembled = framesAssembledFromMultiplePackets
        this.prevJitterBufferDelay = jitterBufferDelay
        this.prevJitterBufferEmittedCount = jitterBufferEmittedCount
        this.prevJitterBufferMinimumDelay = jitterBufferMinimumDelay
    }

    destroy() {
        this.hide()
        this.peerGetter = null
        this.streamGetter = null
        this.workerDiagnosticsGetter = null
        this.statsReportCallback = null
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.root)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.root)
    }
}
