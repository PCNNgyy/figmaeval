import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CAPTURED_DELIVERY_KIND,capturedHash as hash} from '../server/arena_captured_delivery.mjs';
import {validateArenaSnapshot,createArenaStore} from '../server/benchmark_arena.mjs';
import {tournamentProtocol} from '../server/arena_tournament.mjs';

function fixture(t,modelCount=8,taskCount=13){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'captured-review-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'),items=[];
 for(let i=0;i<taskCount;i++)for(let j=0;j<modelCount;j++){
  const id=hash([i,j]).slice(0,24),file=`media/${id}/0.png`;fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});fs.writeFileSync(path.join(dir,file),png);
  const c={id,case_id:'case'+i,title:'Task '+i,source_url:`https://www.figma.com/design/Copy${i}m0`,source_query:'Read the original 00/01 pages',
   model_id:'model'+j,model_name:'Model '+j,run_id:`run${i}-${j}`,workspace_url:`https://www.figma.com/design/Copy${i}m${j}?page-id=3%3A2&node-id=3-2`,workspace_id:'3:2',
   trace_status:'native-capture-available',generation_ended:true,finished_at:'2026-11-11T00:00:00Z',screen_check:{passed:j!==1,expected:j===1?2:1,actual:1},
   evidence_status:'cached-complete',images:[{file,sha256:hash(png),width:1,height:1,node_id:'4:1'}],cc_score:j===0?null:0,cc_score_id:j===0?null:'score'+j,cc_g0_pass:j===0?null:false};
  items.push({candidate:c,frames:[{node_id:'4:1',sha256:hash(png)}]});
 }
 const manifest={kind:CAPTURED_DELIVERY_KIND,plan_hash:'p'.repeat(64),...(taskCount!==13?{task_count:taskCount}:{}),items},text=JSON.stringify(manifest);fs.writeFileSync(path.join(dir,'source-manifest.json'),text);
 const snapshot={kind:'figma-human-arena-snapshot',version:3,name:'Captured 13x8',protocol:tournamentProtocol(),review_mode:'screenshots-only',
  captured_delivery:{kind:CAPTURED_DELIVERY_KIND,plan_hash:manifest.plan_hash,manifest_sha256:hash(text),...(taskCount!==13?{task_count:taskCount}:{}),model_ids:Array.from({length:modelCount},(_,j)=>'model'+j)},
  candidates:items.map(i=>({...i.candidate,delivery_row_sha256:hash(i.candidate)}))};
 return{dir,snapshot};
}
test('native review includes every model, genuine zero scores, absent automatic scores and screen-count failures',t=>{
 const {dir,snapshot}=fixture(t);assert.equal(validateArenaSnapshot(snapshot,dir),snapshot);
 assert.equal(snapshot.candidates.length,104);assert.equal(snapshot.candidates.filter(c=>c.cc_score===null).length,13);
 assert.equal(snapshot.candidates.filter(c=>!c.screen_check.passed).length,13);
});
test('frozen captured evidence rejects changing outputs, judgement status, images, models or the matrix',t=>{
 const {dir,snapshot}=fixture(t);
 for(const mutate of [s=>s.candidates.pop(),s=>{s.candidates[0].cc_score=0;},s=>{s.candidates[1].screen_check.passed=true;},
  s=>{s.candidates[0].trace_status='verified';},s=>{s.candidates[0].images[0].sha256='0'.repeat(64);},s=>s.captured_delivery.model_ids.pop()]){
  const changed=structuredClone(snapshot);mutate(changed);assert.throws(()=>validateArenaSnapshot(changed,dir));
 }
 fs.appendFileSync(path.join(dir,'source-manifest.json'),' ');assert.throws(()=>validateArenaSnapshot(snapshot,dir),/manifest changed/);
});
test('reviewer payload omits links to model-owned input/output copies and never exposes model names',t=>{
 const {dir,snapshot}=fixture(t),store=createArenaStore(dir,snapshot,{openRegistration:true});
 try{
  const reviewer=store.accounts.enroll({name:'匿名评审',profile_secret:'a'.repeat(48)});store.refreshReviewers();
  const pair=store.next(reviewer.id).pair,text=JSON.stringify(pair);
  assert.equal(pair.source_url,null);assert.ok(Object.values(pair.drafts).every(d=>d.url===null));
  assert.ok(!text.includes('https://www.figma.com/design/'));
  for(const c of snapshot.candidates)assert.ok(!text.includes(c.model_name));
 }finally{store.close();}
});

test('ten-model expansion retains a complete 13-by-10 matrix and rejects missing newly added cells',t=>{
 const {dir,snapshot}=fixture(t,10);assert.equal(validateArenaSnapshot(snapshot,dir),snapshot);assert.equal(snapshot.candidates.length,130);const changed=structuredClone(snapshot);changed.candidates.pop();assert.throws(()=>validateArenaSnapshot(changed,dir));
});

test('new twenty-task cohort binds its size and rejects missing cases or a changed declared count',t=>{
 const {dir,snapshot}=fixture(t,10,20);assert.equal(validateArenaSnapshot(snapshot,dir),snapshot);
 assert.equal(snapshot.candidates.length,200);
 for(const mutate of [s=>s.candidates.splice(0,10),s=>{s.captured_delivery.task_count=13;},s=>{delete s.captured_delivery.task_count;}]){
  const changed=structuredClone(snapshot);mutate(changed);assert.throws(()=>validateArenaSnapshot(changed,dir));
 }
});

test('a later product-content failure cannot be overridden by the old captured-delivery passed flags',t=>{
 const {dir,snapshot}=fixture(t);validateArenaSnapshot(snapshot,dir);
 fs.writeFileSync(path.join(dir,'screen-content-check.json'),JSON.stringify({kind:'arena-product-content-acceptance/v1',rule:'blank-screen-pixels/v2',status:'failed',candidates:104,blank_images:10,results:[]}));
 assert.throws(()=>validateArenaSnapshot(snapshot,dir),/content acceptance failed/);
});

test('the framework accepts a declared synthetic cohort without fixed production task or model counts',t=>{
 const {dir,snapshot}=fixture(t,4,4);
 assert.equal(validateArenaSnapshot(snapshot,dir),snapshot);
 assert.equal(snapshot.candidates.length,16);
 const changed=structuredClone(snapshot);changed.captured_delivery.task_count=5;
 assert.throws(()=>validateArenaSnapshot(changed,dir),/task count/);
});
