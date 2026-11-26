import type { Quat } from './ble';

/*
 * Face determination from orientation, in the BNO body frame.
 *
 * The cube itself is the calibration jig: rest each face up, record the
 * body-frame "up" vector (q⁻¹ · ẑ_world), and face detection becomes a
 * nearest-vector lookup. The recorded table also absorbs the 1–3° board
 * mounting misalignment that a hardcoded ±XYZ table cannot.
 */

export type V3 = [number, number, number];

/* Default table: body axis → face, opposite faces sum to 7.
 * Derived from the original visualizer mapping (+Z up = 1, +Y up = 2, …). */
const DEFAULT_TABLE: Record<number, V3> = {
    1: [0, 0, 1],
    2: [0, 1, 0],
    3: [-1, 0, 0],
    4: [1, 0, 0],
    5: [0, -1, 0],
    6: [0, 0, -1],
};

const LS_KEY = 'dice-face-table-v1';

/** body-frame up vector: q⁻¹ · (0,0,1) */
export function bodyUp(q: Quat): V3 {
    const { x, y, z, w } = q;
    // rotate world +Z by conjugate quaternion
    return [
        2 * (x * z - w * y),
        2 * (y * z + w * x),
        1 - 2 * (x * x + y * y),
    ];
}

export class FaceMap {
    private table: Record<number, V3>;

    constructor() {
        this.table = { ...DEFAULT_TABLE };
        const saved = localStorage.getItem(LS_KEY);
        if (saved) {
            try { this.table = { ...this.table, ...JSON.parse(saved) }; }
            catch { /* corrupted entry — keep defaults */ }
        }
    }

    get calibrated(): boolean {
        return localStorage.getItem(LS_KEY) !== null;
    }

    /** Which face is up for this orientation. */
    faceFromQuat(q: Quat): number {
        const up = bodyUp(q);
        let best = 1, bestDot = -Infinity;
        for (let f = 1; f <= 6; f++) {
            const v = this.table[f];
            const d = v[0] * up[0] + v[1] * up[1] + v[2] * up[2];
            if (d > bestDot) { bestDot = d; best = f; }
        }
        return best;
    }

    /** Register the current orientation as "face f is up". */
    calibrate(f: number, q: Quat): void {
        const up = bodyUp(q);
        const n = Math.hypot(...up) || 1;
        this.table[f] = [up[0] / n, up[1] / n, up[2] / n];
        localStorage.setItem(LS_KEY, JSON.stringify(this.table));
    }

    resetCalibration(): void {
        this.table = { ...DEFAULT_TABLE };
        localStorage.removeItem(LS_KEY);
    }

    /** Body-frame up vector of a face (for seeding sims / debugging). */
    vectorOf(f: number): V3 {
        return this.table[f];
    }
}
