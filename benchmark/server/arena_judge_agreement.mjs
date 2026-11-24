import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rate=(n,d)=>d?n/d:null;

export function observedHumanComparisons(store){
  const excluded={unable:0,invalid:0,version_mismatch:0};
  const provenance=store.incremental?new Map(store.db.prepare(`SELECT v.ballot_id,v.pair_id,v.a,v.b,v.winner,v.outcome,v.active,
    s.id,s.reviewer_id,s.case_id,s.source_session_id,s.scope_hash,s.models
    FROM incremental_sort_votes v JOIN incremental_sort_sessions s ON s.id=v.session_id WHERE v.active=1`).all()
    .map(row=>[String(row.ballot_id),row])):null;
  const sessionCache=new Map(),votes=[];
  for(const ballot of store.scopedBallots()){
    if(!store.isActiveReviewer(ballot.reviewer_id))continue;
    const outcome=ballot.outcome||(ballot.winner_id?'win':'unable');
    if(outcome==='unable'){excluded.unable++;continue;}
    const pair=store.pairById.get(ballot.pair_id),a=store.candidates.get(pair?.first_id),b=store.candidates.get(pair?.second_id);
    if(!a||!b||a.id===b.id||a.model_id===b.model_id||a.case_id!==b.case_id||pair.case_id!==a.case_id
      ||!['win','tie'].includes(outcome)||outcome==='win'&&![a.id,b.id].includes(ballot.winner_id)
      ||outcome==='tie'&&ballot.winner_id!=null){excluded.invalid++;continue;}
    if(provenance){
      const source=provenance.get(String(ballot.id));
      if(!source||source.active!==1||source.reviewer_id!==ballot.reviewer_id||source.pair_id!==ballot.pair_id){excluded.invalid++;continue;}
      let models=sessionCache.get(source.id);
      if(models===undefined){
        try{
          const list=JSON.parse(source.models);
          const scope=hash({snapshot_hash:store.digest,case_id:source.case_id,reviewer_id:source.reviewer_id,
            session_id:source.source_session_id||source.id,models:list.toSorted((x,y)=>x.model_id.localeCompare(y.model_id))});
          models=scope===source.scope_hash?new Map(list.map(m=>[m.model_id,m])):null;
        }catch{models=null;}
        sessionCache.set(source.id,models);
      }
      const same=c=>{const m=models?.get(c.model_id);return m?.candidate_id===c.id&&m.version===hash([c.id,c.run_id,c.workspace_id,c.images.map(im=>im.sha256)]);};
      if(source.case_id!==pair.case_id||!same(a)||!same(b)){excluded.version_mismatch++;continue;}
      if(new Set([source.a,source.b]).size!==2||![a.model_id,b.model_id].every(m=>[source.a,source.b].includes(m))
        ||source.outcome!==outcome||outcome==='tie'&&source.winner!=null
        ||outcome==='win'&&source.winner!==store.candidates.get(ballot.winner_id).model_id){excluded.invalid++;continue;}
    }
    votes.push({ballot_id:ballot.id,reviewer_id:ballot.reviewer_id,case_id:pair.case_id,first_id:a.id,second_id:b.id,
      first_run_id:a.run_id,second_run_id:b.run_id,outcome:outcome==='tie'?'tie':ballot.winner_id===a.id?'first':'second'});
  }
  return {votes,excluded};
}

export function compareJudgesWithHumans(data,observed,{includeComparisons=false}={}){
  const candidates=new Map(data.rows.map(row=>[row.candidate_id,row]));
  const empty=()=>({compared:0,agreed:0,disagreed:0,machine_ties:0,human_ties:0,missing_scores:0});
  const counters=new Map(data.judges.map(j=>[j.id,{...empty(),cases:new Set(),pairs:new Set(),models:new Map(j.rows.map(m=>[m.model_id,empty()]))}]));
  const cases=new Set(),pairs=new Set(),reviewers=new Set(),seen=new Set(),records=[];
  let eligible=0,invalid=0;
  for(const vote of observed.votes){
    const a=candidates.get(vote.first_id),b=candidates.get(vote.second_id);
    if(seen.has(String(vote.ballot_id)))continue;
    seen.add(String(vote.ballot_id));
    if(!a||!b||a.candidate_id===b.candidate_id||a.model_id===b.model_id||a.case_id!==vote.case_id||b.case_id!==vote.case_id
      ||a.run_id!==vote.first_run_id||b.run_id!==vote.second_run_id||!['first','second','tie'].includes(vote.outcome)){invalid++;continue;}
    const pair=[a.candidate_id,b.candidate_id].sort().join(':');
    eligible++;cases.add(vote.case_id);pairs.add(pair);reviewers.add(vote.reviewer_id);
    const record={ballot_id:vote.ballot_id,reviewer_id:vote.reviewer_id,case_id:vote.case_id,
      first_model:a.model_name,second_model:b.model_name,first_candidate:a.candidate_id,second_candidate:b.candidate_id,
      first_run_id:a.run_id,second_run_id:b.run_id,human_outcome:vote.outcome};
    for(const judge of data.judges){
      const counter=counters.get(judge.id),x=a.scores[judge.id],y=b.scores[judge.id];
      const own=[counter,...[a.model_id,b.model_id].map(id=>counter.models.get(id))];
      if(x==null||y==null){for(const c of own)c.missing_scores++;record[judge.id+'_outcome']=null;record[judge.id+'_agrees']=null;continue;}
      const outcome=x===y?'tie':x>y?'first':'second',agrees=outcome===vote.outcome;
      for(const c of own){c.compared++;c.agreed+=Number(agrees);c.disagreed+=Number(!agrees);c.machine_ties+=Number(outcome==='tie');c.human_ties+=Number(vote.outcome==='tie');}
      counter.cases.add(vote.case_id);counter.pairs.add(pair);
      record[judge.id+'_outcome']=outcome;record[judge.id+'_agrees']=agrees;
    }
    if(includeComparisons)records.push(record);
  }
  const summary=c=>({...Object.fromEntries(Object.entries(c).filter(([k])=>!['cases','pairs','models'].includes(k))),agreement_rate:rate(c.agreed,c.compared)});
  return {...data,judges:data.judges.map(j=>{
    const counter=counters.get(j.id);
    return {...j,human_agreement:{...summary(counter),cases:counter.cases.size,unique_pairs:counter.pairs.size},
      rows:j.rows.map(m=>({...m,human_agreement:summary(counter.models.get(m.model_id))}))};
  }),human_agreement:{eligible_votes:eligible,cases:cases.size,unique_pairs:pairs.size,reviewers:reviewers.size,
    excluded:{...observed.excluded,invalid:(observed.excluded?.invalid||0)+invalid},
    rule:'Each effective actual overall human ballot counts once. Compare the same task, candidate IDs and run versions. Ties agree only with ties. Missing machine scores and unobserved human pairs are excluded.'},
    ...(includeComparisons?{human_comparisons:records}:{})};
}

export function withHumanJudgeAgreement(data,store,options){
  return compareJudgesWithHumans(data,observedHumanComparisons(store),options);
}
