import RAPIER from '@dimforge/rapier3d-compat';
import type { ImpactPacket, Quat, Vec3 } from './ble';
import { FaceMap } from './faces';

/*
 * Monte Carlo dice prediction with Rapier (Rust→WASM rigid body engine).
 *
 * Seeded from the PRE-impact state sent by the firmware: orientation,
 * body-frame angular velocity, world-frame velocity. Everything runs in the
 * BNO world frame (Z up, yaw arbitrary — irrelevant for the face outcome).
 *
 * Similarity scaling: lengths and gravity are scaled ×SCALE (and therefore
 * velocities ×SCALE, time and angular velocity unchanged). The rigid-body +
 * impulsive-contact equations are invariant under this transform, and it
 * keeps the geometry far away from Rapier's default tolerances (which are
 * tuned for ~1 m bodies, not a 16 mm die).
 *
 * SimParams is the learnable parameter set: once recorded throws accumulate,
 * fit these offline (CMA-ES etc.) against the ground-truth labels.
 */

export interface SimParams {
    sizeM:        number;  // die edge length (m)
    cornerR:      number;  // edge fillet radius (m) — matches the CAD fillet
    restitution:  number;
    friction:     number;
    restitutionJitter: number;
    frictionJitter:    number;
    velJitter:    number;  // relative σ on velocity
    velNoise:     number;  // absolute σ (m/s)
    omegaJitter:  number;  // relative σ on angular velocity
    omegaNoise:   number;  // absolute σ (rad/s)
}

export const DEFAULT_PARAMS: SimParams = {
    sizeM:       0.016,
    cornerR:     0.0008,
    restitution: 0.40,
    friction:    0.30,
    restitutionJitter: 0.08,
    frictionJitter:    0.08,
    velJitter:   0.05,
    velNoise:    0.03,
    omegaJitter: 0.03,
    omegaNoise:  0.20,
};

const SCALE      = 10;        // similarity scale (see header comment)
const G          = 9.81 * SCALE;
const DT         = 1 / 1000;  // s — 16 mm die needs a fine timestep
const MAX_STEPS  = 3000;      // 3 s simulated
const SETTLE_LIN = 0.01 * SCALE;  // m/s (scaled)
const SETTLE_ANG = 0.3;       // rad/s
const SETTLE_STEPS = 120;     // ms of sustained stillness
const ROLLOUTS   = 32;

export interface Prediction {
    face: number;          // most probable face
    probability: number;   // its Monte Carlo probability
    dist: number[];        // index 0..5 → face 1..6 probability
    rollouts: number;
    simMs: number;         // wall-clock cost
    degraded: boolean;     // sensor saturated → don't trust this
}

