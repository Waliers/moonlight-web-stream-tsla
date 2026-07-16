use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicU16, AtomicU32, Ordering};
use std::time::{Duration, Instant};

use log::{info, warn};
use tokio::sync::{
    mpsc::{Receiver, Sender, channel, error::TryRecvError},
};
use webrtc::{
    media::Sample,
    rtcp::packet::Packet,
    rtp::{
        self,
        extension::HeaderExtension,
    },
    rtp_transceiver::rtp_sender::RTCRtpSender,
    track::track_local::{
        TrackLocal, track_local_static_rtp::TrackLocalStaticRTP,
        track_local_static_sample::TrackLocalStaticSample,
    },
};

use crate::StreamConnection;
use crate::video::fec::{UlpfecGenerator, red_wrap};

pub struct TrackLocalSender<Track>
where
    Track: TrackLike,
{
    channel_queue_size: usize,
    pub(crate) stream: Arc<StreamConnection>,
    sender: Option<Sender<Track::Sample>>,
}

impl<Track> TrackLocalSender<Track>
where
    Track: TrackLike,
{
    pub fn new(stream: Arc<StreamConnection>, channel_queue_size: usize) -> Self {
        Self {
            channel_queue_size,
            stream,
            sender: Default::default(),
        }
    }

    /// Pacing rate for the token-bucket sender: 3x the configured stream
    /// bitrate, so sustained throughput is never limited — only bursts far
    /// above the stream rate get smoothed. The floor only guards against a
    /// degenerate near-zero bitrate; it must stay well under the lowest real
    /// preset (1.5 Mbps) or it defeats pacing on exactly the low-bandwidth/
    /// cellular configs this exists to help (a flat 3 MB/s floor here
    /// previously did exactly that — 1.5 Mbps and 3 Mbps presets were paced
    /// at 24 Mbps instead of their intended 4.5/9 Mbps).
    fn pace_bytes_per_sec(&self) -> u64 {
        // settings.bitrate is in kbps -> *125 = bytes/sec
        (self.stream.settings.bitrate as u64 * 125)
            .saturating_mul(3)
            .max(200_000)
    }

    pub fn blocking_create_track(
        &mut self,
        track: Track,
        mut on_packet: impl FnMut(Box<dyn Packet + Send + Sync>) + Send + 'static,
    ) -> Result<(), anyhow::Error> {
        let stream = self.stream.clone();

        let track = Arc::new(track);

        let (sender, receiver) = channel(self.channel_queue_size);

        let pace_bytes_per_sec = self.pace_bytes_per_sec();
        self.stream.runtime.spawn({
            let track = track.clone();
            async move {
                sample_sender(track, receiver, pace_bytes_per_sec).await;
            }
        });

        let track_sender = self.stream.runtime.block_on({
            let track = track.clone();
            async move { stream.peer.add_track(track.track()).await }
        })?;

        // Read incoming RTCP packets.
        // Before these packets are returned they are processed by interceptors. For things
        // like NACK this needs to be called.
        self.stream.runtime.spawn(async move {
            let mut rtcp_buf = vec![0u8; 1500];
            while let Ok((packets, _)) = track_sender.read(&mut rtcp_buf).await {
                for packet in packets {
                    on_packet(packet);
                }
            }
        });

        self.sender.replace(sender);

        Ok(())
    }

    pub fn blocking_send_sample(&self, sample: Track::Sample) {
        if let Some(sender) = self.sender.as_ref() {
            let _ = sender.blocking_send(sample);
        }
    }
}

impl TrackLocalSender<SequencedTrackLocalStaticRTP> {
    /// Activate the sender by replacing the track on an existing transceiver sender.
    /// This is codec-agnostic: the transceiver was added with all codecs in the SDP,
    /// and we now attach the track for whichever codec Moonlight actually selected.
    /// No renegotiation is triggered. When `fec` is set, the track must have been
    /// created with the "video/red" capability — see [`VideoFecConfig`].
    pub fn blocking_activate_via_replace_track(
        &mut self,
        track: Arc<TrackLocalStaticRTP>,
        rtp_sender: Arc<RTCRtpSender>,
        fec: Option<VideoFecConfig>,
        mut on_packet: impl FnMut(Box<dyn Packet + Send + Sync>) + Send + 'static,
    ) -> Result<(), anyhow::Error> {
        let sequenced = Arc::new(SequencedTrackLocalStaticRTP::from_arc_with_fec(
            track.clone(),
            fec,
        ));

        // Attach the track to the pre-existing transceiver sender.
        // The inner TrackLocalStaticRTP is what pion binds to its interceptor chain.
        self.stream.runtime.block_on(
            rtp_sender.replace_track(Some(sequenced.track.clone()))
        )?;

        let (sender, receiver) = channel(self.channel_queue_size);

        let pace_bytes_per_sec = self.pace_bytes_per_sec();
        self.stream.runtime.spawn({
            let track = sequenced.clone();
            async move {
                sample_sender(track, receiver, pace_bytes_per_sec).await;
            }
        });

        self.stream.runtime.spawn(async move {
            let mut rtcp_buf = vec![0u8; 1500];
            while let Ok((packets, _)) = rtp_sender.read(&mut rtcp_buf).await {
                for packet in packets {
                    on_packet(packet);
                }
            }
        });

        self.sender.replace(sender);
        Ok(())
    }
}

