import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createArenaStore,createArenaApp} from '../server/benchmark_arena.mjs';
import {tournamentProtocol,tournamentState} from '../server/arena_tournament.mjs';
import {INCREMENTAL_SORT} from '../server/arena_incremental_sort.mjs';
import {observedHumanComparisons,compareJudgesWithHumans} from '../server/arena_judge_agreement.mjs';

const hash=s=>createHash('sha256').update(s).digest('hex').slice(0,24);
function fixture(t,{cases=1,incremental=true}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arena-incremental-'));
  const snapshot={kind:'figma-human-arena-snapshot',version:3,name:'incremental fixture',protocol:tournamentProtocol({reviewers:2}),
    candidates:Array.from({length:cases},(_,i)=>Array.from({length:6},(_,j)=>({id:hash(`${i}:${j}`),case_id:`case-${i}`,title:`Task ${i}`,
      source_url:`https://www.figma.com/design/Source${i}/`,source_query:'Read00 and create03',model_id:`model-${j}`,model_name:`SECRET_MODEL_${j}`,
      run_id:`run-${i}-${j}`,workspace_id:'3:1',workspace_url:`https://www.figma.com/design/Output${i}m${j}/?page-id=3%3A1&node-id=3-1`,
      generation_ended:true,trace_status:'verified',screen_check:{passed:true},cc_score:j,cc_score_id:`score-${i}-${j}`,evidence_status:'live-view-required',images:[]}))).flat()};
  let store=createArenaStore(directory,snapshot,{incrementalRanking:incremental});
  t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  return{directory,snapshot,get store(){return store;},reopen(enabled=incremental){store.close();store=createArenaStore(directory,snapshot,{incrementalRanking:enabled});return store;}};
}
function vote(store,reviewer='reviewer-1',choice=null){
  const current=store.next(reviewer),p=current.pair;assert.ok(p);
  for(const side of ['A','B'])store.seen(reviewer,p.id,side,'figma');
  const display=store.sides(store.pairById.get(p.id),reviewer);
  const best=Object.entries(display).toSorted((a,b)=>store.candidates.get(a[1]).model_id.localeCompare(store.candidates.get(b[1]).model_id))[0][0];
  const body={pair_id:p.id,choice:choice||best,...(choice==='unable'?{reason:'access'}:{})};
  const result=store.vote(reviewer,body);return{current,body,result};
}

function historicalTie(store,reviewer='reviewer-1'){
  const p=store.next(reviewer).pair,at=new Date().toISOString();
  store.db.prepare('INSERT INTO ballots(reviewer_id,pair_id,winner_id,reason,comment,created_at,outcome,requirements_hash) VALUES (?,?,NULL,?,?,?,?,NULL)')
    .run(reviewer,p.id,'','historical tie',at,'tie');
  const id=store.db.prepare('SELECT id FROM ballots WHERE reviewer_id=? AND pair_id=?').get(reviewer,p.id).id;
  store.incremental.record(reviewer,{pair_id:p.id,ballot_id:id,winner_id:null,outcome:'tie'});
  return{current:{pair:p}};
}

test('persistent sort recovers six-model order, refreshes the same random display, and counts only observed active ballots',t=>{
  const f=fixture(t),r='reviewer-1',first=f.store.next(r),sid=first.sorting.session_id;
  assert.deepEqual(first,f.store.next(r));assert.deepEqual(f.reopen().next(r),first);
  const one=vote(f.store);assert.equal(f.store.vote(r,one.body).duplicate,true);
  let prior=f.store.next(r);assert.deepEqual(f.reopen().next(r),prior);
  while(f.store.next(r).pair)vote(f.store);
  const final=f.store.incremental.getRanking(sid,r);
  assert.equal(final.status,'complete');assert.deepEqual(final.ranking,['model-0','model-1','model-2','model-3','model-4','model-5']);
  assert.ok(final.actual_votes<=11);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM ballots').get().n,final.actual_votes);
  assert.equal(f.store.progress(r).complete,true);assert.equal(f.store.next(r).sorting.complete,true);
  const d=f.store.dashboard();assert.equal(d.snapshot.protocol,INCREMENTAL_SORT);assert.deepEqual(d.ranking.rows,[]);assert.equal(d.valid_votes,final.actual_votes);
  const human=observedHumanComparisons(f.store);
  assert.equal(human.votes.length,final.actual_votes);assert.equal(human.excluded.version_mismatch,0);
  const scores={judges:[{id:'j',rows:Array.from({length:6},(_,i)=>({model_id:`model-${i}`}))}],
    rows:f.snapshot.candidates.map(c=>({candidate_id:c.id,model_id:c.model_id,case_id:c.case_id,run_id:c.run_id,scores:{j:c.cc_score}}))};
  const agreement=compareJudgesWithHumans(scores,human);
  assert.equal(agreement.judges[0].human_agreement.compared,final.actual_votes);
  assert.equal(agreement.judges[0].human_agreement.agreed,0);
  assert.equal(d.task_statistics.tasks[0].first_cycle_target,null);assert.equal(d.task_statistics.tasks[0].reviewers.find(x=>x.reviewer_id===r).first_cycle_complete,true);
  assert.ok(!JSON.stringify(first).includes('SECRET_MODEL'));assert.ok(!JSON.stringify(first).includes('model-'));
});

