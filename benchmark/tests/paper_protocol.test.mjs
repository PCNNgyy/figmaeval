import test from 'node:test';
import assert from 'node:assert/strict';
import {benchmarkDesignSystemPrompt,benchmarkDesignTarget} from '../server/benchmark_design.mjs';

test('paper prompt preserves four starter references and allows iterative visual verification',()=>{
  const target=benchmarkDesignTarget('https://www.figma.com/design/PaperCopy/');
  const prompt=benchmarkDesignSystemPrompt(null,target,{paperProtocol:true});
  for(const name of ['00 · Start Here','01 · Foundations','02 · Components','03 · Media','03 · Workspace']) assert.ok(prompt.includes(name));
  assert.doesNotMatch(prompt,/04 · Media|Do not call get_screenshot|Reasoning summary:/);
  assert.match(prompt,/Reference layouts are withheld/);
  assert.match(prompt,/take multiple screenshots, fix visible problems and check again/);
});
