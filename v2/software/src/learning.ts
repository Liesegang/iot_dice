import type { ImpactPacket } from './ble';
import type { FaceTable } from './faces';
import { ACTION_BOUNDS, ACTION_KEYS, checkedParams, hash, normal, rng32, type SimParams } from './model';
import { simulate } from './physics';

export interface TrainingExample {
    id: string; impact: ImpactPacket; actualFace: number; faces: FaceTable;
}
export interface Metrics { count: number; accuracy: number; nll: number; brier: number; }
export interface TrainingReport {
    algorithm: 'reinforce-physics-v1'; accepted: boolean; iterations: number;
    counts: {train:number;validation:number;test:number};
    validationBefore: Metrics; validationAfter: Metrics;
    testBefore: Metrics; testAfter: Metrics;
}
export interface TrainingResult { params: SimParams; report: TrainingReport; }
export interface TrainingOptions { iterations?:number; batchSize?:number; actionPairs?:number; trainRollouts?:number; evaluationRollouts?:number; }
export interface TrainingProgress { iteration:number; iterations:number; reward:number; validation:Metrics; }
export type Simulator = (e:TrainingExample,p:SimParams,rollouts:number,seed:number)=>number[];
const defaultSimulator:Simulator=(e,p,n,seed)=>simulate(e.impact,e.faces,p,n,seed).dist;

export function partition(id:string): 'train'|'validation'|'test' {
    const bucket=hash(`dice-rl-split-v1:${id}`)%100;
    return bucket<70?'train':bucket<85?'validation':'test';
}

export function metrics(examples:TrainingExample[],p:SimParams,n:number,sim:Simulator=defaultSimulator):Metrics {
    let hit=0, nll=0, brier=0;
    for(const e of examples) {
        const dist=sim(e,p,n,hash(`evaluation:${e.id}`));
        if(dist.length!==6 || dist.some(v=>!Number.isFinite(v)||v<0||v>1)
            || Math.abs(dist.reduce((a,b)=>a+b,0)-1)>1e-5) throw new Error('予測確率が不正です');
        // Uniform uncertainty is an abstention, not a spurious "face 1" hit.
        if(Math.max(...dist)-Math.min(...dist)>1e-8 && dist.indexOf(Math.max(...dist))+1===e.actualFace) hit++;
        nll-=Math.log(Math.max(1e-8,dist[e.actualFace-1]));
        brier+=dist.reduce((a,v,i)=>a+(v-(i===e.actualFace-1?1:0))**2,0);
    }
    const count=examples.length;
    return {count,accuracy:count?hit/count:0,nll:count?nll/count:0,brier:count?brier/count:0};
}

function encode(p:SimParams):number[] {
    return ACTION_KEYS.map(key=>{
        const [lo,hi]=ACTION_BOUNDS[key];
        const u=Math.max(0.01,Math.min(0.99,(p[key]-lo)/(hi-lo)));
        return Math.log(u/(1-u));
    });
}
function decode(mu:number[],base:SimParams):SimParams {
    const p={...base};
    ACTION_KEYS.forEach((key,i)=>{const [lo,hi]=ACTION_BOUNDS[key];p[key]=lo+(hi-lo)/(1+Math.exp(-mu[i]));});
    return checkedParams(p);
}
export function improves(candidate:Metrics,incumbent:Metrics):boolean {
    return candidate.nll<incumbent.nll-0.005 && candidate.accuracy>=incumbent.accuracy;
}

