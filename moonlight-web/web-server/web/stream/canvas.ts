declare class MediaStreamTrackProcessor {
    constructor(options: { track: MediaStreamTrack })
    readonly readable: ReadableStream<VideoFrame>
}

export class CanvasRenderer {
    canvas: HTMLCanvasElement | null
    ctx: CanvasRenderingContext2D | null
    // Preferred main-thread path — see startRendering(). Plain 2D context
    // (ctx) is capped at ~30fps on some Chromium builds (Tesla, Android
    // Chrome, and desktop Chrome have all reproduced it — not a performance
    // issue, a compositing behavior specific to 2D canvas fed by VideoFrame).
    bitmapCtx: ImageBitmapRenderingContext | null
    // Set once transferControlToOffscreen() has been called on canvas (see
    // startRendering()). After that call, canvas.width/height can no longer
    // be assigned directly (throws InvalidStateError) — resizing must go
    // through this object instead. canvas.clientWidth/clientHeight (CSS
    // layout size) remain safe to read either way.
    private offscreenCanvas: OffscreenCanvas | null
    videoTrack: MediaStreamTrack | null
    trackProcessor: MediaStreamTrackProcessor | null
    readableStream: ReadableStream | null
    frameReader: ReadableStreamDefaultReader | null
    latestFrame: VideoFrame | null
    isRunning: boolean = false
    private renderWorker: Worker | null = null
    private workerRenderingEnabled: boolean = false
    private workerAccelerationAllowed: boolean
    private workerInitAttempted: boolean = false
    private workerInitError: string | null = null
    private stretchToFit: boolean
    private handleResize: () => void

    // Hidden video element renderer: uses browser's native frame timing
    private hiddenVideo: HTMLVideoElement | null = null
    private useVideoElementSource: boolean
    private rafId: number = 0
    private drawRafPending: boolean = false
    private lastVideoTime: number = -1  // detect new frames via video.currentTime
    private videoDrawnCount: number = 0
    private videoNewFrameCount: number = 0  // times we detected a genuinely new frame

    constructor(canvasElement: HTMLCanvasElement, stretchToFit: boolean, enableWorkerAcceleration: boolean = true, drawOnArrival: boolean = true) {
        this.canvas = canvasElement
        this.ctx = null
        this.bitmapCtx = null
        this.offscreenCanvas = null
        this.videoTrack = null
        this.trackProcessor = null
        this.readableStream = null
        this.frameReader = null
        this.latestFrame = null
        this.stretchToFit = stretchToFit
        this.workerAccelerationAllowed = enableWorkerAcceleration
        this.drawOnArrival = drawOnArrival
        // Use hidden video element source by default — it leverages the browser's
        // native frame timing/smoothing instead of the batchy MediaStreamTrackProcessor pipeline.
        // Falls back to MSTP if the video element doesn't produce frames.
        // DISABLED: Tesla kills <video> playback in drive mode, causing black screen.
        // The MSTP/worker path is the only one that works in drive mode.
        this.useVideoElementSource = false
        this.workerAccelerationAllowed = enableWorkerAcceleration
        this.drawLoop = this.drawLoop.bind(this)
        this.handleResize = () => {
            if (!this.canvas) return
            if (this.workerRenderingEnabled && this.renderWorker) {
                this.renderWorker.postMessage({
                    type: "resize",
                    width: Math.max(1, this.canvas.clientWidth),
                    height: Math.max(1, this.canvas.clientHeight),
                })
                return
            }

            if (this.useVideoElementSource) {
                // Reset layout so it recalculates on next draw
                this.drawWidth = 0
                this.drawHeight = 0
                return
            }

            if (this.stretchToFit) {
                const w = this.canvas.clientWidth
                const h = this.canvas.clientHeight
                this.resizeDrawTarget(w, h)
                this.drawWidth = w
                this.drawHeight = h
                this.offsetX = 0
                this.offsetY = 0
            } else {
                // For non-stretch mode we need the next video frame to recalc sizes
                this.drawWidth = 0
                this.drawHeight = 0
            }
        }
        window.addEventListener("resize", this.handleResize)
    }

