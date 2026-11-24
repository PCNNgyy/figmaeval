import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createArenaStore, createArenaApp, validateArenaSnapshot, readArenaDeliveryAudit } from '../server/benchmark_arena.mjs';
import { arenaRankings, RATING, rateWin } from '../server/arena_ratings.mjs';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-human-arena-'));
  const candidates = Array.from({ length: 5 }, (_, i) => {
    const caseId = i < 3 ? 'case-001' : 'case-002', modelId = `model-${i < 3 ? i : i - 3}`;
    return { id: createHash('sha256').update(String(i)).digest('hex').slice(0, 24), case_id: caseId,
      model_id: modelId, model_name: `SECRET_MODEL_${modelId}`, run_id: `run-${i}`,
      title: caseId, source_url: `https://www.figma.com/design/source${caseId.replaceAll('-', '')}/`, source_query: 'Read 00, 01, 02, 04; create only in 03',
      workspace_url: `https://www.figma.com/design/output${i}/?page-id=12%3A60&node-id=12-60`, workspace_id: '12:60',
      trace_status: 'verified', evidence_status: 'live-view-required', images: [], recovered: i === 4 };
  });
  const snapshot = { kind: 'figma-human-arena-snapshot', version: 1, name: 'fixture', candidates };
  return { directory, snapshot, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
async function environment(t, options = {}) {
  const f = fixture(), store = createArenaStore(f.directory, f.snapshot);
  const server = createArenaApp(store, options).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); store.close(); f.cleanup(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, { cookie, body, origin } = {}) => {
    const r = await fetch(base + (options.basePath || '') + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(origin ? { origin } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0], setCookie: r.headers.get('set-cookie') };
  };
  const login = async (access) => (await request('/api/session', { body: { access } })).cookie;
  return { ...f, store, request, login, base };
}
function viewBoth(store, reviewer, pair) {
  for (const side of ['A', 'B']) store.seen(reviewer, pair.id, side, 'figma');
}

test('frozen cohort is deduplicated by case/model, copy IDs and the exact 03 page', () => {
  const f = fixture();
  try {
    assert.equal(validateArenaSnapshot(f.snapshot, f.directory), f.snapshot);
    const duplicate = structuredClone(f.snapshot); duplicate.candidates[1].model_id = duplicate.candidates[0].model_id;
    assert.throws(() => validateArenaSnapshot(duplicate, f.directory), /Duplicate/);
    const original = structuredClone(f.snapshot); original.candidates[0].workspace_url = original.candidates[0].source_url;
    assert.throws(() => validateArenaSnapshot(original, f.directory), /independent/);
    const wrongPage = structuredClone(f.snapshot); wrongPage.candidates[0].workspace_url = 'https://www.figma.com/design/output0/?node-id=0-1';
    assert.throws(() => validateArenaSnapshot(wrongPage, f.directory), /03 page/);
    const invalidTrace = structuredClone(f.snapshot); invalidTrace.candidates[0].trace_status = 'needs_review';
    assert.throws(() => validateArenaSnapshot(invalidTrace, f.directory), /unverified/);
  } finally { f.cleanup(); }
});

test('all unordered comparisons stay inside one task and two reviewers see opposite sides', () => {
  const f = fixture(), store = createArenaStore(f.directory, f.snapshot);
  try {
    assert.equal(store.pairs.length, 4);
    for (const pair of store.pairs) {
      assert.equal(store.candidates.get(pair.first_id).case_id, store.candidates.get(pair.second_id).case_id);
      assert.equal(store.sides(pair, 'reviewer-1').A, store.sides(pair, 'reviewer-2').B);
    }
    const first = store.next('reviewer-1').pair;
    viewBoth(store, 'reviewer-1', first); store.vote('reviewer-1', { pair_id: first.id, choice: 'A' });
    assert.notEqual(store.next('reviewer-1').pair.case_id, first.case_id, 'cover another task before repeating this task');
  } finally { store.close(); f.cleanup(); }
});

