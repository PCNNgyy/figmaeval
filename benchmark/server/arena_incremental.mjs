import {createHash, createHmac, randomInt} from 'node:crypto';
import {INCREMENTAL_SORT, createRankingState, advanceRanking, preferenceGraph, rankingComparisonBound} from './arena_incremental_sort.mjs';

const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const reject = (status, message) => { throw Object.assign(new Error(message), {status}); };

export function createIncrementalEngine({db, snapshot, snapshotHash, seed, pairs, pairById,completedStages=[]}) {
  db.exec(`CREATE TABLE IF NOT EXISTS incremental_sort_sessions (
    id TEXT PRIMARY KEY, reviewer_id TEXT NOT NULL REFERENCES reviewers(id), case_id TEXT NOT NULL,
    sequence INTEGER NOT NULL, source_session_id TEXT, scope_hash TEXT NOT NULL, models TEXT NOT NULL,
    state TEXT NOT NULL, revision INTEGER NOT NULL, review_request_id TEXT, created_at TEXT NOT NULL,
    round INTEGER NOT NULL DEFAULT 1, UNIQUE(reviewer_id,case_id,round));
    CREATE TABLE IF NOT EXISTS incremental_sort_requests (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES incremental_sort_sessions(id),
    pair_id TEXT UNIQUE NOT NULL REFERENCES pairs(id), left_model_id TEXT NOT NULL, right_model_id TEXT NOT NULL,
    purpose TEXT NOT NULL, correction_of TEXT, revision INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS incremental_sort_votes (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES incremental_sort_sessions(id), request_id TEXT UNIQUE NOT NULL,
    pair_id TEXT NOT NULL REFERENCES pairs(id), ballot_id INTEGER UNIQUE NOT NULL REFERENCES ballots(id),
    a TEXT NOT NULL, b TEXT NOT NULL, winner TEXT, outcome TEXT NOT NULL,
    active INTEGER NOT NULL, correction_of TEXT REFERENCES incremental_sort_votes(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS incremental_sort_derivations (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES incremental_sort_sessions(id), revision INTEGER NOT NULL,
    winner TEXT NOT NULL, loser TEXT NOT NULL, proof TEXT NOT NULL, created_at TEXT NOT NULL);`);
  if(!db.prepare('PRAGMA table_info(incremental_sort_sessions)').all().some(c=>c.name==='round')){
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    try{
      db.exec(`CREATE TABLE incremental_sort_sessions_new (
        id TEXT PRIMARY KEY, reviewer_id TEXT NOT NULL REFERENCES reviewers(id), case_id TEXT NOT NULL,
        sequence INTEGER NOT NULL, source_session_id TEXT, scope_hash TEXT NOT NULL, models TEXT NOT NULL,
        state TEXT NOT NULL, revision INTEGER NOT NULL, review_request_id TEXT, created_at TEXT NOT NULL,
        round INTEGER NOT NULL DEFAULT 1, UNIQUE(reviewer_id,case_id,round));
        INSERT INTO incremental_sort_sessions_new SELECT *,1 FROM incremental_sort_sessions;
        DROP TABLE incremental_sort_sessions;
        ALTER TABLE incremental_sort_sessions_new RENAME TO incremental_sort_sessions;`);
      if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Ranking session migration failed its reference check');
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    finally{db.exec('PRAGMA foreign_keys=ON');}
  }
  db.exec(`CREATE TABLE IF NOT EXISTS incremental_sort_focus (
    reviewer_id TEXT PRIMARY KEY REFERENCES reviewers(id), session_id TEXT NOT NULL REFERENCES incremental_sort_sessions(id), updated_at TEXT NOT NULL);`);
  const groups = Map.groupBy(snapshot.candidates, c => c.case_id), byCandidate = new Map(snapshot.candidates.map(c => [c.id,c]));
  function previousStage(row){
    return completedStages.filter(h=>h.session_id===row.id&&h.reviewer_id===row.reviewer_id&&h.case_id===row.case_id)
      .toSorted((a,b)=>b.model_count-a.model_count)[0]||null;
  }
  function stageSummary(row){
    const h=previousStage(row),count=h?.model_count||0,total=groups.get(row.case_id).length;
    const state=typeof row.state==='string'?JSON.parse(row.state):row.state;
    return{previous_completed_models:count,pending_added_models:count&&state.status!=='complete'?total-count:0};
  }
  const randomOrder = text => createHmac('sha256', seed).update(text).digest('hex');
  const transaction = work => {
    const own = !db.isTransaction; if (own) db.exec('BEGIN IMMEDIATE');
    try { const result = work(); if (own) db.exec('COMMIT'); return result; }
    catch(e) { if (own) db.exec('ROLLBACK'); throw e; }
  };
  function model(c) { return {model_id:c.model_id,candidate_id:c.id,version:hash([c.id,c.run_id,c.workspace_id,c.images.map(i=>i.sha256)])}; }
  function scope(row, models) {
    return hash({snapshot_hash:snapshotHash,case_id:row.case_id,reviewer_id:row.reviewer_id,
      session_id:row.source_session_id||row.id,models:models.toSorted((a,b)=>a.model_id.localeCompare(b.model_id))});
  }
  function read(id, reviewerId) {
    if(typeof id!=='string'||!id)reject(400,'请指定有效的排序会话');
    const row=db.prepare('SELECT * FROM incremental_sort_sessions WHERE id=?').get(id);
    if (!row || reviewerId && row.reviewer_id!==reviewerId) reject(403,'无权访问这次排序会话');
    const models=JSON.parse(row.models), state=JSON.parse(row.state);
    if (models.some(m=>{const c=byCandidate.get(m.candidate_id);return !c||c.case_id!==row.case_id||JSON.stringify(model(c))!==JSON.stringify(m);})
      || scope(row,models)!==row.scope_hash) reject(409,'题目或模型版本已变化，不能复用这次比较关系');
    return {...row,models,state};
  }
  const votes = id => db.prepare('SELECT * FROM incremental_sort_votes WHERE session_id=? ORDER BY created_at,rowid').all(id);
  function update(row, state, revision, reviewId=null) {
    db.prepare('UPDATE incremental_sort_sessions SET state=?,revision=?,review_request_id=? WHERE id=?')
      .run(JSON.stringify(state),revision,reviewId,row.id);
    return read(row.id);
  }
  function advance(row, reset=false) {
    const active=votes(row.id).filter(v=>v.active), revision=row.revision;
    const remember=relation=>{
      const id=hash([row.id,relation.winner,relation.loser,relation.vote_ids]);
      db.prepare('INSERT OR IGNORE INTO incremental_sort_derivations VALUES (?,?,?,?,?,?,?)')
        .run(id,row.id,revision,relation.winner,relation.loser,JSON.stringify(relation),new Date().toISOString());
    };
    const ids=row.models.map(m=>m.model_id),graph=preferenceGraph(ids,active);
    if(!graph.cycle&&!graph.ties.length)for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++){
      const relation=graph.compare(ids[i],ids[j]);if(relation?.kind==='transitive')remember(relation);
    }
    const state=advanceRanking(reset?createRankingState(ids):row.state,active,remember);
    const unable=active.filter(v=>v.outcome==='unable');
    if (!state.status.startsWith('paused-')&&unable.length) {
      state.status='paused-unable';state.pending=null;state.issue={vote_ids:unable.map(v=>v.id)};
    }
    return update(row,state,revision);
  }
  function createSession({reviewer_id,case_id,sequence,round=1,source_session_id=null,candidate_ids=null,legacyVotes=[]}) {
    const group=groups.get(case_id);if(!group)reject(400,'未知题目');
    const identity=[INCREMENTAL_SORT,snapshotHash,reviewer_id,case_id,source_session_id];
    const id=hash(round===1?identity:[...identity,round]).slice(0,24);
    const ordered=group.map(c=>c.id).sort((a,b)=>randomOrder(`incremental:${id}:${a}`).localeCompare(randomOrder(`incremental:${id}:${b}`)));
    const ids=candidate_ids?[...candidate_ids,...ordered.filter(id=>!candidate_ids.includes(id))]:ordered;
    if (new Set(ids).size!==group.length || ids.some(id=>!group.some(c=>c.id===id))) reject(409,'模型版本不属于这道题');
    const models=ids.map(id=>model(byCandidate.get(id))),row={id,reviewer_id,case_id,source_session_id};
    db.prepare('INSERT INTO incremental_sort_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,reviewer_id,case_id,sequence,source_session_id,scope(row,models),JSON.stringify(models),
        JSON.stringify(createRankingState(models.map(m=>m.model_id))),0,null,new Date().toISOString(),round);
    for(const v of legacyVotes){
      const p=pairById.get(v.pair_id);
      db.prepare('INSERT INTO incremental_sort_votes VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(`legacy-${v.id}`,id,`legacy-${v.id}`,
        p.id,v.id,byCandidate.get(p.first_id).model_id,byCandidate.get(p.second_id).model_id,
        v.winner_id?byCandidate.get(v.winner_id).model_id:null,v.outcome,1,null,v.created_at);
    }
    db.prepare('INSERT INTO events(kind,reviewer_id,body,created_at) VALUES (?,?,?,?)').run('incremental-session-created',reviewer_id,
      JSON.stringify({algorithm:INCREMENTAL_SORT,session_id:id,case_id,source_session_id,scope_hash:scope(row,models),
        imported_ballot_ids:legacyVotes.map(v=>v.id),models}),new Date().toISOString());
    return advance(read(id));
  }
  function migrateLegacy() {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tournaments'").get())return;
    transaction(()=>{
      const selected=new Map();
      for(const row of db.prepare('SELECT * FROM tournaments ORDER BY sequence').all()){
        const old=db.prepare(`SELECT b.* FROM tournament_battles t JOIN ballots b ON b.pair_id=t.pair_id
          WHERE t.tournament_id=? AND b.reviewer_id=? ORDER BY t.step`).all(row.id,row.reviewer_id);
        if(old.some(v=>v.outcome==='unable'))continue;
        selected.set(JSON.stringify([row.reviewer_id,row.case_id]),{row,old});
      }
      for(const {row,old} of selected.values()){
        if(db.prepare('SELECT 1 FROM incremental_sort_sessions WHERE reviewer_id=? AND case_id=?').get(row.reviewer_id,row.case_id))continue;
        createSession({reviewer_id:row.reviewer_id,case_id:row.case_id,sequence:row.sequence,source_session_id:row.id,
          candidate_ids:JSON.parse(row.body).candidate_ids,legacyVotes:old});
      }
    });
  }
  migrateLegacy();
  function ensureRequest(row,purpose='sort',correction=null) {
    if(purpose==='review'&&row.review_request_id)return db.prepare('SELECT * FROM incremental_sort_requests WHERE id=?').get(row.review_request_id);
    const pending=correction?{a:correction.a,b:correction.b}:row.state.pending;
    if(!pending)return null;
    const id=hash([row.id,row.revision,purpose,pending,correction?.id]).slice(0,24);
    let request=db.prepare('SELECT * FROM incremental_sort_requests WHERE id=?').get(id);if(request)return request;
    const pairId=hash(['incremental-pair',id]).slice(0,24),left=randomInt(2)?pending.a:pending.b,right=left===pending.a?pending.b:pending.a;
    const candidate=mid=>row.models.find(m=>m.model_id===mid).candidate_id,ids=[candidate(left),candidate(right)].sort();
    db.prepare('INSERT INTO pairs VALUES (?,?,?,?)').run(pairId,row.case_id,ids[0],ids[1]);
    const pair={id:pairId,case_id:row.case_id,first_id:ids[0],second_id:ids[1]};pairs.push(pair);pairById.set(pairId,pair);
    db.prepare('INSERT INTO incremental_sort_requests VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id,row.id,pairId,left,right,purpose,correction?.id||null,row.revision,new Date().toISOString());
    return db.prepare('SELECT * FROM incremental_sort_requests WHERE id=?').get(id);
  }
  function current(reviewerId,allocate=true) {
    return transaction(()=>{
      const rows=db.prepare('SELECT * FROM incremental_sort_sessions WHERE reviewer_id=? ORDER BY sequence,created_at,id').all(reviewerId);
      const focus=db.prepare('SELECT session_id FROM incremental_sort_focus WHERE reviewer_id=?').get(reviewerId);
      const pending=focus?rows.find(r=>r.id===focus.session_id):rows.find(r=>r.review_request_id||JSON.parse(r.state).status!=='complete');
      let row=pending?read(pending.id,reviewerId):null;
      if(!row&&allocate){
        const todo=[...groups.keys()].filter(id=>!rows.some(r=>r.case_id===id))
          .sort((a,b)=>randomOrder(`incremental-tasks:${reviewerId}:${a}`).localeCompare(randomOrder(`incremental-tasks:${reviewerId}:${b}`)));
        if(todo.length)row=createSession({reviewer_id:reviewerId,case_id:todo[0],sequence:rows.length?Math.max(...rows.map(r=>r.sequence))+1:0});
      }
      if(!row)return{tournament:null,pair:null,complete:new Set(rows.filter(r=>JSON.parse(r.state).status==='complete').map(r=>r.case_id)).size===groups.size};
      let request=row.review_request_id?db.prepare('SELECT * FROM incremental_sort_requests WHERE id=?').get(row.review_request_id):null;
      if(!request&&row.state.status==='awaiting-vote'){
        if(allocate)request=ensureRequest(row);
        else request=db.prepare("SELECT * FROM incremental_sort_requests WHERE session_id=? AND revision=? AND purpose='sort'").get(row.id,row.revision);
      }
      const observed=votes(row.id);
      const tournament={...row,state:{...row.state,step:observed.length+1,complete:row.state.status==='complete',ordering:row.state.status==='complete'?row.state.ranking:null},
        blocked:!request&&row.state.status.startsWith('paused-'),skipped:false,sorting:true,request};
      return{tournament,pair:request?pairById.get(request.pair_id):null};
    });
  }
  function selectTask(reviewerId,{case_id,new_round=false}={}){
    return transaction(()=>{
      if(typeof case_id!=='string'||!groups.has(case_id)||typeof new_round!=='boolean')reject(400,'请选择有效题目');
      const own=db.prepare('SELECT * FROM incremental_sort_sessions WHERE reviewer_id=? AND case_id=? ORDER BY round DESC').all(reviewerId,case_id);
      const unfinished=own.find(r=>r.review_request_id||JSON.parse(r.state).status!=='complete');
      if(new_round&&unfinished)reject(409,'这道题还有未完成的轮次，请先继续该轮');
      let row=new_round?null:unfinished||own[0];
      if(!row){
        const seq=db.prepare('SELECT MAX(sequence) n FROM incremental_sort_sessions WHERE reviewer_id=?').get(reviewerId).n;
        row=createSession({reviewer_id:reviewerId,case_id,sequence:seq===null?0:seq+1,round:own.length?own[0].round+1:1});
      }
      db.prepare('INSERT OR REPLACE INTO incremental_sort_focus VALUES (?,?,?)').run(reviewerId,row.id,new Date().toISOString());
      db.prepare('INSERT INTO events(kind,reviewer_id,body,created_at) VALUES (?,?,?,?)').run('incremental-task-selected',reviewerId,
        JSON.stringify({case_id,session_id:row.id,round:row.round,new_round}),new Date().toISOString());
      return getProgress(row.id,reviewerId);
    });
  }
  function listTasks(reviewerId,activeReviewerIds=null){
    const rows=db.prepare('SELECT * FROM incremental_sort_sessions ORDER BY round,sequence').all()
      .filter(r=>!activeReviewerIds||activeReviewerIds.has(r.reviewer_id));
    const observed=db.prepare('SELECT session_id,outcome FROM incremental_sort_votes WHERE active=1').all();
    const focus=db.prepare('SELECT session_id FROM incremental_sort_focus WHERE reviewer_id=?').get(reviewerId);
    return{algorithm:INCREMENTAL_SORT,reviewer_count:activeReviewerIds?.size||new Set(rows.map(r=>r.reviewer_id)).size,
      tasks:[...groups].map(([case_id,group])=>{
        const sessions=rows.filter(r=>r.case_id===case_id),complete=sessions.filter(r=>!r.review_request_id&&JSON.parse(r.state).status==='complete');
        const own=sessions.filter(r=>r.reviewer_id===reviewerId).toSorted((a,b)=>b.round-a.round);
        return{case_id,title:group[0].title,model_count:group.length,
          participants:new Set(sessions.filter(r=>observed.some(v=>v.session_id===r.id&&v.outcome!=='unable')).map(r=>r.reviewer_id)).size,
          completed_reviewers:new Set(complete.map(r=>r.reviewer_id)).size,completed_rounds:complete.length,
          previously_completed_reviewers:new Set(sessions.filter(r=>previousStage(r)).map(r=>r.reviewer_id)).size,
          my_rounds:own.map(r=>({session_id:r.id,round:r.round,status:r.review_request_id?'reviewing':JSON.parse(r.state).status,
            actual_votes:votes(r.id).length,selected:focus?.session_id===r.id,...stageSummary(r)}))};
      })};
  }
  function display(pairId,reviewerId) {
    const req=db.prepare('SELECT * FROM incremental_sort_requests WHERE pair_id=?').get(pairId);if(!req)return null;
    const row=read(req.session_id,reviewerId);
    return{A:row.models.find(m=>m.model_id===req.left_model_id).candidate_id,B:row.models.find(m=>m.model_id===req.right_model_id).candidate_id};
  }
  function record(reviewerId,{pair_id,ballot_id,winner_id,outcome}) {
    const req=db.prepare('SELECT * FROM incremental_sort_requests WHERE pair_id=?').get(pair_id);if(!req)reject(400,'未知排序比较');
    let row=read(req.session_id,reviewerId);
    if(row.revision!==req.revision||current(reviewerId,false).pair?.id!==pair_id)reject(409,'排序阶段已更新，请刷新后继续');
    const winner=winner_id?byCandidate.get(winner_id)?.model_id:null;
    if(outcome==='win'&&![req.left_model_id,req.right_model_id].includes(winner))reject(400,'胜者不属于当前比较');
    let superseded=[];
    if(req.correction_of){
      const old=db.prepare('SELECT * FROM incremental_sort_votes WHERE id=? AND session_id=? AND active=1').get(req.correction_of,row.id);
      if(!old)reject(409,'该投票已被复核，请刷新');
      superseded=votes(row.id).filter(v=>v.active&&((v.a===old.a&&v.b===old.b)||(v.a===old.b&&v.b===old.a)));
      for(const v of superseded)db.prepare('UPDATE incremental_sort_votes SET active=0 WHERE id=? AND session_id=?').run(v.id,row.id);
    }
    const id=hash(['observed-vote',req.id]).slice(0,24);
    db.prepare('INSERT INTO incremental_sort_votes VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,row.id,req.id,pair_id,ballot_id,
      req.left_model_id,req.right_model_id,winner,outcome,1,req.correction_of,new Date().toISOString());
    if(req.correction_of)db.prepare('INSERT INTO events(kind,reviewer_id,pair_id,body,created_at) VALUES (?,?,?,?,?)').run(
      'incremental-pair-review-resolved',reviewerId,pair_id,JSON.stringify({session_id:row.id,review_scope:'same-pair-in-session',
        selected_vote_id:req.correction_of,superseded_vote_ids:superseded.map(v=>v.id),replacement_vote_id:id}),new Date().toISOString());
    row=update(row,row.state,row.revision+1);
    return advance(row,!!req.correction_of);
  }
  function review(reviewerId,{session_id,vote_id,revision}={}) {
    return transaction(()=>{
      if(typeof vote_id!=='string'||!Number.isSafeInteger(revision))reject(400,'请指定真实投票及当前状态版本');
      let row=read(session_id,reviewerId);if(row.revision!==revision)reject(409,'排序状态已更新，请刷新');
      const pending=current(reviewerId,false).tournament;
      if(pending&&pending.id!==row.id)reject(409,'请先完成或复核当前题目');
      const v=db.prepare('SELECT * FROM incremental_sort_votes WHERE id=? AND session_id=? AND active=1').get(vote_id,row.id);
      if(!v)reject(400,'只能复核本会话内仍生效的真实投票');
      if(row.review_request_id)reject(409,'请先完成当前复核');
      row=update(row,row.state,row.revision+1);const request=ensureRequest(row,'review',v);
      update(row,row.state,row.revision,request.id);
      db.prepare('INSERT INTO events(kind,reviewer_id,pair_id,body,created_at) VALUES (?,?,?,?,?)').run('incremental-vote-review-requested',reviewerId,request.pair_id,
        JSON.stringify({session_id:row.id,vote_id,revision:row.revision}),new Date().toISOString());
      return getProgress(row.id,reviewerId);
    });
  }
  function getProgress(id,reviewerId) {
    const row=read(id,reviewerId),observed=votes(id),active=observed.filter(v=>v.active),activeIds=new Set(active.map(v=>v.id));
    return{algorithm:INCREMENTAL_SORT,session_id:id,round:row.round,source_session_id:row.source_session_id,case_id:row.case_id,reviewer_id:row.reviewer_id,
      revision:row.revision,scope_hash:row.scope_hash,models:row.models,status:row.review_request_id?'reviewing':row.state.status,
      ...stageSummary(row),completed_stage_history:completedStages.filter(h=>h.session_id===row.id&&h.reviewer_id===row.reviewer_id&&h.case_id===row.case_id),
      stage:row.state.phase,merge:row.state.merge,insertion:row.state.insertion,
      current_order:row.state.ranking,ranking:!row.review_request_id&&row.state.status==='complete'?row.state.ranking:null,
      actual_votes:observed.length,active_votes:active.length,decisive_votes:active.filter(v=>v.outcome==='win').length,
      worst_case_votes:rankingComparisonBound(row.models.length),issue:row.state.issue,
      actual_vote_records:observed,derivations:db.prepare('SELECT * FROM incremental_sort_derivations WHERE session_id=? ORDER BY revision,id').all(id)
        .map(d=>{const proof=JSON.parse(d.proof);return{...d,proof,valid_under_current_votes:proof.vote_ids.every(id=>activeIds.has(id))};}),state:row.state};
  }
  function getRanking(id,reviewerId) {
    const p=getProgress(id,reviewerId);return{session_id:id,status:p.status,ranking:p.ranking,actual_votes:p.actual_votes};
  }
  function exported(){return db.prepare('SELECT id FROM incremental_sort_sessions ORDER BY reviewer_id,sequence').all().map(r=>getProgress(r.id));}
  function effectiveBallotIds(){return new Set(db.prepare('SELECT ballot_id FROM incremental_sort_votes WHERE active=1').all().map(v=>v.ballot_id));}
  function progress(reviewerId) {
    const sessions=db.prepare('SELECT id,case_id,state,review_request_id FROM incremental_sort_sessions WHERE reviewer_id=? ORDER BY sequence,created_at,id').all(reviewerId)
      .map(r=>({id:r.id,case_id:r.case_id,status:r.review_request_id?'reviewing':JSON.parse(r.state).status}));
    const observed=db.prepare('SELECT v.* FROM incremental_sort_votes v JOIN incremental_sort_sessions s ON s.id=v.session_id WHERE s.reviewer_id=?').all(reviewerId),active=observed.filter(v=>v.active);
    const completed=sessions.filter(s=>s.status==='complete').length,completedTasks=new Set(sessions.filter(s=>s.status==='complete').map(s=>s.case_id)).size;
    const focus=db.prepare('SELECT session_id FROM incremental_sort_focus WHERE reviewer_id=?').get(reviewerId);
    const currentSession=focus?sessions.find(s=>s.id===focus.session_id):sessions.find(s=>s.status!=='complete');
    const prior=db.prepare('SELECT id,case_id,reviewer_id,state FROM incremental_sort_sessions WHERE reviewer_id=?').all(reviewerId).filter(r=>previousStage(r));
    const priorCases=new Set(prior.map(r=>r.case_id)),allCompleted=new Set([...priorCases,...sessions.filter(s=>s.status==='complete').map(s=>s.case_id)]);
    return{total:null,remaining:null,done:observed.length,voted:active.filter(v=>v.outcome!=='unable').length,ties:active.filter(v=>v.outcome==='tie').length,
      skipped:active.filter(v=>v.outcome==='unable').length,actual_votes:observed.length,completed_sessions:completed,processed_sessions:completed,
      completed_tasks:completedTasks,completed_rounds:completed,assigned_sessions:sessions.length,skipped_sessions:0,tasks_per_cycle:groups.size,cycle:1,cycle_completed:completedTasks,
      started_tasks:new Set(sessions.map(s=>s.case_id)).size,
      previously_completed_tasks:priorCases.size,previously_completed_rounds:prior.length,completed_any_stage_tasks:allCompleted.size,
      pending_extension_tasks:new Set(prior.filter(r=>JSON.parse(r.state).status!=='complete').map(r=>r.case_id)).size,
      battle:currentSession?observed.filter(v=>v.session_id===currentSession.id).length+1:0,battles_per_session:null,blocked:currentSession?.status.startsWith('paused-')||false,
      open_ended:false,algorithm:INCREMENTAL_SORT,complete:completedTasks===groups.size};
  }
  return{algorithm:INCREMENTAL_SORT,current,selectTask,listTasks,progress,exported,display,record,review,getProgress,getRanking,effectiveBallotIds,
    getNext:current,submitWinner:record};
}
