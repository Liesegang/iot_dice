import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {loadCore} from '../tools/load-core.mjs';
const c=await loadCore();after(()=>c.cleanup());
const {DEFAULT_PARAMS:P}=c.model, {DEFAULT_TABLE:F}=c.faces;
const identity={x:0,y:0,z:0,w:1};
const impact={t:1000,preT:983,q:identity,w:{x:0,y:0,z:0},v:{x:0,y:0,z:-0.1},fallMs:100,gyroSat:0,accSat:0};
function corpus() {
    const groups={train:[],validation:[],test:[]};
    for(let i=0;Object.values(groups).some(v=>v.length<16);i++) {
        const e={id:`synthetic-test-${i}`,impact,faces:F,actualFace:1};
        const key=c.learning.partition(e.id);if(groups[key].length<16) groups[key].push(e);
    }
    return Object.values(groups).flat();
}
function record(overrides={}) {
    return {schema:2,id:'one',session:'test',source:'physical',profile:'surface',ts:new Date().toISOString(),
        impact,result:{t:1500,q:identity,maxW:1,maxA:30,gyroSat:0,accSat:0},actualFace:1,
        labelVerified:true,calibrated:true,faces:F,predictedFace:1,predictedDist:[1,0,0,0,0,0],
        predictionTimely:true,predictionLatencyMs:100,params:P,modelVersion:'initial',stream:[],...overrides};
}
test('signed tilts, mounting rotation and either dice numbering handedness are preserved',()=>{
    const tilt=Math.PI/3;
    assert.notEqual(c.faces.faceFromQuat({x:Math.sin(tilt/2),y:0,z:0,w:Math.cos(tilt/2)},F),
        c.faces.faceFromQuat({x:-Math.sin(tilt/2),y:0,z:0,w:Math.cos(tilt/2)},F));
    const mount={x:Math.sin(.3),y:0,z:0,w:Math.cos(.3)};
    const table=Object.fromEntries(Object.entries(F).map(([f,v])=>{
        const r=c.math.rotate(mount,{x:v[0],y:v[1],z:v[2]});return [f,[r.x,r.y,r.z]];
    }));
    assert.ok(Math.abs(c.faces.bodyFromDie(table).x-mount.x)<1e-8);
    assert.equal(c.faces.faceFromQuat({x:-mount.x,y:0,z:0,w:mount.w},table),1);
    assert.doesNotThrow(()=>c.faces.bodyFromDie({...F,1:F[6],6:F[1]}));
    assert.throws(()=>c.faces.bodyFromDie({...F,2:F[1],5:F[6]}));
});
test('calibration puts all six rendered faces up for arbitrary mounting and either numbering handedness',()=>{
    // Actual BoxGeometry face labels before DiceScene's fixed 180-degree Y rotation.
    const meshNormals={1:{x:0,y:1,z:0},2:{x:0,y:0,z:1},3:{x:1,y:0,z:0},
        4:{x:-1,y:0,z:0},5:{x:0,y:0,z:-1},6:{x:0,y:-1,z:0}};
    const mount=c.math.normalize({x:.23,y:-.47,z:.31,w:.79});
    const inverseMount={x:-mount.x,y:-mount.y,z:-mount.z,w:mount.w};
    const fixedY={x:0,y:1,z:0,w:0};
    const toUp=v=>{
        if(v.z < -.999999) return {x:1,y:0,z:0,w:0};
        return c.math.normalize({x:v.y,y:-v.x,z:0,w:1+v.z});
    };
    for(const mirrored of [false,true]) {
        const dieFaces=mirrored?{...F,1:F[6],6:F[1]}:F;
        const table=Object.fromEntries(Object.entries(dieFaces).map(([f,v])=>{
            const r=c.math.rotate(mount,{x:v[0],y:v[1],z:v[2]});return [f,[r.x,r.y,r.z]];
        }));
        assert.equal(c.faces.isMirroredTable(table),mirrored);
        for(let f=1;f<=6;f++) {
            const [x,y,z]=dieFaces[f], yaw=.37+f*.23;
            const dieOrientation=c.math.multiply({x:0,y:0,z:Math.sin(yaw/2),w:Math.cos(yaw/2)},toUp({x,y,z}));
            const sensor=c.math.multiply(dieOrientation,inverseMount);
            assert.equal(c.faces.faceFromQuat(sensor,table),f);
            // Non-unit incoming packets still produce a normalized display quaternion.
            const q=c.faces.displayOrientation(Object.fromEntries(Object.entries(sensor).map(([k,v])=>[k,v*3])),table);
            assert.ok(Math.abs(Math.hypot(q.x,q.y,q.z,q.w)-1)<1e-12);
            const three={x:q.x,y:q.z,z:-q.y,w:q.w};
            const materialFace=mirrored&&(f===1||f===6)?7-f:f;
            const normal=c.math.rotate(three,c.math.rotate(fixedY,meshNormals[materialFace]));
            assert.ok(Math.hypot(normal.x,normal.y-1,normal.z)<1e-10,`mirrored=${mirrored}, face=${f}`);
        }
    }
});
test('display calibration rejects malformed or geometrically invalid face tables',()=>{
    for(const invalid of [{...F,1:[NaN,0,1]},{...F,2:F[1],5:F[6]}]) {
        assert.throws(()=>c.faces.displayOrientation(identity,invalid));
        assert.throws(()=>c.faces.isMirroredTable(invalid));
    }
    assert.throws(()=>c.faces.displayOrientation({x:0,y:0,z:0,w:0},F));
});
test('training excludes unverified, uncalibrated, saturated, synthetic and other-surface records',()=>{
    const records=[record(),record({id:'u',labelVerified:false}),record({id:'c',calibrated:false}),
        record({id:'s',impact:{...impact,gyroSat:1}}),record({id:'fake',source:'synthetic'}),record({id:'other',profile:'other'})];
    const [e]=c.record.trainingExamples(records,'surface');
    assert.equal(c.record.trainingExamples(records,'surface').length,1);
    assert.deepEqual(Object.keys(e).sort(),['actualFace','faces','id','impact']); // no landing/stream leakage
    assert.doesNotThrow(()=>c.record.checkedRecord(record()));
    assert.throws(()=>c.record.checkedRecord(record({impact:{...impact,preT:1001}})));
    assert.throws(()=>c.model.checkedParams({...P,sizeM:.015,cornerR:.008}));
});
test('REINFORCE improves a known synthetic reward; held-out test is opened only after selection',async()=>{
    const examples=corpus(),testIds=new Set(examples.filter(e=>c.learning.partition(e.id)==='test').map(e=>e.id));
    let iterations=0,testCalls=0;
    const sim=(e,p)=>{
        if(testIds.has(e.id)) {assert.equal(iterations,35);testCalls++;}
        const prob=.05+.9/(1+Math.exp(-10*(p.friction-.7)));
        return [prob,...Array(5).fill((1-prob)/5)];
    };
    const result=await c.learning.train(examples,P,()=>iterations++,{iterations:35},sim);
    assert.equal(result.report.accepted,true);
    assert.ok(result.params.friction>P.friction);
    assert.ok(result.report.validationAfter.nll<result.report.validationBefore.nll);
    assert.equal(testCalls,32);
    assert.deepEqual(result.report.counts,{train:16,validation:16,test:16});
    assert.equal(c.learning.partition(examples[0].id),c.learning.partition(examples[0].id));
});
test('learning rejects insufficient/duplicate data and retains a model without validation improvement',async()=>{
    await assert.rejects(c.learning.train([],P),/増やして/);
    const examples=corpus();
    await assert.rejects(c.learning.train([...examples,examples[0]],P),/重複/);
    await assert.rejects(c.learning.train(examples,P,()=>{},{iterations:NaN}),/範囲外/);
    const result=await c.learning.train(examples,P,()=>{},{iterations:1},()=>Array(6).fill(1/6));
    assert.equal(result.report.accepted,false);assert.deepEqual(result.params,P);
});
test('real Rapier replay is deterministic, calibrated, and returns a normalized uncertainty distribution',async()=>{
    await c.physics.initPhysics();
    const p={...P,restitutionJitter:0,frictionJitter:0,velJitter:0,velNoise:0,omegaJitter:0,omegaNoise:0};
    const a=c.physics.simulate(impact,F,p,8,42),b=c.physics.simulate(impact,F,p,8,42);
    assert.deepEqual(a.dist,b.dist);assert.equal(a.face,1);assert.equal(a.resolvedRollouts,8);
    assert.ok(Math.abs(a.dist.reduce((x,y)=>x+y,0)-1)<1e-12);assert.ok(a.probability<1);
    const mount={x:Math.sin(.3),y:0,z:0,w:Math.cos(.3)};
    const table=Object.fromEntries(Object.entries(F).map(([f,v])=>{
        const r=c.math.rotate(mount,{x:v[0],y:v[1],z:v[2]});return [f,[r.x,r.y,r.z]];
    }));
    const calibrated=c.physics.simulate({...impact,q:{x:-mount.x,y:0,z:0,w:mount.w}},table,p,8,42);
    assert.equal(calibrated.face,1);assert.deepEqual(calibrated.dist,a.dist);
    assert.throws(()=>c.physics.simulate(impact,F,p,0),/範囲外/);
    const unknown=c.physics.simulate({...impact,preT:impact.t,v:{x:0,y:0,z:-50}},F,{...p,restitution:.9},1,42);
    assert.equal(unknown.face,null);assert.equal(unknown.resolvedRollouts,0);
    assert.ok(unknown.dist.every(v=>Math.abs(v-1/6)<1e-12));
    assert.equal(c.learning.metrics([{id:'unknown',actualFace:1,impact,faces:F}],p,1,()=>unknown.dist).accuracy,0);
});
test('REINFORCE also runs against the actual physics core (synthetic smoke, no accuracy claim)',async()=>{
    await c.physics.initPhysics();
    const result=await c.learning.train(corpus(),P,()=>{},{iterations:1,batchSize:1,actionPairs:1,trainRollouts:1,evaluationRollouts:1});
    assert.equal(result.report.algorithm,'reinforce-physics-v1');
    assert.equal(result.report.testAfter.count,16);
    assert.equal(result.report.accepted,false);
});

test('model import rejects synthetic models and mismatched profiles',()=>{
    const profile='["surface",0.015,0.0008]';
    const model={modelSchema:1,engine:c.model.MODEL_ENGINE,profile,source:'untrained',version:'initial',params:P,trainedRecords:0,report:null};
    assert.deepEqual(c.model.checkedModel(model,profile).params,P);
    assert.throws(()=>c.model.checkedModel({...model,source:'synthetic'},profile));
    assert.throws(()=>c.model.checkedModel(model,'other surface'));
    assert.throws(()=>c.model.checkedModel({...model,source:'physical',version:'trained',trainedRecords:40},profile));
    assert.throws(()=>c.model.checkedModel({...model,params:null},profile));
});