/* ── small deterministic RNG (reproducible rollouts) ────────────────────── */

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function gauss(rng: () => number): number {
    // Box–Muller
    const u = Math.max(rng(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/* ── quaternion helpers (BNO frame, plain objects) ──────────────────────── */

function rotate(q: Quat, v: Vec3): Vec3 {
    const tx = 2 * (q.y * v.z - q.z * v.y);
    const ty = 2 * (q.z * v.x - q.x * v.z);
    const tz = 2 * (q.x * v.y - q.y * v.x);
    return {
        x: v.x + q.w * tx + (q.y * tz - q.z * ty),
        y: v.y + q.w * ty + (q.z * tx - q.x * tz),
        z: v.z + q.w * tz + (q.x * ty - q.y * tx),
    };
}

/* ── predictor ──────────────────────────────────────────────────────────── */

export class DicePredictor {
    params: SimParams = { ...DEFAULT_PARAMS };
    private ready = false;

    async init(): Promise<void> {
        await RAPIER.init();
        this.ready = true;
    }

    /**
     * Run the Monte Carlo ensemble from a firmware impact packet.
     * Synchronous and CPU-bound (~100–300 ms for 32 rollouts); call it right
     * when the impact packet arrives — the die is still tumbling for far
     * longer than that.
     */
    predict(impact: ImpactPacket, faces: FaceMap): Prediction | null {
        if (!this.ready) return null;

        const t0 = performance.now();
        const rng = mulberry32(impact.t ^ 0x9e3779b9);
        const counts = [0, 0, 0, 0, 0, 0];

        // BNO quaternions are Q14-quantized — renormalize before seeding Rapier
        const qn = Math.hypot(impact.q.x, impact.q.y, impact.q.z, impact.q.w) || 1;
        const q0: Quat = {
            x: impact.q.x / qn, y: impact.q.y / qn,
            z: impact.q.z / qn, w: impact.q.w / qn,
        };

        const p = this.params;
        // gyro rail ±2000 dps: a saturated spin means the seed is wrong
        const degraded = impact.gyroSat > 0;

        for (let i = 0; i < ROLLOUTS; i++) {
            // first rollout is the unjittered nominal trajectory
            const j = i === 0 ? 0 : 1;

            const e  = p.restitution + j * (rng() * 2 - 1) * p.restitutionJitter;
            const mu = p.friction    + j * (rng() * 2 - 1) * p.frictionJitter;

            const v: Vec3 = {
                x: (impact.v.x * (1 + j * gauss(rng) * p.velJitter) + j * gauss(rng) * p.velNoise) * SCALE,
                y: (impact.v.y * (1 + j * gauss(rng) * p.velJitter) + j * gauss(rng) * p.velNoise) * SCALE,
                z: (impact.v.z * (1 + j * gauss(rng) * p.velJitter) + j * gauss(rng) * p.velNoise) * SCALE,
            };
            const wBody: Vec3 = {
                x: impact.w.x * (1 + j * gauss(rng) * p.omegaJitter) + j * gauss(rng) * p.omegaNoise,
                y: impact.w.y * (1 + j * gauss(rng) * p.omegaJitter) + j * gauss(rng) * p.omegaNoise,
                z: impact.w.z * (1 + j * gauss(rng) * p.omegaJitter) + j * gauss(rng) * p.omegaNoise,
            };

            const face = this.rollout(q0, v, rotate(q0, wBody), e, mu, faces);
            if (face >= 1 && face <= 6) counts[face - 1]++;
        }

        const total = counts.reduce((a, b) => a + b, 0) || 1;
        const dist = counts.map(c => c / total);
        let best = 0;
        for (let f = 1; f < 6; f++) if (dist[f] > dist[best]) best = f;

        return {
            face: best + 1,
            probability: dist[best],
            dist,
            rollouts: ROLLOUTS,
            simMs: performance.now() - t0,
            degraded,
        };
    }

    /** Single rollout → final face (1–6) or 0 if it never settled. */
    private rollout(q0: Quat, vel: Vec3, wWorld: Vec3,
                    restitution: number, friction: number,
                    faces: FaceMap): number {
        const p  = this.params;
        const hl = (p.sizeM / 2) * SCALE;
        const r  = p.cornerR * SCALE;

        const world = new RAPIER.World({ x: 0, y: 0, z: -G });
        world.timestep = DT;

        // floor
        world.createCollider(
            RAPIER.ColliderDesc.cuboid(2, 2, 0.5)
                .setTranslation(0, 0, -0.5)
                .setFriction(friction)
                .setRestitution(restitution),
        );

        // start with the lowest corner just above the floor
        let minZ = Infinity;
        for (let sx = -1; sx <= 1; sx += 2)
        for (let sy = -1; sy <= 1; sy += 2)
        for (let sz = -1; sz <= 1; sz += 2) {
            const c = rotate(q0, { x: sx * hl, y: sy * hl, z: sz * hl });
            if (c.z < minZ) minZ = c.z;
        }
        const z0 = -minZ + 0.02 * hl;

        const body = world.createRigidBody(
            RAPIER.RigidBodyDesc.dynamic()
                .setTranslation(0, 0, z0)
                .setRotation(q0)
                .setLinvel(vel.x, vel.y, vel.z)
                .setAngvel(wWorld)
                .setCcdEnabled(true),
        );
        world.createCollider(
            RAPIER.ColliderDesc.roundCuboid(hl - r, hl - r, hl - r, r)
                .setDensity(1.0)
                .setFriction(friction)
                .setRestitution(restitution),
            body,
        );

        let stillSteps = 0;
        let settled = false;
        for (let step = 0; step < MAX_STEPS; step++) {
            world.step();
            const lv = body.linvel();
            const av = body.angvel();
            const lin = Math.hypot(lv.x, lv.y, lv.z);
            const ang = Math.hypot(av.x, av.y, av.z);
            if (lin < SETTLE_LIN && ang < SETTLE_ANG) {
                if (++stillSteps >= SETTLE_STEPS) { settled = true; break; }
            } else {
                stillSteps = 0;
            }
        }

        const rot = body.rotation();
        world.free();

        if (!settled) return 0;
        return faces.faceFromQuat(rot);
    }
}
