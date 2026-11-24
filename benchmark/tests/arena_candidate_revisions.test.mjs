import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import {createArenaStore} from '../server/benchmark_arena.mjs';import {buildScreenCatalog} from '../server/arena_pair_screens.mjs';import {tournamentProtocol} from '../server/arena_tournament.mjs';import {migrateCandidateRevisions} from '../server/arena_candidate_revisions.mjs';
const hash=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
test('revision drops only replaced-output evidence, replays unchanged direct votes, and preserves other task progress and marks',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arena-revisions-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=','base64');
 const candidates=Array.from({length:8},(_,i)=>{const id=hash(String(i)).slice(0,24),file=`media/${id}/0.png`;fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});fs.writeFileSync(path.join(dir,file),png);return{id,case_id:'case'+Math.floor(i/4),title:'Task '+Math.floor(i/4),source_url:'https://www.figma.com/design/Source'+Math.floor(i/4),source_query:'Read task',model_id:'model'+i%4,model_name:'Model '+i%4,run_id:'run'+i,workspace_id:'3:1',workspace_url:`https://www.figma.com/design/Copy${i}/?page-id=3%3A1&node-id=3-1`,generation_ended:true,trace_status:'verified',screen_check:{passed:true},cc_score:null,evidence_status:'cached-complete',images:[{file,width:1,height:1,node_id:'4:1',sha256:hash(png)}]};});
 const previous={kind:'figma-human-arena-snapshot',version:3,name:'revision fixture',protocol:tournamentProtocol(),candidates};
 const catalog=s=>buildScreenCatalog(s,{items:s.candidates.map(c=>({run_id:c.run_id,model_id:c.model_id,copy_file_key:new URL(c.workspace_url).pathname.split('/')[2],workspace_page_id:c.workspace_id,frames:[{...c.images[0],label:'01_Home'}]}))});
 fs.writeFileSync(dir+'/screen-catalog.json',JSON.stringify(catalog(previous)));let store=createArenaStore(dir,previous,{screenComparisons:true,incrementalRanking:true});const reviewer='reviewer-1';
 for(const case_id of ['case0','case1']){
  store.incremental.selectTask(reviewer,{case_id});let guard=0;
  for(;;){const pair=store.next(reviewer).pair;if(!pair)break;assert.ok(++guard<10);const ids=store.sides(store.pairById.get(pair.id),reviewer),choice=store.candidates.get(ids.A).model_id<store.candidates.get(ids.B).model_id?'A':'B';
   for(const side of ['A','B']){store.seen(reviewer,pair.id,side,'gallery');const image=store.media.image(reviewer,ids[side],0);store.media.download(reviewer,image.media_key);store.screenReview.opened(reviewer,pair.id,side,0);}
   let s=store.screenReview.state(reviewer,store.pairById.get(pair.id));s=store.screenReview.save(reviewer,{pair_id:pair.id,plan_hash:s.plan_hash,slot_id:s.rows[0].id,choice,revision:0,viewed:true,comment:''});
   store.vote(reviewer,{pair_id:pair.id,choice,screen_plan_hash:s.plan_hash,screen_votes_hash:s.votes_hash});
  }
 }
 const before=store.db.prepare("SELECT * FROM incremental_sort_sessions WHERE case_id='case1'").get(),total=store.db.prepare('SELECT COUNT(*) n FROM ballots').get().n;
 store.db.exec('CREATE TABLE tournament_battles (tournament_id TEXT, step INTEGER, pair_id TEXT REFERENCES pairs(id))');
 const oldPair=store.db.prepare('SELECT id FROM pairs WHERE first_id=? OR second_id=? LIMIT 1').get(candidates[0].id,candidates[0].id).id;
 const retainedPair=store.db.prepare("SELECT id FROM pairs WHERE case_id='case1' LIMIT 1").get().id;
 store.db.prepare('INSERT INTO tournament_battles VALUES (?,?,?)').run('legacy',0,oldPair);
 store.db.prepare('INSERT INTO tournament_battles VALUES (?,?,?)').run('unrelated',0,retainedPair);
 for(const c of candidates.slice(0,2))store.db.prepare('INSERT INTO screen_case_marks VALUES (?,?,?,?,?,?,?,?,?,?)').run(reviewer,c.id,0,c===candidates[0]?'bad':'good','fixture reason',1,c.images[0].sha256,store.digest,'before','before');store.close();
 const snapshot=structuredClone(previous),replacement=snapshot.candidates[0];replacement.id=hash('replacement').slice(0,24);replacement.run_id='new-run';replacement.images[0].file=`media/${replacement.id}/0.png`;fs.mkdirSync(path.dirname(path.join(dir,replacement.images[0].file)),{recursive:true});fs.writeFileSync(path.join(dir,replacement.images[0].file),png);
 const db=new DatabaseSync(dir+'/arena.sqlite3'),report=migrateCandidateRevisions({db,previous,snapshot,archiveDirectory:'private-archive',expectedReplacements:[{old_id:candidates[0].id,new_id:replacement.id}]});
 assert.ok(report.archived_overall_votes>0);assert.equal(report.retained_overall_votes,total-report.archived_overall_votes);assert.equal(report.archived_screen_marks,1);assert.equal(report.archived_legacy_battles,1);assert.deepEqual(db.prepare('SELECT pair_id FROM tournament_battles').all().map(r=>r.pair_id),[retainedPair]);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.close();
 fs.writeFileSync(dir+'/screen-catalog.json',JSON.stringify(catalog(snapshot)));store=createArenaStore(dir,snapshot,{screenComparisons:true,incrementalRanking:true});
 try{
  assert.equal(store.db.prepare("SELECT state FROM incremental_sort_sessions WHERE case_id='case1'").get().state,before.state);
  const changed=store.incremental.exported().find(s=>s.case_id==='case0');assert.equal(changed.status,'awaiting-vote');assert.ok(changed.actual_votes>0);
  assert.equal(store.screenMarks.exported().length,1);assert.equal(store.screenMarks.exported()[0].reason,'fixture reason');assert.equal(store.screenMarks.exported()[0].candidate_id,candidates[1].id);
  assert.equal(store.incremental.progress(reviewer).completed_tasks,1);
 }finally{store.close();}
});
