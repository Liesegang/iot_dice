#include "bno085.hpp"
#include "ble_orient.hpp"

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

/* ── globals ─────────────────────────────────────────────────────────────── */

static BNO085 imu;

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

    if (!imu.enableReport(BNO085::REPORT_ROTATION_VECTOR, 10000 /* µs = 100 Hz */)) {
        printf("BNO085 enableReport failed\n");
        while (true) k_msleep(1000);
    }

    printf("BNO085 ready\n");

    /*
     * Main loop: poll() blocks via semaphore — CPU yields to the BLE stack and
     * other Zephyr threads while waiting for the next IMU sample.
     * No busy-wait, no k_msleep(1) polling.
     */
    BNO085::EulerAngles a;
    while (true) {
        if (imu.poll(&a)) {
            printf("rv  yaw=%8.2f  pitch=%8.2f  roll=%8.2f  acc=%u\n",
                   a.yaw, a.pitch, a.roll, a.accuracy);
            BleOrient::sendOrient(a.yaw, a.pitch, a.roll);
        }
    }
}
