import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {seal,verifySeal} from './benchmark_protocol.mjs';

const digest=s=>createHash('sha256').update(JSON.stringify(s)).digest('hex');

export function captureCompletedStages(db,snapshot){
 const source_snapshot_hash=digest(snapshot);
 if(db.prepare("SELECT value FROM metadata WHERE key='snapshot_hash'").get()?.value!==source_snapshot_hash)throw Error('Completion history source differs from its snapshot');
 return db.prepare('SELECT * FROM incremental_sort_sessions').all().flatMap(row=>{
  const state=JSON.parse(row.state),models=JSON.parse(row.models);
  if(state.status!=='complete'||row.review_request_id)return[];
  return[{session_id:row.id,reviewer_id:row.reviewer_id,case_id:row.case_id,round:row.round,model_count:models.length,ranking:state.ranking,
   models,source_snapshot_hash,actual_votes:db.prepare('SELECT COUNT(*) n FROM incremental_sort_votes WHERE session_id=?').get(row.id).n}];
 });
}

export function completionHistory(snapshot,entries){
 return seal({kind:'arena-completed-stage-history/v1',snapshot_hash:digest(snapshot),entries});
}

export function readCompletedStages(directory,snapshot){
 const file=path.join(directory,'completed-stages.json');if(!fs.existsSync(file))return[];
 const history=verifySeal(JSON.parse(fs.readFileSync(file))),seen=new Set(),groups=Map.groupBy(snapshot.candidates,c=>c.case_id);
 if(history.kind!=='arena-completed-stage-history/v1'||history.snapshot_hash!==digest(snapshot)||!Array.isArray(history.entries))throw Error('Completion history belongs to another snapshot');
 for(const row of history.entries){
  const group=groups.get(row.case_id),ids=row.models?.map(m=>m.model_id),key=JSON.stringify([row.session_id,row.source_snapshot_hash]);
  if(!group||seen.has(key)||typeof row.reviewer_id!=='string'||!row.session_id||!/^[a-f0-9]{64}$/.test(row.source_snapshot_hash)
   ||!Number.isInteger(row.model_count)||row.model_count<1||row.model_count>group.length||ids?.length!==row.model_count||new Set(ids).size!==ids.length
   ||!Array.isArray(row.ranking)||row.ranking.length!==ids.length||new Set(row.ranking).size!==ids.length||row.ranking.some(id=>!ids.includes(id))
   ||ids.some(id=>!group.some(c=>c.model_id===id)))throw Error('Invalid completed model stage');
  seen.add(key);
 }
 return history.entries;
}
