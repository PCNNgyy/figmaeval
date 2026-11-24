import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {seal} from '../server/benchmark_protocol.mjs';
import {activeSamplingPolicy,readArenaSampling,ACTIVE_SAMPLING,UNIFORM_SAMPLING} from '../server/arena_active_sampling.mjs';

const opts={};for(let i=2;i<process.argv.length;i+=2)opts[process.argv[i].replace(/^--/,'')]=process.argv[i+1];
if(!opts.directory||!['active','uniform'].includes(opts.algorithm))throw Error('Use --directory <arena> --algorithm active|uniform [--exploration .2 --temperature .05 --prior-precision 1]');
const directory=path.resolve(opts.directory),pidFile=path.join(directory,'service.pid');
if(fs.existsSync(pidFile)){
  const pid=Number(fs.readFileSync(pidFile));if(!Number.isSafeInteger(pid)||pid<1)throw Error('Invalid service PID');
  let running=false;try{process.kill(pid,0);running=true;}catch(e){if(e.code!=='ESRCH')throw e;}
  if(running)throw Error('Stop the service before changing sampling; existing assignments and ballots must be preserved');
}
const snapshot=JSON.parse(fs.readFileSync(path.join(directory,'snapshot.json')));
if(snapshot.version!==3)throw Error('Sampling configuration requires the four-model tournament');
const snapshotHash=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
const before=readArenaSampling(directory,snapshot,snapshotHash),at=new Date().toISOString();
const algorithm=opts.algorithm==='active'?ACTIVE_SAMPLING:UNIFORM_SAMPLING;
const meta={created_at:at,previous_policy_hash:before.content_hash};
const policy=algorithm===ACTIVE_SAMPLING?activeSamplingPolicy(snapshotHash,{...meta,exploration_fraction:Number(opts.exploration??.2),temperature:Number(opts.temperature??.05),prior_precision:Number(opts['prior-precision']??1)})
  :seal({kind:'figma-arena-sampling/v1',snapshot_hash:snapshotHash,algorithm,...meta});
const archive=path.join(directory,'sampling-history',at.replace(/[:.]/g,'-'));fs.mkdirSync(archive,{recursive:true,mode:0o700});
const db=new DatabaseSync(path.join(directory,'arena.sqlite3'),{readOnly:true});
if(db.prepare('SELECT value FROM metadata WHERE key=?').get('snapshot_hash')?.value!==snapshotHash)throw Error('Database and frozen snapshot differ');
await backup(db,path.join(archive,'arena.sqlite3'));fs.chmodSync(path.join(archive,'arena.sqlite3'),0o600);
const counts={ballots:db.prepare('SELECT COUNT(*) n FROM ballots').get().n,tournaments:db.prepare('SELECT COUNT(*) n FROM tournaments').get().n};db.close();
fs.writeFileSync(path.join(archive,'sampling-before.json'),JSON.stringify(before,null,2),{flag:'wx',mode:0o600});
const staging=path.join(archive,'validation');fs.mkdirSync(staging,{mode:0o700});
fs.writeFileSync(path.join(staging,'sampling-policy.json'),JSON.stringify(policy),{flag:'wx',mode:0o600});readArenaSampling(staging,snapshot,snapshotHash);fs.rmSync(staging,{recursive:true});
const file=path.join(directory,'sampling-policy.json'),temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(policy,null,2),{flag:'wx',mode:0o600});fs.renameSync(temp,file);
const receipt={changed_at:at,snapshot_hash:snapshotHash,algorithm,policy_hash:policy.content_hash,archive,preserved:counts,
  existing_assignments:'unchanged',effect:'future-tournaments-only',implementation:'local-adaptation-of-published-principles'};
fs.writeFileSync(path.join(archive,'receipt.json'),JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify(receipt));
