import type { Quat } from './ble';
import { multiply, normalize, rotate } from './math';

/*
 * Face determination from orientation, in the IMU body frame.
 *
 * The cube itself is the calibration jig: rest each face up, record the
 * body-frame "up" vector (q⁻¹ · ẑ_world), and face detection becomes a
 * nearest-vector lookup. The recorded table also absorbs the 1–3° board
 * mounting misalignment that a hardcoded ±XYZ table cannot.
 */

export type V3 = [number, number, number];
export type FaceTable = Record<number, V3>;

/* Default table: body axis → face, opposite faces sum to 7.
 * Derived from the original visualizer mapping (+Z up = 1, +Y up = 2, …). */
export const DEFAULT_TABLE: FaceTable = {
    1: [0, 0, 1],
    2: [0, 1, 0],
    3: [-1, 0, 0],
    4: [1, 0, 0],
    5: [0, -1, 0],
    6: [0, 0, -1],
};

const LS_KEY = 'dice-face-table-v2';
const DONE_KEY = 'dice-calibrated-faces-v2';

export function checkedTable(table: FaceTable): FaceTable {
    const result: FaceTable = {};
    for (let f=1;f<=6;f++) {
        const v=table[f];
        if (!Array.isArray(v) || v.length!==3 || !v.every(Number.isFinite)) throw new Error('面校正データが不正です');
        const n=Math.hypot(...v);
        if (n<0.9 || n>1.1) throw new Error('面校正データが不正です');
        result[f]=[v[0]/n,v[1]/n,v[2]/n];
    }
    return result;
}

export function faceFromQuat(q: Quat, table: FaceTable): number {
    const up=bodyUp(normalize(q));
    let best=1, bestDot=-Infinity;
    for (let f=1;f<=6;f++) {
        const v=table[f], dot=v[0]*up[0]+v[1]*up[1]+v[2]*up[2];
        if (dot>bestDot) { bestDot=dot; best=f; }
    }
    return best;
}

// Rotate the physical die's axes into the IMU's body axes. Face calibration
// must affect contact geometry as well as the final label lookup.
export function bodyFromDie(table: FaceTable): Quat {
    const dot=(a:V3,b:V3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
    const unit=(v:V3):V3=>{ const n=Math.hypot(...v); if(n<0.1) throw new Error('6面の校正をやり直してください'); return [v[0]/n,v[1]/n,v[2]/n]; };
    const difference=(a:number,b:number):V3=>[table[a][0]-table[b][0],table[a][1]-table[b][1],table[a][2]-table[b][2]];
    const x=unit(difference(4,3)), y0=unit(difference(2,5)), d=dot(x,y0);
    const y=unit([y0[0]-d*x[0],y0[1]-d*x[1],y0[2]-d*x[2]]);
    const z:V3=[x[1]*y[2]-x[2]*y[1],x[2]*y[0]-x[0]*y[2],x[0]*y[1]-x[1]*y[0]];
    // Dice exist with either numbering handedness; the contact box is symmetric.
    if (Math.abs(d)>0.2 || Math.abs(dot(z,unit(difference(1,6))))<0.95
        || [1,2,3].some(f=>dot(table[f],table[7-f])> -0.95))
        throw new Error('向かい合う面の組み合わせを確認してください');
    const trace=x[0]+y[1]+z[2];
    let q:Quat;
    if(trace>0) { const s=2*Math.sqrt(trace+1); q={w:s/4,x:(y[2]-z[1])/s,y:(z[0]-x[2])/s,z:(x[1]-y[0])/s}; }
    else if(x[0]>y[1]&&x[0]>z[2]) { const s=2*Math.sqrt(1+x[0]-y[1]-z[2]); q={w:(y[2]-z[1])/s,x:s/4,y:(y[0]+x[1])/s,z:(z[0]+x[2])/s}; }
    else if(y[1]>z[2]) { const s=2*Math.sqrt(1+y[1]-x[0]-z[2]); q={w:(z[0]-x[2])/s,x:(y[0]+x[1])/s,y:s/4,z:(z[1]+y[2])/s}; }
    else { const s=2*Math.sqrt(1+z[2]-x[0]-y[1]); q={w:(x[1]-y[0])/s,x:(z[0]+x[2])/s,y:(z[1]+y[2])/s,z:s/4}; }
    return normalize(q);
}

/** Calibrated die-to-world orientation, before the renderer's world-frame conversion. */
export function displayOrientation(q: Quat, table: FaceTable): Quat {
    return normalize(multiply(normalize(q), bodyFromDie(checkedTable(table))));
}

/** A mirrored numbering requires exchanging the renderer's 1/6 face labels. */
export function isMirroredTable(table: FaceTable): boolean {
    const checked = checkedTable(table);
    const z = rotate(bodyFromDie(checked), { x:0, y:0, z:1 });
    return z.x*(checked[1][0]-checked[6][0])
        + z.y*(checked[1][1]-checked[6][1])
        + z.z*(checked[1][2]-checked[6][2]) < 0;
}

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
            try { this.table = checkedTable(JSON.parse(saved)); }
            catch { /* corrupted entry — keep defaults */ }
        }
    }

    get calibrated(): boolean {
        return this.calibratedFaces.length === 6;
    }

    get calibratedFaces(): number[] {
        try { return [...new Set<number>(JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]'))].filter(f=>Number.isInteger(f)&&f>=1&&f<=6); }
        catch { return []; }
    }
    snapshot(): FaceTable { return checkedTable(this.table); }

    /** Which face is up for this orientation. */
    faceFromQuat(q: Quat): number {
        return faceFromQuat(q, this.table);
    }

    /** Register the current orientation as "face f is up". */
    calibrate(f: number, q: Quat): void {
        const up = bodyUp(normalize(q));
        const n = Math.hypot(...up) || 1;
        this.table[f] = [up[0] / n, up[1] / n, up[2] / n];
        localStorage.setItem(LS_KEY, JSON.stringify(this.table));
        localStorage.setItem(DONE_KEY, JSON.stringify([...new Set([...this.calibratedFaces,f])]));
    }

    resetCalibration(): void {
        this.table = { ...DEFAULT_TABLE };
        localStorage.removeItem(LS_KEY);
        localStorage.removeItem(DONE_KEY);
    }

    /** Body-frame up vector of a face (for seeding sims / debugging). */
    vectorOf(f: number): V3 {
        return this.table[f];
    }
}
