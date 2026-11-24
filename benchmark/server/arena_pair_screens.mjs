import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {seal,verifySeal} from './benchmark_protocol.mjs';
import {frameKey,requiredScreenNames,selectReviewImages,SCREEN_SELECTION_POLICY} from './arena_screen_selection.mjs';
export {frameKey} from './arena_screen_selection.mjs';

const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
export const SCREEN_COMPARISON_KIND='figma-arena-pair-screens/v1';
const blind=name=>String(name).replace(/(?:claude\s*)?(?:opus|fable|gemini|gpt|glm|qwen|kimi)(?:[\s._-]*[\d.]+)?(?:\s*(?:flash|astra))?/gi,'匿名稿件');

export function buildScreenCatalog(snapshot,manifest,requirements=null){
  const items=new Map((manifest.items||[]).map(item=>[item.run_id,item]));
  const candidates=snapshot.candidates.map(c=>{
    const item=items.get(c.run_id);
    if(!item||item.model_id!==c.model_id||item.workspace_page_id!==c.workspace_id
      ||new URL(c.workspace_url).pathname.split('/')[2]!==item.copy_file_key)throw Error('Screen metadata does not match the frozen run');
    const named=new Map((item.workspace_top_level||[]).map(n=>[n.id,n.name]));
    const frames=new Map((item.frames||[]).map(f=>[f.node_id,f]));
    const images=c.images.map((im,index)=>{
      const frame=frames.get(im.node_id),name=frame?.label||frame?.name||named.get(im.node_id);
      if(!name||!frame||frame.sha256!==im.sha256||frame.width!==im.width||frame.height!==im.height)throw Error('Named screen is missing or its frozen image changed');
      return{index,node_id:im.node_id,sha256:im.sha256,name:String(name)};
    });
    return{id:c.id,run_id:c.run_id,case_id:c.case_id,workspace_id:c.workspace_id,images};
  });
  return seal({kind:'figma-arena-screen-catalog/v1',snapshot_hash:hash(snapshot),
    screen_selection_policy:SCREEN_SELECTION_POLICY,
    source_manifest_hash:hash(manifest),created_at:new Date().toISOString(),
    required_frames:Object.fromEntries((requirements?.cases||[]).map(c=>[c.case_id,requiredScreenNames(c)])),candidates});
}

export function readScreenCatalog(directory,snapshot,digest){
  const catalog=verifySeal(JSON.parse(fs.readFileSync(path.join(directory,'screen-catalog.json'),'utf8')));
  if(catalog.kind!=='figma-arena-screen-catalog/v1'||catalog.snapshot_hash!==digest
    ||catalog.candidates?.length!==snapshot.candidates.length)throw Error('Screen catalog does not match the frozen cohort');
  const ids=new Set();
  for(const row of catalog.candidates){
    const c=snapshot.candidates.find(c=>c.id===row.id);
    if(!c||ids.has(row.id)||c.run_id!==row.run_id||c.case_id!==row.case_id||c.workspace_id!==row.workspace_id
      ||row.images?.length!==c.images.length)throw Error('Invalid screen catalog candidate');
    ids.add(row.id);
    row.images.forEach((im,index)=>{const original=c.images[index];
      if(im.index!==index||im.node_id!==original.node_id||im.sha256!==original.sha256||typeof im.name!=='string'||!im.name.trim())throw Error('Screen catalog image changed');});
  }
  return catalog;
}

export function alignScreens(first,second,required=[]){
  first=selectReviewImages(first,required).images;second=selectReviewImages(second,required).images;
  const keys=new Map(),add=name=>{const key=frameKey(name);if(!keys.has(key))keys.set(key,{name:blind(name),key});};
  required.forEach(add);first.forEach(im=>add(im.name));second.forEach(im=>add(im.name));
  const rows=[];
  for(const {name,key} of keys.values()){
    const a=first.filter(im=>frameKey(im.name)===key),b=second.filter(im=>frameKey(im.name)===key);
    for(let i=0;i<Math.max(a.length,b.length,1);i++)rows.push({id:hash([key,i]).slice(0,20),name,
      required:required.some(n=>frameKey(n)===key),duplicate:a.length>1||b.length>1,
      A:a[i]?.index??null,B:b[i]?.index??null,manual:false});
  }
  return rows;
}

