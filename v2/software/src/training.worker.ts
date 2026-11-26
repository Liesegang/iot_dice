import { train, type TrainingExample, type TrainingOptions } from './learning';
import type { SimParams } from './model';
import { initPhysics } from './physics';

self.onmessage=async(event:MessageEvent<{examples:TrainingExample[];params:SimParams;options?:TrainingOptions}>)=>{
    try {
        await initPhysics();
        const result=await train(event.data.examples,event.data.params,
            progress=>self.postMessage({progress}),event.data.options);
        self.postMessage({result});
    } catch(error) {self.postMessage({error:String(error)});}
};
