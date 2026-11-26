#pragma once
#include "imu_sample.hpp"
#include <stdint.h>

// Readable over SWD without stopping the BLE radio or IMU.
struct AppDebug {
    uint32_t heartbeat;
    uint32_t who_am_i;
    int32_t imu_error;
    uint32_t imu_ready;
    uint32_t imu_samples;
    int32_t ble_error;
    uint32_t ble_connected;
    uint32_t notifications;
    uint32_t fifo_overruns;
    ImuSample sample;
    uint32_t high_g_samples;
};
extern "C" { extern volatile AppDebug app_debug; }
