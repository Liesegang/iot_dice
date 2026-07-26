#pragma once

#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/spi.h>
#include <zephyr/kernel.h>
#include <stddef.h>
#include <stdint.h>

class BNO085 {
public:
    static constexpr uint8_t REPORT_GYRO_CALIBRATED      = 0x02;
    static constexpr uint8_t REPORT_LINEAR_ACCEL         = 0x04;
    static constexpr uint8_t REPORT_ROTATION_VECTOR      = 0x05;
    static constexpr uint8_t REPORT_GAME_ROTATION_VECTOR = 0x08;

    struct Sample {
        uint64_t t_us;             /* uptime timestamp at parse (µs) */
        float   qx, qy, qz, qw;  /* rotation quaternion (unit) */
        float   wx, wy, wz;        /* angular velocity  (rad/s, Q9) */
        float   ax, ay, az;        /* linear accel      (m/s²,  Q8, gravity-removed) */
        uint8_t accuracy;          /* 0=unreliable … 3=high */
    };

    bool begin(const spi_dt_spec  *spi,
               const gpio_dt_spec *rst,
               const gpio_dt_spec *wake,
               const gpio_dt_spec *intn);

    bool enableReport(uint8_t report_id, uint32_t interval_us);

    /* Blocks (CPU yields) until the next rotation-vector sample is ready.
     * Gyro/accel packets that arrive between rotation-vector packets update
     * the internal cache and are returned together with the next rv sample. */
    bool poll(Sample *out);

    /* Quaternion → yaw / pitch / roll in degrees. */
    static void toEuler(const Sample &s,
                        float *yaw, float *pitch, float *roll);

private:
    static constexpr int     BUF_SIZE    = 512;
    static constexpr int     MAX_REPORTS = 4;
    static constexpr uint8_t CH_CONTROL  = 2;
    static constexpr uint8_t CH_REPORTS  = 3;
    static constexpr uint8_t CH_WAKE     = 4;
    static constexpr uint8_t CMD_SET_FEATURE = 0xFD;
    static constexpr uint8_t RPT_TIMEBASE    = 0xFB;

    static void intIsr(const struct device *port,
                       struct gpio_callback *cb,
                       gpio_port_pins_t pins);

    int  waitInt(int timeout_ms);
    int  readPacket(uint8_t *ch, uint8_t *payload, size_t cap, size_t *len);
    void queueWrite(uint8_t ch, const uint8_t *data, size_t len, int skip = 0);
    void drainBoot();
    bool parseReport(const uint8_t *payload, size_t len, Sample *out);
    static int16_t leI16(const uint8_t *p);

    const spi_dt_spec  *spi_   = nullptr;
    const gpio_dt_spec *rst_   = nullptr;
    const gpio_dt_spec *wake_  = nullptr;
    const gpio_dt_spec *intn_  = nullptr;

    struct k_sem         data_sem_;
    struct gpio_callback int_cb_;

    uint8_t seq_[6]  = {};
    uint8_t txbuf_[BUF_SIZE];
    uint8_t rxbuf_[BUF_SIZE];

    uint8_t lw_ch_   = 0;
    uint8_t lw_buf_[64];
    size_t  lw_len_  = 0;
    int     lw_skip_ = 0;

    uint8_t report_ids_[MAX_REPORTS] = {};
    int     num_reports_ = 0;
    bool    booted_      = false;
    Sample  cache_       = {};
};
