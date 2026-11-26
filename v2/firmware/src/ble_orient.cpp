#include "ble_orient.hpp"
#include "debug.hpp"

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

static const struct gpio_dt_spec led_conn = GPIO_DT_SPEC_GET(DT_ALIAS(led0), gpios);
K_MUTEX_DEFINE(connection_mutex);

static struct bt_conn *active_conn = NULL;
static bool            notify_en   = false;
static atomic_t        simulation_en = ATOMIC_INIT(0);
static uint8_t         last_pkt[100];
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

static inline void put_quat(uint8_t *p, const ImuSample &s)
{
    put_f32(p + 0,  s.qx); put_f32(p + 4,  s.qy);
    put_f32(p + 8,  s.qz); put_f32(p + 12, s.qw);
}

static void put_accelerometers(uint8_t *pkt,const ImuSample &s)
{
    put_f32(pkt+58,s.lax);put_f32(pkt+62,s.lay);put_f32(pkt+66,s.laz);
    put_f32(pkt+70,s.hax);put_f32(pkt+74,s.hay);put_f32(pkt+78,s.haz);
    pkt[82]=s.accel_flags;pkt[83]=3;
    put_f32(pkt+84,s.hpx);put_f32(pkt+88,s.hpy);put_f32(pkt+92,s.hpz);
    put_u32(pkt+96,s.high_peak_t_ms);
}

/* ── GATT callbacks ─────────────────────────────────────────────────────── */

static ssize_t on_orient_read(struct bt_conn *conn,
                               const struct bt_gatt_attr *attr,
                               void *buf, uint16_t len, uint16_t offset)
{
    k_mutex_lock(&connection_mutex, K_FOREVER);
    ssize_t result = bt_gatt_attr_read(conn, attr, buf, len, offset, last_pkt, last_pkt_len);
    k_mutex_unlock(&connection_mutex);
    return result;
}

static void on_orient_ccc(const struct bt_gatt_attr *attr, uint16_t value)
{
    (void)attr;
    k_mutex_lock(&connection_mutex, K_FOREVER);
    notify_en = (value == BT_GATT_CCC_NOTIFY);
    k_mutex_unlock(&connection_mutex);
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
    k_mutex_lock(&connection_mutex, K_FOREVER);
    memcpy(last_pkt, pkt, len < sizeof(last_pkt) ? len : sizeof(last_pkt));
    last_pkt_len = len;
    bt_conn *conn = notify_en && active_conn ? bt_conn_ref(active_conn) : nullptr;
    k_mutex_unlock(&connection_mutex);
    if (conn) {
        uint16_t wire_len=len;
        const uint16_t available=bt_gatt_get_mtu(conn)-3;
        if(wire_len>available && pkt[0]==PKT_STREAM) wire_len=available>=58?58:available>=46?46:22;
        if(wire_len>available && pkt[0]==PKT_IMPACT) wire_len=available>=58?58:50;
        if(wire_len>available && pkt[0]==PKT_RESULT) wire_len=available>=36?36:32;
        int rc = wire_len<=available?bt_gatt_notify(conn, &dice_svc.attrs[2], pkt, wire_len):-EMSGSIZE;
        if (rc == 0) app_debug.notifications = app_debug.notifications + 1;
        else app_debug.ble_error = rc;
        bt_conn_unref(conn);
    }
}

static void mtu_exchanged(struct bt_conn *conn, uint8_t err, struct bt_gatt_exchange_params *params)
{
    (void)params;
    printf("BLE MTU: %u (exchange err=%u)\n", bt_gatt_get_mtu(conn), err);
}
static struct bt_gatt_exchange_params mtu_params={.func=mtu_exchanged};

/* ── BLE connection callbacks ───────────────────────────────────────────── */

static const struct bt_data ad[] = {
    BT_DATA_BYTES(BT_DATA_FLAGS, BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR),
    BT_DATA(BT_DATA_NAME_COMPLETE,
            CONFIG_BT_DEVICE_NAME, sizeof(CONFIG_BT_DEVICE_NAME) - 1),
    BT_DATA_BYTES(BT_DATA_UUID128_ALL, BT_UUID_DICE_SVC_VAL),
};

static void advertise(k_work *work);
K_WORK_DELAYABLE_DEFINE(advertising_work, advertise);
static void advertise(k_work *work)
{
    int rc = bt_le_adv_start(BT_LE_ADV_CONN_FAST_2, ad, ARRAY_SIZE(ad), NULL, 0);
    if (rc && rc != -EALREADY) {
        app_debug.ble_error = rc;
        k_work_reschedule(&advertising_work, K_MSEC(500));
    }
}

