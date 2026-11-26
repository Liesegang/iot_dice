import { DiceBle, type ImpactPacket, type StreamSample } from './ble';
import { DiceScene } from './dice';
import { FaceMap, faceFromQuat, bodyFromDie, displayOrientation, isMirroredTable, type FaceTable } from './faces';
import { DicePredictor, type Prediction } from './predict';
import { ThrowStore, trainingExamples, downloadJson, type ThrowRecord } from './record';
import { DEFAULT_PARAMS, checkedParams, checkedModel, MODEL_ENGINE as ENGINE, type SimParams, type SavedModel } from './model';
import { partition } from './learning';
import { Trainer } from './trainer';
import { MotionTrail } from './trajectory';
import { normalize, multiply } from './math';
import { MotionCharts } from './motion-chart';

const element=(id:string)=>document.getElementById(id)!;
const button=(id:string)=>element(id) as HTMLButtonElement;
const input=(id:string)=>element(id) as HTMLInputElement;
const btnConnect=button('connect-btn'), btnSimulation=button('simulation-btn');
const elStatus=element('status'), elPred=element('prediction');
const elPredFace=element('pred-face'), elPredLabel=element('pred-label');
const labelRow=element('label-row'), learnPanel=element('learn-panel');
const learningStatus=element('learning-status'), trainButton=button('train-btn');
const stopTrainingButton=button('stop-training-btn');
const ble=new DiceBle(), scene=new DiceScene(element('app'));
const charts=new MotionCharts(element('motion-charts'));
const trail=new MotionTrail();
let trajectoryEnabled=true;
scene.setTrajectoryEnabled(true);
const motionMode=()=>simulationEnabled||trajectoryEnabled;
const updateTrailStatus=()=>{
    const p=trail.position;
    element('trajectory-status').textContent=trajectoryEnabled
        ? trail.points.length ? `推定軌跡 ${trail.points.length}点・Δ X ${(p.x*100).toFixed(1)} / Y ${(p.y*100).toFixed(1)} / Z ${(p.z*100).toFixed(1)} cm` : '推定軌跡：動作待ち（静止中は非表示）'
        : '軌跡 OFF';
};
function resetTrail():void {trail.reset();scene.setTrajectory(trail.points,trail.position);updateTrailStatus();}
button('trail-clear-btn').addEventListener('click',resetTrail);
button('trajectory-btn').addEventListener('click',async()=>{
    const b=button('trajectory-btn');b.disabled=true;
    try {
        await ble.setSimulationEnabled(simulationEnabled||!trajectoryEnabled);
        trajectoryEnabled=!trajectoryEnabled;scene.setTrajectoryEnabled(trajectoryEnabled);resetTrail();
        b.textContent=`軌跡 ${trajectoryEnabled?'ON':'OFF'}`;b.setAttribute('aria-pressed',String(trajectoryEnabled));
        showConnectionStatus();
    } catch(error) {elStatus.textContent=`軌跡: ${error}`;}
    finally {b.disabled=false;}
});
const faceMap=new FaceMap(), predictor=new DicePredictor();
const store=new ThrowStore(), trainer=new Trainer();
const CONFIG_KEY='dice-v2-experiment', MODEL_PREFIX='dice-rl-model-v2:';
interface Config {surface:string;sizeM:number;cornerR:number;}
let config:Config={surface:'試験面1（未指定）',sizeM:0.015,cornerR:0.0008};
try {
    const saved=JSON.parse(localStorage.getItem(CONFIG_KEY)??'null');
    if(saved && typeof saved.surface==='string') {
        const p=checkedParams({...DEFAULT_PARAMS,sizeM:saved.sizeM,cornerR:saved.cornerR});
        config={surface:saved.surface.slice(0,80),sizeM:p.sizeM,cornerR:p.cornerR};
    }
} catch { /* retain measured 15 mm default */ }
const profileKey=()=>JSON.stringify([config.surface,config.sizeM,config.cornerR]);
let model:SavedModel;
function loadModel():void {
    const initial=checkedParams({...DEFAULT_PARAMS,sizeM:config.sizeM,cornerR:config.cornerR});
    model={modelSchema:1,engine:ENGINE,profile:profileKey(),version:'initial',source:'untrained',params:initial,trainedRecords:0,report:null};
    try {
        const saved=checkedModel(JSON.parse(localStorage.getItem(MODEL_PREFIX+profileKey())??'null'),profileKey());
        if(saved && saved.modelSchema===1 && saved.engine===ENGINE && saved.profile===profileKey()) {
            const p=checkedParams(saved.params);
            if(p.sizeM===config.sizeM && p.cornerR===config.cornerR) model={...saved,params:p};
        }
    } catch { /* corrupted model never reaches physics */ }
    predictor.params={...model.params};
    element('model-summary').textContent=`モデル: ${model.version==='initial'?'初期値・実機未学習':`学習済み（${model.trainedRecords}投）`} / 反発 ${model.params.restitution.toFixed(2)}・摩擦 ${model.params.friction.toFixed(2)}`;
}
loadModel();
input('surface-input').value=config.surface;
input('size-input').value=String(config.sizeM*1000);
input('corner-input').value=String(config.cornerR*1000);
let records:ThrowRecord[]=[];
let lastAttempt=0;
let session=crypto.randomUUID();
let simulationEnabled=false, predictorReady=false;
let mounting={x:0,y:0,z:0,w:1}, calibrationValid=false;
let quietSince=0;
function applyCalibration():void {
    calibrationValid=false;mounting={x:0,y:0,z:0,w:1};scene.setMirroredFaces(false);
    if(faceMap.calibrated) {
        const table=faceMap.snapshot();mounting=displayOrientation(mounting,table);
        scene.setMirroredFaces(isMirroredTable(table));calibrationValid=true;
    }
}
try {applyCalibration();} catch(error) {elStatus.textContent=`面校正: ${error}`;}
let streamBuf:StreamSample[]=[], latest:StreamSample|null=null;
let connectedAt=0, lastSampleAt=0, sampleCount=0, rateStartedAt=performance.now(), sampleRate=0;
let generation=0, lastRecord:ThrowRecord|null=null;
interface PendingThrow {
    generation:number; id:string; impact:ImpactPacket; started:number; prediction:Prediction|null;
    latency:number|null; faces:FaceTable; calibrated:boolean; params:SimParams; version:string; profile:string;session:string;
}
let pending:PendingThrow|null=null;
let resultTimer:ReturnType<typeof setTimeout>|undefined;
const storeReady=store.open().then(()=>refreshStats()).catch(error=>{learningStatus.textContent=`記録DB: ${error}`;});