test('same-session legacy four-model votes extend by at most six; other sessions and reviewers cannot contribute evidence',t=>{
  const f=fixture(t,{incremental:false});for(let i=0;i<5;i++)vote(f.store);
  const legacy=f.store.tournament.exported()[0],before=f.store.db.prepare('SELECT * FROM ballots ORDER BY id').all();
  f.reopen(true);let current=f.store.next('reviewer-1');assert.equal(current.sorting.actual_votes,5);
  const sid=current.sorting.session_id;assert.equal(f.store.incremental.getProgress(sid).source_session_id,legacy.id);
  while(f.store.next('reviewer-1').pair)vote(f.store);
  const result=f.store.incremental.getRanking(sid);assert.equal(result.status,'complete');assert.ok(result.actual_votes-5<=6);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM ballots ORDER BY id LIMIT 5').all(),before);
  assert.equal(f.store.next('reviewer-2').sorting.actual_votes,0);
  assert.throws(()=>f.store.incremental.getProgress(sid,'reviewer-2'),/无权/);
  assert.throws(()=>f.store.vote('reviewer-2',{pair_id:current.pair.id,choice:'A'}),/当前比较|无权/);
});

test('ties pause without an order; explicit audited review supersedes evidence and resumes, with correction actions counted honestly',t=>{
  const f=fixture(t);assert.throws(()=>vote(f.store,'reviewer-1','tie'),/无效投票/);const first=historicalTie(f.store);let next=f.store.next('reviewer-1');
  assert.equal(next.pair,null);assert.equal(next.sorting.status,'paused-tie');assert.equal(next.sorting.ranking,null);
  const session=next.sorting.session_id,voteId=next.sorting.votes[0].id;
  f.store.incremental.review('reviewer-1',{session_id:session,vote_id:voteId,revision:next.sorting.revision});
  next=f.store.next('reviewer-1');assert.equal(next.sorting.status,'reviewing');assert.notEqual(next.pair.id,first.current.pair.id);
  vote(f.store);const progress=f.store.incremental.getProgress(session);
  assert.equal(progress.actual_votes,2);assert.equal(progress.active_votes,1);assert.equal(progress.actual_vote_records.filter(v=>!v.active).length,1);
  assert.equal(f.store.scopedBallots().length,1);assert.equal(f.store.scopedBallots()[0].outcome,'win');
  const human=observedHumanComparisons(f.store);assert.equal(human.votes.length,1);
  assert.equal(human.votes[0].ballot_id,f.store.scopedBallots()[0].id);assert.equal(human.excluded.invalid,0);
  assert.throws(()=>f.store.incremental.review('reviewer-2',{session_id:session,vote_id:voteId,revision:progress.revision}),/无权/);
  assert.throws(()=>f.store.incremental.review('reviewer-1',{session_id:session,vote_id:voteId,revision:progress.revision}),/仍生效/);
});