/// Safety valve for the pacer's local queue: ~4096 packets (≈5MB) means the
/// link has been unable to drain for a long time — drop everything queued and
/// let the receiver recover via PLI instead of growing without bound.
const PACE_QUEUE_MAX: usize = 4096;

async fn sample_sender<Track>(
    track: Arc<Track>,
    mut receiver: Receiver<Track::Sample>,
    pace_bytes_per_sec: u64,
) where
    Track: TrackLike,
{
    // We do NOT send the PlayoutDelayExtension.
    // Setting it to (0, 0) disables WebRTC's adaptive jitter buffer, causing severe frame drops
    // on cellular networks with 20ms+ latency jitter. Letting the browser manage its own jitter
    // buffer is essential for smooth real-time streaming over variable networks.
    let extensions = [];

    // Token-bucket pacer. A normal frame fits inside the burst allowance and is
    // sent immediately, exactly as before; only bursts well above the sustained
    // rate (IDR/recovery frames, which can be 20+ packets back-to-back) get
    // spread out, so they don't overflow the downlink queue and cause the
    // loss → PLI → another IDR spiral on constrained links. Refill is based on
    // measured elapsed time, so coarse OS timers only reduce smoothing
    // granularity — never throughput.
    let rate = pace_bytes_per_sec.max(1) as f64;
    let burst_bytes = (rate * 0.005).max(24_000.0);
    let mut budget = burst_bytes;
    let mut last_refill = Instant::now();
    let mut queue: VecDeque<Track::Sample> = VecDeque::new();
    let mut open = true;

    while open || !queue.is_empty() {
        // Move everything already waiting in the channel into the local queue,
        // so the (blocking) decode callback side never stalls on a full channel
        // while we pace.
        loop {
            match receiver.try_recv() {
                Ok(sample) => queue.push_back(sample),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    open = false;
                    break;
                }
            }
        }

        if queue.len() > PACE_QUEUE_MAX {
            warn!(
                "[Stream]: pacer queue exceeded {PACE_QUEUE_MAX} packets, dropping them (link too slow?)"
            );
            queue.clear();
            continue;
        }

        if queue.is_empty() {
            if !open {
                break;
            }
            match receiver.recv().await {
                Some(sample) => queue.push_back(sample),
                None => open = false,
            }
            continue;
        }

        let now = Instant::now();
        budget = (budget + now.duration_since(last_refill).as_secs_f64() * rate).min(burst_bytes);
        last_refill = now;

        if budget <= 0.0 {
            // Out of budget: wait for a refill, but keep accepting packets so
            // the sender side stays unblocked.
            let deficit_secs = (-budget / rate).max(0.0005);
            let sleep = tokio::time::sleep(Duration::from_secs_f64(deficit_secs));
            tokio::pin!(sleep);
            loop {
                tokio::select! {
                    _ = &mut sleep => break,
                    received = receiver.recv(), if open => match received {
                        Some(sample) => queue.push_back(sample),
                        None => open = false,
                    }
                }
            }
            continue;
        }

        while budget > 0.0 {
            let Some(sample) = queue.pop_front() else {
                break;
            };
            budget -= Track::sample_size(&sample) as f64;
            if let Err(err) = track
                .write_with_extensions(
                    sample,
                    &extensions,
                )
                .await
            {
                warn!("[Stream]: track.write_sample failed: {err}");
            }
        }
    }
}

pub trait TrackLike: Send + Sync + 'static {
    type Sample: Send + 'static;

    /// Approximate wire size of a sample, used by the pacer's token bucket.
    fn sample_size(sample: &Self::Sample) -> usize;

    fn write_with_extensions(
        &self,
        sample: Self::Sample,
        extensions: &[HeaderExtension],
    ) -> impl Future<Output = Result<(), anyhow::Error>> + Send;

    fn track(self: Arc<Self>) -> Arc<dyn TrackLocal + Send + Sync + 'static>;
}

impl TrackLike for TrackLocalStaticSample {
    type Sample = Sample;

    fn sample_size(sample: &Self::Sample) -> usize {
        sample.data.len()
    }

    async fn write_with_extensions(
        &self,
        sample: Self::Sample,
        extensions: &[HeaderExtension],
    ) -> Result<(), anyhow::Error> {
        self.write_sample_with_extensions(&sample, extensions)
            .await
            .map_err(anyhow::Error::from)
    }

