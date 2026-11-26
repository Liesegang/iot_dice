import type { StreamSample, Vec3 } from './ble';

/** Short relative motion; raw stillness overrides residual integrated velocity. */
export class MotionTrail {
    points: Vec3[] = [];
    position: Vec3 = {x:0,y:0,z:0};
    private previous: StreamSample | null = null;
    private started = 0;
    private active = false;
    private quietSince: number | null = null;
    private motionSince: number | null = null;
    private stopped = false;
    reset(): void {
        this.points=[];this.position={x:0,y:0,z:0};this.previous=null;
        this.active=false;this.quietSince=this.motionSince=null;this.stopped=false;
    }
    private hide(sample:StreamSample):boolean {
        const changed=this.points.length>0;
        this.reset();this.previous=sample;return changed;
    }
    add(sample: StreamSample): boolean {
        if(![sample.t,...Object.values(sample.v),...Object.values(sample.w),...Object.values(sample.a)].every(Number.isFinite)) return false;
        const prev=this.previous, dt=prev?((sample.t-prev.t)>>>0)/1000:0;
        if(prev && dt===0) return false;
        if(prev && dt>0.25) {const changed=this.hide(sample);this.stopped=true;return changed;}
        if(sample.state==='rest') return this.hide(sample);
        const omega=Math.hypot(sample.w.x,sample.w.y,sample.w.z), accel=Math.hypot(sample.a.x,sample.a.y,sample.a.z);
        const quiet=omega<0.4 && accel<0.8;
        this.previous=sample;
        if(quiet) {
            this.motionSince=null;
            if(this.quietSince===null) this.quietSince=sample.t;
            // Never integrate a stale velocity during stillness, even before FSM settles.
            if(((sample.t-this.quietSince)>>>0)>=120) return this.hide(sample);
            return false;
        }
        this.quietSince=null;
        if(this.stopped) return false;
        if(!this.active) {
            if(omega<0.6 && accel<1.2) {this.motionSince=null;return false;}
            if(this.motionSince===null) this.motionSince=sample.t;
            if(((sample.t-this.motionSince)>>>0)<20) return false;
            this.active=true;this.started=sample.t;this.points.push({...this.position});return true;
        }
        if(((sample.t-this.started)>>>0)>8000) {const changed=this.hide(sample);this.stopped=true;return changed;}
        if(prev) for(const axis of ['x','y','z'] as const)
            this.position[axis]+=(prev.v[axis]+sample.v[axis])*0.5*dt;
        this.points.push({...this.position});
        if(this.points.length>1000) this.points.shift();
        return true;
    }
}
