import type { TrainingExample, TrainingProgress, TrainingResult } from './learning';
import { checkedParams, type SimParams } from './model';

export class Trainer {
    private worker:Worker|null=null;
    private rejectPending:((error:Error)=>void)|null=null;
    get running():boolean {return this.worker!==null;}
    stop():void {
        this.worker?.terminate();this.worker=null;
        this.rejectPending?.(new Error('学習を停止しました'));this.rejectPending=null;
    }
    async run(examples:TrainingExample[],params:SimParams,
              onProgress:(p:TrainingProgress)=>void):Promise<TrainingResult> {
        if(this.running) throw new Error('学習中です');
        return new Promise((resolve,reject)=>{
            this.rejectPending=reject;
            const worker=new Worker(new URL('./training.worker.ts',import.meta.url),{type:'module'});
            this.worker=worker;
            const finish=()=>{worker.terminate();this.worker=null;this.rejectPending=null;};
            worker.onerror=event=>{finish();reject(new Error(event.message));};
            worker.onmessage=event=>{
                if(event.data.progress) onProgress(event.data.progress);
                else if(event.data.error) {finish();reject(new Error(event.data.error));}
                else if(event.data.result) {finish();resolve(event.data.result);}
            };
            worker.postMessage({examples,params:checkedParams(params)});
        });
    }
}
