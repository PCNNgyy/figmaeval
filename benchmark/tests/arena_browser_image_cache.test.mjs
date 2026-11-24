import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserImageCache} from '../arena/browser-image-cache.js';

function fixture({fetchImage,storage}={}){
  const rows=new Map(),requests=[],blob=new Blob(['image bytes'],{type:'image/png'});
  const cases=['one','two'].map(case_id=>({case_id,title:case_id,items:Array.from({length:3},(_,i)=>({url:'/api/review/media/'+case_id+i,bytes:blob.size,sha256:'hash-'+case_id+i}))}));
  const disk=storage||{keys:async()=>[...rows.keys()],get:async key=>rows.get(key),put:async row=>{rows.set(row.url,row);},remove:async keys=>{for(const key of keys)rows.delete(key);}};
  const fetcher=fetchImage||(async url=>{requests.push(url);return new Response(blob,{headers:{'content-type':'image/png',etag:'"'+cases.flatMap(c=>c.items).find(im=>'/arena'+im.url===url).sha256+'"'}});});
  const make=()=>createBrowserImageCache({api:async()=>({snapshot_hash:'snapshot',cases}),localPath:url=>'/arena'+url,storage:disk,fetchImage:fetcher});
  return{make,rows,requests,blob,cases};
}

test('explicit caching persists compressed images across instances, resumes missing files, and isolates per-task work',async()=>{
  const f=fixture(),cache=f.make();await cache.init();assert.equal(f.requests.length,0);
  await cache.start('one');assert.equal(f.requests.length,3);assert.equal(cache.stats().cached,3);
  const restored=f.make();await restored.init();assert.equal(restored.stats().cached,3);
  const url=await restored.source(f.requests[0]);assert.match(url,/^blob:/);URL.revokeObjectURL(url);
  await restored.start();assert.equal(f.requests.length,6);assert.equal(restored.stats().cached,6);
  await restored.start();assert.equal(f.requests.length,6,'completed images are never downloaded again');
  await restored.clear();assert.equal(f.rows.size,0);assert.equal(restored.stats().cached,0);
});

test('entering review aborts every background transfer and does not mark partial downloads as cached',async()=>{
  const pending=[];
  const f=fixture({fetchImage:(url,{signal})=>new Promise((resolve,reject)=>{pending.push({url,signal});signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})));})});
  const cache=f.make(),job=cache.start();
  while(pending.length<2)await new Promise(r=>setTimeout(r,1));
  cache.pause('review');await job;assert.ok(pending.every(p=>p.signal.aborted));
  assert.equal(cache.stats().cached,0);assert.equal(cache.stats().failed,0);assert.equal(cache.stats().status,'review');
});

test('failed, truncated and wrong-version downloads remain retryable and never become local image sources',async()=>{
  let healthy=false;const f=fixture();
  const cache=createBrowserImageCache({api:async()=>({cases:f.cases}),localPath:u=>'/arena'+u,
    storage:{keys:async()=>[],get:async key=>f.rows.get(key),put:async row=>f.rows.set(row.url,row),remove:async()=>{}},
    fetchImage:async url=>{const im=f.cases.flatMap(c=>c.items).find(im=>'/arena'+im.url===url);return new Response(healthy?f.blob:'x',{status:!healthy&&url.endsWith('2')?503:200,headers:{'content-type':'image/png',etag:'"'+(!healthy&&url.endsWith('1')?'wrong-version':im.sha256)+'"'}});}});
  await cache.start();assert.equal(cache.stats().cached,0);assert.equal(cache.stats().failed,6);
  assert.equal(await cache.source('/arena'+f.cases[0].items[0].url),'/arena'+f.cases[0].items[0].url);
  healthy=true;await cache.start();assert.equal(cache.stats().cached,6);assert.equal(cache.stats().failed,0);
});

test('a replacement snapshot cannot reuse older opaque image URLs and quota failures stop downloading',async()=>{
  const f=fixture(),first=f.make();await first.start('one');assert.equal(f.rows.size,3);
  for(const c of f.cases)for(const im of c.items)im.url+='-replacement';
  const next=f.make();await next.init();assert.equal(next.stats().cached,0);
  assert.equal(next.stats().stored,3,'old snapshots remain clearable when none of the current images are cached');
  assert.equal(await next.source('/arena'+f.cases[0].items[0].url),'/arena'+f.cases[0].items[0].url);
  await next.clear();assert.equal(f.rows.size,0);
  const limited=fixture({storage:{keys:async()=>[],get:async()=>null,put:async()=>{throw Object.assign(Error('full'),{name:'QuotaExceededError'});}}});
  const quota=limited.make();await quota.start();assert.equal(quota.stats().cached,0);assert.equal(quota.stats().status,'error');assert.match(quota.stats().error,/空间不足/);
});

test('storage denial keeps foreground loading available; outdated asynchronous image reads cannot replace a newer screen',async()=>{
  const f=fixture({storage:{keys:async()=>{throw Error('storage denied');},get:async()=>{throw Error('storage denied');}}}),cache=f.make();
  await cache.init();assert.equal(cache.stats().status,'unavailable');assert.equal(await cache.source('/remote'),'/remote');
  const image={src:'newer screen'};await cache.mount(image,'/older',()=>false);assert.equal(image.src,'newer screen');
});

test('navigation while the manifest is loading prevents a late background download from starting',async()=>{
  let resolveManifest;const f=fixture(),cache=createBrowserImageCache({api:()=>new Promise(r=>{resolveManifest=r;}),localPath:u=>u,
    storage:{keys:async()=>[]},fetchImage:async()=>{throw Error('Must not download after navigation');}});
  const starting=cache.start();cache.pause('review');resolveManifest({cases:f.cases});await starting;
  assert.equal(cache.stats().running,false);assert.equal(cache.stats().cached,0);
});
