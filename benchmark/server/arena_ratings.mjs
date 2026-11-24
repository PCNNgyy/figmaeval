import { createHash } from 'node:crypto';

export const RATING = Object.freeze({ mu: 25, sigma: 25 / 3, beta: 25 / 6, tau: 0, draw_probability: 0 });
const pdf = (x) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
function erfc(x) {
  const z = Math.abs(x), t = 1 / (1 + z / 2);
  const p = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (.37409196 + t * (.09678418
    + t * (-.18628806 + t * (.27886807 + t * (-1.13520398 + t * (1.48851587
      + t * (-.82215223 + t * .17087277)))))))));
  return x >= 0 ? p : 2 - p;
}
export function rateWin(winner, loser) {
  const c2 = winner.sigma ** 2 + loser.sigma ** 2 + 2 * RATING.beta ** 2;
  const c = Math.sqrt(c2), t = (winner.mu - loser.mu) / c;
  const a = -t;
  const v = t < -10 ? a + 1 / a - 2 / a ** 3 + 10 / a ** 5 - 74 / a ** 7
    : pdf(t) / (.5 * erfc(-t / Math.SQRT2));
  const w = Math.min(1 - 1e-12, Math.max(0, v * (v + t)));
  return [
    { mu: winner.mu + winner.sigma ** 2 / c * v,
      sigma: Math.sqrt(Math.max(1e-12, winner.sigma ** 2 * (1 - winner.sigma ** 2 / c2 * w))) },
    { mu: loser.mu - loser.sigma ** 2 / c * v,
      sigma: Math.sqrt(Math.max(1e-12, loser.sigma ** 2 * (1 - loser.sigma ** 2 / c2 * w))) },
  ];
}
const order = (vote) => createHash('sha256').update(`${vote.pair_id}:${vote.reviewer_id}`).digest('hex');

export function arenaRankings(candidates, pairs, votes) {
  const models = new Map(), byId = new Map(candidates.map((c) => [c.id, c]));
  const pairById = new Map(pairs.map((p) => [p.id, p]));
  for (const c of candidates) {
    if (!models.has(c.model_id)) models.set(c.model_id, { model_id: c.model_id, model_name: c.model_name,
      candidate_count: 0, wins: 0, losses: 0, skipped: 0, cases: new Set(), opponents: new Set(), rating: { ...RATING } });
    models.get(c.model_id).candidate_count++;
  }
  const caseRatings = new Map(), matrix = new Map();
  for (const vote of [...votes].sort((a, b) => order(a).localeCompare(order(b)))) {
    const pair = pairById.get(vote.pair_id);
    if (!pair) throw new Error('Vote references an unknown pair');
    const ca = byId.get(pair.first_id), cb = byId.get(pair.second_id);
    if (!vote.winner_id) { models.get(ca.model_id).skipped++; models.get(cb.model_id).skipped++; continue; }
    if (![ca.id, cb.id].includes(vote.winner_id)) throw new Error('Winner does not belong to this pair');
    const winner = byId.get(vote.winner_id), loser = winner.id === ca.id ? cb : ca;
    const wm = models.get(winner.model_id), lm = models.get(loser.model_id);
    [wm.rating, lm.rating] = rateWin(wm.rating, lm.rating);
    wm.wins++; lm.losses++;
    for (const [model, opponent] of [[wm, lm], [lm, wm]]) {
      model.cases.add(pair.case_id); model.opponents.add(opponent.model_id);
    }
    const wk = `${pair.case_id}:${winner.model_id}`, lk = `${pair.case_id}:${loser.model_id}`;
    const [wr, lr] = rateWin(caseRatings.get(wk) || RATING, caseRatings.get(lk) || RATING);
    caseRatings.set(wk, wr); caseRatings.set(lk, lr);
    const mk = `${winner.model_id}:${loser.model_id}`;
    matrix.set(mk, (matrix.get(mk) || 0) + 1);
  }
  const rows = [...models.values()].map((m) => {
    const ratings = [...m.cases].map((cid) => caseRatings.get(`${cid}:${m.model_id}`));
    const played = m.wins + m.losses;
    return { model_id: m.model_id, model_name: m.model_name, candidates: m.candidate_count,
      wins: m.wins, losses: m.losses, votes: played, skipped: m.skipped,
      win_rate: played ? m.wins / played : null, evaluated_cases: m.cases.size, opponents: m.opponents.size,
      score: played ? m.rating.mu : null, sigma: played ? m.rating.sigma : null,
      lower: played ? m.rating.mu - 2 * m.rating.sigma : null,
      upper: played ? m.rating.mu + 2 * m.rating.sigma : null,
      case_mean: ratings.length ? ratings.reduce((s, r) => s + r.mu, 0) / ratings.length : null };
  }).sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.model_name.localeCompare(b.model_name));
  const seen = new Set();
  const start = rows.find((r) => r.votes)?.model_id;
  const visit = (id) => { if (seen.has(id)) return; seen.add(id); for (const next of models.get(id).opponents) visit(next); };
  if (start) visit(start);
  let compared = 0, agreed = 0;
  for (const pair of pairs) {
    const scored = votes.filter((v) => v.pair_id === pair.id && v.winner_id);
    if (scored.length >= 2) { compared++; if (scored.every((v) => v.winner_id === scored[0].winner_id)) agreed++; }
  }
  return { rows, matrix: Object.fromEntries(matrix), agreement: { compared, agreed, rate: compared ? agreed / compared : null },
    connected: Boolean(start && seen.size === models.size), parameters: RATING,
    method: 'pooled-within-case-trueskill-v1',
    explanation: '同题内两两盲评，所有有效票汇总更新模型 TrueSkill；排名分为 μ，区间为 μ±2σ。样本覆盖不齐时为暂定排名。逐题均分仅统计已获有效票的题目，不能当作完整30题均分。没有投票的模型不展示先验分数。',
    reference: 'https://arxiv.org/html/2508.20410v3' };
}
