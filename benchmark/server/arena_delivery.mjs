import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {requirementTexts,requirementsHash} from './arena_requirements.mjs';
import {tournamentProtocol} from './arena_tournament.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const digest=value=>sha(JSON.stringify(value));
const key=url=>{const u=new URL(url);if(u.protocol!=='https:'||!['www.figma.com','figma.com'].includes(u.hostname))throw Error('Invalid Figma URL');return u.pathname.match(/^\/(?:design|file)\/([A-Za-z0-9]+)(?:\/|$)/)?.[1];};
export const DELIVERY_KIND='external-scored-delivery/v1';
export function deliveryFile(root,relative){
  if(typeof relative!=='string'||path.isAbsolute(relative))throw Error('Unsafe delivery path');
  const base=fs.realpathSync(root),file=path.resolve(base,relative),rel=path.relative(base,file);
  if(!rel||rel.startsWith('..')||path.isAbsolute(rel)||fs.realpathSync(file)!==file||!fs.statSync(file).isFile())throw Error('Unsafe delivery path');
  return file;
}
export function validateDeliveryCandidate(snapshot,c){
  const p=snapshot.external_delivery;
  const native=c.native_revision||c.native_addition;
  if(c.native_revision&&c.native_addition)throw Error('Conflicting native provenance');
  if(native&&((c.native_revision?(native.kind!=='arena-native-delivery-revision/v1'||!/^[a-f0-9]{24}$/.test(native.previous_candidate_id)||native.previous_candidate_id===c.id)
    :native.kind!=='arena-native-delivery-addition/v1')||typeof native.task_id!=='string'||!native.task_id
    ||['plan_hash','input_sha256','capture_receipt_sha256','screen_check_sha256','blank_check_sha256','trace_audit_sha256','acceptance_sha256'].some(k=>!/^[a-f0-9]{64}$/.test(native[k]))))throw Error('Invalid native revision provenance');
  const evidence=native?c.trace_status==='native-capture-available'&&c.screen_check?.status==='native-required-screens-verified'
    &&c.screen_check.passed===true&&c.screen_check.white_screen_check_passed===true&&Number.isInteger(c.screen_check.expected)
    &&c.screen_check.expected>0&&c.screen_check.actual===c.screen_check.expected&&c.images?.length===c.screen_check.actual
    :c.trace_status==='not-delivered'&&c.screen_check?.status==='not-independently-verified'&&c.screen_check.passed===null;
  const scored=Number.isInteger(c.cc_score)&&c.cc_score>=0&&c.cc_score<=53&&c.cc_score_id&&typeof c.cc_g0_pass==='boolean';
  const pending=native&&c.cc_score===null&&c.cc_score_id===null&&c.cc_g0_pass===null;
  if(p?.kind!==DELIVERY_KIND||!/^[a-f0-9]{64}$/.test(p.manifest_sha256)||snapshot.review_mode!=='screenshots-only'
    ||!Array.isArray(p.model_ids)||!p.model_ids.includes(c.model_id)||!/^[a-f0-9]{64}$/.test(c.delivery_row_sha256)
    ||!evidence||c.generation_ended!==true||!Number.isFinite(Date.parse(c.finished_at))
    ||c.evidence_status!=='cached-complete'||!c.images.length||c.cc_method!=='fixed_v4'||c.cc_judge!=='Opus 5.5'
    ||(!scored&&!pending))throw Error('Invalid external delivery provenance');
}
export function validateDeliveryManifest(snapshot,directory){
  const bytes=fs.readFileSync(path.join(directory,'source-manifest.json'));
  if(sha(bytes)!==snapshot.external_delivery.manifest_sha256)throw Error('Frozen delivery manifest changed');
  const manifest=JSON.parse(bytes),models=snapshot.external_delivery.model_ids;
  if(new Set(models).size!==models.length||models.length<4)throw Error('Invalid delivery model pool');
  const rows=manifest.items.filter(r=>models.includes(r.model_id)),byHash=new Map(rows.map(r=>[digest(r),r]));
  if(rows.length!==snapshot.candidates.length||byHash.size!==rows.length)throw Error('Delivery matrix differs');
  for(const c of snapshot.candidates){
    const r=byHash.get(c.delivery_row_sha256),task=manifest.meta.cases.find(t=>`${t.round}-${t.case_id}`===c.case_id);
    if(!r||!task||c.case_id!==`${r.round}-${r.case_id}`||c.title!==r.title||c.source_url!==r.source_figma_url||c.source_query!==task.source_query
      ||c.model_id!==r.model_id||c.model_name!==r.model_name||c.run_id!==r.run_id||c.finished_at!==r.finished_at
      ||key(c.workspace_url)!==r.copy_file_key||c.workspace_id!==r.workspace_page_id||c.cc_score!==r.score_total||c.cc_score_id!==r.score_id
      ||JSON.stringify(c.native_revision)!==JSON.stringify(r.native_revision)
      ||JSON.stringify(c.native_addition)!==JSON.stringify(r.native_addition)
      ||c.cc_g0_pass!==r.g0_pass||c.images.length!==r.frames.length||c.images.some((im,i)=>im.sha256!==r.frames[i].sha256
        ||im.width!==r.frames[i].width||im.height!==r.frames[i].height||im.node_id!==r.frames[i].node_id))throw Error('Frozen candidate differs from delivered result');
  }
  for(const group of Map.groupBy(snapshot.candidates,c=>c.case_id).values())if(group.length!==models.length||models.some(id=>!group.some(c=>c.model_id===id)))throw Error('Incomplete delivery matrix');
}
export function frozenDeliveryLeaderboard(snapshot,{includeCoverage=false}={}){
  if(snapshot.external_delivery?.kind!==DELIVERY_KIND)throw Error('No external delivery scores');
  const groups=Map.groupBy(snapshot.candidates,c=>c.model_id),cases=new Set(snapshot.candidates.map(c=>c.case_id)).size;
  const scored=g=>g.filter(c=>Number.isInteger(c.cc_score));
  const rows=[...groups.values()].map(g=>{const values=scored(g);return{model_name:g[0].model_name,mean_score:values.length?values.reduce((s,c)=>s+c.cc_score,0)/values.length:null,
    ...(includeCoverage?{scored_count:values.length,total_count:cases}:{})};}).sort((a,b)=>a.mean_score===null?b.mean_score===null?a.model_name.localeCompare(b.model_name):1:b.mean_score===null?-1:b.mean_score-a.mean_score||a.model_name.localeCompare(b.model_name));
  let rank=0;
  return{method:'fixed_v4',max_score:53,judge:'Opus 5.5',updated_at:snapshot.source_at,complete:[...groups.values()].every(g=>scored(g).length===cases),
    ...(includeCoverage?{scored_count:snapshot.candidates.filter(c=>Number.isInteger(c.cc_score)).length,total_count:cases*groups.size}:{}),
    rows:rows.map((r,i)=>{if(r.mean_score===null)return{rank:null,...r};if(i===0||r.mean_score!==rows[i-1].mean_score)rank=i+1;return{rank,...r};})};
}