// One-step reinforcement learning: a Gaussian policy chooses a bounded set of
// physical parameters; the observed landing face rewards its predicted
// probability. REINFORCE score-function gradients use antithetic actions and
// common random rollout seeds. Validation selects; test NEVER selects or trains.
// Williams (1992), https://doi.org/10.1007/BF00992696
export async function train(examples:TrainingExample[],initial:SimParams,
    onProgress:(p:TrainingProgress)=>void=()=>{}, options:TrainingOptions={},
    sim:Simulator=defaultSimulator):Promise<TrainingResult> {
    const base=checkedParams(initial), unique=new Map(examples.map(e=>[e.id,e]));
    if(unique.size!==examples.length) throw new Error('同じ投擲が重複しています');
    const groups={train:[] as TrainingExample[],validation:[] as TrainingExample[],test:[] as TrainingExample[]};
    for(const e of examples) {
        if(!e.id || !Number.isInteger(e.actualFace) || e.actualFace<1 || e.actualFace>6) throw new Error('正解ラベルが不正です');
        groups[partition(e.id)].push(e);
    }
    if(groups.train.length<16 || groups.validation.length<5 || groups.test.length<5)
        throw new Error(`正解確認済みの投擲を増やしてください（学習 ${groups.train.length}/16・検証 ${groups.validation.length}/5・テスト ${groups.test.length}/5）`);
    const iterations=options.iterations??12, batchSize=options.batchSize??8;
    const pairs=options.actionPairs??4, trainRollouts=options.trainRollouts??8, evalRollouts=options.evaluationRollouts??32;
    if(![iterations,batchSize,pairs,trainRollouts,evalRollouts].every(Number.isInteger)
        || iterations<1 || iterations>200 || batchSize<1 || batchSize>128
        || pairs<1 || pairs>16 || trainRollouts<1 || trainRollouts>128 || evalRollouts<1 || evalRollouts>128)
        throw new Error('学習設定が範囲外です');
    let mu=encode(base), best={...base};
    const prior=[...mu], random=rng32(hash(examples.map(e=>e.id).sort().join('|')));
    const before=metrics(groups.validation,base,evalRollouts,sim);
    let bestValidation=before, accepted=false;
    const yieldWorker=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
    for(let iteration=1;iteration<=iterations;iteration++) {
        const batch=Array.from({length:Math.min(batchSize,groups.train.length)},
            ()=>groups.train[Math.floor(random()*groups.train.length)]);
        const sigma=0.6, gradient=mu.map(()=>0);
        let rewardSum=0;
        const reward=(latent:number[])=>{
            const p=decode(latent,base);
            const fit=-metrics(batch,p,trainRollouts,sim).nll;
            const regularization=latent.reduce((a,v,i)=>a+(v-prior[i])**2,0)/latent.length;
            return fit-0.02*regularization;
        };
        for(let pair=0;pair<pairs;pair++) {
            const z=mu.map(()=>normal(random));
            const plus=reward(mu.map((v,i)=>v+sigma*z[i]));
            const minus=reward(mu.map((v,i)=>v-sigma*z[i]));
            rewardSum+=plus+minus;
            z.forEach((v,i)=>{gradient[i]+=(plus-minus)*v/(2*pairs*sigma);});
            await yieldWorker();
        }
        const norm=Math.hypot(...gradient), clip=Math.min(1,1/Math.max(norm,1e-8));
        mu=mu.map((v,i)=>Math.max(-8,Math.min(8,v+0.18*gradient[i]*clip)));
        const candidate=decode(mu,base);
        const validation=metrics(groups.validation,candidate,evalRollouts,sim);
        if(improves(validation,bestValidation)) {best=candidate;bestValidation=validation;accepted=true;}
        onProgress({iteration,iterations,reward:rewardSum/(2*pairs),validation:bestValidation});
        await yieldWorker();
    }
    // Best parameters are frozen BEFORE opening the held-out test partition.
    const testBefore=metrics(groups.test,base,evalRollouts,sim);
    const testAfter=metrics(groups.test,best,evalRollouts,sim);
    return {params:best,report:{algorithm:'reinforce-physics-v1',accepted,iterations,
        counts:{train:groups.train.length,validation:groups.validation.length,test:groups.test.length},
        validationBefore:before,validationAfter:bestValidation,testBefore,testAfter}};
}
