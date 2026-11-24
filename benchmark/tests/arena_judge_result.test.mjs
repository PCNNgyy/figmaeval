import test from 'node:test';
import assert from 'node:assert/strict';
import { getScaleMethod } from '../server/fixed_scales/index.mjs';
import { parseArenaJudgeResult } from '../scripts/arena-judge-result.mjs';

const fixture = () => ({ g0: { pass: true, reason: '完整可辨' }, scores: getScaleMethod('fixed_v4').questions.map(q => ({
  key: q.key, score: q.max ?? 2, evidence: '第1屏与图层摘要中的可定位证据',
})) });
test('complete v4 scores use the existing 53-point total and G0 gate', () => {
  const data = fixture();
  assert.equal(parseArenaJudgeResult(JSON.stringify(data)).score_total, 53);
  data.g0.pass = false;
  assert.equal(parseArenaJudgeResult(JSON.stringify(data)).score_total, 0);
});
test('missing items, duplicate items and invalid values never become completed zero scores', () => {
  const short = fixture(); short.scores.pop();
  assert.throws(() => parseArenaJudgeResult(JSON.stringify(short)), /22/);
  const duplicate = fixture(); duplicate.scores[1] = duplicate.scores[0];
  assert.throws(() => parseArenaJudgeResult(JSON.stringify(duplicate)), /Duplicate/);
  const invalid = fixture(); invalid.scores[0].score = 99;
  assert.throws(() => parseArenaJudgeResult(JSON.stringify(invalid)), /Invalid/);
  const noGate = fixture(); delete noGate.g0;
  assert.throws(() => parseArenaJudgeResult(JSON.stringify(noGate)), /G0/);
  const noEvidence = fixture(); noEvidence.scores[0].evidence = '';
  assert.throws(() => parseArenaJudgeResult(JSON.stringify(noEvidence)), /evidence/);
});

test('disabled gate totals all items without requiring or applying a gate verdict', () => {
  const data = fixture();
  delete data.g0;
  const result = parseArenaJudgeResult(JSON.stringify(data), { gatePolicy: 'disabled' });
  assert.equal(result.score_total, 53);
  assert.equal(result.g0_pass, null);
  assert.equal(result.gate_policy, 'disabled');
  data.g0 = { pass: false, reason: 'unexpected legacy verdict' };
  assert.equal(parseArenaJudgeResult(JSON.stringify(data), { gatePolicy: 'disabled' }).score_total, 53);
  data.scores.forEach(row => { row.score = 0; });
  assert.equal(parseArenaJudgeResult(JSON.stringify(data), { gatePolicy: 'disabled' }).score_total, 0);
  data.scores.pop();
  assert.throws(() => parseArenaJudgeResult(JSON.stringify(data), { gatePolicy: 'disabled' }), /22/);
  assert.throws(() => parseArenaJudgeResult(JSON.stringify(fixture()), { gatePolicy: 'typo' }), /policy/);
});

test('a partial draft followed by one complete rubric recovers without changing scores', () => {
  const final=fixture();delete final.g0;
  final.scores[0].evidence='第1屏包含 "quoted" 和 {braces}，仍是完整JSON字符串';
  const text=JSON.stringify({scores:[{key:'draft',score:0,evidence:'unfinished'}]})+'\nCorrection:\n'+JSON.stringify(final);
  const result=parseArenaJudgeResult(text,{gatePolicy:'disabled'});
  assert.equal(result.score_total,53);
  assert.equal(result.parse_recovery,'unique-complete-json-object');
  assert.equal(result.evidence.A1,final.scores[0].evidence);
});

test('two complete rubrics are ambiguous and empty output is a format error', () => {
  const one=fixture(),two=fixture();two.scores[0].score=0;
  assert.throws(()=>parseArenaJudgeResult(JSON.stringify(one)+'\n'+JSON.stringify(two)),/Ambiguous JSON/);
  assert.throws(()=>parseArenaJudgeResult('',{gatePolicy:'disabled'}),/22/);
});
