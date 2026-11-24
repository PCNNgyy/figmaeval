import { createHash, createHmac } from 'node:crypto';
import {tournamentState} from './arena_bracket.mjs';
import {ACTIVE_SAMPLING,drawActiveTournament} from './arena_active_sampling.mjs';
export {tournamentState} from './arena_bracket.mjs';

export const TOURNAMENT_KIND = 'design-arena-tournament/v3';
export const DESIGN_ARENA_REFERENCE = 'https://www.designarena.ai/about';
export const tournamentProtocol = ({ reviewers = 1 } = {}) => ({ kind: TOURNAMENT_KIND, models_per_session: 4, battles_per_session: 5,
  sampling: 'uniform-four-without-replacement', task_schedule: 'shuffled-task-cycles', reviewers,
  choices: ['A', 'B', 'unable'], ranking: 'equal-weight-bradley-terry-mm', convergence: 0.0001,
  max_iterations: 200, chart_min_comparisons: 50, preliminary_below: 200, reference: DESIGN_ARENA_REFERENCE });

export function validateTournamentProtocol(snapshot) {
  if (![1,2].includes(snapshot.protocol?.reviewers)
    || JSON.stringify(snapshot.protocol) !== JSON.stringify(tournamentProtocol({reviewers:snapshot.protocol.reviewers}))) throw Error('Invalid DesignArena tournament protocol');
  for (const group of Map.groupBy(snapshot.candidates, c => c.case_id).values()) {
    if (group.length < 4) throw Error('Each tournament task needs at least four distinct models');
  }
}

