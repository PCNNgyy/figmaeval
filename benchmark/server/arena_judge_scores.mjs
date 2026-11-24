import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getScaleMethod } from './fixed_scales/index.mjs';

const cache = new Map();
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stamp = file => { try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; } catch { return 'missing'; } };

export function repeatedCandidateVersion(candidate) {
  return sha(JSON.stringify([candidate.id, candidate.run_id, candidate.workspace_id, candidate.images.map(im => im.sha256)]));
}

function readRepeatedScores(arenaDirectory, campaignDirectory, campaign) {
  if(campaign.method!=='fixed_v4'||campaign.max_score!==53||campaign.repeats!==3
    ||!Array.isArray(campaign.judges)||campaign.judges.length!==3
    ||new Set(campaign.judges.map(j=>j.id)).size!==3
    ||campaign.judges.some(j=>typeof j.id!=='string'||!j.id||typeof j.name!=='string'))throw Error('Invalid repeated judge campaign');
  const snapshotFile=path.join(arenaDirectory,'snapshot.json'),dataFile=path.join(campaignDirectory,'repeated-scores.json');
  const version=[snapshotFile,path.join(campaignDirectory,'campaign.json'),dataFile].map(stamp).join('|');
  const cacheKey='repeated:'+path.resolve(arenaDirectory)+':'+path.resolve(campaignDirectory);
  if(cache.get(cacheKey)?.version===version)return cache.get(cacheKey).data;
  const bytes=fs.readFileSync(snapshotFile),raw=fs.readFileSync(dataFile);
  if(sha(bytes)!==campaign.source_snapshot_sha256||sha(raw)!==campaign.data_sha256)throw Error('Repeated judge snapshot or data changed');
  const snapshot=JSON.parse(bytes),bound=JSON.parse(raw),candidates=new Map(snapshot.candidates.map(c=>[c.id,c]));
  if(candidates.size!==campaign.candidates||!Array.isArray(bound.rows)||bound.rows.length!==candidates.size
    ||new Set(bound.rows.map(r=>r.candidate_id)).size!==candidates.size)throw Error('Repeated judge cohort incomplete or duplicated');
  const records=new Map(bound.rows.map(r=>[r.candidate_id,r])),models=new Map();
  if([...records.keys()].some(id=>!candidates.has(id)))throw Error('Unknown repeated judge candidate');
  for(const c of candidates.values()){
    if(!models.has(c.model_id))models.set(c.model_id,{name:c.model_name,candidates:[]});
    models.get(c.model_id).candidates.push(c);
  }
  const scored=new Map(),judges=[];
  for(const judge of campaign.judges){
    const scores=new Map();let invalid=0;
    for(const c of candidates.values()){
      const r=records.get(c.id),sample=r.judges?.[judge.id];
      if(sample==null)continue;
      if(r.case_id!==c.case_id||r.model_id!==c.model_id||r.run_id!==c.run_id||r.version_sha256!==repeatedCandidateVersion(c)
        ||!Array.isArray(sample.repetitions)||sample.repetitions.length!==3
        ||sample.repetitions.some(v=>!Number.isInteger(v)||v<0||v>53)
        ||!['required','disabled'].includes(sample.gate_policy)){invalid++;continue;}
      scores.set(c.id,sample.repetitions.reduce((a,b)=>a+b,0)/3);
    }
    scored.set(judge.id,scores);
    judges.push({id:judge.id,name:judge.name,scored_count:scores.size,total_count:candidates.size,invalid_count:invalid,
      updated_at:campaign.updated_at,complete:scores.size===candidates.size&&!invalid,rows:ranked(models,scores)});
  }
  const data={method:'fixed_v4',max_score:53,repeats:3,source_kind:campaign.kind,score_source_updated_at:campaign.updated_at,
    targeted_no_gate_reassessment:true,ranking_method:'same-task-pairwise-win-rate/v1',
    win_rate_rule:'Each judge uses its own unrounded three-repeat mean; wins=1, ties=0.5, losses=0; missing and unmatched revisions excluded.',
    cases:new Set(snapshot.candidates.map(c=>c.case_id)).size,candidates:candidates.size,judges,
    rows:snapshot.candidates.map(c=>({candidate_id:c.id,case_id:c.case_id,title:c.title,model_id:c.model_id,model_name:c.model_name,
      run_id:c.run_id,scores:Object.fromEntries([...scored].map(([j,scores])=>[j,scores.get(c.id)??null]))}))};
  cache.set(cacheKey,{version,data});return data;
}

