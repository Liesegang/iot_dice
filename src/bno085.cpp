#include "bno085.hpp"

#include <zephyr/kernel.h>
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/* ── public ─────────────────────────────────────────────────────────────── */

bool BNO085::begin(const spi_dt_spec  *spi,
                   const gpio_dt_spec *rst,
                   const gpio_dt_spec *wake,
                   const gpio_dt_spec *intn)
{
    spi_  = spi;
    rst_  = rst;
    wake_ = wake;
    intn_ = intn;

    k_sem_init(&data_sem_, 0, 16);

    gpio_pin_configure_dt(rst_,  GPIO_OUTPUT_INACTIVE);
    gpio_pin_configure_dt(wake_, GPIO_OUTPUT_INACTIVE);
    gpio_pin_configure_dt(intn_, GPIO_INPUT | GPIO_PULL_UP);

    /* Set up GPIO edge interrupt BEFORE releasing reset so we don't miss the first edge */
    gpio_init_callback(&int_cb_, intIsr, BIT(intn_->pin));
    gpio_add_callback(intn_->port, &int_cb_);
    gpio_pin_interrupt_configure_dt(intn_, GPIO_INT_EDGE_TO_ACTIVE);

    /* PS0/WAKE physical HIGH → SPI mode */
    gpio_pin_set_dt(wake_, 0);

    gpio_pin_set_dt(rst_, 1);
    k_msleep(20);
    gpio_pin_set_dt(rst_, 0);

    /* Wait for first INT via semaphore (ISR fires on falling edge) */
    if (waitInt(1000) != 0) {
        printf("BNO085: no INT after reset\n");
        return false;
    }
    return true;
}

bool BNO085::enableReport(uint8_t report_id, uint32_t interval_us)
{
    if (num_reports_ < MAX_REPORTS) {
        report_ids_[num_reports_++] = report_id;
    }

    uint8_t cmd[17] = {};
    cmd[0] = CMD_SET_FEATURE;
    cmd[1] = report_id;
    cmd[5] = (uint8_t)(interval_us >>  0);
    cmd[6] = (uint8_t)(interval_us >>  8);
    cmd[7] = (uint8_t)(interval_us >> 16);
    cmd[8] = (uint8_t)(interval_us >> 24);

    if (!booted_) {
        /*
         * skip=2: skip ch=0 advertisement and ch=2 unsolicited init;
         * piggyback Set Feature on ch=1 (reset-complete) per SH-2 spec.
         */
        queueWrite(CH_CONTROL, cmd, sizeof(cmd), 2);
        drainBoot();
        booted_ = true;
    } else {
        /* Device is running: skip=0, piggyback on the next data packet. */
        queueWrite(CH_CONTROL, cmd, sizeof(cmd), 0);
        for (int i = 0; i < 8; i++) {
            if (waitInt(300) != 0) break;
            uint8_t ch, payload[BUF_SIZE];
            size_t  plen;
            readPacket(&ch, payload, sizeof(payload), &plen);
            if (lw_len_ == 0) break;  /* write consumed */
        }
    }
    return true;
}

bool BNO085::poll(Sample *out)
{
    /*
     * Loop until a rotation-vector packet arrives.
     * Gyro/accel packets update the internal cache but do not return.
     * CPU yields to other threads while waiting for each INT.
     */
    while (true) {
        if (k_sem_take(&data_sem_, K_FOREVER) != 0) return false;

        uint8_t ch;
        uint8_t payload[BUF_SIZE];
        size_t  plen;

        if (readPacket(&ch, payload, sizeof(payload), &plen) != 0) continue;

        if ((ch == CH_REPORTS || ch == CH_WAKE) && plen > 0) {
            if (parseReport(payload, plen, out)) {
                out->t_us = k_ticks_to_us_floor64(k_uptime_ticks());
                return true;
            }
        } else if (ch == CH_CONTROL && plen > 0) {
            printf("BNO085: ctrl id=0x%02x\n", payload[0]);
        }
    }
}

/* ── private ────────────────────────────────────────────────────────────── */

void BNO085::intIsr(const struct device *port,
                    struct gpio_callback *cb,
                    gpio_port_pins_t pins)
{
    (void)port; (void)pins;
    BNO085 *self = CONTAINER_OF(cb, BNO085, int_cb_);
    k_sem_give(&self->data_sem_);
}

int BNO085::waitInt(int timeout_ms)
{
    if (k_sem_take(&data_sem_, K_MSEC(timeout_ms)) == 0) return 0;
    return -ETIMEDOUT;
}