test('blinded reviewer API excludes model identities, run IDs, other votes and admin links', async (t) => {
  const { request, login, store } = await environment(t);
  assert.equal((await request('/api/admin/dashboard')).status, 403);
  assert.equal((await request('/api/session', { body: { access: 'bad-code' } })).status, 403);
  assert.equal((await request('/api/session', { body: { access: '错'.repeat(32) } })).status, 403);
  const cookie = await login(store.credentials.reviewers[0].access);
  const next = await request('/api/review/next', { cookie });
  assert.equal(next.status, 200);
  for (const secret of ['SECRET_MODEL', 'model_id', 'run_id', 'model_name', store.credentials.admin, store.credentials.reviewers[1].access]) assert.ok(!JSON.stringify(next.data).includes(secret));
  assert.equal((await request('/api/admin/dashboard', { cookie })).status, 403);
  assert.equal((await request('/api/admin/export', { cookie })).status, 403);
  assert.equal((await request('/api/admin/delivery-audit', { cookie })).status, 403);
  const adminCookie = await login(store.credentials.admin);
  assert.equal((await request('/api/review/next', { cookie: adminCookie })).status, 403);
  assert.equal((await request('/api/review/vote', { cookie, body: { pair_id: next.data.pair.id, choice: 'A' }, origin: 'https://unrelated.invalid' })).status, 403);
});

test('public management opens dashboard and exports without login, conceals access codes, and cannot grant voting identities',async t=>{
  const {store,request,login,base}=await environment(t,{basePath:'/arena',publicAdmin:true});
  const state=await request('/api/session');assert.equal(state.data.role,null);assert.equal(state.data.public_admin,true);assert.equal(state.setCookie,null);
  for(const route of ['/api/admin/dashboard','/api/admin/export','/api/admin/export.csv']){
    if(route.endsWith('.csv'))continue;
    const r=await request(route);assert.equal(r.status,200);
    for(const secret of [store.credentials.admin,store.credentials.seed,...store.credentials.reviewers.map(v=>v.access)])assert.ok(!JSON.stringify(r.data).includes(secret));
    const dashboard=route.endsWith('/dashboard')?r.data:r.data.dashboard;assert.ok(dashboard.reviewers.every(v=>!('invite'in v)));
  }
  const csv=await fetch(base+'/arena/api/admin/export.csv');assert.equal(csv.status,200);assert.match(await csv.text(),/human_preference/);
  assert.equal((await request('/api/review/next')).status,403);
  for(const route of ['/api/review/vote','/api/review/seen','/api/review/retry-unable'])assert.equal((await request(route,{body:{}})).status,403);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM ballots').get().n,0);
  const reviewer=await login(store.credentials.reviewers[0].access),reviewerDashboard=await request('/api/admin/dashboard',{cookie:reviewer});
  assert.equal(reviewerDashboard.status,200);assert.ok(reviewerDashboard.data.reviewers.every(v=>!v.invite));
  assert.equal((await request('/api/session',{cookie:reviewer})).data.role,'reviewer');
  const admin=await login(store.credentials.admin),adminDashboard=await request('/api/admin/dashboard',{cookie:admin});
  assert.ok(adminDashboard.data.reviewers.every(v=>v.invite.startsWith('/arena/#invite=')));
});

test('multi-judge score exports follow the existing admin read permissions',async t=>{
  const f=await environment(t,{basePath:'/arena',judgeScoresDirectory:path.join(os.tmpdir(),'missing-judge-campaign')});
  for(const route of ['/api/admin/judge-scores','/api/admin/judge-scores.csv','/api/admin/judge-pairs.csv','/api/admin/judge-agreement.csv']){
    assert.equal((await f.request(route)).status,403);
    const reviewer=await f.login(f.store.credentials.reviewers[0].access);
    assert.equal((await f.request(route,{cookie:reviewer})).status,403);
    const admin=await f.login(f.store.credentials.admin);
    const response=await f.request(route,{cookie:admin});assert.equal(response.status,503);
    assert.ok(!JSON.stringify(response.data).includes('missing-judge-campaign'));
  }
});