function ranked(models, scores) {
  const counts = new Map([...models].map(([id]) => [id, {wins:0,ties:0,losses:0,compared_count:0,possible_pairs:0,cases:new Set()}]));
  const groups = Map.groupBy([...models.values()].flatMap(m=>m.candidates),c=>c.case_id);
  for(const group of groups.values())for(let i=0;i<group.length;i++)for(let k=i+1;k<group.length;k++){
    const a=group[i],b=group[k],first=counts.get(a.model_id),second=counts.get(b.model_id);
    first.possible_pairs++;second.possible_pairs++;
    const x=scores.get(a.id),y=scores.get(b.id);
    if(x==null||y==null)continue;
    first.compared_count++;second.compared_count++;first.cases.add(a.case_id);second.cases.add(b.case_id);
    if(x===y){first.ties++;second.ties++;}
    else if(x>y){first.wins++;second.losses++;}else{first.losses++;second.wins++;}
  }
  const rows = [...models].map(([id, model]) => {
    const values = model.candidates.map(c => scores.get(c.id)).filter(v => v !== null && v !== undefined);
    return { model_id: id, model_name: model.name, scored_count: values.length, total_count: model.candidates.length,
      mean_score: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null };
  }).sort((a, b) => a.mean_score === null ? b.mean_score === null ? a.model_name.localeCompare(b.model_name) : 1
    : b.mean_score === null ? -1 : b.mean_score - a.mean_score || a.model_name.localeCompare(b.model_name));
  let rank = null;
  const withMeans=rows.map((row, index) => {
    if (row.mean_score !== null && (index === 0 || row.mean_score !== rows[index - 1].mean_score)) rank = index + 1;
    const {cases,...count}=counts.get(row.model_id);
    return { ...row, mean_rank: row.mean_score === null ? null : rank, ...count, compared_cases:cases.size,
      win_rate:count.compared_count?(count.wins+.5*count.ties)/count.compared_count:null };
  });
  const difference=(a,b)=>(b.wins*2+b.ties)*a.compared_count-(a.wins*2+a.ties)*b.compared_count;
  withMeans.sort((a,b)=>!a.compared_count?!b.compared_count?a.model_name.localeCompare(b.model_name):1
    :!b.compared_count?-1:difference(a,b)||a.model_name.localeCompare(b.model_name));
  rank=null;
  return withMeans.map((row,index)=>{
    if(row.compared_count&&(index===0||!withMeans[index-1].compared_count||difference(row,withMeans[index-1])!==0))rank=index+1;
    return {...row,rank:row.compared_count?rank:null};
  });
}

