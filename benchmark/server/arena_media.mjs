import fs from 'node:fs';
import path from 'node:path';
import {createHash,createHmac} from 'node:crypto';
import {selectReviewImages} from './arena_screen_selection.mjs';
import {readDisplayImages} from './arena_display_images.mjs';

const reject=(status,message)=>{throw Object.assign(new Error(message),{status});};
export function createArenaMedia({db,directory,snapshot,digest,seed,candidates,catalog}){
  db.exec(`CREATE TABLE IF NOT EXISTS arena_media_downloads (
    reviewer_id TEXT NOT NULL REFERENCES reviewers(id), media_key TEXT NOT NULL, image_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY(reviewer_id,media_key));`);
  const registries=new Map(),verified=new Map(),sizes=new Map(),downloads=new Set();
  const named=new Map((catalog?.candidates||[]).map(c=>[c.id,c]));
  const display=readDisplayImages(directory,snapshot);
  const key=(reviewer,id,index)=>createHmac('sha256',seed).update(JSON.stringify([digest,reviewer,id,index,candidates.get(id).images[index].sha256])).digest('hex');
  function image(reviewer,id,index){
    const im=candidates.get(id)?.images[index];if(!im)reject(404,'图片不存在');
    const token=key(reviewer,id,index);
    if(!sizes.has(im.file))sizes.set(im.file,fs.statSync(path.resolve(directory,im.file)).size);
    const original=`/api/review/media/${token}`,variant=display.get(im.sha256);
    return{url:original+(variant?'?display=webp':''),...(variant?{original_url:original}:{}),media_key:token,index:index+1,width:im.width,height:im.height,bytes:variant?.bytes||sizes.get(im.file),sha256:variant?.sha256||im.sha256};
  }
  function registry(reviewer){
    if(!registries.has(reviewer)){
      const map=new Map();for(const c of snapshot.candidates)c.images.forEach((im,index)=>map.set(key(reviewer,c.id,index),{candidate_id:c.id,index,im}));
      if(registries.size>=128)registries.delete(registries.keys().next().value);
      registries.set(reviewer,map);
    }
    return registries.get(reviewer);
  }
  function download(reviewer,token,format){
    const item=registry(reviewer).get(token);if(!item)reject(404,'图片不存在');
    const file=path.resolve(directory,item.im.file),stat=fs.statSync(file,{bigint:true});
    const fingerprint=[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
    if(verified.get(file)!==fingerprint){
      if(fs.realpathSync(file)!==file||createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==item.im.sha256)reject(409,'冻结截图已变化，请反馈组织者');
      verified.set(file,fingerprint);
    }
    const receipt=reviewer+':'+token;
    if(!downloads.has(receipt)){
      db.prepare('INSERT OR IGNORE INTO arena_media_downloads VALUES (?,?,?,?)').run(reviewer,token,item.im.sha256,new Date().toISOString());
      if(downloads.size>=10000)downloads.clear();downloads.add(receipt);
    }
    const variant=format==='webp'?display.get(item.im.sha256):null;
    if(variant){
      const cached=path.resolve(directory,variant.file),stat=fs.statSync(cached,{bigint:true}),fingerprint=[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
      if(verified.get(cached)!==fingerprint){
        if(fs.realpathSync(cached)!==cached||stat.size!==BigInt(variant.bytes)||createHash('sha256').update(fs.readFileSync(cached)).digest('hex')!==variant.sha256)reject(409,'无损显示缓存已变化，请反馈组织者');
        verified.set(cached,fingerprint);
      }
      return{file:cached,sha256:variant.sha256,contentType:'webp'};
    }
    return{file,sha256:item.im.sha256,contentType:'png'};
  }
  function assertDownloaded(reviewer,id,index,token){
    const im=candidates.get(id)?.images[index];
    if(!im||key(reviewer,id,index)!==token||!db.prepare('SELECT 1 FROM arena_media_downloads WHERE reviewer_id=? AND media_key=? AND image_sha256=?').get(reviewer,token,im.sha256))reject(400,'请先加载当前屏的原图');
  }
  function preload(reviewer,caseId){
    const group=snapshot.candidates.filter(c=>c.case_id===caseId);if(!group.length)reject(400,'未知题目');
    const lists=group.map(c=>{
      const meta=named.get(c.id),indices=meta?selectReviewImages(meta.images,catalog.required_frames[caseId]||[]).images.map(im=>im.index):c.images.map((_,i)=>i);
      return indices.map(i=>image(reviewer,c.id,i));
    });
    const items=[];
    for(let i=0;i<Math.max(0,...lists.map(list=>list.length));i++)for(const list of lists)if(list[i])items.push(list[i]);
    return{case_id:caseId,items};
  }
  function cacheManifest(reviewer){
    const cases=[...new Set(snapshot.candidates.map(c=>c.case_id))].map(caseId=>{
      const {items}=preload(reviewer,caseId);
      return{case_id:caseId,title:snapshot.candidates.find(c=>c.case_id===caseId).title,items};
    });
    return{snapshot_hash:digest,cases};
  }
  return{image,download,assertDownloaded,preload,cacheManifest};
}
