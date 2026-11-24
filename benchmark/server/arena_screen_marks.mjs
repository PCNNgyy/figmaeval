import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {selectReviewImages} from './arena_screen_selection.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const blind=name=>String(name).replace(/(?:claude\s*)?(?:opus|fable|gemini|gpt|glm|qwen|kimi)(?:[\s._-]*[\d.]+)?(?:\s*(?:flash|astra))?/gi,'匿名稿件');

export function createScreenMarks({db,directory,snapshotHash,candidates,catalog,sides,currentPair,assertActive,assertLoaded}) {
  db.exec(`CREATE TABLE IF NOT EXISTS screen_case_marks (
    reviewer_id TEXT NOT NULL REFERENCES reviewers(id),
    candidate_id TEXT NOT NULL REFERENCES candidates(id), image_index INTEGER NOT NULL,
    label TEXT CHECK(label IN ('good','bad') OR label IS NULL), reason TEXT NOT NULL,
    revision INTEGER NOT NULL, image_sha256 TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(reviewer_id,candidate_id,image_index));`);
  const named=new Map(catalog.candidates.map(c=>[c.id,c]));
  const eligible=new Map(catalog.candidates.map(c=>[c.id,new Map(selectReviewImages(c.images,catalog.required_frames[c.case_id]||[]).images.map(im=>[im.index,im]))]));
  const version=(id,index)=>hash([snapshotHash,id,index,candidates.get(id).images[index].sha256]);
  function publicMark(reviewer,id,index) {
    const row=db.prepare('SELECT * FROM screen_case_marks WHERE reviewer_id=? AND candidate_id=? AND image_index=?').get(reviewer,id,index);
    if(row&&(row.image_sha256!==candidates.get(id).images[index].sha256||row.snapshot_hash!==snapshotHash))fail(409,'案例标记的截图版本与当前稿件不一致，请联系组织者');
    return {image_index:index,label:row?.label||null,reason:row?.reason||'',revision:row?.revision||0,
      evidence_version:version(id,index),updated_at:row?.updated_at||null};
  }
  function forPair(reviewer,pair) {
    return Object.fromEntries(Object.entries(sides(pair,reviewer)).map(([side,id])=>[side,
      [...eligible.get(id).keys()].map(index=>publicMark(reviewer,id,index))]));
  }
  function save(reviewer,body) {
    assertActive(reviewer);
    const pair=currentPair(reviewer);
    if(!pair||pair.id!==body?.pair_id)fail(409,'当前比较已变化，请刷新后再标记');
    if(!['A','B'].includes(body.side)||!Number.isSafeInteger(body.image_index)||body.image_index<0)fail(400,'请选择具体的产品屏幕');
    const id=sides(pair,reviewer)[body.side],index=body.image_index,image=candidates.get(id)?.images[index];
    if(!image||!eligible.get(id)?.has(index))fail(400,'只能标记当前方案中的产品屏幕');
    if(body.evidence_version!==version(id,index))fail(409,'截图版本已变化，请刷新后再标记');
    if(body.label!==null&&!['good','bad'].includes(body.label))fail(400,'请选择 good case 或 bad case');
    if(typeof body.reason!=='string')fail(400,'请填写案例理由');
    const reason=body.label===null?'':body.reason.trim();
    if(body.label!==null&&!reason)fail(400,'请填写这张屏幕的标记理由');
    if(reason.length>2000)fail(400,'案例理由最多2000字');
    if(!Number.isSafeInteger(body.revision)||body.revision<0)fail(400,'缺少标记版本，请刷新');
    assertLoaded(reviewer,pair,id,index,body);
    const at=new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const prior=db.prepare('SELECT * FROM screen_case_marks WHERE reviewer_id=? AND candidate_id=? AND image_index=?').get(reviewer,id,index);
      if(prior&&(prior.image_sha256!==image.sha256||prior.snapshot_hash!==snapshotHash))fail(409,'案例标记的截图版本已变化');
      if(prior&&prior.label===body.label&&prior.reason===reason) { db.exec('COMMIT');return {duplicate:true,mark:publicMark(reviewer,id,index)}; }
      if(body.revision!==(prior?.revision||0))fail(409,'这张屏幕的标记已在另一窗口修改，请刷新');
      const revision=(prior?.revision||0)+1;
      db.prepare(`INSERT INTO screen_case_marks VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(reviewer_id,candidate_id,image_index) DO UPDATE SET
        label=excluded.label,reason=excluded.reason,revision=excluded.revision,updated_at=excluded.updated_at`)
        .run(reviewer,id,index,body.label,reason,revision,image.sha256,snapshotHash,prior?.created_at||at,at);
      db.prepare('INSERT INTO events(kind,reviewer_id,pair_id,body,created_at) VALUES (?,?,?,?,?)')
        .run('screen-case-mark',reviewer,pair.id,JSON.stringify({scope:'screen',candidate_id:id,image_index:index,
          node_id:image.node_id,image_sha256:image.sha256,snapshot_hash:snapshotHash,label:body.label,reason,revision,previous:prior||null}),at);
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK');throw error; }
    return {duplicate:false,mark:publicMark(reviewer,id,index)};
  }
  function exported() {
    return db.prepare(`SELECT m.*,r.label AS reviewer FROM screen_case_marks m
      JOIN reviewers r ON r.id=m.reviewer_id WHERE m.label IS NOT NULL ORDER BY m.updated_at DESC,m.reviewer_id,m.candidate_id,m.image_index`).all().map(row=>{
      const c=candidates.get(row.candidate_id),im=c.images[row.image_index],meta=named.get(c.id).images[row.image_index];
      if(im.sha256!==row.image_sha256||row.snapshot_hash!==snapshotHash)fail(409,'案例库包含不匹配的截图版本');
      const url=new URL(c.workspace_url);url.searchParams.set('node-id',im.node_id.replace(':','-'));
      return {...row,case_id:c.case_id,title:c.title,model_id:c.model_id,model_name:c.model_name,run_id:c.run_id,
        screen_name:blind(meta.name),node_id:im.node_id,width:im.width,height:im.height,figma_url:url.href,
        image_url:`/api/admin/screen-marks/image/${c.id}/${row.image_index}`};
    });
  }
  function image(id,index) {
    const im=candidates.get(id)?.images[index];
    if(!im||!eligible.get(id)?.has(index)||!db.prepare('SELECT 1 FROM screen_case_marks WHERE candidate_id=? AND image_index=? AND label IS NOT NULL AND image_sha256=? AND snapshot_hash=?').get(id,index,im.sha256,snapshotHash))fail(404,'没有对应的已标记截图');
    const file=path.resolve(directory,im.file);
    if(!file.startsWith(path.resolve(directory)+path.sep)||fs.realpathSync(file)!==file||createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==im.sha256)fail(409,'截图证据已变化');
    return file;
  }
  return {forPair,save,exported,image};
}

export function screenMarksCsv(records) {
  const columns=['label','reason','title','case_id','screen_name','model_name','reviewer','candidate_id','run_id','image_index','node_id','image_sha256','snapshot_hash','figma_url','revision','created_at','updated_at'];
  const cell=value=>{
    let text=String(value??'');
    if(/^[\s]*[=+\-@]/.test(text))text="'"+text;
    return '"'+text.replaceAll('"','""')+'"';
  };
  return '\uFEFF'+[columns,...records.map(r=>columns.map(k=>r[k]))].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
