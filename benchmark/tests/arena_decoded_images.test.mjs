import test from 'node:test';
import assert from 'node:assert/strict';
import {createDecodedImages} from '../arena/decoded-images.js';

function fixture(options={}){
 const allocated=[];
 const cache=createDecodedImages({localPath:u=>'/arena-v2'+u,budget:16,limit:2,makeImage:()=>{
  const image={dataset:{},isConnected:false,complete:true,naturalWidth:2,removeAttribute(name){delete this[name];},async decode(){if(this.src.endsWith('bad'))throw Error('decode');}};
  allocated.push(image);return image;
 },...options});
 const im=name=>({url:'/media/'+name,width:2,height:1});return{cache,allocated,im};
}
test('nearby decode retains only a bounded window; a failed decode releases its reservation',async()=>{
 const {cache,allocated,im}=fixture();await cache.prepare(['a','b','c'].map(im));
 assert.equal(cache.stats().bytes,16);assert.equal(cache.stats().entries,2);
 await cache.prepare([im('c')]);assert.equal(allocated.length,3);
 await cache.prepare([im('bad')]);assert.equal(cache.stats().bytes,8);
 await cache.prepare([{...im('huge'),height:100}]);assert.equal(allocated.length,4);
 cache.stop();await cache.prepare([im('d')]);assert.equal(cache.stats().entries,0);
});
test('leaving a screen cancels unfinished hidden originals instead of retaining their downloads',async()=>{
 const {cache,allocated,im}=fixture();await cache.prepare([im('a'),im('b')]);
 allocated[0].complete=false;allocated[1].complete=false;allocated[1].isConnected=true;
 cache.releaseHidden();assert.equal(allocated[0].src,undefined);assert.ok(allocated[1].src);
 assert.equal(cache.stats().entries,1);assert.equal(cache.stats().bytes,8);
});
test('decoded cache keeps visible originals and skips background decode when they use its budget',async()=>{
 const {cache,allocated,im}=fixture();await cache.prepare([im('a'),im('b')]);
 for(const image of allocated)image.isConnected=true;
 await cache.prepare([im('c')]);assert.equal(allocated.length,2);assert.equal(cache.stats().bytes,16);
 allocated[0].isConnected=false;await cache.prepare([im('c')]);assert.equal(allocated.length,3);
 assert.equal(cache.stats().bytes,16);
});