export function createPairScreenReview({db,catalog,snapshotHash,candidates,currentPair,sides,assertActive}){
  const named=new Map(catalog.candidates.map(c=>[c.id,c]));
  const requiredFrames=caseId=>catalog.required_frames[caseId]||[];
  const selected=id=>selectReviewImages(named.get(id).images,requiredFrames(named.get(id).case_id));
  db.exec(`CREATE TABLE IF NOT EXISTS pair_screen_plans (
    reviewer_id TEXT NOT NULL REFERENCES reviewers(id),pair_id TEXT NOT NULL REFERENCES pairs(id),
    body TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(reviewer_id,pair_id));
    CREATE TABLE IF NOT EXISTS pair_screen_votes (
    reviewer_id TEXT NOT NULL REFERENCES reviewers(id),pair_id TEXT NOT NULL REFERENCES pairs(id),
    slot_id TEXT NOT NULL,choice TEXT NOT NULL,comment TEXT NOT NULL,revision INTEGER NOT NULL,
    evidence_hash TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(reviewer_id,pair_id,slot_id));
    CREATE TABLE IF NOT EXISTS pair_screen_image_views (
    reviewer_id TEXT NOT NULL REFERENCES reviewers(id),pair_id TEXT NOT NULL REFERENCES pairs(id),
    candidate_id TEXT NOT NULL REFERENCES candidates(id),image_index INTEGER NOT NULL,
    image_sha256 TEXT NOT NULL,opened_at TEXT NOT NULL,PRIMARY KEY(reviewer_id,pair_id,candidate_id,image_index));`);
  function check(reviewer,pairId){
    assertActive(reviewer);
    if(currentPair(reviewer)?.id!==pairId)fail(409,'这一组已提交或不属于当前评审，请刷新');
  }
  const votes=(reviewer,pairId)=>db.prepare('SELECT * FROM pair_screen_votes WHERE reviewer_id=? AND pair_id=? ORDER BY slot_id').all(reviewer,pairId);
  function reconcile(reviewer,pair,saved){
    if(db.prepare('SELECT 1 FROM ballots WHERE reviewer_id=? AND pair_id=?').get(reviewer,pair.id))return saved;
    const display=sides(pair,reviewer),previous=JSON.parse(saved.body),fresh=alignScreens(named.get(display.A).images,named.get(display.B).images,requiredFrames(pair.case_id));
    const allowed=Object.fromEntries(['A','B'].map(side=>[side,new Set(selected(display[side]).images.map(im=>im.index))]));
    let rows=fresh.map(row=>{
      const old=previous.find(r=>r.id===row.id);
      return old?.manual&&['A','B'].every(side=>old[side]===null||allowed[side].has(old[side]))?{...row,A:old.A,B:old.B,manual:true}:row;
    });
    if(['A','B'].some(side=>{
      const used=rows.filter(r=>r[side]!==null).map(r=>r[side]);return used.length!==allowed[side].size||new Set(used).size!==used.length;
    }))rows=fresh;
    if(JSON.stringify(rows)===saved.body)return saved;
    const retained=old=>{const row=rows.find(r=>r.id===old.id);return row&&row.A===old.A&&row.B===old.B;};
    const invalid=votes(reviewer,pair.id).filter(v=>!previous.some(r=>r.id===v.slot_id&&retained(r)));
    const at=new Date().toISOString();db.exec('BEGIN IMMEDIATE');try{
      for(const v of invalid)db.prepare('DELETE FROM pair_screen_votes WHERE reviewer_id=? AND pair_id=? AND slot_id=?').run(reviewer,pair.id,v.slot_id);
      db.prepare('UPDATE pair_screen_plans SET body=?,revision=revision+1,updated_at=? WHERE reviewer_id=? AND pair_id=?').run(JSON.stringify(rows),at,reviewer,pair.id);
      db.prepare('INSERT INTO events(kind,reviewer_id,pair_id,body,created_at) VALUES (?,?,?,?,?)').run('pair-screen-selection-corrected',reviewer,pair.id,
        JSON.stringify({selection_policy:SCREEN_SELECTION_POLICY,previous,rows,archived_screen_votes:invalid,overall_votes_changed:false}),at);
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    return{...saved,body:JSON.stringify(rows),revision:saved.revision+1,updated_at:at};
  }
  function plan(reviewer,pair){
    let saved=db.prepare('SELECT * FROM pair_screen_plans WHERE reviewer_id=? AND pair_id=?').get(reviewer,pair.id);
    if(!saved){
      const display=sides(pair,reviewer),rows=alignScreens(named.get(display.A).images,named.get(display.B).images,catalog.required_frames[pair.case_id]||[]);
      db.prepare('INSERT INTO pair_screen_plans VALUES (?,?,?,?,?)').run(reviewer,pair.id,JSON.stringify(rows),0,new Date().toISOString());
      saved=db.prepare('SELECT * FROM pair_screen_plans WHERE reviewer_id=? AND pair_id=?').get(reviewer,pair.id);
    }
    saved=reconcile(reviewer,pair,saved);
    const rows=JSON.parse(saved.body),display=sides(pair,reviewer);
    return{rows,revision:saved.revision,display,hash:hash([SCREEN_SELECTION_POLICY,snapshotHash,catalog.content_hash,reviewer,pair.id,saved.revision,rows])};
  }
  function evidence(p,row){return hash(['A','B'].map(side=>row[side]===null?null:[p.display[side],row[side],candidates.get(p.display[side]).images[row[side]].sha256]));}
  function state(reviewer,pair){
    const p=plan(reviewer,pair),saved=votes(reviewer,pair.id),tally={A:0,B:0,tie:0,unable:0,total:p.rows.length,voted:saved.length};
    for(const v of saved)tally[v.choice]++;
    tally.complete=tally.voted===tally.total;
    const images=Object.fromEntries(['A','B'].map(side=>[side,selected(p.display[side]).images.map(im=>({index:im.index,name:blind(im.name)}))]));
    const excluded=Object.fromEntries(['A','B'].map(side=>[side,selected(p.display[side]).excluded.map(im=>({index:im.index,name:blind(im.name),reason:im.reason}))]));
    return{kind:SCREEN_COMPARISON_KIND,selection_policy:SCREEN_SELECTION_POLICY,excluded,plan_hash:p.hash,votes_hash:hash(saved),revision:p.revision,
      rows:p.rows.map(row=>({...row,vote:saved.find(v=>v.slot_id===row.id)?(({choice,comment,revision})=>({choice,comment,revision}))(saved.find(v=>v.slot_id===row.id)):null})),
      images,tally};
  }
  function opened(reviewer,pairId,side,index){
    const pair=currentPair(reviewer);if(pair?.id!==pairId)return;
    const id=sides(pair,reviewer)[side],image=candidates.get(id).images[index];
    if(image)db.prepare('INSERT OR IGNORE INTO pair_screen_image_views VALUES (?,?,?,?,?,?)').run(reviewer,pairId,id,index,image.sha256,new Date().toISOString());
  }
  function save(reviewer,body){
    check(reviewer,body?.pair_id);const pair=currentPair(reviewer),p=plan(reviewer,pair),row=p.rows.find(r=>r.id===body.slot_id);
    if(body.plan_hash!==p.hash)fail(409,'画板对应关系已更新，请刷新后继续');
    if(!row||!['A','B','tie','unable'].includes(body.choice))fail(400,'无效逐屏选择');
    const comment=String(body.comment||'').trim();if(comment.length>1000)fail(400,'逐屏备注最多1000字');
    if(body.choice==='unable'&&!comment)fail(400,'请说明无法对应或判断这一屏的原因');
    if(body.choice!=='unable'){
      if(['A','B'].includes(body.choice)&&row[body.choice]===null||body.choice==='tie'&&(row.A===null||row.B===null))fail(400,'所选侧没有对应画板，请先核对画板或记录无法判断');
      for(const side of ['A','B'])if(row[side]!==null){
        const im=candidates.get(p.display[side]).images[row[side]];
        if(body.viewed!==true||!db.prepare('SELECT 1 FROM pair_screen_image_views WHERE reviewer_id=? AND pair_id=? AND candidate_id=? AND image_index=? AND image_sha256=?')
          .get(reviewer,pair.id,p.display[side],row[side],im.sha256))fail(400,'请先加载并查看这一屏的原图');
      }
    }
    const prior=votes(reviewer,pair.id).find(v=>v.slot_id===row.id),proof=evidence(p,row);
    if(prior&&prior.choice===body.choice&&prior.comment===comment&&prior.evidence_hash===proof)return{duplicate:true,...state(reviewer,pair)};
    if(!Number.isInteger(body.revision)||body.revision!==(prior?.revision||0))fail(409,'这一屏已在另一窗口修改，请刷新');
    const at=new Date().toISOString();db.exec('BEGIN IMMEDIATE');try{
      db.prepare(`INSERT INTO pair_screen_votes VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(reviewer_id,pair_id,slot_id)
        DO UPDATE SET choice=excluded.choice,comment=excluded.comment,revision=excluded.revision,evidence_hash=excluded.evidence_hash,updated_at=excluded.updated_at`)
        .run(reviewer,pair.id,row.id,body.choice,comment,(prior?.revision||0)+1,proof,at);
      db.prepare('INSERT INTO events(kind,reviewer_id,pair_id,body,created_at) VALUES (?,?,?,?,?)').run('pair-screen-vote',reviewer,pair.id,
        JSON.stringify({slot:row,choice:body.choice,comment,evidence_hash:proof,previous:prior||null}),at);
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    return{duplicate:false,...state(reviewer,pair)};
  }
  function align(reviewer,body){
    check(reviewer,body?.pair_id);const pair=currentPair(reviewer),p=plan(reviewer,pair),row=p.rows.find(r=>r.id===body.slot_id),side=body.side;
    if(body.plan_hash!==p.hash)fail(409,'画板对应关系已更新，请刷新');
    if(!row||!['A','B'].includes(side)||body.image_index!==null&&(!Number.isInteger(body.image_index)||!selected(p.display[side]).images.some(im=>im.index===body.image_index)))fail(400,'只能选择本题产品屏，组件或附属画板不参与逐屏比较');
    if(row[side]===body.image_index)return state(reviewer,pair);
    const other=p.rows.find(r=>r.id!==row.id&&r[side]===body.image_index&&body.image_index!==null),previous=structuredClone(p.rows);
    if(other){other[side]=row[side];other.manual=true;}
    else if(row[side]!==null)fail(400,'此操作会遗漏画板，请选择另一张画板进行交换');
    row[side]=body.image_index;row.manual=true;
    const changed=[row.id,...(other?[other.id]:[])],at=new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');try{
      const oldVotes=votes(reviewer,pair.id).filter(v=>changed.includes(v.slot_id));
      for(const id of changed)db.prepare('DELETE FROM pair_screen_votes WHERE reviewer_id=? AND pair_id=? AND slot_id=?').run(reviewer,pair.id,id);
      db.prepare('UPDATE pair_screen_plans SET body=?,revision=revision+1,updated_at=? WHERE reviewer_id=? AND pair_id=?').run(JSON.stringify(p.rows),at,reviewer,pair.id);
      db.prepare('INSERT INTO events(kind,reviewer_id,pair_id,body,created_at) VALUES (?,?,?,?,?)').run('pair-screen-alignment',reviewer,pair.id,JSON.stringify({previous,rows:p.rows,invalidated_votes:oldVotes}),at);
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    return state(reviewer,pair);
  }
  function assertComplete(reviewer,pair,body){
    const value=state(reviewer,pair);
    if(!value.tally.complete)fail(400,`还有 ${value.tally.total-value.tally.voted} 屏没有比较，请逐屏完成后再判断整体`);
    if(body.screen_plan_hash!==value.plan_hash||body.screen_votes_hash!==value.votes_hash)fail(409,'逐屏记录已更新，请重新核对整体汇总');
    return value;
  }
  function exported(){return{kind:SCREEN_COMPARISON_KIND,selection_policy:SCREEN_SELECTION_POLICY,catalog_hash:catalog.content_hash,
    plans:db.prepare('SELECT * FROM pair_screen_plans ORDER BY reviewer_id,pair_id').all().map(r=>({...r,rows:JSON.parse(r.body),body:undefined})),
    votes:db.prepare('SELECT * FROM pair_screen_votes ORDER BY reviewer_id,pair_id,slot_id').all(),
    image_views:db.prepare('SELECT * FROM pair_screen_image_views ORDER BY opened_at').all()};}
  for(const saved of db.prepare('SELECT * FROM pair_screen_plans').all()){
    const pair=db.prepare('SELECT * FROM pairs WHERE id=?').get(saved.pair_id);reconcile(saved.reviewer_id,pair,saved);
  }
  const selectionSummary=()=>({policy:SCREEN_SELECTION_POLICY,
    product_screens:catalog.candidates.reduce((n,c)=>n+selected(c.id).images.length,0),
    excluded_boards:catalog.candidates.reduce((n,c)=>n+selected(c.id).excluded.length,0)});
  return{state,save,align,opened,assertComplete,exported,catalog,requiredFrames,selectionSummary};
}
