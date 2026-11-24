import {createHash} from 'node:crypto';
import {createRankingState,advanceRanking} from './arena_incremental_sort.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity=c=>JSON.stringify([c.case_id,c.model_id]);
const model=c=>({model_id:c.model_id,candidate_id:c.id,version:hash([c.id,c.run_id,c.workspace_id,c.images.map(i=>i.sha256)])});

export function migrateCandidateRevisions({db,previous,snapshot,archiveDirectory,expectedReplacements}){
 const oldDigest=hash(previous),digest=hash(snapshot),oldBy=new Map(previous.candidates.map(c=>[identity(c),c])),by=new Map(snapshot.candidates.map(c=>[identity(c),c]));
 if(oldBy.size!==by.size||[...oldBy.keys()].some(k=>!by.has(k)))throw Error('Revision must preserve the case/model matrix');
 const changed=[...oldBy].filter(([k,c])=>JSON.stringify(c)!==JSON.stringify(by.get(k))).map(([k,c])=>({previous:c,current:by.get(k)}));
 if(changed.length!==expectedReplacements.length||changed.some(r=>!expectedReplacements.some(e=>e.old_id===r.previous.id&&e.new_id===r.current.id))
  ||changed.some(r=>r.previous.id===r.current.id))throw Error('Replacement authorization does not match the changed candidates');
 if(db.prepare("SELECT value FROM metadata WHERE key='snapshot_hash'").get()?.value!==oldDigest)throw Error('Source DB does not belong to the previous snapshot');
 const substitutions=new Map(changed.map(r=>[r.previous.id,r.current])),affected=new Set(changed.map(r=>r.current.case_id));
 const oldPairs=db.prepare('SELECT * FROM pairs').all().filter(p=>substitutions.has(p.first_id)||substitutions.has(p.second_id));
 const report={kind:'arena-candidate-revisions/v1',at:new Date().toISOString(),previous_snapshot_hash:oldDigest,snapshot_hash:digest,archive_directory:archiveDirectory,
  replacements:changed.map(r=>({case_id:r.current.case_id,title:r.current.title,model_id:r.current.model_id,old_id:r.previous.id,new_id:r.current.id,old_run:r.previous.run_id,new_run:r.current.run_id})),
  archived_overall_votes:0,archived_screen_votes:0,archived_screen_marks:0,archived_legacy_battles:0,retained_overall_votes:0,recomputed_sessions:[],unchanged_sessions:[]};
 const legacyBattles=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tournament_battles'").get();
 db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
 try{
  for(const pair of oldPairs){
   report.archived_overall_votes+=db.prepare('SELECT COUNT(*) n FROM ballots WHERE pair_id=?').get(pair.id).n;
   report.archived_screen_votes+=db.prepare('SELECT COUNT(*) n FROM pair_screen_votes WHERE pair_id=?').get(pair.id).n;
   if(legacyBattles)report.archived_legacy_battles+=db.prepare('DELETE FROM tournament_battles WHERE pair_id=?').run(pair.id).changes;
   for(const table of ['views','pair_screen_image_views','pair_screen_votes','pair_screen_plans','incremental_sort_votes','incremental_sort_requests','ballots','pairs']){
    db.prepare(`DELETE FROM ${table} WHERE ${table==='pairs'?'id':'pair_id'}=?`).run(pair.id);
   }
  }
  for(const [id,c] of substitutions){
   report.archived_screen_marks+=db.prepare('SELECT COUNT(*) n FROM screen_case_marks WHERE candidate_id=?').get(id).n;
   db.prepare('DELETE FROM screen_case_marks WHERE candidate_id=?').run(id);
   db.prepare('DELETE FROM candidates WHERE id=?').run(id);
   db.prepare('INSERT INTO candidates VALUES (?,?,?,?,?)').run(c.id,c.case_id,c.model_id,c.run_id,JSON.stringify(c));
  }
  for(const row of db.prepare('SELECT * FROM incremental_sort_sessions').all()){
   const models=JSON.parse(row.models).map(m=>substitutions.has(m.candidate_id)?model(substitutions.get(m.candidate_id)):m);
   const scope=hash({snapshot_hash:digest,case_id:row.case_id,reviewer_id:row.reviewer_id,session_id:row.source_session_id||row.id,models:models.toSorted((a,b)=>a.model_id.localeCompare(b.model_id))});
   let state=row.state,review=row.review_request_id;
   if(affected.has(row.case_id)){
    const votes=db.prepare('SELECT * FROM incremental_sort_votes WHERE session_id=? ORDER BY created_at,rowid').all(row.id).filter(v=>v.active);
    db.prepare('DELETE FROM incremental_sort_derivations WHERE session_id=?').run(row.id);
    const derived=relation=>db.prepare('INSERT OR IGNORE INTO incremental_sort_derivations VALUES (?,?,?,?,?,?,?)').run(hash([row.id,relation.winner,relation.loser,relation.vote_ids]),row.id,row.revision,relation.winner,relation.loser,JSON.stringify(relation),report.at);
    const next=advanceRanking(createRankingState(models.map(m=>m.model_id)),votes,derived),unable=votes.filter(v=>v.outcome==='unable');
    if(!next.status.startsWith('paused-')&&unable.length){next.status='paused-unable';next.pending=null;next.issue={vote_ids:unable.map(v=>v.id)};}
    state=JSON.stringify(next);
    if(review&&!db.prepare('SELECT 1 FROM incremental_sort_requests WHERE id=?').get(review))review=null;
    for(const request of db.prepare("SELECT * FROM incremental_sort_requests WHERE session_id=? AND revision=? AND purpose='sort'").all(row.id,row.revision)){
     if(db.prepare('SELECT 1 FROM ballots WHERE pair_id=? AND reviewer_id=?').get(request.pair_id,row.reviewer_id))continue;
     const ids=next.pending?[next.pending.a,next.pending.b].sort():[];
     if(JSON.stringify(ids)===JSON.stringify([request.left_model_id,request.right_model_id].sort()))continue;
     for(const table of ['views','pair_screen_image_views','pair_screen_votes','pair_screen_plans'])db.prepare(`DELETE FROM ${table} WHERE pair_id=?`).run(request.pair_id);
     db.prepare('DELETE FROM incremental_sort_requests WHERE id=?').run(request.id);db.prepare('DELETE FROM pairs WHERE id=?').run(request.pair_id);
    }
    report.recomputed_sessions.push({id:row.id,case_id:row.case_id,status:next.status,retained_actual_votes:votes.length});
   }else report.unchanged_sessions.push(row.id);
   db.prepare('UPDATE incremental_sort_sessions SET models=?,scope_hash=?,state=?,review_request_id=? WHERE id=?').run(JSON.stringify(models),scope,state,review,row.id);
  }
  const candidates=new Map(snapshot.candidates.map(c=>[c.id,c]));
  for(const mark of db.prepare('SELECT * FROM screen_case_marks').all())if(candidates.get(mark.candidate_id)?.images[mark.image_index]?.sha256!==mark.image_sha256)throw Error('Retained annotation points to changed evidence');
  db.prepare('UPDATE screen_case_marks SET snapshot_hash=?').run(digest);
  db.exec('DELETE FROM arena_media_downloads');
  db.prepare("UPDATE metadata SET value=? WHERE key='snapshot_hash'").run(digest);
  db.prepare("DELETE FROM metadata WHERE key IN ('reviewer_policy_hash','sampling_policy_hash')").run();
  report.retained_overall_votes=db.prepare('SELECT COUNT(*) n FROM ballots').get().n;
  db.prepare('INSERT INTO events(kind,body,created_at) VALUES (?,?,?)').run('candidate-revisions-activated',JSON.stringify(report),report.at);
  const broken=db.prepare('PRAGMA foreign_key_check').all();
  if(broken.length)throw Error('Revised review DB has broken foreign keys: '+JSON.stringify(broken));
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}finally{db.exec('PRAGMA foreign_keys=ON');}
 return report;
}
