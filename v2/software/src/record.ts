import type { ImpactPacket, ResultPacket, StreamSample } from './ble';
import { checkedTable, bodyFromDie, type FaceTable } from './faces';
import { normalize } from './math';
import { checkedParams, type SimParams } from './model';
import type { TrainingExample } from './learning';

export interface ThrowRecord {
    schema: 2; id: string; session: string; source: 'physical' | 'synthetic';
    profile: string; ts: string;
    impact: ImpactPacket; result: ResultPacket; actualFace: number;
    labelVerified: boolean; calibrated: boolean; faces: FaceTable;
    predictedFace: number | null; predictedDist: number[] | null;
    predictionTimely: boolean; predictionLatencyMs: number | null;
    params: SimParams; modelVersion: string;
    stream: StreamSample[];
}

export function trainingExamples(records:ThrowRecord[],profile:string):TrainingExample[] {
    return records.filter(r=>r.profile===profile && r.source==='physical'
        && r.calibrated && r.labelVerified && r.impact.gyroSat===0)
        .map(r=>({id:r.id,impact:r.impact,actualFace:r.actualFace,faces:r.faces}));
}

export function checkedRecord(value:unknown):ThrowRecord {
    const r=value as ThrowRecord;
    if(!r || r.schema!==2 || typeof r.id!=='string' || !r.id || r.id.length>200
        || !['physical','synthetic'].includes(r.source) || typeof r.profile!=='string'
        || typeof r.session!=='string' || typeof r.ts!=='string'
        || !Number.isInteger(r.actualFace) || r.actualFace<1 || r.actualFace>6
        || typeof r.labelVerified!=='boolean' || typeof r.calibrated!=='boolean'
        || typeof r.predictionTimely!=='boolean') throw new Error('v2の投擲記録が必要です');
    for(const packet of [r.impact,r.result]) {
        if(!packet || !Number.isFinite(packet.t)) throw new Error('時刻が不正です');
        normalize(packet.q);
    }
    for(const v of [r.impact.w,r.impact.v])
        if(!v || ![v.x,v.y,v.z].every(Number.isFinite)) throw new Error('運動データが不正です');
    if(Math.hypot(r.impact.w.x,r.impact.w.y,r.impact.w.z)>100
        || Math.hypot(r.impact.v.x,r.impact.v.y,r.impact.v.z)>50
        || !Number.isFinite(r.impact.fallMs) || r.impact.fallMs<0 || r.impact.fallMs>65535
        || ![r.impact.gyroSat,r.impact.accSat].every(v=>Number.isInteger(v)&&v>=0&&v<=255)) throw new Error('運動データが範囲外です');
    if(r.impact.preT!==undefined && (!Number.isFinite(r.impact.preT) || r.impact.preT>r.impact.t))
        throw new Error('衝突前の時刻が不正です');
    if(!Array.isArray(r.stream) || r.stream.length>10000) throw new Error('記録サイズが不正です');
    if(r.predictedDist!==null && (!Array.isArray(r.predictedDist) || r.predictedDist.length!==6
        || r.predictedDist.some(v=>!Number.isFinite(v)||v<0||v>1)
        || Math.abs(r.predictedDist.reduce((a,b)=>a+b,0)-1)>1e-5)) throw new Error('予測分布が不正です');
    if(r.result.t<r.impact.t || (r.impact.throwId!==undefined&&r.result.throwId!==undefined&&r.impact.throwId!==r.result.throwId))
        throw new Error('衝突と着地が一致しません');
    const faces=checkedTable(r.faces);if(r.calibrated) bodyFromDie(faces);
    return {...r,faces,params:checkedParams(r.params)};
}

const DB_NAME='dice-throws-v2';
const STORE_NAME='throws';
export class ThrowStore {
    private db:IDBDatabase|null=null;
    async open():Promise<void> {
        this.db=await new Promise((resolve,reject)=>{
            const req=indexedDB.open(DB_NAME,1);
            req.onupgradeneeded=()=>req.result.createObjectStore(STORE_NAME,{keyPath:'id'});
            req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
        });
    }
    async add(rec:ThrowRecord):Promise<void> {
        if(!this.db) throw new Error('記録DB未初期化');
        const valid=checkedRecord(rec), tx=this.db.transaction(STORE_NAME,'readwrite');
        tx.objectStore(STORE_NAME).put(valid);
        await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
    }
    async all():Promise<ThrowRecord[]> {
        if(!this.db) throw new Error('記録DB未初期化');
        return new Promise((resolve,reject)=>{
            const req=this.db!.transaction(STORE_NAME,'readonly').objectStore(STORE_NAME).getAll();
            req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
        });
    }
    async count():Promise<number> {return (await this.all()).length;}
    async importJson(input:unknown):Promise<number> {
        const values=Array.isArray(input)?input:(input as {records?:unknown[]})?.records;
        if(!Array.isArray(values)||values.length>10000) throw new Error('投擲記録の配列が必要です');
        const records=values.map(checkedRecord);
        if(records.some(r=>r.source!=='physical')) throw new Error('実機の記録だけを取り込めます');
        const existing=new Set((await this.all()).map(r=>r.id));
        const fresh=records.filter(r=>{if(existing.has(r.id)) return false;existing.add(r.id);return true;});
        if(!this.db) throw new Error('記録DB未初期化');
        if(!fresh.length) return 0;
        const tx=this.db.transaction(STORE_NAME,'readwrite');
        for(const rec of fresh) tx.objectStore(STORE_NAME).add(rec);
        await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
        return fresh.length;
    }
    async exportJson():Promise<void> {downloadJson(await this.all(),`dice-throws-v2-${new Date().toISOString().slice(0,19).replace(/[T:]/g,'-')}.json`);}
}
export function downloadJson(value:unknown,filename:string):void {
    const url=URL.createObjectURL(new Blob([JSON.stringify(value)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download=filename;link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
}