    private trySetupRenderWorker() {
        this.workerInitAttempted = true

        if (!this.workerAccelerationAllowed || this.renderWorker || this.workerRenderingEnabled || !this.canvas) {
            return
        }

        const transfer = (this.canvas as any).transferControlToOffscreen
        if (typeof Worker === "undefined" || typeof transfer !== "function") {
            if (typeof Worker === "undefined") {
                this.workerInitError = "Worker API unsupported"
            } else {
                this.workerInitError = "OffscreenCanvas transfer unsupported"
            }
            return
        }

        try {
            const offscreen = transfer.call(this.canvas) as OffscreenCanvas
            this.renderWorker = new Worker(new URL("./video_render_worker.js", import.meta.url), { type: "module" })
            this.renderWorker.onmessage = (event: MessageEvent) => {
                if (event.data?.type === "stats") {
                    this.workerDrawnFrameCount   = event.data.drawn
                    this.workerDroppedFrameCount = event.data.dropped
                    this.workerArrivedCount      = event.data.arrived
                    this.workerMinGapMs          = event.data.minGapMs
                    this.workerAvgGapMs          = event.data.avgGapMs
                    this.workerMaxGapMs          = event.data.maxGapMs
                }
            }
            this.renderWorker.postMessage({
                type: "init",
                canvas: offscreen,
                stretchToFit: this.stretchToFit,
                width: Math.max(1, this.canvas.clientWidth),
                height: Math.max(1, this.canvas.clientHeight),
            }, [offscreen as any])
            if (this.statsEnabledDesired) {
                this.renderWorker.postMessage({ type: 'enable-stats' })
            }
            this.workerRenderingEnabled = true
            this.workerInitError = null
        } catch (e) {
            console.error("Failed to initialize video render worker, falling back to main-thread canvas rendering", e)
            this.renderWorker = null
            this.workerRenderingEnabled = false
            this.workerInitError = String(e)
        }
    }

    getWorkerDiagnostics() {
        const isWorkerActive = this.workerRenderingEnabled
        const isVideoElementActive = this.useVideoElementSource && this.hiddenVideo != null
        const mainMinGapMs = this.drawGapMin
        const mainAvgGapMs = this.drawGapAvg
        const mainMaxGapMs = this.drawGapMax
        const mainJumpCount = this.drawJumpCount

        const mainDrawLatencyAvg = this.drawLatencyAvgMs
        const mainDrawLatencyMax = this.drawLatencyMaxMs

        // Expose a rolling main-thread gap window instead of a lifetime max.
        // The stats overlay polls periodically, so resetting here makes max-gap
        // reflect only the most recent interval and highlights fresh stutter spikes.
        if (!isWorkerActive && !isVideoElementActive) {
            this.drawGapMin = -1
            this.drawGapAvg = -1
            this.drawGapMax = -1
            this.drawJumpCount = 0
            this.drawLatencyMaxMs = -1
        }

        return {
            allowed: this.workerAccelerationAllowed,
            attempted: this.workerInitAttempted,
            active: isWorkerActive,
            hasWorkerInstance: this.renderWorker != null,
            error: this.workerInitError,
            // In video-element mode report video element stats
            // In worker mode use counts reported back from the worker;
            // in main-thread mode use the rAF-loop counters.
            rafMissedFrames: isWorkerActive ? this.workerDroppedFrameCount : this.rafMissedFrames,
            drawnFrameCount: isVideoElementActive ? this.videoDrawnCount : (isWorkerActive ? this.workerDrawnFrameCount : this.drawnFrameCount),
            arrivedCount:    isVideoElementActive ? this.videoNewFrameCount : (isWorkerActive ? this.workerArrivedCount : this.mainArrivedCount),
            supersededCount: isWorkerActive ? 0 : this.mainSupersededCount,
            jumpCount:       isWorkerActive ? 0 : mainJumpCount,
            minGapMs:        isWorkerActive ? this.workerMinGapMs          : mainMinGapMs,
            avgGapMs:        isWorkerActive ? this.workerAvgGapMs          : mainAvgGapMs,
            maxGapMs:        isWorkerActive ? this.workerMaxGapMs          : mainMaxGapMs,
            // Arrival→draw latency (main-thread mode only): the A/B signal
            // for the drawOnArrival setting (~0ms on-arrival vs 0-16.7ms rAF)
            drawLatencyAvgMs: isWorkerActive || isVideoElementActive ? -1 : mainDrawLatencyAvg,
            drawLatencyMaxMs: isWorkerActive || isVideoElementActive ? -1 : mainDrawLatencyMax,
            drawOnArrival:   this.drawOnArrival,
            usingBitmapRenderer: this.bitmapCtx != null,
            videoElementMode: isVideoElementActive,
        }
    }

