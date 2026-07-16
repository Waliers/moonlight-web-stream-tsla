//! ULPFEC (RFC 5109) generation and RED (RFC 2198) encapsulation for the
//! outgoing video track.
//!
//! Why: on cellular, a single lost RTP packet freezes video for ~250-300ms
//! even though NACK retransmission recovers it — the retransmit needs a full
//! RTT, which a gaming-latency jitter buffer (40ms) can't wait out. FEC lets
//! the browser reconstruct the lost packet from parity the moment enough of
//! the frame's other packets arrive: zero added latency, ~10-15% bandwidth.
//!
//! Chromium receives ULPFEC only inside RED, sharing the media SSRC and
//! sequence-number space. So when FEC is active:
//!   - every media packet's payload is prefixed with a 1-byte RED header
//!     carrying the real media payload type,
//!   - after each frame's marker packet, 1 parity packet per group of up to
//!     [`MAX_GROUP_SIZE`] media packets is sent, RED-wrapped with the ulpfec
//!     payload type,
//!   - the on-wire payload type of all of it is the negotiated RED PT
//!     (stamped by the track binding).
//!
//! The parity payload follows RFC 5109 with a 16-bit mask (level 0 only):
//! FEC header (10 bytes) + level header (4 bytes) + XOR of the protected
//! packets' payloads. Recovery of a missing packet is: XOR the parity with
//! the received packets' fields/payloads. The tests below implement that
//! receiver side to prove bit-exact reconstruction.

use bytes::Bytes;

/// Max media packets protected by one parity packet. Each group tolerates
/// one lost packet, so smaller groups = stronger protection = more overhead.
/// 10 ≈ 10-15% overhead and matches the observed single-loss pattern.
pub const MAX_GROUP_SIZE: usize = 10;

/// One media packet recorded for parity generation: the fields the receiver
/// reconstructs, exactly as they appear AFTER RED decapsulation.
struct ProtectedPacket {
    sequence_number: u16,
    marker: bool,
    timestamp: u32,
    payload_type: u8,
    payload: Bytes,
}

/// Prefix `payload` with a single-block RED header (RFC 2198): one byte,
/// F-bit 0 (final block) + the 7-bit payload type of the wrapped content.
pub fn red_wrap(inner_payload_type: u8, payload: &[u8]) -> Bytes {
    let mut out = Vec::with_capacity(1 + payload.len());
    out.push(inner_payload_type & 0x7F);
    out.extend_from_slice(payload);
    Bytes::from(out)
}

/// Accumulates the media packets of the current video frame and produces the
/// ULPFEC parity payloads (pre-RED) when the frame completes.
#[derive(Default)]
pub struct UlpfecGenerator {
    packets: Vec<ProtectedPacket>,
}

impl UlpfecGenerator {
    /// Record one media packet (pre-RED fields) of the current frame.
    pub fn push_media_packet(
        &mut self,
        sequence_number: u16,
        marker: bool,
        timestamp: u32,
        payload_type: u8,
        payload: Bytes,
    ) {
        self.packets.push(ProtectedPacket {
            sequence_number,
            marker,
            timestamp,
            payload_type,
            payload,
        });
    }

    /// Frame complete: emit one parity payload per group of consecutive
    /// packets and reset for the next frame.
    pub fn finish_frame(&mut self) -> Vec<Vec<u8>> {
        let packets = std::mem::take(&mut self.packets);
        packets
            .chunks(MAX_GROUP_SIZE)
            .map(generate_parity)
            .collect()
    }

    /// Drop any half-recorded frame (e.g. a frame that never saw its marker
    /// packet) so stale packets can't be XORed into the next frame's parity.
    pub fn reset(&mut self) {
        self.packets.clear();
    }

    /// Timestamp of the frame currently being recorded, if any.
    pub fn pending_timestamp(&self) -> Option<u32> {
        self.packets.first().map(|p| p.timestamp)
    }
}