export function createTournamentEngine({ db, snapshot, seed, pairs, pairById, samplingPolicy=null, getBallots=null }) {
  db.exec(`CREATE TABLE IF NOT EXISTS tournaments (
    id TEXT PRIMARY KEY, reviewer_id TEXT NOT NULL REFERENCES reviewers(id), case_id TEXT NOT NULL,
    sequence INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(reviewer_id,sequence));
    CREATE TABLE IF NOT EXISTS tournament_battles (
    tournament_id TEXT NOT NULL REFERENCES tournaments(id), step INTEGER NOT NULL,
    pair_id TEXT UNIQUE NOT NULL REFERENCES pairs(id), PRIMARY KEY(tournament_id,step));`);
  const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 24);
  const order = text => createHmac('sha256', seed).update(text).digest('hex');
  const groups = Map.groupBy(snapshot.candidates, c => c.case_id);
  function read(row) {
    if (!row) return null;
    const ids = JSON.parse(row.body).candidate_ids;
    const votes = db.prepare(`SELECT b.*,t.step FROM tournament_battles t JOIN ballots b ON b.pair_id=t.pair_id
      WHERE t.tournament_id=? AND b.reviewer_id=? ORDER BY t.step`).all(row.id, row.reviewer_id);
    const valid = votes.filter(v => v.outcome === 'win');
    const state = tournamentState(ids, valid.map(v => v.winner_id));
    return { ...row, candidate_ids: ids, state, skipped: votes.some(v => v.outcome === 'unable'), blocked: false };
  }
  function current(reviewerId, allocate = true) {
    let row = read(db.prepare('SELECT * FROM tournaments WHERE reviewer_id=? ORDER BY sequence DESC LIMIT 1').get(reviewerId));
    if (!row || row.state.complete || row.skipped) {
      if(!allocate)return {tournament:row,pair:null};
      const sequence = row ? row.sequence + 1 : 0, cycle = Math.floor(sequence / groups.size);
      const caseIds = [...groups.keys()].sort((a, b) => order(`tasks:${reviewerId}:${cycle}:${a}`).localeCompare(order(`tasks:${reviewerId}:${cycle}:${b}`)));
      const caseId = caseIds[sequence % groups.size], id = digest(`${reviewerId}:${sequence}:${seed}`);
      const candidateIds = groups.get(caseId).map(c => c.id).sort((a, b) => order(`draw:${id}:${a}`).localeCompare(order(`draw:${id}:${b}`))).slice(0, 4);
      const selection=samplingPolicy?.algorithm===ACTIVE_SAMPLING?drawActiveTournament({group:groups.get(caseId),candidates:snapshot.candidates,pairs,
        ballots:getBallots?getBallots():db.prepare('SELECT * FROM ballots ORDER BY id').all(),policy:samplingPolicy,seed,drawId:id})
        :{candidate_ids:candidateIds,sampling:snapshot.protocol.sampling,
          ordered_selection_probability:1/(groups.get(caseId).length*(groups.get(caseId).length-1)*(groups.get(caseId).length-2)*(groups.get(caseId).length-3))};
      const body={...selection,cycle:cycle+1};
      const at = new Date().toISOString();
      const own = !db.isTransaction;
      if (own) db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO tournaments VALUES (?,?,?,?,?,?)').run(id, reviewerId, caseId, sequence, JSON.stringify(body), at);
        db.prepare('INSERT INTO events(kind,reviewer_id,body,created_at) VALUES (?,?,?,?)').run('tournament-assigned', reviewerId, JSON.stringify({ id, case_id: caseId, sequence, ...body }), at);
        if (own) db.exec('COMMIT');
      } catch (e) { if (own) db.exec('ROLLBACK'); throw e; }
      row = read(db.prepare('SELECT * FROM tournaments WHERE id=?').get(id));
    }
    const step = row.state.step, pairId = digest(`${row.id}:${step}`), ids = [...row.state.pair].sort();
    let pair = pairById.get(pairId);
    if (!pair) {
      if(!allocate)return {tournament:row,pair:null};
      const own = !db.isTransaction;
      if (own) db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO pairs VALUES (?,?,?,?)').run(pairId, row.case_id, ids[0], ids[1]);
        db.prepare('INSERT INTO tournament_battles VALUES (?,?,?)').run(row.id, step, pairId);
        if (own) db.exec('COMMIT');
      } catch (e) { if (own) db.exec('ROLLBACK'); throw e; }
      pair = { id: pairId, case_id: row.case_id, first_id: ids[0], second_id: ids[1] };
      pairs.push(pair); pairById.set(pairId, pair);
    }
    return { tournament: row, pair };
  }
  function progress(reviewerId) {
    const rows = db.prepare('SELECT * FROM tournaments WHERE reviewer_id=? ORDER BY sequence').all(reviewerId).map(read);
    const completed = rows.filter(r => r.state.complete).length, skipped = rows.filter(r => r.skipped).length, last = rows.at(-1);
    const r = db.prepare("SELECT COUNT(*) done,COALESCE(SUM(outcome='win'),0) voted,COALESCE(SUM(outcome='unable'),0) skipped FROM ballots WHERE reviewer_id=?").get(reviewerId);
    return { ...r, ties: 0, total: null, remaining: null, completed_sessions: completed, skipped_sessions: skipped,
      processed_sessions: completed + skipped, assigned_sessions: rows.length,
      cycle: last ? Math.floor(last.sequence / groups.size) + 1 : 1, tasks_per_cycle: groups.size,
      cycle_completed: completed % groups.size, battle: last && !last.state.complete && !last.skipped ? last.state.step : 0,
      battles_per_session: 5, blocked: last?.blocked || false, open_ended: true };
  }
  function exported() {
    return db.prepare('SELECT * FROM tournaments ORDER BY reviewer_id,sequence').all().map(row => {
      const r = read(row); return { id: r.id, reviewer_id: r.reviewer_id, case_id: r.case_id, sequence: r.sequence,
        ...JSON.parse(r.body), created_at: r.created_at, complete: r.state.complete, skipped: r.skipped, blocked: r.blocked,
        ordering: r.state.ordering || null, battles: db.prepare('SELECT * FROM tournament_battles WHERE tournament_id=? ORDER BY step').all(r.id) };
    });
  }
  return { current, progress, exported };
}

