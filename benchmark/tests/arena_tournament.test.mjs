import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tournamentProtocol, tournamentState, bradleyTerryRankings } from '../server/arena_tournament.mjs';
import { createArenaStore, createArenaApp, validateArenaSnapshot } from '../server/benchmark_arena.mjs';
import { seal } from '../server/benchmark_protocol.mjs';

const hash=s=>createHash('sha256').update(s).digest('hex').slice(0,24);
function snapshot(count=3){return {kind:'figma-human-arena-snapshot',version:3,name:'tournament fixture',protocol:tournamentProtocol({reviewers:2}),
  candidates:Array.from({length:count},(_,i)=>Array.from({length:7},(_,j)=>({id:hash(`${i}:${j}`),case_id:`case-${i}`,
    title:`Task ${i}`,source_url:`https://www.figma.com/design/Source${i}/`,source_query:'Read 00 and create in 03',model_id:`model-${j}`,model_name:`SECRET_MODEL_${j}`,
    run_id:`run-${i}-${j}`,workspace_id:'3:1',workspace_url:`https://www.figma.com/design/Output${i}m${j}/?page-id=3%3A1&node-id=3-1`,
    generation_ended:true,trace_status:'verified',screen_check:{passed:true},cc_score:j,cc_score_id:`score-${i}-${j}`,evidence_status:'live-view-required',images:[]}))).flat()};}
function fixture(t,count=3){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arena-tournament-')),s=snapshot(count);let store=createArenaStore(directory,s);
  t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  return{directory,s,get store(){return store;},reopen(){store.close();store=createArenaStore(directory,s);return store;}};}
function vote(store,reviewer,winner){const p=store.next(reviewer).pair;assert.ok(p);for(const side of ['A','B'])store.seen(reviewer,p.id,side,'figma');
  const side=winner?Object.entries(store.sides(store.pairById.get(p.id),reviewer)).find(([,id])=>id===winner)[0]:'A';
  const body={pair_id:p.id,choice:side};store.vote(reviewer,body);return body;}
function permutations(ids){return ids.length?ids.flatMap((v,i)=>permutations(ids.filter((_,j)=>j!==i)).map(p=>[v,...p])):[[]];}

test('all24 strict four-model orderings are recovered with exactly5 real comparisons',()=>{
  for(const ranking of permutations(['a','b','c','d'])){const decisions=[],rank=id=>ranking.indexOf(id);let s=tournamentState(['a','b','c','d'],decisions);
    for(let i=0;i<5;i++){assert.equal(s.complete,false);decisions.push(s.pair.toSorted((a,b)=>rank(a)-rank(b))[0]);s=tournamentState(['a','b','c','d'],decisions);}
    assert.equal(s.complete,true);assert.deepEqual(s.ordering,ranking);assert.equal(s.battles.length,5);
    assert.ok([4,5].includes(new Set(s.battles.map(p=>p.toSorted().join(':'))).size));
  }
  assert.throws(()=>tournamentState(['a','b','c','d'],['c']),/does not belong/);
});

test('actual winners/losers route5 persistent battles; next task then subsequent cycles have no120 cap',t=>{
  const f=fixture(t),store=f.store,reviewer='reviewer-1',first=store.next(reviewer);
  assert.deepEqual(first,store.next(reviewer));assert.equal(store.pairs.length,1);
  assert.throws(()=>store.vote(reviewer,{pair_id:first.pair.id,choice:'tie'}),/无效投票/);
  assert.throws(()=>store.vote(reviewer,{pair_id:first.pair.id,choice:'A'}),/完整查看/);
  const group=store.tournament.exported()[0],ids=group.candidate_ids,decisions=[];
  for(let i=0;i<5;i++){const expected=tournamentState(ids,decisions).pair,p=store.next(reviewer).pair;
    assert.deepEqual([store.pairById.get(p.id).first_id,store.pairById.get(p.id).second_id].sort(),[...expected].sort());
    const body=vote(store,reviewer,expected[0]);decisions.push(expected[0]);assert.equal(store.vote(reviewer,body).duplicate,true);
  }
  const exported=store.tournament.exported()[0];assert.equal(exported.complete,true);assert.deepEqual(exported.ordering,tournamentState(ids,decisions).ordering);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM ballots').get().n,5);
  assert.equal(store.progress(reviewer).completed_sessions,1);assert.equal(store.progress(reviewer).total,null);
  assert.notEqual(store.next(reviewer).pair.case_id,first.pair.case_id);
  for(let i=5;i<155;i++)vote(store,reviewer);
  const history=store.tournament.exported();assert.equal(history.filter(x=>x.complete).length,31);
  for(let cycle=0;cycle<10;cycle++)assert.equal(new Set(history.slice(cycle*3,cycle*3+3).map(x=>x.case_id)).size,3);
  assert.equal(store.progress(reviewer).voted,155);assert.equal(store.progress(reviewer).open_ended,true);
});

