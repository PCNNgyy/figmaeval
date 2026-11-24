import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { verifySeal } from './benchmark_protocol.mjs';
import { resolveCurrentResultsDirectory } from './benchmark_results_pointer.mjs';

export function readCCLeaderboard(directory, { includeCoverage = false } = {}) {
  directory = resolveCurrentResultsDirectory(directory);
  const read = (name) => verifySeal(JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
  const plan = read('plan.json'), rubric = read('rubric.json'), policy = read('partial-scoring-policy.json');
  if (policy.kind !== 'benchmark-verified-subset-scoring/v1' || policy.plan_hash !== plan.content_hash
      || policy.rubric_hash !== rubric.content_hash || plan.rubric_hash !== rubric.content_hash
      || policy.judge_id !== plan.judge.id || policy.judge_id !== 'model_claude_opus55_direct'
      || rubric.method !== 'fixed_v4' || rubric.max !== 53
      || !policy.job_id || !Array.isArray(policy.entries) || !Array.isArray(plan.models) || plan.models.length !== 7) {
    throw new Error('CC leaderboard source does not match the frozen v4 scoring cohort');
  }
  const models = new Map(plan.models.map((m) => [m.id, { name: m.name, sum: 0, count: 0,
    total: plan.assignments.filter(a => a.model_id === m.id).length }]));
  if (models.size !== plan.models.length) throw new Error('Duplicate leaderboard model');
  const runs = new Map(), combinations = new Set();
  for (const entry of policy.entries) {
    const assignment = plan.assignments.find((a) => a.assignment_id === entry.assignment_id);
    const key = `${entry.case_id}:${entry.model_id}`;
    if (!models.has(entry.model_id) || !assignment || assignment.case_id !== entry.case_id
        || assignment.model_id !== entry.model_id || runs.has(entry.run_id) || combinations.has(key)) {
      throw new Error('Duplicate or unassigned leaderboard entry');
    }
    runs.set(entry.run_id, entry); combinations.add(key);
  }
  const file = path.join(directory, 'ui-eval.sqlite3');
  if (!fs.existsSync(file)) throw new Error('CC score database is missing');
  const db = new DatabaseSync(file, { readOnly: true });
  let updatedAt = null;
  const used = new Set();
  try {
    db.exec('PRAGMA busy_timeout=1000');
    const scores = db.prepare(`SELECT id,run_id,test_id,model_id,cc_total,prompt_template,updated_at
      FROM scale_scores WHERE method='fixed_v4' AND job_id=? AND eval_model_id=?
      AND status='已完成' AND is_baseline=1 AND cc_total IS NOT NULL
      AND COALESCE(parse_error,'')='' ORDER BY updated_at DESC,id DESC`).all(policy.job_id, policy.judge_id);
    for (const score of scores) {
      const entry = runs.get(score.run_id);
      if (!entry || entry.model_id !== score.model_id || entry.test_id !== score.test_id
          || score.prompt_template !== rubric.prompt_template || !Number.isInteger(score.cc_total)
          || score.cc_total < 0 || score.cc_total > rubric.max || used.has(score.run_id)) continue;
      used.add(score.run_id);
      const model = models.get(score.model_id);
      model.sum += score.cc_total; model.count++;
      if (!updatedAt || score.updated_at > updatedAt) updatedAt = score.updated_at;
    }
  } finally { db.close(); }
  const sorted = [...models.values()].map((m) => ({ name: m.name, count: m.count, total: m.total, mean: m.count ? m.sum / m.count : null }))
    .sort((a, b) => a.mean === null ? b.mean === null ? a.name.localeCompare(b.name) : 1
      : b.mean === null ? -1 : b.mean - a.mean || a.name.localeCompare(b.name));
  let rank = null;
  return { method: 'fixed_v4', max_score: rubric.max, judge: 'Opus 5.5', updated_at: updatedAt,
    complete: used.size === plan.assignments.length,
    ...(includeCoverage ? { scored_count: used.size, total_count: plan.assignments.length } : {}),
    rows: sorted.map((m, i) => {
      if (m.mean !== null && (i === 0 || m.mean !== sorted[i - 1].mean)) rank = i + 1;
      return { rank: m.mean === null ? null : rank, model_name: m.name, mean_score: m.mean,
        ...(includeCoverage ? { scored_count: m.count, total_count: m.total } : {}) };
    }) };
}