test('delivery audit stays admin-only and rejects a different run cohort without changing votes', async (t) => {
  const { request, login, store, directory } = await environment(t, { basePath: '/arena' });
  store.snapshot.selection_sha256 = 'frozen-selection';
  const audit = { kind: 'figma-arena-completeness-audit', selection_sha256: 'frozen-selection', counts: { empty: 999 },
    rows: store.snapshot.candidates.map((c) => ({ id: c.id, run_id: c.run_id, workspace_url: c.workspace_url, status: 'unverified' })) };
  fs.writeFileSync(path.join(directory, 'delivery-audit.json'), JSON.stringify(audit));
  assert.deepEqual(readArenaDeliveryAudit(store).counts, { unverified: 5 });
  const admin = await login(store.credentials.admin), reviewer = await login(store.credentials.reviewers[0].access);
  assert.equal((await request('/api/admin/delivery-audit', { cookie: reviewer })).status, 403);
  assert.equal((await request('/api/admin/delivery-audit', { cookie: admin })).data.rows.length, 5);
  assert.equal((await request('/api/review/next', { cookie: reviewer })).data.pair.delivery_audit, undefined);
  audit.rows[0].run_id = 'different-run';
  fs.writeFileSync(path.join(directory, 'delivery-audit.json'), JSON.stringify(audit));
  assert.equal((await request('/api/admin/delivery-audit', { cookie: admin })).status, 409);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM ballots').get().n, 0);
});