int BNO085::readPacket(uint8_t *ch, uint8_t *payload, size_t cap, size_t *len)
{
    memset(txbuf_, 0x00, sizeof(txbuf_));

    if (lw_len_ > 0 && lw_len_ + 4U <= sizeof(txbuf_)) {
        if (lw_skip_ > 0) {
            --lw_skip_;
        } else {
            uint16_t wlen = (uint16_t)(lw_len_ + 4U);
            txbuf_[0] = (uint8_t)(wlen & 0xFF);
            txbuf_[1] = (uint8_t)((wlen >> 8) & 0x7F);
            txbuf_[2] = lw_ch_;
            txbuf_[3] = seq_[lw_ch_]++;
            memcpy(&txbuf_[4], lw_buf_, lw_len_);
            printf("BNO085: piggyback ch=%u cmd=0x%02x\n", lw_ch_, lw_buf_[0]);
            lw_len_ = 0;
        }
    }

    memset(rxbuf_, 0x00, sizeof(rxbuf_));

    const struct spi_buf tx_buf = { .buf = txbuf_, .len = sizeof(txbuf_) };
    const struct spi_buf rx_buf = { .buf = rxbuf_, .len = sizeof(rxbuf_) };
    const struct spi_buf_set tx_set = { .buffers = &tx_buf, .count = 1 };
    const struct spi_buf_set rx_set = { .buffers = &rx_buf, .count = 1 };

    int ret = spi_transceive_dt(spi_, &tx_set, &rx_set);
    if (ret) return ret;

    uint16_t pkt_len = (uint16_t)(((uint16_t)(rxbuf_[1] & 0x7F) << 8) | rxbuf_[0]);

    if (pkt_len == 0 || pkt_len == 0x7FFF || pkt_len == 0xFFFF) return -EAGAIN;
    if (pkt_len < 4 || pkt_len > (uint16_t)BUF_SIZE) {
        printf("BNO085: bad SHTP len=%u\n", pkt_len);
        return -EIO;
    }

    *ch  = rxbuf_[2];
    *len = pkt_len - 4;
    if (*len > cap) return -EMSGSIZE;

    memcpy(payload, &rxbuf_[4], *len);
    return 0;
}

void BNO085::queueWrite(uint8_t ch, const uint8_t *data, size_t len, int skip)
{
    if (len > sizeof(lw_buf_)) {
        printf("BNO085: queueWrite too large %u\n", (unsigned)len);
        return;
    }
    lw_ch_   = ch;
    lw_len_  = len;
    lw_skip_ = skip;
    memcpy(lw_buf_, data, len);
}

void BNO085::drainBoot()
{
    uint8_t payload[BUF_SIZE];
    uint8_t ch;
    size_t  plen;

    for (int i = 0; i < 16; i++) {
        if (waitInt(500) != 0) {
            printf("BNO085: boot drain done (%d pkts)\n", i);
            return;
        }
        int ret = readPacket(&ch, payload, sizeof(payload), &plen);
        printf("BNO085: boot[%d] ch=%u len=%u id=0x%02x\n",
               i, ch, (unsigned)plen, ret == 0 && plen ? payload[0] : 0);
    }
    printf("BNO085: boot drain hit limit\n");
}

bool BNO085::parseReport(const uint8_t *p, size_t len, Sample *out)
{
    bool   got_rv = false;
    size_t off    = 0;

    while (off < len) {
        uint8_t id = p[off];

        if (id == RPT_TIMEBASE) {
            if (off + 5 > len) break;
            off += 5;
            continue;
        }

        if (id == REPORT_ROTATION_VECTOR || id == REPORT_GAME_ROTATION_VECTOR) {
            size_t needed = (id == REPORT_GAME_ROTATION_VECTOR) ? 12U : 14U;
            if (off + needed > len) break;
            cache_.qx       = (float)leI16(&p[off + 4])  / 16384.0f;
            cache_.qy       = (float)leI16(&p[off + 6])  / 16384.0f;
            cache_.qz       = (float)leI16(&p[off + 8])  / 16384.0f;
            cache_.qw       = (float)leI16(&p[off + 10]) / 16384.0f;
            cache_.accuracy = p[off + 2] & 0x03;
            got_rv = true;
            off += needed;
            continue;
        }

        if (id == REPORT_GYRO_CALIBRATED) {
            /* Q9 = 1/512 rad/s per LSB */
            if (off + 10 > len) break;
            cache_.wx = (float)leI16(&p[off + 4]) / 512.0f;
            cache_.wy = (float)leI16(&p[off + 6]) / 512.0f;
            cache_.wz = (float)leI16(&p[off + 8]) / 512.0f;
            off += 10;
            continue;
        }

        if (id == REPORT_LINEAR_ACCEL) {
            /* Q8 = 1/256 m/s² per LSB, gravity-removed */
            if (off + 10 > len) break;
            cache_.ax = (float)leI16(&p[off + 4]) / 256.0f;
            cache_.ay = (float)leI16(&p[off + 6]) / 256.0f;
            cache_.az = (float)leI16(&p[off + 8]) / 256.0f;
            off += 10;
            continue;
        }

        printf("BNO085: unknown report 0x%02x\n", id);
        break;
    }

    if (got_rv) {
        *out = cache_;
    }
    return got_rv;
}

void BNO085::toEuler(const Sample &s, float *yaw, float *pitch, float *roll)
{
    float qx = s.qx, qy = s.qy, qz = s.qz, qw = s.qw;

    float sinr = 2.0f * (qw * qx + qy * qz);
    float cosr = 1.0f - 2.0f * (qx * qx + qy * qy);
    *roll = atan2f(sinr, cosr);

    float sinp = 2.0f * (qw * qy - qz * qx);
    sinp  = sinp > 1.0f ? 1.0f : (sinp < -1.0f ? -1.0f : sinp);
    *pitch = asinf(sinp);

    float siny = 2.0f * (qw * qz + qx * qy);
    float cosy = 1.0f - 2.0f * (qy * qy + qz * qz);
    *yaw = atan2f(siny, cosy);

    const float r2d = 180.0f / (float)M_PI;
    *yaw   *= r2d;
    *pitch *= r2d;
    *roll  *= r2d;
}

int16_t BNO085::leI16(const uint8_t *p)
{
    return (int16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}
