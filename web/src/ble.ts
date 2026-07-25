/* BLE notify protocol — single characteristic, first byte = packet type.
 * Mirrors src/ble_orient.hpp on the firmware side. All little-endian.
 *
 *  0x01 STREAM (58 B): state u8, t_ms u32, q f32×4, ω f32×3, a f32×3, v f32×3
 *  0x02 IMPACT (50 B): pre-impact q/ω/v + fall_ms u16 + sat counters
 *  0x03 RESULT (32 B): rest q + max|ω| + max|a| + sat counters
 */

const SERVICE_UUID     = 'd1ce0001-1234-5678-abcd-1234567890ab';
const ORIENT_CHAR_UUID = 'd1ce0002-1234-5678-abcd-1234567890ab';

export const FSM_STATES = ['rest', 'moving', 'freefall', 'tumbling'] as const;
export type FsmState = typeof FSM_STATES[number];

export interface Quat { x: number; y: number; z: number; w: number; }
export interface Vec3 { x: number; y: number; z: number; }

export interface StreamSample {
    t: number;            // device uptime (ms)
    state: FsmState;
    q: Quat;              // orientation (BNO world frame, Z-up, yaw arbitrary)
    w: Vec3;              // angular velocity (rad/s, body frame)
    a: Vec3;              // linear accel (m/s², body frame, gravity-removed)
    v: Vec3;              // integrated velocity (m/s, world frame)
}

export interface ImpactPacket {
    t: number;            // impact time (device ms)
    q: Quat;              // PRE-impact orientation
    w: Vec3;              // PRE-impact angular velocity (body frame)
    v: Vec3;              // PRE-impact velocity (world frame)
    fallMs: number;
    gyroSat: number;
    accSat: number;
}

export interface ResultPacket {
    t: number;
    q: Quat;              // rest orientation → ground-truth face
    maxW: number;
    maxA: number;
    gyroSat: number;
    accSat: number;
}

function quatAt(dv: DataView, off: number): Quat {
    return {
        x: dv.getFloat32(off,      true),
        y: dv.getFloat32(off + 4,  true),
        z: dv.getFloat32(off + 8,  true),
        w: dv.getFloat32(off + 12, true),
    };
}

function vec3At(dv: DataView, off: number): Vec3 {
    return {
        x: dv.getFloat32(off,     true),
        y: dv.getFloat32(off + 4, true),
        z: dv.getFloat32(off + 8, true),
    };
}

export class DiceBle {
    private device: BluetoothDevice | null = null;
    private char: BluetoothRemoteGATTCharacteristic | null = null;

    onSample: ((s: StreamSample) => void) | null = null;
    onImpact: ((p: ImpactPacket) => void) | null = null;
    onResult: ((p: ResultPacket) => void) | null = null;
    onStatusChange: ((status: string) => void) | null = null;

    get connected(): boolean {
        return this.device?.gatt?.connected ?? false;
    }

    async connect(): Promise<void> {
        this.device = await navigator.bluetooth.requestDevice({
            filters: [{ name: 'dice' }],
            optionalServices: [SERVICE_UUID],
        });

        this.device.addEventListener('gattserverdisconnected', () => {
            this.onStatusChange?.('切断されました');
            this.device = null;
            this.char   = null;
        });

        const server  = await this.device.gatt!.connect();
        const service = await server.getPrimaryService(SERVICE_UUID);
        this.char     = await service.getCharacteristic(ORIENT_CHAR_UUID);

        await this.char.startNotifications();
        this.char.addEventListener('characteristicvaluechanged',
            (e: Event) => this.onValueChanged(e));

        this.onStatusChange?.(`接続: ${this.device.name}`);
    }

    disconnect(): void {
        this.device?.gatt?.disconnect();
    }

    private onValueChanged(event: Event): void {
        const dv = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!dv || dv.byteLength < 1) return;

        switch (dv.getUint8(0)) {

        case 0x01: {
            if (dv.byteLength < 58) return;
            this.onSample?.({
                state: FSM_STATES[dv.getUint8(1)] ?? 'rest',
                t: dv.getUint32(2, true),
                q: quatAt(dv, 6),
                w: vec3At(dv, 22),
                a: vec3At(dv, 34),
                v: vec3At(dv, 46),
            });
            break;
        }

        case 0x02: {
            if (dv.byteLength < 50) return;
            this.onImpact?.({
                t: dv.getUint32(2, true),
                q: quatAt(dv, 6),
                w: vec3At(dv, 22),
                v: vec3At(dv, 34),
                fallMs:  dv.getUint16(46, true),
                gyroSat: dv.getUint8(48),
                accSat:  dv.getUint8(49),
            });
            break;
        }

        case 0x03: {
            if (dv.byteLength < 32) return;
            this.onResult?.({
                t: dv.getUint32(2, true),
                q: quatAt(dv, 6),
                maxW:    dv.getFloat32(22, true),
                maxA:    dv.getFloat32(26, true),
                gyroSat: dv.getUint8(30),
                accSat:  dv.getUint8(31),
            });
            break;
        }
        }
    }
}
