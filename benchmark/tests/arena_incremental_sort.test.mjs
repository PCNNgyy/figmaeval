import test from 'node:test';
import assert from 'node:assert/strict';
import {createRankingState,advanceRanking,addRankingModels,preferenceGraph,rankingComparisonBound} from '../server/arena_incremental_sort.mjs';

const permutations = ids => ids.length ? ids.flatMap((id, i) => permutations(ids.filter((_, j) => j !== i)).map(p => [id, ...p])) : [[]];
function finish(state, order, votes = []) {
  const rank = new Map(order.map((id, i) => [id, i])), derivations = [];
  for (;;) {
    state = advanceRanking(state, votes, r => derivations.push(r));
    if (state.status !== 'awaiting-vote') return {state, votes, derivations};
    const {a, b} = state.pending;
    assert.equal(preferenceGraph(state.models, votes).compare(a, b), null, 'A vote must only be requested for an unknown relation');
    votes.push({id: votes.length + 1, a, b, winner: rank.get(a) < rank.get(b) ? a : b, outcome: 'win'});
    state = JSON.parse(JSON.stringify(state));
  }
}

test('all 720 six-model strict preferences finish correctly with at most 11 actual votes, including staged 4+2', () => {
  const ids = ['a','b','c','d','e','f'], histogram = new Map(); let checked = 0;
  for (const order of permutations(ids)) {
    const first = finish(createRankingState(ids.slice(0, 4)), order);
    assert.equal(first.state.status, 'complete'); assert.ok(first.votes.length <= 5);
    assert.deepEqual(first.state.ranking, order.filter(id => ids.slice(0, 4).includes(id)));
    const before = first.votes.length, extended = finish(addRankingModels(first.state, ids.slice(4)), order, first.votes);
    assert.deepEqual(extended.state.ranking, order); assert.ok(extended.votes.length - before <= 6); assert.ok(extended.votes.length <= 11);
    const automatic = finish(createRankingState(ids), order);
    assert.equal(automatic.state.status, 'complete'); assert.deepEqual(automatic.state.ranking, order); assert.ok(automatic.votes.length <= 11);
    histogram.set(automatic.votes.length, (histogram.get(automatic.votes.length) || 0) + 1); checked++;
  }
  assert.equal(checked, 720); assert.equal(Math.max(...histogram.keys()), 11); assert.equal(rankingComparisonBound(6), 11);
});

test('one added model uses binary insertion at every position; direct and transitive evidence avoid new votes', () => {
  for (const order of permutations(['a','b','c','d','e'])) {
    const first = finish(createRankingState(['a','b','c','d']), order), before = first.votes.length;
    const next = finish(addRankingModels(first.state, ['e']), order, first.votes);
    assert.deepEqual(next.state.ranking, order); assert.ok(next.votes.length - before <= 3);
  }
  const votes = [{id:1,a:'a',b:'b',winner:'a',outcome:'win'},{id:2,a:'b',b:'c',winner:'b',outcome:'win'}];
  const graph = preferenceGraph(['a','b','c'],votes);
  assert.equal(graph.compare('a','b').kind,'direct'); assert.equal(graph.compare('c','a').kind,'transitive');
  assert.deepEqual(graph.compare('a','c').vote_ids,[1,2]); assert.equal(votes.length,2);
});

test('cycles and ties pause without producing a strict final ranking; correcting evidence allows replay', () => {
  const votes = [{id:1,a:'a',b:'b',winner:'a',outcome:'win'},{id:2,a:'b',b:'c',winner:'b',outcome:'win'},{id:3,a:'c',b:'a',winner:'c',outcome:'win'}];
  let state=advanceRanking(createRankingState(['a','b','c','d']),votes);
  assert.equal(state.status,'paused-cycle');assert.equal(state.pending,null);assert.ok(state.issue.vote_ids.length>=3);
  votes[2].active=false;state=advanceRanking(createRankingState(['a','b','c','d']),votes);assert.equal(state.status,'awaiting-vote');
  const tie={id:4,a:state.pending.a,b:state.pending.b,outcome:'tie'};
  state=advanceRanking(state,[...votes,tie]);assert.equal(state.status,'paused-tie');assert.equal(state.pending,null);
  assert.throws(()=>preferenceGraph(['a','b'],[{id:1,a:'a',b:'foreign',winner:'a',outcome:'win'}]),/scope/);
});
