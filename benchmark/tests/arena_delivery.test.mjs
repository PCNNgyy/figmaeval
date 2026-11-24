import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {inspectArenaDelivery,normalizeDeliveryRequirements,frozenDeliveryLeaderboard} from '../server/arena_delivery.mjs';
import {createArenaStore,createArenaApp,validateArenaSnapshot} from '../server/benchmark_arena.mjs';
import {activeSamplingPolicy} from '../server/arena_active_sampling.mjs';
import {requirementsHash,requirementTexts} from '../server/arena_requirements.mjs';

function fixture(t){
  const source=fs.mkdtempSync(path.join(os.tmpdir(),'arena-delivery-')),output=path.join(source,'frozen');
  t.after(()=>fs.rmSync(source,{recursive:true,force:true}));fs.mkdirSync(path.join(source,'requirements/raw'),{recursive:true});
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=','base64'),hash=createHash('sha256').update(png).digest('hex');fs.writeFileSync(path.join(source,'image.png'),png);
  const models=Array.from({length:7},(_,i)=>({model_id:`model${i}`,name:`SECRET_MODEL_${i}`})),cases=[],items=[];
  for(const round of ['mobile','web']){
    const sourceUrl=`https://www.figma.com/design/source${round}/`,task={round,case_id:'case-001',title:round,source_figma_url:sourceUrl,source_file_key:`source${round}`,source_query:`在 ${sourceUrl} 完成任务`};cases.push(task);
    const raw={file_key:task.source_file_key,pages:[{page_id:'0:1',page_name:'00 · Start Here',texts:[{id:'1:1',x:64,y:0,text:'Design a mobile application.'},{id:'1:2',x:88,y:100,text:'01_Home'},{id:'1:3',x:88,y:130,text:'Goal: Read account details.'}]},
      {page_id:'0:2',page_name:'01 · Foundations',texts:[{id:'2:1',x:64,y:0,text:'Use blue.'}]}]};fs.writeFileSync(path.join(source,`requirements/raw/${task.source_file_key}.json`),JSON.stringify(raw));
    for(const m of models){const score=m.model_id==='model0'?0:22;items.push({round,case_id:task.case_id,title:round,source_figma_url:sourceUrl,model_id:m.model_id,model_name:m.name,
      copy_file_key:`copy${round}${m.model_id}`,copy_figma_url:`https://www.figma.com/design/copy${round}${m.model_id}/`,workspace_page_id:'3:1',workspace_page_name:'03 · Workspace',run_id:`${round}-${m.model_id}`,finished_at:'2026-11-03T01:00:00Z',
      rubric:'fixed_v4',judge_model_id:'model_claude_opus55_direct',score_max:53,score_total:score,score_id:`score-${round}-${m.model_id}`,g0_pass:score>0,items:Object.fromEntries(Array.from({length:22},(_,i)=>[`item${i}`,score?1:0])),
      frame_count:1,frames:[{file:'image.png',sha256:hash,width:1,height:1,node_id:'4:1'}]});}
  }
  const manifest={meta:{cases,models,judge:'Opus 5.5',generated_at:'2026-11-03T02:00:00Z',selection_rule:'last scored result'},items};
  const save=()=>fs.writeFileSync(path.join(source,'manifest.json'),JSON.stringify(manifest));save();
  const inspect=()=>inspectArenaDelivery(source,{excludeModelIds:['model6'],expectedCases:2,expectedModels:6});
  const freeze=()=>{const data=inspect();fs.mkdirSync(output);for(const im of data.imageFiles){const f=path.join(output,im.file);fs.mkdirSync(path.dirname(f),{recursive:true});fs.copyFileSync(im.source,f);}fs.writeFileSync(path.join(output,'source-manifest.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(output,'sampling-policy.json'),JSON.stringify(activeSamplingPolicy(requirementsHash(data.snapshot))));return data;};
  return{source,output,manifest,inspect,save,freeze};
}
test('delivery excludes requested model, namespaces repeated case IDs and retains genuine zero scores',t=>{
  const f=fixture(t),data=f.freeze();validateArenaSnapshot(data.snapshot,f.output);
  assert.equal(data.candidates.length,12);assert.deepEqual([...new Set(data.candidates.map(c=>c.case_id))],['mobile-case-001','web-case-001']);
  assert.equal(data.candidates.filter(c=>c.cc_score===0).length,2);assert.ok(data.candidates.every(c=>c.trace_status==='not-delivered'&&c.screen_check.passed===null));
  const board=frozenDeliveryLeaderboard(data.snapshot,{includeCoverage:true});assert.equal(board.complete,true);assert.equal(board.scored_count,12);assert.equal(board.rows.at(-1).mean_score,0);
});
test('CLI preserves original manifest bytes including whitespace and never overwrites a cohort',t=>{
  const f=fixture(t),original=Buffer.from(' \n'+JSON.stringify(f.manifest,null,1)+'\n');fs.writeFileSync(path.join(f.source,'manifest.json'),original);
  const args=['scripts/import-delivery-arena.mjs','--source',f.source,'--output',f.output,'--exclude-models','model6','--expected-cases','2','--expected-models','6','--python','python3','--name','Named immutable rerun cohort'];
  const r=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  assert.deepEqual(fs.readFileSync(path.join(f.output,'source-manifest.json')),original);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.output,'snapshot.json'))).name,'Named immutable rerun cohort');
  const snapshot=fs.readFileSync(path.join(f.output,'snapshot.json'));const duplicate=spawnSync(process.execPath,args,{encoding:'utf8'});assert.notEqual(duplicate.status,0);
  assert.deepEqual(fs.readFileSync(path.join(f.output,'snapshot.json')),snapshot);
});
test('rejects missing cells, reused copies, altered scores, changed PNGs and paths outside delivery',t=>{
  const f=fixture(t),original=structuredClone(f.manifest);
  for(const mutate of [m=>m.items.shift(),m=>{m.items[1].copy_figma_url=m.items[0].copy_figma_url;},m=>{m.items[1].score_total++;},m=>{m.items[1].frames[0].sha256='0'.repeat(64);},m=>{m.items[1].frames[0].file='../outside.png';}]){
    Object.assign(f.manifest,structuredClone(original));mutate(f.manifest);f.save();assert.throws(f.inspect);
  }
});
test('frozen external provenance cannot claim verified traces, alter score/run or remove a result',t=>{
  const f=fixture(t),data=f.freeze();
  for(const mutate of [s=>{s.candidates[0].trace_status='verified';},s=>{s.candidates[0].cc_score=50;},s=>{s.candidates[0].run_id='other-run';},s=>s.candidates.pop()]){
    const changed=structuredClone(data.snapshot);mutate(changed);assert.throws(()=>validateArenaSnapshot(changed,f.output));
  }
  fs.appendFileSync(path.join(f.output,'source-manifest.json'),' ');assert.throws(()=>validateArenaSnapshot(data.snapshot,f.output),/manifest changed/);
});
test('native revisions in a legacy cohort require bound capture, acceptance and score evidence without changing legacy candidates',t=>{
  const f=fixture(t),data=f.freeze(),candidate=data.snapshot.candidates[0];
  const proof={kind:'arena-native-delivery-revision/v1',previous_candidate_id:'b'.repeat(24),task_id:'retry-one',
    ...Object.fromEntries(['plan_hash','input_sha256','capture_receipt_sha256','screen_check_sha256','blank_check_sha256','trace_audit_sha256','acceptance_sha256'].map(k=>[k,'a'.repeat(64)]))};
  candidate.native_revision=proof;candidate.trace_status='native-capture-available';candidate.screen_check={status:'native-required-screens-verified',passed:true,expected:1,actual:1,white_screen_check_passed:true};
  assert.throws(()=>validateArenaSnapshot(data.snapshot,f.output),'a native candidate cannot borrow the old manifest row');
  f.manifest.items[0].native_revision=proof;
  const manifestText=JSON.stringify(f.manifest);fs.writeFileSync(path.join(f.output,'source-manifest.json'),manifestText);
  candidate.delivery_row_sha256=createHash('sha256').update(JSON.stringify(f.manifest.items[0])).digest('hex');data.snapshot.external_delivery.manifest_sha256=createHash('sha256').update(manifestText).digest('hex');
  validateArenaSnapshot(data.snapshot,f.output);
  for(const mutate of [c=>{delete c.native_revision.blank_check_sha256;},c=>{c.screen_check.actual=2;},c=>{c.screen_check.white_screen_check_passed=false;},c=>{c.cc_score=null;},c=>{c.native_revision.previous_candidate_id=c.id;}]){
    const copy=structuredClone(data.snapshot);mutate(copy.candidates[0]);assert.throws(()=>validateArenaSnapshot(copy,f.output));
  }
  assert.equal(data.snapshot.candidates[1].trace_status,'not-delivered');
  candidate.cc_score=null;candidate.cc_score_id=null;candidate.cc_g0_pass=null;
  Object.assign(f.manifest.items[0],{score_total:null,score_id:null,g0_pass:null});
  const pending=JSON.stringify(f.manifest);fs.writeFileSync(path.join(f.output,'source-manifest.json'),pending);
  candidate.delivery_row_sha256=createHash('sha256').update(JSON.stringify(f.manifest.items[0])).digest('hex');data.snapshot.external_delivery.manifest_sha256=createHash('sha256').update(pending).digest('hex');
  validateArenaSnapshot(data.snapshot,f.output);
  const board=frozenDeliveryLeaderboard(data.snapshot,{includeCoverage:true});assert.equal(board.complete,false);assert.equal(board.scored_count,11);
  const model=board.rows.find(r=>r.model_name===candidate.model_name);assert.equal(model.scored_count,1);assert.equal(model.mean_score,0,'a pending score is excluded; the genuine zero remains included');
});
test('coordinate extraction keeps adjacent screen requirements separate without dropping text',()=>{
  const texts=[{id:'intro',x:64,y:0,text:'Do all frames.'},{id:'a',x:88,y:100,text:'01_Home'},{id:'b',x:520,y:100,text:'02_Profile'},
    {id:'ga',x:88,y:130,text:'Goal: Home.'},{id:'gb',x:520,y:130,text:'Goal: Profile.'},{id:'fixed',x:64,y:200,text:'Fixed data'},{id:'data',x:88,y:230,text:'Amount 10'}];
  const raw={file_key:'source',pages:[{page_id:'0:1',page_name:'00 · Start Here',texts},{page_id:'0:2',page_name:'01 · Foundations',texts:[{id:'font',x:64,y:0,text:'Use Inter.'}]}]};
  const r=normalizeDeliveryRequirements(raw,{case_id:'a',title:'A',source_url:'https://www.figma.com/design/source/'}),sections=r.pages[0].sections;
  assert.deepEqual(requirementTexts(sections.find(s=>s.name==='01_Home')).map(t=>t.id),['a','ga']);
  assert.deepEqual(requirementTexts(sections.find(s=>s.name==='02_Profile')).map(t=>t.id),['b','gb']);
  assert.equal(requirementTexts(r.pages).length,8);assert.deepEqual(r.required_frames,['01_Home','02_Profile']);
});
test('common-entry external cohort counts real enrolled designers without an unused placeholder',t=>{
  const f=fixture(t),data=f.freeze(),store=createArenaStore(f.output,data.snapshot,{openRegistration:true});t.after(()=>store.close());
  assert.equal(store.activeReviewers.length,0);assert.equal(store.dashboard().task_statistics.summary.first_cycle_target,0);
  store.accounts.enroll({name:'Designer One',profile_secret:'a'.repeat(43)});store.refreshReviewers();
  assert.equal(store.activeReviewers.length,1);assert.equal(store.dashboard().task_statistics.summary.first_cycle_target,10);
  store.accounts.enroll({name:'Designer Two',profile_secret:'b'.repeat(43)});store.refreshReviewers();
  assert.equal(store.activeReviewers.length,2);assert.equal(store.dashboard().task_statistics.summary.first_cycle_target,20);
});
test('external review hides copy links and identities, requires gallery confirmation, and exposes frozen CC aggregates',async t=>{
  const f=fixture(t),data=f.freeze(),store=createArenaStore(f.output,data.snapshot),server=createArenaApp(store,{publicAdmin:true,basePath:'/arena-v2'}).listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));t.after(async()=>{await new Promise(r=>server.close(r));store.close();});
  const base=`http://127.0.0.1:${server.address().port}/arena-v2`;
  const request=async(route,body,cookie)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
  const cookie=(await request('/api/session',{access:store.credentials.reviewers[0].access})).cookie,pair=(await request('/api/review/next',null,cookie)).data.pair;
  assert.equal(pair.drafts.A.url,null);assert.equal(pair.drafts.B.url,null);for(const token of ['SECRET_MODEL','copyweb','copymobile','cc_score','model_id','run_id'])assert.ok(!JSON.stringify(pair).includes(token));
  assert.equal((await request('/api/review/seen',{pair_id:pair.id,side:'A',method:'figma'},cookie)).status,400);
  for(const side of ['A','B'])assert.equal((await request('/api/review/seen',{pair_id:pair.id,side,method:'gallery'},cookie)).status,200);
  assert.equal((await request('/api/review/vote',{pair_id:pair.id,choice:'A'},cookie)).status,200);
  const board=await request('/api/leaderboard');assert.equal(board.status,200);assert.equal(board.data.rows.length,6);
  const dashboard=await request('/api/admin/dashboard');assert.equal(dashboard.data.cc_leaderboard.scored_count,12);assert.equal(dashboard.data.external_delivery.kind,'external-scored-delivery/v1');
  assert.equal(store.tournament.exported()[0].selection_probabilities.length,45);
});
test('opening Figma links preserves the frozen cohort, existing votes, sessions and the next assigned comparison',async t=>{
  const f=fixture(t),data=f.freeze(),snapshotText=JSON.stringify(data.snapshot);
  let store=createArenaStore(f.output,data.snapshot),server;
  t.after(async()=>{if(server)await new Promise(r=>server.close(r));store.close();});
  const reviewer=store.credentials.reviewers[0].id,first=store.next(reviewer).pair;
  for(const side of ['A','B'])store.seen(reviewer,first.id,side,'gallery');
  store.vote(reviewer,{pair_id:first.id,choice:'A'});
  const next=store.next(reviewer),oldVotes=store.db.prepare('SELECT * FROM ballots ORDER BY id').all(),digest=store.digest;
  const oldViews=store.db.prepare('SELECT * FROM views ORDER BY created_at').all();
  const sessionToken='retained-browser-session',tokenHash=createHash('sha256').update(sessionToken).digest('hex');
  store.db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(tokenHash,'reviewer',reviewer,Date.now()+60000);
  store.close();
  store=createArenaStore(f.output,data.snapshot,{showFigmaLinks:true});
  assert.equal(store.digest,digest);assert.equal(JSON.stringify(data.snapshot),snapshotText);
  assert.equal(store.snapshot.review_mode,'screenshots-only');assert.equal(store.dashboard().review_mode,'figma-and-screenshots');
  assert.equal(store.dashboard().frozen_review_mode,'screenshots-only');
  assert.deepEqual(store.db.prepare('SELECT * FROM ballots ORDER BY id').all(),oldVotes);
  assert.deepEqual(store.db.prepare('SELECT * FROM views ORDER BY created_at').all(),oldViews);
  assert.equal(store.next(reviewer).pair.id,next.pair.id);assert.deepEqual(store.progress(reviewer),next.progress);
  server=createArenaApp(store,{basePath:'/arena-v2'}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}/arena-v2`,cookie=`arena_session=${sessionToken}`;
  const request=async(route,body)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{cookie,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,data:await r.json()};};
  const response=await request('/api/review/next');assert.equal(response.status,200);
  const pair=response.data.pair,sides=store.sides(store.pairById.get(pair.id),reviewer);
  for(const side of ['A','B']){
    assert.equal(pair.drafts[side].url,store.candidates.get(sides[side]).workspace_url);
    const url=new URL(pair.drafts[side].url);assert.equal(url.searchParams.get('page-id'),'3:1');assert.equal(url.searchParams.get('node-id'),'3-1');
    assert.equal(pair.drafts[side].images.length,1);
  }
  for(const token of ['SECRET_MODEL','cc_score','model_id','run_id'])assert.ok(!JSON.stringify(pair).includes(token));
  assert.equal((await request('/api/review/seen',{pair_id:pair.id,side:'A',method:'figma'})).status,200);
  assert.equal((await request('/api/review/seen',{pair_id:pair.id,side:'B',method:'gallery'})).status,200);
  assert.equal((await request('/api/review/vote',{pair_id:pair.id,choice:'B'})).status,200);
  assert.equal(store.dashboard().valid_votes,2);
});

test('native model additions require matching capture and blank acceptance evidence even while scores are pending',t=>{
 const f=fixture(t),data=f.freeze(),c=data.snapshot.candidates[0],proof={kind:'arena-native-delivery-addition/v1',task_id:'new-model-task',...Object.fromEntries(['plan_hash','input_sha256','capture_receipt_sha256','screen_check_sha256','blank_check_sha256','trace_audit_sha256','acceptance_sha256'].map(k=>[k,'a'.repeat(64)]))};
 Object.assign(c,{native_addition:proof,trace_status:'native-capture-available',screen_check:{status:'native-required-screens-verified',passed:true,expected:1,actual:1,white_screen_check_passed:true},cc_score:null,cc_score_id:null,cc_g0_pass:null});
 assert.throws(()=>validateArenaSnapshot(data.snapshot,f.output));Object.assign(f.manifest.items[0],{native_addition:proof,score_total:null,score_id:null,g0_pass:null});
 const text=JSON.stringify(f.manifest);fs.writeFileSync(path.join(f.output,'source-manifest.json'),text);c.delivery_row_sha256=createHash('sha256').update(JSON.stringify(f.manifest.items[0])).digest('hex');data.snapshot.external_delivery.manifest_sha256=createHash('sha256').update(text).digest('hex');validateArenaSnapshot(data.snapshot,f.output);
 for(const change of [s=>{delete s.candidates[0].native_addition.acceptance_sha256;},s=>{s.candidates[0].screen_check.white_screen_check_passed=false;},s=>{s.candidates[0].native_addition.kind='unknown';}]){const copy=structuredClone(data.snapshot);change(copy);assert.throws(()=>validateArenaSnapshot(copy,f.output));}
});
