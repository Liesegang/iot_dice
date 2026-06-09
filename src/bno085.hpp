#pragma once

#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/spi.h>
#include <zephyr/kernel.h>
#include <stddef.h>
#include <stdint.h>

class BNO085 {
public:
    static constexpr uint8_t REPORT_ROTATION_VECTOR      = 0x05;
    static constexpr uint8_t REPORT_GAME_ROTATION_VECTOR = 0x08;

    struct EulerAngles {
        float   yaw;
        float   pitch;
        float   roll;
        uint8_t accuracy;
    };

    /*
     * Configure GPIO, assert/release reset, set up the INT edge interrupt,
     * and wait for the first INT via semaphore. Must be called before enableReport().
     */
    bool begin(const spi_dt_spec  *spi,
               const gpio_dt_spec *rst,
               const gpio_dt_spec *wake,
               const gpio_dt_spec *intn);

    /*
     * Queue Set Feature and drain the BNO085 boot sequence.
     * The command is piggybacked onto the ch=1 (reset complete) transaction —
     * the earliest safe point per the SH-2 spec.
     */
    bool enableReport(uint8_t report_id, uint32_t interval_us);

    /*
     * Block until the next orientation sample arrives (CPU yields via semaphore).
     * Returns true when *out is valid.
     */
    bool poll(EulerAngles *out);

private:
    static constexpr int     BUF_SIZE   = 512;
    static constexpr uint8_t CH_CONTROL = 2;
    static constexpr uint8_t CH_REPORTS = 3;
    static constexpr uint8_t CH_WAKE    = 4;
    static constexpr uint8_t CMD_SET_FEATURE = 0xFD;
    static constexpr uint8_t RPT_TIMEBASE    = 0xFB;

    /* INT edge ISR — gives data_sem_ so the caller thread can wake up */
    static void intIsr(const struct device *port,
                       struct gpio_callback *cb,
                       gpio_port_pins_t pins);

    /* Take data_sem_ with timeout. Returns 0 on success, -ETIMEDOUT on timeout. */
    int  waitInt(int timeout_ms);

    /* Read one SHTP packet; consumes the pending lazy write if ready. */
    int  readPacket(uint8_t *ch, uint8_t *payload, size_t cap, size_t *len);

    /* Queue a write to piggyback on a future read. skip=N defers N reads first. */
    void queueWrite(uint8_t ch, const uint8_t *data, size_t len, int skip = 0);

    void drainBoot();
    bool parseReport(const uint8_t *payload, size_t len, EulerAngles *out);

    static void quatToEuler(float qx, float qy, float qz, float qw,
                            float *yaw, float *pitch, float *roll);
    static int16_t leI16(const uint8_t *p);

    const spi_dt_spec  *spi_   = nullptr;
    const gpio_dt_spec *rst_   = nullptr;
    const gpio_dt_spec *wake_  = nullptr;
    const gpio_dt_spec *intn_  = nullptr;

    /* INT edge → semaphore (given from ISR, taken by caller thread) */
    struct k_sem         data_sem_;
    struct gpio_callback int_cb_;

    uint8_t seq_[6]  = {};
    uint8_t txbuf_[BUF_SIZE];
    uint8_t rxbuf_[BUF_SIZE];

    /* lazy write state */
    uint8_t lw_ch_   = 0;
    uint8_t lw_buf_[64];
    size_t  lw_len_  = 0;
    int     lw_skip_ = 0;

    uint8_t report_id_ = 0;
};
