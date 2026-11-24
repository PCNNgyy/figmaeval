import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createArenaStore, createArenaApp } from '../server/benchmark_arena.mjs';

const opts = {};
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i].replace(/^--/, '');
  if (['background', 'status'].includes(flag)) opts[flag] = true;
  else { if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`Missing --${flag}`); opts[flag] = process.argv[++i]; }
}
if (!opts.directory) throw new Error('Use --directory <frozen arena directory> [--port 18186] [--background]');
const directory = path.resolve(opts.directory), script = fileURLToPath(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const pidFile = path.join(directory, 'service.pid');
const running = () => {
  if (!fs.existsSync(pidFile)) return null;
  const pid = Number(fs.readFileSync(pidFile));
  if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid service PID');
  try {
    process.kill(pid, 0);
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    if (!args.includes(script) || !args.includes(directory)) throw new Error('PID belongs to another process');
    return pid;
  } catch (e) { if (['ENOENT', 'ESRCH'].includes(e.code)) return null; throw e; }
};
if (opts.status) {
  console.log(JSON.stringify({ pid: running(), ...(fs.existsSync(path.join(directory, 'service.json')) ? JSON.parse(fs.readFileSync(path.join(directory, 'service.json'))) : {}) }));
} else if (opts.background) {
  const pid = running();
  if (pid) { console.log(JSON.stringify({ pid, already_running: true })); process.exit(0); }
  const log = fs.openSync(path.join(directory, 'service.log'), 'a', 0o600);
  const args = process.argv.slice(2).filter((v) => v !== '--background');
  const at = args.indexOf('--directory'); args[at + 1] = directory;
  const child = spawn(process.execPath, [script, ...args], { cwd: root, detached: true, stdio: ['ignore', log, log] });
  child.unref(); fs.closeSync(log);
  console.log(JSON.stringify({ pid: child.pid, log: path.join(directory, 'service.log') }));
} else {
  if (running()) throw new Error('Arena already running');
  const snapshot = JSON.parse(fs.readFileSync(path.join(directory, 'snapshot.json')));
  const port = Number(opts.port || 18186), host = opts.host || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const previous = fs.existsSync(path.join(directory, 'service.json')) ? JSON.parse(fs.readFileSync(path.join(directory, 'service.json'))) : {};
  if(opts['open-registration']!==undefined&&!['true','false'].includes(opts['open-registration']))throw Error('Use --open-registration true or false');
  const openRegistration=opts['open-registration']===undefined?previous.open_registration===true:opts['open-registration']==='true';
  if(opts['show-figma-links']!==undefined&&!['true','false'].includes(opts['show-figma-links']))throw Error('Use --show-figma-links true or false');
  const showFigmaLinks=opts['show-figma-links']===undefined?previous.show_figma_links===true:opts['show-figma-links']==='true';
  if(opts['screen-comparisons']!==undefined&&!['true','false'].includes(opts['screen-comparisons']))throw Error('Use --screen-comparisons true or false');
  const screenComparisons=opts['screen-comparisons']===undefined?previous.screen_comparisons===true:opts['screen-comparisons']==='true';
  if(opts['incremental-ranking']!==undefined&&!['true','false'].includes(opts['incremental-ranking']))throw Error('Use --incremental-ranking true or false');
  const incrementalRanking=opts['incremental-ranking']===undefined?previous.incremental_ranking===true:opts['incremental-ranking']==='true';
  const store = createArenaStore(directory, snapshot, {openRegistration,showFigmaLinks,screenComparisons,incrementalRanking});
  const basePath = opts['base-path'] ?? previous.base_path ?? '';
  const scoresDirectory = opts['scores-directory'] ? path.resolve(opts['scores-directory']) : previous.scores_directory || null;
  if(opts['public-admin']!==undefined&&!['true','false'].includes(opts['public-admin']))throw Error('Use --public-admin true or false');
  const publicAdmin=opts['public-admin']===undefined?previous.public_admin===true:opts['public-admin']==='true';
  if(opts['reviewer-selection']!==undefined&&!['true','false'].includes(opts['reviewer-selection']))throw Error('Use --reviewer-selection true or false');
  const reviewerSelection=opts['reviewer-selection']===undefined?previous.reviewer_selection===true:opts['reviewer-selection']==='true';
  const judgeScoresDirectory = opts['judge-scores-directory'] ? path.resolve(opts['judge-scores-directory']) : previous.judge_scores_directory || null;
  const app = createArenaApp(store, { staticDirectory: path.join(root, 'arena'), secureCookies: opts['secure-cookies'] === 'true', basePath, scoresDirectory, publicAdmin, reviewerSelection, judgeScoresDirectory });
  const server = app.listen(port, host, () => {
    fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
    const startedAt=new Date().toISOString();
    if(showFigmaLinks!==(previous.show_figma_links===true))store.db.prepare('INSERT INTO events(kind,body,created_at) VALUES (?,?,?)')
      .run('review-presentation-updated',JSON.stringify({snapshot_hash:store.digest,show_figma_links:showFigmaLinks,
        previous_show_figma_links:previous.show_figma_links===true,review_mode:store.reviewMode,
        existing_votes:store.db.prepare('SELECT COUNT(*) n FROM ballots').get().n}),startedAt);
    if(screenComparisons!==(previous.screen_comparisons===true))store.db.prepare('INSERT INTO events(kind,body,created_at) VALUES (?,?,?)')
      .run('screen-comparisons-presentation-updated',JSON.stringify({snapshot_hash:store.digest,enabled:screenComparisons,
        catalog_hash:store.screenReview?.catalog.content_hash||null,existing_votes:store.db.prepare('SELECT COUNT(*) n FROM ballots').get().n,
        ranking_unit:'one-explicit-overall-choice'}),startedAt);
    if(incrementalRanking!==(previous.incremental_ranking===true))store.db.prepare('INSERT INTO events(kind,body,created_at) VALUES (?,?,?)')
      .run('incremental-ranking-presentation-updated',JSON.stringify({enabled:incrementalRanking,algorithm:store.incremental?.algorithm||null,
        snapshot_hash:store.digest,existing_ballots:store.db.prepare('SELECT COUNT(*) n FROM ballots').get().n}),startedAt);
    const receipt = { host, port, base_path: basePath, scores_directory: scoresDirectory, judge_scores_directory: judgeScoresDirectory, public_admin:publicAdmin, open_registration:openRegistration, reviewer_selection:reviewerSelection,
      show_figma_links:showFigmaLinks,screen_comparisons:screenComparisons,incremental_ranking:incrementalRanking,review_mode:store.reviewMode,started_at: startedAt, candidates: store.candidates.size, pairs: store.pairs.length,
      snapshot_hash: store.digest, database: path.join(directory, 'arena.sqlite3') };
    fs.writeFileSync(path.join(directory, 'service.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ listening: true, port, candidates: store.candidates.size, pairs: store.pairs.length }));
  });
  let closing = false;
  const cleanup = () => { if (fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile)) === process.pid) fs.rmSync(pidFile); };
  process.on('exit', cleanup);
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    if (closing) return; closing = true;
    server.close(() => { store.close(); cleanup(); process.exit(0); });
  });
  server.on('error', (e) => { console.error(e.message); store.close(); process.exit(1); });
}
