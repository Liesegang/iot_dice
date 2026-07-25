#pragma once

#include "bno085.hpp"
#include "dice_fsm.hpp"

/*
 * BLE notify protocol — single characteristic, first byte = packet type.
 * All multi-byte fields little-endian.
 *
 * 0x01 STREAM (58 B) — decimated live stream for visualization/recording
 *   [0]      type
 *   [1]      fsm state (DiceFsm::State)
 *   [2..5]   t_ms      u32  uptime
 *   [6..21]  qx qy qz qw    f32×4
 *   [22..33] wx wy wz       f32×3  rad/s (body)
 *   [34..45] ax ay az       f32×3  m/s²  (body, gravity-removed)
 *   [46..57] vx vy vz       f32×3  m/s   (world, integrated)
 *
 * 0x02 IMPACT (50 B) — sent immediately on first table contact;
 *                       carries the PRE-impact state to seed the simulation
 *   [0]      type
 *   [1]      reserved
 *   [2..5]   t_ms      u32  impact time
 *   [6..21]  q (pre-impact)
 *   [22..33] w (pre-impact, body)
 *   [34..45] v (pre-impact, world)
 *   [46..47] fall_ms   u16
 *   [48]     gyro_sat  u8
 *   [49]     acc_sat   u8
 *
 * 0x03 RESULT (32 B) — sent when the die settles; ground-truth label source
 *   [0]      type
 *   [1]      reserved
 *   [2..5]   t_ms      u32
 *   [6..21]  q (rest)
 *   [22..25] max |ω|   f32
 *   [26..29] max |a|   f32
 *   [30]     gyro_sat  u8
 *   [31]     acc_sat   u8
 */

namespace BleOrient {

void init();

void sendStream(const BNO085::Sample &s, DiceFsm::State state, const float v[3]);
void sendImpact(const DiceFsm::ImpactInfo &info);
void sendResult(const DiceFsm::ResultInfo &info);

} // namespace BleOrient