    fn track(self: Arc<Self>) -> Arc<dyn TrackLocal + Send + Sync + 'static> {
        self
    }
}

/// Configuration for the ULPFEC/RED layer of a video track. Present only when
/// the remote offer advertised red+ulpfec and the setting is enabled; the
/// track itself must then be created with the "video/red" capability so the
/// binding stamps the negotiated RED payload type on every outgoing packet.
pub struct VideoFecConfig {
    /// Used to look up the negotiated media/ulpfec payload types once bound.
    pub rtp_sender: Arc<RTCRtpSender>,
    /// Mime of the inner media codec, lowercase (e.g. "video/h264").
    pub media_mime: String,
    /// fmtp substring disambiguating between multiple entries of the same
    /// mime (e.g. "42e01f" vs "640032"); falls back to first mime match.
    pub media_fmtp_hint: Option<String>,
}

struct FecRuntime {
    config: VideoFecConfig,
    /// (media_pt, ulpfec_pt) — resolved from the negotiated codec list on
    /// first bound write and cached. These are the payload types the browser
    /// expects inside RED blocks.
    resolved: OnceLock<(u8, u8)>,
    generator: Mutex<UlpfecGenerator>,
    unresolved_drops: AtomicU32,
}

impl FecRuntime {
    /// The negotiated parameters are authoritative: they are what our SDP
    /// answer declared, which is what the browser configured its RED
    /// demuxer/FEC receiver with. Only callable usefully once the track is
    /// bound (which implies negotiation completed).
    async fn resolve(&self) -> Option<(u8, u8)> {
        if let Some(pts) = self.resolved.get() {
            return Some(*pts);
        }

        let params = self.config.rtp_sender.get_parameters().await;
        let mut media_pt = None;
        let mut media_pt_any = None;
        let mut ulpfec_pt = None;
        for codec in &params.rtp_parameters.codecs {
            let mime = codec.capability.mime_type.to_ascii_lowercase();
            if mime == "video/ulpfec" {
                ulpfec_pt.get_or_insert(codec.payload_type);
            } else if mime == self.config.media_mime {
                media_pt_any.get_or_insert(codec.payload_type);
                let hint_matches = self
                    .config
                    .media_fmtp_hint
                    .as_deref()
                    .is_none_or(|hint| codec.capability.sdp_fmtp_line.contains(hint));
                if hint_matches {
                    media_pt.get_or_insert(codec.payload_type);
                }
            }
        }

        let media_pt = media_pt.or(media_pt_any)?;
        let ulpfec_pt = ulpfec_pt?;
        let pts = *self.resolved.get_or_init(|| (media_pt, ulpfec_pt));
        info!(
            "[Stream] Video FEC active: RED-wrapped media pt={} + ulpfec pt={}",
            pts.0, pts.1
        );
        Some(pts)
    }
}

