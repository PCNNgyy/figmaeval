import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createArenaStore,createArenaApp} from '../server/benchmark_arena.mjs';
import {buildScreenCatalog} from '../server/arena_pair_screens.mjs';
import {tournamentProtocol} from '../server/arena_tournament.mjs';

const hash=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
async function fixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'screen-case-marks-'));
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=','base64');
  const candidates=[],items=[];
  for(let task=0;task<2;task++)for(let model=0;model<6;model++) {
    const id=hash([task,model]).slice(0,24),names=['01_Home','02_Detail','Library · Buttons'];
    const images=names.map((name,index)=>{
      const file=`media/${id}/${index}.png`;fs.mkdirSync(path.join(directory,path.dirname(file)),{recursive:true});fs.writeFileSync(path.join(directory,file),png);
      return {file,width:1,height:1,node_id:`${task+3}:${model*10+index}`,sha256:hash(png)};
    });
    const c={id,case_id:`case-${task}`,title:`Task ${task}`,source_url:`https://www.figma.com/design/Source${task}/`,source_query:'Read00 and create03',model_id:`model-${model}`,model_name:`SECRET_MODEL_${model}`,run_id:`run-${task}-${model}`,workspace_id:'3:1',workspace_url:`https://www.figma.com/design/Output${task}m${model}/?page-id=3%3A1&node-id=3-1`,generation_ended:true,trace_status:'verified',screen_check:{passed:true},cc_score:20+model,cc_score_id:`score-${task}-${model}`,evidence_status:'cached-complete',images};
    candidates.push(c);items.push({run_id:c.run_id,model_id:c.model_id,copy_file_key:`Output${task}m${model}`,workspace_page_id:'3:1',frames:images.map((im,index)=>({...im,label:names[index]}))});
  }
  const snapshot={kind:'figma-human-arena-snapshot',version:3,name:'screen marks fixture',protocol:tournamentProtocol({reviewers:2}),candidates};
  fs.writeFileSync(path.join(directory,'screen-catalog.json'),JSON.stringify(buildScreenCatalog(snapshot,{items})));
  let store,server,base;
  async function open(){store=createArenaStore(directory,snapshot,{screenComparisons:true,incrementalRanking:true});server=createArenaApp(store,{basePath:'/arena-v2'}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}/arena-v2`;}
  await open();
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();fs.rmSync(directory,{recursive:true,force:true});});
  const request=async(route,body,cookie)=>{
    const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{connection:'close',...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const text=await response.text();return {status:response.status,data:response.headers.get('content-type')?.includes('json')?JSON.parse(text):text,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const login=async index=>(await request('/api/session',{access:index==='admin'?store.credentials.admin:store.credentials.reviewers[index].access})).cookie;
  const start=async()=>{const cookie=await login(0);await request('/api/review/tasks/select',{case_id:'case-0'},cookie);const pair=(await request('/api/review/next',undefined,cookie)).data.pair;const info=pair.screen_marks.A.find(m=>m.image_index===0);const body={pair_id:pair.id,side:'A',image_index:0,label:'good',reason:'布局清楚，字段完整',revision:info.revision,evidence_version:info.evidence_version,media_key:pair.drafts.A.images[0].media_key};return {cookie,pair,body};};
  return {directory,snapshot,png,request,login,start,get store(){return store;},async reopen(){await new Promise(r=>server.close(r));store.close();await open();}};
}

test('screen marks require authentication, a loaded product screen, evidence binding and a reason; never create preference votes',async t=>{
  const f=await fixture(t),{cookie,pair,body}=await f.start();
  assert.equal((await f.request('/api/review/screen-mark',body)).status,403);
  assert.equal((await f.request('/api/review/screen-mark',body,cookie)).status,400);
  await f.request(pair.drafts.A.images[0].url,undefined,cookie);
  for(const invalid of [{reason:' '},{label:'great'},{image_index:2},{image_index:-1},{evidence_version:'wrong'},{reason:{text:'x'}}])assert.ok((await f.request('/api/review/screen-mark',{...body,...invalid},cookie)).status>=400);
  const saved=await f.request('/api/review/screen-mark',body,cookie);assert.equal(saved.status,200);assert.equal(saved.data.mark.revision,1);
  const next=(await f.request('/api/review/next',undefined,cookie)).data;
  assert.equal(next.pair.screen_marks.A.find(m=>m.image_index===0).label,'good');
  assert.equal(next.pair.screen_marks.A.find(m=>m.image_index===1).label,null);
  assert.ok(!JSON.stringify(next).includes('SECRET_MODEL'));
  for(const table of ['ballots','pair_screen_votes','incremental_sort_votes'])assert.equal(f.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
  assert.equal((await f.request('/api/admin/screen-marks')).status,403);
});

test('same screen persists across pairs, A/B positions, reviewers and restarts with independent per-reviewer annotations',async t=>{
  const f=await fixture(t),{cookie,pair,body}=await f.start();await f.request(pair.drafts.A.images[0].url,undefined,cookie);await f.request('/api/review/screen-mark',body,cookie);
  const display=f.store.sides(f.store.pairById.get(pair.id),'reviewer-1');
  const other={id:'another-pair',first_id:display.B,second_id:display.A};
  const all=Object.values(f.store.screenMarks.forPair('reviewer-1',other)).flat();assert.equal(all.filter(m=>m.label==='good').length,1);
  assert.equal(Object.values(f.store.screenMarks.forPair('reviewer-2',other)).flat().filter(m=>m.label).length,0);
  await f.reopen();const newCookie=await f.login(0),next=(await f.request('/api/review/next',undefined,newCookie)).data;
  assert.equal(next.pair.screen_marks.A.find(m=>m.image_index===0).reason,body.reason);
  await f.request('/api/review/tasks/select',{case_id:'case-1'},newCookie);
  assert.equal((await f.request('/api/review/screen-mark',{...body,revision:1,label:'bad'},newCookie)).status,409);
});

test('edits are revision-checked, retries idempotent, and clearing retains audit history without losing concurrency protection',async t=>{
  const f=await fixture(t),{cookie,pair,body}=await f.start();await f.request(pair.drafts.A.images[0].url,undefined,cookie);
  await f.request('/api/review/screen-mark',body,cookie);
  assert.equal((await f.request('/api/review/screen-mark',body,cookie)).data.duplicate,true);
  assert.equal((await f.request('/api/review/screen-mark',{...body,label:'bad'},cookie)).status,409);
  assert.equal((await f.request('/api/review/screen-mark',{...body,label:'bad',reason:'底部内容被裁切',revision:1},cookie)).data.mark.revision,2);
  assert.equal((await f.request('/api/review/screen-mark',{...body,label:null,reason:'',revision:2},cookie)).data.mark.revision,3);
  assert.equal(f.store.screenMarks.exported().length,0);
  assert.equal((await f.request('/api/review/screen-mark',{...body,revision:2},cookie)).status,409);
  const events=f.store.db.prepare("SELECT body FROM events WHERE kind='screen-case-mark' ORDER BY id").all().map(r=>JSON.parse(r.body));
  assert.equal(events.length,3);assert.equal(events[1].previous.label,'good');assert.equal(events[2].previous.reason,'底部内容被裁切');assert.equal(events[2].scope,'screen');
});

test('admin exports exact screen provenance, formula-safe CSV and original PNG; altered evidence cannot be newly marked',async t=>{
  const f=await fixture(t),{cookie,pair,body}=await f.start();await f.request(pair.drafts.A.images[0].url,undefined,cookie);
  await f.request('/api/review/screen-mark',{...body,reason:'=HYPERLINK("example")'},cookie);
  const admin=await f.login('admin'),dump=await f.request('/api/admin/screen-marks',undefined,admin),r=dump.data.records[0];
  assert.equal(dump.data.scope,'screen');assert.equal(r.image_index,0);assert.equal(r.screen_name,'01_Home');assert.ok(r.model_name.startsWith('SECRET_MODEL'));assert.equal(r.image_sha256,hash(f.png));assert.equal(new URL(r.figma_url).searchParams.get('node-id'),r.node_id.replace(':','-'));
  assert.ok((await f.request('/api/admin/screen-marks.csv',undefined,admin)).data.includes("'=HYPERLINK"));
  const png=await f.request(r.image_url,undefined,admin);assert.equal(png.status,200);
  const c=f.store.candidates.get(r.candidate_id);fs.appendFileSync(path.join(f.directory,c.images[0].file),'changed');
  assert.equal((await f.request('/api/review/screen-mark',{...body,revision:1,label:'bad'},cookie)).status,409);
  assert.equal((await f.request(r.image_url,undefined,admin)).status,409);
  assert.equal(f.store.screenMarks.exported().length,1);
});