static void on_connected(struct bt_conn *conn, uint8_t err)
{
    if (err) { printf("BLE connect err=%u\n", err); return; }
    k_mutex_lock(&connection_mutex, K_FOREVER);
    active_conn = bt_conn_ref(conn);
    k_mutex_unlock(&connection_mutex);
    app_debug.ble_connected = 1;
    gpio_pin_set_dt(&led_conn, 1);
    printf("BLE connected\n");

    int mtu_rc=bt_gatt_exchange_mtu(conn,&mtu_params);
    if(mtu_rc && mtu_rc!=-EALREADY) printf("BLE MTU request err=%d\n",mtu_rc);
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
    k_mutex_lock(&connection_mutex, K_FOREVER);
    if (active_conn) bt_conn_unref(active_conn);
    active_conn = NULL;
    notify_en   = false;
    k_mutex_unlock(&connection_mutex);
    app_debug.ble_connected = 0;
    atomic_set(&simulation_en, 0);
    gpio_pin_set_dt(&led_conn, 0);
    k_work_reschedule(&advertising_work, K_MSEC(100));
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

int init()
{
    if (!gpio_is_ready_dt(&led_conn)) return -ENODEV;
    int err = gpio_pin_configure_dt(&led_conn, GPIO_OUTPUT_INACTIVE);
    if (err) return err;

    err = bt_enable(NULL);
    if (err) { printf("BLE enable err=%d\n", err); return err; }

    err = bt_le_adv_start(BT_LE_ADV_CONN_FAST_2, ad, ARRAY_SIZE(ad), NULL, 0);
    if (err) { printf("BLE adv err=%d\n", err); return err; }

    printf("BLE advertising as \"%s\"\n", CONFIG_BT_DEVICE_NAME);
    return 0;
}

bool simulationEnabled()
{
    return atomic_get(&simulation_en) != 0;
}

void sendPose(const ImuSample &s)
{
    uint8_t pkt[100]={};
    pkt[0] = PKT_STREAM;
    pkt[1] = (uint8_t)DiceFsm::State::REST;
    put_u32(&pkt[2], (uint32_t)(s.t_us / 1000));
    put_quat(&pkt[6], s);
    put_f32(&pkt[22], s.wx); put_f32(&pkt[26], s.wy); put_f32(&pkt[30], s.wz);
    put_f32(&pkt[34], s.ax); put_f32(&pkt[38], s.ay); put_f32(&pkt[42], s.az);
    put_f32(&pkt[46],0);put_f32(&pkt[50],0);put_f32(&pkt[54],0);
    put_accelerometers(pkt,s);
    notify(pkt, sizeof(pkt));
}

void sendStream(const ImuSample &s, DiceFsm::State state, const float v[3])
{
    uint8_t pkt[100]={};
    pkt[0] = PKT_STREAM;
    pkt[1] = (uint8_t)state;
    put_u32(&pkt[2], (uint32_t)(s.t_us / 1000));
    put_quat(&pkt[6], s);
    put_f32(&pkt[22], s.wx); put_f32(&pkt[26], s.wy); put_f32(&pkt[30], s.wz);
    put_f32(&pkt[34], s.ax); put_f32(&pkt[38], s.ay); put_f32(&pkt[42], s.az);
    put_f32(&pkt[46], v[0]); put_f32(&pkt[50], v[1]); put_f32(&pkt[54], v[2]);
    put_accelerometers(pkt,s);
    notify(pkt, sizeof(pkt));
}

void sendImpact(const DiceFsm::ImpactInfo &info)
{
    uint8_t pkt[76]={};
    pkt[0] = PKT_IMPACT;
    pkt[1] = 3;
    put_u32(&pkt[2], info.t_ms);
    put_quat(&pkt[6], info.pre);
    put_f32(&pkt[22], info.pre.wx); put_f32(&pkt[26], info.pre.wy);
    put_f32(&pkt[30], info.pre.wz);
    put_f32(&pkt[34], info.vx); put_f32(&pkt[38], info.vy);
    put_f32(&pkt[42], info.vz);
    put_u16(&pkt[46], info.fall_ms);
    pkt[48] = info.gyro_sat;
    pkt[49] = info.acc_sat;
    put_u32(&pkt[50], (uint32_t)(info.pre.t_us / 1000));
    put_u32(&pkt[54], info.throw_id);
    for(unsigned i=0;i<3;i++) put_f32(&pkt[58+4*i],info.high_peak[i]);
    put_u32(&pkt[70],info.high_peak_t_ms);pkt[74]=info.high_saturated;
    notify(pkt, sizeof(pkt));
}

void sendResult(const DiceFsm::ResultInfo &info)
{
    uint8_t pkt[44]={};
    pkt[0] = PKT_RESULT;
    pkt[1] = 3;
    put_u32(&pkt[2], info.t_ms);
    put_quat(&pkt[6], info.rest);
    put_f32(&pkt[22], info.max_w);
    put_f32(&pkt[26], info.max_a);
    pkt[30] = info.gyro_sat;
    pkt[31] = info.acc_sat;
    put_u32(&pkt[32], info.throw_id);
    put_f32(&pkt[36],info.max_high_g);pkt[40]=info.high_sat;
    notify(pkt, sizeof(pkt));
}

} // namespace BleOrient