async function refreshStats():Promise<void> {
    records=await store.all();
    const current=records.filter(r=>r.profile===profileKey());
    const scored=current.filter(r=>r.labelVerified&&r.predictionTimely&&r.predictedFace!==null);
    const hits=scored.filter(r=>r.predictedFace===r.actualFace).length;
    element('stats').textContent=`記録 ${current.length}投・正解確認 ${current.filter(r=>r.labelVerified).length}投${scored.length?`・的中 ${hits}/${scored.length}`:''}`;
    const examples=trainingExamples(current,profileKey());
    const count={train:0,validation:0,test:0};
    examples.forEach(e=>count[partition(e.id)]++);
    const noCalibration=current.filter(r=>r.labelVerified&&!r.calibrated).length;
    const saturated=current.filter(r=>r.labelVerified&&r.calibrated&&r.impact.gyroSat>0).length;
    element('learning-data').textContent=`学習可能 ${examples.length}投（学習 ${count.train}/16・検証 ${count.validation}/5・学習外テスト ${count.test}/5）${noCalibration||saturated?`。確認済みでも対象外：校正前 ${noCalibration}投・ジャイロ飽和 ${saturated}投`:''}`;
    const unconfirmed=current.filter(r=>!r.labelVerified).length;
    const missing=[count.train<16?`学習あと${16-count.train}投`:'',count.validation<5?`検証あと${5-count.validation}投`:'',count.test<5?`テストあと${5-count.test}投`:''].filter(Boolean);
    const state=trainer.running?'学習中':model.source==='physical'?`学習済みモデル ${model.trainedRecords}投`:'未学習・初期値';
    element('training-indicator').textContent=`${state}・学習可能 ${examples.length}投`;
    element('learning-readiness').textContent=trainer.running?'パラメータを更新・検証しています':
        !calibrationValid?'学習待ち：有効な6面校正が必要です':missing.length?`学習待ち：正解未確認 ${unconfirmed}投。${missing.join('・')}`:
        input('auto-learn').checked?`学習可能：正解確認の操作で自動開始。以降10投追加ごとに再学習`:'学習可能：「強化学習する」で開始';
    const attempt=localStorage.getItem('dice-training-attempt-v2:'+profileKey());
    try {
        const a=attempt?JSON.parse(attempt):null;
        element('learning-last-run').textContent=a?`最終学習 ${new Date(a.at).toLocaleString('ja-JP')}・${a.report.iterations}回更新・${a.report.accepted?'モデル採用':'改善なし、既存モデル維持'}`:'学習実行履歴なし';
    } catch {element('learning-last-run').textContent='学習実行履歴なし';}
    renderReview(current);
    trainButton.disabled=trainer.running||count.train<16||count.validation<5||count.test<5;
    stopTrainingButton.disabled=!trainer.running;
}
function renderReview(current:ThrowRecord[]):void {
    const list=element('label-review');list.replaceChildren();
    for(const record of current.filter(r=>!r.labelVerified).sort((a,b)=>b.ts.localeCompare(a.ts)).slice(0,8)) {
        const row=document.createElement('div');row.className='review-row';
        const caption=document.createElement('p');caption.textContent=`${new Date(record.ts).toLocaleTimeString('ja-JP')}の出目${!record.calibrated?'（校正前・学習対象外）':record.impact.gyroSat>0?'（ジャイロ飽和・学習対象外）':''}`;
        row.append(caption);
        for(let f=1;f<=6;f++) {
            const b=document.createElement('button');b.className='small';b.textContent=String(f);
            b.addEventListener('click',async()=>{
                const rec={...record,actualFace:f,labelVerified:true};
                try {await store.add(rec);if(lastRecord?.id===rec.id) {lastRecord=rec;showResult(rec);}await refreshStats();await maybeTrain();}
                catch(error) {learningStatus.textContent=String(error);}
            });row.append(b);
        }
        list.append(row);
    }
}
const distBars:HTMLDivElement[]=[];
for(let f=1;f<=6;f++) {
    const col=document.createElement('div'); col.className='dist-col';
    const bar=document.createElement('div');bar.className='dist-bar';
    const n=document.createElement('div');n.className='dist-num';n.textContent=String(f);
    col.append(bar,n);element('dist').appendChild(col);distBars.push(bar);
}
function showDist(dist:number[]|null):void {distBars.forEach((b,i)=>{b.style.height=dist?`${Math.round(dist[i]*44)+1}px`:'1px';});}
function showPrediction(pred:Prediction):void {
    elPredFace.textContent=pred.face===null?'?':String(pred.face);elPredFace.className=pred.degraded?'degraded':'uncertain';
    elPredLabel.textContent=pred.face===null?'初回衝突の予測：未収束':`初回衝突の予測 ${Math.round(pred.probability*100)}%${pred.degraded?'・入力／収束に不確かさ':''}`;
    showDist(pred.dist);elPred.classList.add('visible');
}
function showResult(record:ThrowRecord):void {
    elPredFace.textContent=String(record.actualFace);
    elPredFace.className=record.labelVerified?'locked':'uncertain';
    const outcome=record.predictedFace===null?'予測なし':record.predictedFace===record.actualFace?'的中':'はずれ';
    elPredLabel.textContent=record.labelVerified?`正解確認・${outcome}`:'静止時の推定・実際の目を確認';
    elPred.classList.add('visible');labelRow.hidden=false;
    element('label-caption').textContent=record.labelVerified?`正解 ${record.actualFace}：`:'実際の目：';
    labelRow.querySelectorAll('button').forEach(b=>b.classList.toggle('done',record.labelVerified&&Number(b.textContent)===record.actualFace));
}

