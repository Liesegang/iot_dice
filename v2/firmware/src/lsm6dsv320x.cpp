#include "lsm6dsv320x.hpp"
#include "debug.hpp"
#include <zephyr/kernel.h>
#include <errno.h>
#include <math.h>
#include <string.h>

static constexpr float MG_TO_MS2 = 0.00980665f;
static constexpr float MDPS_TO_RADS = 0.00001745329252f;

static uint16_t word(const uint8_t *data)
{
    return (uint16_t)data[0] | ((uint16_t)data[1] << 8);
}

int32_t Lsm6dsv320x::read(void *handle, uint8_t reg, uint8_t *data, uint16_t len)
{
    const auto *spi = static_cast<const spi_dt_spec *>(handle);
    uint8_t command = reg | 0x80;
    const spi_buf tx[] = {{&command, 1}, {nullptr, len}};
    const spi_buf rx[] = {{nullptr, 1}, {data, len}};
    const spi_buf_set tx_set = {tx, 2}, rx_set = {rx, 2};
    return spi_transceive_dt(spi, &tx_set, &rx_set);
}

int32_t Lsm6dsv320x::write(void *handle, uint8_t reg, const uint8_t *data, uint16_t len)
{
    const auto *spi = static_cast<const spi_dt_spec *>(handle);
    const spi_buf tx[] = {{&reg, 1}, {const_cast<uint8_t *>(data), len}};
    const spi_buf_set tx_set = {tx, 2};
    return spi_write_dt(spi, &tx_set);
}

void Lsm6dsv320x::delay(uint32_t ms) { k_msleep(ms); }

int Lsm6dsv320x::begin(const spi_dt_spec *spi)
{
    if (!spi_is_ready_dt(spi)) return -ENODEV;
    ctx_ = {};
    ctx_.read_reg = read;
    ctx_.write_reg = write;
    ctx_.mdelay = delay;
    ctx_.handle = const_cast<spi_dt_spec *>(spi);
    cache_ = {};
    valid_ = 0;
    quaternion_.reset();
    high_=HighGWindow();high_discard_=2;
    memset(accel_, 0, sizeof(accel_));
    memset(gravity_, 0, sizeof(gravity_));
    memset(bias_, 0, sizeof(bias_));
    memset(gyro_, 0, sizeof(gyro_));
    delay(20);
    uint8_t id = 0;
    int rc = lsm6dsv320x_device_id_get(&ctx_, &id);
    app_debug.who_am_i = id;
    if (rc) return rc;
    if (id != LSM6DSV320X_ID) return -ENODEV;

    // ST's SFLP sequence, with all FIFO data at 120 Hz for coherent samples.
    // https://github.com/STMicroelectronics/STMems_Standard_C_drivers/blob/master/lsm6dsv320x_STdC/examples/lsm6dsv320x_sensor_fusion.c
#define CHECK(call) do { rc = (call); if (rc) return rc; } while (0)
    CHECK(lsm6dsv320x_sw_por(&ctx_));
    CHECK(lsm6dsv320x_auto_increment_set(&ctx_, 1));
    CHECK(lsm6dsv320x_block_data_update_set(&ctx_, 1));
    CHECK(lsm6dsv320x_xl_full_scale_set(&ctx_, LSM6DSV320X_16g));
    CHECK(lsm6dsv320x_gy_full_scale_set(&ctx_, LSM6DSV320X_4000dps));
    CHECK(lsm6dsv320x_fifo_mode_set(&ctx_, LSM6DSV320X_BYPASS_MODE));
    CHECK(lsm6dsv320x_fifo_xl_batch_set(&ctx_, LSM6DSV320X_XL_BATCHED_AT_120Hz));
    CHECK(lsm6dsv320x_fifo_gy_batch_set(&ctx_, LSM6DSV320X_GY_BATCHED_AT_120Hz));
    CHECK(lsm6dsv320x_hg_xl_full_scale_set(&ctx_, LSM6DSV320X_320g));
    CHECK(lsm6dsv320x_fifo_hg_xl_batch_set(&ctx_, 1));
    CHECK(lsm6dsv320x_hg_xl_data_rate_set(&ctx_, LSM6DSV320X_HG_XL_ODR_AT_960Hz, 0));
    lsm6dsv320x_hg_xl_full_scale_t high_scale;
    lsm6dsv320x_hg_xl_data_rate_t high_rate;
    uint8_t high_output, high_batch;
    CHECK(lsm6dsv320x_hg_xl_full_scale_get(&ctx_, &high_scale));
    CHECK(lsm6dsv320x_hg_xl_data_rate_get(&ctx_, &high_rate, &high_output));
    CHECK(lsm6dsv320x_fifo_hg_xl_batch_get(&ctx_, &high_batch));
    if(high_scale!=LSM6DSV320X_320g || high_rate!=LSM6DSV320X_HG_XL_ODR_AT_960Hz || !high_batch) return -EIO;
    lsm6dsv320x_fifo_sflp_raw_t fusion = {};
    fusion.game_rotation = 1;
    fusion.gravity = 1;
    fusion.gbias = 1;
    CHECK(lsm6dsv320x_fifo_sflp_batch_set(&ctx_, fusion));
    CHECK(lsm6dsv320x_xl_data_rate_set(&ctx_, LSM6DSV320X_ODR_AT_120Hz));
    CHECK(lsm6dsv320x_gy_data_rate_set(&ctx_, LSM6DSV320X_ODR_AT_120Hz));
    CHECK(lsm6dsv320x_sflp_data_rate_set(&ctx_, LSM6DSV320X_SFLP_120Hz));
    CHECK(lsm6dsv320x_sflp_game_rotation_set(&ctx_, 1));
    lsm6dsv320x_sflp_gbias_t bias = {};
    CHECK(lsm6dsv320x_sflp_game_gbias_set(&ctx_, &bias));
    CHECK(lsm6dsv320x_fifo_mode_set(&ctx_, LSM6DSV320X_STREAM_MODE));
#undef CHECK
    return 0;
}

