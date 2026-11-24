import fs from 'node:fs';
import path from 'node:path';
import {createHash,createHmac} from 'node:crypto';
import {seal,verifySeal} from './benchmark_protocol.mjs';
import {tournamentState} from './arena_bracket.mjs';

export const ACTIVE_SAMPLING='active-fisher-information/v1';
export const UNIFORM_SAMPLING='uniform-four-without-replacement';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sigmoid=x=>x>=0?1/(1+Math.exp(-x)):Math.exp(x)/(1+Math.exp(x));
export function activeSamplingPolicy(snapshotHash,extra={}){
  return seal({kind:'figma-arena-sampling/v1',snapshot_hash:snapshotHash,algorithm:ACTIVE_SAMPLING,
    exploration_fraction:.2,temperature:.05,prior_precision:1,map_max_iterations:50,map_tolerance:1e-8,
    objective:'expected-five-battle-local-fisher-logdet-gain',evidence:'active-reviewers-observed-human-wins-only',
    implementation:'local-adaptation-of-published-principles',reference:'https://notes.designarena.ai/methodology/',...extra});
}
export function readArenaSampling(directory,snapshot,snapshotHash){
  const file=path.join(directory,'sampling-policy.json');
  if(!fs.existsSync(file))return seal({kind:'figma-arena-sampling/v1',snapshot_hash:snapshotHash,algorithm:UNIFORM_SAMPLING});
  const p=verifySeal(JSON.parse(fs.readFileSync(file,'utf8')));
  if(snapshot.version!==3||p.kind!=='figma-arena-sampling/v1'||p.snapshot_hash!==snapshotHash
    ||![ACTIVE_SAMPLING,UNIFORM_SAMPLING].includes(p.algorithm))throw Error('Invalid arena sampling policy');
  if(p.algorithm===ACTIVE_SAMPLING){
    const expected=activeSamplingPolicy(snapshotHash);
    for(const key of ['objective','evidence','implementation','reference','map_max_iterations','map_tolerance'])if(p[key]!==expected[key])throw Error('Unsupported active sampling policy');
    if(!Number.isFinite(p.exploration_fraction)||p.exploration_fraction<=0||p.exploration_fraction>1
      ||!Number.isFinite(p.temperature)||p.temperature<=0||p.temperature>10
      ||!Number.isFinite(p.prior_precision)||p.prior_precision<.001||p.prior_precision>100)throw Error('Invalid active sampling parameters');
  }
  return p;
}
function inverse(matrix){
  const n=matrix.length,a=matrix.map((row,i)=>[...row,...Array.from({length:n},(_,j)=>Number(i===j))]);
  for(let k=0;k<n;k++){
    let pivot=k;for(let i=k+1;i<n;i++)if(Math.abs(a[i][k])>Math.abs(a[pivot][k]))pivot=i;
    [a[k],a[pivot]]=[a[pivot],a[k]];const v=a[k][k];if(!Number.isFinite(v)||Math.abs(v)<1e-14)throw Error('Sampling information matrix is singular');
    for(let j=0;j<2*n;j++)a[k][j]/=v;
    for(let i=0;i<n;i++)if(i!==k){const f=a[i][k];for(let j=0;j<2*n;j++)a[i][j]-=f*a[k][j];}
  }
  return a.map(row=>row.slice(n));
}
function information(theta,counts,precision){
  const n=theta.length,m=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?precision:0));
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){const p=sigmoid(theta[i]-theta[j]),w=counts[i][j]*p*(1-p);
    m[i][i]+=w;m[j][j]+=w;m[i][j]-=w;m[j][i]-=w;}
  return m;
}
export function samplingEvidence(candidates,pairs,ballots,policy){
  const models=[...new Set(candidates.map(c=>c.model_id))].sort(),n=models.length,index=new Map(models.map((id,i)=>[id,i]));
  const byId=new Map(candidates.map(c=>[c.id,c])),byPair=new Map(pairs.map(p=>[p.id,p]));
  const counts=Array.from({length:n},()=>Array(n).fill(0)),wins=Array.from({length:n},()=>Array(n).fill(0)),observed=[];
  for(const b of ballots){if(b.outcome!=='win')continue;const p=byPair.get(b.pair_id),a=byId.get(p?.first_id),c=byId.get(p?.second_id);
    if(!a||!c||![a.id,c.id].includes(b.winner_id))throw Error('Invalid human sampling evidence');
    const i=index.get(a.model_id),j=index.get(c.model_id);counts[i][j]++;counts[j][i]++;wins[b.winner_id===a.id?i:j][b.winner_id===a.id?j:i]++;
    observed.push({id:b.id,reviewer_id:b.reviewer_id,pair_id:b.pair_id,first_model:a.model_id,second_model:c.model_id,winner_model:byId.get(b.winner_id).model_id});
  }
  observed.sort((a,b)=>(a.id??0)-(b.id??0)||a.pair_id.localeCompare(b.pair_id));
  const likelihood=theta=>{
    let value=-.5*policy.prior_precision*theta.reduce((sum,x)=>sum+x*x,0);
    const logSigmoid=x=>x>=0?-Math.log1p(Math.exp(-x)):x-Math.log1p(Math.exp(x));
    for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)value+=wins[i][j]*logSigmoid(theta[i]-theta[j])+wins[j][i]*logSigmoid(theta[j]-theta[i]);
    return value;
  };
  let theta=Array(n).fill(0),iterations=0,converged=false;
  for(iterations=1;iterations<=policy.map_max_iterations;iterations++){
    const gradient=theta.map(x=>-policy.prior_precision*x);
    for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){const g=wins[i][j]-counts[i][j]*sigmoid(theta[i]-theta[j]);gradient[i]+=g;gradient[j]-=g;}
    const cov=inverse(information(theta,counts,policy.prior_precision)),step=cov.map(row=>row.reduce((sum,x,j)=>sum+x*gradient[j],0));
    let alpha=1,next;
    for(let backtrack=0;backtrack<30;backtrack++){next=theta.map((x,i)=>x+alpha*step[i]);if(likelihood(next)>=likelihood(theta)-1e-12)break;alpha/=2;}
    const delta=Math.max(...next.map((x,i)=>Math.abs(x-theta[i])));theta=next;
    if(delta<policy.map_tolerance){converged=true;break;}
  }
  if(!converged)throw Error('Sampling predictor did not converge; no new tournament was allocated');
  return{models,theta,covariance:inverse(information(theta,counts,policy.prior_precision)),counts,wins,
    observed_votes:observed.length,evidence_hash:hash(observed),ballot_ids:observed.map(b=>b.id),iterations,converged};
}
export function expectedBracketGain(ids,evidence){
  const index=new Map(evidence.models.map((id,i)=>[id,i]));
  function walk(decisions,cov){
    const state=tournamentState(ids,decisions);if(state.complete)return 0;
    const [a,b]=state.pair,i=index.get(a),j=index.get(b),p=sigmoid(evidence.theta[i]-evidence.theta[j]),w=p*(1-p);
    const d=cov.map(row=>row[i]-row[j]),variance=cov[i][i]+cov[j][j]-2*cov[i][j];
    const scale=w/(1+w*variance),next=cov.map((row,r)=>row.map((v,c)=>v-scale*d[r]*d[c]));
    const gain=.5*Math.log1p(w*variance);
    return gain+p*walk([...decisions,a],next)+(1-p)*walk([...decisions,b],next);
  }
  return walk([],evidence.covariance);
}
export function samplingConfigurations(group,evidence,policy){
  const sorted=group.toSorted((a,b)=>a.model_id.localeCompare(b.model_id)),configs=[];
  for(let a=0;a<sorted.length-3;a++)for(let b=a+1;b<sorted.length-2;b++)for(let c=b+1;c<sorted.length-1;c++)for(let d=c+1;d<sorted.length;d++){
    const subset=[sorted[a],sorted[b],sorted[c],sorted[d]];
    for(const layout of [[0,1,2,3],[0,2,1,3],[0,3,1,2]]){
      const arranged=layout.map(i=>subset[i]);configs.push({candidate_ids:arranged.map(c=>c.id),model_ids:arranged.map(c=>c.model_id),
        expected_information_gain:expectedBracketGain(arranged.map(c=>c.model_id),evidence)});
    }
  }
  if(!configs.length)throw Error('Active sampling requires four available models');
  const max=Math.max(...configs.map(c=>c.expected_information_gain)),weights=configs.map(c=>Math.exp((c.expected_information_gain-max)/policy.temperature));
  const sum=weights.reduce((a,b)=>a+b,0);
  return configs.map((c,i)=>({...c,exploitation_probability:weights[i]/sum,
    probability:policy.exploration_fraction/configs.length+(1-policy.exploration_fraction)*weights[i]/sum}));
}
export function drawActiveTournament({group,candidates,pairs,ballots,policy,seed,drawId}){
  const evidence=samplingEvidence(candidates,pairs,ballots,policy),configurations=samplingConfigurations(group,evidence,policy);
  const random=purpose=>parseInt(createHmac('sha256',seed).update(`active:${drawId}:${purpose}`).digest('hex').slice(0,13),16)/2**52;
  const exploration=random('component')<policy.exploration_fraction,u=random('configuration');
  let at=0;if(exploration)at=Math.floor(u*configurations.length);else{let sum=0;at=configurations.length-1;for(const[i,c]of configurations.entries()){sum+=c.exploitation_probability;if(u<sum){at=i;break;}}}
  const chosen=configurations[at],layout=Math.floor(random('orientation')*8),ids=[...chosen.candidate_ids];
  if(layout&1)[ids[0],ids[1]]=[ids[1],ids[0]];if(layout&2)[ids[2],ids[3]]=[ids[3],ids[2]];if(layout&4)ids.push(...ids.splice(0,2));
  return{candidate_ids:ids,sampling:ACTIVE_SAMPLING,sampling_policy_hash:policy.content_hash,
    selection_component:exploration?'exploration':'information-gain',configuration_probability:chosen.probability,
    ordered_selection_probability:chosen.probability/8,expected_information_gain:chosen.expected_information_gain,
    sampling_evidence:evidence,selection_probabilities:configurations,random_draws:{component:random('component'),configuration:u,orientation:layout},
    implementation:'local-adaptation-of-published-principles'};
}
