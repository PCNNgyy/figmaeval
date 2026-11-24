import fs from 'node:fs';
import {benchmarkDesignSystemPrompt,benchmarkDesignTarget} from '../server/benchmark_design.mjs';
import {getScaleMethod} from '../server/fixed_scales/index.mjs';
import {buildFixed20Prompt} from '../server/fixed20_scale.mjs';
import {assertRubric} from '../server/benchmark_protocol.mjs';
assertRubric(JSON.parse(fs.readFileSync(new URL('../benchmarks/rubrics/fixed-v4.json',import.meta.url),'utf8')));
const [mode,file]=process.argv.slice(2), input=JSON.parse(fs.readFileSync(file,'utf8'));
if(mode==='inference') {
  const target=benchmarkDesignTarget(input.query,input.figma_url);
  console.log(JSON.stringify({file_key:target.fileKey,system_prompt:benchmarkDesignSystemPrompt({identity:input.identity},target,{paperProtocol:true})}));
} else if(mode==='judge') {
  const def=getScaleMethod('fixed_v4');
  let prompt=buildFixed20Prompt(def.prompt_template,{query:input.query,
    imageBlock:input.images.map((p,i)=>`第 ${i+1} 屏：${p}`).join('\n'),
    layerSummary:input.layer_summary,questions:def.questions,layerLabel:def.layer_label,layerHints:def.layer_hints});
  if(input.gate_policy!=='required')throw Error('The paper rubric supplement requires G0');
  console.log(JSON.stringify({prompt:'Use Read to open EVERY image listed below before scoring. Text summaries are not substitutes for reading images.\n'+prompt}));
} else throw Error('Unknown context mode');