    setVideoTrack(track: MediaStreamTrack) {
        if (this.videoTrack === track) {
            return
        }

        this.stopRendering() // Stop any existing rendering
        this.videoTrack = track

        if (this.videoTrack) {
            if (this.useVideoElementSource) {
                // Hidden video element approach: attach track to a hidden <video>,
                // let the browser handle jitter buffer smoothing and frame timing natively,
                // then draw from the video element to canvas at each rAF.
                this.setupHiddenVideoElement(this.videoTrack)
                this.startRenderingFromVideo()
            } else {
                // Legacy: MediaStreamTrackProcessor → ReadableStream → Worker/main-thread
                if (!("MediaStreamTrackProcessor" in window)) {
                    console.error("MediaStreamTrackProcessor not supported in this browser.")
                    return
                }
                try {
                    this.trackProcessor = new MediaStreamTrackProcessor({ track: this.videoTrack })
                    this.readableStream = this.trackProcessor.readable
                    this.startRendering()
                } catch (e) {
                    console.error("Error creating MediaStreamTrackProcessor:", e)
                }
            }
        }
    }

    private setupHiddenVideoElement(track: MediaStreamTrack) {
        this.hiddenVideo = document.createElement("video")
        this.hiddenVideo.style.position = "absolute"
        this.hiddenVideo.style.width = "1px"
        this.hiddenVideo.style.height = "1px"
        this.hiddenVideo.style.opacity = "0"
        this.hiddenVideo.style.pointerEvents = "none"
        this.hiddenVideo.muted = true
        this.hiddenVideo.autoplay = true
        this.hiddenVideo.playsInline = true
        this.hiddenVideo.srcObject = new MediaStream([track])
        // Append to DOM so the browser actually decodes frames
        document.body.appendChild(this.hiddenVideo)
        this.hiddenVideo.play().catch(e => console.error("Hidden video play failed:", e))
    }

    private startRenderingFromVideo() {
        if (!this.canvas || !this.hiddenVideo) return
        this.ctx = this.canvas.getContext("2d", { alpha: false, desynchronized: true })
        this.isRunning = true
        this.lastVideoTime = -1
        this.videoDrawnCount = 0
        this.videoNewFrameCount = 0

        // Use requestVideoFrameCallback if available for frame-precise timing,
        // otherwise fall back to requestAnimationFrame
        if ("requestVideoFrameCallback" in this.hiddenVideo) {
            this.videoFrameCallbackLoop()
        } else {
            this.videoRafLoop()
        }
    }

    private videoFrameCallbackLoop() {
        if (!this.isRunning || !this.hiddenVideo) return
        this.hiddenVideo.requestVideoFrameCallback((_now, _metadata) => {
            this.drawFromVideoElement()
            this.videoFrameCallbackLoop()
        })
    }

    private videoRafLoop() {
        if (!this.isRunning) return
        this.rafId = requestAnimationFrame(() => {
            this.drawFromVideoElement()
            this.videoRafLoop()
        })
    }

