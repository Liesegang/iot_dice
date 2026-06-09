#include "ble_orient.hpp"

#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/drivers/gpio.h>
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

/* ── state ───────────────────────────────────────────────────────────────── */

static const struct gpio_dt_spec led_conn = GPIO_DT_SPEC_GET(DT_ALIAS(led1), gpios);

static struct bt_conn *active_conn = NULL;
static bool            notify_en   = false;
static float           orient[3];  /* yaw, pitch, roll */

/* ── GATT callbacks ─────────────────────────────────────────────────────── */

static ssize_t on_orient_read(struct bt_conn *conn,
                               const struct bt_gatt_attr *attr,
                               void *buf, uint16_t len, uint16_t offset)
{
    return bt_gatt_attr_read(conn, attr, buf, len, offset, orient, sizeof(orient));
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
    (void)conn; (void)attr; (void)offset; (void)flags;
    printf("BLE cmd len=%u\n", len);
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
}

static void on_disconnected(struct bt_conn *conn, uint8_t reason)
{
    (void)conn;
    printf("BLE disconnected reason=%u\n", reason);
    bt_conn_unref(active_conn);
    active_conn = NULL;
    notify_en   = false;
    gpio_pin_set_dt(&led_conn, 0);
    bt_le_adv_start(BT_LE_ADV_CONN, ad, ARRAY_SIZE(ad), NULL, 0);
}

BT_CONN_CB_DEFINE(conn_cbs) = {
    .connected    = on_connected,
    .disconnected = on_disconnected,
};

/* ── namespace implementation ───────────────────────────────────────────── */

namespace BleOrient {

void init()
{
    gpio_pin_configure_dt(&led_conn, GPIO_OUTPUT_INACTIVE);

    int err = bt_enable(NULL);
    if (err) { printf("BLE enable err=%d\n", err); return; }

    err = bt_le_adv_start(BT_LE_ADV_CONN, ad, ARRAY_SIZE(ad), NULL, 0);
    if (err) { printf("BLE adv err=%d\n", err); return; }

    printf("BLE advertising as \"%s\"\n", CONFIG_BT_DEVICE_NAME);
}

void sendOrient(float yaw, float pitch, float roll)
{
    orient[0] = yaw;
    orient[1] = pitch;
    orient[2] = roll;

    if (notify_en && active_conn) {
        bt_gatt_notify(active_conn, &dice_svc.attrs[2], orient, sizeof(orient));
    }
}

} // namespace BleOrient
