import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {getScaleMethod} from '../server/fixed_scales/index.mjs';
import {repeatedCandidateVersion,readArenaJudgeScores} from '../server/arena_judge_scores.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function exportHarnessScores({arena,batch,config,output}){
 if(fs.existsSync(output))throw Error('Use a fresh score export directory');
 const raw=fs.readFileSync(path.join(arena,'snapshot.json')),snapshot=JSON.parse(raw);
 const manifest=JSON.parse(fs.readFileSync(path.join(batch,'manifest.json')));
 const frozenConfig=path.join(batch,'config.json'),configRaw=fs.readFileSync(frozenConfig),settings=JSON.parse(configRaw);
 const protocol='figmaeval-cvpr2027/v1',seeds=[42,102,423];
 if(manifest.protocol!==protocol||manifest.framework!=='claude-code'||manifest.mode!=='judge'
   ||manifest.configuration_sha256!==sha(configRaw)||settings.protocol!==protocol
   ||manifest.rubric_sha256!==sha(fs.readFileSync(new URL('../benchmarks/rubrics/fixed-v4.json',import.meta.url))))throw Error('Batch configuration or framework mismatch');
 if(config){const supplied=sha(fs.readFileSync(config));if(supplied!==manifest.configuration_sha256&&supplied!==manifest.source_configuration_sha256)throw Error('Supplied configuration differs from the frozen batch');}
 if(settings.repetitions!==3||settings.judges.length!==3||settings.gate_policy!=='required'
   ||JSON.stringify(settings.seeds)!==JSON.stringify(seeds)||new Set(settings.judges.map(j=>j.id)).size!==3)throw Error('Arena bridge requires three seeded judges and the paper G0 policy');
 const results=JSON.parse(fs.readFileSync(path.join(batch,'results.json'))),questions=getScaleMethod('fixed_v4').questions;
 const rows=snapshot.candidates.map(c=>{
  const artifact=settings.artifacts.find(a=>a.id===c.id),judges={};
  if(artifact)for(const judge of settings.judges){
   const selected=results.filter(r=>r.id===c.id&&r.judge_id===judge.id&&r.status==='completed');
   if(!selected.length)continue;
   if(selected.length!==3)continue;
   if(new Set(selected.map(r=>r.repeat)).size!==3||selected.some(r=>![1,2,3].includes(r.repeat)))throw Error('Duplicate or invalid repetition');
   for(const r of selected){
    if(r.framework!=='claude-code'||r.method!=='fixed_v4'||r.gate_policy!==settings.gate_policy
      ||r.seed!==seeds[r.repeat-1]||r.seed_forwarded!==true||!artifact.input_sha256||r.input_sha256!==artifact.input_sha256
      ||typeof r.g0_pass!=='boolean'||r.images_read!==c.images.length
      ||r.max_score!==53||JSON.stringify(r.image_sha256)!==JSON.stringify(c.images.map(i=>i.sha256))
      ||!r.values||Object.keys(r.values).length!==questions.length
      ||questions.some(q=>!Number.isInteger(r.values[q.key])||r.values[q.key]<0||r.values[q.key]>(q.max??2))
      ||r.score_total!==(settings.gate_policy==='required'&&!r.g0_pass?0:questions.reduce((s,q)=>s+r.values[q.key],0)))throw Error('Score rubric or screenshot revision differs');
   }
   judges[judge.id]={repetitions:selected.sort((a,b)=>a.repeat-b.repeat).map(r=>r.score_total),gate_policy:settings.gate_policy};
  }
  return{candidate_id:c.id,case_id:c.case_id,model_id:c.model_id,run_id:c.run_id,version_sha256:repeatedCandidateVersion(c),judges};
 });
 if(settings.artifacts.some(a=>!snapshot.candidates.some(c=>c.id===a.id)))throw Error('Unknown artifact ID for frozen Arena');
 const data=Buffer.from(JSON.stringify({rows},null,2));
 const campaign={kind:'arena-repeated-multijudge/v1',framework:'claude-code',method:'fixed_v4',max_score:53,repeats:3,
  protocol,seeds,judges:settings.judges.map(j=>({id:j.id,name:j.name||j.cli_model})),candidates:snapshot.candidates.length,
  source_snapshot_sha256:sha(raw),data_sha256:sha(data),updated_at:new Date().toISOString()};
 fs.mkdirSync(output,{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(output,'repeated-scores.json'),data,{flag:'wx',mode:0o600});
 fs.writeFileSync(path.join(output,'campaign.json'),JSON.stringify(campaign,null,2),{flag:'wx',mode:0o600});
 return readArenaJudgeScores(arena,output);
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 const opts={};for(let i=2;i<process.argv.length;i+=2)opts[process.argv[i].slice(2)]=process.argv[i+1];
 for(const key of ['arena','batch','output'])if(!opts[key])throw Error(`Missing --${key}`);else opts[key]=path.resolve(opts[key]);
 if(opts.config)opts.config=path.resolve(opts.config);
 const result=exportHarnessScores(opts);console.log(JSON.stringify({candidates:result.candidates,judges:result.judges.map(j=>({id:j.id,complete:j.complete}))}));
}
