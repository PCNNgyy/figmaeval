import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const CAPTURED_DELIVERY_KIND='distributed-captured-review/v1';
export const capturedHash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');

export function validateCapturedCandidate(snapshot,c){
 const source=snapshot.captured_delivery;
 if(source?.kind!==CAPTURED_DELIVERY_KIND||!/^[a-f0-9]{64}$/.test(source.manifest_sha256)
   ||snapshot.review_mode!=='screenshots-only'||c.trace_status!=='native-capture-available'
   ||c.generation_ended!==true||!Number.isFinite(Date.parse(c.finished_at))
   ||!/^[a-f0-9]{64}$/.test(c.delivery_row_sha256)||c.evidence_status!=='cached-complete'||!c.images.length
   ||typeof c.screen_check?.passed!=='boolean'||!Number.isInteger(c.screen_check.expected)||!Number.isInteger(c.screen_check.actual)
   ||c.cc_score!==null&&(!Number.isInteger(c.cc_score)||c.cc_score<0||c.cc_score>53||!c.cc_score_id||typeof c.cc_g0_pass!=='boolean')
   ||c.cc_score===null&&(c.cc_score_id!==null||c.cc_g0_pass!==null))throw Error('Invalid native-captured review candidate');
}

export function validateCapturedManifest(snapshot,directory){
 const bytes=fs.readFileSync(path.join(directory,'source-manifest.json'));
 if(capturedHash(bytes)!==snapshot.captured_delivery.manifest_sha256)throw Error('Captured review manifest changed');
 const manifest=JSON.parse(bytes),byHash=new Map(manifest.items.map(r=>[capturedHash(r.candidate),r]));
 if(manifest.kind!==CAPTURED_DELIVERY_KIND||manifest.plan_hash!==snapshot.captured_delivery.plan_hash
   ||byHash.size!==snapshot.candidates.length||manifest.items.length!==snapshot.candidates.length)throw Error('Captured review provenance differs');
 const models=snapshot.captured_delivery.model_ids;
 if(!Array.isArray(models)||new Set(models).size!==models.length||models.length<2)throw Error('Captured review model pool differs');
 for(const c of snapshot.candidates){
  const row=byHash.get(c.delivery_row_sha256),{delivery_row_sha256,...body}=c;
  if(!row||JSON.stringify(body)!==JSON.stringify(row.candidate)
    ||row.frames.length!==c.images.length||row.frames.some((f,i)=>f.sha256!==c.images[i].sha256||f.node_id!==c.images[i].node_id))throw Error('Captured review candidate changed');
 }
 const groups=Map.groupBy(snapshot.candidates,c=>c.case_id);
 const taskCount=snapshot.captured_delivery.task_count??13;
 if(!Number.isInteger(taskCount)||taskCount<1||groups.size!==taskCount
   ||(snapshot.captured_delivery.task_count!==undefined&&manifest.task_count!==taskCount))throw Error('Captured review task count differs');
 for(const group of groups.values())if(group.length!==models.length||models.some(id=>!group.some(c=>c.model_id===id)))throw Error('Incomplete captured review matrix');
}
