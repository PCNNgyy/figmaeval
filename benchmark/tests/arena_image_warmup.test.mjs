import test from 'node:test';
import assert from 'node:assert/strict';
import {createImageWarmup} from '../arena/image-warmup.js';

test('only one next-screen download runs; navigation aborts even urgent prefetches and lobby never downloads a task',async t=>{
 const original={document:Object.getOwnPropertyDescriptor(globalThis,'document'),navigator:Object.getOwnPropertyDescriptor(globalThis,'navigator'),fetch:globalThis.fetch};
 const document=new EventTarget();document.hidden=false;
 Object.defineProperty(globalThis,'document',{configurable:true,value:document});
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{deviceMemory:8}});
 const requests=[];
 globalThis.fetch=(url,options)=>new Promise((resolve,reject)=>{requests.push({url,signal:options.signal});options.signal.addEventListener('abort',()=>reject(Error('aborted')));});
 const warmup=createImageWarmup({localPath:u=>'/arena-v2'+u});
 t.after(()=>{warmup.stop();globalThis.fetch=original.fetch;for(const key of ['document','navigator']){if(original[key])Object.defineProperty(globalThis,key,original[key]);else delete globalThis[key];}});
 await warmup.lobby([{case_id:'case-0',model_count:8}]);await new Promise(r=>setTimeout(r,800));assert.equal(requests.length,0);
 await warmup.task('case-0');warmup.add([0,1,2,3].map(i=>({url:'/image/'+i,media_key:String(i),bytes:500000})),0,'case-0');warmup.resume();
 await new Promise(r=>setTimeout(r,800));assert.equal(requests.length,1);assert.equal(warmup.stats().queued,1);
 warmup.pause();assert.equal(requests[0].signal.aborted,true);assert.equal(warmup.stats().queued,0);
});
