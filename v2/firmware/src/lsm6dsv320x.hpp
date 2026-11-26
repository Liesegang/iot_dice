#pragma once
#include "imu_sample.hpp"
#include "sflp_fifo.hpp"
#include "high_g.hpp"
#include <zephyr/drivers/spi.h>
#include <lsm6dsv320x_reg.h>

class Lsm6dsv320x {
public:
    int begin(const spi_dt_spec *spi);
    // Returns 1 for a complete fusion sample, 0 when FIFO is empty, or -errno.
    int poll(ImuSample *sample);

private:
    static int32_t read(void *handle, uint8_t reg, uint8_t *data, uint16_t len);
    static int32_t write(void *handle, uint8_t reg, const uint8_t *data, uint16_t len);
    static void delay(uint32_t ms);
    stmdev_ctx_t ctx_ = {};
    ImuSample cache_ = {};
    float accel_[3] = {};
    float gravity_[3] = {};
    float bias_[3] = {};
    float gyro_[3] = {};
    uint8_t valid_ = 0;
    SflpQuaternion quaternion_;
    HighGWindow high_;
    unsigned high_discard_=2;
};
