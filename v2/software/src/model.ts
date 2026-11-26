import type { TrainingReport } from './learning';

export const MODEL_ENGINE='first-impact-rapier014-v2';
export interface SavedModel {
    modelSchema:1;engine:string;profile:string;version:string;
    source:'physical'|'untrained';params:SimParams;trainedRecords:number;report:TrainingReport|null;
}
export function checkedModel(value:unknown,profile:string):SavedModel {
    const m=value as SavedModel;
    if(!m || m.modelSchema!==1 || m.engine!==MODEL_ENGINE || m.profile!==profile
        || !['physical','untrained'].includes(m.source) || typeof m.version!=='string'
        || !m.params || typeof m.params!=='object'
        || !Number.isInteger(m.trainedRecords)||m.trainedRecords<0
        || (m.source==='physical' && (!m.report?.accepted || m.report.algorithm!=='reinforce-physics-v1'))
        || (m.source==='untrained' && (m.trainedRecords!==0 || m.version!=='initial')))
        throw new Error('投げる面・外寸・実機モデル形式を確認してください');
    return {...m,params:checkedParams(m.params)};
}

export interface SimParams {
    sizeM: number;
    cornerR: number;
    restitution: number;
    friction: number;
    angularDamping: number;
    velocityScale: number;
    spinScale: number;
    comX: number; comY: number; comZ: number; // fraction of edge length, die frame
    inertiaScale: number;
    impactTimeOffsetMs: number;
    restitutionJitter: number;
    frictionJitter: number;
    velJitter: number; velNoise: number;
    omegaJitter: number; omegaNoise: number;
}

export const DEFAULT_PARAMS: SimParams = {
    sizeM: 0.015, cornerR: 0.0008, restitution: 0.4, friction: 0.3,
    angularDamping: 0.05, velocityScale: 1, spinScale: 1,
    comX: 0, comY: 0, comZ: 0, inertiaScale: 1, impactTimeOffsetMs: 0,
    restitutionJitter: 0.08, frictionJitter: 0.08,
    velJitter: 0.05, velNoise: 0.03, omegaJitter: 0.03, omegaNoise: 0.2,
};

export const ACTION_BOUNDS = {
    restitution: [0.02, 0.9], friction: [0.05, 1.2], angularDamping: [0, 1.5],
    velocityScale: [0.6, 1.4], spinScale: [0.85, 1.15],
    comX: [-0.15, 0.15], comY: [-0.15, 0.15], comZ: [-0.15, 0.15],
    inertiaScale: [0.5, 1.5], impactTimeOffsetMs: [-8, 8],
} as const;
export type ActionKey = keyof typeof ACTION_BOUNDS;
export const ACTION_KEYS = Object.keys(ACTION_BOUNDS) as ActionKey[];

export function checkedParams(input: Partial<SimParams>): SimParams {
    const p = { ...DEFAULT_PARAMS, ...input };
    for (const key of Object.keys(DEFAULT_PARAMS) as (keyof SimParams)[]) {
        if (!Number.isFinite(p[key])) throw new Error(`不正なパラメータ: ${key}`);
    }
    if (p.sizeM < 0.008 || p.sizeM > 0.1 || p.cornerR < 0 || p.cornerR >= p.sizeM/2)
        throw new Error('外寸・角丸の設定を確認してください');
    for (const key of ACTION_KEYS) {
        const [lo, hi] = ACTION_BOUNDS[key];
        if (p[key] < lo || p[key] > hi) throw new Error(`範囲外のパラメータ: ${key}`);
    }
    for (const key of ['restitutionJitter', 'frictionJitter', 'velJitter', 'velNoise', 'omegaJitter', 'omegaNoise'] as const)
        if (p[key] < 0 || p[key] > 2) throw new Error(`範囲外のばらつき: ${key}`);
    return p;
}

export function hash(text: string): number {
    let h = 2166136261;
    for (let i = 0; i < text.length; ++i) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
}

export function rng32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
export function normal(rng: () => number): number {
    return Math.sqrt(-2*Math.log(Math.max(rng(), 1e-12)))*Math.cos(2*Math.PI*rng());
}