    private drawFromVideoElement() {
        if (!this.ctx || !this.canvas || !this.hiddenVideo) return
        if (this.hiddenVideo.readyState < 2) return  // HAVE_CURRENT_DATA

        const currentTime = this.hiddenVideo.currentTime
        if (currentTime === this.lastVideoTime) return  // no new frame
        this.lastVideoTime = currentTime
        this.videoNewFrameCount++

        const vw = this.hiddenVideo.videoWidth
        const vh = this.hiddenVideo.videoHeight
        if (vw === 0 || vh === 0) return

        // Recalculate layout if needed
        if (this.drawWidth === 0 || this.drawHeight === 0) {
            this.recalcLayoutFromDimensions(vw, vh)
        }

        if (this.offsetX !== 0 || this.offsetY !== 0) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
        }
        this.ctx.drawImage(this.hiddenVideo, this.offsetX, this.offsetY, this.drawWidth, this.drawHeight)
        this.videoDrawnCount++
    }

    private recalcLayoutFromDimensions(frameWidth: number, frameHeight: number) {
        if (!this.canvas) return
        const canvasAspect = this.canvas.clientWidth / this.canvas.clientHeight
        const frameAspect = frameWidth / frameHeight
        this.offsetX = 0
        this.offsetY = 0

        if (this.stretchToFit) {
            this.canvas.width = this.canvas.clientWidth
            this.canvas.height = this.canvas.clientHeight
            this.drawWidth = this.canvas.width
            this.drawHeight = this.canvas.height
        } else {
            this.canvas.width = frameWidth
            this.canvas.height = frameHeight
            if (canvasAspect > frameAspect) {
                this.drawHeight = this.canvas.height
                this.drawWidth = this.drawHeight * frameAspect
                this.offsetX = (this.canvas.width - this.drawWidth) / 2
            } else {
                this.drawWidth = this.canvas.width
                this.drawHeight = this.drawWidth / frameAspect
                this.offsetY = (this.canvas.height - this.drawHeight) / 2
            }
        }
    }

    // Try to hand the ReadableStream to the worker so it pulls frames directly,
    // bypassing the main-thread async readLoop entirely. Falls back gracefully if
    // the browser does not support transferable ReadableStream (Chrome 87+).
    private tryTransferStreamToWorker(): boolean {
        if (!this.renderWorker || !this.workerRenderingEnabled || !this.readableStream) {
            return false
        }
        try {
            this.renderWorker.postMessage(
                { type: "setStream", stream: this.readableStream },
                [this.readableStream as any]
            )
            this.readableStream = null  // worker now owns it
            this.workerOwnsStream = true
            return true
        } catch (_e) {
            // Browser doesn't support transferable ReadableStream — fall back to postMessage frames
            this.workerOwnsStream = false
            return false
        }
    }

    startRendering() {
        if ((this.readableStream || this.frameReader) && !this.isRunning) {
            this.trySetupRenderWorker()
            if (!this.workerRenderingEnabled && this.canvas && !this.ctx && !this.bitmapCtx) {
                // Prefer an OffscreenCanvas even on the main thread. Plain
                // bitmaprenderer on a regular HTMLCanvasElement still caps at
                // ~30fps (measured 2026-07-20) — cross-platform (Tesla,
                // Android Chrome, desktop Chrome), so it isn't a performance
                // issue or specifically a 2D-vs-bitmaprenderer context issue.
                // The worker path's fix is more likely OffscreenCanvas's own
                // presentation path bypassing whatever compositor behavior
                // causes the cap, independent of context type or thread.
                // transferControlToOffscreen() works from the main thread —
                // this gets the same fix without a Worker's message-passing
                // overhead (which had its own reported stutter). A canvas can
                // only ever be bound to one context/offscreen for its
                // lifetime, so this must happen before any getContext() call
                // succeeds, and it can only be attempted once ever.
                let offscreenBitmapCtx: ImageBitmapRenderingContext | null = null
                const transfer = (this.canvas as any).transferControlToOffscreen
                if (typeof transfer === "function") {
                    try {
                        const offscreen = transfer.call(this.canvas) as OffscreenCanvas
                        offscreen.width = this.canvas.width
                        offscreen.height = this.canvas.height
                        offscreenBitmapCtx = offscreen.getContext("bitmaprenderer", { alpha: false }) as ImageBitmapRenderingContext | null
                        if (offscreenBitmapCtx) {
                            this.offscreenCanvas = offscreen
                        } else {
                            // bitmaprenderer unavailable on this OffscreenCanvas (very
                            // unlikely on any real target browser) — 2D on an already-
                            // transferred canvas so no meaningful fallback remains
                            // beyond accepting the known ~30fps cap.
                            this.offscreenCanvas = offscreen
                            this.ctx = offscreen.getContext("2d", { alpha: false, desynchronized: true }) as unknown as CanvasRenderingContext2D
                        }
                    } catch (_e) {
                        // transferControlToOffscreen unsupported or already called —
                        // fall through to the regular (non-offscreen) canvas below.
                    }
                }
                if (offscreenBitmapCtx) {
                    this.bitmapCtx = offscreenBitmapCtx
                } else if (!this.ctx) {
                    this.ctx = this.canvas.getContext("2d", { alpha: false, desynchronized: true })
                }
            }
            this.isRunning = true
            if (this.workerRenderingEnabled && this.tryTransferStreamToWorker()) {
                // Worker owns the ReadableStream and reads frames directly on its own thread.
                // No main-thread readLoop needed — this is the zero-main-thread-involvement path.
            } else {
                // Main-thread path: readLoop stores latest frame, drawLoop renders at vsync.
                this.workerOwnsStream = false
                if (!this.frameReader && this.readableStream) {
                    this.frameReader = this.readableStream.getReader()
                }
                this.readLoop()
                this.startDrawLoop()
            }
        }
    }

    /** Start the continuous rAF render loop (runs every vsync). */
    private startDrawLoop() {
        if (this.drawRafPending) return
        this.drawRafPending = true
        this.rafId = requestAnimationFrame(this.drawLoop)
    }

    stopRendering() {
        this.isRunning = false
        this.drawRafPending = false
        if (this.rafId) {
            cancelAnimationFrame(this.rafId)
            this.rafId = 0
        }
        if (this.hiddenVideo) {
            this.hiddenVideo.pause()
            this.hiddenVideo.srcObject = null
            this.hiddenVideo.remove()
            this.hiddenVideo = null
        }
        if (this.workerOwnsStream && this.renderWorker) {
            // Tell the worker to cancel its stream reader
            this.renderWorker.postMessage({ type: "stopStream" })
            this.workerOwnsStream = false
            this.readableStream = null  // worker owns/cancels it
        }
        if (this.frameReader) {
            this.frameReader.cancel()
            this.frameReader = null
        }
        if (this.trackProcessor) {
            // Only cancel the readable if we still hold a reference to it
            if (this.readableStream) {
                this.readableStream.cancel().catch(() => {})
                this.readableStream = null
            }
            this.trackProcessor = null
        }
        if (this.latestFrame) {
            this.latestFrame.close()
            this.latestFrame = null
        }
        this.videoTrack = null
    }

    async readLoop() {
        if (!this.frameReader) return

        try {
            while (this.isRunning && this.frameReader) {
                const { value, done } = await this.frameReader.read()
                if (done) {
                    this.stopRendering()
                    break
                }

                if (this.workerRenderingEnabled && this.renderWorker) {
                    // Transfer frame ownership to worker for rasterization.
                    this.renderWorker.postMessage({ type: "frame", frame: value }, [value as any])
                    continue
                }

                this.mainArrivedCount++
                const prev = this.latestFrame
                const prevWasDrawn = this.latestFrameDrawn
                this.latestFrame = value
                this.latestFrameDrawn = false
                this.latestFrameArrivedAt = performance.now()
                if (prev) {
                    // Previous frame was never drawn — it got superseded
                    if (!prevWasDrawn) this.mainSupersededCount++
                    prev.close()
                }

                // Draw-on-arrival (input-to-photon latency): the desynchronized
                // canvas can present out-of-band, so drawing the moment a frame
                // arrives skips the 0-16.7ms wait for the next rAF tick plus
                // potentially a compositor vsync. Tradeoffs: frame pacing
                // follows network arrival (not vsync-even), and at decode rates
                // above the display refresh every frame is still rasterized
                // (2x GPU work at 120fps on the 60Hz Tesla panel). The rAF
                // drawLoop keeps running as a no-op fallback.
                if (this.drawOnArrival) {
                    this.drawStoredFrame()
                }
            }
        } catch (e) {
            console.error("Error reading video frame:", e)
            this.stopRendering()
        }
    }

    /**
     * Draw the stored latestFrame now. Shared by draw-on-arrival (readLoop)
     * and the rAF fallback loop — whichever runs first wins; the other no-ops
     * via latestFrameDrawn. Dispatches to whichever context type this canvas
     * was bound to (see startRendering()).
     */
    private drawStoredFrame() {
        if (!this.canvas) return
        const frame = this.latestFrame
        if (!frame || this.latestFrameDrawn) return

        if (this.drawWidth === 0) {
            this.onFirstFrameAfterResize(frame)
        }

        if (this.bitmapCtx) {
            this.drawStoredFrameBitmap(frame)
        } else if (this.ctx) {
            this.drawStoredFrame2d(frame)
        }
    }

    /**
     * Fallback path when bitmaprenderer isn't supported: synchronous
     * ctx.drawImage(). Closes the frame eagerly after drawing (the canvas has
     * rasterized the pixels; releasing the decoder buffer immediately reduces
     * GC/decoder-pool pressure).
     */
    private drawStoredFrame2d(frame: VideoFrame) {
        if (!this.ctx || !this.canvas) return
        const arrivedAt = this.latestFrameArrivedAt

        if (this.offsetX !== 0 || this.offsetY !== 0) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
        }
        this.ctx.drawImage(frame, this.offsetX, this.offsetY, this.drawWidth, this.drawHeight)
        this.latestFrameDrawn = true
        this.drawnFrameCount++
        frame.close()
        this.latestFrame = null
        this.recordDrawCompletion(arrivedAt)
    }

    // At most one createImageBitmap()+transferFromImageBitmap() in flight at a
    // time (see drawStoredFrameBitmap doc comment for why).
    private bitmapDrawInFlight: boolean = false

    /**
     * Default main-thread path: createImageBitmap() + transferFromImageBitmap()
     * instead of a synchronous drawImage(). Mirrors the technique already
     * proven in video_render_worker.ts's worker render path (atomic compositor
     * handoff instead of a blocking paint) — this is what actually fixes the
     * ~30fps 2D-canvas compositing cap (confirmed cross-platform: Tesla,
     * Android Chrome, desktop Chrome laptop — not a performance issue).
     *
     * Concurrency is capped at 1 in-flight bitmap operation. A first attempt
     * at this (2026-07-20) let createImageBitmap calls for consecutive frames
     * overlap freely — harmless on the worker thread (nothing else competes
     * for its event loop) but on the main thread, if other work (input
     * handling, FreezeWatch, stats) delays when a pending promise's .then()
     * actually runs, frames stay unclosed longer than intended and the
     * decoder's frame pool can exhaust, stalling the whole pipeline (observed:
     * hard stall after ~20 frames). Bounding to 1 in-flight call means a frame
     * is always closed (via .finally()) before the next one starts; any frame
     * that arrives while one is already in flight is simply left as
     * latestFrame and picked up either by the retry below or the next caller
     * — never captured by a second concurrent createImageBitmap call.
     *
     * Known limitation (matches the worker path): no offsetX/offsetY
     * compositing — transferFromImageBitmap always fills the whole canvas, so
     * letterbox/pillarbox positioning isn't applied here. Fine under the
     * default stretchToFit=true where offsets are always 0.
     */
    private drawStoredFrameBitmap(frame: VideoFrame) {
        if (!this.bitmapCtx) {
            frame.close()
            return
        }
        if (this.bitmapDrawInFlight) {
            // Leave latestFrame/latestFrameDrawn alone — whichever frame is
            // current once the in-flight draw finishes gets picked up by the
            // retry in .finally() below (or the next rAF/readLoop call).
            return
        }
        const arrivedAt = this.latestFrameArrivedAt
        this.latestFrameDrawn = true
        this.drawnFrameCount++
        this.latestFrame = null
        this.bitmapDrawInFlight = true

        // No Promise.finally in the ES6 target — duplicate the in-flight
        // clear + retry in both branches instead.
        const settle = () => {
            this.bitmapDrawInFlight = false
            // Don't wait for the next rAF tick (up to 16.7ms away) to pick up
            // a frame that arrived while this one was in flight.
            this.drawStoredFrame()
        }
        createImageBitmap(frame, {
            resizeWidth: this.drawWidth,
            resizeHeight: this.drawHeight,
            resizeQuality: "low",
        }).then((bitmap) => {
            this.bitmapCtx?.transferFromImageBitmap(bitmap)
            bitmap.close()
            frame.close()
            this.recordDrawCompletion(arrivedAt)
            settle()
        }).catch(() => {
            frame.close()
            settle()
        })
    }

    /** Arrival→draw latency + inter-draw gap bookkeeping. */
    private recordDrawCompletion(arrivedAt: number) {
        const now = performance.now()
        // Arrival→draw latency: ~0ms with draw-on-arrival, 0-16.7ms rAF-paced.
        // The A/B signal for the drawOnArrival setting, shown in the overlay.
        const latency = now - arrivedAt
        this.drawLatencyAvgMs = this.drawLatencyAvgMs < 0
            ? latency
            : this.drawLatencyAvgMs * 0.9 + latency * 0.1
        if (latency > this.drawLatencyMaxMs) this.drawLatencyMaxMs = latency
        // Inter-draw gap (jank signal)
        if (this.lastDrawTime > 0) {
            const gap = now - this.lastDrawTime
            if (this.drawGapMin < 0 || gap < this.drawGapMin) this.drawGapMin = gap
            if (gap > this.drawGapMax) this.drawGapMax = gap
            this.drawGapAvg = this.drawGapAvg < 0 ? gap : this.drawGapAvg * 0.9 + gap * 0.1
            // "Jump" = gap well above the observed cadence. A fixed 25ms
            // threshold flagged every normal 40ms gap on 25/30fps content
            // (2026-07-17 field dump: jumps=49 in one 2s window at 25fps).
            const jumpThreshold = this.drawGapAvg > 0 ? Math.max(25, this.drawGapAvg * 1.75) : 25
            if (gap > jumpThreshold) this.drawJumpCount++
        }
        this.lastDrawTime = now
    }

    private offsetX = 0;
    private offsetY = 0;
    private drawWidth = 0;
    private drawHeight = 0;
    // true when the worker has taken ownership of the ReadableStream via setStream transfer
    private workerOwnsStream: boolean = false
    private rafMissedFrames: number = 0;  // rAF ticks with no decoded frame ready (stream not started)
    private drawnFrameCount: number = 0;
    private latestFrameDrawn: boolean = false;  // true once we've drawn the current latestFrame
    // Draw frames the moment they arrive instead of waiting for the next rAF
    // tick (main-thread mode only; the worker path always draws on arrival)
    private drawOnArrival: boolean = true;
    private latestFrameArrivedAt: number = 0;   // performance.now() when latestFrame was stored
    private drawLatencyAvgMs: number = -1;      // EMA of arrival→draw latency
    private drawLatencyMaxMs: number = -1;      // rolling max, reset per diagnostics read
    // Main-thread frame pacing stats
    private mainArrivedCount: number = 0;       // total frames received by readLoop
    private mainSupersededCount: number = 0;    // frames closed without ever being drawn
    private lastDrawTime: number = 0;           // performance.now() of last draw
    private drawGapMin: number = -1;
    private drawGapAvg: number = -1;
    private drawGapMax: number = -1;
    private drawJumpCount: number = 0;          // draw gaps > 25ms in current diagnostics interval
    // Stats received from the render worker (worker mode)
    private workerDrawnFrameCount: number = 0;
    private workerDroppedFrameCount: number = 0;
    private workerArrivedCount: number = 0;
    private workerMinGapMs: number = -1;
    private workerAvgGapMs: number = -1;
    private workerMaxGapMs: number = -1;
    // Last state requested via setStatsEnabled(), replayed once the worker
    // actually exists — the stats overlay's initial show() typically fires
    // before startRendering() has created renderWorker, so a plain postMessage
    // here would silently no-op and stats would never turn on for worker mode.
    private statsEnabledDesired: boolean = false;

    setStatsEnabled(enabled: boolean) {
        this.statsEnabledDesired = enabled
        if (this.renderWorker) {
            this.renderWorker.postMessage({ type: enabled ? 'enable-stats' : 'disable-stats' })
        }
    }

    /**
     * Sets the draw-buffer size. Once transferControlToOffscreen() has been
     * called, canvas.width/height can no longer be assigned (throws
     * InvalidStateError) — the OffscreenCanvas object must be resized
     * instead. Falls back to the regular canvas when no transfer happened.
     */
    private resizeDrawTarget(width: number, height: number) {
        if (this.offscreenCanvas) {
            this.offscreenCanvas.width = width
            this.offscreenCanvas.height = height
        } else if (this.canvas) {
            this.canvas.width = width
            this.canvas.height = height
        }
    }

    public onFirstFrameAfterResize(frame: VideoFrame) {
        if(!this.canvas) return
        // Calculate aspect ratios
        const canvasAspect = this.canvas.clientWidth / this.canvas.clientHeight
        const frameAspect = frame.displayWidth / frame.displayHeight

        // Reset offsets to avoid stale values from a previous layout
        this.offsetX = 0
        this.offsetY = 0

        if (this.stretchToFit) {
            const w = this.canvas.clientWidth
            const h = this.canvas.clientHeight
            this.resizeDrawTarget(w, h)
            this.drawWidth = w
            this.drawHeight = h
            this.offsetX = 0
            this.offsetY = 0
        } else {
            const w = frame.displayWidth
            const h = frame.displayHeight
            this.resizeDrawTarget(w, h)

            if (canvasAspect > frameAspect) {
                // Canvas is wider than the video frame, so the video will be pillarboxed.
                this.drawHeight = h
                this.drawWidth = this.drawHeight * frameAspect
                this.offsetX = (w - this.drawWidth) / 2
            } else {
                // Canvas is taller than the video frame, so the video will be letterboxed.
                this.drawWidth = w
                this.drawHeight = this.drawWidth / frameAspect
                this.offsetY = (h - this.drawHeight) / 2
            }
        }
    }

    drawLoop() {
        this.drawRafPending = false
        if (!this.isRunning) return

        // Always reschedule — continuous rAF loop ensures we never miss a vsync
        // waiting for readLoop to deliver a frame. Cost when idle: ~1μs per tick.
        this.drawRafPending = true
        this.rafId = requestAnimationFrame(this.drawLoop)

        if ((!this.ctx && !this.bitmapCtx) || !this.canvas) return

        if (!this.latestFrame) {
            // No undrawn frame pending — either stream startup or (with
            // drawOnArrival) the frame was already drawn and closed on arrival.
            this.rafMissedFrames++
            return
        }

        // Fallback draw for a frame that arrived but wasn't drawn on arrival
        // (drawOnArrival disabled, or ctx wasn't ready at arrival time).
        this.drawStoredFrame()
    }

    destroy() {
        this.stopRendering()
        if (this.renderWorker) {
            this.renderWorker.postMessage({ type: "stop" })
            this.renderWorker.terminate()
            this.renderWorker = null
        }
        this.workerRenderingEnabled = false
        if (this.handleResize) {
            window.removeEventListener("resize", this.handleResize)
        }
        if (this.hiddenVideo) {
            this.hiddenVideo.pause()
            this.hiddenVideo.srcObject = null
            this.hiddenVideo.remove()
            this.hiddenVideo = null
        }
        this.canvas = null
        this.ctx = null
        this.bitmapCtx = null
        this.offscreenCanvas = null
    }
}