const STATE_LABEL:Record<string,string>={rest:'静止',moving:'移動',freefall:'落下',tumbling:'転がり'};
ble.onSample=s=>{
    lastSampleAt=performance.now(); sampleCount++; latest=s;
    charts.add(s);
    const q=normalize(multiply(s.q,mounting));scene.setQuaternion(q.x,q.y,q.z,q.w);
    const quiet=Math.hypot(s.w.x,s.w.y,s.w.z)<.4 && Math.hypot(s.a.x,s.a.y,s.a.z)<.8;
    quietSince=quiet?(quietSince||performance.now()):0;
    element('up-face').textContent=calibrationValid?`上面 ${faceMap.faceFromQuat(s.q)}`:'上面：6面校正待ち';
    if(trajectoryEnabled && trail.add(s)) {scene.setTrajectory(trail.points,trail.position);updateTrailStatus();}
    if(simulationEnabled) {streamBuf.push(s);streamBuf=streamBuf.filter(v=>v.t>=s.t-8000);}
    const omega=Math.hypot(s.w.x,s.w.y,s.w.z);
    element('omega').textContent=omega>0.1?`ω ${omega.toFixed(2)} rad/s`:'';
    element('state').textContent=STATE_LABEL[s.state]??s.state;
};
ble.onImpact=impact=>{
    if(!simulationEnabled||!predictorReady||!calibrationValid) return;
    if(pending?.impact.t===impact.t) return; // only the first collision per throw
    clearTimeout(resultTimer);labelRow.hidden=true;elPred.classList.remove('visible');
    const job:PendingThrow={generation:++generation,id:crypto.randomUUID(),
        impact,started:performance.now(),prediction:null,latency:null,faces:faceMap.snapshot(),
        calibrated:calibrationValid,params:{...predictor.params},version:model.version,profile:profileKey(),session};
    pending=job;
    elPredLabel.textContent='初回衝突から計算中';
    predictor.predict(impact,faceMap).then(pred=>{
        // Late or previous-throw answers must never be displayed/scored after landing.
        if(pending!==job||!pred) return;
        job.prediction=pred;job.latency=performance.now()-job.started;showPrediction(pred);
    }).catch(error=>{if(pending===job) {elStatus.textContent=`予測: ${error}`;}});
};
ble.onResult=async result=>{
    const job=pending;
    if(!simulationEnabled||!job) return;
    if(result.throwId!==undefined&&job.impact.throwId!==undefined&&result.throwId!==job.impact.throwId) return;
    pending=null;
    const record:ThrowRecord={schema:2,id:job.id,session:job.session,source:'physical',profile:job.profile,
        ts:new Date().toISOString(),impact:job.impact,result,actualFace:faceFromQuat(result.q,job.faces),
        labelVerified:false,calibrated:job.calibrated,faces:job.faces,
        predictedFace:job.prediction?.face??null,predictedDist:job.prediction?.dist??null,
        predictionTimely:job.prediction!==null,predictionLatencyMs:job.latency,
        params:job.params,modelVersion:job.version,
        stream:streamBuf.filter(s=>s.t>=job.impact.t-2000&&s.t<=result.t)};
    try {
        await storeReady;await store.add(record);await refreshStats();
        if(generation!==job.generation) return;
        lastRecord=record;showResult(record);
        resultTimer=setTimeout(()=>elPred.classList.remove('visible'),6000);
    } catch(error) {learningStatus.textContent=`記録失敗: ${error}`;}
};
for(let f=1;f<=6;f++) {
    const b=document.createElement('button');b.className='small';b.textContent=String(f);
    b.addEventListener('click',async()=>{
        if(!lastRecord) return;
        const rec={...lastRecord,actualFace:f,labelVerified:true};
        try {await store.add(rec);if(lastRecord?.id===rec.id) {lastRecord=rec;showResult(rec);}await refreshStats();await maybeTrain();}
        catch(error) {learningStatus.textContent=String(error);}
    });labelRow.appendChild(b);
}
function clearThrow():void {generation++;pending=null;streamBuf=[];lastRecord=null;labelRow.hidden=true;clearTimeout(resultTimer);elPred.classList.remove('visible');}
ble.onStatusChange=status=>{
    elStatus.textContent=status;btnConnect.textContent=ble.connected?'切断':'🎲 サイコロを接続';btnConnect.disabled=ble.connecting;
    if(!ble.connected) {charts.clear();quietSince=0;resetTrail();latest=null;lastSampleAt=0;sampleCount=0;sampleRate=0;element('state').textContent='';element('omega').textContent='';clearThrow();}
};
function showConnectionStatus():void {
    if(!ble.connected||ble.connecting) return;
    if(performance.now()-(lastSampleAt||connectedAt)>3000) elStatus.textContent='接続済み：姿勢データ未受信';
    else elStatus.textContent=lastSampleAt?`姿勢受信中（${simulationEnabled?'初回衝突予測':trajectoryEnabled?'姿勢・推定軌跡':'姿勢・IMU'}・${sampleRate} Hz）`:'接続済み：姿勢データ待ち';
}
setInterval(()=>{const now=performance.now();sampleRate=Math.round(sampleCount*1000/(now-rateStartedAt));sampleCount=0;rateStartedAt=now;showConnectionStatus();},1000);
btnConnect.addEventListener('click',async()=>{
    if(ble.connected) {ble.disconnect();return;}
    try {await ble.connect();session=crypto.randomUUID();clearThrow();connectedAt=performance.now();rateStartedAt=connectedAt;await ble.setSimulationEnabled(motionMode());showConnectionStatus();}
    catch(error) {ble.disconnect();elStatus.textContent=String(error);btnConnect.disabled=false;}
});
btnSimulation.addEventListener('click',async()=>{
    if(!simulationEnabled&&!faceMap.calibrated) {
        element('calib-panel').classList.add('open');elStatus.textContent='予測の前に6面を校正してください';return;
    }
    btnSimulation.disabled=true;
    try {
        if(!predictorReady) {elStatus.textContent='予測を準備中';await predictor.init();predictorReady=true;}
        if(!simulationEnabled) bodyFromDie(faceMap.snapshot());
        simulationEnabled=!simulationEnabled;clearThrow();
        await ble.setSimulationEnabled(motionMode());
        btnSimulation.textContent=`予測 ${simulationEnabled?'ON':'OFF'}`;
        showConnectionStatus();if(!ble.connected) elStatus.textContent=simulationEnabled?'未接続（予測ON）':'未接続';
    } catch(error) {elStatus.textContent=`予測準備: ${error}`;simulationEnabled=false;btnSimulation.textContent='予測 OFF';}
    finally {btnSimulation.disabled=false;}
});
const calibDone=new Set(faceMap.calibratedFaces);
for(let f=1;f<=6;f++) {
    const b=document.createElement('button');b.className='small';b.textContent=String(f);b.classList.toggle('done',calibDone.has(f));
    b.addEventListener('click',()=>{
        if(!latest||pending) {elStatus.textContent='接続して静止させてから校正してください';return;}
        if(!quietSince || performance.now()-quietSince<300) {elStatus.textContent='サイコロを300ms以上静止させてから校正してください';return;}
        faceMap.calibrate(f,latest.q);calibDone.add(f);b.classList.add('done');
        try {
            applyCalibration();
            const q=normalize(multiply(latest.q,mounting));scene.setQuaternion(q.x,q.y,q.z,q.w);
            elStatus.textContent=`面校正 ${calibDone.size}/6${calibrationValid?'・3D表示に反映':''}`;
        } catch(error) {elStatus.textContent=`面校正: ${error}`;}
        refreshStats().catch(error=>{learningStatus.textContent=String(error);});
    });element('calib-faces').appendChild(b);
}
button('calib-btn').addEventListener('click',()=>element('calib-panel').classList.toggle('open'));
button('calib-reset').addEventListener('click',async()=>{
    faceMap.resetCalibration();applyCalibration();calibDone.clear();clearThrow();simulationEnabled=false;btnSimulation.textContent='予測 OFF';
    element('calib-faces').querySelectorAll('button').forEach(b=>b.classList.remove('done'));
    try {await ble.setSimulationEnabled(motionMode());} catch(error) {elStatus.textContent=String(error);}
});
button('export-btn').addEventListener('click',()=>{store.exportJson().catch(error=>{learningStatus.textContent=String(error);});});
button('learn-btn').addEventListener('click',()=>learnPanel.classList.toggle('open'));
button('profile-apply').addEventListener('click',async()=>{
    try {
        const surface=input('surface-input').value.trim();if(!surface) throw new Error('投げる面の名前を入力してください');
        const p=checkedParams({...DEFAULT_PARAMS,sizeM:Number(input('size-input').value)/1000,cornerR:Number(input('corner-input').value)/1000});
        trainer.stop();config={surface,sizeM:p.sizeM,cornerR:p.cornerR};
        localStorage.setItem(CONFIG_KEY,JSON.stringify(config));loadModel();lastAttempt=0;await refreshStats();
        learningStatus.textContent='この面と外寸の記録・モデルを選択しました';
    } catch(error) {learningStatus.textContent=String(error);}
});
async function trainNow():Promise<void> {
    await storeReady;if(trainer.running) return;
    const profile=profileKey(), examples=trainingExamples(records,profile);
    lastAttempt=examples.length;trainButton.disabled=true;stopTrainingButton.disabled=false;
    learningStatus.textContent='強化学習を準備中（予測・BLEは継続）';
    element('training-indicator').textContent='学習中・準備';
    try {
        const result=await trainer.run(examples,{...predictor.params},p=>{
            element('training-indicator').textContent=`学習中 ${p.iteration}/${p.iterations}`;
            learningStatus.textContent=`学習 ${p.iteration}/${p.iterations}・検証の的中率 ${Math.round(p.validation.accuracy*100)}%`;
        });
        if(profile!==profileKey()) return;
        const report=result.report;
        if(report.accepted) {
            model={modelSchema:1,engine:ENGINE,profile,version:`rl-${new Date().toISOString()}`,source:'physical',params:result.params,trainedRecords:examples.length,report};
            localStorage.setItem(MODEL_PREFIX+profile,JSON.stringify(model));loadModel();
        }
        localStorage.setItem('dice-training-attempt-v2:'+profile,JSON.stringify({at:new Date().toISOString(),report}));
        const pct=(v:number)=>`${Math.round(v*100)}%`;
        learningStatus.textContent=`${report.accepted?'検証で改善したモデルを採用':'改善を確認できず、現在のモデルを保持'}\n検証 ${pct(report.validationBefore.accuracy)} → ${pct(report.validationAfter.accuracy)}（${report.counts.validation}投）\n学習外テスト ${pct(report.testBefore.accuracy)} → ${pct(report.testAfter.accuracy)}（${report.counts.test}投）`;
    } catch(error) {learningStatus.textContent=String(error);}
    finally {await refreshStats();}
}
async function maybeTrain():Promise<void> {
    const n=trainingExamples(records,profileKey()).length;
    if(input('auto-learn').checked&&!trainButton.disabled&&n>=Math.max(model.trainedRecords,lastAttempt)+10) await trainNow();
}
trainButton.addEventListener('click',()=>{trainNow().catch(error=>{learningStatus.textContent=String(error);});});
stopTrainingButton.addEventListener('click',()=>trainer.stop());
input('auto-learn').addEventListener('change',()=>{refreshStats().catch(error=>{learningStatus.textContent=String(error);});});
button('model-export-btn').addEventListener('click',()=>downloadJson(model,'dice-model-v2.json'));
button('import-btn').addEventListener('click',()=>input('import-file').click());
input('import-file').addEventListener('change',async()=>{
    const file=input('import-file').files?.[0];if(!file) return;
    try {
        if(file.size>100*1024*1024) throw new Error('100 MB以下のJSONを選んでください');
        const data=JSON.parse(await file.text());
        if(data.modelSchema===1) {
            const valid=checkedModel(data,profileKey()), p=valid.params;
            if(p.sizeM!==config.sizeM||p.cornerR!==config.cornerR) throw new Error('モデルの外寸が違います');
            localStorage.setItem(MODEL_PREFIX+profileKey(),JSON.stringify(valid));loadModel();learningStatus.textContent='モデルを読み込みました';
        } else {await storeReady;const n=await store.importJson(data);learningStatus.textContent=`実機記録を${n}投読み込みました`;await refreshStats();}
    } catch(error) {learningStatus.textContent=String(error);}
    finally {input('import-file').value='';}
});
