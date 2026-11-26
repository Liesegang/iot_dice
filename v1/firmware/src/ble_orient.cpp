#include "ble_orient.hpp"

#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/sys/atomic.h>
#include <stdio.h>
#include <string.h>

/* ── UUIDs ──────────────────────────────────────────────────────────────── */

#define BT_UUID_DICE_SVC_VAL \
    BT_UUID_128_ENCODE(0xd1ce0001, 0x1234, 0x5678, 0xabcd, 0x1234567890ab)
#define BT_UUID_DICE_ORIENT_VAL \
    BT_UUID_128_ENCODE(0xd1ce0002, 0x1234, 0x5678, 0xabcd, 0x1234567890ab)
#define BT_UUID_DICE_CMD_VAL \
    BT_UUID_128_ENCODE(0xd1ce0003, 0x1234, 0x5678, 0xabcd, 0x1234567890ab)

static struct bt_uuid_128 svc_uuid    = BT_UUID_INIT_128(BT_UUID_DICE_SVC_VAL);
static struct bt_uuid_128 orient_uuid = BT_UUID_INIT_128(BT_UUID_DICE_ORIENT_VAL);
static struct bt_uuid_128 cmd_uuid    = BT_UUID_INIT_128(BT_UUID_DICE_CMD_VAL);

/* ── packet types ───────────────────────────────────────────────────────── */

static constexpr uint8_t PKT_STREAM = 0x01;
static constexpr uint8_t PKT_IMPACT = 0x02;
static constexpr uint8_t PKT_RESULT = 0x03;

/* ── state ───────────────────────────────────────────────────────────────── */

static const struct gpio_dt_spec led_conn = GPIO_DT_SPEC_GET(DT_ALIAS(led1), gpios);

static struct bt_conn *active_conn = NULL;
static bool            notify_en   = false;
static atomic_t        simulation_en = ATOMIC_INIT(0);
static uint8_t         last_pkt[58];
static uint16_t        last_pkt_len = 0;

/* ── little-endian pack helpers ─────────────────────────────────────────── */

static inline void put_u32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}

static inline void put_u16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8);
}

static inline void put_f32(uint8_t *p, float v)
{
    memcpy(p, &v, 4);
}

static inline void put_quat(uint8_t *p, const BNO085::Sample &s)
{
    put_f32(p + 0,  s.qx); put_f32(p + 4,  s.qy);
    put_f32(p + 8,  s.qz); put_f32(p + 12, s.qw);
}

/* ── GATT callbacks ─────────────────────────────────────────────────────── */

static ssize_t on_orient_read(struct bt_conn *conn,
                               const struct bt_gatt_attr *attr,
                               void *buf, uint16_t len, uint16_t offset)
{
    return bt_gatt_attr_read(conn, attr, buf, len, offset,
                             last_pkt, last_pkt_len);
}

static void on_orient_ccc(const struct bt_gatt_attr *attr, uint16_t value)
{
    (void)attr;
    notify_en = (value == BT_GATT_CCC_NOTIFY);
    printf("BLE orient notify %s\n", notify_en ? "on" : "off");
}

static ssize_t on_cmd_write(struct bt_conn *conn,
                             const struct bt_gatt_attr *attr,
                             const void *buf, uint16_t len,
                             uint16_t offset, uint8_t flags)
{
    (void)conn; (void)attr; (void)flags;
    if (offset != 0 || len != 1) {
        return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
    }

    const uint8_t command = *(const uint8_t *)buf;
    if (command > 1) {
        return BT_GATT_ERR(BT_ATT_ERR_VALUE_NOT_ALLOWED);
    }

    atomic_set(&simulation_en, command);
    printf("BLE mode: %s\n", command ? "simulation" : "pose");
    return len;
}

