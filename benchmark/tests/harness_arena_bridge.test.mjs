import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createDemo} from '../scripts/arena-demo.mjs';
import {exportHarnessScores} from '../scripts/export-harness-arena-scores.mjs';
import {getScaleMethod} from '../server/fixed_scales/index.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
test('harness scores bind exact screenshot revisions; incomplete judges remain missing',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'harness-arena-'));
 try{
  const arena=path.join(root,'arena'),batch=path.join(root,'batch'),config=path.join(root,'config.json');
  createDemo(arena);fs.mkdirSync(batch);
  const snapshot=JSON.parse(fs.readFileSync(path.join(arena,'snapshot.json'))),judges=[{id:'judge-a',name:'Judge A'},{id:'judge-b',name:'Judge B'},{id:'judge-c',name:'Judge C'}];
  const settings={protocol:'figmaeval-cvpr2027/v1',seeds:[42,102,423],repetitions:3,gate_policy:'required',judges,artifacts:snapshot.candidates.map(c=>({id:c.id,input_sha256:'synthetic-'+c.id}))};
  fs.writeFileSync(config,JSON.stringify(settings));
  fs.copyFileSync(config,path.join(batch,'config.json'));
  fs.writeFileSync(path.join(batch,'manifest.json'),JSON.stringify({protocol:settings.protocol,framework:'claude-code',mode:'judge',configuration_sha256:sha(fs.readFileSync(config)),rubric_sha256:sha(fs.readFileSync(new URL('../benchmarks/rubrics/fixed-v4.json',import.meta.url)))}));
  const results=snapshot.candidates.flatMap(c=>judges.flatMap(j=>[1,2,3].map(repeat=>({id:c.id,judge_id:j.id,repeat,seed:settings.seeds[repeat-1],seed_forwarded:true,input_sha256:'synthetic-'+c.id,images_read:c.images.length,g0_pass:true,status:'completed',framework:'claude-code',method:'fixed_v4',gate_policy:'required',max_score:53,score_total:0,values:Object.fromEntries(getScaleMethod('fixed_v4').questions.map(q=>[q.key,0])),image_sha256:c.images.map(i=>i.sha256)}))));
  results.pop();fs.writeFileSync(path.join(batch,'results.json'),JSON.stringify(results));
  const data=exportHarnessScores({arena,batch,config,output:path.join(root,'export')});
  assert.equal(data.judges[0].scored_count,3);assert.equal(data.judges[2].scored_count,2);
  assert.equal(data.rows[0].scores['judge-a'],0);
  results[0].seed=1;fs.writeFileSync(path.join(batch,'results.json'),JSON.stringify(results));
  assert.throws(()=>exportHarnessScores({arena,batch,config,output:path.join(root,'wrong-seed')}),/revision differs/);
  results[0].seed=42;
  results[0].image_sha256=['0'.repeat(64)];fs.writeFileSync(path.join(batch,'results.json'),JSON.stringify(results));
  assert.throws(()=>exportHarnessScores({arena,batch,config,output:path.join(root,'bad')}),/revision differs/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
