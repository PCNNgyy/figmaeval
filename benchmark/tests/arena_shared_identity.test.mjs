import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createArenaStore,createArenaApp} from '../server/benchmark_arena.mjs';
import {tournamentProtocol} from '../server/arena_tournament.mjs';

function snapshot(prefix,n){return{kind:'figma-human-arena-snapshot',version:3,name:prefix,protocol:tournamentProtocol(),
 candidates:Array.from({length:n},(_,j)=>({id:createHash('sha256').update(prefix+j).digest('hex').slice(0,24),case_id:prefix,
 title:prefix,source_url:`https://www.figma.com/design/Source${prefix}`,source_query:'Read 00 and build in 03',
 model_id:`model-${j}`,model_name:`Anonymous model ${j}`,run_id:`run-${prefix}-${j}`,workspace_id:'3:1',
 workspace_url:`https://www.figma.com/design/Output${prefix}${j}/?page-id=3%3A1&node-id=3-1`,generation_ended:true,
 trace_status:'verified',screen_check:{passed:true},cc_score:null,evidence_status:'live-view-required',images:[]}))};}

test('original identity and login work across cohorts while votes, sorting progress and disabled state stay isolated',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'arena-cohorts-'));
 const old=createArenaStore(path.join(root,'old'),snapshot('old',6),{openRegistration:true,incrementalRanking:true});
 const fresh=createArenaStore(path.join(root,'new'),snapshot('new',8),{openRegistration:true,incrementalRanking:true});
 const original=createArenaApp(old,{basePath:'/arena-v2',reviewerSelection:true});
 const added=createArenaApp(fresh,{basePath:'/arena-v2/new13',reviewerSelection:true,identitySourceStore:old,identityCookiePath:'/arena-v2/'});
 const server=http.createServer((req,res)=>(req.url.startsWith('/arena-v2/new13/')?added:original)(req,res));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));fresh.close();old.close();fs.rmSync(root,{recursive:true,force:true});});
 const request=async(p,body,cookie)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}${p}`,{
  method:body===undefined?'GET':'POST',headers:{connection:'close',...(body===undefined?{}:{'content-type':'application/json'}),...(cookie?{cookie}:{})},
  ...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json(),setCookie:response.headers.get('set-cookie'),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
 const login=await request('/arena-v2/api/reviewers/enroll',{name:'原设计师',profile_secret:'s'.repeat(48)});
 const id=old.activeReviewers.find(r=>r.label==='原设计师').id;
 const first=old.next(id).pair;for(const side of ['A','B'])old.seen(id,first.id,side,'figma');old.vote(id,{pair_id:first.id,choice:'A'});
 const before={ballots:old.db.prepare('SELECT * FROM ballots').all(),sessions:old.db.prepare('SELECT * FROM incremental_sort_sessions').all()};
 const inherited=await request('/arena-v2/new13/api/session',undefined,login.cookie);
 assert.equal(inherited.data.role,'reviewer');assert.equal(inherited.data.label,'原设计师');
 const chosen=await request('/arena-v2/new13/api/reviewers/select-existing',{reviewer_id:id},login.cookie);
 assert.equal(chosen.status,200);assert.match(chosen.setCookie,/Path=\/arena-v2\//);
 assert.equal((await request('/arena-v2/api/session',undefined,chosen.cookie)).data.label,'原设计师');
 assert.equal(fresh.activeReviewers.find(r=>r.label==='原设计师').id,id);
 const changes=fresh.db.prepare('SELECT total_changes() n').get().n;
 for(let i=0;i<3;i++)assert.equal((await request('/arena-v2/new13/api/session',undefined,chosen.cookie)).data.role,'reviewer');
 assert.equal(fresh.db.prepare('SELECT total_changes() n').get().n,changes,'ordinary reads must not rewrite identical identities');
 let count=0;
 for(;;){const current=fresh.next(id);if(!current.pair)break;const pair=current.pair;
  for(const side of ['A','B'])fresh.seen(id,pair.id,side,'figma');
  const sides=fresh.sides(fresh.pairById.get(pair.id),id),a=fresh.candidates.get(sides.A),b=fresh.candidates.get(sides.B);
  fresh.vote(id,{pair_id:pair.id,choice:a.model_id<b.model_id?'A':'B'});assert.ok(++count<=19);}
 assert.equal(fresh.incremental.exported().find(s=>s.reviewer_id===id).status,'complete');
 assert.deepEqual(old.db.prepare('SELECT * FROM ballots').all(),before.ballots);
 assert.deepEqual(old.db.prepare('SELECT * FROM incremental_sort_sessions').all(),before.sessions);
 const registered=await request('/arena-v2/new13/api/reviewers/enroll',{name:'后续评审',profile_secret:'n'.repeat(48)});
 assert.equal(registered.status,200);assert.equal(old.activeReviewers.find(r=>r.label==='后续评审').id,fresh.activeReviewers.find(r=>r.label==='后续评审').id);
 old.db.prepare('UPDATE reviewer_accounts SET enabled=0 WHERE reviewer_id=?').run(id);
 assert.equal((await request('/arena-v2/new13/api/session',undefined,chosen.cookie)).data.role,null);
 assert.equal((await request('/arena-v2/new13/api/reviewers/select-existing',{reviewer_id:id})).status,403);
});