test('unable skips to the next task without invented wins; duplicate submissions, other reviewers and reopen preserve state',t=>{
  const f=fixture(t),a=f.store.next('reviewer-1'),b=f.store.next('reviewer-2');
  assert.notEqual(a.pair.id,b.pair.id);
  assert.throws(()=>f.store.vote('reviewer-2',{pair_id:a.pair.id,choice:'A'}),/当前比较/);
  const skipped={pair_id:a.pair.id,choice:'unable',reason:'access',comment:'Cannot open this draft'};
  f.store.vote('reviewer-1',skipped);
  const next=f.store.next('reviewer-1');assert.notEqual(next.pair.id,a.pair.id);assert.notEqual(next.pair.case_id,a.pair.case_id);
  assert.equal(next.tournament.step,1);assert.equal(next.tournament.unable_action,'skip-session');
  assert.equal(f.store.progress('reviewer-1').blocked,false);assert.equal(f.store.progress('reviewer-1').skipped_sessions,1);
  assert.ok(f.store.dashboard().ranking.rows.every(x=>x.rating===null));
  const store=f.reopen();assert.deepEqual(store.next('reviewer-1'),next);
  assert.equal(store.vote('reviewer-1',skipped).duplicate,true);assert.equal(store.dashboard().unable,1);
  assert.throws(()=>store.vote('reviewer-1',{pair_id:a.pair.id,choice:'A'}),/已提交/);
  assert.deepEqual(store.next('reviewer-2'),b);const body=vote(store,'reviewer-1');
  assert.throws(()=>store.vote('reviewer-1',{...body,choice:body.choice==='A'?'B':'A'}),/已提交/);
  const pending=store.next('reviewer-1');assert.deepEqual(f.reopen().next('reviewer-1'),pending);
  assert.equal(f.store.progress('reviewer-2').voted,0);const old=f.store.tournament.exported().find(x=>x.reviewer_id==='reviewer-1'&&x.sequence===0);
  assert.equal(old.battles.length,1);assert.equal(old.skipped,true);assert.equal(old.complete,false);assert.equal(old.ordering,null);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM events WHERE kind='tournament-skipped'").get().n,1);
});

test('unable at each of the five battle positions retains all earlier votes and reports the partial task honestly',t=>{
  for(let step=0;step<5;step++){
    const f=fixture(t);for(let i=0;i<step;i++)vote(f.store,'reviewer-1');
    const pending=f.store.next('reviewer-1'),oldVotes=f.store.scopedBallots();
    f.store.vote('reviewer-1',{pair_id:pending.pair.id,choice:'unable',reason:'incomplete-view'});
    const next=f.store.next('reviewer-1');assert.notEqual(next.pair.case_id,pending.pair.case_id);
    assert.deepEqual(f.store.scopedBallots().slice(0,step),oldVotes);
    const d=f.store.dashboard(),task=d.task_statistics.tasks.find(x=>x.case_id===pending.pair.case_id);
    assert.equal(d.valid_votes,step);assert.equal(d.unable,1);assert.equal(d.v4_comparison.comparable_votes,step);
    assert.equal(d.ranking.rows.reduce((sum,m)=>sum+m.votes,0),step*2);
    assert.equal(task.first_cycle_votes,step);assert.equal(task.skipped_sessions,1);assert.equal(task.status,'has-skips');
    assert.equal(task.first_cycle_complete,false);assert.equal(task.reviewers.find(r=>r.reviewer_id==='reviewer-1').first_cycle_skipped,true);
    const old=f.store.tournament.exported().find(x=>x.reviewer_id==='reviewer-1'&&x.sequence===0);
    assert.equal(old.battles.length,step+1);assert.equal(old.ordering,null);assert.equal(old.complete,false);
    assert.equal(f.store.progress('reviewer-1').completed_sessions,0);
    assert.equal(f.store.progress('reviewer-1').processed_sessions,1);
  }
});

