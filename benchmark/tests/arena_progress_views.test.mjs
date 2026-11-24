import test from 'node:test';import assert from 'node:assert/strict';import {identityProgressLines,cohortProgressSection} from '../arena/review-progress.js';
test('both identity selectors show historical completion when current ten-model completion is zero',()=>{
 for(const [total,prior,started] of [[29,22,29],[13,1,9]]){
  const lines=identityProgressLines({tasks_per_cycle:total,completed_tasks:0,completed_any_stage_tasks:prior,started_tasks:started,pending_extension_tasks:prior,actual_votes:55});
  assert.equal(lines[0],`已完成过 ${prior}/${total} 题（含原阶段）`);assert.ok(lines[1].includes(`已开始 ${started} 题`));assert.ok(!lines.some(s=>s.startsWith('已完成 0/')));
 }
});
test('one admin progress section shows all cohorts independently, including partially reviewed tasks',()=>{
 const make=(version,label,total,prior,started)=>({version,label,model_count:10,review_href:'/arena-v2/?view=review',admin_href:'/arena-v2/?view=admin',reviewers:[{label:'Designer <name>',tasks_per_cycle:total,completed_tasks:0,completed_any_stage_tasks:prior,started_tasks:started,pending_extension_tasks:prior,actual_votes:55}]});
 const html=cohortProgressSection({cohort_progress:[make('v2','首批29题',29,22,29),make('new13','新增13题',13,1,9),make('new20','新增20题',20,0,0)]},s=>s);
 for(const text of ['data-cohort-progress="v2"','data-cohort-progress="new13"','data-cohort-progress="new20"','22/29','9/13','1/13','0/20','各批次分别统计','当前 10 模型已完成'])assert.ok(html.includes(text));assert.ok(html.includes('Designer &lt;name&gt;'));assert.ok(!html.includes('Designer <name>'));
});