/// Build one RFC 5109 ULPFEC payload protecting `group` (≤ 16 packets, all
/// sequence numbers within a 16-slot window — guaranteed by consecutive
/// numbering and MAX_GROUP_SIZE).
fn generate_parity(group: &[ProtectedPacket]) -> Vec<u8> {
    debug_assert!(!group.is_empty() && group.len() <= 16);

    let sn_base = group[0].sequence_number;
    let protection_length = group.iter().map(|p| p.payload.len()).max().unwrap_or(0);

    // Recovery fields: XOR over all protected packets. P/X/CC recovery are 0
    // because our packetizer emits no padding, extensions, or CSRCs — but the
    // XOR form is kept so that ever changing that doesn't corrupt recovery.
    let mut m_rec = false;
    let mut pt_rec: u8 = 0;
    let mut ts_rec: u32 = 0;
    let mut len_rec: u16 = 0;
    let mut mask: u16 = 0;
    for p in group {
        m_rec ^= p.marker;
        pt_rec ^= p.payload_type & 0x7F;
        ts_rec ^= p.timestamp;
        len_rec ^= p.payload.len() as u16;
        let offset = p.sequence_number.wrapping_sub(sn_base);
        debug_assert!(offset < 16);
        mask |= 0x8000u16 >> offset;
    }

    let mut out = vec![0u8; 14 + protection_length];
    // FEC header (10 bytes)
    out[0] = 0; // E=0, L=0 (16-bit mask), P/X/CC recovery = 0
    out[1] = ((m_rec as u8) << 7) | pt_rec;
    out[2..4].copy_from_slice(&sn_base.to_be_bytes());
    out[4..8].copy_from_slice(&ts_rec.to_be_bytes());
    out[8..10].copy_from_slice(&len_rec.to_be_bytes());
    // Level 0 header (4 bytes)
    out[10..12].copy_from_slice(&(protection_length as u16).to_be_bytes());
    out[12..14].copy_from_slice(&mask.to_be_bytes());
    // Parity: XOR of payloads, zero-padded to protection_length
    for p in group {
        for (i, byte) in p.payload.iter().enumerate() {
            out[14 + i] ^= byte;
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Receiver-side ULPFEC recovery (what Chromium does), used to prove the
    /// generated parity reconstructs a lost packet bit-exactly.
    struct RecoveredPacket {
        sequence_number: u16,
        marker: bool,
        timestamp: u32,
        payload_type: u8,
        payload: Vec<u8>,
    }

    fn recover(parity: &[u8], received: &[&ProtectedPacket], lost_seq: u16) -> RecoveredPacket {
        assert_eq!(parity[0], 0, "E/L/P/X/CC recovery must be 0 for our streams");
        let mut m = (parity[1] >> 7) != 0;
        let mut pt = parity[1] & 0x7F;
        let sn_base = u16::from_be_bytes([parity[2], parity[3]]);
        let mut ts = u32::from_be_bytes([parity[4], parity[5], parity[6], parity[7]]);
        let mut len = u16::from_be_bytes([parity[8], parity[9]]);
        let protection_length = u16::from_be_bytes([parity[10], parity[11]]) as usize;
        let mask = u16::from_be_bytes([parity[12], parity[13]]);

        // The lost packet must be covered by the mask
        assert_ne!(mask & (0x8000 >> lost_seq.wrapping_sub(sn_base)), 0);

        let mut payload = parity[14..14 + protection_length].to_vec();
        for p in received {
            m ^= p.marker;
            pt ^= p.payload_type & 0x7F;
            ts ^= p.timestamp;
            len ^= p.payload.len() as u16;
            for (i, byte) in p.payload.iter().enumerate() {
                payload[i] ^= byte;
            }
        }
        payload.truncate(len as usize);

        RecoveredPacket {
            sequence_number: lost_seq,
            marker: m,
            timestamp: ts,
            payload_type: pt,
            payload,
        }
    }

    fn make_frame(seq_start: u16, ts: u32, pt: u8, sizes: &[usize]) -> Vec<ProtectedPacket> {
        sizes
            .iter()
            .enumerate()
            .map(|(i, &size)| ProtectedPacket {
                sequence_number: seq_start.wrapping_add(i as u16),
                marker: i == sizes.len() - 1,
                timestamp: ts,
                payload_type: pt,
                payload: Bytes::from(
                    (0..size).map(|b| (b as u8) ^ (i as u8) ^ 0x5A).collect::<Vec<u8>>(),
                ),
            })
            .collect()
    }

    fn assert_recovers_every_packet(packets: &[ProtectedPacket]) {
        let mut generator = UlpfecGenerator::default();
        for p in packets {
            generator.push_media_packet(
                p.sequence_number,
                p.marker,
                p.timestamp,
                p.payload_type,
                p.payload.clone(),
            );
        }
        let parities = generator.finish_frame();
        assert_eq!(parities.len(), packets.len().div_ceil(MAX_GROUP_SIZE));

        for (group, parity) in packets.chunks(MAX_GROUP_SIZE).zip(&parities) {
            for lost_index in 0..group.len() {
                let received: Vec<&ProtectedPacket> = group
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| *i != lost_index)
                    .map(|(_, p)| p)
                    .collect();
                let lost = &group[lost_index];
                let recovered = recover(parity, &received, lost.sequence_number);
                assert_eq!(recovered.sequence_number, lost.sequence_number);
                assert_eq!(recovered.marker, lost.marker);
                assert_eq!(recovered.timestamp, lost.timestamp);
                assert_eq!(recovered.payload_type, lost.payload_type);
                assert_eq!(recovered.payload, lost.payload.to_vec());
            }
        }
    }

    #[test]
    fn recovers_any_single_loss_in_typical_frame() {
        // 7 packets ≈ a 4 Mbps 60fps frame; unequal sizes exercise padding
        assert_recovers_every_packet(&make_frame(1000, 0x1234_5678, 96, &[1188, 1188, 1188, 1188, 1188, 1188, 431]));
    }

    #[test]
    fn recovers_in_multi_group_idr_frame() {
        // 23 packets ≈ an IDR burst → 3 groups (10/10/3)
        let sizes: Vec<usize> = (0..23).map(|i| 1188 - (i * 7) % 300).collect();
        assert_recovers_every_packet(&make_frame(64000, 0xDEAD_BEEF, 127, &sizes));
    }

    #[test]
    fn recovers_single_packet_frame() {
        assert_recovers_every_packet(&make_frame(42, 90_000, 96, &[17]));
    }

    #[test]
    fn recovers_across_sequence_wraparound() {
        assert_recovers_every_packet(&make_frame(65534, 3_000_000_000, 96, &[900, 900, 900, 900]));
    }

    #[test]
    fn red_wrap_prepends_single_block_header() {
        let wrapped = red_wrap(96, &[0xAA, 0xBB]);
        assert_eq!(&wrapped[..], &[96, 0xAA, 0xBB]);
        // F bit must be 0 even for PTs with the high bit set
        assert_eq!(red_wrap(0xFF, &[])[0], 0x7F);
    }

    #[test]
    fn reset_discards_partial_frame() {
        let mut generator = UlpfecGenerator::default();
        generator.push_media_packet(1, false, 100, 96, Bytes::from_static(&[1, 2, 3]));
        generator.reset();
        assert!(generator.finish_frame().is_empty());
    }
}
