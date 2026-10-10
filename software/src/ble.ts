/* BLE notify protocol — single characteristic, first byte = packet type.
 * Mirrors src/ble_orient.hpp on the firmware side. All little-endian.
 *
 *  0x01 POSE   (22 B): state u8, t_ms u32, q f32×4
 *  0x01 STREAM (58 B, simulation mode): POSE + ω f32×3, a f32×3, v f32×3
 *  0x02 IMPACT (50 B): pre-impact q/ω/v + fall_ms u16 + sat counters
 *  0x03 RESULT (32 B): rest q + max|ω| + max|a| + sat counters
 */

const SERVICE_UUID     = 'd1ce0001-1234-5678-abcd-1234567890ab';
const ORIENT_CHAR_UUID = 'd1ce0002-1234-5678-abcd-1234567890ab';
const CMD_CHAR_UUID    = 'd1ce0003-1234-5678-abcd-1234567890ab';

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
    private cmdChar: BluetoothRemoteGATTCharacteristic | null = null;

    onSample: ((s: StreamSample) => void) | null = null;
    onImpact: ((p: ImpactPacket) => void) | null = null;
    onResult: ((p: ResultPacket) => void) | null = null;
    onStatusChange: ((status: string) => void) | null = null;

    get connected(): boolean {
        return this.ready && (this.device?.gatt?.connected ?? false);
    }

    get connecting(): boolean {
        return this.connecting_;
    }

    private connecting_ = false;
    private ready = false;
    private disconnectListener: (() => void) | null = null;
    private valueListener = (e: Event) => this.onValueChanged(e);

    private async step<T>(label: string, operation: Promise<T>): Promise<T> {
        this.onStatusChange?.(label);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                operation,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`${label} タイムアウト`)), 15000);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    async connect(): Promise<void> {
        if (this.connecting || this.connected) return;
        this.connecting_ = true;
        try {
            this.onStatusChange?.('デバイスを選択してください');
            this.device = await navigator.bluetooth.requestDevice({
                filters: [{ name: 'dice' }],
                optionalServices: [SERVICE_UUID],
            });
            this.disconnectListener = () => {
                this.clearConnection();
                this.onStatusChange?.('切断されました');
            };
            this.device.addEventListener('gattserverdisconnected', this.disconnectListener);

            const server = await this.step('BLE接続中...', this.device.gatt!.connect());
            const service = await this.step('サービス確認中...',
                server.getPrimaryService(SERVICE_UUID));
            this.char = await this.step('姿勢サービス確認中...',
                service.getCharacteristic(ORIENT_CHAR_UUID));
            this.cmdChar = await this.step('操作サービス確認中...',
                service.getCharacteristic(CMD_CHAR_UUID));

            // Register before enabling notifications so the first sample is not lost.
            this.char.addEventListener('characteristicvaluechanged', this.valueListener);
            await this.step('姿勢通知を有効化中...', this.char.startNotifications());
            if (!this.device?.gatt?.connected) throw new Error('接続中に切断されました');
            this.ready = true;
        } catch (error) {
            this.disconnect();
            throw error;
        } finally {
            this.connecting_ = false;
        }
        this.onStatusChange?.('接続済み：姿勢データ待ち');
    }

    async setSimulationEnabled(enabled: boolean): Promise<void> {
        if (!this.cmdChar) return;
        await this.step('動作モード設定中...',
            this.cmdChar.writeValueWithoutResponse(Uint8Array.of(enabled ? 1 : 0)));
    }

    private clearConnection(): void {
        if (this.disconnectListener) {
            this.device?.removeEventListener('gattserverdisconnected', this.disconnectListener);
        }
        this.char?.removeEventListener('characteristicvaluechanged', this.valueListener);
        this.device = null;
        this.char = null;
        this.cmdChar = null;
        this.disconnectListener = null;
        this.ready = false;
    }

    disconnect(): void {
        const device = this.device;
        this.clearConnection();
        // Also cancels a pending GATT connection after a timeout.
        device?.gatt?.disconnect();
        this.onStatusChange?.('切断されました');
    }

    private onValueChanged(event: Event): void {
        const dv = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!dv || dv.byteLength < 1) return;

        switch (dv.getUint8(0)) {

        case 0x01: {
            if (dv.byteLength < 22) return;
            const hasSimulationData = dv.byteLength >= 58;
            this.onSample?.({
                state: hasSimulationData
                    ? (FSM_STATES[dv.getUint8(1)] ?? 'rest')
                    : 'rest',
                t: dv.getUint32(2, true),
                q: quatAt(dv, 6),
                w: hasSimulationData ? vec3At(dv, 22) : { x: 0, y: 0, z: 0 },
                a: hasSimulationData ? vec3At(dv, 34) : { x: 0, y: 0, z: 0 },
                v: hasSimulationData ? vec3At(dv, 46) : { x: 0, y: 0, z: 0 },
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
