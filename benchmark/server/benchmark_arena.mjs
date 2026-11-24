import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import {CAPTURED_DELIVERY_KIND,validateCapturedCandidate,validateCapturedManifest} from './arena_captured_delivery.mjs';
import {synchronizeArenaIdentities} from './arena_shared_identity.mjs';
import { arenaRankings } from './arena_ratings.mjs';
import { readCCLeaderboard } from './benchmark_cc_leaderboard.mjs';
import { validateArenaProtocol, pairwiseRankings, validBallot, ballotOutcome, arenaV4Comparison } from './arena_protocol.mjs';
import { readArenaRequirements, reviewerRequirements } from './arena_requirements.mjs';
import { validateTournamentProtocol, createTournamentEngine, bradleyTerryRankings } from './arena_tournament.mjs';
import { readArenaReviewers } from './arena_reviewers.mjs';
import { arenaAccounts } from './arena_accounts.mjs';
import { arenaTaskStatistics, arenaCsv, taskCsvColumns } from './arena_statistics.mjs';
import {readArenaSampling} from './arena_active_sampling.mjs';
import {DELIVERY_KIND,validateDeliveryCandidate,validateDeliveryManifest,frozenDeliveryLeaderboard} from './arena_delivery.mjs';
import {readScreenCatalog,createPairScreenReview} from './arena_pair_screens.mjs';
import {selectReviewImages} from './arena_screen_selection.mjs';
import {createIncrementalEngine} from './arena_incremental.mjs';
import {readCompletedStages} from './arena_progress_history.mjs';
import {INCREMENTAL_SORT} from './arena_incremental_sort.mjs';
import {createArenaMedia} from './arena_media.mjs';
import {createScreenMarks,screenMarksCsv} from './arena_screen_marks.mjs';
import {readAnonymousFigmaLinks,canonicalFigmaUrl} from './arena_figma_links.mjs';
import {readArenaJudgeScores,judgeScoreCsvRows,judgePairCsvRows} from './arena_judge_scores.mjs';
import {withHumanJudgeAgreement} from './arena_judge_agreement.mjs';

const hash = (v) => createHash('sha256').update(v).digest('hex');
const token = () => randomBytes(24).toString('base64url');
const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
const fileKey = (url) => {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !['www.figma.com', 'figma.com'].includes(u.hostname)) throw new Error('Invalid Figma URL');
  return u.pathname.match(/^\/(?:design|file)\/([a-zA-Z0-9]+)(?:\/|$)/)?.[1] || '';
};
const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
};

export function readArenaDeliveryAudit(store) {
  const file = path.join(store.directory, 'delivery-audit.json');
  if (!fs.existsSync(file)) return null;
  const audit = JSON.parse(fs.readFileSync(file, 'utf8'));
  const statuses = new Set(['partial', 'empty', 'unverified', 'wrong_workspace', 'uncertain_content', 'no_obvious_omissions']);
  const ids = new Set();
  if (audit.kind !== 'figma-arena-completeness-audit' || !store.snapshot.selection_sha256
      || audit.selection_sha256 !== store.snapshot.selection_sha256 || audit.rows?.length !== store.candidates.size) fail(409, '交付核查与本轮冻结稿件不匹配');
  const counts = {};
  for (const row of audit.rows) {
    const c = store.candidates.get(row.id);
    if (!c || ids.has(row.id) || row.run_id !== c.run_id || row.workspace_url !== c.workspace_url || !statuses.has(row.status)) fail(409, '交付核查与本轮冻结稿件不匹配');
    ids.add(row.id); counts[row.status] = (counts[row.status] || 0) + 1;
  }
  return { ...audit, counts };
}

export function validateArenaSnapshot(snapshot, directory) {
  if (snapshot.kind !== 'figma-human-arena-snapshot' || ![1,2,3].includes(snapshot.version) || !snapshot.candidates?.length) throw new Error('Invalid arena snapshot');
  const external=snapshot.version===3&&snapshot.external_delivery?.kind===DELIVERY_KIND;
  const captured=snapshot.version===3&&snapshot.captured_delivery?.kind===CAPTURED_DELIVERY_KIND;
  if(snapshot.external_delivery&&!external)throw Error('Invalid external delivery type');
  if(snapshot.captured_delivery&&!captured)throw Error('Invalid captured review type');
  const ids = new Set(), combinations = new Set(), outputs = new Set();
  const sourceKeys = new Set(snapshot.candidates.map((c) => fileKey(c.source_url)));
  const cases = new Map();
  const models = new Map();
  for (const c of snapshot.candidates) {
    const combination = `${c.case_id}:${c.model_id}`;
    if (!/^[a-f0-9]{24}$/.test(c.id) || !c.case_id || !c.model_id || !c.model_name || !c.run_id
        || typeof c.title !== 'string' || !c.title || typeof c.source_query !== 'string' || !c.source_query.trim()
        || ids.has(c.id) || combinations.has(combination)
        || (external||captured ? false : snapshot.version===1 ? c.trace_status!=='verified' : !['verified','verified_prefix_terminal_results_missing','input_transport_unverified'].includes(c.trace_status)
          || c.generation_ended!==true || c.screen_check?.passed!==true
          || c.cc_score!==null&&(!Number.isInteger(c.cc_score)||c.cc_score<0||c.cc_score>53||!c.cc_score_id))) throw new Error('Duplicate or unverified arena candidate');
    const key = fileKey(c.workspace_url), source = fileKey(c.source_url), u = new URL(c.workspace_url);
    if (!key || !source || !captured&&sourceKeys.has(key) || outputs.has(key) || !/^\d+:\d+$/.test(c.workspace_id)
        || u.searchParams.get('page-id') !== c.workspace_id || u.searchParams.get('node-id') !== c.workspace_id.replaceAll(':', '-')) throw new Error('Output must be an independent copy linked to its 03 page');
    const caseValue = JSON.stringify([c.source_url, c.source_query, c.title]);
    if (cases.has(c.case_id) && cases.get(c.case_id) !== caseValue) throw new Error('Same-case task references differ');
    if (models.has(c.model_id) && models.get(c.model_id) !== c.model_name) throw new Error('Model identity differs');
    cases.set(c.case_id, caseValue); models.set(c.model_id, c.model_name);
    if (!['cached-complete', 'live-view-required'].includes(c.evidence_status) || !Array.isArray(c.images)
        || c.evidence_status === 'live-view-required' && c.images.length
        || c.evidence_status === 'cached-complete' && !c.images.length) throw new Error('Unverified screenshots must not be served');
    if(external)validateDeliveryCandidate(snapshot,c);
    if(captured)validateCapturedCandidate(snapshot,c);
    for (const image of c.images) {
      if (!new RegExp(`^media/${c.id}/[0-9]+\\.png$`).test(image.file) || !/^[a-f0-9]{64}$/.test(image.sha256)) throw new Error('Unsafe image manifest');
      const target = path.resolve(directory, image.file);
      if (fs.realpathSync(target) !== target || fs.lstatSync(target).isSymbolicLink()) throw new Error('Frozen screenshot changed');
      const bytes = fs.readFileSync(target);
      if (hash(bytes) !== image.sha256) throw new Error('Frozen screenshot changed');
      if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
          || bytes.subarray(12, 16).toString() !== 'IHDR' || !image.width || !image.height
          || bytes.readUInt32BE(16) !== image.width || bytes.readUInt32BE(20) !== image.height) throw new Error('Invalid frozen screenshot');
    }
    ids.add(c.id); combinations.add(combination); outputs.add(key);
  }
  if(snapshot.version===2)validateArenaProtocol(snapshot);
  if(snapshot.version===3)validateTournamentProtocol(snapshot);
  if(external)validateDeliveryManifest(snapshot,directory);
  if(captured)validateCapturedManifest(snapshot,directory);
  const contentFile=path.join(directory,'screen-content-check.json');
  if(fs.existsSync(contentFile)){
    const check=JSON.parse(fs.readFileSync(contentFile));
    if(check.kind!=='arena-product-content-acceptance/v1'||check.rule!=='blank-screen-pixels/v2'||check.status!=='passed'
      ||check.candidates!==snapshot.candidates.length||check.results?.length!==snapshot.candidates.length
      ||check.snapshot_file_sha256!==hash(fs.readFileSync(path.join(directory,'snapshot.json')))
      ||check.catalog_file_sha256!==hash(fs.readFileSync(path.join(directory,'screen-catalog.json')))
      ||new Set(check.results.map(r=>r.candidate_id)).size!==snapshot.candidates.length
      ||check.results.some(r=>r.status!=='passed'||!snapshot.candidates.some(c=>c.id===r.candidate_id)))throw Error('Published screen content acceptance failed or changed');
    const catalog=JSON.parse(fs.readFileSync(path.join(directory,'screen-catalog.json')));
    for(const row of check.results){
      const c=snapshot.candidates.find(c=>c.id===row.candidate_id),meta=catalog.candidates.find(m=>m.id===c.id);
      const images=selectReviewImages(meta.images,catalog.required_frames[c.case_id]).images;
      if(!images.length||row.rule!=='blank-screen-pixels/v2'||row.blank_screens?.length!==0||row.screens?.length!==images.length
        ||row.screens.some((screen,i)=>screen.blank!==false||screen.sha256!==c.images[images[i].index].sha256||screen.node_id!==images[i].node_id))throw Error('Content acceptance does not cover the published product PNGs');
    }
  }
  return snapshot;
}

