import test from 'node:test';
import assert from 'node:assert/strict';
import {arenaTaskStatistics,arenaCsv,taskCsvColumns} from '../server/arena_statistics.mjs';
const reviewers=[{id:'r1',label:'甲'},{id:'r2',label:'乙'}];
function fixture(){
  const candidates=Array.from({length:3},(_,i)=>Array.from({length:4},(_,j)=>({id:`${i}-${j}`,case_id:`case-${i}`,title:`Task ${i}`,
    model_id:`m${j}`,model_name:`Model ${j}`,cc_score:j,images:[{}],evidence_status:'cached-complete'}))).flat();
  const pairs=candidates.filter(c=>c.id.endsWith('-0')).flatMap((c,i)=>Array.from({length:3},(_,j)=>({id:`p${i}${j}`,case_id:c.case_id,first_id:c.id,second_id:`${i}-${j+1}`})));
  return{candidates,pairs};
}
const vote=(pair,first=false,reviewer='r1')=>({pair_id:pair.id,reviewer_id:reviewer,outcome:'win',winner_id:first?pair.first_id:pair.second_id});
test('per-task numerators distinguish micro from macro and leave unrated tasks undefined',()=>{
  const{candidates,pairs}=fixture(),votes=[vote(pairs[0]),vote(pairs[1]),vote(pairs[2]),vote(pairs[3],true)];
  const result=arenaTaskStatistics(candidates,pairs,votes,reviewers);
  assert.equal(result.summary.micro_agreement_rate,.75);assert.equal(result.summary.macro_agreement_rate,.5);
  assert.equal(result.summary.rated_tasks,2);assert.equal(result.summary.unrated_tasks,1);assert.equal(result.summary.macro_tasks,2);
  assert.equal(result.tasks[0].agreement_rate,1);assert.equal(result.tasks[0].evaluated_models,4);assert.equal(result.tasks[0].unique_pairs,3);
  assert.equal(result.tasks[2].agreement_rate,null);assert.equal(result.tasks[2].valid_votes,0);assert.equal(result.tasks[2].cc_scored,4);
});
test('CC ties, missing scores, invalid feedback and true zero scores have separate denominators',()=>{
  const{candidates,pairs}=fixture();candidates[1].cc_score=0;candidates[2].cc_score=null;
  const votes=[vote(pairs[0]),vote(pairs[1]),{...vote(pairs[2]),outcome:'unable',winner_id:null},vote(pairs[3])];
  const result=arenaTaskStatistics(candidates,pairs,votes,reviewers);
  assert.equal(result.summary.valid_votes,3);assert.equal(result.summary.unable,1);assert.equal(result.summary.comparable_votes,2);
  assert.equal(result.summary.cc_tie_votes,1);assert.equal(result.summary.missing_cc_votes,1);
  assert.equal(result.summary.micro_agreement_rate,.5);assert.equal(result.summary.directional_agreement_rate,1);
  assert.equal(result.tasks[0].cc_scored,3);assert.equal(result.tasks[0].models[0].cc_score,0);
});
test('only actual first-cycle ballots count toward progress, and each reviewer remains independent',()=>{
  const{candidates,pairs}=fixture();const repeats=Array.from({length:7},(_,i)=>({...pairs[0],id:`actual-${i}`}));pairs.push(...repeats);
  const votes=repeats.map(p=>vote(p));
  const tournaments=[{case_id:'case-0',reviewer_id:'r1',sequence:0,complete:true,battles:repeats.slice(0,5).map(p=>({pair_id:p.id}))},
    {case_id:'case-0',reviewer_id:'r1',sequence:3,complete:false,battles:repeats.slice(5).map(p=>({pair_id:p.id}))}];
  const result=arenaTaskStatistics(candidates,pairs,votes,reviewers,tournaments),task=result.tasks[0];
  assert.equal(task.valid_votes,7);assert.equal(task.first_cycle_votes,5);assert.equal(task.first_cycle_target,10);
  assert.equal(task.first_cycle_completed_reviewers,1);assert.equal(task.first_cycle_complete,false);
  assert.equal(task.evaluated_models,2);assert.equal(task.unique_pairs,1);assert.equal(task.possible_pairs,6);
  assert.equal(task.reviewers[0].valid_votes,7);assert.equal(task.reviewers[1].valid_votes,0);
  assert.equal(result.summary.first_cycle_target,30);
});
test('a fully completed four-model session is not seven-model coverage, and no-vote summaries stay null',()=>{
  const{candidates,pairs}=fixture();const result=arenaTaskStatistics(candidates,pairs,[],reviewers,[]);
  assert.equal(result.summary.micro_agreement_rate,null);assert.equal(result.summary.macro_agreement_rate,null);
  assert.equal(result.summary.first_cycle_votes,0);assert.equal(result.summary.first_cycle_completed_tasks,0);
  const csv=arenaCsv(taskCsvColumns,[{case_id:'=1+1',title:'行,含"引号"',agreement_rate:null}]);
  assert.ok(csv.includes("'=1+1"));assert.ok(csv.includes('行,含""引号""'));assert.ok(!csv.includes('null'));
});
