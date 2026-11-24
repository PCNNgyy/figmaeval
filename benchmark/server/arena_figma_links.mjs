import fs from 'node:fs';
import path from 'node:path';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';

const hash=value=>createHash('sha256').update(value).digest('hex');
export function canonicalFigmaUrl(candidate,index){
 const original=new URL(candidate.workspace_url),parts=original.pathname.match(/^\/(?:design|file)\/([A-Za-z0-9]+)(?:\/|$)/);
 if(original.protocol!=='https:'||!['www.figma.com','figma.com'].includes(original.hostname)||!parts)throw Error('Invalid frozen Figma URL');
 const url=new URL(`https://www.figma.com/design/${parts[1]}/`);
 url.searchParams.set('page-id',candidate.workspace_id);
 const node=index===undefined?candidate.workspace_id:candidate.images[index]?.node_id;if(!node)throw Error('Unknown screen');
 url.searchParams.set('node-id',node.replaceAll(':','-'));return url.href;
}
export function encryptFigmaCandidate(key,digest,id){
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(digest));
 const body=Buffer.concat([cipher.update(id,'utf8'),cipher.final()]);
 return ['v1',nonce.toString('base64url'),body.toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.');
}
export function decryptFigmaCandidate(key,digest,token){
 if(typeof token!=='string'||token.length>512||!/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))throw Error('Invalid anonymous link');
 const [,n,b,t]=token.split('.'),nonce=Buffer.from(n,'base64url'),tag=Buffer.from(t,'base64url');if(nonce.length!==12||tag.length!==16)throw Error('Invalid anonymous link');
 const decipher=createDecipheriv('aes-256-gcm',key,nonce);decipher.setAAD(Buffer.from(digest));decipher.setAuthTag(tag);
 return Buffer.concat([decipher.update(Buffer.from(b,'base64url')),decipher.final()]).toString('utf8');
}
export function readAnonymousFigmaLinks(directory,snapshot,digest){
 const file=path.join(directory,'figma-links.json');if(!fs.existsSync(file))return null;
 const config=JSON.parse(fs.readFileSync(file)),key=Buffer.from(JSON.parse(fs.readFileSync(path.join(directory,'figma-links-key.json'))).key,'base64');
 if(key.length!==32||config.kind!=='arena-anonymous-figma/v1'||config.snapshot_hash!==digest)throw Error('Anonymous links belong to another cohort');
 const candidates=new Map(snapshot.candidates.map(c=>[c.id,c])),entries=new Map(),aliases=new Set();
 for(const row of config.entries){
  const c=candidates.get(row.candidate_id);if(!c||entries.has(c.id)||aliases.has(row.alias)||!/^作品 [A-F0-9]{12}$/.test(row.alias)
   ||row.verified!==true||row.file_key!==new URL(canonicalFigmaUrl(c)).pathname.split('/')[2]||decryptFigmaCandidate(key,row.cipher_snapshot_hash||digest,row.token)!==c.id)throw Error('Invalid verified anonymous Figma mapping');
  entries.set(c.id,row);aliases.add(row.alias);
 }
 return{publicLink(id){const row=entries.get(id);return row?{url:'/api/review/figma/'+row.token,figma_alias:row.alias}:null;},
  resolve(value){
   const row=[...entries.values()].find(r=>r.alias===value||r.token===value);
   if(!row)throw Error('Unknown anonymous Figma link');const id=decryptFigmaCandidate(key,row.cipher_snapshot_hash||digest,row.token),candidate=candidates.get(id);
   return{row,candidate};
  },size:entries.size};
}

export function provisionAnonymousFigmaLinks(directory,verified){
 const snapshot=JSON.parse(fs.readFileSync(path.join(directory,'snapshot.json'))),digest=hash(JSON.stringify(snapshot));
 const keyFile=path.join(directory,'figma-links-key.json');
 if(!fs.existsSync(keyFile))fs.writeFileSync(keyFile,JSON.stringify({key:randomBytes(32).toString('base64')}),{mode:0o600,flag:'wx'});
 const key=Buffer.from(JSON.parse(fs.readFileSync(keyFile)).key,'base64'),existingFile=path.join(directory,'figma-links.json');
 const existing=fs.existsSync(existingFile)?readAnonymousFigmaLinks(directory,snapshot,digest):null;
 const entries=snapshot.candidates.map(c=>{
  const proof=verified.get(c.id);if(!proof||proof.file_key!==new URL(canonicalFigmaUrl(c)).pathname.split('/')[2]
   ||!['renamed','already-anonymous','kept-neutral'].includes(proof.status)||/claude|gpt|fable|opus|gemini|glm|kimi|qwen|deepseek|sonnet/i.test(proof.final_title))throw Error('Figma title has not been verified anonymous');
  const alias=proof.alias?.match(/作品 [A-F0-9]{12}$/)?.[0];if(!alias)throw Error('Missing anonymous artwork alias');
  const previous=existing?.publicLink(c.id);return{candidate_id:c.id,alias,token:previous?previous.url.split('/').at(-1):encryptFigmaCandidate(key,digest,c.id),file_key:proof.file_key,verified:true,verified_title:proof.final_title,verified_at:proof.verified_at};
 });
 const temp=existingFile+'.tmp';fs.writeFileSync(temp,JSON.stringify({kind:'arena-anonymous-figma/v1',snapshot_hash:digest,entries},null,2),{mode:0o600});fs.renameSync(temp,existingFile);
 return{candidates:entries.length};
}