export function readArenaJudgeScores(arenaDirectory, campaignDirectory) {
  const snapshotFile = path.join(arenaDirectory, 'snapshot.json');
  const campaignFile = path.join(campaignDirectory, 'campaign.json');
  const inputsFile = path.join(campaignDirectory, 'inputs.json');
  const campaign = read(campaignFile);
  if(campaign.kind==='arena-repeated-multijudge/v1')return readRepeatedScores(arenaDirectory,campaignDirectory,campaign);
  if (campaign.kind !== 'arena-frozen-multijudge/v1' || campaign.method !== 'fixed_v4' || campaign.max_score !== 53
      || !Array.isArray(campaign.judges) || campaign.judges.some(j => typeof j.id !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(j.id) || typeof j.name !== 'string' || typeof j.model !== 'string')
      || new Set(campaign.judges.map(j => j.id)).size !== campaign.judges.length
      || campaign.judges.some(j => j.id === 'opus55')) throw Error('Invalid multi-judge campaign');
  const key = path.resolve(arenaDirectory) + ':' + path.resolve(campaignDirectory);
  const version = [snapshotFile, campaignFile, inputsFile,
    ...campaign.judges.flatMap(j => [path.join(campaignDirectory, j.id, 'progress.json'), path.join(campaignDirectory, j.id, 'results')])]
    .map(stamp).join('|');
  if (cache.get(key)?.version === version) return cache.get(key).data;
  const snapshotBytes = fs.readFileSync(snapshotFile);
  if (sha(snapshotBytes) !== campaign.source_snapshot_sha256) throw Error('Judge campaign belongs to another frozen snapshot');
  const snapshot = JSON.parse(snapshotBytes);
  const candidates = new Map(snapshot.candidates.map(c => [c.id, c]));
  const inputs = read(inputsFile);
  if (candidates.size !== campaign.candidates || inputs.length !== candidates.size
      || new Set(inputs.map(i => i.candidate_id)).size !== inputs.length) throw Error('Judge cohort is incomplete or duplicated');
  const proofs = new Map();
  for (const input of inputs) {
    const c = candidates.get(input.candidate_id);
    if (!c || input.run_id !== c.run_id || input.case_id !== c.case_id || input.design_model_id !== c.model_id
        || input.opus_score_id !== c.cc_score_id || input.opus_score !== c.cc_score
        || input.image_count !== c.images.length || !/^[a-f0-9]{64}$/.test(input.prompt_sha256)) throw Error('Input proof does not match frozen candidate');
    proofs.set(c.id, input);
  }
  const models = new Map();
  for (const c of candidates.values()) {
    if (!models.has(c.model_id)) models.set(c.model_id, { name: c.model_name, candidates: [] });
    models.get(c.model_id).candidates.push(c);
  }
  const opus = new Map([...candidates.values()].map(c => [c.id, Number.isInteger(c.cc_score) && c.cc_score >= 0 && c.cc_score <= 53 ? c.cc_score : null]));
  const scored = new Map([['opus55', opus]]);
  const judges = [{ id: 'opus55', name: 'Opus 5.5', scored_count: [...opus.values()].filter(v => v !== null).length,
    total_count: candidates.size, invalid_count: 0, updated_at: snapshot.source_at || null, rows: ranked(models, opus) }];
  const questions = getScaleMethod('fixed_v4').questions;
  for (const judge of campaign.judges) {
    const scores = new Map();
    let invalid = 0, updated = null;
    for (const c of candidates.values()) {
      const file = path.join(campaignDirectory, judge.id, 'results', c.id + '.json');
      if (!fs.existsSync(file)) continue;
      try {
        const result = read(file), proof = proofs.get(c.id);
        if (result.candidate_id !== c.id || result.run_id !== c.run_id || result.case_id !== c.case_id
            || result.design_model_id !== c.model_id || result.judge_id !== judge.id || result.judge_model !== judge.model
            || result.prompt_sha256 !== proof.prompt_sha256 || result.image_count !== proof.image_count
            || result.method !== 'fixed_v4' || result.max_score !== 53 || typeof result.g0_pass !== 'boolean'
            || !result.values || Object.keys(result.values).length !== questions.length
            || questions.some(q => !Number.isInteger(result.values[q.key]) || result.values[q.key] < 0 || result.values[q.key] > (q.max ?? 2))
            || result.score_total !== (result.g0_pass ? questions.reduce((sum, q) => sum + result.values[q.key], 0) : 0)) {
          throw Error('Score identity or rubric mismatch');
        }
        scores.set(c.id, result.score_total);
        if (!updated || result.completed_utc > updated) updated = result.completed_utc;
      } catch { invalid++; }
    }
    scored.set(judge.id, scores);
    judges.push({ id: judge.id, name: judge.name, scored_count: scores.size, total_count: candidates.size,
      invalid_count: invalid, updated_at: updated, rows: ranked(models, scores) });
  }
  const data = { method: 'fixed_v4', max_score: 53, cases: new Set(snapshot.candidates.map(c => c.case_id)).size,
    ranking_method:'same-task-pairwise-win-rate/v1',
    win_rate_rule:'(wins + 0.5 * ties) / compared_count; compare only different models within the same frozen task; missing scores are excluded',
    candidates: candidates.size, judges: judges.map(j => ({ ...j, complete: j.scored_count === j.total_count && !j.invalid_count })),
    rows: snapshot.candidates.map(c => ({ candidate_id: c.id, case_id: c.case_id, title: c.title,
      model_id: c.model_id, model_name: c.model_name, run_id: c.run_id,
      scores: Object.fromEntries([...scored].map(([judge, scores]) => [judge, scores.get(c.id) ?? null])) })) };
  cache.set(key, { version, data });
  return data;
}

export function judgeScoreCsvRows(data) {
  return data.rows.map(row => ({ case_id: row.case_id, title: row.title, model_id: row.model_id,
    model_name: row.model_name, run_id: row.run_id, ...row.scores }));
}

export function judgePairCsvRows(data){
  const rows=[];
  for(const group of Map.groupBy(data.rows,r=>r.case_id).values()){
    group.sort((a,b)=>a.model_id.localeCompare(b.model_id));
    for(let i=0;i<group.length;i++)for(let k=i+1;k<group.length;k++){
      const a=group[i],b=group[k],row={case_id:a.case_id,first_model:a.model_name,second_model:b.model_name,
        first_candidate:a.candidate_id,second_candidate:b.candidate_id,first_run_id:a.run_id,second_run_id:b.run_id};
      for(const j of data.judges){const x=a.scores[j.id],y=b.scores[j.id];
        row[j.id+'_first_score']=x;row[j.id+'_second_score']=y;
        row[j.id+'_outcome']=x==null||y==null?null:x===y?'tie':x>y?'first':'second';
      }
      rows.push(row);
    }
  }
  return rows;
}
