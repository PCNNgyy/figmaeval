import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { balancedArenaPairs, pairwiseRankings, arenaV4Comparison, validateArenaProtocol } from '../server/arena_protocol.mjs';
import { createArenaStore,createArenaApp,validateArenaSnapshot } from '../server/benchmark_arena.mjs';
import { seal } from '../server/benchmark_protocol.mjs';
import { requirementsHash, readArenaRequirements, requirementLiterals } from '../server/arena_requirements.mjs';

const hash=s=>createHash('sha256').update(s).digest('hex').slice(0,24);
function snapshot(cases=2){
  const candidates=Array.from({length:cases},(_,i)=>Array.from({length:7},(_,j)=>({id:hash(`${i}:${j}`),case_id:`case-${String(i+1).padStart(3,'0')}`,
    title:`Task ${i}`,source_query:'Read the task and create the design in 03',source_url:`https://www.figma.com/design/Source${i}/`,
    model_id:`model-${j}`,model_name:`HIDDEN_MODEL_${j}`,run_id:`run-${i}-${j}`,workspace_id:'3:1',
    workspace_url:`https://www.figma.com/design/Output${i}m${j}/?page-id=3%3A1&node-id=3-1`,
    trace_status:'verified',generation_ended:true,screen_check:{passed:true,expected:1,actual:1},cc_score:j*5,cc_score_id:`score-${i}-${j}`,
    evidence_status:'live-view-required',images:[]}))).flat();
  return{kind:'figma-human-arena-snapshot',version:2,name:'B2 fixture',candidates,
    protocol:{kind:'design-arena-b2/v2',pairs_per_case:4,reviewers:2,tie_credit:0.5,pairs:balancedArenaPairs(candidates)}};
}
function fixture(t,s=snapshot(),withRequirements=false){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arena-b2-'));
  if(withRequirements){
    const cases=[...new Map(s.candidates.map(c=>[c.case_id,c])).values()].map(c=>{
      const pages=['00 · Start Here','01 · Foundations'].map((name,i)=>({id:`${i}:1`,name,text_count:1,coverage_complete:true,
        sections:[{kind:'group',id:`${i}:2`,name:'THE ASSIGNMENT',blocks:[{kind:'text',id:`${i}:3`,text:i?'Use #FF8660':'Create 01_Home'}]}]}));
      return{case_id:c.case_id,title:c.title,source_url:c.source_url,pages,source_sha256:requirementsHash(pages),required_frames:['01_Home'],translations:{'0:3':'创建 01_Home 主页','1:3':'使用颜色 #FF8660'}};
    });
    fs.writeFileSync(path.join(directory,'requirements-zh.json'),JSON.stringify(seal({kind:'figma-arena-requirements/v1',language:'zh-CN',snapshot_hash:requirementsHash(s),translation_model:'TRANSLATOR_MUST_STAY_PRIVATE',cases})));
  }
  const store=createArenaStore(directory,s);
  t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});return{directory,store,snapshot:s};
}
function viewBoth(store,reviewer,pair){for(const side of ['A','B'])store.seen(reviewer,pair.id,side,'figma');}

test('30 tasks with seven models and one missing output create exactly120 pairs, cover every available model, and balance exposures',()=>{
  const s=snapshot(30);s.candidates=s.candidates.filter(c=>!(c.case_id==='case-024'&&c.model_id==='model-5'));
  const pairs=balancedArenaPairs(s.candidates),again=balancedArenaPairs([...s.candidates].reverse());
  assert.equal(pairs.length,120);assert.deepEqual(pairs,again);
  const counts=new Map();for(const p of pairs)for(const id of [p.first_id,p.second_id]){const c=s.candidates.find(c=>c.id===id);assert.equal(c.case_id,p.case_id);counts.set(c.model_id,(counts.get(c.model_id)||0)+1);}
  assert.ok(Math.max(...counts.values())-Math.min(...counts.values())<=1);
  s.protocol.pairs=pairs;assert.doesNotThrow(()=>validateArenaProtocol(s));
  for(const c of s.candidates)assert.ok(pairs.some(p=>p.first_id===c.id||p.second_id===c.id));
  s.protocol.pairs[0].case_id='wrong-case';assert.throws(()=>validateArenaProtocol(s),/same-task/);
});

