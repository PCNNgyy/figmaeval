import {createHash,createHmac} from 'node:crypto';
import {addRankingModels,advanceRanking} from './arena_incremental_sort.mjs';

const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const model=c=>({model_id:c.model_id,candidate_id:c.id,version:hash([c.id,c.run_id,c.workspace_id,c.images.map(i=>i.sha256)])});

export function migrateModelExpansion({db,previous,snapshot,expectedAddedIds,seed,archiveDirectory}){
 const old=new Map(previous.candidates.map(c=>[c.id,c])),current=new Map(snapshot.candidates.map(c=>[c.id,c]));
 if(old.size!==previous.candidates.length||current.size!==snapshot.candidates.length||[...old].some(([id,c])=>JSON.stringify(c)!==JSON.stringify(current.get(id))))throw Error('Expansion must preserve every existing candidate');
 const added=snapshot.candidates.filter(c=>!old.has(c.id)),authorized=new Set(expectedAddedIds);
 if(authorized.size!==expectedAddedIds.length||added.length!==authorized.size||added.some(c=>!authorized.has(c.id)))throw Error('Unexpected model additions');
 const oldGroups=Map.groupBy(previous.candidates,c=>c.case_id),groups=Map.groupBy(snapshot.candidates,c=>c.case_id);
 if(oldGroups.size!==groups.size||[...oldGroups.keys()].some(id=>!groups.has(id)))throw Error('Expansion must preserve the task set');
 for(const [id,group] of groups){
  const models=group.map(c=>c.model_id),baseline=oldGroups.get(id).map(c=>c.model_id);
  if(new Set(models).size!==models.length||group.filter(c=>!old.has(c.id)).some(c=>baseline.includes(c.model_id)))throw Error('An existing model cannot be replaced by expansion');
 }
 const digest=hash(snapshot),oldDigest=hash(previous);
 if(db.prepare("SELECT value FROM metadata WHERE key='snapshot_hash'").get()?.value!==oldDigest)throw Error('Expansion DB has another frozen snapshot');
 const report={kind:'arena-model-expansion/v1',at:new Date().toISOString(),previous_snapshot_hash:oldDigest,snapshot_hash:digest,archive_directory:archiveDirectory,added_candidates:added.length,sessions:[],real_votes_added:0};
 db.exec('BEGIN IMMEDIATE');
 try{
  for(const c of added)db.prepare('INSERT INTO candidates VALUES (?,?,?,?,?)').run(c.id,c.case_id,c.model_id,c.run_id,JSON.stringify(c));
  for(const row of db.prepare('SELECT * FROM incremental_sort_sessions').all()){
   const existing=JSON.parse(row.models),state=JSON.parse(row.state);
   if(existing.some(m=>JSON.stringify(model(old.get(m.candidate_id)||{}))!==JSON.stringify(m))||JSON.stringify(state.models)!==JSON.stringify(existing.map(m=>m.model_id)))throw Error('Session output versions differ from the original cohort');
   const order=c=>createHmac('sha256',seed).update(`expansion:${row.id}:${c.id}`).digest('hex');
   const extra=added.filter(c=>c.case_id===row.case_id).sort((a,b)=>order(a).localeCompare(order(b))),models=[...existing,...extra.map(model)];
   if(!extra.length)throw Error('Every task must have its authorized additions');
   let next=addRankingModels(state,extra.map(c=>c.model_id));
   if(state.phase==='complete')next=advanceRanking(next,db.prepare('SELECT * FROM incremental_sort_votes WHERE session_id=? AND active=1 ORDER BY created_at,rowid').all(row.id));
   const scope=hash({snapshot_hash:digest,case_id:row.case_id,reviewer_id:row.reviewer_id,session_id:row.source_session_id||row.id,models:models.toSorted((a,b)=>a.model_id.localeCompare(b.model_id))});
   db.prepare('UPDATE incremental_sort_sessions SET models=?,scope_hash=?,state=? WHERE id=?').run(JSON.stringify(models),scope,JSON.stringify(next),row.id);
   report.sessions.push({id:row.id,case_id:row.case_id,previous_status:state.status,status:next.status,added_models:extra.map(c=>c.model_id),pending_comparison_preserved:state.phase!=='complete'});
  }
  db.prepare('UPDATE screen_case_marks SET snapshot_hash=?').run(digest);
  db.exec('DELETE FROM arena_media_downloads');
  db.prepare("UPDATE metadata SET value=? WHERE key='snapshot_hash'").run(digest);
  db.prepare("DELETE FROM metadata WHERE key IN ('reviewer_policy_hash','sampling_policy_hash')").run();
  db.prepare('INSERT INTO events(kind,body,created_at) VALUES (?,?,?)').run('model-expansion-activated',JSON.stringify(report),report.at);
  if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Model expansion has broken review references');
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
 return report;
}
