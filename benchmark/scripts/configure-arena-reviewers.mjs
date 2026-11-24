import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { seal } from '../server/benchmark_protocol.mjs';
import { readArenaReviewers } from '../server/arena_reviewers.mjs';

const opts={};for(let i=2;i<process.argv.length;i+=2)opts[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
if(!opts.directory||!opts.active)throw Error('Use --directory <arena> --active reviewer-1[,reviewer-2]');
const directory=path.resolve(opts.directory),pidFile=path.join(directory,'service.pid');
if(fs.existsSync(pidFile)){
  const pid=Number(fs.readFileSync(pidFile));if(!Number.isSafeInteger(pid)||pid<1)throw Error('Invalid service PID');
  let live=false;try{process.kill(pid,0);live=true;}catch(e){if(e.code!=='ESRCH')throw e;}
  if(live)throw Error('Stop the arena before changing participants; restart it afterwards');
}
const snapshot=JSON.parse(fs.readFileSync(path.join(directory,'snapshot.json'))),credentials=JSON.parse(fs.readFileSync(path.join(directory,'access.json')));
if(snapshot.version!==3)throw Error('Participant configuration requires the DesignArena tournament protocol');
const snapshotHash=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),ids=opts.active.split(',');
if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!credentials.reviewers.some(r=>r.id===id)))throw Error('Unknown or duplicate reviewer identity');
const before=readArenaReviewers(directory,snapshot,snapshotHash,credentials),policy=seal({kind:'figma-arena-reviewers/v1',snapshot_hash:snapshotHash,
  active_reviewers:ids,created_at:new Date().toISOString(),previous_policy_hash:before.content_hash});
const archive=path.join(directory,'participant-history',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(archive,{recursive:true,mode:0o700});
fs.writeFileSync(path.join(archive,'reviewers-before.json'),JSON.stringify(before,null,2),{flag:'wx',mode:0o600});
const db=new DatabaseSync(path.join(directory,'arena.sqlite3'),{readOnly:true});
if(db.prepare('SELECT value FROM metadata WHERE key=?').get('snapshot_hash')?.value!==snapshotHash)throw Error('Database snapshot does not match');
await backup(db,path.join(archive,'arena.sqlite3'));fs.chmodSync(path.join(archive,'arena.sqlite3'),0o600);
const counts={ballots:db.prepare('SELECT COUNT(*) n FROM ballots').get().n,tournaments:db.prepare('SELECT COUNT(*) n FROM tournaments').get().n};db.close();
const file=path.join(directory,'reviewers.json'),temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(policy,null,2),{flag:'wx',mode:0o600});fs.renameSync(temp,file);
const receipt={changed_at:new Date().toISOString(),snapshot_hash:snapshotHash,active_reviewers:ids,previous_active_reviewers:before.active_reviewers,
  reviewer_policy_hash:policy.content_hash,archive,preserved_counts:counts};
fs.writeFileSync(path.join(archive,'receipt.json'),JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify(receipt));
