#pragma once
#include <stdint.h>

struct ImuSample {
    uint64_t t_us;
    float qx, qy, qz, qw;  // Body-to-world quaternion, world Z up.
    float wx, wy, wz;      // Body angular velocity, rad/s.
    float ax, ay, az;      // Body linear acceleration, gravity removed, m/s².
    float lax, lay, laz;   // Low-g raw acceleration, gravity included, m/s².
    float hax, hay, haz;   // Latest high-g raw acceleration, gravity included, m/s².
    float hpx, hpy, hpz;   // Highest-norm high-g vector since the previous fusion sample.
    uint32_t high_peak_t_ms; // FIFO dequeue uptime, not sensor acquisition timestamp.
    uint8_t accel_flags;   // bit0 high valid, bit1 high saturated, bit2 peak valid.
};