int Lsm6dsv320x::poll(ImuSample *sample)
{
    lsm6dsv320x_fifo_status_t status = {};
    int rc = lsm6dsv320x_fifo_status_get(&ctx_, &status);
    if (rc) return rc;
    if (status.fifo_ovr) {
        app_debug.fifo_overruns = app_debug.fifo_overruns + 1;
        return -EOVERFLOW; // Reset FIFO/fusion rather than using stale throw data.
    }
    // Bound each drain so BLE and the heartbeat work can keep running.
    const unsigned count = status.fifo_level < 32 ? status.fifo_level : 32;
    for (unsigned n = 0; n < count; ++n) {
        lsm6dsv320x_fifo_out_raw_t row = {};
        rc = lsm6dsv320x_fifo_out_raw_get(&ctx_, &row);
        if (rc) return rc;
        switch (row.tag) {
        case lsm6dsv320x_fifo_out_raw_t::LSM6DSV320X_XL_NC_TAG:
            for (unsigned i = 0; i < 3; ++i)
                accel_[i] = lsm6dsv320x_from_fs16_to_mg((int16_t)word(row.data + 2*i)) * MG_TO_MS2;
            valid_ |= 1;
            break;
        case lsm6dsv320x_fifo_out_raw_t::LSM6DSV320X_XL_HG_TAG:
            if(high_discard_) {--high_discard_;break;}
            high_.push(row.data, (uint32_t)k_uptime_get());
            app_debug.high_g_samples=app_debug.high_g_samples+1;
            break;
        case lsm6dsv320x_fifo_out_raw_t::LSM6DSV320X_GY_NC_TAG:
            for (unsigned i = 0; i < 3; ++i)
                gyro_[i] = lsm6dsv320x_from_fs4000_to_mdps((int16_t)word(row.data + 2*i)) * MDPS_TO_RADS;
            valid_ |= 2;
            break;
        case lsm6dsv320x_fifo_out_raw_t::LSM6DSV320X_SFLP_GRAVITY_VECTOR_TAG:
            for (unsigned i = 0; i < 3; ++i)
                gravity_[i] = lsm6dsv320x_from_sflp_to_mg((int16_t)word(row.data + 2*i)) * MG_TO_MS2;
            valid_ |= 4;
            break;
        case lsm6dsv320x_fifo_out_raw_t::LSM6DSV320X_SFLP_GYROSCOPE_BIAS_TAG:
            for (unsigned i = 0; i < 3; ++i)
                bias_[i] = lsm6dsv320x_from_fs125_to_mdps((int16_t)word(row.data + 2*i)) * MDPS_TO_RADS;
            break;
        case lsm6dsv320x_fifo_out_raw_t::LSM6DSV320X_SFLP_GAME_ROTATION_VECTOR_TAG: {
            float q[4];
            rc = quaternion_.push(row.data, q);
            if (rc < 0) return rc;
            if (rc == 0) break;
            cache_.qx = q[0]; cache_.qy = q[1];
            cache_.qz = q[2]; cache_.qw = q[3];
            if (valid_ != 7) break;
            cache_.t_us = k_ticks_to_us_floor64(k_uptime_ticks());
            cache_.wx = gyro_[0] - bias_[0];
            cache_.wy = gyro_[1] - bias_[1];
            cache_.wz = gyro_[2] - bias_[2];
            cache_.ax = accel_[0] - gravity_[0];
            cache_.ay = accel_[1] - gravity_[1];
            cache_.az = accel_[2] - gravity_[2];
            cache_.lax=accel_[0];cache_.lay=accel_[1];cache_.laz=accel_[2];
            cache_.hax=high_.latest[0];cache_.hay=high_.latest[1];cache_.haz=high_.latest[2];
            cache_.hpx=high_.peak[0];cache_.hpy=high_.peak[1];cache_.hpz=high_.peak[2];
            cache_.high_peak_t_ms=high_.peak_t_ms;cache_.accel_flags=high_.flags();
            high_.clearPeak();
            *sample = cache_;
            return 1;
        }
        default: break;
        }
    }
    return 0;
}
