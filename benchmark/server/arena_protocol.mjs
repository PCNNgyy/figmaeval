import { createHash } from 'node:crypto';
const hash = text => createHash('sha256').update(text).digest('hex');
const modelPair = (a,b) => JSON.stringify([a,b].sort());
export const validBallot = v => v.outcome ? v.outcome !== 'unable' : Boolean(v.winner_id);
export const ballotOutcome = v => v.outcome || (v.winner_id ? 'win' : 'unable');

export function balancedArenaPairs(candidates, perCase = 4) {
  const models = [...new Set(candidates.map(c => c.model_id))].sort(), exposure = new Map(models.map(m => [m,0])), opponents = new Map();
  const result = [];
  for (const [caseId,group] of [...Map.groupBy(candidates,c=>c.case_id)].sort(([a],[b])=>a.localeCompare(b))) {
    group.sort((a,b)=>a.model_id.localeCompare(b.model_id));
    const edges=[];for(let i=0;i<group.length;i++)for(let j=i+1;j<group.length;j++)edges.push([group[i],group[j]]);
    const count=Math.min(perCase,edges.length), maxDegree=Math.ceil(2*count/group.length);
    if(!count||2*count<group.length)throw Error('Pair budget cannot cover every available model');
    let best=null;
    function choose(at,chosen,degrees){
      if(chosen.length===count){
        if(group.some(c=>!degrees.get(c.model_id)))return;
        const totals=models.map(m=>exposure.get(m)+(degrees.get(m)||0));
        const score=[Math.max(...totals)-Math.min(...totals),totals.reduce((s,n)=>s+n*n,0),
          chosen.reduce((s,[a,b])=>{const n=opponents.get(modelPair(a.model_id,b.model_id))||0;return s+2*n+1;},0)];
        const tie=hash(`${caseId}:${chosen.map(([a,b])=>[a.id,b.id].sort().join(':')).join('|')}`);
        const order=best?score.findIndex((n,i)=>n!==best.score[i]):-1;
        if(!best||order>=0&&score[order]<best.score[order]||order<0&&tie<best.tie)best={chosen:[...chosen],score,tie};
        return;
      }
      for(let i=at;i<=edges.length-(count-chosen.length);i++){
        const edge=edges[i];if(edge.some(c=>(degrees.get(c.model_id)||0)>=maxDegree))continue;
        const next=new Map(degrees);for(const c of edge)next.set(c.model_id,(next.get(c.model_id)||0)+1);
        choose(i+1,[...chosen,edge],next);
      }
    }
    choose(0,[],new Map());if(!best)throw Error('No balanced same-task pairing covers every model');
    for(const[a,b]of best.chosen){
      const ids=[a.id,b.id].sort();result.push({id:hash(`${caseId}:${ids[0]}:${ids[1]}`).slice(0,24),case_id:caseId,first_id:ids[0],second_id:ids[1]});
      for(const c of[a,b])exposure.set(c.model_id,exposure.get(c.model_id)+1);
      const k=modelPair(a.model_id,b.model_id);opponents.set(k,(opponents.get(k)||0)+1);
    }
  }
  return result;
}

export function validateArenaProtocol(snapshot) {
  const p=snapshot.protocol, byId=new Map(snapshot.candidates.map(c=>[c.id,c]));
  if(p?.kind!=='design-arena-b2/v2'||p.pairs_per_case!==4||p.reviewers!==2||p.tie_credit!==0.5
    ||!Array.isArray(p.pairs)||!p.pairs.length)throw Error('Invalid B2 arena protocol');
  const seen=new Set();
  for(const pair of p.pairs){const a=byId.get(pair.first_id),b=byId.get(pair.second_id);
    if(!a||!b||a.id===b.id||a.case_id!==b.case_id||pair.case_id!==a.case_id||seen.has(pair.id)
      ||pair.first_id>=pair.second_id||pair.id!==hash(`${pair.case_id}:${pair.first_id}:${pair.second_id}`).slice(0,24))throw Error('Invalid same-task frozen pair');seen.add(pair.id);}
  for(const[caseId,group]of Map.groupBy(snapshot.candidates,c=>c.case_id)){
    const pairs=p.pairs.filter(x=>x.case_id===caseId),expected=Math.min(4,group.length*(group.length-1)/2);
    if(pairs.length!==expected||group.some(c=>!pairs.some(x=>x.first_id===c.id||x.second_id===c.id)))throw Error('B2 pairs do not cover every available model');
  }
}