test('unable pauses for review without deleting real ballots; stages and model versions cannot be forged',t=>{
  const f=fixture(t);vote(f.store,'reviewer-1','unable');const next=f.store.next('reviewer-1');
  assert.equal(next.sorting.status,'paused-unable');assert.equal(next.pair,null);assert.equal(next.sorting.actual_votes,1);
  assert.throws(()=>f.store.retrySkipped('reviewer-1'),/不删除真实记录/);
  const sid=next.sorting.session_id;
  assert.throws(()=>f.store.incremental.review('reviewer-1',{session_id:sid,vote_id:next.sorting.votes[0].id,revision:-1}),/已更新/);
  const row=f.store.db.prepare('SELECT models FROM incremental_sort_sessions WHERE id=?').get(sid),models=JSON.parse(row.models);models[0].version='other-model-version';
  f.store.db.prepare('UPDATE incremental_sort_sessions SET models=? WHERE id=?').run(JSON.stringify(models),sid);
  assert.throws(()=>f.store.incremental.getProgress(sid),/模型版本/);
  assert.equal(observedHumanComparisons(f.store).votes.length,0);
});

test('contradictory real legacy votes pause for cycle review, survive reopen, and can be corrected without deleting history',t=>{
  const f=fixture(t,{incremental:false});f.store.next('reviewer-1');const ids=f.store.tournament.exported()[0].candidate_ids;
  const perms=xs=>xs.length?xs.flatMap((x,i)=>perms(xs.filter((_,j)=>j!==i)).map(p=>[x,...p])):[[]];
  const preference=perms(ids).find(order=>{const decisions=[],seen=[];
    for(let i=0;i<4;i++){const pair=tournamentState(ids,decisions).pair;seen.push(JSON.stringify([...pair].sort()));decisions.push([...pair].sort((a,b)=>order.indexOf(a)-order.indexOf(b))[0]);}
    return seen.includes(JSON.stringify([...tournamentState(ids,decisions).pair].sort()));});assert.ok(preference);
  for(let i=0;i<5;i++){
    const pair=f.store.next('reviewer-1').pair,display=f.store.sides(f.store.pairById.get(pair.id),'reviewer-1');
    const sorted=Object.entries(display).sort((a,b)=>preference.indexOf(a[1])-preference.indexOf(b[1]));
    for(const side of ['A','B'])f.store.seen('reviewer-1',pair.id,side,'figma');
    f.store.vote('reviewer-1',{pair_id:pair.id,choice:sorted[i===4?1:0][0]});
  }
  const before=f.store.db.prepare('SELECT * FROM ballots ORDER BY id').all();f.reopen(true);
  let next=f.store.next('reviewer-1');assert.equal(next.sorting.status,'paused-cycle');assert.equal(next.pair,null);
  assert.deepEqual(f.reopen(true).next('reviewer-1'),next);
  const p=f.store.incremental.getProgress(next.sorting.session_id),wrong=p.actual_vote_records.at(-1);
  f.store.incremental.review('reviewer-1',{session_id:p.session_id,vote_id:wrong.id,revision:p.revision});next=f.store.next('reviewer-1');
  const display=f.store.sides(f.store.pairById.get(next.pair.id),'reviewer-1'),winner=Object.entries(display).sort((a,b)=>preference.indexOf(a[1])-preference.indexOf(b[1]))[0][0];
  vote(f.store,'reviewer-1',winner);
  assert.equal(f.store.incremental.getProgress(p.session_id).status,'awaiting-vote');
  assert.deepEqual(f.store.db.prepare('SELECT * FROM ballots ORDER BY id LIMIT 5').all(),before);
  assert.equal(f.store.incremental.getProgress(p.session_id).actual_votes,6);
});