export function bradleyTerryRankings(candidates, pairs, votes) {
  const models = [...new Set(candidates.map(c => c.model_id))].sort(), n = models.length;
  const index = new Map(models.map((id, i) => [id, i])), byId = new Map(candidates.map(c => [c.id, c])), byPair = new Map(pairs.map(p => [p.id, p]));
  const wins = Array.from({ length: n }, () => Array(n).fill(0)), cases = models.map(() => new Set()), skipped = Array(n).fill(0);
  for (const v of votes) {
    const p = byPair.get(v.pair_id); if (!p) throw Error('Unknown tournament comparison');
    const a = byId.get(p.first_id), b = byId.get(p.second_id), i = index.get(a.model_id), j = index.get(b.model_id);
    if (v.outcome === 'unable') { skipped[i]++; skipped[j]++; continue; }
    if (v.outcome !== 'win' || ![a.id, b.id].includes(v.winner_id)) throw Error('Tournament rankings require decisive observed ballots');
    if (v.winner_id === a.id) wins[i][j]++; else wins[j][i]++;
    cases[i].add(a.case_id); cases[j].add(b.case_id);
  }
  const reachable = directed => {
    const seen = new Set(); function visit(i) { if (seen.has(i)) return; seen.add(i);
      for (let j = 0; j < n; j++) if (wins[i][j] || !directed && wins[j][i]) visit(j); }
    if (n) visit(0); return seen.size === n;
  };
  const connected = reachable(false), stronglyConnected = n > 1 && models.every((_, start) => {
    const seen = new Set(); function visit(i) { if (seen.has(i)) return; seen.add(i); for (let j = 0; j < n; j++) if (wins[i][j]) visit(j); } visit(start); return seen.size === n;
  });
  let strength = Array(n).fill(1), converged = false, iterations = 0;
  const totalWins = wins.map(row => row.reduce((a, b) => a + b, 0));
  if (stronglyConnected) for (iterations = 1; iterations <= 200; iterations++) {
    const next = strength.map((s, i) => totalWins[i] / models.reduce((sum, _, j) => sum + (i === j ? 0 : (wins[i][j] + wins[j][i]) / (s + strength[j])), 0));
    const scale = Math.exp(next.reduce((sum, v) => sum + Math.log(v), 0) / n);
    for (let i = 0; i < n; i++) next[i] /= scale;
    const delta = Math.max(...next.map((v, i) => Math.abs(v - strength[i]))); strength = next;
    if (delta < 0.0001) { converged = true; break; }
  }
  iterations = Math.min(iterations, 200);
  const rows = models.map((id, i) => {
    const group = candidates.filter(c => c.model_id === id), losses = wins.reduce((sum, row) => sum + row[i], 0), count = totalWins[i] + losses;
    const rating = stronglyConnected ? 400 * Math.log10(strength[i]) : null;
    return { model_id: id, model_name: group[0].model_name, candidates: group.length, wins: totalWins[i], losses, ties: 0, skipped: skipped[i],
      votes: count, win_rate: count ? totalWins[i] / count : null, strength: stronglyConnected ? strength[i] : null,
      rating, score: rating, rank: null, evaluated_cases: cases[i].size,
      opponents: models.filter((_, j) => wins[i][j] + wins[j][i] > 0).length,
      chart_eligible: count >= 50, preliminary: count < 200 || !converged };
  }).sort((a, b) => (b.rating ?? -Infinity) - (a.rating ?? -Infinity) || a.model_name.localeCompare(b.model_name));
  if (stronglyConnected) for (let i = 0; i < rows.length; i++) rows[i].rank = i && Math.abs(rows[i].rating - rows[i - 1].rating) < 1e-8 ? rows[i - 1].rank : i + 1;
  return { rows, matrix: Object.fromEntries(models.flatMap((a, i) => models.map((b, j) => [`${a}:${b}`, wins[i][j]]))),
    method: 'design-arena-bradley-terry-mm/v3', reference: DESIGN_ARENA_REFERENCE, connected, strongly_connected: stronglyConnected,
    status: !connected ? 'awaiting-connected-comparisons' : !stronglyConnected ? 'separated-no-finite-mle' : converged ? 'converged' : 'iteration-limit',
    converged, iterations, max_iterations: 200, convergence: 0.0001, normalization: 'geometric-mean-strength-one',
    explanation: '每轮随机4模型、5场匿名二选一；每张实际胜负票等权进入Bradley–Terry。Rating=400×log10(strength)，强度几何均值归一为1；不推导第6场票，不加入虚拟票或先验。少于50场不进入正式图榜，少于200场标为初步结果。比较图未连通或完全分离时，不发布有限BT排名。结果反映本轮参评设计师的偏好。' };
}
