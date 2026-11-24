import fs from 'node:fs';
import {parseArenaJudgeResult} from './arena-judge-result.mjs';
console.log(JSON.stringify(parseArenaJudgeResult(fs.readFileSync(process.argv[2],'utf8'),{gatePolicy:process.argv[3]})));
