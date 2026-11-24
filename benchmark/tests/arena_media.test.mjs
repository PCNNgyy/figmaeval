import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createArenaStore,createArenaApp} from '../server/benchmark_arena.mjs';
import {buildScreenCatalog} from '../server/arena_pair_screens.mjs';
import {tournamentProtocol} from '../server/arena_tournament.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
async function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arena-media-'));
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=','base64'),items=[];
  const candidates=Array.from({length:2},(_,i)=>Array.from({length:6},(_,j)=>{
    const id=hash(`${i}:${j}`).slice(0,24),images=['01_Home','02_Detail','Library · Buttons'].map((name,k)=>{
      const file=`media/${id}/${k}.png`;fs.mkdirSync(path.join(directory,path.dirname(file)),{recursive:true});fs.writeFileSync(path.join(directory,file),png);
      return{file,width:1,height:1,node_id:`${i+3}:${j*10+k}`,sha256:hash(png)};
    });
    const c={id,case_id:`case-${i}`,title:`Task ${i}`,source_url:`https://www.figma.com/design/Source${i}/`,source_query:'Read00 and create03',model_id:`model-${j}`,model_name:`SECRET_${j}`,run_id:`run-${i}-${j}`,workspace_id:'3:1',workspace_url:`https://www.figma.com/design/Output${i}m${j}/?page-id=3%3A1&node-id=3-1`,generation_ended:true,trace_status:'verified',screen_check:{passed:true},cc_score:j,cc_score_id:`score-${i}-${j}`,evidence_status:'cached-complete',images};
    items.push({run_id:c.run_id,model_id:c.model_id,copy_file_key:`Output${i}m${j}`,workspace_page_id:'3:1',frames:images.map((im,k)=>({...im,label:['01_Home','02_Detail','Library · Buttons'][k]}))});return c;
  })).flat();
  const snapshot={kind:'figma-human-arena-snapshot',version:3,name:'media fixture',protocol:tournamentProtocol({reviewers:2}),candidates};
  fs.writeFileSync(path.join(directory,'screen-catalog.json'),JSON.stringify(buildScreenCatalog(snapshot,{items})));
  const store=createArenaStore(directory,snapshot,{screenComparisons:true,incrementalRanking:true}),server=createArenaApp(store,{basePath:'/arena-v2'}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();fs.rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}/arena-v2`;
  const request=async(url,body,cookie)=>fetch(base+url,{method:body===undefined?'GET':'POST',headers:{...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const login=async i=>(await request('/api/session',{access:store.credentials.reviewers[i].access})).headers.get('set-cookie').split(';')[0];
  return{store,directory,base,png,request,login,snapshot};
}

test('opaque native PNG cache is stable and reviewer-bound; prefetch neither assigns a task nor records a viewed screen',async t=>{
  const f=await fixture(t),cookie=await f.login(0),other=await f.login(1);
  const catalog=await(await f.request('/api/review/tasks',undefined,cookie)).json();assert.equal(catalog.tasks.length,2);
  const plan=await(await f.request('/api/review/preload?case_id=case-1',undefined,cookie)).json();assert.equal(plan.items.length,12);assert.ok(!JSON.stringify(plan).includes('SECRET'));
  assert.equal(f.store.incremental.exported().length,0);
  const im=plan.items[0],response=await f.request(im.url,undefined,cookie);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.png);
  assert.match(response.headers.get('cache-control'),/private.*immutable/);assert.equal(response.headers.get('etag'),`"${hash(f.png)}"`);
  const changes=f.store.db.prepare('SELECT total_changes() n').get().n;
  assert.equal((await fetch(f.base+im.url,{headers:{cookie,'if-none-match':response.headers.get('etag')}})).status,304);
  assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,changes,'a repeated cached download must not issue another database write');
  assert.equal((await f.request(im.url)).status,403);assert.equal((await f.request(im.url,undefined,other)).status,404);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM pair_screen_image_views').get().n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM ballots').get().n,0);
});

test('batch cache manifest is anonymous and reviewer-bound without assigning tasks or granting view receipts',async t=>{
  const f=await fixture(t),cookie=await f.login(0),other=await f.login(1);
  assert.equal((await f.request('/api/review/cache-manifest')).status,403);
  const manifest=await(await f.request('/api/review/cache-manifest',undefined,cookie)).json();
  const headers=(await f.request('/api/session',undefined,cookie)).headers;
  assert.match(headers.get('content-security-policy'),/img-src 'self' data: blob:/);
  assert.match(headers.get('content-security-policy'),/script-src 'self';/);
  assert.equal(manifest.snapshot_hash,f.store.digest);assert.equal(manifest.cases.length,2);
  assert.ok(!JSON.stringify(manifest).includes('SECRET'));assert.ok(!JSON.stringify(manifest).includes('model_id'));
  for(const c of manifest.cases){
    assert.equal(c.items.length,12);
    for(const image of c.items){
      assert.equal(image.sha256,hash(f.png));assert.equal(image.bytes,f.png.length);
      assert.equal((await f.request(image.url,undefined,cookie)).status,200);
      assert.equal((await f.request(image.url,undefined,other)).status,404);
    }
  }
  assert.equal(f.store.incremental.exported().length,0);
  for(const table of ['pair_screen_image_views','pair_screen_votes','ballots'])assert.equal(f.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
});

test('lossless display copies keep original receipts, reviewer isolation, PNG access and tamper checks',async t=>{
 const f=await fixture(t),im=f.snapshot.candidates[0].images[0];
 const webp=Buffer.from('UklGRhoAAABXRUJQVlA4TA4AAAAvAAAAAAcQEf0PRET/Aw==','base64');
 const file=`display-media/${im.sha256}.webp`;fs.mkdirSync(path.join(f.directory,'display-media'));fs.writeFileSync(path.join(f.directory,file),webp);
 const meta={kind:'arena-lossless-display/v1',variants:{[im.sha256]:{source_sha256:im.sha256,file,sha256:hash(webp),pixel_sha256:'f'.repeat(64),width:1,height:1,bytes:webp.length}}};
 fs.writeFileSync(path.join(f.directory,'display-media.json'),JSON.stringify(meta));
 const {createArenaMedia}=await import('../server/arena_media.mjs');
 const media=createArenaMedia({db:f.store.db,directory:f.directory,snapshot:f.snapshot,digest:f.store.digest,seed:f.store.credentials.seed,candidates:f.store.candidates});
 const image=media.image('reviewer-1',f.snapshot.candidates[0].id,0);assert.match(image.url,/\?display=webp$/);assert.equal(image.bytes,webp.length);
 assert.equal(media.download('reviewer-1',image.media_key,'webp').contentType,'webp');media.assertDownloaded('reviewer-1',f.snapshot.candidates[0].id,0,image.media_key);
 assert.equal(media.download('reviewer-1',image.media_key).contentType,'png');assert.throws(()=>media.download('reviewer-2',image.media_key,'webp'),/不存在/);
 fs.appendFileSync(path.join(f.directory,file),'tamper');assert.throws(()=>media.download('reviewer-1',image.media_key,'webp'),/缓存已变化/);
 meta.variants[im.sha256].width=2;fs.writeFileSync(path.join(f.directory,'display-media.json'),JSON.stringify(meta));assert.throws(()=>createArenaMedia({db:f.store.db,directory:f.directory,snapshot:f.snapshot,digest:f.store.digest,seed:f.store.credentials.seed,candidates:f.store.candidates}),/does not match/);
});

test('cached downloads require explicit current-screen render receipts, while task switches reject stale receipts',async t=>{
  const f=await fixture(t),cookie=await f.login(0);await f.request('/api/review/tasks/select',{case_id:'case-0'},cookie);
  const next=await(await f.request('/api/review/next',undefined,cookie)).json(),p=next.pair,s=p.screen_comparison,row=s.rows[0];
  assert.deepEqual(next.choices,['A','B','unable']);
  const vote={pair_id:p.id,plan_hash:s.plan_hash,slot_id:row.id,choice:'A',revision:0,viewed:true};
  const images=['A','B'].map(side=>({side,index:row[side],media_key:p.drafts[side].images[row[side]].media_key}));
  const seen={pair_id:p.id,plan_hash:s.plan_hash,slot_id:row.id,images};
  assert.equal((await f.request('/api/review/screen-viewed',seen,cookie)).status,400);
  for(const side of ['A','B'])assert.equal((await f.request(p.drafts[side].images[row[side]].url,undefined,cookie)).status,200);
  assert.equal((await f.request('/api/review/screen-vote',vote,cookie)).status,400);
  assert.equal((await f.request('/api/review/screen-viewed',seen,cookie)).status,200);
  assert.equal((await f.request('/api/review/screen-vote',vote,cookie)).status,200);
  assert.equal((await f.request('/api/review/vote',{pair_id:p.id,choice:'tie'},cookie)).status,400);
  await f.request('/api/review/tasks/select',{case_id:'case-1'},cookie);
  assert.equal((await f.request('/api/review/screen-viewed',seen,cookie)).status,409);
  assert.equal(f.store.media.image('reviewer-1',f.store.sides(f.store.pairById.get(p.id),'reviewer-1').A,row.A).url,p.drafts.A.images[row.A].url);
  const c=f.store.candidates.get(f.store.sides(f.store.pairById.get(p.id),'reviewer-1').A);fs.appendFileSync(path.join(f.directory,c.images[row.A].file),'tampered');
  assert.equal((await f.request(p.drafts.A.images[row.A].url,undefined,cookie)).status,409);
});
