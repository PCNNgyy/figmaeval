import fs from 'node:fs';
import { getScaleMethod } from '../server/fixed_scales/index.mjs';
import { normalizeFixed20Config, parseFixed20Result, fixed20Total } from '../server/fixed20_scale.mjs';
import { parseClaudeJson } from '../server/claude_result.mjs';

function validateRubricObject(parsed, gatePolicy, def) {
  if (gatePolicy === 'required' && typeof parsed?.g0?.pass !== 'boolean') throw Error('Missing explicit boolean G0');
  if (!Array.isArray(parsed?.scores) || parsed.scores.length !== def.questions.length) throw Error('Expected all 22 rubric items');
  const entries = new Map();
  for (const row of parsed.scores) {
    const key = String(row.key || '').trim().toUpperCase();
    if (entries.has(key)) throw Error('Duplicate rubric item: ' + key);
    entries.set(key, row);
  }
  for (const question of def.questions) {
    const row = entries.get(question.key);
    if (!row || !Number.isInteger(row.score) || row.score < 0 || row.score > (question.max ?? 2)) {
      throw Error('Invalid rubric score: ' + question.key);
    }
    if (typeof row.evidence !== 'string' || !row.evidence.trim()) throw Error('Missing evidence: ' + question.key);
  }
  const result = parseFixed20Result(parsed, def.questions);
  if (result.parse_error) throw Error(result.parse_error);
  if (gatePolicy === 'disabled') return { method: 'fixed_v4', max_score: def.max, gate_policy: 'disabled',
    g0_pass: null, g0_reason: '', values: result.values, evidence: result.evidence,
    score_total: fixed20Total(result.values, true, def.questions) };
  return { method: 'fixed_v4', max_score: def.max, g0_pass: result.g0_pass, g0_reason: result.g0_reason,
    values: result.values, evidence: result.evidence, score_total: fixed20Total(result.values, result.g0_pass, def.questions) };
}

function completeJsonObjects(text) {
  const objects=[];let start=-1,depth=0,quoted=false,escaped=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(start<0){if(c==='{'){start=i;depth=1;quoted=false;escaped=false;}continue;}
    if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"'){quoted=true;continue;}
    if(c==='{')depth++;
    if(c==='}'&&--depth===0){
      try{objects.push(JSON.parse(text.slice(start,i+1)));}catch{}
      start=-1;
    }
  }
  return objects;
}

export function parseArenaJudgeResult(text, { gatePolicy = 'required' } = {}) {
  if (!['required', 'disabled'].includes(gatePolicy)) throw Error('Unknown G0 gate policy');
  const def=getScaleMethod('fixed_v4');
  try{return validateRubricObject(parseClaudeJson(text),gatePolicy,def);}
  catch(primary){
    const valid=[];
    for(const object of completeJsonObjects(text)){
      try{valid.push(validateRubricObject(object,gatePolicy,def));}catch{}
    }
    if(valid.length===1)return {...valid[0],parse_recovery:'unique-complete-json-object'};
    if(valid.length>1)throw Error('Ambiguous JSON: multiple complete rubric outputs');
    throw primary;
  }
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  if (process.argv[2] === 'rubric') {
    const def = getScaleMethod('fixed_v4');
    console.log(JSON.stringify({ method: def.key, max: def.max, questions: def.questions,
      prompt_template: normalizeFixed20Config({}, def).prompt_template }));
  } else {
    console.log(JSON.stringify(parseArenaJudgeResult(fs.readFileSync(process.argv[2], 'utf8'))));
  }
}