BT_GATT_SERVICE_DEFINE(dice_svc,
    BT_GATT_PRIMARY_SERVICE(&svc_uuid),
    BT_GATT_CHARACTERISTIC(&orient_uuid.uuid,
                           BT_GATT_CHRC_READ | BT_GATT_CHRC_NOTIFY,
                           BT_GATT_PERM_READ,
                           on_orient_read, NULL, NULL),
    BT_GATT_CCC(on_orient_ccc, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
    BT_GATT_CHARACTERISTIC(&cmd_uuid.uuid,
                           BT_GATT_CHRC_WRITE_WITHOUT_RESP,
                           BT_GATT_PERM_WRITE,
                           NULL, on_cmd_write, NULL),
);

static void notify(const uint8_t *pkt, uint16_t len)
{
    memcpy(last_pkt, pkt, len < sizeof(last_pkt) ? len : sizeof(last_pkt));
    last_pkt_len = len;

    if (notify_en && active_conn) {
        bt_gatt_notify(active_conn, &dice_svc.attrs[2], pkt, len);
    }
}

/* ── BLE connection callbacks ───────────────────────────────────────────── */

static const struct bt_data ad[] = {
    BT_DATA_BYTES(BT_DATA_FLAGS, BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR),
    BT_DATA(BT_DATA_NAME_COMPLETE,
            CONFIG_BT_DEVICE_NAME, sizeof(CONFIG_BT_DEVICE_NAME) - 1),
};

static void on_connected(struct bt_conn *conn, uint8_t err)
{
    if (err) { printf("BLE connect err=%u\n", err); return; }
    active_conn = bt_conn_ref(conn);
    gpio_pin_set_dt(&led_conn, 1);
    printf("BLE connected\n");

    /* Web Bluetooth cannot set link parameters from the central side, so the
     * peripheral must ask: 7.5–15 ms interval and 2M PHY for low latency.
     * (BT_LE_CONN_PARAM / BT_CONN_LE_PHY_PARAM_* are C compound literals —
     * not valid C++, hence the static structs.) */
    static const struct bt_le_conn_param conn_params = {
        .interval_min = 6,    /* 7.5 ms  */
        .interval_max = 12,   /* 15 ms   */
        .latency      = 0,
        .timeout      = 400,  /* 4 s     */
    };
    static const struct bt_conn_le_phy_param phy_2m = {
        .options     = BT_CONN_LE_PHY_OPT_NONE,
        .pref_tx_phy = BT_GAP_LE_PHY_2M,
        .pref_rx_phy = BT_GAP_LE_PHY_2M,
    };

    int rc = bt_conn_le_param_update(conn, &conn_params);
    if (rc) printf("BLE param update req err=%d\n", rc);

    rc = bt_conn_le_phy_update(conn, &phy_2m);
    if (rc) printf("BLE PHY update req err=%d\n", rc);
}

static void on_disconnected(struct bt_conn *conn, uint8_t reason)
{
    (void)conn;
    printf("BLE disconnected reason=%u\n", reason);
    bt_conn_unref(active_conn);
    active_conn = NULL;
    notify_en   = false;
    atomic_set(&simulation_en, 0);
    gpio_pin_set_dt(&led_conn, 0);
    bt_le_adv_start(BT_LE_ADV_CONN_FAST_2, ad, ARRAY_SIZE(ad), NULL, 0);
}

static void on_param_updated(struct bt_conn *conn, uint16_t interval,
                             uint16_t latency, uint16_t timeout)
{
    (void)conn;
    printf("BLE params: interval=%.2fms latency=%u timeout=%ums\n",
           interval * 1.25, latency, timeout * 10);
}

BT_CONN_CB_DEFINE(conn_cbs) = {
    .connected        = on_connected,
    .disconnected     = on_disconnected,
    .le_param_updated = on_param_updated,
};

/* ── namespace implementation ───────────────────────────────────────────── */

namespace BleOrient {

void init()
{
    gpio_pin_configure_dt(&led_conn, GPIO_OUTPUT_INACTIVE);

    int err = bt_enable(NULL);
    if (err) { printf("BLE enable err=%d\n", err); return; }

    err = bt_le_adv_start(BT_LE_ADV_CONN_FAST_2, ad, ARRAY_SIZE(ad), NULL, 0);
    if (err) { printf("BLE adv err=%d\n", err); return; }

    printf("BLE advertising as \"%s\"\n", CONFIG_BT_DEVICE_NAME);
}

bool simulationEnabled()
{
    return atomic_get(&simulation_en) != 0;
}

void sendPose(const BNO085::Sample &s)
{
    uint8_t pkt[22];
    pkt[0] = PKT_STREAM;
    pkt[1] = (uint8_t)DiceFsm::State::REST;
    put_u32(&pkt[2], (uint32_t)(s.t_us / 1000));
    put_quat(&pkt[6], s);
    notify(pkt, sizeof(pkt));
}

void sendStream(const BNO085::Sample &s, DiceFsm::State state, const float v[3])
{
    uint8_t pkt[58];
    pkt[0] = PKT_STREAM;
    pkt[1] = (uint8_t)state;
    put_u32(&pkt[2], (uint32_t)(s.t_us / 1000));
    put_quat(&pkt[6], s);
    put_f32(&pkt[22], s.wx); put_f32(&pkt[26], s.wy); put_f32(&pkt[30], s.wz);
    put_f32(&pkt[34], s.ax); put_f32(&pkt[38], s.ay); put_f32(&pkt[42], s.az);
    put_f32(&pkt[46], v[0]); put_f32(&pkt[50], v[1]); put_f32(&pkt[54], v[2]);
    notify(pkt, sizeof(pkt));
}

void sendImpact(const DiceFsm::ImpactInfo &info)
{
    uint8_t pkt[50];
    pkt[0] = PKT_IMPACT;
    pkt[1] = 0;
    put_u32(&pkt[2], info.t_ms);
    put_quat(&pkt[6], info.pre);
    put_f32(&pkt[22], info.pre.wx); put_f32(&pkt[26], info.pre.wy);
    put_f32(&pkt[30], info.pre.wz);
    put_f32(&pkt[34], info.vx); put_f32(&pkt[38], info.vy);
    put_f32(&pkt[42], info.vz);
    put_u16(&pkt[46], info.fall_ms);
    pkt[48] = info.gyro_sat;
    pkt[49] = info.acc_sat;
    notify(pkt, sizeof(pkt));
}

void sendResult(const DiceFsm::ResultInfo &info)
{
    uint8_t pkt[32];
    pkt[0] = PKT_RESULT;
    pkt[1] = 0;
    put_u32(&pkt[2], info.t_ms);
    put_quat(&pkt[6], info.rest);
    put_f32(&pkt[22], info.max_w);
    put_f32(&pkt[26], info.max_a);
    pkt[30] = info.gyro_sat;
    pkt[31] = info.acc_sat;
    notify(pkt, sizeof(pkt));
}

} // namespace BleOrient