export function pairwiseRankings(candidates,pairs,votes) {
  const byId=new Map(candidates.map(c=>[c.id,c])), pairById=new Map(pairs.map(p=>[p.id,p]));
  const models=new Map();for(const c of candidates){if(!models.has(c.model_id))models.set(c.model_id,{model_id:c.model_id,model_name:c.model_name,candidates:0,wins:0,losses:0,ties:0,skipped:0,cases:new Set(),opponents:new Set()});models.get(c.model_id).candidates++;}
  const matrix=new Map();
  for(const v of votes){const p=pairById.get(v.pair_id);if(!p)throw Error('Unknown comparison');const a=byId.get(p.first_id),b=byId.get(p.second_id),ma=models.get(a.model_id),mb=models.get(b.model_id);
    if(!validBallot(v)){ma.skipped++;mb.skipped++;continue;}
    for(const[m,c,o]of[[ma,a,b],[mb,b,a]]){m.cases.add(c.case_id);m.opponents.add(o.model_id);}
    if(ballotOutcome(v)==='tie'){ma.ties++;mb.ties++;continue;}
    if(![a.id,b.id].includes(v.winner_id))throw Error('Winner does not belong to the comparison');
    const winner=v.winner_id===a.id?ma:mb,loser=winner===ma?mb:ma;winner.wins++;loser.losses++;
    const key=`${winner.model_id}:${loser.model_id}`;matrix.set(key,(matrix.get(key)||0)+1);
  }
  const rows=[...models.values()].map(m=>{const n=m.wins+m.losses+m.ties,rate=n?(m.wins+0.5*m.ties)/n:null;
    return{...m,cases:undefined,opponents:m.opponents.size,evaluated_cases:m.cases.size,votes:n,win_rate:rate,score:rate===null?null:rate*100,
      sigma:null,lower:null,upper:null,case_mean:null};}).sort((a,b)=>(b.score??-Infinity)-(a.score??-Infinity)||a.model_name.localeCompare(b.model_name));
  let rank=null;for(const[r,m]of rows.entries()){if(m.votes&&(r===0||m.score!==rows[r-1].score))rank=r+1;m.rank=m.votes?rank:null;}
  const visited=new Set(),start=rows.find(r=>r.votes)?.model_id;
  const visit=id=>{if(visited.has(id))return;visited.add(id);for(const other of models.get(id).opponents)visit(other);};if(start)visit(start);
  let compared=0,agreed=0;for(const p of pairs){const rated=votes.filter(v=>v.pair_id===p.id&&validBallot(v));if(rated.length>=2){compared++;if(rated.every(v=>ballotOutcome(v)===ballotOutcome(rated[0])&&v.winner_id===rated[0].winner_id))agreed++;}}
  return{rows,matrix:Object.fromEntries(matrix),agreement:{compared,agreed,rate:compared?agreed/compared:null},connected:Boolean(start&&visited.size===models.size),
    method:'balanced-pairwise-win-rate/v2',explanation:'每题最多4组匿名比较，覆盖该题全部可用模型；两位设计师独立评价。胜率=(胜票+0.5×平局票)/有效票，无效票不计入分母；相同胜率并列排名。尚未收齐预定票数时为阶段结果。'};
}

export function arenaV4Comparison(candidates,pairs,votes) {
  const byId=new Map(candidates.map(c=>[c.id,c])),byPair=new Map(pairs.map(p=>[p.id,p]));
  const rows=votes.map(v=>{const p=byPair.get(v.pair_id),a=byId.get(p.first_id),b=byId.get(p.second_id);
    const comparable=validBallot(v)&&Number.isFinite(a.cc_score)&&Number.isFinite(b.cc_score);
    const human=!validBallot(v)?'invalid':ballotOutcome(v)==='tie'?'tie':v.winner_id===a.id?'first':'second';
    const cc=comparable?a.cc_score===b.cc_score?'tie':a.cc_score>b.cc_score?'first':'second':null;
    return{pair_id:p.id,case_id:p.case_id,reviewer_id:v.reviewer_id,human_preference:human,
      first_model:a.model_name,first_model_id:a.model_id,first_run_id:a.run_id,first_url:a.workspace_url,first_v4:a.cc_score??null,
      second_model:b.model_name,second_model_id:b.model_id,second_run_id:b.run_id,second_url:b.workspace_url,second_v4:b.cc_score??null,
      v4_preference:cc,comparable,agreement:comparable?human===cc:null,reason:v.reason,comment:v.comment,created_at:v.created_at,requirements_hash:v.requirements_hash??null};});
  const valid=rows.filter(r=>r.human_preference!=='invalid'),comparable=rows.filter(r=>r.comparable),agreed=comparable.filter(r=>r.agreement).length;
  return{rows,summary:{valid_votes:valid.length,comparable_votes:comparable.length,missing_v4_votes:valid.length-comparable.length,
    agreed_votes:agreed,agreement_rate:comparable.length?agreed/comparable.length:null,rule:'Exact preference agreement; equal v4 scores count as tie; invalid votes and missing v4 scores are excluded'}};
}