export function normalizeDeliveryRequirements(raw,task){
  if(raw.file_key!==key(task.source_url)||raw.pages?.length!==2)throw Error('Requirement source differs');
  const pages=raw.pages.map(p=>{
    if(!/^0[01]\s*[·.\-—]/.test(p.page_name)||!Array.isArray(p.texts)||!p.texts.length
      ||new Set(p.texts.map(t=>t.id)).size!==p.texts.length||p.texts.some(t=>typeof t.text!=='string'||!t.text.trim()||!Number.isFinite(t.x)||!Number.isFinite(t.y)))throw Error('Invalid extracted requirement text');
    const texts=p.texts.toSorted((a,b)=>a.y-b.y||a.x-b.x),block=t=>({kind:'text',id:t.id,text:t.text}),sections=[],used=new Set();
    const add=(name,values)=>{if(!values.length)return;sections.push({kind:'group',name,blocks:values.map(block)});values.forEach(t=>used.add(t.id));};
    const frames=/^00/.test(p.page_name)?texts.filter(t=>/^\d{2}_[A-Za-z0-9_]+$/.test(t.text)):[];
    if(frames.length){
      add('ASSIGNMENT',texts.filter(t=>t.y<frames[0].y));
      sections.push({kind:'group',name:'FRAMES EXACT DELIVER',blocks:[]});
      const left=Math.min(...frames.map(t=>t.x));
      for(const frame of frames){
        const right=Math.min(...frames.filter(f=>f.x>frame.x).map(f=>f.x),Infinity);
        const end=Math.min(...frames.filter(f=>f.x===frame.x&&f.y>frame.y).map(f=>f.y),...texts.filter(t=>t.x<left&&t.y>frame.y).map(t=>t.y),Infinity);
        add(frame.text,texts.filter(t=>!used.has(t.id)&&t.x>=frame.x&&t.x<right&&t.y>=frame.y&&t.y<end));
      }
      let values=[];
      for(const t of texts.filter(t=>!used.has(t.id))){if(t.x<left&&values.length){add(values[0].text,values);values=[];}values.push(t);}
      add(values[0]?.text||'OTHER REQUIREMENTS',values);
    }else add(/^00/.test(p.page_name)?'ASSIGNMENT':'FOUNDATIONS',texts);
    if(requirementTexts(sections).length!==p.texts.length)throw Error('Requirement extraction lost text');
    return{id:p.page_id,name:p.page_name,coverage_complete:true,text_count:p.texts.length,sections};
  });
  if(!pages.some(p=>/^00/.test(p.name))||!pages.some(p=>/^01/.test(p.name)))throw Error('Missing 00/01 requirements');
  const required_frames=requirementTexts(pages.find(p=>/^00/.test(p.name))).map(t=>t.text).filter(t=>/^\d{2}_[A-Za-z0-9_]+$/.test(t));
  if(!required_frames.length||new Set(required_frames).size!==required_frames.length)throw Error('Missing or duplicate required frame names');
  return{case_id:task.case_id,title:task.title,source_url:task.source_url,read_only:true,pages,required_frames,source_sha256:requirementsHash(pages),raw_sha256:digest(raw)};
}

