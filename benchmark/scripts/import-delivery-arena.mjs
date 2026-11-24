import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {inspectArenaDelivery} from '../server/arena_delivery.mjs';
import {validateArenaSnapshot} from '../server/benchmark_arena.mjs';
import {activeSamplingPolicy} from '../server/arena_active_sampling.mjs';
import {requirementsHash} from '../server/arena_requirements.mjs';
const opts={};for(let i=2;i<process.argv.length;i+=2)opts[process.argv[i].slice(2)]=process.argv[i+1];
if(!opts.source||!opts.output)throw Error('Use --source DELIVERY --output NEW_DIRECTORY --exclude-models IDs --expected-cases N --expected-models N --python PYTHON');
const source=path.resolve(opts.source),output=path.resolve(opts.output),staging=output+'.staging';
if(fs.existsSync(output)||fs.existsSync(staging))throw Error('Never overwrite a frozen or unfinished import');
const data=inspectArenaDelivery(source,{excludeModelIds:(opts['exclude-models']||'').split(',').filter(Boolean),expectedCases:Number(opts['expected-cases']),expectedModels:Number(opts['expected-models'])});
if(opts.name!==undefined){if(!opts.name.trim()||opts.name.length>120)throw Error('Use a nonempty cohort name of at most 120 characters');data.snapshot.name=opts.name;}
const result=spawnSync(opts.python||'python3',['-c','import json,sys\nfrom PIL import Image\nfor p in json.load(sys.stdin):\n with Image.open(p) as im: im.load()'],{input:JSON.stringify(data.imageFiles.map(i=>i.source)),encoding:'utf8',timeout:120000,maxBuffer:2000000});
if(result.status!==0)throw Error('Delivery PNG decode failed; nothing imported');
fs.mkdirSync(staging,{recursive:true,mode:0o700});
for(const im of data.imageFiles){const file=path.join(staging,im.file);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.copyFileSync(im.source,file,fs.constants.COPYFILE_EXCL);fs.chmodSync(file,0o600);}
const write=(file,value)=>fs.writeFileSync(path.join(staging,file),JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
write('snapshot.json',data.snapshot);
fs.copyFileSync(path.join(source,'manifest.json'),path.join(staging,'source-manifest.json'),fs.constants.COPYFILE_EXCL);fs.chmodSync(path.join(staging,'source-manifest.json'),0o600);
fs.mkdirSync(path.join(staging,'requirements-source'),{mode:0o700});
for(const req of data.requirements)write(`requirements-source/${req.case_id}.json`,req);
write('requirements-index.json',{kind:'delivery-requirements-index/v1',cases:data.requirements.map(r=>({case_id:r.case_id,source_url:r.source_url,source_sha256:r.source_sha256,required_frames:r.required_frames}))});
write('sampling-policy.json',activeSamplingPolicy(requirementsHash(data.snapshot)));
validateArenaSnapshot(data.snapshot,staging);
write('import-receipt.json',{source,manifest_sha256:data.snapshot.external_delivery.manifest_sha256,cases:data.requirements.length,models:data.snapshot.external_delivery.model_ids.length,
  candidates:data.candidates.length,images:data.imageFiles.length,zero_scores:data.candidates.filter(c=>c.cc_score===0).length,review_mode:'screenshots-only',model_calls:0,mcp_calls:0,judge_calls:0,trace_verified:false,screen_completeness_certified:false});
fs.renameSync(staging,output);
console.log(JSON.stringify({output,cases:data.requirements.length,models:data.snapshot.external_delivery.model_ids.length,candidates:data.candidates.length,images:data.imageFiles.length}));