export function createArenaStore(directory, snapshot, {openRegistration=false,showFigmaLinks=false,screenComparisons=false,incrementalRanking=false} = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const snapshotText = JSON.stringify(snapshot), digest = hash(snapshotText);
  validateArenaSnapshot(snapshot, directory);
  if(incrementalRanking&&snapshot.version!==3)throw Error('Incremental sorting requires a version3 frozen cohort');
  const reviewMode=showFigmaLinks?'figma-and-screenshots':snapshot.review_mode||'figma-and-screenshots';
  const requirements = readArenaRequirements(directory, snapshot, digest);
  const database = path.join(directory, 'arena.sqlite3');
  const db = new DatabaseSync(database);
  fs.chmodSync(database, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, case_id TEXT NOT NULL, model_id TEXT NOT NULL, run_id TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(case_id,model_id));
    CREATE TABLE IF NOT EXISTS pairs (id TEXT PRIMARY KEY, case_id TEXT NOT NULL, first_id TEXT NOT NULL REFERENCES candidates(id), second_id TEXT NOT NULL REFERENCES candidates(id));
    CREATE TABLE IF NOT EXISTS reviewers (id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, role TEXT NOT NULL, reviewer_id TEXT REFERENCES reviewers(id), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS views (reviewer_id TEXT NOT NULL REFERENCES reviewers(id), pair_id TEXT NOT NULL REFERENCES pairs(id), candidate_id TEXT NOT NULL REFERENCES candidates(id), method TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(reviewer_id,pair_id,candidate_id));
    CREATE TABLE IF NOT EXISTS ballots (id INTEGER PRIMARY KEY, reviewer_id TEXT NOT NULL REFERENCES reviewers(id), pair_id TEXT NOT NULL REFERENCES pairs(id), winner_id TEXT REFERENCES candidates(id), reason TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE(reviewer_id,pair_id));
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, reviewer_id TEXT, pair_id TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL);`);
  if(!db.prepare('PRAGMA table_info(ballots)').all().some(c=>c.name==='outcome'))db.exec('ALTER TABLE ballots ADD COLUMN outcome TEXT');
  if(!db.prepare('PRAGMA table_info(ballots)').all().some(c=>c.name==='requirements_hash'))db.exec('ALTER TABLE ballots ADD COLUMN requirements_hash TEXT');
  db.exec("UPDATE ballots SET outcome=CASE WHEN winner_id IS NULL THEN 'unable' ELSE 'win' END WHERE outcome IS NULL");
  const existing = db.prepare('SELECT value FROM metadata WHERE key=?').get('snapshot_hash');
  if (existing && existing.value !== digest) { db.close(); throw new Error('This arena already has a different frozen snapshot; use a new directory'); }
  let credentials;
  const plannedReviewers=snapshot.version===3?snapshot.protocol.reviewers:2;
  const credentialFile = path.join(directory, 'access.json');
  if (existing) {
    if (!fs.existsSync(credentialFile)) { db.close(); throw new Error('Arena access file is missing; restore it rather than replacing reviewer identities'); }
    credentials = JSON.parse(fs.readFileSync(credentialFile));
  } else {
    credentials = fs.existsSync(credentialFile) ? JSON.parse(fs.readFileSync(credentialFile))
      : { admin: token(), seed: token(), reviewers: Array.from({length:plannedReviewers},(_,i)=>({id:`reviewer-${i+1}`,label:`评审 ${i+1}`,access:token()})) };
    if (!credentials.admin || !credentials.seed || credentials.reviewers?.length < plannedReviewers
      || !Array.isArray(credentials.reviewers) || new Set(credentials.reviewers.map(r=>r.id)).size!==credentials.reviewers.length
      || credentials.reviewers.some(r=>!r.id||!r.label||!r.access)) throw Error('Invalid arena access identities');
    const carriedAccess = fs.existsSync(credentialFile);
    if (!carriedAccess) fs.writeFileSync(credentialFile, JSON.stringify(credentials, null, 2), { flag: 'wx', mode: 0o600 });
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO metadata VALUES (?,?)').run('snapshot_hash', digest);
      for (const c of snapshot.candidates) db.prepare('INSERT INTO candidates VALUES (?,?,?,?,?)').run(c.id, c.case_id, c.model_id, c.run_id, JSON.stringify(c));
      const groups = Map.groupBy(snapshot.candidates, (c) => c.case_id);
      if(snapshot.version===2){for(const p of snapshot.protocol.pairs)db.prepare('INSERT INTO pairs VALUES (?,?,?,?)').run(p.id,p.case_id,p.first_id,p.second_id);}
      else if(snapshot.version===1) for (const [caseId, group] of groups) {
        group.sort((a, b) => a.id.localeCompare(b.id));
        for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
          const id = hash(`${caseId}:${group[i].id}:${group[j].id}`).slice(0, 24);
          db.prepare('INSERT INTO pairs VALUES (?,?,?,?)').run(id, caseId, group[i].id, group[j].id);
        }
      }
      for (const r of credentials.reviewers) db.prepare('INSERT INTO reviewers VALUES (?,?,?)').run(r.id, r.label, hash(r.access));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); db.close(); if(!carriedAccess)fs.rmSync(credentialFile, { force: true }); throw e; }
  }
  let reviewerPolicy;
  try{reviewerPolicy=readArenaReviewers(directory,snapshot,digest,credentials);}catch(e){db.close();throw e;}
  const legacyReviewers=openRegistration&&(snapshot.external_delivery?.kind===DELIVERY_KIND||snapshot.captured_delivery?.kind===CAPTURED_DELIVERY_KIND)?[]:credentials.reviewers.filter(r=>reviewerPolicy.active_reviewers.includes(r.id));
  const accounts=arenaAccounts(db,legacyReviewers,{openRegistration});
  const activeIds=new Set(),activeReviewers=[];
  function refreshReviewers(){activeReviewers.splice(0,activeReviewers.length,...accounts.reviewers());activeIds.clear();for(const r of activeReviewers)activeIds.add(r.id);}
  refreshReviewers();
  const assertActive=id=>{if(!activeIds.has(id))fail(403,'此评审入口已停用，请使用当前评审链接');};
  let incremental=null;
  const scopedBallots=()=>{const ids=incremental?.effectiveBallotIds();return db.prepare('SELECT * FROM ballots ORDER BY id').all()
    .filter(v=>activeIds.has(v.reviewer_id)&&(!ids||ids.has(v.id)));};
  if(snapshot.version===3&&db.prepare('SELECT value FROM metadata WHERE key=?').get('reviewer_policy_hash')?.value!==reviewerPolicy.content_hash){
    db.exec('BEGIN IMMEDIATE');try{
      db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run('reviewer_policy_hash',reviewerPolicy.content_hash);
      db.prepare('INSERT INTO events(kind,body,created_at) VALUES (?,?,?)').run('reviewer-policy',JSON.stringify(reviewerPolicy),new Date().toISOString());
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');db.close();throw e;}
  }
  const candidates = new Map(snapshot.candidates.map((c) => [c.id, c]));
  const figmaLinks=readAnonymousFigmaLinks(directory,snapshot,digest);
  const updateFile=path.join(directory,'review-updates.json'),reviewUpdates=fs.existsSync(updateFile)?JSON.parse(fs.readFileSync(updateFile)):null;
  if(reviewUpdates&&reviewUpdates.snapshot_hash!==digest)throw Error('Review updates belong to another snapshot');
  const updateFor=caseId=>reviewUpdates?.case_ids.includes(caseId)?{message:reviewUpdates.message||'本题有一份稿件已更新，相关比较需要重新确认；旧版记录已归档。',lobby_message:reviewUpdates.lobby_message||'稿件已更新 · 请继续复核相关比较',updated_at:reviewUpdates.updated_at}:null;
  let samplingPolicy=null;
  try{if(snapshot.version===3)samplingPolicy=readArenaSampling(directory,snapshot,digest);}catch(e){db.close();throw e;}
  if(samplingPolicy&&db.prepare('SELECT value FROM metadata WHERE key=?').get('sampling_policy_hash')?.value!==samplingPolicy.content_hash){
    db.exec('BEGIN IMMEDIATE');try{
      db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run('sampling_policy_hash',samplingPolicy.content_hash);
      db.prepare('INSERT INTO events(kind,body,created_at) VALUES (?,?,?)').run('sampling-policy-activated',JSON.stringify(samplingPolicy),new Date().toISOString());
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');db.close();throw e;}
  }
  const pairs = db.prepare('SELECT * FROM pairs ORDER BY id').all();
  const pairById = new Map(pairs.map((p) => [p.id, p]));
  const randomOrder = (s) => createHmac('sha256', credentials.seed).update(s).digest('hex');
  const tournament = snapshot.version===3&&!incrementalRanking ? createTournamentEngine({db,snapshot,seed:credentials.seed,pairs,pairById,samplingPolicy,getBallots:scopedBallots}) : null;
  if(incrementalRanking)incremental=createIncrementalEngine({db,snapshot,snapshotHash:digest,seed:credentials.seed,pairs,pairById,completedStages:readCompletedStages(directory,snapshot)});
  const engine=incremental||tournament;
  let screenReview=null;
  if(screenComparisons){
    try{
      const catalog=readScreenCatalog(directory,snapshot,digest);
      screenReview=createPairScreenReview({db,catalog,snapshotHash:digest,candidates,sides,assertActive,
        currentPair:reviewer=>engine?engine.current(reviewer,false).pair:queue(reviewer).find(p=>!db.prepare('SELECT 1 FROM ballots WHERE reviewer_id=? AND pair_id=?').get(reviewer,p.id))});
    }catch(e){db.close();throw e;}
  }
  const media=incremental?createArenaMedia({db,directory,snapshot,digest,seed:credentials.seed,candidates,catalog:screenReview?.catalog}):null;
  const screenMarks=screenReview?createScreenMarks({db,directory,snapshotHash:digest,candidates,catalog:screenReview.catalog,sides,assertActive,
    currentPair:reviewer=>engine?engine.current(reviewer,false).pair:queue(reviewer).find(p=>!db.prepare('SELECT 1 FROM ballots WHERE reviewer_id=? AND pair_id=?').get(reviewer,p.id)),
    assertLoaded:(reviewer,pair,id,index,body)=>{
      if(media){media.assertDownloaded(reviewer,id,index,body.media_key);media.download(reviewer,body.media_key);return;}
      if(!db.prepare('SELECT 1 FROM pair_screen_image_views WHERE reviewer_id=? AND pair_id=? AND candidate_id=? AND image_index=? AND image_sha256=?').get(reviewer,pair.id,id,index,candidates.get(id).images[index].sha256))fail(400,'请先加载这张屏幕的原图');
    }}):null;
  if(incremental&&db.prepare("SELECT value FROM metadata WHERE key='review_flow'").get()?.value!=='task-picker-cache-ab/v1'){
    db.prepare("INSERT OR REPLACE INTO metadata VALUES ('review_flow',?)").run('task-picker-cache-ab/v1');
    db.prepare('INSERT INTO events(kind,body,created_at) VALUES (?,?,?)').run('review-flow-updated',JSON.stringify({
      kind:'task-picker-cache-ab/v1',overall_choices:['A','B'],independent_repeat_rounds:true,
      downloads_are_not_views:true,snapshot_hash:digest,existing_ballots:db.prepare('SELECT COUNT(*) n FROM ballots').get().n}),new Date().toISOString());
  }
  function sides(pair, reviewerId) {
    const sorted=incremental?.display(pair.id,reviewerId);if(sorted)return sorted;
    const reverse = Number.parseInt(randomOrder(pair.id)[0], 16) % 2 ^ Number(reviewerId === 'reviewer-2');
    return reverse ? { A: pair.second_id, B: pair.first_id } : { A: pair.first_id, B: pair.second_id };
  }
  function queue(reviewerId) {
    const groups = [...Map.groupBy(pairs, (p) => p.case_id)].sort((a, b) => randomOrder(`${reviewerId}:${a[0]}`).localeCompare(randomOrder(`${reviewerId}:${b[0]}`)));
    for (const [, group] of groups) group.sort((a, b) => randomOrder(`${reviewerId}:${a.id}`).localeCompare(randomOrder(`${reviewerId}:${b.id}`)));
    const result = [];
    for (let i = 0; groups.some(([, g]) => g.length > i); i++) for (const [, group] of groups) if (group[i]) result.push(group[i]);
    return result;
  }
  function progress(reviewerId) {
    assertActive(reviewerId);
    if(engine)return engine.progress(reviewerId);
    const r = db.prepare("SELECT COUNT(*) done, COALESCE(SUM(outcome!='unable'),0) voted, COALESCE(SUM(outcome='tie'),0) ties FROM ballots WHERE reviewer_id=?").get(reviewerId);
    return { total: pairs.length, done: r.done, voted: r.voted, ties:r.ties, skipped: r.done - r.voted, remaining: pairs.length - r.done };
  }
  function next(reviewerId) {
    assertActive(reviewerId);
    const assigned=engine?.current(reviewerId);
    const done = new Set(db.prepare('SELECT pair_id FROM ballots WHERE reviewer_id=?').all(reviewerId).map((r) => r.pair_id));
    const pair = engine ? assigned.pair : queue(reviewerId).find((p) => !done.has(p.id));
    const result = { progress: progress(reviewerId), pair: null, choices: snapshot.version===2?['A','B','tie','unable']:['A','B','unable'] };
    if(tournament)result.tournament={number:assigned.tournament.sequence+1,step:assigned.tournament.state.step,total_steps:5,
      blocked:assigned.tournament.blocked,unable_action:'skip-session'};
    if(incremental)result.sorting=assigned.tournament?publicSorting(incremental.getProgress(assigned.tournament.id,reviewerId))
      :{algorithm:INCREMENTAL_SORT,complete:assigned.complete,status:assigned.complete?'complete':'not-started'};
    if (!pair) return result;
    const display = sides(pair, reviewerId), first = candidates.get(pair.first_id);
    const views = new Set(db.prepare('SELECT candidate_id FROM views WHERE reviewer_id=? AND pair_id=?').all(reviewerId, pair.id).map((r) => r.candidate_id));
    const captured=snapshot.captured_delivery?.kind===CAPTURED_DELIVERY_KIND,publicRequirements=reviewerRequirements(requirements,pair.case_id);
    if(captured&&publicRequirements)publicRequirements.source_url=null;
    result.pair = { id: pair.id, case_id: pair.case_id, title: first.title,review_update:updateFor(pair.case_id),
      query:captured?first.source_query.replaceAll(first.source_url,'（见本页任务与规范）'):first.source_query,source_url:captured?null:first.source_url,
      requirements: publicRequirements,
      drafts: Object.fromEntries(Object.entries(display).map(([side, id]) => {
        const c = candidates.get(id);
        const anonymous=figmaLinks?.publicLink(id);
        return [side, { url: anonymous?.url||(reviewMode==='screenshots-only'?null:c.workspace_url),...(anonymous?{figma_alias:anonymous.figma_alias}:{}), seen: views.has(id), evidence_status: c.evidence_status,
          images: c.images.map((image, index) => media?media.image(reviewerId,id,index):({ url: `/api/review/image/${pair.id}/${side}/${index}`, index: index + 1, width: image.width, height: image.height })) }];
      })) };
    if(screenReview){
      result.pair.screen_comparison=screenReview.state(reviewerId,pair);
      result.pair.screen_marks=screenMarks.forPair(reviewerId,pair);
      if(result.pair.requirements)result.pair.requirements.required_frames=screenReview.requiredFrames(pair.case_id);
    }
    return result;
  }
  function seen(reviewerId, pairId, side, method) {
    assertActive(reviewerId);
    const pair = pairById.get(pairId);
    if (!pair || !['A', 'B'].includes(side)) fail(400, '无效比较');
    const current = engine?engine.current(reviewerId,false).pair:next(reviewerId).pair;
    if (!current || current.id !== pairId) fail(409, '这一组已提交，请刷新');
    const id = sides(pair, reviewerId)[side];
    if(reviewMode==='screenshots-only'&&method!=='gallery')fail(400,'本轮使用匿名截图评审');
    if (!['figma', 'gallery'].includes(method) || method === 'gallery' && candidates.get(id).evidence_status !== 'cached-complete') fail(400, '请打开完整03页面查看');
    db.prepare('INSERT OR IGNORE INTO views VALUES (?,?,?,?,?)').run(reviewerId, pairId, id, method, new Date().toISOString());
  }
  function vote(reviewerId, body) {
    assertActive(reviewerId);
    if (!body || !pairById.has(body.pair_id) || !(snapshot.version===2?['A','B','tie','unable']:['A','B','unable']).includes(body.choice)) fail(400, '无效投票');
    const comment = String(body.comment || '').trim();
    if (comment.length > 2000) fail(400, '备注最多2000字');
    const pair = pairById.get(body.pair_id), display = sides(pair, reviewerId);
    const reason = body.choice === 'unable' ? String(body.reason || '') : '';
    if (body.choice === 'unable' && !['access', 'incomplete-view', 'identity-leak', 'other'].includes(reason)) fail(400, '请选择无法比较的原因');
    const outcome=body.choice==='unable'?'unable':body.choice==='tie'?'tie':'win';
    const winner = outcome==='win'?display[body.choice]:null;
    db.exec('BEGIN IMMEDIATE');
    try {
      const prior = db.prepare('SELECT * FROM ballots WHERE reviewer_id=? AND pair_id=?').get(reviewerId, pair.id);
      if (prior) {
        if (prior.winner_id !== winner || ballotOutcome(prior)!==outcome || prior.reason !== reason || prior.comment !== comment
            || prior.requirements_hash !== (body.requirements_hash || null)) fail(409, '这一组已提交，不会重复计票');
        db.exec('COMMIT'); return { duplicate: true, progress: progress(reviewerId) };
      }
      const currentTournament=engine?.current(reviewerId,false);
      if ((engine?currentTournament.pair:next(reviewerId).pair)?.id !== pair.id) fail(409, '请按当前比较组提交');
      if ((body.requirements_hash || null) !== (requirements?.content_hash || null)) fail(409, '题目需求已更新，请刷新后阅读当前需求再提交');
      if (outcome!=='unable') {
        const count = db.prepare('SELECT COUNT(*) n FROM views WHERE reviewer_id=? AND pair_id=? AND candidate_id IN (?,?)').get(reviewerId, pair.id, display.A, display.B).n;
        if (count !== 2) fail(400, '请先确认完整查看A、B两份03产物');
        if(screenReview)screenReview.assertComplete(reviewerId,pair,body);
      }
      const at = new Date().toISOString();
      db.prepare('INSERT INTO ballots(reviewer_id,pair_id,winner_id,reason,comment,created_at,outcome,requirements_hash) VALUES (?,?,?,?,?,?,?,?)').run(reviewerId, pair.id, winner, reason, comment, at,outcome,requirements?.content_hash || null);
      if(incremental)incremental.record(reviewerId,{pair_id:pair.id,ballot_id:db.prepare('SELECT id FROM ballots WHERE reviewer_id=? AND pair_id=?').get(reviewerId,pair.id).id,winner_id:winner,outcome});
      db.prepare('INSERT INTO events(kind,reviewer_id,pair_id,body,created_at) VALUES (?,?,?,?,?)').run('ballot', reviewerId, pair.id, JSON.stringify({ winner_id: winner, side: body.choice, reason, comment, requirements_hash:requirements?.content_hash || null,
        ...(screenReview?{review_process:'pair-screens/v1',screen_plan_hash:body.screen_plan_hash||null,screen_votes_hash:body.screen_votes_hash||null}:{} ) }), at);
      if(tournament&&outcome==='unable')db.prepare('INSERT INTO events(kind,reviewer_id,pair_id,body,created_at) VALUES (?,?,?,?,?)')
        .run('tournament-skipped',reviewerId,pair.id,JSON.stringify({tournament_id:currentTournament.tournament.id,
          case_id:pair.case_id,step:currentTournament.tournament.state.step,reason,action:'next-task',prior_votes_retained:true}),at);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { duplicate: false, progress: progress(reviewerId) };
  }
  function retrySkipped(reviewerId) {
    assertActive(reviewerId);
    if(incremental)fail(409,'本轮保留问题投票，请通过排序复核继续，不删除真实记录');
    db.exec('BEGIN IMMEDIATE');
    try {
      const skipped = db.prepare("SELECT * FROM ballots WHERE reviewer_id=? AND outcome='unable'").all(reviewerId);
      for (const b of skipped) db.prepare('INSERT INTO events(kind,reviewer_id,pair_id,body,created_at) VALUES (?,?,?,?,?)').run('requeue-unable', reviewerId, b.pair_id, JSON.stringify(b), new Date().toISOString());
      db.prepare("DELETE FROM ballots WHERE reviewer_id=? AND outcome='unable'").run(reviewerId);
      db.exec('COMMIT');
      return { requeued: skipped.length };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  function publicSorting(p) {
    const alias=id=>`作品 ${String(p.models.findIndex(m=>m.model_id===id)+1).padStart(2,'0')}`;
    return {algorithm:p.algorithm,session_id:p.session_id,round:p.round,case_id:p.case_id,revision:p.revision,status:p.status,stage:p.stage,
      model_count:p.models.length,actual_votes:p.actual_votes,active_votes:p.active_votes,worst_case_votes:p.worst_case_votes,
      previous_completed_models:p.previous_completed_models,pending_added_models:p.pending_added_models,
      current_order:p.current_order.map(alias),ranking:p.ranking?.map(alias)||null,
      merge:p.merge?{left_cursor:p.merge.i,right_cursor:p.merge.j,output_count:p.merge.output.length,
        left_count:p.merge.left.length,right_count:p.merge.right.length}:null,
      issue:p.issue?{kind:p.status,cycle:p.issue.models?.map(alias)||null,vote_ids:p.issue.vote_ids}:null,
      votes:p.actual_vote_records.filter(v=>v.active).map(v=>({id:v.id,a:alias(v.a),b:alias(v.b),winner:v.winner?alias(v.winner):null,outcome:v.outcome}))};
  }
  function incrementalTaskStatistics() {
    const data=arenaTaskStatistics(snapshot.candidates,pairs,scopedBallots(),activeReviewers),sessions=incremental.exported();
    for(const task of data.tasks){
      const rows=sessions.filter(s=>s.case_id===task.case_id&&activeIds.has(s.reviewer_id));
      task.sorting=true;task.comparison_bound=rows[0]?.worst_case_votes||null;
      task.first_cycle_votes=rows.reduce((n,r)=>n+r.actual_votes,0);task.first_cycle_target=null;
      task.first_cycle_completed_reviewers=new Set(rows.filter(r=>r.status==='complete').map(r=>r.reviewer_id)).size;
      task.first_cycle_complete=activeReviewers.length>0&&task.first_cycle_completed_reviewers===activeReviewers.length;
      task.completed_sessions=rows.filter(r=>r.status==='complete').length;task.assigned_sessions=rows.length;
      task.status=task.first_cycle_complete?'first-cycle-complete':rows.some(s=>s.status.startsWith('paused-'))?'paused':rows.length?'in-progress':'not-started';
      for(const r of task.reviewers){const own=rows.filter(s=>s.reviewer_id===r.reviewer_id),row=own.at(-1);r.first_cycle_votes=own.reduce((n,s)=>n+s.actual_votes,0);r.first_cycle_complete=own.some(s=>s.status==='complete');r.sorting_status=row?.status||'not-started';}
    }
    data.method=INCREMENTAL_SORT;data.summary.first_cycle_votes=data.tasks.reduce((n,t)=>n+t.first_cycle_votes,0);
    data.summary.first_cycle_target=null;data.summary.first_cycle_completed_tasks=data.tasks.filter(t=>t.first_cycle_complete).length;
    data.rules.first_cycle='Each reviewer completes a full per-task order. Actual vote counts are adaptive; no fixed five-vote denominator.';
    return data;
  }
  function dashboard() {
    const ballots = scopedBallots();
    const ranking = incremental?{method:INCREMENTAL_SORT,rows:[],orders:incremental.exported().filter(r=>activeIds.has(r.reviewer_id)),
      explanation:'仅输出同题、同一评审会话内的相对顺序；真实票与传递关系分开，不计算BT或Rating。'}:tournament?bradleyTerryRankings(snapshot.candidates,pairs,ballots):snapshot.version===2?pairwiseRankings(snapshot.candidates,pairs,ballots):arenaRankings(snapshot.candidates, pairs, ballots);
    const counts = Map.groupBy(snapshot.candidates, (c) => c.case_id);
    const reports = ballots.filter((b) => !validBallot(b)).map((b) => ({ reviewer: activeReviewers.find((r) => r.id === b.reviewer_id).label,
      case_id: pairById.get(b.pair_id).case_id, reason: b.reason, comment: b.comment, at: b.created_at }));
    return { snapshot: { name: snapshot.name, frozen_at: snapshot.created_at, source_at: snapshot.source_at,
      hash: digest, candidates: candidates.size, cases: counts.size, models: new Set(snapshot.candidates.map(c=>c.model_id)).size,
      recovered: snapshot.candidates.filter((c) => c.recovered).length,
      recovered_evidence_pending: snapshot.candidates.filter((c) => c.recovered && c.evidence_status !== 'cached-complete').length,
      live_view_required: snapshot.candidates.filter((c) => c.evidence_status !== 'cached-complete').length,
      pairs: pairs.length, target_votes: engine?null:pairs.length * activeReviewers.length,protocol:incremental?INCREMENTAL_SORT:snapshot.protocol?.kind||'legacy-all-pairs/v1',reviewer_count:activeReviewers.length },
      reviewer_policy:reviewerPolicy,
      sorting:incremental?{algorithm:INCREMENTAL_SORT,sessions:ranking.orders,actual_votes:ranking.orders.reduce((n,r)=>n+r.actual_votes,0),
        legacy_ballots_retained:db.prepare('SELECT COUNT(*) n FROM ballots').get().n-db.prepare('SELECT COUNT(*) n FROM incremental_sort_votes').get().n}:null,
      external_delivery:snapshot.external_delivery||null,review_mode:reviewMode,frozen_review_mode:snapshot.review_mode||'figma-and-screenshots',
      screen_comparison:screenReview?{kind:'figma-arena-pair-screens/v1',catalog_hash:screenReview.catalog.content_hash,
        selection:screenReview.selectionSummary(),
        saved_screens:db.prepare('SELECT reviewer_id FROM pair_screen_votes').all().filter(r=>activeIds.has(r.reviewer_id)).length,
        started_comparisons:db.prepare('SELECT reviewer_id FROM pair_screen_plans').all().filter(r=>activeIds.has(r.reviewer_id)).length,
        note:incremental?'逐屏记录独立保存；只有真实整体投票进入排序证据，传递关系不计票。历史记录保留。':'逐屏记录独立保存；仅明确提交的整题选择进入BT和CC一致率。历史整体票保留，不伪造逐屏记录。'}:null,
      sampling:!incremental&&samplingPolicy?{policy:samplingPolicy,assigned_counts:Object.fromEntries([...Map.groupBy(tournament.exported().filter(t=>activeIds.has(t.reviewer_id)),t=>t.sampling)].map(([key,rows])=>[key,rows.length]))}:null,
      open_registration:accounts.openRegistration,
      task_statistics:incremental?incrementalTaskStatistics():arenaTaskStatistics(snapshot.candidates,pairs,ballots,activeReviewers,tournament?.exported().filter(t=>activeIds.has(t.reviewer_id))??null),
      reviewers: activeReviewers.map((r) => ({ id: r.id, label: r.label, ...progress(r.id), ...(r.access?{invite:`/#invite=${r.access}`}:{}) })),
      valid_votes: ballots.filter(validBallot).length, ties:ballots.filter(b=>ballotOutcome(b)==='tie').length, unable: reports.length, ranking, reports,
      tournaments: tournament ? tournament.exported().filter(t=>activeIds.has(t.reviewer_id)).map(t=>({id:t.id,reviewer_id:t.reviewer_id,case_id:t.case_id,sequence:t.sequence,complete:t.complete,skipped:t.skipped,blocked:t.blocked,battles:t.battles.length})) : null,
      v4_comparison: snapshot.version>=2?arenaV4Comparison(snapshot.candidates,pairs,ballots).summary:null,
      daily_statistics: snapshot.version>=2?{models:new Set(snapshot.candidates.map(c=>c.model_id)).size,tasks:counts.size,
        generated:snapshot.source_counts?.inference_ended??snapshot.candidates.length,qualified:snapshot.candidates.length,
        v4_scored:snapshot.candidates.filter(c=>c.cc_score!==null).length,pairs:pairs.length,valid_votes:ballots.filter(validBallot).length}:null,
      coverage: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([id, drafts]) => ({ case_id: id, title: drafts[0].title,
        candidates: drafts.length, models: drafts.map((c) => c.model_name), pairs: pairs.filter((p) => p.case_id === id).length,
        votes: ballots.filter((b) => validBallot(b) && pairById.get(b.pair_id).case_id === id).length })),
      requirements: requirements ? { language:requirements.language, cases:requirements.cases.length, version:requirements.content_hash } : null,
      updated_at: new Date().toISOString() };
  }
  return { db, directory, snapshot, digest, reviewMode, credentials, activeReviewers, reviewerPolicy, samplingPolicy, accounts, refreshReviewers, isActiveReviewer:id=>activeIds.has(id), scopedBallots, candidates, pairs, pairById, sides, next, seen, vote, retrySkipped, progress, dashboard, requirements, tournament, incremental, media, screenReview, screenMarks, figmaLinks, publicSorting,updateFor,
    close() { db.close(); } };
}

