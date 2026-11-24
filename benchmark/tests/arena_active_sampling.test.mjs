import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {activeSamplingPolicy,readArenaSampling,samplingEvidence,samplingConfigurations,expectedBracketGain,drawActiveTournament,ACTIVE_SAMPLING} from '../server/arena_active_sampling.mjs';
import {createArenaStore,createArenaApp} from '../server/benchmark_arena.mjs';
import {tournamentState,tournamentProtocol} from '../server/arena_tournament.mjs';
import {seal} from '../server/benchmark_protocol.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
function data(n=7){
  const candidates=Array.from({length:n},(_,i)=>({id:`candidate-${i}`,case_id:'one',model_id:`model-${i}`,model_name:`MODEL_${i}`,cc_score:50-i})),pairs=[];
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)pairs.push({id:`pair-${i}-${j}`,case_id:'one',first_id:candidates[i].id,second_id:candidates[j].id});
  return{candidates,pairs,policy:activeSamplingPolicy('snapshot')};
}
function balancedVotes(pairs,{exclude='candidate-6',count=25}={}){
  const votes=[];for(const p of pairs)if(![p.first_id,p.second_id].includes(exclude))for(let i=0;i<count;i++)for(const winner of [p.first_id,p.second_id])votes.push({id:votes.length+1,reviewer_id:'reviewer-1',pair_id:p.id,outcome:'win',winner_id:winner});return votes;
}
function logdet(matrix){const a=matrix.map(r=>[...r]);let sum=0;for(let i=0;i<a.length;i++){const p=a[i][i];assert.ok(p>0);sum+=Math.log(p);for(let r=i+1;r<a.length;r++){const f=a[r][i]/p;for(let c=i+1;c<a.length;c++)a[r][c]-=f*a[i][c];}}return sum;}