export function inspectArenaDelivery(source,{excludeModelIds=[],expectedCases,expectedModels}={}){
  const manifestBytes=fs.readFileSync(path.join(source,'manifest.json')),manifest=JSON.parse(manifestBytes),rows=manifest.items;
  if(!Array.isArray(rows)||!Array.isArray(manifest.meta?.cases)||!Array.isArray(manifest.meta?.models)||manifest.meta.judge!=='Opus 5.5')throw Error('Invalid delivery manifest');
  const modelIds=manifest.meta.models.map(m=>m.model_id).filter(id=>!excludeModelIds.includes(id)),selected=rows.filter(r=>modelIds.includes(r.model_id));
  if(new Set(modelIds).size!==modelIds.length||modelIds.length<4||expectedModels&&modelIds.length!==expectedModels)throw Error('Unexpected model pool');
  const tasks=manifest.meta.cases.map(c=>({...c,case_id:`${c.round}-${c.case_id}`,original_case_id:c.case_id,source_url:c.source_figma_url}));
  if(new Set(tasks.map(c=>c.case_id)).size!==tasks.length||expectedCases&&tasks.length!==expectedCases||selected.length!==tasks.length*modelIds.length)throw Error('Incomplete task/model matrix');
  const byTask=new Map(tasks.map(c=>[c.case_id,c])),seen=new Set(),outputs=new Set(),sources=new Set(tasks.map(c=>key(c.source_url))),candidates=[],imageFiles=[];
  for(const r of selected){
    const task=byTask.get(`${r.round}-${r.case_id}`),cell=`${task?.case_id}:${r.model_id}`,model=manifest.meta.models.find(m=>m.model_id===r.model_id),copy=key(r.copy_figma_url);
    if(!task||seen.has(cell)||r.title!==task.title||r.source_figma_url!==task.source_url||!task.source_query?.includes(task.source_url)
      ||!copy||copy!==r.copy_file_key||sources.has(copy)||outputs.has(copy)||r.workspace_page_name!=='03 · Workspace'||!/^\d+:\d+$/.test(r.workspace_page_id)
      ||model?.name!==r.model_name||!r.run_id||!Number.isFinite(Date.parse(r.finished_at))||r.rubric!=='fixed_v4'||r.judge_model_id!=='model_claude_opus55_direct'
      ||r.score_max!==53||!Number.isInteger(r.score_total)||r.score_total<0||r.score_total>53||!r.score_id||typeof r.g0_pass!=='boolean'
      ||!Array.isArray(r.frames)||!r.frames.length||r.frames.length!==r.frame_count||new Set(r.frames.map(i=>i.node_id)).size!==r.frames.length)throw Error(`Invalid or duplicate delivery cell ${cell}`);
    if(r.g0_pass&&(Object.keys(r.items||{}).length!==22||Object.values(r.items).some(v=>!Number.isInteger(v)||v<0)||Object.values(r.items).reduce((s,v)=>s+v,0)!==r.score_total))throw Error('CC score components differ');
    const id=digest([task.case_id,r.model_id,r.run_id,copy]).slice(0,24),url=new URL(`https://www.figma.com/design/${copy}/`);
    url.searchParams.set('page-id',r.workspace_page_id);url.searchParams.set('node-id',r.workspace_page_id.replaceAll(':','-'));
    const images=r.frames.map((im,i)=>{
      const file=deliveryFile(source,im.file),bytes=fs.readFileSync(file);
      if(!/^[a-f0-9]{64}$/.test(im.sha256)||sha(bytes)!==im.sha256||bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'
        ||bytes.subarray(12,16).toString()!=='IHDR'||bytes.readUInt32BE(16)!==im.width||bytes.readUInt32BE(20)!==im.height||!im.width||!im.height)throw Error('Delivery PNG differs from manifest');
      imageFiles.push({source:file,file:`media/${id}/${i}.png`});return{file:`media/${id}/${i}.png`,sha256:im.sha256,width:im.width,height:im.height,node_id:im.node_id};
    });
    candidates.push({id,case_id:task.case_id,title:task.title,source_query:task.source_query,source_url:task.source_url,model_id:r.model_id,model_name:r.model_name,
      run_id:r.run_id,workspace_url:url.href,workspace_id:r.workspace_page_id,trace_status:'not-delivered',generation_ended:true,finished_at:r.finished_at,
      screen_check:{status:'not-independently-verified',passed:null,delivered_screens:r.frame_count},delivery_row_sha256:digest(r),
      evidence_status:'cached-complete',images,cc_score:r.score_total,cc_score_id:r.score_id,cc_method:r.rubric,cc_judge:'Opus 5.5',cc_g0_pass:r.g0_pass});
    seen.add(cell);outputs.add(copy);
  }
  const requirements=tasks.map(task=>normalizeDeliveryRequirements(JSON.parse(fs.readFileSync(deliveryFile(source,`requirements/raw/${key(task.source_url)}.json`))),task));
  return{manifest,candidates,imageFiles,requirements,snapshot:{kind:'figma-human-arena-snapshot',version:3,name:`Bench v2 · ${tasks.length}题 × ${modelIds.length}模型`,created_at:new Date().toISOString(),source_at:manifest.meta.generated_at,
    protocol:tournamentProtocol({reviewers:1}),review_mode:'screenshots-only',external_delivery:{kind:DELIVERY_KIND,manifest_sha256:sha(manifestBytes),model_ids:modelIds,
      excluded_model_ids:excludeModelIds,trace_qualification:'Original inference traces not delivered; not independently verified',screen_qualification:'All delivered PNGs hash/dimension checked; task screen completeness not independently certified',
      selection_rule:manifest.meta.selection_rule},candidates}};
}
