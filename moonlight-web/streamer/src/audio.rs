use std::io::Write;
use std::sync::Arc;

use log::{info, warn};
use moonlight_common::stream::{
    audio::AudioDecoder,
    bindings::{AudioConfig, OpusMultistreamConfig},
};
use ogg::{PacketWriteEndInfo, PacketWriter};
use tokio::sync::mpsc::{self, Sender};
use tokio::sync::Notify;
use tokio::time::{self, Duration};
use webrtc::{
    api::media_engine::{MIME_TYPE_OPUS, MediaEngine},
    data_channel::{RTCDataChannel, data_channel_state::RTCDataChannelState},
    rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType},
};

pub fn register_audio_codecs(media_engine: &mut MediaEngine) -> Result<(), webrtc::Error> {
    media_engine.register_codec(
        RTCRtpCodecParameters {
            capability: RTCRtpCodecCapability {
                mime_type: MIME_TYPE_OPUS.to_owned(),
                clock_rate: 48000,
                channels: 2,
                sdp_fmtp_line: "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=256000".to_owned(),
                rtcp_feedback: vec![],
            },
            payload_type: 111,
            ..Default::default()
        },
        RTPCodecType::Audio,
    )?;

    Ok(())
}

pub struct OpusTrackSampleAudioDecoder {
    channel: Arc<RTCDataChannel>,
    channel_open: Arc<Notify>,
    sender: Option<Sender<Vec<u8>>>,
    config: Option<OpusMultistreamConfig>,
}

impl OpusTrackSampleAudioDecoder {
    pub fn new(channel: Arc<RTCDataChannel>, channel_open: Arc<Notify>) -> Self {
        Self {
            channel,
            channel_open,
            sender: None,
            config: None,
        }
    }
}

