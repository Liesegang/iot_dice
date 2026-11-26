import type { ImpactPacket } from './ble';
import type { FaceMap } from './faces';
import { DEFAULT_PARAMS, checkedParams, type SimParams } from './model';
import type { Prediction } from './physics';
export type { Prediction } from './physics';
export { DEFAULT_PARAMS } from './model';
export type { SimParams } from './model';

/** Worker-backed first-impact prediction. The BLE/UI thread never runs physics. */
export class DicePredictor {
    params: SimParams = { ...DEFAULT_PARAMS };
    private worker: Worker | null = null;
    private nextId = 0;
    private pending = new Map<number, { resolve:(p:Prediction|null)=>void; reject:(e:Error)=>void; timer:ReturnType<typeof setTimeout> }>();

    private request(impact?:ImpactPacket, faces?:FaceMap):Promise<Prediction|null> {
        if (!this.worker) {
            this.worker = new Worker(new URL('./prediction.worker.ts', import.meta.url), {type:'module'});
            this.worker.onmessage = event => {
                const job = this.pending.get(event.data.id);
                if (!job) return;
                this.pending.delete(event.data.id); clearTimeout(job.timer);
                if (event.data.error) job.reject(new Error(event.data.error));
                else job.resolve(event.data.prediction ?? null);
            };
            this.worker.onerror = event => {
                for (const job of this.pending.values()) {clearTimeout(job.timer);job.reject(new Error(event.message));}
                this.pending.clear(); this.worker?.terminate(); this.worker=null;
            };
        }
        const id=++this.nextId;
        const params=checkedParams(this.params);
        const table=faces?.snapshot();
        return new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('予測計算がタイムアウトしました'));},15000);
            this.pending.set(id,{resolve,reject,timer});
            try { this.worker!.postMessage({id,impact,faces:table,params}); }
            catch(error) {clearTimeout(timer);this.pending.delete(id);reject(error);}
        });
    }
    async init():Promise<void> {await this.request();}
    async predict(impact:ImpactPacket,faces:FaceMap):Promise<Prediction|null> {return this.request(impact,faces);}
}