test('equal-weight BT recovers known strength ratios; no invented prior, disconnected/separated samples do not publish finite MLE',()=>{
  const candidates=['a','b','c'].map((id,i)=>({id,model_id:id,model_name:id,case_id:'one',cc_score:i})),pairs=[['a','b'],['a','c'],['b','c']].map((p,i)=>({id:String(i),case_id:'one',first_id:p[0],second_id:p[1]}));
  const votes=[];for(const[p,counts]of pairs.map((p,i)=>[p,[[3,1],[9,1],[3,1]][i]]))for(let side=0;side<2;side++)for(let k=0;k<counts[side];k++)votes.push({pair_id:p.id,outcome:'win',winner_id:side?p.second_id:p.first_id});
  const r=bradleyTerryRankings(candidates,pairs,votes);assert.equal(r.converged,true);assert.deepEqual(r.rows.map(x=>x.model_id),['a','b','c']);
  assert.ok(Math.abs(r.rows[0].rating-r.rows[1].rating-400*Math.log10(3))<0.02);
  assert.equal(r.rows.reduce((sum,x)=>sum+x.votes,0),votes.length*2);assert.ok(r.rows.every(x=>x.preliminary&&!x.chart_eligible));
  const none=bradleyTerryRankings(candidates,pairs,[]);assert.ok(none.rows.every(x=>x.rank===null&&x.rating===null&&x.votes===0));
  const separated=bradleyTerryRankings(candidates,pairs,votes.filter(v=>v.winner_id===pairs.find(p=>p.id===v.pair_id).first_id));
  assert.equal(separated.status,'separated-no-finite-mle');assert.ok(separated.rows.every(x=>x.rating===null));
  const reversed=bradleyTerryRankings(candidates,pairs,votes.toReversed());assert.deepEqual(reversed,r);
});

test('new round carries access codes but cannot overwrite snapshots; protocol needs four models per task',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arena-carried-access-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const credentials={admin:'admin',seed:'seed',reviewers:[{id:'reviewer-1',label:'one',access:'one'},{id:'reviewer-2',label:'two',access:'two'}]};
  fs.writeFileSync(path.join(directory,'access.json'),JSON.stringify(credentials));const s=snapshot(1),store=createArenaStore(directory,s);
  assert.deepEqual(store.credentials,credentials);store.close();s.candidates[0].run_id='new-run';assert.throws(()=>createArenaStore(directory,s),/different frozen snapshot/);
  s.candidates=s.candidates.slice(0,3);assert.throws(()=>validateArenaSnapshot(s,directory),/four distinct/);
});

