import {arenaV4Comparison,validBallot,ballotOutcome} from './arena_protocol.mjs';

const rate=(n,d)=>d?n/d:null;
export function arenaTaskStatistics(candidates,pairs,votes,reviewers,tournaments=null){
  const byId=new Map(candidates.map(c=>[c.id,c])),byPair=new Map(pairs.map(p=>[p.id,p]));
  const labels=new Map(reviewers.map(r=>[r.id,r.label])),caseCount=new Set(candidates.map(c=>c.case_id)).size;
  const comparisons=arenaV4Comparison(candidates,pairs,votes).rows.map(r=>({...r,reviewer_name:labels.get(r.reviewer_id)||r.reviewer_id}));
  const tasks=[...Map.groupBy(candidates,c=>c.case_id)].sort(([a],[b])=>a.localeCompare(b)).map(([caseId,group])=>{
    const all=votes.filter(v=>byPair.get(v.pair_id)?.case_id===caseId),valid=all.filter(validBallot);
    const rows=comparisons.filter(r=>r.case_id===caseId),compared=rows.filter(r=>r.comparable),agreed=compared.filter(r=>r.agreement);
    const directional=compared.filter(r=>r.v4_preference!=='tie'),models=new Set(),uniquePairs=new Set();
    const counts=new Map(group.map(c=>[c.id,{wins:0,losses:0,ties:0,votes:0}]));
    for(const v of valid){const p=byPair.get(v.pair_id),ids=[p.first_id,p.second_id];uniquePairs.add(JSON.stringify(ids.toSorted()));
      for(const id of ids){models.add(byId.get(id).model_id);const x=counts.get(id);x.votes++;
        if(ballotOutcome(v)==='tie')x.ties++;else if(v.winner_id===id)x.wins++;else x.losses++;}}
    const sessions=(tournaments||[]).filter(t=>t.case_id===caseId),first=sessions.filter(t=>t.sequence<caseCount);
    const firstPairs=new Set(first.flatMap(t=>t.battles.map(b=>b.pair_id))),firstVotes=tournaments?valid.filter(v=>firstPairs.has(v.pair_id)).length:valid.length;
    const perReviewer=reviewers.map(r=>{const rv=all.filter(v=>v.reviewer_id===r.id),rc=rows.filter(v=>v.reviewer_id===r.id&&v.comparable),rs=first.filter(t=>t.reviewer_id===r.id);
      return{reviewer_id:r.id,reviewer_name:r.label,valid_votes:rv.filter(validBallot).length,unable:rv.filter(v=>!validBallot(v)).length,
        first_cycle_votes:tournaments?rv.filter(v=>validBallot(v)&&firstPairs.has(v.pair_id)).length:rv.filter(validBallot).length,
        first_cycle_complete:tournaments?rs.some(t=>t.complete):false,
        first_cycle_skipped:tournaments?rs.some(t=>t.skipped):false,
        agreed_votes:rc.filter(v=>v.agreement).length,comparable_votes:rc.length,agreement_rate:rate(rc.filter(v=>v.agreement).length,rc.length)};});
    const targetPerReviewer=tournaments?5:pairs.filter(p=>p.case_id===caseId).length,target=targetPerReviewer*reviewers.length;
    const complete=reviewers.length>0&&perReviewer.every(r=>tournaments?r.first_cycle_complete:r.first_cycle_votes>=targetPerReviewer);
    return{case_id:caseId,title:group[0].title,source_url:group[0].source_url,candidates:group.length,cc_scored:group.filter(c=>Number.isFinite(c.cc_score)).length,
      screenshots_ready:group.filter(c=>c.evidence_status==='cached-complete'&&c.images.length>0).length,
      valid_votes:valid.length,unable:all.length-valid.length,evaluated_models:models.size,unique_pairs:uniquePairs.size,possible_pairs:group.length*(group.length-1)/2,
      assigned_sessions:sessions.length,completed_sessions:sessions.filter(s=>s.complete).length,skipped_sessions:sessions.filter(s=>s.skipped).length,
      first_cycle_votes:firstVotes,first_cycle_target:target,
      first_cycle_completed_reviewers:perReviewer.filter(r=>r.first_cycle_complete).length,first_cycle_complete:complete,
      status:complete?'first-cycle-complete':first.some(s=>s.skipped)?'has-skips':valid.length||sessions.length?'in-progress':'not-started',
      comparable_votes:compared.length,agreed_votes:agreed.length,agreement_rate:rate(agreed.length,compared.length),
      missing_cc_votes:valid.length-compared.length,cc_tie_votes:compared.length-directional.length,
      directional_votes:directional.length,directional_agreed_votes:directional.filter(r=>r.agreement).length,
      directional_agreement_rate:rate(directional.filter(r=>r.agreement).length,directional.length),
      reviewers:perReviewer,models:group.map(c=>({...counts.get(c.id),model_id:c.model_id,model_name:c.model_name,run_id:c.run_id,
        cc_score:c.cc_score??null,workspace_url:c.workspace_url,images:c.images.length,screen_count:c.screen_check?.actual??null})),comparisons:rows};
  });
  const rated=tasks.filter(t=>t.valid_votes),comparable=tasks.filter(t=>t.comparable_votes);
  const sum=field=>tasks.reduce((n,t)=>n+t[field],0),agreed=sum('agreed_votes'),compared=sum('comparable_votes');
  return{method:'arena-task-statistics/v1',tasks,summary:{total_tasks:tasks.length,rated_tasks:rated.length,unrated_tasks:tasks.length-rated.length,
    first_cycle_completed_tasks:tasks.filter(t=>t.first_cycle_complete).length,reviewers:reviewers.length,
    first_cycle_votes:sum('first_cycle_votes'),first_cycle_target:sum('first_cycle_target'),valid_votes:sum('valid_votes'),unable:sum('unable'),
    comparable_votes:compared,agreed_votes:agreed,micro_agreement_rate:rate(agreed,compared),
    macro_agreement_rate:comparable.length?comparable.reduce((n,t)=>n+t.agreement_rate,0)/comparable.length:null,macro_tasks:comparable.length,
    missing_cc_votes:sum('missing_cc_votes'),cc_tie_votes:sum('cc_tie_votes'),directional_votes:sum('directional_votes'),
    directional_agreed_votes:sum('directional_agreed_votes'),directional_agreement_rate:rate(sum('directional_agreed_votes'),sum('directional_votes')),
    cc_scored:candidates.filter(c=>Number.isFinite(c.cc_score)).length,candidates:candidates.length,
    screenshots_ready:candidates.filter(c=>c.evidence_status==='cached-complete'&&c.images.length>0).length},
    rules:{micro:'All observed comparable ballots have equal weight; CC ties disagree with decisive human choices.',
      macro:'Unweighted mean of per-task agreement across tasks with comparable ballots; unreviewed tasks are excluded and reported.',
      first_cycle:'Five actual decisions per reviewer per task in the first shuffled task cycle; later cycles do not increase this numerator.',
      directional:'Agreement among comparable ballots where CC scores differ; CC ties are excluded and counted separately.'}};
}

export const taskCsvColumns=['case_id','title','candidates','cc_scored','screenshots_ready','status','first_cycle_votes','first_cycle_target',
  'first_cycle_complete','valid_votes','unable','evaluated_models','unique_pairs','possible_pairs','comparable_votes','agreed_votes',
  'agreement_rate','cc_tie_votes','directional_votes','directional_agreed_votes','directional_agreement_rate','missing_cc_votes'];
export function arenaCsv(columns,rows){
  const cell=v=>{let text=v===null||v===undefined?'':String(v);if(typeof v==='string'&&/^[=+\-@]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
  return '\uFEFF'+[columns,...rows.map(r=>columns.map(k=>r[k]))].map(r=>r.map(cell).join(',')).join('\r\n');
}
