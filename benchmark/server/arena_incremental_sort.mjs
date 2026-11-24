export const INCREMENTAL_SORT = 'pairwise-incremental-merge/v1';

export function preferenceGraph(ids, votes) {
  const nodes = new Set(ids), edges = new Map(ids.map(id => [id, []])), ties = new Map();
  for (const v of votes.filter(v => v.active !== false && v.active !== 0)) {
    if (!nodes.has(v.a) || !nodes.has(v.b) || v.a === v.b) throw Error('Vote outside ranking scope');
    if (v.outcome === 'tie') { ties.set(JSON.stringify([v.a, v.b].sort()), v); continue; }
    if (v.outcome !== 'win') continue;
    if (![v.a, v.b].includes(v.winner)) throw Error('Invalid observed winner');
    edges.get(v.winner).push({ to: v.winner === v.a ? v.b : v.a, vote_id: v.id });
  }
  function path(a, b) {
    const queue = [{ id: a, models: [a], votes: [] }], seen = new Set([a]);
    for (const at of queue) for (const e of edges.get(at.id)) {
      if (e.to === b) return { models: [...at.models, b], vote_ids: [...at.votes, e.vote_id] };
      if (!seen.has(e.to)) { seen.add(e.to); queue.push({ id: e.to, models: [...at.models, e.to], votes: [...at.votes, e.vote_id] }); }
    }
    return null;
  }
  let cycle = null;
  findCycle: for (const [a, list] of edges) for (const e of list) {
    const back = path(e.to, a);
    if (back) { cycle = { models: [a, ...back.models], vote_ids: [e.vote_id, ...back.vote_ids] }; break findCycle; }
  }
  function compare(a, b) {
    if (!nodes.has(a) || !nodes.has(b) || a === b) throw Error('Invalid comparison');
    if (cycle) return { kind: 'cycle', cycle };
    const tie = ties.get(JSON.stringify([a, b].sort()));
    if (tie) return { kind: 'tie', vote_ids: [tie.id] };
    for (const [winner, loser] of [[a, b], [b, a]]) {
      const direct = edges.get(winner).find(e => e.to === loser);
      if (direct) return { kind: 'direct', winner, loser, models: [winner, loser], vote_ids: [direct.vote_id] };
    }
    for (const [winner, loser] of [[a, b], [b, a]]) {
      const proof = path(winner, loser);
      if (proof) return { kind: 'transitive', winner, loser, ...proof };
    }
    return null;
  }
  return { compare, cycle, ties: [...ties.values()] };
}

export function createRankingState(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw Error('Distinct model IDs required');
  return { algorithm: INCREMENTAL_SORT, models: [...ids], introduced: Math.min(4, ids.length),
    phase: ids.length >= 4 ? 'initial-left' : 'batch', status: 'running',
    remaining: ids.length >= 4 ? ids.slice(4) : [...ids], ranking: [],
    initial: { left: ids.slice(0, 2), right: ids.slice(2, 4) }, merge: null, insertion: null,
    batch: null, pending: null, issue: null };
}

export function addRankingModels(state, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id || state.models.includes(id)) || new Set(ids).size !== ids.length) throw Error('New distinct model IDs required');
  const next = structuredClone(state);
  next.models.push(...ids); next.remaining.push(...ids);
  if (next.phase === 'complete') { next.phase = 'batch'; next.status = 'running'; }
  return next;
}

export function advanceRanking(input, votes, onDerivation = () => {}) {
  const s = structuredClone(input), graph = preferenceGraph(s.models, votes);
  s.pending = null; s.issue = null; s.status = 'running';
  if (graph.cycle) { s.status = 'paused-cycle'; s.issue = graph.cycle; return s; }
  if (graph.ties.length) { s.status = 'paused-tie'; s.issue = { vote_ids: graph.ties.map(v => v.id) }; return s; }
  function compare(a, b) {
    const relation = graph.compare(a, b);
    if (!relation) { s.pending = { a, b }; s.status = 'awaiting-vote'; return null; }
    if (relation.kind === 'transitive') onDerivation(relation);
    return relation.winner;
  }
  function beginMerge(left, right, target) {
    s.merge = { left: [...left], right: [...right], i: 0, j: 0, output: [], target };
    s.phase = 'merge';
  }
  for (;;) {
    if (s.phase === 'initial-left' || s.phase === 'initial-right') {
      const side = s.phase === 'initial-left' ? 'left' : 'right', [a, b] = s.initial[side];
      const winner = compare(a, b); if (!winner) return s;
      s.initial[side] = winner === a ? [a, b] : [b, a];
      if (side === 'left') s.phase = 'initial-right';
      else beginMerge(s.initial.left, s.initial.right, 'initial');
    } else if (s.phase === 'merge') {
      const m = s.merge;
      if (m.i === m.left.length || m.j === m.right.length) {
        s.ranking = [...m.output, ...m.left.slice(m.i), ...m.right.slice(m.j)];
        s.merge = null; s.batch = null; s.phase = 'batch'; continue;
      }
      const a = m.left[m.i], b = m.right[m.j], winner = compare(a, b); if (!winner) return s;
      m.output.push(winner); if (winner === a) m.i++; else m.j++;
    } else if (s.phase === 'batch') {
      if (!s.remaining.length) { s.phase = 'complete'; s.status = 'complete'; return s; }
      s.batch = s.remaining.splice(0, 2);
      if (s.batch.length === 2) s.phase = 'batch-pair';
      else { s.insertion = { model: s.batch[0], lo: 0, hi: s.ranking.length }; s.phase = 'binary-insert'; }
    } else if (s.phase === 'batch-pair') {
      const [a, b] = s.batch, winner = compare(a, b); if (!winner) return s;
      s.introduced = Math.max(s.introduced, s.models.length - s.remaining.length);
      beginMerge(s.ranking, winner === a ? [a, b] : [b, a], 'extension');
    } else if (s.phase === 'binary-insert') {
      const ins = s.insertion;
      if (ins.lo === ins.hi) {
        s.ranking.splice(ins.lo, 0, ins.model); s.insertion = null; s.batch = null; s.phase = 'batch';
        s.introduced = Math.max(s.introduced, s.models.length - s.remaining.length); continue;
      }
      const mid = Math.floor((ins.lo + ins.hi) / 2), winner = compare(ins.model, s.ranking[mid]); if (!winner) return s;
      if (winner === ins.model) ins.hi = mid; else ins.lo = mid + 1;
    } else if (s.phase === 'complete') { s.status = 'complete'; return s; }
    else throw Error(`Unknown sorting phase: ${s.phase}`);
  }
}

export function rankingComparisonBound(n) {
  if (!Number.isSafeInteger(n) || n < 1) throw Error('Invalid model count');
  if (n < 4) return n === 1 ? 0 : n === 2 ? 1 : 3;
  let total = 5, size = 4;
  while (size + 2 <= n) { total += 1 + size + 1; size += 2; }
  if (size < n) total += Math.ceil(Math.log2(size + 1));
  return total;
}
