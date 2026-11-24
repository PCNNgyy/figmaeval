import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDemo} from '../scripts/arena-demo.mjs';
import {createArenaStore,createArenaApp} from '../server/benchmark_arena.mjs';
test('synthetic offline demo serves the UI and a blinded reviewer API',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arena-demo-'));let store,server;
 try{
  createDemo(directory);assert.throws(()=>createDemo(directory),/fresh/);
  store=createArenaStore(directory,JSON.parse(fs.readFileSync(path.join(directory,'snapshot.json'))));
  server=createArenaApp(store,{staticDirectory:path.resolve('arena')}).listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/')).status,200);
  const login=await fetch(base+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({access:store.credentials.reviewers[0].access})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const response=await fetch(base+'/api/review/next',{headers:{cookie}});
  assert.equal(response.status,200);assert.ok(!(await response.text()).includes('demo-model-'));
 }finally{if(server)await new Promise(r=>server.close(r));store?.close();fs.rmSync(directory,{recursive:true,force:true});}
});
