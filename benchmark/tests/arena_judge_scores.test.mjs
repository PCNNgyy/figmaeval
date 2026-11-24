import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readArenaJudgeScores, judgeScoreCsvRows, judgePairCsvRows, repeatedCandidateVersion } from '../server/arena_judge_scores.mjs';
import { getScaleMethod } from '../server/fixed_scales/index.mjs';

function fixture(t, scores = [0, 40, 20, 10]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-judge-board-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const arena = path.join(root, 'arena'), campaign = path.join(root, 'campaign');
  const save = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  const candidates = Array.from({ length: scores.length }, (_, i) => ({ id: createHash('sha256').update(String(i)).digest('hex').slice(0, 24),
    case_id: 'case-' + Math.floor(i / 2), title: 'Task ' + Math.floor(i / 2), model_id: 'model-' + i % 2,
    model_name: 'Model ' + i % 2, run_id: 'run-' + i, cc_score_id: 'opus-' + i, cc_score: scores[i], images: [{}] }));
  const snapshot = { source_at: '2026-11-08T00:00:00Z', candidates };
  save(path.join(arena, 'snapshot.json'), snapshot);
  const config = { kind: 'arena-frozen-multijudge/v1', method: 'fixed_v4', max_score: 53, candidates: scores.length,
    source_snapshot_sha256: createHash('sha256').update(fs.readFileSync(path.join(arena, 'snapshot.json'))).digest('hex'),
    credentials_file: '/private/DO_NOT_EXPOSE_KEY', judges: [{ id: 'new-judge', name: 'New Judge', model: 'api-model' }] };
  save(path.join(campaign, 'campaign.json'), config);
  const inputs = candidates.map(c => ({ candidate_id: c.id, run_id: c.run_id, case_id: c.case_id, design_model_id: c.model_id,
    opus_score_id: c.cc_score_id, opus_score: c.cc_score, image_count: 1, prompt_sha256: 'a'.repeat(64), prompt_file: '/private/PROMPT' }));
  save(path.join(campaign, 'inputs.json'), inputs);
  const result = (i, total, extra = {}) => {
    const values = {};
    let remaining = total;
    for (const q of getScaleMethod('fixed_v4').questions) { values[q.key] = Math.min(remaining, q.max ?? 2); remaining -= values[q.key]; }
    const c = candidates[i];
    save(path.join(campaign, 'new-judge/results', c.id + '.json'), { candidate_id: c.id, case_id: c.case_id, run_id: c.run_id,
      design_model_id: c.model_id, judge_id: 'new-judge', judge_model: 'api-model', prompt_sha256: 'a'.repeat(64),
      image_count: 1, method: 'fixed_v4', max_score: 53, g0_pass: true, values, score_total: total,
      completed_utc: '2026-11-09T00:00:00Z', raw_output: 'PRIVATE_RESPONSE', ...extra });
  };
  return { arena, campaign, config, save, result, read: () => readArenaJudgeScores(arena, campaign) };
}

test('judge means include true zero scores, preserve missing scores, and rank each judge independently', t => {
  const f = fixture(t); f.result(0, 53); f.result(1, 0); f.result(2, 53);
  const data = f.read(), [opus, added] = data.judges;
  assert.deepEqual(opus.rows.map(r => [r.model_id, r.rank, r.win_rate]), [['model-0', 1, .5], ['model-1', 1, .5]]);
  assert.equal(opus.rows.find(r => r.model_id === 'model-1').mean_rank, 1);
  assert.equal(opus.rows.find(r => r.model_id === 'model-0').mean_score, 10);
  assert.equal(added.rows[0].model_id, 'model-0'); assert.equal(added.rows[0].mean_score, 53);
  assert.equal(added.rows[1].mean_score, 0); assert.equal(added.rows[1].scored_count, 1);
  assert.equal(added.complete, false); assert.equal(data.rows[3].scores['new-judge'], null);
  assert.equal(added.rows[0].win_rate, 1); assert.equal(added.rows[0].compared_count, 1);
  assert.equal(added.rows[0].possible_pairs, 2); assert.equal(added.rows[1].win_rate, 0);
  assert.equal(judgeScoreCsvRows(data)[1]['new-judge'], 0);
  for (const secret of ['DO_NOT_EXPOSE_KEY', '/private/PROMPT', 'PRIVATE_RESPONSE']) assert.ok(!JSON.stringify(data).includes(secret));
  f.result(3, 20);
  assert.equal(f.read().judges[1].scored_count, 4); assert.equal(f.read().judges[1].complete, true);
});

