import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createArenaStore,createArenaApp} from '../server/benchmark_arena.mjs';
import {tournamentProtocol} from '../server/arena_tournament.mjs';
import {seal} from '../server/benchmark_protocol.mjs';

const secret = n => String(n).repeat(48);
async function fixture(t,{openRegistration=true,basePath='',reviewerSelection=false,incrementalRanking=false,models=7}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arena-profiles-'));
  const snapshot={kind:'figma-human-arena-snapshot',version:3,name:'profile fixture',protocol:tournamentProtocol(),
    candidates:Array.from({length:3},(_,i)=>Array.from({length:models},(_,j)=>({
      id:createHash('sha256').update(`${i}:${j}`).digest('hex').slice(0,24),case_id:`case-${i}`,
      title:`Task ${i}`,source_url:`https://www.figma.com/design/Source${i}/`,source_query:'Read 00 and create in 03',
      model_id:`model-${j}`,model_name:`SECRET_MODEL_${j}`,run_id:`run-${i}-${j}`,workspace_id:'3:1',
      workspace_url:`https://www.figma.com/design/Output${i}m${j}/?page-id=3%3A1&node-id=3-1`,
      generation_ended:true,trace_status:'verified',screen_check:{passed:true},cc_score:j,cc_score_id:`score-${i}-${j}`,
      evidence_status:'live-view-required',images:[]}))).flat()};
  let store=createArenaStore(directory,snapshot,{openRegistration,incrementalRanking});
  let server=createArenaApp(store,{basePath,publicAdmin:true,reviewerSelection}).listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  const url=`http://127.0.0.1:${server.address().port}${basePath}`;
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();fs.rmSync(directory,{recursive:true,force:true});});
  const request=async(route,body,cookie,origin)=>{
    const response=await fetch(url+route,{method:body===undefined?'GET':'POST',headers:{connection:'close',...(body===undefined?{}:{'content-type':'application/json'}),...(cookie?{cookie}:{}),...(origin?{origin}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const text=await response.text();return{status:response.status,data:response.headers.get('content-type')?.includes('json')?JSON.parse(text):text,
      cookie:response.headers.get('set-cookie')?.split(';')[0],setCookie:response.headers.get('set-cookie')};
  };
  const enroll=async(name,key,cookie)=>(await request('/api/reviewers/enroll',{name,profile_secret:key},cookie));
  return{get store(){return store;},snapshot,directory,request,enroll,
    async reopen(){await new Promise(r=>server.close(r));store.close();store=createArenaStore(directory,snapshot,{openRegistration,incrementalRanking});
      server=createArenaApp(store,{basePath,publicAdmin:true,reviewerSelection}).listen(Number(new URL(url).port),'127.0.0.1');await new Promise(r=>server.once('listening',r));}};
}
function vote(store,id){const pair=store.next(id).pair;for(const side of ['A','B'])store.seen(id,pair.id,side,'figma');store.vote(id,{pair_id:pair.id,choice:'A'});return pair;}

test('name entry creates separate authenticated identities, even for identical names; public IDs cannot authenticate',async t=>{
  const f=await fixture(t,{basePath:'/arena'});
  assert.equal((await f.request('/api/session')).data.open_registration,true);
  assert.equal((await f.request('/api/review/next')).status,403);
  const a=await f.enroll('设计师甲',secret('a')),b=await f.enroll('设计师甲',secret('b'));
  assert.equal(a.status,200);assert.match(a.setCookie,/HttpOnly/);assert.match(a.setCookie,/Path=\/arena\//);
  const ids=f.store.activeReviewers.filter(r=>r.id.startsWith('participant-')).map(r=>r.id);
  assert.equal(ids.length,2);assert.notEqual(ids[0],ids[1]);vote(f.store,ids[0]);
  assert.equal((await f.request('/api/review/next',undefined,a.cookie)).data.progress.voted,1);
  assert.equal((await f.request('/api/review/next',undefined,b.cookie)).data.progress.voted,0);
  assert.equal((await f.request('/api/session',{access:ids[0]})).status,403);
  assert.equal((await f.enroll('冒用',ids[0])).status,400);
  const blinded=(await f.request('/api/review/next',undefined,b.cookie)).data;
  assert.ok(!JSON.stringify(blinded).includes('SECRET_MODEL'));
});

test('profile credential resumes durable votes across cookie loss and service restart without duplicating a reviewer',async t=>{
  const f=await fixture(t);await f.enroll('甲',secret('c'));
  const id=f.store.activeReviewers.find(r=>r.label==='甲').id;const pair=vote(f.store,id),next=f.store.next(id).pair.id;
  await f.reopen();const again=await f.enroll('甲',secret('c'));
  assert.equal((await f.request('/api/review/next',undefined,again.cookie)).data.pair.id,next);
  assert.equal(f.store.scopedBallots().length,1);assert.equal(f.store.scopedBallots()[0].pair_id,pair.id);
  assert.equal(f.store.activeReviewers.length,2);
});

test('binding an existing invitation preserves votes, reviewer ID and current assignment',async t=>{
  const f=await fixture(t);vote(f.store,'reviewer-1');const next=f.store.next('reviewer-1').pair.id;
  const login=await f.request('/api/session',{access:f.store.credentials.reviewers[0].access});
  const bound=await f.enroll('原设计师',secret('d'),login.cookie);
  assert.equal(bound.status,200);assert.equal(f.store.activeReviewers.length,1);
  assert.equal(f.store.activeReviewers[0].id,'reviewer-1');assert.equal(f.store.scopedBallots()[0].reviewer_id,'reviewer-1');
  const current=await f.request('/api/review/next',undefined,bound.cookie);assert.equal(current.data.pair.id,next);assert.equal(current.data.progress.voted,1);
  assert.equal((await f.request('/api/session',undefined,bound.cookie)).data.profile_registered,true);
});

test('old disabled invitation remains disabled when registration opens; disabled profiles cannot resume',async t=>{
  const f=await fixture(t);const credential=JSON.parse(fs.readFileSync(path.join(f.directory,'access.json')));
  credential.reviewers.push({id:'reviewer-2',label:'旧评审2',access:secret('2')});fs.writeFileSync(path.join(f.directory,'access.json'),JSON.stringify(credential));
  fs.writeFileSync(path.join(f.directory,'reviewers.json'),JSON.stringify(seal({kind:'figma-arena-reviewers/v1',snapshot_hash:f.store.digest,active_reviewers:['reviewer-1']})));
  await f.reopen();assert.equal((await f.request('/api/session',{access:secret('2')})).status,403);
  const enrolled=await f.enroll('乙',secret('e')),id=f.store.activeReviewers.find(r=>r.label==='乙').id;
  f.store.db.prepare('UPDATE reviewer_accounts SET enabled=0 WHERE reviewer_id=?').run(id);f.store.refreshReviewers();
  assert.equal((await f.enroll('乙',secret('e'))).status,403);
  assert.equal((await f.request('/api/review/next',undefined,enrolled.cookie)).status,403);
});

test('registration can remain closed, checks input and origin, and never exports identity secrets',async t=>{
  const closed=await fixture(t,{openRegistration:false});assert.equal((await closed.enroll('甲',secret('a'))).status,403);
  const f=await fixture(t);assert.equal((await f.enroll('\n',secret('a'))).status,400);
  assert.equal((await f.enroll('x'.repeat(41),secret('a'))).status,400);
  assert.equal((await f.request('/api/reviewers/enroll',{name:'甲',profile_secret:secret('a')},undefined,'https://other.example')).status,403);
  await f.enroll('甲',secret('f'));
  const dump=JSON.stringify((await f.request('/api/admin/export')).data);
  for(const credential of [secret('f'),createHash('sha256').update(secret('f')).digest('hex'),f.store.credentials.admin]) assert.ok(!dump.includes(credential));
  const csv=await f.request('/api/admin/tasks.csv');assert.equal(csv.status,200);assert.ok(csv.data.includes('first_cycle_votes'));
});

test('existing reviewer selection is opt-in and cannot create or rename identities',async t=>{
  const closed=await fixture(t);
  assert.equal((await closed.request('/api/reviewers/existing')).status,404);
  assert.equal((await closed.request('/api/reviewers/select-existing',{reviewer_id:'reviewer-1'})).status,404);
  assert.notEqual((await closed.request('/api/session')).data.reviewer_selection,true);
  const f=await fixture(t,{reviewerSelection:true,basePath:'/arena'});
  await f.enroll('原评审',secret('g'));
  const id=f.store.activeReviewers.find(r=>r.label==='原评审').id;
  vote(f.store,id);const pending=f.store.next(id).pair.id;
  const before={reviewers:f.store.db.prepare('SELECT * FROM reviewers ORDER BY id').all(),
    accounts:f.store.db.prepare('SELECT * FROM reviewer_accounts ORDER BY reviewer_id').all(),
    ballots:f.store.db.prepare('SELECT * FROM ballots ORDER BY id').all()};
  const list=await f.request('/api/reviewers/existing');assert.equal(list.status,200);
  assert.equal(list.data.reviewers.find(r=>r.id===id).progress.voted,1);
  for(const privateValue of [secret('g'),createHash('sha256').update(secret('g')).digest('hex'),f.store.credentials.admin,f.store.credentials.reviewers[0].access])
    assert.ok(!JSON.stringify(list.data).includes(privateValue));
  assert.equal((await f.request('/api/reviewers/select-existing',{name:'原评审'})).status,400);
  assert.equal((await f.request('/api/reviewers/select-existing',{reviewer_id:'unknown'})).status,403);
  assert.equal((await f.request('/api/reviewers/select-existing',{reviewer_id:id},undefined,'https://other.example')).status,403);
  const chosen=await f.request('/api/reviewers/select-existing',{reviewer_id:id,name:'不能改名'});
  assert.equal(chosen.status,200);assert.equal(chosen.data.reviewer_id,id);assert.equal(chosen.data.label,'原评审');
  assert.match(chosen.setCookie,/HttpOnly/);assert.match(chosen.setCookie,/SameSite=Strict/);assert.match(chosen.setCookie,/Path=\/arena\//);
  assert.equal((await f.request('/api/session',undefined,chosen.cookie)).data.reviewer_selection,true);
  assert.equal((await f.request('/api/review/next',undefined,chosen.cookie)).data.pair.id,pending);
  await f.reopen();
  const again=await f.request('/api/reviewers/select-existing',{reviewer_id:id});
  assert.equal((await f.request('/api/review/next',undefined,again.cookie)).data.pair.id,pending);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM reviewers ORDER BY id').all(),before.reviewers);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM reviewer_accounts ORDER BY reviewer_id').all(),before.accounts);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM ballots ORDER BY id').all(),before.ballots);
  assert.equal((await f.enroll('原评审',secret('g'))).status,200);
});

test('selection retains incremental votes, current task and paused review across restart',async t=>{
  const f=await fixture(t,{reviewerSelection:true,incrementalRanking:true,models:6,basePath:'/arena-v2'});
  await f.enroll('待复核评审',secret('h'));const id=f.store.activeReviewers.find(r=>r.label==='待复核评审').id;
  f.store.incremental.selectTask(id,{case_id:'case-0'});vote(f.store,id);
  const p=f.store.next(id).pair;
  for(const side of ['A','B'])f.store.seen(id,p.id,side,'figma');
  f.store.vote(id,{pair_id:p.id,choice:'unable',reason:'access'});
  const before={ballots:f.store.db.prepare('SELECT * FROM ballots ORDER BY id').all(),
    focus:f.store.db.prepare('SELECT * FROM incremental_sort_focus WHERE reviewer_id=?').get(id),
    sort:f.store.db.prepare('SELECT * FROM incremental_sort_sessions WHERE reviewer_id=?').all(id)};
  assert.equal(f.store.progress(id).blocked,true);
  await f.reopen();
  const list=await f.request('/api/reviewers/existing'),entry=list.data.reviewers.find(r=>r.id===id);
  assert.equal(entry.progress.actual_votes,2);assert.equal(entry.progress.blocked,true);
  const chosen=await f.request('/api/reviewers/select-existing',{reviewer_id:id});
  const next=(await f.request('/api/review/next',undefined,chosen.cookie)).data;
  assert.equal(next.pair,null);assert.equal(next.sorting.status,'paused-unable');
  assert.equal(next.sorting.session_id,before.focus.session_id);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM ballots ORDER BY id').all(),before.ballots);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM incremental_sort_focus WHERE reviewer_id=?').get(id),before.focus);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM incremental_sort_sessions WHERE reviewer_id=?').all(id),before.sort);
});

test('selection respects disabled accounts and supports active original invitations with registration closed',async t=>{
  const f=await fixture(t,{reviewerSelection:true});await f.enroll('已停用',secret('i'));
  const id=f.store.activeReviewers.find(r=>r.label==='已停用').id;
  f.store.db.prepare('UPDATE reviewer_accounts SET enabled=0 WHERE reviewer_id=?').run(id);
  assert.ok(!(await f.request('/api/reviewers/existing')).data.reviewers.some(r=>r.id===id));
  assert.equal((await f.request('/api/reviewers/select-existing',{reviewer_id:id})).status,403);
  const legacy=await fixture(t,{reviewerSelection:true,openRegistration:false});vote(legacy.store,'reviewer-1');
  const chosen=await legacy.request('/api/reviewers/select-existing',{reviewer_id:'reviewer-1'});
  assert.equal(chosen.status,200);assert.equal((await legacy.request('/api/session',undefined,chosen.cookie)).data.role,'reviewer');
  assert.equal((await legacy.request('/api/review/next',undefined,chosen.cookie)).data.progress.voted,1);
  assert.equal(legacy.store.db.prepare('SELECT COUNT(*) n FROM reviewer_accounts').get().n,0);
});