test('requires complete-view attestations, binds votes to randomized sides and deduplicates concurrent retries', async (t) => {
  const { request, login, store } = await environment(t);
  const reviewer = store.credentials.reviewers[0], cookie = await login(reviewer.access);
  const pair = (await request('/api/review/next', { cookie })).data.pair;
  const body = { pair_id: pair.id, choice: 'A' };
  assert.equal((await request('/api/review/vote', { cookie, body })).status, 400);
  assert.equal((await request('/api/review/seen', { cookie, body: { pair_id: pair.id, side: 'A', method: 'gallery' } })).status, 400);
  for (const side of ['A', 'B']) assert.equal((await request('/api/review/seen', { cookie, body: { pair_id: pair.id, side, method: 'figma' } })).status, 200);
  const results = await Promise.all([request('/api/review/vote', { cookie, body }), request('/api/review/vote', { cookie, body })]);
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(results.filter((r) => !r.data.duplicate).length, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM ballots').get().n, 1);
  const winner = store.candidates.get(store.sides(store.pairById.get(pair.id), reviewer.id).A);
  assert.equal(store.dashboard().ranking.rows.find((r) => r.model_id === winner.model_id).wins, 1);
  assert.equal((await request('/api/review/vote', { cookie, body: { ...body, choice: 'B' } })).status, 409);
});

test('access/evidence failures produce no losses or rating updates; retry keeps an audit trail', () => {
  const f = fixture(), store = createArenaStore(f.directory, f.snapshot);
  try {
    const pair = store.next('reviewer-1').pair;
    store.vote('reviewer-1', { pair_id: pair.id, choice: 'unable', reason: 'access', comment: 'No Figma access' });
    const d = store.dashboard();
    assert.equal(d.valid_votes, 0); assert.equal(d.unable, 1);
    assert.ok(d.ranking.rows.every((r) => r.score === null && r.wins === 0 && r.losses === 0));
    assert.equal(store.retrySkipped('reviewer-1').requeued, 1);
    assert.equal(store.next('reviewer-1').pair.id, pair.id);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM events').get().n, 2);
  } finally { store.close(); f.cleanup(); }
});

test('votes, identities and reviewer progress survive a database reopen; frozen cohort cannot be replaced', () => {
  const f = fixture(); let store = createArenaStore(f.directory, f.snapshot);
  try {
    const access = store.credentials.reviewers[0].access, pair = store.next('reviewer-1').pair;
    viewBoth(store, 'reviewer-1', pair); store.vote('reviewer-1', { pair_id: pair.id, choice: 'B' });
    store.close(); store = createArenaStore(f.directory, f.snapshot);
    assert.equal(store.credentials.reviewers[0].access, access);
    assert.equal(store.progress('reviewer-1').voted, 1);
    assert.notEqual(store.next('reviewer-1').pair.id, pair.id);
    const changed = structuredClone(f.snapshot); changed.candidates[0].run_id = 'replacement-run';
    assert.throws(() => createArenaStore(f.directory, changed), /different frozen snapshot/);
  } finally { store.close(); f.cleanup(); }
});

test('TrueSkill matches no-draw/no-drift reference and stays finite on a major upset', () => {
  const [winner, loser] = rateWin(RATING, RATING);
  assert.ok(Math.abs(winner.mu - 29.2052208700336) < .000002);
  assert.ok(Math.abs(winner.sigma - 7.194481348831082) < .000002);
  assert.ok(Math.abs(winner.mu + loser.mu - 50) < 1e-10);
  const upset = rateWin({ mu: -1000, sigma: .01 }, { mu: 1000, sigma: .01 });
  assert.ok(upset.every((r) => Number.isFinite(r.mu) && r.sigma > 0));
});

test('same frozen ballots produce the same ranking regardless of arrival order; only observed tasks are averaged', () => {
  const f = fixture(), store = createArenaStore(f.directory, f.snapshot);
  try {
    const pair = store.pairs[0], votes = [{ pair_id: pair.id, reviewer_id: 'reviewer-1', winner_id: pair.first_id },
      { pair_id: pair.id, reviewer_id: 'reviewer-2', winner_id: pair.second_id }];
    const first = arenaRankings(f.snapshot.candidates, store.pairs, votes);
    const reverse = arenaRankings(f.snapshot.candidates, store.pairs, [...votes].reverse());
    assert.deepEqual(first, reverse);
    assert.equal(first.agreement.compared, 1); assert.equal(first.agreement.agreed, 0);
    for (const r of first.rows.filter((r) => r.votes)) assert.equal(r.evaluated_cases, 1);
    assert.ok(first.rows.filter((r) => !r.votes).every((r) => r.case_mean === null));
  } finally { store.close(); f.cleanup(); }
});

test('image manifests cannot expose arbitrary files, symlinks or changed evidence', () => {
  const f = fixture();
  try {
    const s = structuredClone(f.snapshot), c = s.candidates[0];
    c.evidence_status = 'cached-complete'; c.images = [{ file: '../access.json', sha256: 'a'.repeat(64) }];
    assert.throws(() => validateArenaSnapshot(s, f.directory), /Unsafe image/);
    const p = `media/${c.id}/0.png`; fs.mkdirSync(path.dirname(path.join(f.directory, p)), { recursive: true });
    fs.writeFileSync(path.join(f.directory, p), 'changed'); c.images[0].file = p;
    assert.throws(() => validateArenaSnapshot(s, f.directory), /changed/);
    fs.rmSync(path.join(f.directory, p)); fs.symlinkSync('/etc/hosts', path.join(f.directory, p));
    assert.throws(() => validateArenaSnapshot(s, f.directory), /changed/);
  } finally { f.cleanup(); }
});

test('gateway prefix preserves browser assets, scoped sessions, invitations, votes and exports', async (t) => {
  const staticDirectory = path.resolve(import.meta.dirname, '../arena');
  const { request, store, login, base } = await environment(t, { basePath: '/arena', staticDirectory });
  const html = await fetch(base + '/arena/');
  assert.match(await html.text(), /<meta name="arena-base" content="\/arena">/);
  assert.equal((await fetch(base + '/arena/arena.js')).status, 200);
  assert.equal((await fetch(base + '/arena/arena.css')).status, 200);
  const canonical = await fetch(base + '/arena', { redirect: 'manual' });
  assert.equal(canonical.status, 308); assert.equal(canonical.headers.get('location'), '/arena/');
  const rootHealth = await fetch(base + '/api/health'); assert.equal(rootHealth.status, 200);
  const admin = await request('/api/session', { body: { access: store.credentials.admin } });
  assert.match(admin.setCookie, /Path=\/arena\//);
  const dashboard = await request('/api/admin/dashboard', { cookie: admin.cookie });
  assert.ok(dashboard.data.reviewers.every((r) => r.invite.startsWith('/arena/#invite=')));
  const cookie = await login(store.credentials.reviewers[0].access);
  const pair = (await request('/api/review/next', { cookie })).data.pair;
  for (const side of ['A', 'B']) assert.equal((await request('/api/review/seen', { cookie, body: { pair_id: pair.id, side, method: 'figma' } })).status, 200);
  assert.equal((await request('/api/review/vote', { cookie, body: { pair_id: pair.id, choice: 'A' } })).status, 200);
  const exported = await request('/api/admin/export', { cookie: admin.cookie });
  assert.equal(exported.data.votes.length, 1);
  assert.ok(exported.data.dashboard.reviewers.every((r) => r.invite.startsWith('/arena/#invite=')));
  const logout = await request('/api/logout', { cookie, body: {} }); assert.match(logout.setCookie, /Path=\/arena\//);
  assert.equal((await request('/api/review/next', { cookie })).status, 403);
});