test('cold start is symmetric; all105 four-model/matching configurations have positive normalized probability',()=>{
  const{candidates,pairs,policy}=data(),e=samplingEvidence(candidates,pairs,[],policy),configs=samplingConfigurations(candidates,e,policy);
  assert.equal(configs.length,35*3);assert.equal(e.observed_votes,0);assert.ok(e.theta.every(x=>x===0));
  assert.ok(Math.abs(configs.reduce((n,c)=>n+c.probability,0)-1)<1e-12);
  for(const c of configs){assert.equal(new Set(c.candidate_ids).size,4);assert.ok(Math.abs(c.probability-1/105)<1e-12);assert.ok(Number.isFinite(c.expected_information_gain));}
});
test('human evidence makes sampling nonuniform and prioritizes an under-evaluated model while retaining exploration',()=>{
  const{candidates,pairs,policy}=data(),votes=balancedVotes(pairs),e=samplingEvidence(candidates,pairs,votes,policy),configs=samplingConfigurations(candidates,e,policy);
  const rareProbability=configs.filter(c=>c.model_ids.includes('model-6')).reduce((n,c)=>n+c.probability,0);
  assert.ok(rareProbability>.75,`under-evaluated inclusion probability: ${rareProbability}`);
  assert.ok(configs.every(c=>c.probability>=.2/configs.length));
  assert.ok(e.covariance[6][6]>e.covariance[0][0]);assert.equal(e.observed_votes,votes.length);
});
test('five-battle expected Fisher gain matches exact enumeration of all32 paths and never adds an unobserved sixth vote',()=>{
  const{candidates,pairs,policy}=data(4),votes=balancedVotes(pairs,{exclude:'candidate-3',count:4}),e=samplingEvidence(candidates,pairs,votes,policy);
  const ids=e.models,n=ids.length,idx=new Map(ids.map((id,i)=>[id,i]));
  const initial=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?policy.prior_precision:0));
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){const p=1/(1+Math.exp(e.theta[j]-e.theta[i])),w=e.counts[i][j]*p*(1-p);initial[i][i]+=w;initial[j][j]+=w;initial[i][j]-=w;initial[j][i]-=w;}
  const base=logdet(initial);let enumerated=0,paths=0;
  function visit(decisions,matrix,probability){const state=tournamentState(ids,decisions);if(state.complete){paths++;enumerated+=probability*.5*(logdet(matrix)-base);return;}
    const [a,b]=state.pair,i=idx.get(a),j=idx.get(b),p=1/(1+Math.exp(e.theta[j]-e.theta[i])),w=p*(1-p),next=matrix.map(r=>[...r]);
    next[i][i]+=w;next[j][j]+=w;next[i][j]-=w;next[j][i]-=w;visit([...decisions,a],next,probability*p);visit([...decisions,b],next,probability*(1-p));}
  visit([],initial,1);assert.equal(paths,32);assert.ok(Math.abs(expectedBracketGain(ids,e)-enumerated)<1e-10);
});
test('CC scores and invalid reports cannot affect the draw; probabilities, deterministic replay and eight orientations are auditable',()=>{
  const{candidates,pairs,policy}=data(),votes=balancedVotes(pairs,{count:3});
  const args={group:candidates,candidates,pairs,ballots:votes,policy,seed:'private fixture seed',drawId:'round-1'},a=drawActiveTournament(args);
  const changed=candidates.map(c=>({...c,cc_score:Math.random()*53,model_name:'irrelevant'}));
  assert.deepEqual(drawActiveTournament({...args,group:changed,candidates:changed,ballots:[...votes,{id:9999,pair_id:pairs[0].id,outcome:'unable'}]}),a);
  assert.ok(a.ordered_selection_probability>0);assert.equal(a.ordered_selection_probability,a.configuration_probability/8);
  assert.equal(a.sampling_evidence.observed_votes,votes.length);assert.equal(a.sampling_policy_hash,policy.content_hash);
  assert.equal(a.selection_probabilities.length,105);assert.equal(new Set(a.candidate_ids).size,4);
  const config=a.selection_probabilities.find(c=>c.candidate_ids.toSorted().join()===a.candidate_ids.toSorted().join()
    &&[c.candidate_ids.slice(0,2).toSorted().join(),c.candidate_ids.slice(2).toSorted().join()].toSorted().join('|')
      ===[a.candidate_ids.slice(0,2).toSorted().join(),a.candidate_ids.slice(2).toSorted().join()].toSorted().join('|'));
  assert.equal(config.probability,a.configuration_probability);
});