test('main ranks use within-task wins even when mean ordering differs; zero-score ties count half', t => {
  const f = fixture(t, [53, 20, 10, 11, 10, 11]);
  for(let i=0;i<6;i++)f.result(i, 0);
  const data=f.read(),[opus,added]=data.judges;
  assert.equal(opus.rows[0].model_id,'model-1'); assert.equal(opus.rows[0].win_rate,2/3);
  assert.equal(opus.rows[1].mean_rank,1); assert.ok(opus.rows[1].mean_score>opus.rows[0].mean_score);
  assert.ok(added.rows.every(r=>r.win_rate===.5&&r.rank===1&&r.ties===3&&r.compared_count===3));
  const pairs=judgePairCsvRows(data);
  assert.equal(pairs.length,3); assert.ok(pairs.every(r=>r['new-judge_outcome']==='tie'));
  assert.deepEqual(pairs.map(r=>r.opus55_outcome),['first','second','second']);
});

test('mismatched run and invalid rubric values are excluded rather than attributed to the current cohort', t => {
  const f = fixture(t);
  f.result(0, 53, { run_id: 'different-run' }); f.result(1, 0, { values: { A1: 99 } });
  const data = f.read(); assert.equal(data.judges[1].invalid_count, 2); assert.equal(data.judges[1].scored_count, 0);
  assert.equal(data.rows[0].scores['new-judge'], null);
});

test('a different frozen snapshot and unsafe judge identifiers are rejected', t => {
  const f = fixture(t);
  f.config.source_snapshot_sha256 = 'b'.repeat(64); f.save(path.join(f.campaign, 'campaign.json'), f.config);
  assert.throws(f.read, /snapshot/);
  f.config.judges[0].id = '../private'; f.save(path.join(f.campaign, 'campaign.json'), f.config);
  assert.throws(f.read, /Invalid/);
});

function repeatedFixture(t) {
  const f=fixture(t),snapshot=JSON.parse(fs.readFileSync(path.join(f.arena,'snapshot.json')));
  const judges=['opus55','gpt61sol','deepseek41flash1017'].map(id=>({id,name:id}));
  const values=[[0,1,2],[1,1,1],[2,3,4],[0,0,0]];
  const rows=snapshot.candidates.map((c,i)=>({candidate_id:c.id,case_id:c.case_id,model_id:c.model_id,
    run_id:c.run_id,version_sha256:repeatedCandidateVersion(c),
    judges:Object.fromEntries(judges.map(j=>[j.id,{repetitions:values[i],gate_policy:'disabled'}]))}));
  Object.assign(f.config,{kind:'arena-repeated-multijudge/v1',repeats:3,judges,updated_at:'2026-11-14T20:00:00+08:00'});
  const publish=()=>{
    f.save(path.join(f.campaign,'repeated-scores.json'),{rows});
    f.config.data_sha256=createHash('sha256').update(fs.readFileSync(path.join(f.campaign,'repeated-scores.json'))).digest('hex');
    f.save(path.join(f.campaign,'campaign.json'),f.config);
  };
  publish();return {...f,rows,publish};
}

test('latest repeated scores replace frozen Opus, average all three without rounding, and retain no-gate zeros',t=>{
  const f=repeatedFixture(t),data=f.read();
  assert.equal(data.repeats,3);assert.equal(data.judges.length,3);
  assert.ok(data.judges.every(j=>j.complete&&j.scored_count===4));
  assert.deepEqual(data.rows.map(r=>r.scores.opus55),[1,1,3,0]);
  assert.equal(data.judges[0].rows[0].win_rate,.75);
  assert.equal(judgePairCsvRows(data)[0].opus55_outcome,'tie');
  assert.ok(!JSON.stringify(data).includes('DO_NOT_EXPOSE_KEY'));
});

test('repeated summaries reject changed data and exclude missing or stale candidate versions',t=>{
  const f=repeatedFixture(t);
  f.rows[0].run_id='a-different-output';f.rows[1].judges.gpt61sol=null;f.publish();
  let data=f.read();
  assert.equal(data.rows[0].scores.opus55,null);assert.equal(data.judges[0].invalid_count,1);
  assert.equal(data.rows[1].scores.gpt61sol,null);assert.equal(data.judges[1].scored_count,2);
  f.rows[2].judges.opus55.repetitions=[0,54,0];f.publish();
  data=f.read();assert.equal(data.rows[2].scores.opus55,null);assert.equal(data.judges[0].invalid_count,2);
  fs.appendFileSync(path.join(f.campaign,'repeated-scores.json'),' ');
  assert.throws(f.read,/changed/);
});
