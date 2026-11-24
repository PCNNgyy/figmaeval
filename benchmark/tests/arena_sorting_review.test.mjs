import test from 'node:test';import assert from 'node:assert/strict';import {sortingReviewGroups} from '../arena/incremental-ranking.js';
test('a repeated comparison has one review action containing both old directions, including repeats outside the cycle witness',()=>{
 const votes=[{id:'old1',a:'作品 03',b:'作品 04',winner:'作品 03',outcome:'win'},
  {id:'old2',a:'作品 04',b:'作品 03',winner:'作品 04',outcome:'win'},
  {id:'again',a:'作品 03',b:'作品 04',winner:'作品 04',outcome:'win'},
  {id:'other',a:'作品 01',b:'作品 02',winner:'作品 01',outcome:'win'}];
 const groups=sortingReviewGroups({votes,issue:{vote_ids:['old1','again']}});
 assert.deepEqual(groups,[{a:'作品 03',b:'作品 04',vote_id:'again',count:3,choices:['作品 03 更好','作品 04 更好']}]);
});
test('a three-way cycle retains its three distinct pair choices rather than folding unrelated judgments together',()=>{
 const votes=[{id:'ab',a:'A',b:'B',winner:'A',outcome:'win'},{id:'bc',a:'B',b:'C',winner:'B',outcome:'win'},{id:'ca',a:'C',b:'A',winner:'C',outcome:'win'}];
 assert.equal(sortingReviewGroups({votes,issue:{vote_ids:['ab','bc','ca']}}).length,3);
});
