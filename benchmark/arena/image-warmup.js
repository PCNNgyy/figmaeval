import {createDecodedImages} from './decoded-images.js';
import {createBrowserImageCache} from './browser-image-cache.js';
export function createImageWarmup({localPath,api,budget=48*1024*1024}){
  const queue=new Map(),done=new Set(),active=new Map();
  const images=createDecodedImages({localPath,budget:(navigator.deviceMemory&&navigator.deviceMemory<=4?48:96)*1024*1024});
  const localCache=api?createBrowserImageCache({api,localPath}):null;
  let paused=true,stopped=false,spent=0,activeCase,timer,generation=0;
  function cancel(){generation++;clearTimeout(timer);timer=null;for(const controller of active.values())controller.abort();queue.clear();}
  function schedule(){if(!timer&&!stopped&&!paused)timer=setTimeout(()=>{timer=null;pump();},750);}
  function add(items,priority=0,caseId){
    if(stopped||caseId!==activeCase)return;
    queue.clear();for(const im of items.slice(0,2))if(im?.media_key&&!done.has(im.url)&&!active.has(im.url))queue.set(im.url,im);
    schedule();
  }
  async function pump(){
    if(stopped||paused||active.size||document.hidden||navigator.connection?.saveData)return;
    const item=queue.values().next().value;if(!item)return;
    queue.delete(item.url);const controller=new AbortController(),version=generation;active.set(item.url,controller);
    try{
      if(await localCache?.has(item.url)){done.add(item.url);return;}
      if(stopped||paused||version!==generation)return;
      const response=await fetch(localPath(item.url),{credentials:'same-origin',cache:'force-cache',priority:'low',signal:controller.signal});
      if(response.ok){
        const reader=response.body?.getReader();if(reader){while(!(await reader.read()).done){ }}else await response.arrayBuffer();
        if(!stopped&&version===generation){done.add(item.url);spent+=item.bytes||0;}
      }
    }catch{ }
    finally{active.delete(item.url);schedule();}
  }
  const visibility=()=>{if(document.hidden)cancel();else schedule();};document.addEventListener('visibilitychange',visibility);
  return{images,localCache,add,pause(){paused=true;cancel();localCache?.pause('review');},resume(){paused=false;schedule();},
    async task(caseId){if(activeCase!==caseId){cancel();activeCase=caseId;}},
    async lobby(){paused=true;cancel();localCache?.releaseHidden();await localCache?.init();},
    stop(){stopped=true;cancel();localCache?.stop();images.stop();document.removeEventListener('visibilitychange',visibility);},
    stats:()=>({spent,budget,queued:queue.size,completed:done.size,concurrency:active.size,decoded:images.stats()})};
}