test('review API exposes only current two drafts, no bracket winners, model/CC identities or other reviewer; export includes all real battles',async t=>{
  const{store}=fixture(t),server=createArenaApp(store,{basePath:'/arena'}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}/arena`,login=async access=>(await fetch(base+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({access})})).headers.get('set-cookie').split(';')[0];
  const cookie=await login(store.credentials.reviewers[0].access),r=await(await fetch(base+'/api/review/next',{headers:{cookie}})).json();
  for(const secret of ['SECRET_MODEL','model_id','run_id','cc_score','candidate_ids','winner_id','ordering'])assert.ok(!JSON.stringify(r).includes(secret));
  assert.deepEqual(r.choices,['A','B','unable']);assert.equal(r.tournament.step,1);vote(store,'reviewer-1');
  assert.equal((await fetch(base+'/api/admin/export',{headers:{cookie}})).status,403);
  const admin=await login(store.credentials.admin),exported=await(await fetch(base+'/api/admin/export',{headers:{cookie:admin}})).json();
  assert.equal(exported.tournaments.length,1);assert.equal(exported.votes.length,1);assert.equal(exported.human_v4.rows.length,1);
  assert.equal(exported.tournaments[0].candidate_ids.length,4);assert.ok(exported.tournaments[0].ordered_selection_probability>0);
  const before=await(await fetch(base+'/api/review/next',{headers:{cookie}})).json();
  const response=await fetch(base+'/api/review/vote',{method:'POST',headers:{cookie,'content-type':'application/json'},
    body:JSON.stringify({pair_id:before.pair.id,choice:'unable',reason:'other',comment:'Unable to judge'})});
  assert.equal(response.status,200);assert.equal((await response.json()).progress.blocked,false);
  const after=await(await fetch(base+'/api/review/next',{headers:{cookie}})).json();
  assert.notEqual(after.pair.case_id,before.pair.case_id);assert.equal(after.progress.skipped_sessions,1);
  assert.equal(after.progress.voted,1);assert.equal(after.progress.skipped,1);
});

test('single-designer default completes all30 task sessions in150 choices without a second identity or barrier',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arena-single-')),s=snapshot(30);s.protocol=tournamentProtocol();
  const store=createArenaStore(directory,s);t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  assert.equal(s.protocol.reviewers,1);assert.equal(store.credentials.reviewers.length,1);
  for(let i=0;i<150;i++)vote(store,'reviewer-1');
  const d=store.dashboard();assert.equal(d.reviewers.length,1);assert.equal(d.snapshot.reviewer_count,1);
  assert.equal(d.reviewers[0].completed_sessions,30);assert.equal(d.valid_votes,150);
  assert.ok(d.coverage.every(c=>c.votes===5));assert.equal(d.ranking.rows.reduce((sum,m)=>sum+m.votes,0),300);
  const next=store.next('reviewer-1');assert.equal(next.tournament.number,31);assert.equal(next.progress.cycle,2);
  assert.throws(()=>store.next('reviewer-2'),/已停用/);
});

test('switching to one designer preserves current session, votes and credentials, blocks retired codes and cookies, and scopes all ranking exports',async t=>{
  const f=fixture(t),bodies=[vote(f.store,'reviewer-1'),vote(f.store,'reviewer-2')],pending=f.store.next('reviewer-1');
  let server=createArenaApp(f.store).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  let base=`http://127.0.0.1:${server.address().port}`;
  const login=async access=>{const r=await fetch(base+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({access})});return {status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0]};};
  const active=await login(f.store.credentials.reviewers[0].access),retired=await login(f.store.credentials.reviewers[1].access),credentials=structuredClone(f.store.credentials);
  await new Promise(r=>server.close(r));
  fs.writeFileSync(path.join(f.directory,'snapshot.json'),JSON.stringify(f.s));
  const config=spawnSync(process.execPath,[path.resolve('scripts/configure-arena-reviewers.mjs'),'--directory',f.directory,'--active','reviewer-1'],{encoding:'utf8'});
  assert.equal(config.status,0,config.stderr);const receipt=JSON.parse(config.stdout);
  assert.equal(receipt.preserved_counts.ballots,2);assert.ok(fs.existsSync(path.join(receipt.archive,'arena.sqlite3')));
  const store=f.reopen();assert.deepEqual(store.credentials,credentials);assert.deepEqual(store.next('reviewer-1'),pending);
  assert.equal(store.vote('reviewer-1',bodies[0]).duplicate,true);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM ballots').get().n,2);
  assert.throws(()=>store.vote('reviewer-2',bodies[1]),/已停用/);
  server=createArenaApp(store).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await login(credentials.reviewers[1].access)).status,403);
  for(const route of ['/api/review/next','/api/review/image/any/A/0'])assert.equal((await fetch(base+route,{headers:{cookie:retired.cookie}})).status,403);
  for(const route of ['/api/review/seen','/api/review/vote','/api/review/retry-unable'])assert.equal((await fetch(base+route,{method:'POST',headers:{cookie:retired.cookie,'content-type':'application/json'},body:'{}'})).status,403);
  assert.equal((await(await fetch(base+'/api/session',{headers:{cookie:retired.cookie}})).json()).role,null);
  assert.equal((await fetch(base+'/api/review/next',{headers:{cookie:active.cookie}})).status,200);
  const admin=await login(credentials.admin),exported=await(await fetch(base+'/api/admin/export',{headers:{cookie:admin.cookie}})).json();
  assert.equal(exported.dashboard.reviewers.length,1);assert.equal(exported.dashboard.valid_votes,1);assert.equal(exported.votes.length,2);
  assert.equal(exported.votes.filter(v=>v.included_in_current_ranking).length,1);assert.equal(exported.human_v4.summary.valid_votes,1);
  assert.equal(exported.dashboard.ranking.rows.reduce((sum,m)=>sum+m.votes,0),2);
  const csv=await(await fetch(base+'/api/admin/export.csv',{headers:{cookie:admin.cookie}})).text();assert.ok(!csv.includes('reviewer-2'));
  const policy=store.db.prepare("SELECT body FROM events WHERE kind='reviewer-policy' ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual(JSON.parse(policy.body).active_reviewers,['reviewer-1']);
});

test('participant policy rejects a changed snapshot, unknown identity and a forged seal',t=>{
  const{directory,store,s}=fixture(t),file=path.join(directory,'reviewers.json');
  const original={kind:'figma-arena-reviewers/v1',snapshot_hash:store.digest,active_reviewers:['reviewer-1']};
  for(const value of [{...original,snapshot_hash:'another-round'},{...original,active_reviewers:['unknown']}]){
    fs.writeFileSync(file,JSON.stringify(seal(value)));assert.throws(()=>createArenaStore(directory,s),/Invalid arena reviewer policy/);
  }
  const forged=seal(original);forged.active_reviewers=['reviewer-2'];fs.writeFileSync(file,JSON.stringify(forged));
  assert.throws(()=>createArenaStore(directory,s),/checksum/);
});