test('authenticated status endpoints expose anonymous order only; admin export separates actual votes and derivations',async t=>{
  const f=fixture(t),server=createArenaApp(f.store,{basePath:'/arena-v2',publicAdmin:true}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}/arena-v2`,login=await fetch(base+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({access:f.store.credentials.reviewers[0].access})});
  const cookie=login.headers.get('set-cookie').split(';')[0],headers={cookie};
  assert.equal((await fetch(base+'/api/review/sort/next')).status,403);
  const next=await(await fetch(base+'/api/review/sort/next',{headers})).json();assert.equal(next.sorting.algorithm,INCREMENTAL_SORT);
  let p=await(await fetch(base+'/api/review/sort/progress',{headers})).json();assert.ok(!JSON.stringify(p).includes('model-'));
  while(f.store.next('reviewer-1').pair)vote(f.store);
  const final=await(await fetch(base+'/api/review/sort/ranking?session_id='+next.sorting.session_id,{headers})).json();assert.equal(final.ranking.length,6);assert.ok(final.ranking.every(x=>x.startsWith('作品 ')));assert.ok(!('score' in final));
  const exported=await(await fetch(base+'/api/admin/export')).json();assert.equal(exported.incremental_sorting.length,1);assert.equal(exported.incremental_sorting[0].actual_vote_records.length,final.actual_votes);
  assert.equal(exported.human_v4.rows.length,final.actual_votes);assert.ok(Array.isArray(exported.incremental_sorting[0].derivations));
});

for(const select of ['earlier','later'])test(`confirming the same ${select} judgment resolves a repeated opposite pair while retaining all raw ballots`,t=>{
 const f=fixture(t,{incremental:false,cases:2}),r='reviewer-1';f.store.next(r);const ids=f.store.tournament.exported()[0].candidate_ids;
 const perms=xs=>xs.length?xs.flatMap((x,i)=>perms(xs.filter((_,j)=>j!==i)).map(p=>[x,...p])):[[]];
 const preference=perms(ids).find(order=>{const decisions=[],seen=[];for(let i=0;i<4;i++){const pair=tournamentState(ids,decisions).pair;seen.push(JSON.stringify([...pair].sort()));decisions.push([...pair].sort((a,b)=>order.indexOf(a)-order.indexOf(b))[0]);}return seen.includes(JSON.stringify([...tournamentState(ids,decisions).pair].sort()));});
 for(let i=0;i<5;i++){
  const pair=f.store.next(r).pair,display=f.store.sides(f.store.pairById.get(pair.id),r),sorted=Object.entries(display).sort((a,b)=>preference.indexOf(a[1])-preference.indexOf(b[1]));
  for(const side of ['A','B'])f.store.seen(r,pair.id,side,'figma');f.store.vote(r,{pair_id:pair.id,choice:sorted[i===4?1:0][0]});
 }
 vote(f.store,'reviewer-2');const raw=f.store.db.prepare('SELECT * FROM ballots ORDER BY id').all();f.reopen(true);
 const paused=f.store.next(r),p=f.store.incremental.getProgress(paused.sorting.session_id),conflicting=p.actual_vote_records.filter(v=>p.issue.vote_ids.includes(v.id));assert.equal(conflicting.length,2);
 const selected=select==='earlier'?conflicting[0]:conflicting.at(-1),other=p.actual_vote_records.filter(v=>!conflicting.includes(v));
 const otherSession=f.store.incremental.exported().filter(s=>s.session_id!==p.session_id);
 f.store.incremental.review(r,{session_id:p.session_id,vote_id:selected.id,revision:p.revision});
 assert.deepEqual(f.store.db.prepare('SELECT * FROM ballots ORDER BY id').all(),raw);
 const next=f.store.next(r),display=f.store.sides(f.store.pairById.get(next.pair.id),r),choice=Object.entries(display).find(([,id])=>f.store.candidates.get(id).model_id===selected.winner)[0];
 vote(f.store,r,choice);const updated=f.store.incremental.getProgress(p.session_id);
 assert.ok(!updated.status.startsWith('paused-'));assert.equal(updated.actual_votes,6);assert.equal(updated.active_votes,4);
 assert.ok(conflicting.every(old=>updated.actual_vote_records.find(v=>v.id===old.id).active===0));
 for(const old of other)assert.deepEqual(updated.actual_vote_records.find(v=>v.id===old.id),old);
 assert.deepEqual(f.store.db.prepare('SELECT * FROM ballots ORDER BY id LIMIT ?').all(raw.length),raw);
 assert.deepEqual(f.store.incremental.exported().filter(s=>s.session_id!==p.session_id),otherSession);
 const audit=JSON.parse(f.store.db.prepare("SELECT body FROM events WHERE kind='incremental-pair-review-resolved' ORDER BY id DESC LIMIT 1").get().body);
 assert.deepEqual(audit.superseded_vote_ids,conflicting.map(v=>v.id));assert.equal(audit.review_scope,'same-pair-in-session');
 const restored=f.reopen(true).incremental.getProgress(p.session_id);assert.equal(restored.active_votes,4);assert.ok(!restored.status.startsWith('paused-'));
 const effective=observedHumanComparisons(f.store).votes.map(v=>v.ballot_id);assert.ok(conflicting.every(v=>!effective.includes(v.ballot_id)));
});

test('task selection does not allocate on listing, switches durably, and independent repeat rounds count one person separately from rounds',t=>{
  const f=fixture(t,{cases:2}),r='reviewer-1';
  assert.equal(f.store.incremental.listTasks(r).tasks.length,2);assert.equal(f.store.incremental.exported().length,0);
  f.store.incremental.selectTask(r,{case_id:'case-1'});vote(f.store);const pending=f.store.next(r);
  f.store.incremental.selectTask(r,{case_id:'case-0'});assert.equal(f.store.next(r).pair.case_id,'case-0');
  f.store.incremental.selectTask(r,{case_id:'case-1'});const resumed=f.reopen().next(r);assert.deepEqual(resumed.pair,pending.pair);assert.deepEqual(resumed.sorting,pending.sorting);
  assert.throws(()=>f.store.incremental.selectTask(r,{case_id:'case-1',new_round:true}),/未完成/);
  while(f.store.next(r).pair)vote(f.store);const first=f.store.incremental.getProgress(pending.sorting.session_id);
  assert.equal(f.store.next(r).sorting.status,'complete');
  let task=f.store.incremental.listTasks(r).tasks.find(t=>t.case_id==='case-1');assert.equal(task.completed_reviewers,1);assert.equal(task.completed_rounds,1);
  f.store.incremental.selectTask(r,{case_id:'case-1',new_round:true});const again=f.store.next(r);
  assert.equal(again.sorting.round,2);assert.equal(again.sorting.actual_votes,0);assert.notEqual(again.sorting.session_id,first.session_id);
  assert.notEqual(f.store.incremental.getProgress(again.sorting.session_id).scope_hash,first.scope_hash);
  while(f.store.next(r).pair)vote(f.store);
  task=f.store.incremental.listTasks(r).tasks.find(t=>t.case_id==='case-1');assert.equal(task.completed_reviewers,1);assert.equal(task.completed_rounds,2);
  assert.equal(f.store.progress(r).completed_tasks,1);assert.equal(f.store.progress(r).completed_rounds,2);
  f.store.incremental.selectTask('reviewer-2',{case_id:'case-1'});while(f.store.next('reviewer-2').pair)vote(f.store,'reviewer-2');
  task=f.store.incremental.listTasks(r).tasks.find(t=>t.case_id==='case-1');assert.equal(task.completed_reviewers,2);assert.equal(task.completed_rounds,3);
  assert.equal(task.my_rounds.length,2);
});

test('pre-round schema migration preserves session IDs, requests, actual votes, and every foreign key',t=>{
  const f=fixture(t);vote(f.store);const pending=f.store.next('reviewer-1'),before=f.store.db.prepare('SELECT * FROM incremental_sort_votes').all();
  const columns=f.store.db.prepare('PRAGMA table_info(incremental_sort_sessions)').all().filter(c=>c.name!=='round').map(c=>c.name).join(',');
  f.store.db.exec(`PRAGMA foreign_keys=OFF;BEGIN IMMEDIATE;
    CREATE TABLE old_sort_sessions (id TEXT PRIMARY KEY,reviewer_id TEXT NOT NULL REFERENCES reviewers(id),case_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,source_session_id TEXT,scope_hash TEXT NOT NULL,models TEXT NOT NULL,state TEXT NOT NULL,
      revision INTEGER NOT NULL,review_request_id TEXT,created_at TEXT NOT NULL,UNIQUE(reviewer_id,case_id));
    INSERT INTO old_sort_sessions SELECT ${columns} FROM incremental_sort_sessions;
    DROP TABLE incremental_sort_sessions;ALTER TABLE old_sort_sessions RENAME TO incremental_sort_sessions;COMMIT;PRAGMA foreign_keys=ON;`);
  f.reopen();assert.deepEqual(f.store.next('reviewer-1'),pending);assert.deepEqual(f.store.db.prepare('SELECT * FROM incremental_sort_votes').all(),before);
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(f.store.incremental.getProgress(pending.sorting.session_id).round,1);
});