/// Test hook: `FEC_TEST_DROP_PERCENT=N` silently discards N% of outgoing
/// video media packets AFTER they were recorded for FEC and BEFORE they reach
/// the wire — the receiver sees genuine loss that NACK retransmission cannot
/// repair (the responder never cached the packet), so any recovery observed
/// can only come from FEC. Used by the local E2E harness; never set in
/// production.
fn fec_test_drop_percent() -> u32 {
    static CACHED: OnceLock<u32> = OnceLock::new();
    *CACHED.get_or_init(|| {
        std::env::var("FEC_TEST_DROP_PERCENT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
            .min(50)
    })
}

fn fec_test_should_drop(counter: &AtomicU32) -> bool {
    let percent = fec_test_drop_percent();
    if percent == 0 {
        return false;
    }
    // Deterministic spread: drop every (100/percent)-th packet.
    let n = counter.fetch_add(1, Ordering::Relaxed);
    n % (100 / percent) == (100 / percent) - 1
}

pub struct SequencedTrackLocalStaticRTP {
    track: Arc<TrackLocalStaticRTP>,
    sequence_number: AtomicU16,
    fec: Option<FecRuntime>,
    test_drop_counter: AtomicU32,
}

impl From<TrackLocalStaticRTP> for SequencedTrackLocalStaticRTP {
    fn from(value: TrackLocalStaticRTP) -> Self {
        Self {
            track: Arc::new(value),
            sequence_number: AtomicU16::new(0),
            fec: None,
            test_drop_counter: AtomicU32::new(0),
        }
    }
}

impl SequencedTrackLocalStaticRTP {
    pub(crate) fn from_arc(track: Arc<TrackLocalStaticRTP>) -> Self {
        Self::from_arc_with_fec(track, None)
    }

    pub(crate) fn from_arc_with_fec(
        track: Arc<TrackLocalStaticRTP>,
        fec: Option<VideoFecConfig>,
    ) -> Self {
        Self {
            track,
            sequence_number: AtomicU16::new(0),
            fec: fec.map(|config| FecRuntime {
                config,
                resolved: OnceLock::new(),
                generator: Mutex::new(UlpfecGenerator::default()),
                unresolved_drops: AtomicU32::new(0),
            }),
            test_drop_counter: AtomicU32::new(0),
        }
    }

    /// FEC path: RED-wrap the media packet, record it for parity, and after
    /// the frame's marker packet emit the ULPFEC parity packets (RED-wrapped,
    /// consuming sequence numbers in the same space, as Chromium requires).
    async fn write_with_fec(
        &self,
        mut sample: rtp::packet::Packet,
        extensions: &[HeaderExtension],
        fec: &FecRuntime,
        media_pt: u8,
        ulpfec_pt: u8,
    ) -> Result<(), anyhow::Error> {
        let timestamp = sample.header.timestamp;
        let marker = sample.header.marker;

        sample.header.sequence_number = self.sequence_number.fetch_add(1, Ordering::Relaxed);

        {
            let mut generator = fec.generator.lock().unwrap();
            // A frame that never saw its marker (e.g. packetize error on the
            // last NAL) would otherwise leak its packets into the next
            // frame's parity groups. Cross-frame parity is legal ULPFEC, but
            // an unbounded group is not — flush at the timestamp boundary.
            if generator.pending_timestamp().is_some_and(|ts| ts != timestamp) {
                generator.reset();
            }
            generator.push_media_packet(
                sample.header.sequence_number,
                marker,
                timestamp,
                media_pt,
                sample.payload.clone(),
            );
        }

        sample.payload = red_wrap(media_pt, &sample.payload);
        // Test hook: skip the wire write (loss simulation) but keep the FEC
        // record above and the parity emission below — the receiver must then
        // recover this packet from parity alone.
        if !fec_test_should_drop(&self.test_drop_counter) {
            self.track
                .write_rtp_with_extensions(&sample, extensions)
                .await?;
        }

        if marker {
            let parities = fec.generator.lock().unwrap().finish_frame();
            for parity in parities {
                let packet = rtp::packet::Packet {
                    header: rtp::header::Header {
                        version: 2,
                        sequence_number: self.sequence_number.fetch_add(1, Ordering::Relaxed),
                        timestamp,
                        // payload_type and ssrc are stamped by the binding
                        ..Default::default()
                    },
                    payload: red_wrap(ulpfec_pt, &parity),
                };
                self.track
                    .write_rtp_with_extensions(&packet, extensions)
                    .await?;
            }
        }

        Ok(())
    }
}

impl TrackLike for SequencedTrackLocalStaticRTP {
    type Sample = rtp::packet::Packet;

    fn sample_size(sample: &Self::Sample) -> usize {
        // 12 bytes fixed RTP header + payload. When FEC is active the wire
        // adds ~15% (RED byte + parity packets) that the pacer doesn't see —
        // fine, since the pacing rate is 3x the stream bitrate.
        12 + sample.payload.len()
    }

    async fn write_with_extensions(
        &self,
        mut sample: Self::Sample,
        extensions: &[HeaderExtension],
    ) -> Result<(), anyhow::Error> {
        if self.track.all_binding_paused().await {
            // Abort already here to not increment sequence numbers.
            return Ok(());
        }

        if let Some(fec) = &self.fec {
            if let Some((media_pt, ulpfec_pt)) = fec.resolve().await {
                return self
                    .write_with_fec(sample, extensions, fec, media_pt, ulpfec_pt)
                    .await;
            }
            // Bound but payload types not resolvable: sending un-wrapped
            // payloads on a RED-typed track would give the browser garbage,
            // so drop and complain. Should be unreachable — FEC is only
            // enabled after red+ulpfec were seen in the remote offer.
            let drops = fec.unresolved_drops.fetch_add(1, Ordering::Relaxed);
            if drops % 300 == 0 {
                warn!(
                    "[Stream]: video FEC payload types not negotiated; dropping video \
                     ({drops} packets so far). Disable the Video FEC setting to recover."
                );
            }
            return Ok(());
        }

        sample.header.sequence_number = self.sequence_number.fetch_add(1, Ordering::Relaxed);

        // Test hook (control runs): simulate unrecoverable loss on the plain
        // path too, so FEC-on vs FEC-off can be compared under identical loss.
        if fec_test_should_drop(&self.test_drop_counter) {
            return Ok(());
        }

        self.track
            .write_rtp_with_extensions(&sample, extensions)
            .await
            .map_err(anyhow::Error::from)
            .map(|_| ())
    }

    fn track(self: Arc<Self>) -> Arc<dyn TrackLocal + Send + Sync + 'static> {
        self.track.clone()
    }
}
