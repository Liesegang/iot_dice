import {readFile,writeFile} from 'node:fs/promises';
import {loadCore} from './load-core.mjs';
const args=process.argv.slice(2),options={};
const usage='npm run train -- --input dice-throws-v2-….json --output dice-model-v2.json [--profile surface-name] [--initial dice-model-v2.json] [--iterations 12]';
for(let i=0;i<args.length;i+=2) {
    if(!['--input','--output','--profile','--initial','--iterations'].includes(args[i])||!args[i+1]) throw new Error(usage);
    options[args[i].slice(2)]=args[i+1];
}
if(!options.input||!options.output) {console.error(usage);process.exit(2);}
const core=await loadCore();
try {
    const raw=JSON.parse(await readFile(options.input,'utf8'));
    const records=(Array.isArray(raw)?raw:raw.records)?.map(core.record.checkedRecord);
    if(!records || records.length>10000) throw new Error('v2の実機投擲記録を指定してください');
    const profiles=[...new Set(records.filter(r=>r.source==='physical').map(r=>r.profile))];
    const candidates=options.profile?profiles.filter(p=>p===options.profile||JSON.parse(p)[0]===options.profile):profiles;
    const profile=candidates.length===1?candidates[0]:null;
    if(!profile) throw new Error(`学習対象の面を --profile で指定してください。候補: ${profiles.join(', ')||'実機記録なし'}`);
    const [,sizeM,cornerR]=JSON.parse(profile);
    let initial=core.model.checkedParams({...core.model.DEFAULT_PARAMS,sizeM,cornerR});
    let incumbent={modelSchema:1,engine:core.model.MODEL_ENGINE,profile,version:'initial',source:'untrained',params:initial,trainedRecords:0,report:null};
    if(options.initial) {
        incumbent=core.model.checkedModel(JSON.parse(await readFile(options.initial,'utf8')),profile);initial=incumbent.params;
        if(initial.sizeM!==sizeM||initial.cornerR!==cornerR) throw new Error('初期モデルの外寸が違います');
    }
    const examples=core.record.trainingExamples(records,profile);
    console.log(`実機・正解確認済み ${examples.length}投 / ${profile}`);
    await core.physics.initPhysics();
    const result=await core.learning.train(examples,initial,p=>console.log(`${p.iteration}/${p.iterations}: 検証的中率 ${(p.validation.accuracy*100).toFixed(1)}%, NLL ${p.validation.nll.toFixed(3)}`),
        {iterations:options.iterations===undefined?12:Number(options.iterations)});
    const model=result.report.accepted?{modelSchema:1,engine:core.model.MODEL_ENGINE,profile,
        version:`rl-${new Date().toISOString()}`,source:'physical',params:result.params,
        trainedRecords:examples.length,report:result.report}:{...incumbent,lastTrainingReport:result.report};
    await writeFile(options.output,JSON.stringify(model,null,2));
    console.log(JSON.stringify(result.report,null,2));
} catch(error) {console.error(error.message);process.exitCode=1;}
finally {await core.cleanup();}