function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arena-active-')),snapshot={kind:'figma-human-arena-snapshot',version:3,name:'active fixture',protocol:tournamentProtocol({reviewers:2}),
    candidates:Array.from({length:2},(_,i)=>Array.from({length:7},(_,j)=>({id:hash(`${i}:${j}`).slice(0,24),case_id:`case-${i}`,title:`Task ${i}`,
      source_url:`https://www.figma.com/design/Source${i}/`,source_query:'Read 00, deliver in 03',model_id:`model-${j}`,model_name:`SECRET_MODEL_${j}`,
      run_id:`run-${i}-${j}`,workspace_id:'3:1',workspace_url:`https://www.figma.com/design/Output${i}m${j}/?page-id=3%3A1&node-id=3-1`,
      generation_ended:true,trace_status:'verified',screen_check:{passed:true},cc_score:j,cc_score_id:`score-${i}-${j}`,evidence_status:'live-view-required',images:[]}))).flat()};
  fs.writeFileSync(path.join(directory,'snapshot.json'),JSON.stringify(snapshot));let store=createArenaStore(directory,snapshot);
  t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  return{directory,snapshot,get store(){return store;},reopen(){store.close();store=createArenaStore(directory,snapshot);return store;}};
}
function vote(store,id){const p=store.next(id).pair;for(const side of ['A','B'])store.seen(id,p.id,side,'figma');store.vote(id,{pair_id:p.id,choice:'A'});}
test('switching policy preserves current assignment and ballots; only future tournaments use active sampling, with unchanged five-battle routing',t=>{
  const f=fixture(t);vote(f.store,'reviewer-1');const before=f.store.next('reviewer-1'),ballots=f.store.scopedBallots(),old=f.store.tournament.exported()[0];
  fs.writeFileSync(path.join(f.directory,'sampling-policy.json'),JSON.stringify(activeSamplingPolicy(f.store.digest)));
  f.reopen();assert.deepEqual(f.store.next('reviewer-1'),before);assert.deepEqual(f.store.scopedBallots(),ballots);
  assert.deepEqual(f.store.tournament.exported()[0],old);
  for(let i=1;i<5;i++)vote(f.store,'reviewer-1');const next=f.store.next('reviewer-1'),active=f.store.tournament.exported().at(-1);
  assert.notEqual(next.pair.case_id,before.pair.case_id);assert.equal(active.sampling,ACTIVE_SAMPLING);assert.equal(active.sampling_evidence.observed_votes,5);
  assert.equal(active.ordered_selection_probability,active.configuration_probability/8);
  assert.equal(f.store.scopedBallots().length,5);assert.equal(f.store.dashboard().ranking.method,'design-arena-bradley-terry-mm/v3');
  for(let i=0;i<5;i++)vote(f.store,'reviewer-1');assert.equal(f.store.scopedBallots().length,10);assert.equal(f.store.progress('reviewer-1').completed_sessions,2);
  const hashBefore=f.store.digest;assert.equal(f.reopen().digest,hashBefore);
});
test('sampling reads active human ballots only and reviewer API never exposes selection weights, strengths or other models',async t=>{
  const f=fixture(t);vote(f.store,'reviewer-2');fs.writeFileSync(path.join(f.directory,'reviewers.json'),JSON.stringify(seal({kind:'figma-arena-reviewers/v1',snapshot_hash:f.store.digest,active_reviewers:['reviewer-1']})));
  fs.writeFileSync(path.join(f.directory,'sampling-policy.json'),JSON.stringify(activeSamplingPolicy(f.store.digest)));f.reopen();
  const next=f.store.next('reviewer-1');assert.equal(f.store.tournament.exported().find(s=>s.reviewer_id==='reviewer-1').sampling_evidence.observed_votes,0);
  const server=createArenaApp(f.store,{publicAdmin:true}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`,login=await fetch(base+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({access:f.store.credentials.reviewers[0].access})});
  const cookie=login.headers.get('set-cookie').split(';')[0],review=await(await fetch(base+'/api/review/next',{headers:{cookie}})).json();
  assert.deepEqual(review,next);for(const secret of ['SECRET_MODEL','sampling_evidence','selection_probabilities','theta','cc_score','candidate_ids'])assert.ok(!JSON.stringify(review).includes(secret));
  const dashboard=await(await fetch(base+'/api/admin/dashboard')).json();assert.equal(dashboard.sampling.policy.algorithm,ACTIVE_SAMPLING);
});
test('configuration script backs up the real database and rejects policies bound to a different snapshot or invalid parameters',t=>{
  const f=fixture(t);vote(f.store,'reviewer-1');
  const result=spawnSync(process.execPath,[path.resolve('scripts/configure-arena-sampling.mjs'),'--directory',f.directory,'--algorithm','active'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout);assert.equal(receipt.preserved.ballots,1);assert.ok(fs.existsSync(path.join(receipt.archive,'arena.sqlite3')));
  assert.equal(readArenaSampling(f.directory,f.snapshot,f.store.digest).algorithm,ACTIVE_SAMPLING);
  fs.writeFileSync(path.join(f.directory,'sampling-policy.json'),JSON.stringify(activeSamplingPolicy('different')));
  assert.throws(()=>readArenaSampling(f.directory,f.snapshot,f.store.digest),/Invalid/);
  fs.writeFileSync(path.join(f.directory,'sampling-policy.json'),JSON.stringify(activeSamplingPolicy(f.store.digest,{exploration_fraction:0})));
  assert.throws(()=>readArenaSampling(f.directory,f.snapshot,f.store.digest),/parameters/);
});
