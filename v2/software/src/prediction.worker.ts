import type { ImpactPacket } from './ble';
import type { FaceTable } from './faces';
import type { SimParams } from './model';
import { initPhysics, simulate } from './physics';
import { DEFAULT_TABLE } from './faces';
import { DEFAULT_PARAMS } from './model';

let warmed=false;

self.onmessage=async(event:MessageEvent<{id:number;impact?:ImpactPacket;faces?:FaceTable;params?:SimParams}>)=>{
    const job=event.data;
    try {
        await initPhysics();
        // Compile/warm the WASM contact solver before accepting a real throw.
        // This deterministic synthetic trajectory is never recorded or trained.
        if(!warmed) {
            simulate({t:1000,preT:983,q:{x:.2,y:.1,z:.3,w:Math.sqrt(.86)},
                w:{x:10,y:-15,z:5},v:{x:1,y:-.2,z:-2},fallMs:100,gyroSat:0,accSat:0},
                DEFAULT_TABLE,DEFAULT_PARAMS,32,42);
            warmed=true;
        }
        if(!job.impact) {self.postMessage({id:job.id,ready:true});return;}
        const prediction=simulate(job.impact,job.faces!,job.params!,32);
        self.postMessage({id:job.id,prediction});
    } catch(error) {self.postMessage({id:job.id,error:String(error)});}
};