test('ties require both views, remain valid and idempotent, and are never requeued as invalid',t=>{
  const {store}=fixture(t),reviewer='reviewer-1',pair=store.next(reviewer).pair;
  assert.throws(()=>store.vote(reviewer,{pair_id:pair.id,choice:'tie'}),/完整查看/);
  viewBoth(store,reviewer,pair);store.vote(reviewer,{pair_id:pair.id,choice:'tie'});
  assert.equal(store.vote(reviewer,{pair_id:pair.id,choice:'tie'}).duplicate,true);
  assert.equal(store.progress(reviewer).voted,1);assert.equal(store.progress(reviewer).ties,1);assert.equal(store.retrySkipped(reviewer).requeued,0);
  assert.throws(()=>store.vote(reviewer,{pair_id:pair.id,choice:'unable',reason:'access'}),/已提交/);
  const second=store.next(reviewer).pair;store.vote(reviewer,{pair_id:second.id,choice:'unable',reason:'access'});
  assert.equal(store.progress(reviewer).voted,1);assert.equal(store.retrySkipped(reviewer).requeued,1);assert.equal(store.progress(reviewer).ties,1);
});

test('two independent tie ballots per pair yield equal50% ranks and full agreement, with no invented v4 preference agreement',t=>{
  const {store}=fixture(t);
  for(const reviewer of ['reviewer-1','reviewer-2'])for(let next;(next=store.next(reviewer).pair);){viewBoth(store,reviewer,next);store.vote(reviewer,{pair_id:next.id,choice:'tie'});}
  const d=store.dashboard();assert.equal(d.valid_votes,16);assert.equal(d.unable,0);assert.equal(d.ties,16);
  assert.equal(d.ranking.agreement.rate,1);assert.ok(d.ranking.rows.every(r=>r.win_rate===0.5&&r.rank===1&&r.wins===0&&r.losses===0));
  assert.equal(d.v4_comparison.comparable_votes,16);assert.equal(d.v4_comparison.agreement_rate,0);
  assert.equal(d.daily_statistics.pairs,8);assert.equal(d.daily_statistics.models,7);
  assert.ok(d.coverage.every(c=>c.pairs===4&&c.votes===8));
  assert.equal(d.coverage.reduce((n,c)=>n+c.pairs,0),d.snapshot.pairs);
});

test('V4 comparison preserves real zeroes, exact ties, and missing score/invalid exclusions',()=>{
  const s=snapshot(1),p=s.protocol.pairs[0],a=s.candidates.find(c=>c.id===p.first_id),b=s.candidates.find(c=>c.id===p.second_id);
  a.cc_score=0;b.cc_score=0;const votes=[{pair_id:p.id,reviewer_id:'r1',outcome:'tie',winner_id:null},{pair_id:p.id,reviewer_id:'r2',outcome:'unable',winner_id:null}];
  let d=arenaV4Comparison(s.candidates,s.protocol.pairs,votes);assert.equal(d.summary.comparable_votes,1);assert.equal(d.summary.agreement_rate,1);assert.equal(d.rows[0].first_v4,0);
  b.cc_score=null;d=arenaV4Comparison(s.candidates,s.protocol.pairs,votes);assert.equal(d.summary.comparable_votes,0);assert.equal(d.summary.missing_v4_votes,1);assert.equal(d.rows[0].agreement,null);
});

test('anonymous B2 API exposes four choices and never exposes model identities or CC scores; admin exports remain protected',async t=>{
  const {store}=fixture(t),server=createArenaApp(store).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>new Promise(r=>server.close(r)));const base=`http://127.0.0.1:${server.address().port}`;
  const login=async access=>{const r=await fetch(base+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({access})});return r.headers.get('set-cookie').split(';')[0];};
  const cookie=await login(store.credentials.reviewers[0].access),next=await(await fetch(base+'/api/review/next',{headers:{cookie}})).json();
  assert.deepEqual(next.choices,['A','B','tie','unable']);for(const text of ['HIDDEN_MODEL','cc_score','run_id','model_id','v4'])assert.ok(!JSON.stringify(next).includes(text));
  assert.equal((await fetch(base+'/api/admin/export.csv',{headers:{cookie}})).status,403);
  viewBoth(store,'reviewer-1',next.pair);store.vote('reviewer-1',{pair_id:next.pair.id,choice:'tie',comment:'=DANGER()'});
  const admin=await login(store.credentials.admin),r=await fetch(base+'/api/admin/export.csv',{headers:{cookie:admin}}),csv=await r.text();
  assert.equal(r.status,200);assert.match(csv,/'=DANGER\(\)/);assert.match(csv,/first_v4/);
  const exported=await(await fetch(base+'/api/admin/export',{headers:{cookie:admin}})).json();assert.equal(exported.human_v4.rows.length,1);
});

