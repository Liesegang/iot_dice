import RAPIER from '@dimforge/rapier3d-compat';
import type { ImpactPacket, Quat, Vec3 } from './ble';
import { bodyFromDie, faceFromQuat, type FaceTable } from './faces';
import { advance, multiply, normalize, rotate } from './math';
import { checkedParams, normal, rng32, type SimParams } from './model';

const SCALE=10, G=9.81, DT=1/1000, MAX_STEPS=5000;
export interface Prediction {
    face: number | null; probability: number; dist: number[];
    rollouts: number; resolvedRollouts: number; simMs: number; degraded: boolean;
}

let initialized: Promise<void> | null=null;
export async function initPhysics(): Promise<void> {
    if(!initialized) initialized=RAPIER.init();
    await initialized;
}

function rollout(q0:Quat, velocity:Vec3, omega:Vec3, p:SimParams,
                 restitution:number, friction:number): Quat | null {
    const hl=p.sizeM*SCALE/2, r=p.cornerR*SCALE;
    const world=new RAPIER.World({x:0,y:0,z:-G*SCALE});
    try {
        world.timestep=DT;
        // 15 mm geometry requires explicit contact tolerances. Scaling alone
        // still left the old default penetration tolerance at 0.1 mm.
        world.integrationParameters.lengthUnit=p.sizeM*SCALE;
        world.integrationParameters.numSolverIterations=8;
        world.integrationParameters.maxCcdSubsteps=4;
        world.createCollider(RAPIER.ColliderDesc.cuboid(100,100,0.5)
            .setTranslation(0,0,-0.5).setFriction(friction).setRestitution(restitution));
        // Support function of the rounded box, not of a sharp-cornered cube.
        let minZ=Infinity;
        for(let x=-1;x<=1;x+=2) for(let y=-1;y<=1;y+=2) for(let z=-1;z<=1;z+=2)
            minZ=Math.min(minZ,rotate(q0,{x:x*(hl-r),y:y*(hl-r),z:z*(hl-r)}).z-r);
        const body=world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(0,0,-minZ+hl*0.001).setRotation(q0)
            .setLinvel(velocity.x*SCALE,velocity.y*SCALE,velocity.z*SCALE)
            .setAngvel(omega).setAngularDamping(p.angularDamping).setCcdEnabled(true));
        // Battery/PCB move the center of mass and inertia away from a solid cube.
        const inertia=(p.sizeM*SCALE)**2/6*p.inertiaScale;
        world.createCollider(RAPIER.ColliderDesc.roundCuboid(hl-r,hl-r,hl-r,r)
            .setMassProperties(1,{x:p.comX*2*hl,y:p.comY*2*hl,z:p.comZ*2*hl},
                {x:inertia,y:inertia,z:inertia},{x:0,y:0,z:0,w:1})
            .setFriction(friction).setRestitution(restitution),body);
        let still=0;
        for(let step=0;step<MAX_STEPS;step++) {
            world.step();
            const v=body.linvel(), w=body.angvel();
            if(Math.hypot(v.x,v.y,v.z)<0.01*SCALE && Math.hypot(w.x,w.y,w.z)<0.3) {
                if(++still>=120) return {...body.rotation()};
            } else still=0;
        }
        return null;
    } finally { world.free(); }
}

// This function accepts only the first-impact packet. Landing labels and
// post-impact streams are never inference inputs.
export function simulate(impact:ImpactPacket, table:FaceTable, input:SimParams,
                         rollouts=32, seed=impact.t^0x9e3779b9): Prediction {
    if(!initialized) throw new Error('物理エンジン未初期化');
    if(!Number.isInteger(rollouts)||rollouts<1||rollouts>128) throw new Error('試行回数が範囲外です');
    const p=checkedParams(input), start=performance.now(), rng=rng32(seed);
    const lag=impact.preT===undefined ? 25 : Math.max(0,Math.min(80,impact.t-impact.preT));
    const dt=Math.max(0,(lag+p.impactTimeOffsetMs)/1000);
    const qImu=advance(normalize(impact.q),impact.w,dt);
    const mounting=bodyFromDie(table);
    const qDie=normalize(multiply(qImu,mounting));
    const inverseMounting={x:-mounting.x,y:-mounting.y,z:-mounting.z,w:mounting.w};
    const counts=[0,0,0,0,0,0];
    let resolved=0;
    for(let i=0;i<rollouts;i++) {
        const jitter=i===0?0:1;
        const e=Math.max(0,Math.min(0.98,p.restitution+jitter*(rng()*2-1)*p.restitutionJitter));
        const mu=Math.max(0.01,p.friction+jitter*(rng()*2-1)*p.frictionJitter);
        const perturb=(v:number,scale:number,relative:number,absolute:number)=>
            v*scale*(1+jitter*normal(rng)*relative)+jitter*normal(rng)*absolute;
        const v={x:perturb(impact.v.x,p.velocityScale,p.velJitter,p.velNoise),
            y:perturb(impact.v.y,p.velocityScale,p.velJitter,p.velNoise),
            z:perturb(impact.v.z-G*dt,p.velocityScale,p.velJitter,p.velNoise)};
        const wBody={x:perturb(impact.w.x,p.spinScale,p.omegaJitter,p.omegaNoise),
            y:perturb(impact.w.y,p.spinScale,p.omegaJitter,p.omegaNoise),
            z:perturb(impact.w.z,p.spinScale,p.omegaJitter,p.omegaNoise)};
        const final=rollout(qDie,v,rotate(qImu,wBody),p,e,mu);
        if(final) { ++resolved; counts[faceFromQuat(multiply(final,inverseMounting),table)-1]++; }
    }
    // Unknown trajectories retain probability mass; never drop them and then
    // report a falsely certain result. Jeffreys smoothing prevents zero scores.
    const unknown=rollouts-resolved;
    const dist=counts.map(c=>(c+unknown/6+0.5)/(rollouts+3));
    const best=dist.indexOf(Math.max(...dist));
    return {face:resolved===0?null:best+1,probability:dist[best],dist,rollouts,resolvedRollouts:resolved,
        simMs:performance.now()-start,degraded:impact.gyroSat>0 || resolved<rollouts*0.8};
}
