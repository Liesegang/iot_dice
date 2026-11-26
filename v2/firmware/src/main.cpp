#include "lsm6dsv320x.hpp"
#include "ble_orient.hpp"
#include "dice_fsm.hpp"
#include "debug.hpp"
#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>
#include <stdio.h>

extern "C" { volatile AppDebug app_debug = {}; }
static const gpio_dt_spec power_led = GPIO_DT_SPEC_GET(DT_ALIAS(led1), gpios);
static const spi_dt_spec imu_spi = SPI_DT_SPEC_GET(DT_NODELABEL(imu),
    SPI_WORD_SET(8) | SPI_TRANSFER_MSB | SPI_MODE_CPOL | SPI_MODE_CPHA, 0);
static Lsm6dsv320x imu;
static DiceFsm fsm;

static void heartbeat(k_work *work);
K_WORK_DELAYABLE_DEFINE(heartbeat_work, heartbeat);
static void heartbeat(k_work *work)
{
    static bool on = true;
    on = !on;
    gpio_pin_set_dt(&power_led, on);
    app_debug.heartbeat = app_debug.heartbeat + 1;
    k_work_reschedule(&heartbeat_work, K_MSEC(500));
}

int main()
{
    if (gpio_is_ready_dt(&power_led)) {
        gpio_pin_configure_dt(&power_led, GPIO_OUTPUT_ACTIVE);
        k_work_reschedule(&heartbeat_work, K_MSEC(500));
    }
    app_debug.ble_error = BleOrient::init();
    bool ready = false;
    bool previous_simulation = false;
    unsigned decimation = 0;
    float notify_high_peak[3]={}, notify_high_norm2=-1;
    uint32_t notify_high_t=0;
    uint8_t notify_high_sat=0;
    while (true) {
        if (!ready) {
            int rc = imu.begin(&imu_spi);
            app_debug.imu_error = rc;
            app_debug.imu_ready = rc == 0;
            if (rc) {
                printf("LSM6DSV320X init failed: %d, WHO_AM_I=0x%02x\n", rc, (unsigned)app_debug.who_am_i);
                k_msleep(1000);
                continue;
            }
            printf("LSM6DSV320X ready: Low-g/SFLP @120 Hz, High-g +/-320g @960 Hz, gyro +/-4000dps\n");
            ready = true;
            fsm = DiceFsm();
        }
        ImuSample sample;
        int rc = imu.poll(&sample);
        if (rc < 0) {
            app_debug.imu_error = rc;
            app_debug.imu_ready = 0;
            ready = false;
            continue;
        }
        if (rc == 0) { k_msleep(1); continue; }
        app_debug.imu_samples = app_debug.imu_samples + 1;
        // Store individual members because the diagnostic object is volatile.
        app_debug.sample.t_us = sample.t_us;
        app_debug.sample.qx = sample.qx; app_debug.sample.qy = sample.qy;
        app_debug.sample.qz = sample.qz; app_debug.sample.qw = sample.qw;
        app_debug.sample.wx = sample.wx; app_debug.sample.wy = sample.wy; app_debug.sample.wz = sample.wz;
        app_debug.sample.ax = sample.ax; app_debug.sample.ay = sample.ay; app_debug.sample.az = sample.az;
        app_debug.sample.lax=sample.lax;app_debug.sample.lay=sample.lay;app_debug.sample.laz=sample.laz;
        app_debug.sample.hax=sample.hax;app_debug.sample.hay=sample.hay;app_debug.sample.haz=sample.haz;
        app_debug.sample.hpx=sample.hpx;app_debug.sample.hpy=sample.hpy;app_debug.sample.hpz=sample.hpz;
        app_debug.sample.high_peak_t_ms=sample.high_peak_t_ms;app_debug.sample.accel_flags=sample.accel_flags;

        bool simulation = BleOrient::simulationEnabled();
        if (simulation != previous_simulation) {
            fsm = DiceFsm();
            decimation = 0;
            previous_simulation = simulation;
        }
        if (simulation) {
            auto event = fsm.update(sample);
            if (event == DiceFsm::Event::IMPACT) BleOrient::sendImpact(fsm.impact());
            if (event == DiceFsm::Event::RESULT) BleOrient::sendResult(fsm.result());
        }
        if(sample.accel_flags&4) {
            const float norm2=sample.hpx*sample.hpx+sample.hpy*sample.hpy+sample.hpz*sample.hpz;
            if(norm2>notify_high_norm2) {
                notify_high_peak[0]=sample.hpx;notify_high_peak[1]=sample.hpy;notify_high_peak[2]=sample.hpz;
                notify_high_norm2=norm2;notify_high_t=sample.high_peak_t_ms;
            }
        }
        notify_high_sat|=sample.accel_flags&2;
        if (++decimation >= (simulation ? 1 : 2)) {
            decimation = 0;
            ImuSample notify_sample=sample;
            notify_sample.hpx=notify_high_peak[0];notify_sample.hpy=notify_high_peak[1];notify_sample.hpz=notify_high_peak[2];
            notify_sample.high_peak_t_ms=notify_high_t;
            notify_sample.accel_flags=(sample.accel_flags&1)|notify_high_sat|(notify_high_norm2>=0?4:0);
            notify_high_norm2=-1;notify_high_sat=0;
            if (simulation) {
                float velocity[3];
                fsm.velocity(velocity);
                BleOrient::sendStream(notify_sample, fsm.state(), velocity);
            } else BleOrient::sendPose(notify_sample);
        }
    }
}
