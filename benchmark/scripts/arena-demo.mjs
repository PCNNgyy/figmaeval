import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {spawn} from 'node:child_process';
const sha=b=>createHash('sha256').update(b).digest('hex');
function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(name,bytes){const type=Buffer.from(name),len=Buffer.alloc(4),crc=Buffer.alloc(4);len.writeUInt32BE(bytes.length);crc.writeUInt32BE(crc32(Buffer.concat([type,bytes])));return Buffer.concat([len,type,bytes,crc]);}
export function syntheticPng(variant){
 const w=360,h=640,data=Buffer.alloc(h*(1+w*3));
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const at=y*(1+w*3)+1+x*3;let rgb=[245,247,250];
  if(x>20&&x<340&&y>20&&y<100)rgb=variant?[22,115,105]:[40,72,155];
  if(x>20&&x<340&&y>125&&y<560&&((y-125)%95)<75)rgb=variant?[213,234,230]:[215,223,246];
  if(x>40&&x<230&&y>145&&y<555&&((y-145)%95)<12)rgb=[100,110,130];
  data.set(rgb,at);
 }
 const header=Buffer.alloc(13);header.writeUInt32BE(w,0);header.writeUInt32BE(h,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(data)),chunk('IEND',Buffer.alloc(0))]);
}
export function createDemo(directory){
 fs.mkdirSync(directory,{recursive:true,mode:0o700});
 if(fs.existsSync(path.join(directory,'snapshot.json')))throw Error('Use a fresh demo directory; do not overwrite an Arena round');
 const candidates=Array.from({length:3},(_,i)=>{
  const id=sha(`synthetic-${i}`).slice(0,24),bytes=syntheticPng(i%2),file=`media/${id}/0.png`;
  fs.mkdirSync(path.join(directory,'media',id),{recursive:true});fs.writeFileSync(path.join(directory,file),bytes);
  return{id,case_id:'demo-task',title:'Synthetic catalog',model_id:`demo-model-${i}`,model_name:`Demo model ${i+1}`,
   run_id:`synthetic-${i}`,source_url:'https://www.figma.com/design/demoSource/',
   source_query:'Synthetic fixture: compare catalog layouts. These are not benchmark results.',
   workspace_url:`https://www.figma.com/design/demoOutput${i}/?page-id=3%3A1&node-id=3-1`,workspace_id:'3:1',
   trace_status:'verified',evidence_status:'cached-complete',images:[{file,sha256:sha(bytes),width:360,height:640,node_id:'3:2',name:'01_Catalog'}]};
 });
 fs.writeFileSync(path.join(directory,'snapshot.json'),JSON.stringify({kind:'figma-human-arena-snapshot',version:1,
  name:'Synthetic offline demo',review_mode:'screenshots-only',candidates},null,2));
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 const directory=path.resolve(process.argv[2]||'outputs/arena-demo');createDemo(directory);
 console.log(`Demo credentials will be written to ${path.join(directory,'access.json')}. Open http://127.0.0.1:18186`);
 const child=spawn(process.execPath,[path.join(import.meta.dirname,'benchmark-arena.mjs'),'--directory',directory,'--host','127.0.0.1'],{stdio:'inherit'});
 for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>child.kill(sig));
 child.on('exit',code=>process.exitCode=code??1);
}