/// `io::Write` sink appending into a `BytesMut`, so the Ogg writer serializes
/// pages straight into the DataChannel aggregation buffer (no intermediate
/// chunk copies or channel hop).
struct BytesMutWriter(bytes::BytesMut);
impl Write for BytesMutWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl AudioDecoder for OpusTrackSampleAudioDecoder {
    fn setup(
        &mut self,
        audio_config: AudioConfig,
        stream_config: OpusMultistreamConfig,
        _ar_flags: i32,
    ) -> i32 {
        info!("[Stream] Audio setup: {audio_config:?}, {stream_config:?}");

        const SUPPORTED_SAMPLE_RATES: &[u32] = &[8000, 12000, 16000, 24000, 48000];
        if !SUPPORTED_SAMPLE_RATES.contains(&stream_config.sample_rate) {
            warn!(
                "[Stream] Audio could have problems because of the sample rate, Selected: {}, Expected one of: {SUPPORTED_SAMPLE_RATES:?}",
                stream_config.sample_rate
            );
        }
        if audio_config != self.config() {
            warn!(
                "[Stream] A different audio configuration than requested was selected, Expected: {:?}, Found: {audio_config:?}",
                self.config()
            );
        }

        let samples_per_frame = stream_config.samples_per_frame as u64;
        self.config = Some(stream_config);

        let (sender, mut receiver) = mpsc::channel::<Vec<u8>>(50);
        self.sender = Some(sender);

        let channel = self.channel.clone();
        let channel_open = self.channel_open.clone();

        tokio::spawn(async move {
            // Wait for the DataChannel to be open before sending anything.
            // With pre-emptive stream start, audio setup may happen before ICE connects.
            if channel.ready_state() != RTCDataChannelState::Open {
                channel_open.notified().await;
            }

            // Ogg pages are serialized directly into this writer's BytesMut,
            // which doubles as the aggregation buffer for outgoing sends.
            let mut writer = PacketWriter::new(BytesMutWriter(bytes::BytesMut::with_capacity(4096)));
            let serial = 12345;
            let mut granule_pos = 0;

            // Write ID Header
            let mut id_header = Vec::new();
            id_header.extend_from_slice(b"OpusHead");
            id_header.push(1); // Version
            id_header.push(2); // Channels
            id_header.extend_from_slice(&0u16.to_le_bytes()); // Pre-skip
            id_header.extend_from_slice(&48000u32.to_le_bytes()); // Sample rate
            id_header.extend_from_slice(&0u16.to_le_bytes()); // Gain
            id_header.push(0); // Mapping family

            if let Err(e) = writer.write_packet(
                id_header,
                serial,
                PacketWriteEndInfo::EndPage,
                granule_pos,
            ) {
                warn!("Failed to write ID header: {:?}", e);
            }

            // Write Comment Header
            let mut comment_header = Vec::new();
            comment_header.extend_from_slice(b"OpusTags");
            let vendor = "Moonlight";
            comment_header.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
            comment_header.extend_from_slice(vendor.as_bytes());
            comment_header.extend_from_slice(&0u32.to_le_bytes()); // User comment list length

            if let Err(e) = writer.write_packet(
                comment_header,
                serial,
                PacketWriteEndInfo::EndPage,
                granule_pos,
            ) {
                warn!("Failed to write comment header: {:?}", e);
            }

            // Send the header pages together as the first message.
            let initial_payload = writer.inner_mut().0.split().freeze();
            if !initial_payload.is_empty()
                && let Err(e) = channel.send(&initial_payload).await
            {
                warn!("Failed to send Ogg headers: {:?}", e);
            }

            // Flush interval — batches multiple Opus frames into one DataChannel message.
            // At 48kHz/5ms per frame, 20ms accumulates ~4 frames per send (~50 msg/s).
            // Field data (2026-07-07) showed the Tesla renderer stalls scale with
            // per-packet/per-message cost, and every DataChannel message costs a
            // main-thread onmessage + a worker postMessage on the client — so fewer,
            // larger messages directly buy back Tesla CPU budget. Latency impact is
            // irrelevant: the playback worklet primes 150ms regardless. The tradeoff
            // is 20ms (not more) because the channel is unreliable (max_retransmits
            // 0) — one lost SCTP message now costs 20ms of audio instead of 10ms,
            // which Opus PLC still conceals well.
            let mut interval = time::interval(Duration::from_millis(20));

            loop {
                tokio::select! {
                    biased;
                    _ = interval.tick() => {
                        if !writer.inner_mut().0.is_empty() {
                            let payload = writer.inner_mut().0.split().freeze();
                            if let Err(e) = channel.send(&payload).await {
                                warn!("Failed to send aggregated audio data: {:?}", e);
                            }
                        }
                    }
                    maybe = receiver.recv() => {
                        match maybe {
                            Some(data) => {
                                granule_pos += samples_per_frame;

                                // `data` is moved in as Cow::Owned — no copy.
                                if let Err(e) = writer.write_packet(
                                    data,
                                    serial,
                                    PacketWriteEndInfo::EndPage,
                                    granule_pos,
                                ) {
                                    warn!("Failed to write audio packet: {:?}", e);
                                }

                                // If the accumulated payload is large, flush immediately
                                if writer.inner_mut().0.len() >= 16 * 1024 {
                                    let payload = writer.inner_mut().0.split().freeze();
                                    if let Err(e) = channel.send(&payload).await {
                                        warn!("Failed to send aggregated audio data (eager flush): {:?}", e);
                                    }
                                }
                            }
                            None => {
                                // Receiver closed — flush anything buffered and exit
                                if !writer.inner_mut().0.is_empty() {
                                    let payload = writer.inner_mut().0.split().freeze();
                                    if let Err(e) = channel.send(&payload).await {
                                        warn!("Failed to send final aggregated audio data: {:?}", e);
                                    }
                                }
                                break;
                            }
                        }
                    }
                }
            }
        });

        0
    }

    fn start(&mut self) {}

    fn stop(&mut self) {}

    fn decode_and_play_sample(&mut self, data: &[u8]) {
        if let Some(sender) = &self.sender {
            // One owned copy of the FFI slice; the Ogg writer takes ownership
            // of it downstream (Cow::Owned), so this is the only copy made
            // before the page bytes land in the aggregation buffer.
            let data = data.to_vec();
            // Use try_send to never block the audio receive thread.
            // If the channel is full (data channel transport backpressure),
            // drop the frame — real-time audio should prefer dropping over stalling.
            if sender.try_send(data).is_err() {
                // Channel full — transport can't keep up, drop this frame
            }
        }
    }

    fn config(&self) -> AudioConfig {
        AudioConfig::STEREO
    }
}
