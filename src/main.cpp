#include "bno085.hpp"
#include "ble_orient.hpp"
#include "dice_fsm.hpp"

#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/hwinfo.h>
#include <zephyr/drivers/spi.h>
#include <zephyr/kernel.h>
#include <stdio.h>

/* ── hardware specs (from app.overlay) ──────────────────────────────────── */

static const struct spi_dt_spec bno_spi =
    SPI_DT_SPEC_GET(DT_NODELABEL(bno085),
                    SPI_WORD_SET(8) | SPI_TRANSFER_MSB |
                    SPI_MODE_CPOL | SPI_MODE_CPHA,  /* SPI mode 3, datasheet §6.5.2 */
                    0);

static const struct gpio_dt_spec bno_rst  = GPIO_DT_SPEC_GET(DT_NODELABEL(bno_rst),  gpios);
static const struct gpio_dt_spec bno_wake = GPIO_DT_SPEC_GET(DT_NODELABEL(bno_wake), gpios);
static const struct gpio_dt_spec bno_int  = GPIO_DT_SPEC_GET(DT_NODELABEL(bno_int),  gpios);
static const struct gpio_dt_spec led0     = GPIO_DT_SPEC_GET(DT_ALIAS(led0),         gpios);

/* ── sampling configuration ─────────────────────────────────────────────── */

/* 2500 µs = 400 Hz target; the chip clamps to what it can actually deliver. */
static constexpr uint32_t REPORT_INTERVAL_US = 2500;

/* Stream every Nth sample over BLE (~100 Hz at 400 Hz sensor rate).
 * Impact/result packets are never decimated. */
static constexpr int STREAM_DECIMATION = 4;

/* ── globals ─────────────────────────────────────────────────────────────── */

static BNO085  imu;
static DiceFsm fsm;

/* ── main ────────────────────────────────────────────────────────────────── */

int main()
{
    k_msleep(500);

    uint32_t cause = 0;
    hwinfo_get_reset_cause(&cause); 
    hwinfo_clear_reset_cause();
    printf("reset cause: 0x%08x\n", cause);

    BleOrient::init();

    gpio_pin_configure_dt(&led0, GPIO_OUTPUT_INACTIVE);
    for (int i = 0; i < 5; i++) {
        gpio_pin_set_dt(&led0, 1); k_msleep(100);
        gpio_pin_set_dt(&led0, 0); k_msleep(100);
    }

    if (!imu.begin(&bno_spi, &bno_rst, &bno_wake, &bno_int)) {
        printf("BNO085 begin failed\n");
        while (true) k_msleep(1000);
    }

    /*
     * Game Rotation Vector (0x08): mag-free 6-axis fusion.  The magnetometer
     * is useless next to the battery/coil and yaw is irrelevant for face
     * prediction — 9-axis RV (0x05) causes heading-correction jumps mid-air
     * that corrupt velocity integration and the sim seed.
     */
    if (!imu.enableReport(BNO085::REPORT_GAME_ROTATION_VECTOR, REPORT_INTERVAL_US)) {
        printf("BNO085 enableReport failed\n");
        while (true) k_msleep(1000);
    }
    imu.enableReport(BNO085::REPORT_GYRO_CALIBRATED, REPORT_INTERVAL_US);
    imu.enableReport(BNO085::REPORT_LINEAR_ACCEL,    REPORT_INTERVAL_US);

    printf("BNO085 ready (game rv @ %u us)\n", REPORT_INTERVAL_US);

    BNO085::Sample s;
    int n = 0;

    while (true) {
        if (!imu.poll(&s)) continue;

        const DiceFsm::Event ev = fsm.update(s);

        if (ev == DiceFsm::Event::IMPACT) {
            const auto &i = fsm.impact();
            BleOrient::sendImpact(i);
            printf("IMPACT fall=%ums v=(%.2f %.2f %.2f) w=(%.1f %.1f %.1f) sat=%u/%u\n",
                   i.fall_ms, (double)i.vx, (double)i.vy, (double)i.vz,
                   (double)i.pre.wx, (double)i.pre.wy, (double)i.pre.wz,
                   i.gyro_sat, i.acc_sat);
        } else if (ev == DiceFsm::Event::RESULT) {
            const auto &r = fsm.result();
            BleOrient::sendResult(r);
            printf("RESULT max|w|=%.1f max|a|=%.1f sat=%u/%u\n",
                   (double)r.max_w, (double)r.max_a, r.gyro_sat, r.acc_sat);
        }

        if (++n >= STREAM_DECIMATION) {
            n = 0;
            float v[3];
            fsm.velocity(v);
            BleOrient::sendStream(s, fsm.state(), v);
        }
    }
}