export function createArenaApp(store, { staticDirectory, secureCookies = false, basePath = '', scoresDirectory = null, publicAdmin = false, reviewerSelection = false, judgeScoresDirectory = null, identitySourceStore = null, identityCookiePath = null, cohorts = [],cohortProgress = null } = {}) {
  if (basePath && !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(basePath)) throw new Error('Invalid arena base path');
  const app = express();
  const selectionEnabled = reviewerSelection === true;
  const cookiePath = identityCookiePath||`${basePath}/`;
  if(!cookiePath.startsWith('/')||!cookiePath.endsWith('/')||!`${basePath}/`.startsWith(cookiePath))throw Error('Invalid shared identity cookie scope');
  const identityStore=identitySourceStore||store,sessionDb=identityStore.db;
  const syncIdentities=()=>synchronizeArenaIdentities(identitySourceStore,store);
  syncIdentities();
  const leaderboard=options=>scoresDirectory?readCCLeaderboard(scoresDirectory,options):frozenDeliveryLeaderboard(store.snapshot,options);
  const judgeScoreData=options=>withHumanJudgeAgreement(readArenaJudgeScores(store.directory,judgeScoresDirectory),store,options);
  const dashboard = (req) => {
    const value = store.dashboard();
    const audit = readArenaDeliveryAudit(store);
    let ccLeaderboard = null, ccLeaderboardError = null;
    if (scoresDirectory||store.snapshot.external_delivery) {
      try { ccLeaderboard = leaderboard({ includeCoverage: true }); }
      catch { ccLeaderboardError = '暂时无法读取CC评分排名，请稍后刷新'; }
    }
    let judgeScores = null, judgeScoresError = null;
    if (judgeScoresDirectory) {
      try { judgeScores = judgeScoreData(); }
      catch { judgeScoresError = '暂时无法读取多模型评分，请稍后刷新'; }
    }
    return { ...value, cc_leaderboard: ccLeaderboard, cc_leaderboard_error: ccLeaderboardError,
      ...(judgeScoresDirectory ? {judge_scores:judgeScores,judge_scores_error:judgeScoresError} : {}),
      delivery_audit: audit ? { created_at: audit.created_at, counts: audit.counts } : null,
      reviewers: value.reviewers.map(({invite,...r}) => ({ ...r,
        ...(invite&&session(req)?.role==='admin'?{invite:`${basePath}${invite}`}:{}) })) };
  };
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; frame-src https://www.figma.com https://embed.figma.com; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.get('sec-fetch-site') === 'cross-site' || req.get('origin') && new URL(req.get('origin')).host !== req.get('host')) return res.status(403).json({ error: '请从本服务页面提交' });
    }
    next();
  });
  app.use(express.json({ limit: '12kb' }));
  app.use('/api',(req,res,next)=>{try{syncIdentities();next();}catch(error){next(error);}});
  const session = (req) => {
    const value = req.headers.cookie?.split(';').map((v) => v.trim()).find((v) => v.startsWith('arena_session='))?.slice(14);
    const s=value ? sessionDb.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(value), Date.now()) : null;
    return s?.role==='reviewer'&&!store.isActiveReviewer(s.reviewer_id)?null:s;
  };
  const requireRole = (role) => (req, res, next) => { req.arenaSession = session(req);
    if (!req.arenaSession || req.arenaSession.role !== role) return res.status(403).json({ error: '请使用对应的评审或管理链接进入' }); next(); };
  const requireAdminRead = (req,res,next) => publicAdmin ? next() : requireRole('admin')(req,res,next);
  app.get(['/api/admin/judge-scores','/api/admin/judge-scores.csv','/api/admin/judge-pairs.csv','/api/admin/judge-agreement.csv'],requireAdminRead,(req,res)=>{
    if(!judgeScoresDirectory)return res.status(404).json({error:'本轮未配置多模型评分'});
    try{
      const data=judgeScoreData({includeComparisons:req.path.endsWith('/judge-agreement.csv')});
      if(req.path.endsWith('/judge-pairs.csv'))return res.type('text/csv; charset=utf-8').attachment('arena-judge-pairs.csv')
        .send(arenaCsv(['case_id','first_model','second_model','first_candidate','second_candidate','first_run_id','second_run_id',
          ...data.judges.flatMap(j=>[j.id+'_first_score',j.id+'_second_score',j.id+'_outcome'])],judgePairCsvRows(data)));
      if(req.path.endsWith('/judge-agreement.csv'))return res.type('text/csv; charset=utf-8').attachment('arena-human-judge-agreement.csv')
        .send(arenaCsv(['ballot_id','reviewer_id','case_id','first_model','second_model','first_candidate','second_candidate','first_run_id','second_run_id','human_outcome',
          ...data.judges.flatMap(j=>[j.id+'_outcome',j.id+'_agrees'])],data.human_comparisons));
      if(req.path.endsWith('.csv'))return res.type('text/csv; charset=utf-8').attachment('arena-judge-scores.csv')
        .send(arenaCsv(['case_id','title','model_id','model_name','run_id',...data.judges.map(j=>j.id)],judgeScoreCsvRows(data)));
      res.json(data);
    }catch{res.status(503).json({error:'暂时无法读取多模型评分，请稍后刷新'});}
  });
  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'figma-human-arena', candidates: store.candidates.size, pairs: store.pairs.length }));
  app.get('/api/leaderboard', (req, res) => {
    if (!scoresDirectory&&!store.snapshot.external_delivery) return res.status(503).json({ error: '评分排名尚未配置' });
    try { res.json(leaderboard()); }
    catch { res.status(503).json({ error: '暂时无法读取评分排名，请稍后刷新' }); }
  });
  app.get('/api/session', (req, res) => {
    const s = session(req);
    res.json({role:s?.role??null,public_admin:publicAdmin,open_registration:store.accounts.openRegistration,
      screen_marking:!!store.screenMarks,
      ...(selectionEnabled?{reviewer_selection:true}:{}),
      sorting_algorithm:store.incremental?.algorithm||null,
      ...(s?{label:s.role==='admin'?'管理员':store.activeReviewers.find(r=>r.id===s.reviewer_id).label,
        profile_registered:s.role==='reviewer'&&store.accounts.registered(s.reviewer_id),
        summary:{candidates:store.candidates.size,cases:new Set(store.snapshot.candidates.map(c=>c.case_id)).size,pairs:store.pairs.length}}:{})});
  });
  const attempts = new Map();
  const limitLogin=(req,res,next)=>{
    const ip = req.socket.remoteAddress || '';
    let a = attempts.get(ip);
    if (!a || Date.now() - a.at > 60000) { a = { at: Date.now(), n: 0 }; attempts.set(ip, a); }
    if (++a.n > 30) return res.status(429).json({ error: '请稍后重试' });
    if (attempts.size > 10000) for (const [key, value] of attempts) if (Date.now() - value.at > 60000) attempts.delete(key);
    next();
  };
  function establishSession(req,res,role,reviewerId){
    const old=session(req);if(old)sessionDb.prepare('DELETE FROM sessions WHERE token_hash=?').run(old.token_hash);
    sessionDb.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
    const value=token();
    sessionDb.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(hash(value),role,reviewerId,Date.now()+90*86400000);
    res.cookie('arena_session',value,{httpOnly:true,sameSite:'strict',secure:secureCookies,maxAge:90*86400000,path:cookiePath});
  }
  const requireReviewerSelection = (req,res,next) => selectionEnabled ? next() : res.status(404).json({error:'本服务未开启已有身份选择'});
  function selectableReviewers() {
    store.refreshReviewers();
    const disabled = new Set(store.db.prepare('SELECT reviewer_id FROM reviewer_accounts WHERE enabled=0').all().map(r=>r.reviewer_id));
    return store.activeReviewers.filter(r=>!disabled.has(r.id));
  }
  app.get('/api/reviewers/existing',requireReviewerSelection,(req,res)=>{
    res.json({reviewers:selectableReviewers().map(({id,label})=>{
      const p=store.progress(id),progress={};
      for(const key of ['completed_tasks','tasks_per_cycle','completed_rounds','completed_sessions','actual_votes','voted','done','total','blocked','started_tasks','previously_completed_tasks','completed_any_stage_tasks','pending_extension_tasks'])
        if(p[key]!==undefined)progress[key]=p[key];
      return{id,label,progress};
    })});
  });
  app.post('/api/reviewers/select-existing',requireReviewerSelection,limitLogin,(req,res)=>{
    const id=req.body?.reviewer_id;
    if(typeof id!=='string'||!id||id.length>128)return res.status(400).json({error:'请选择已有评审身份'});
    const reviewer=selectableReviewers().find(r=>r.id===id);
    if(!reviewer)return res.status(403).json({error:'该评审身份不可用，请刷新后重新选择'});
    establishSession(req,res,'reviewer',reviewer.id);
    res.json({ok:true,reviewer_id:reviewer.id,label:reviewer.label});
  });
  app.post('/api/reviewers/enroll',limitLogin,(req,res)=>{
    const current=session(req),reviewer=identityStore.accounts.enroll(req.body,current?.role==='reviewer'?current.reviewer_id:null);
    identityStore.refreshReviewers();syncIdentities();store.refreshReviewers();establishSession(req,res,'reviewer',reviewer.id);
    res.json({ok:true,label:reviewer.label});
  });
  app.post('/api/session',limitLogin, (req, res) => {
    const input = req.body?.access;
    const admin = same(input, store.credentials.admin), reviewer = store.activeReviewers.find((r) => same(input, r.access));
    if (!admin && !reviewer) return res.status(403).json({ error: '链接无效，请向组织者索取评审链接' });
    establishSession(req,res,admin?'admin':'reviewer',admin?null:reviewer.id);
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => { const s = session(req); if (s) sessionDb.prepare('DELETE FROM sessions WHERE token_hash=?').run(s.token_hash);
    res.clearCookie('arena_session', { path: cookiePath }); res.json({ ok: true }); });
  app.get('/api/review/next', requireRole('reviewer'), (req, res) => res.json(store.next(req.arenaSession.reviewer_id)));
  app.get('/api/review/figma/:token',requireRole('reviewer'),(req,res)=>{
    try{
      if(!store.figmaLinks)return res.sendStatus(404);
      const {candidate}=store.figmaLinks.resolve(req.params.token);
      let index;if(req.query.screen!==undefined){if(!/^\d+$/.test(String(req.query.screen)))return res.sendStatus(404);index=Number(req.query.screen);}
      res.set({'Referrer-Policy':'no-referrer','Cache-Control':'no-store'}).redirect(302,canonicalFigmaUrl(candidate,index));
    }catch{return res.sendStatus(404);}
  });
  app.post('/api/review/seen', requireRole('reviewer'), (req, res) => { store.seen(req.arenaSession.reviewer_id, req.body?.pair_id, req.body?.side, req.body?.method); res.json({ ok: true }); });
  app.post('/api/review/vote', requireRole('reviewer'), (req, res) => res.json(store.vote(req.arenaSession.reviewer_id, req.body)));
  const requireSorting=(req,res,next)=>store.incremental?next():res.status(404).json({error:'本轮未启用增量排序'});
  app.get('/api/review/tasks',requireRole('reviewer'),requireSorting,(req,res)=>{
    const data=store.incremental.listTasks(req.arenaSession.reviewer_id,new Set(store.activeReviewers.map(r=>r.id)));
    res.json({...data,tasks:data.tasks.map(t=>({...t,review_update:store.updateFor(t.case_id)}))});
  });
  app.post('/api/review/tasks/select',requireRole('reviewer'),requireSorting,(req,res)=>{
    store.incremental.selectTask(req.arenaSession.reviewer_id,req.body);res.json({ok:true});
  });
  app.get('/api/review/preload',requireRole('reviewer'),requireSorting,(req,res)=>res.json(store.media.preload(req.arenaSession.reviewer_id,req.query.case_id)));
  app.get('/api/review/cache-manifest',requireRole('reviewer'),requireSorting,(req,res)=>res.json(store.media.cacheManifest(req.arenaSession.reviewer_id)));
  app.get('/api/review/media/:key',requireRole('reviewer'),requireSorting,(req,res)=>{
    const item=store.media.download(req.arenaSession.reviewer_id,req.params.key,req.query.display);
    res.set({'Cache-Control':'private, max-age=604800, immutable',ETag:`"${item.sha256}"`});
    if(req.get('if-none-match')?.split(/\s*,\s*/).includes(`"${item.sha256}"`))return res.status(304).end();
    res.type(item.contentType).sendFile(item.file,{cacheControl:false,lastModified:false});
  });
  app.post('/api/review/screen-viewed',requireRole('reviewer'),requireSorting,(req,res)=>{
    if(!store.screenReview)return res.status(404).json({error:'未启用逐屏查看'});
    const reviewer=req.arenaSession.reviewer_id,body=req.body||{},pair=store.incremental.current(reviewer,false).pair;
    if(!pair||pair.id!==body.pair_id)return res.status(409).json({error:'当前比较已更新，请返回题目列表继续'});
    const state=store.screenReview.state(reviewer,pair),row=state.rows.find(r=>r.id===body.slot_id),display=store.sides(pair,reviewer);
    if(!row||state.plan_hash!==body.plan_hash||!Array.isArray(body.images)||body.images.length>2)return res.status(409).json({error:'画板对应已更新，请刷新'});
    for(const im of body.images){
      if(!['A','B'].includes(im.side)||!Number.isSafeInteger(im.index)||row[im.side]!==im.index)return res.status(400).json({error:'图片与当前屏不符'});
      store.media.assertDownloaded(reviewer,display[im.side],im.index,im.media_key);
    }
    for(const im of body.images)store.screenReview.opened(reviewer,pair.id,im.side,im.index);
    res.json({ok:true});
  });
  app.get('/api/review/sort/next',requireRole('reviewer'),requireSorting,(req,res)=>res.json(store.next(req.arenaSession.reviewer_id)));
  app.post('/api/review/sort/winner',requireRole('reviewer'),requireSorting,(req,res)=>res.json(store.vote(req.arenaSession.reviewer_id,req.body)));
  app.get('/api/review/sort/progress',requireRole('reviewer'),requireSorting,(req,res)=>{
    const current=store.incremental.current(req.arenaSession.reviewer_id,false),id=req.query.session_id||current.tournament?.id;
    res.json(id?store.publicSorting(store.incremental.getProgress(id,req.arenaSession.reviewer_id))
      :{algorithm:INCREMENTAL_SORT,status:current.complete?'complete':'not-started',complete:current.complete,progress:store.progress(req.arenaSession.reviewer_id)});
  });
  app.get('/api/review/sort/ranking',requireRole('reviewer'),requireSorting,(req,res)=>{
    if(typeof req.query.session_id!=='string')return res.status(400).json({error:'请指定排序会话'});
    const p=store.publicSorting(store.incremental.getProgress(req.query.session_id,req.arenaSession.reviewer_id));
    res.json({session_id:p.session_id,status:p.status,ranking:p.ranking,actual_votes:p.actual_votes});
  });
  app.post('/api/review/sort/review',requireRole('reviewer'),requireSorting,(req,res)=>
    res.json(store.publicSorting(store.incremental.review(req.arenaSession.reviewer_id,req.body))));
  app.post('/api/review/screen-vote',requireRole('reviewer'),(req,res)=>{
    if(!store.screenReview)return res.status(404).json({error:'本轮未启用逐屏比较'});
    res.json(store.screenReview.save(req.arenaSession.reviewer_id,req.body));
  });
  app.post('/api/review/screen-align',requireRole('reviewer'),(req,res)=>{
    if(!store.screenReview)return res.status(404).json({error:'本轮未启用逐屏比较'});
    res.json(store.screenReview.align(req.arenaSession.reviewer_id,req.body));
  });
  app.post('/api/review/screen-mark',requireRole('reviewer'),(req,res)=>{
    if(!store.screenMarks)return res.status(404).json({error:'本轮未启用屏幕案例标记'});
    res.json(store.screenMarks.save(req.arenaSession.reviewer_id,req.body));
  });
  app.post('/api/review/retry-unable', requireRole('reviewer'), (req, res) => res.json(store.retrySkipped(req.arenaSession.reviewer_id)));
  app.get('/api/review/image/:pair/:side/:index', requireRole('reviewer'), (req, res) => {
    const pair = store.pairById.get(req.params.pair);
    const side = req.params.side, index = Number(req.params.index);
    if (!pair || !['A', 'B'].includes(side) || !/^\d+$/.test(req.params.index)) return res.sendStatus(404);
    if (store.next(req.arenaSession.reviewer_id).pair?.id !== pair.id) return res.sendStatus(404);
    const c = store.candidates.get(store.sides(pair, req.arenaSession.reviewer_id)[side]), image = c.images[index];
    if (!image || !Number.isSafeInteger(index)) return res.sendStatus(404);
    const file = path.resolve(store.directory, image.file);
    if (fs.realpathSync(file) !== file || hash(fs.readFileSync(file)) !== image.sha256) return res.status(409).json({ error: '截图证据已变化，请使用完整Figma页面并反馈组织者' });
    store.screenReview?.opened(req.arenaSession.reviewer_id,pair.id,side,index);
    res.type('png').sendFile(file);
  });
  app.get('/api/admin/dashboard', requireAdminRead, (req, res) => res.json(dashboard(req)));
  app.get('/api/admin/cohort-progress',requireAdminRead,(req,res)=>res.json({cohorts:cohortProgress?cohortProgress():[{
    label:store.snapshot.name,version:'current',model_count:new Set(store.snapshot.candidates.map(c=>c.model_id)).size,
    review_href:basePath+'/?view=review',admin_href:basePath+'/?view=admin',
    reviewers:store.activeReviewers.map(r=>({id:r.id,label:r.label,...store.progress(r.id)}))
  }]}));
  app.get('/api/admin/revision-history',requireAdminRead,(req,res)=>{
    const file=path.join(store.directory,'revision-history.json');
    if(!fs.existsSync(file))return res.json({revisions:[]});
    const history=JSON.parse(fs.readFileSync(file));
    if(history.snapshot_hash!==store.digest)return res.status(409).json({error:'换稿历史版本不匹配'});
    res.json(history);
  });
  app.get('/api/admin/sorting',requireAdminRead,requireSorting,(req,res)=>res.json({algorithm:INCREMENTAL_SORT,sessions:store.incremental.exported()}));
  app.get(['/api/admin/screen-marks','/api/admin/screen-marks.csv'],requireAdminRead,(req,res)=>{
    if(!store.screenMarks)return res.status(404).json({error:'本轮未启用屏幕案例标记'});
    const records=store.screenMarks.exported();
    if(req.path.endsWith('.csv'))return res.attachment('arena-screen-cases.csv').type('text/csv; charset=utf-8').send(screenMarksCsv(records));
    res.json({scope:'screen',snapshot_hash:store.digest,records});
  });
  app.get('/api/admin/screen-marks/image/:candidate/:index',requireAdminRead,(req,res)=>{
    if(!store.screenMarks||!/^\d+$/.test(req.params.index))return res.sendStatus(404);
    res.type('png').sendFile(store.screenMarks.image(req.params.candidate,Number(req.params.index)));
  });
  app.get('/api/admin/delivery-audit', requireAdminRead, (req, res) => {
    const audit = readArenaDeliveryAudit(store);
    if (!audit) return res.status(404).json({ error: '尚无交付核查记录' });
    res.attachment('arena-delivery-audit.json').json(audit);
  });
  app.get('/api/admin/export', requireAdminRead, (req, res) => {
    const votes = store.db.prepare('SELECT * FROM ballots ORDER BY id').all();
    const detailed = votes.map((v) => {
      const pair = store.pairById.get(v.pair_id), a = store.candidates.get(pair.first_id), b = store.candidates.get(pair.second_id);
      return { ...v, included_in_current_ranking:store.isActiveReviewer(v.reviewer_id)&&(!store.incremental||store.incremental.effectiveBallotIds().has(v.id)), case_id: pair.case_id, candidates: [a, b].map((c) => ({ id: c.id, model_id: c.model_id, model_name: c.model_name, run_id: c.run_id, url: c.workspace_url })),
        winner_model_id: v.winner_id ? store.candidates.get(v.winner_id).model_id : null };
    });
    res.attachment(`arena-votes-${new Date().toISOString().slice(0, 10)}.json`).json({ snapshot_hash: store.digest, snapshot: store.snapshot, requirements:store.requirements,reviewer_policy:store.reviewerPolicy,sampling_policy:store.samplingPolicy,
      votes: detailed, events: store.db.prepare('SELECT * FROM events ORDER BY id').all(),
      views: store.db.prepare('SELECT * FROM views ORDER BY created_at').all(), dashboard: dashboard(req),
      screen_comparisons:store.screenReview?.exported()||null,
      screen_case_marks:store.screenMarks?{scope:'screen',records:store.screenMarks.exported()}:null,
      incremental_sorting:store.incremental?.exported()||null,
      tournaments:store.tournament?.exported()||null,
      human_v4:store.snapshot.version>=2?arenaV4Comparison(store.snapshot.candidates,store.pairs,store.scopedBallots()):null });
  });
  app.get('/api/admin/export.csv',requireAdminRead,(req,res)=>{
    const votes=store.scopedBallots(),comparison=arenaV4Comparison(store.snapshot.candidates,store.pairs,votes);
    const columns=['pair_id','case_id','reviewer_id','human_preference','first_model','first_run_id','first_url','first_v4','second_model','second_run_id','second_url','second_v4','v4_preference','comparable','agreement','reason','comment','created_at','requirements_hash'];
    const csv=v=>{let text=v===null||v===undefined?'':String(v);if(typeof v==='string'&&/^[=+\-@]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
    res.attachment('arena-human-v4.csv').type('text/csv; charset=utf-8').send('\uFEFF'+[columns,...comparison.rows.map(r=>columns.map(c=>r[c]))].map(row=>row.map(csv).join(',')).join('\r\n'));
  });
  app.get('/api/admin/tasks.csv',requireAdminRead,(req,res)=>{
    res.attachment('arena-per-task.csv').type('text/csv; charset=utf-8')
      .send(arenaCsv(taskCsvColumns,store.dashboard().task_statistics.tasks));
  });
  app.get('/api/admin/screens.csv',requireAdminRead,(req,res)=>{
    if(!store.screenReview)return res.status(404).json({error:'本轮未启用逐屏比较'});
    const data=store.screenReview.exported(),rows=data.votes.filter(v=>store.isActiveReviewer(v.reviewer_id)).map(v=>{
      const pair=store.pairById.get(v.pair_id),plan=data.plans.find(p=>p.reviewer_id===v.reviewer_id&&p.pair_id===v.pair_id),slot=plan.rows.find(r=>r.id===v.slot_id),display=store.sides(pair,v.reviewer_id);
      const a=store.candidates.get(display.A),b=store.candidates.get(display.B);
      return{...v,case_id:pair.case_id,screen_name:slot.name,A_model:a.model_name,A_run:a.run_id,A_image:slot.A,B_model:b.model_name,B_run:b.run_id,B_image:slot.B,
        overall_submitted:!!store.db.prepare('SELECT 1 FROM ballots WHERE reviewer_id=? AND pair_id=?').get(v.reviewer_id,v.pair_id)};
    });
    res.attachment('arena-screen-comparisons.csv').type('text/csv; charset=utf-8').send(arenaCsv(
      ['case_id','reviewer_id','pair_id','slot_id','screen_name','A_model','A_run','A_image','B_model','B_run','B_image','choice','comment','revision','overall_submitted','evidence_hash','updated_at'],rows));
  });
  if (staticDirectory) {
    const htmlEscape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    if(cohorts.some(c=>typeof c.label!=='string'||!/^\/[A-Za-z0-9_/?=&.-]+$/.test(c.href)))throw Error('Invalid review cohort navigation');
    const navigation=cohorts.length?`<nav class="cohort-navigation" aria-label="评审批次">${cohorts.map(c=>`<a href="${htmlEscape(c.href)}"${c.current?' aria-current="page"':''}>${htmlEscape(c.label)}</a>`).join('')}</nav>`:'';
    app.get(['/', '/index.html'], (req, res) => res.type('html').send(fs.readFileSync(path.join(staticDirectory, 'index.html'), 'utf8')
      .replace('<meta name="arena-base" content="">', `<meta name="arena-base" content="${basePath}">`)
      .replace('<main id="app">',navigation+'<main id="app">')));
    app.use(express.static(staticDirectory, { index: false, etag: false, lastModified: false }));
  }
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use((error, req, res, next) => { if (res.headersSent) return next(error);
    res.status(error.status || 500).json({ error: error.status ? error.message : '服务暂时出错，请刷新重试；投票不会重复计入' }); });
  if (!basePath) return app;
  const mounted = express();
  mounted.disable('x-powered-by');
  mounted.get('/api/health', (req, res) => res.json({ ok: true, service: 'figma-human-arena', candidates: store.candidates.size, pairs: store.pairs.length }));
  mounted.use((req, res, next) => {
    if (req.path === '/' || req.path === basePath) return res.redirect(308, `${basePath}/`);
    next();
  });
  mounted.use(basePath, app);
  return mounted;
}