test('snapshot distinguishes interrupted-trace provenance without silently certifying it, and rejects missing qualification',t=>{
  const f=fixture(t),s=structuredClone(f.snapshot);s.candidates[0].trace_status='verified_prefix_terminal_results_missing';assert.doesNotThrow(()=>validateArenaSnapshot(s,f.directory));
  s.candidates[0].generation_ended=false;assert.throws(()=>validateArenaSnapshot(s,f.directory),/unverified/);
});

test('original Chinese requirements are source-bound and shared by both drafts; stale pages cannot submit new votes',t=>{
  const{store,directory}=fixture(t,snapshot(),true),next=store.next('reviewer-1'),req=next.pair.requirements;
  assert.equal(req.source_url,next.pair.source_url);assert.equal(req.required_frames[0],'01_Home');
  assert.equal(req.pages[0].sections[0].blocks[0].zh,'创建 01_Home 主页');
  assert.ok(!JSON.stringify(req).includes('TRANSLATOR_MUST_STAY_PRIVATE'));
  viewBoth(store,'reviewer-1',next.pair);
  assert.throws(()=>store.vote('reviewer-1',{pair_id:next.pair.id,choice:'tie'}),/需求已更新/);
  const body={pair_id:next.pair.id,choice:'tie',requirements_hash:req.version};
  store.vote('reviewer-1',body);assert.equal(store.vote('reviewer-1',body).duplicate,true);
  assert.equal(store.db.prepare('SELECT requirements_hash FROM ballots').get().requirements_hash,req.version);
  const file=path.join(directory,'requirements-zh.json'),{content_hash,...bundle}=JSON.parse(fs.readFileSync(file));
  bundle.cases[0].source_url='https://www.figma.com/design/OtherSource/';fs.writeFileSync(file,JSON.stringify(seal(bundle)));
  assert.throws(()=>readArenaRequirements(directory,store.snapshot,store.digest),/mismatched original/);
});

test('incomplete translations and a different arena version cannot be presented as original task requirements',t=>{
  const{store,directory}=fixture(t,snapshot(),true),file=path.join(directory,'requirements-zh.json'),{content_hash,...original}=JSON.parse(fs.readFileSync(file));
  const incomplete=structuredClone(original);delete incomplete.cases[0].translations['0:3'];fs.writeFileSync(file,JSON.stringify(seal(incomplete)));
  assert.throws(()=>readArenaRequirements(directory,store.snapshot,store.digest),/Incomplete/);
  const changed=structuredClone(original);changed.snapshot_hash='another-arena';fs.writeFileSync(file,JSON.stringify(seal(changed)));
  assert.throws(()=>readArenaRequirements(directory,store.snapshot,store.digest),/frozen arena/);
  const english=structuredClone(original),item=english.cases[0];
  item.pages[0].sections[0].blocks[0].text='Design the complete portfolio page with projects, experience and contact details in 01_Home.';
  item.translations['0:3']=item.pages[0].sections[0].blocks[0].text;item.source_sha256=requirementsHash(item.pages);
  fs.writeFileSync(file,JSON.stringify(seal(english)));assert.throws(()=>readArenaRequirements(directory,store.snapshot,store.digest),/Chinese translation/);
});

test('translation preserves values without mistaking date commas for thousands separators',()=>{
  const tokens=requirementLiterals('Nov 20,2022; amount 20,202.00; 01_Home; #FF8660; team@example.com');
  for(const t of ['20','2022','20,202.00','01_Home','#FF8660','team@example.com'])assert.ok(tokens.includes(t));
  assert.ok(!tokens.includes('20,2022'));assert.ok(!tokens.includes('20,202'));
});
