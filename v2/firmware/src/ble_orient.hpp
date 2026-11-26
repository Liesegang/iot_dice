#pragma once

#include "imu_sample.hpp"
#include "dice_fsm.hpp"

/*
 * BLE notify protocol — single characteristic, first byte = packet type.
 * All multi-byte fields little-endian.
 *
 * 0x01 POSE (100 B, protocol v3 normal mode) — orientation and motion, approximately 60 Hz
 *   [0]      type
 *   [1]      state = REST
 *   [2..5]   t_ms      u32  uptime
 *   [6..21]  qx qy qz qw    f32×4
 *   [22..33] wx wy wz       f32×3  rad/s (body, bias corrected)
 *   [34..45] ax ay az       f32×3  m/s²  (body, gravity-removed)
 *
 * 0x01 STREAM (100 B, protocol v3) — 120 Hz live stream for visualization/recording
 *   [0]      type
 *   [1]      fsm state (DiceFsm::State)
 *   [2..5]   t_ms      u32  uptime
 *   [6..21]  qx qy qz qw    f32×4
 *   [22..33] wx wy wz       f32×3  rad/s (body)
 *   [34..45] ax ay az       f32×3  m/s²  (body, gravity-removed)
 *   [46..57] vx vy vz       f32×3  m/s   (world, integrated; 0 in POSE)
 *   [58..69] low-g raw xyz  f32×3  m/s²  (body, includes gravity)
 *   [70..81] high-g raw xyz f32×3  m/s²  (latest 960 Hz sample)
 *   [82]     flags: bit0 high valid, bit1 high saturated, bit2 peak valid
 *   [83]     protocol version = 3
 *   [84..95] high-g peak xyz f32×3 (largest norm over the notification interval)
 *   [96..99] high-g peak FIFO dequeue uptime in ms (not acquisition timestamp)
 *
 * 0x02 IMPACT (76 B) — sent immediately on first table contact;
 *                       carries the PRE-impact state to seed the simulation
 *   [0]      type
 *   [1]      protocol version = 3
 *   [2..5]   t_ms      u32  impact time
 *   [6..21]  q (pre-impact)
 *   [22..33] w (pre-impact, body)
 *   [34..45] v (pre-impact, world)
 *   [46..47] fall_ms   u16
 *   [48]     gyro_sat  u8
 *   [49]     acc_sat   u8
 *   [50..53] pre_t_ms  u32  timestamp of q/w/v
 *   [54..57] throw_id  u32  matches RESULT
 *   [58..69] high-g peak xyz f32×3  m/s² (collision diagnostics, not inference input)
 *   [70..73] high-g peak FIFO dequeue uptime ms
 *   [74]     high saturated u8
 *   [75]     reserved
 *
 * 0x03 RESULT (44 B) — sent when the die settles; ground-truth label source
 *   [0]      type
 *   [1]      protocol version = 3
 *   [2..5]   t_ms      u32
 *   [6..21]  q (rest)
 *   [22..25] max |ω|   f32
 *   [26..29] max |a|   f32
 *   [30]     gyro_sat  u8
 *   [31]     acc_sat   u8
 *   [32..35] throw_id  u32
 *   [36..39] maximum high-g norm f32 m/s²
 *   [40]     high-g saturated sample-window count u8
 *   [41..43] reserved
 *
 * Legacy POSE 22/46, STREAM 58, IMPACT 50/58, RESULT 32/36 remain readable.
 * Firmware sends a shorter legacy prefix if the negotiated MTU is too small.
 */

namespace BleOrient {

int init();

bool simulationEnabled();
void sendPose(const ImuSample &s);
void sendStream(const ImuSample &s, DiceFsm::State state, const float v[3]);
void sendImpact(const DiceFsm::ImpactInfo &info);
void sendResult(const DiceFsm::ResultInfo &info);

} // namespace BleOrient
