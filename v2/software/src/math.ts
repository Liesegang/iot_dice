import type { Quat, Vec3 } from './ble';

export function normalize(q: Quat): Quat {
    const n = Math.hypot(q.x, q.y, q.z, q.w);
    if (!Number.isFinite(n) || n < 0.1) throw new Error('姿勢データが不正です');
    return { x: q.x/n, y: q.y/n, z: q.z/n, w: q.w/n };
}
export function multiply(a: Quat, b: Quat): Quat {
    return { x:a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y,
        y:a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,
        z:a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w,
        w:a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z };
}
export function rotate(q: Quat, v: Vec3): Vec3 {
    const tx=2*(q.y*v.z-q.z*v.y), ty=2*(q.z*v.x-q.x*v.z), tz=2*(q.x*v.y-q.y*v.x);
    return { x:v.x+q.w*tx+q.y*tz-q.z*ty, y:v.y+q.w*ty+q.z*tx-q.x*tz,
        z:v.z+q.w*tz+q.x*ty-q.y*tx };
}
export function advance(q: Quat, w: Vec3, seconds: number): Quat {
    const speed = Math.hypot(w.x,w.y,w.z);
    if (speed < 1e-8) return q;
    const half = speed*seconds/2, s = Math.sin(half)/speed;
    return normalize(multiply(q, { x:w.x*s, y:w.y*s, z:w.z*s, w:Math.cos(half) }));
}
