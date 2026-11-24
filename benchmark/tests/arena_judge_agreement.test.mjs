import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {compareJudgesWithHumans,observedHumanComparisons} from '../server/arena_judge_agreement.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const models=['a','b','c'];
const data={judges:[{id:'j',rows:models.map(model_id=>({model_id}))},{id:'missing',rows:models.map(model_id=>({model_id}))}],
  rows:models.map((id,i)=>({candidate_id:id,case_id:'task',model_id:id,model_name:id,run_id:'run-'+id,scores:{j:[10,20,20][i],missing:i===0?null:20}}))};
const vote=(id,first='a',second='b',outcome='second')=>({ballot_id:id,reviewer_id:'reviewer',case_id:'task',first_id:first,second_id:second,first_run_id:'run-'+first,second_run_id:'run-'+second,outcome});
const observed=votes=>({votes,excluded:{unable:0,invalid:0,version_mismatch:0}});

test('agreement counts only observed ballots and exact ties, handles reversed sides and missing scores',()=>{
  const votes=[vote(1),vote(2,'b','a','first'),vote(3,'b','c','tie'),vote(4,'b','c','first'),vote(4,'b','c','first')];
  const result=compareJudgesWithHumans(data,observed(votes),{includeComparisons:true});
  assert.equal(result.human_agreement.eligible_votes,4); assert.equal(result.human_agreement.unique_pairs,2);
  const [j,missing]=result.judges;
  assert.equal(j.human_agreement.compared,4); assert.equal(j.human_agreement.agreed,3);
  assert.equal(j.human_agreement.agreement_rate,.75); assert.equal(j.human_agreement.machine_ties,2);
  assert.equal(missing.human_agreement.missing_scores,2); assert.equal(missing.human_agreement.compared,2);
  assert.equal(missing.human_agreement.agreement_rate,.5); assert.equal(result.human_comparisons.length,4);
  assert.equal(result.human_comparisons[1].j_outcome,'first');
  assert.equal(j.rows[0].human_agreement.compared,2);
  assert.equal(data.judges[0].human_agreement,undefined);
});

test('unreviewed pairs and other task or run versions never enter agreement; empty samples are null',()=>{
  const invalid=[{...vote(1),case_id:'other'}, {...vote(2),first_run_id:'old-run'},vote(3,'a','a')];
  const r=compareJudgesWithHumans(data,observed(invalid));
  assert.equal(r.human_agreement.eligible_votes,0); assert.equal(r.human_agreement.excluded.invalid,3);
  assert.ok(r.judges.every(j=>j.human_agreement.agreement_rate===null&&j.human_agreement.compared===0));
  const actual=compareJudgesWithHumans(data,observed([vote(4)]));
  assert.equal(actual.judges[0].human_agreement.compared,1);
  assert.equal(r.judges[0].human_agreement.compared,0);
});

function storeFixture(){
  const candidates=new Map(models.map(id=>[id,{id,case_id:'task',model_id:id,run_id:'run-'+id,workspace_id:'w-'+id,images:[{sha256:'image-'+id}]}]));
  const members=[...candidates.values()].map(c=>({model_id:c.model_id,candidate_id:c.id,version:hash([c.id,c.run_id,c.workspace_id,c.images.map(i=>i.sha256)])}));
  const session={id:'session',reviewer_id:'reviewer',case_id:'task',source_session_id:null,models:JSON.stringify(members)};
  session.scope_hash=hash({snapshot_hash:'snapshot',case_id:'task',reviewer_id:'reviewer',session_id:'session',models:members.toSorted((a,b)=>a.model_id.localeCompare(b.model_id))});
  const sources=[1,2,3,4,5].map(id=>({...session,ballot_id:id,pair_id:'pair',a:'a',b:'b',winner:'b',outcome:'win',active:1}));
  const ballots=[1,2,3,4,5,6,7].map(id=>({id,reviewer_id:'reviewer',pair_id:'pair',outcome:'win',winner_id:'b'}));
  ballots[2].reviewer_id='disabled';
  ballots[3].outcome='unable';ballots[3].winner_id=null;
  sources[4].models=JSON.stringify(members.map(m=>({...m,version:'old'})));sources[4].id='stale-session';
  sources[1].active=0;
  const store={digest:'snapshot',incremental:{},candidates,pairById:new Map([['pair',{id:'pair',case_id:'task',first_id:'a',second_id:'b'}]]),
    isActiveReviewer:id=>id==='reviewer',scopedBallots:()=>ballots,
    db:{prepare:()=>({all:()=>sources.filter(s=>s.active===1)})}};
  return {store,sources,ballots};
}

test('actual effective overall votes require active provenance, reviewer, and exact snapshot/candidate versions',()=>{
  const {store}=storeFixture(),r=observedHumanComparisons(store);
  assert.deepEqual(r.votes.map(v=>v.ballot_id),[1]);
  assert.equal(r.excluded.unable,1); assert.equal(r.excluded.version_mismatch,1);
  assert.equal(r.excluded.invalid,3);
  assert.equal(r.votes[0].outcome,'second');
});
