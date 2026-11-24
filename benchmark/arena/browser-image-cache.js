export function createImageStorage(indexedDB=globalThis.indexedDB){
  let opening;
  function open(){
    return opening||=(new Promise((resolve,reject)=>{
      if(!indexedDB)return reject(Error('此浏览器不支持本地图片缓存，请换用普通模式的 Chrome 或 Edge'));
      const request=indexedDB.open('design-arena-images-v1',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('images',{keyPath:'url'});
      request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(Error('本地缓存正被其他页面占用，请关闭旧评审标签页后重试'));
      request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();opening=null;};resolve(db);};
    }));
  }
  async function transaction(mode,action){
    const db=await open();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('images',mode),request=action(tx.objectStore('images'));
      tx.oncomplete=()=>resolve(request?.result);
      tx.onerror=tx.onabort=()=>reject(tx.error||Error('无法保存本地缓存'));
    });
  }
  return{keys:()=>transaction('readonly',s=>s.getAllKeys()),get:url=>transaction('readonly',s=>s.get(url)),
    put:row=>transaction('readwrite',s=>s.put(row)),remove:urls=>transaction('readwrite',s=>{for(const url of urls)s.delete(url);})};
}

export function createBrowserImageCache({api,localPath,storage=createImageStorage(),fetchImage=(...args)=>fetch(...args),concurrency=2}){
  const listeners=new Set(),present=new Set(),failed=new Set(),controllers=new Set(),writes=new Set(),sources=new Map();
  let cases=[],initializing,initialized=false,running=false,status='loading',error='',generation=0,target=null;
  const key=url=>localPath(url);
  const unique=items=>[...new Map(items.map(im=>[key(im.url),im])).values()];
  function summary(items){
    const all=unique(items),cached=all.filter(im=>present.has(key(im.url)));
    return{total:all.length,cached:cached.length,bytes:all.reduce((n,im)=>n+im.bytes,0),cachedBytes:cached.reduce((n,im)=>n+im.bytes,0),failed:all.filter(im=>failed.has(key(im.url))).length};
  }
  function stats(){return{...summary(cases.flatMap(c=>c.items)),running,status,error,target,
    stored:[...present].filter(url=>url.startsWith(localPath('/api/review/media/'))).length,
    cases:cases.map(c=>({case_id:c.case_id,title:c.title,...summary(c.items)}))};}
  const notify=()=>{const state=stats();for(const listener of listeners)listener(state);};
  async function init(){
    if(initialized)return;
    if(initializing)return initializing;
    initializing=(async()=>{
      try{
        const manifest=await api('/api/review/cache-manifest');cases=manifest.cases;
        for(const url of await storage.keys())present.add(url);
        initialized=true;status='ready';error='';
      }catch(e){status='unavailable';error=e.message||'本地缓存不可用，仍可直接进入评审';}
      finally{initializing=null;notify();}
    })();return initializing;
  }
  function pause(reason='paused'){
    generation++;
    if(!running)return;
    running=false;status=reason;
    for(const controller of controllers)controller.abort();controllers.clear();notify();
  }
  async function start(caseId=null){
    if(running)return;
    const requested=generation;
    await init();if(!initialized||running||requested!==generation)return;
    running=true;status='running';error='';target=caseId;const version=++generation;
    const queue=unique(cases.filter(c=>caseId===null||c.case_id===caseId).flatMap(c=>c.items)).filter(im=>!present.has(key(im.url)));
    for(const im of queue)failed.delete(key(im.url));notify();let cursor=0;
    async function worker(){
      while(running&&version===generation&&cursor<queue.length){
        const im=queue[cursor++],url=key(im.url),controller=new AbortController();controllers.add(controller);
        const timeout=setTimeout(()=>controller.abort(),90000);
        try{
          const response=await fetchImage(url,{credentials:'same-origin',cache:'force-cache',priority:'low',signal:controller.signal});
          if(!response.ok)throw Error(response.status===403?'登录已过期，请刷新页面后继续缓存':`图片下载失败（${response.status}），可重试`);
          if(!response.headers.get('content-type')?.startsWith('image/'))throw Error('图片响应异常，可重试');
          if(response.headers.get('etag')!==`"${im.sha256}"`)throw Error('图片版本已更新，请刷新页面后继续缓存');
          const blob=await response.blob();
          if(blob.size!==im.bytes)throw Error('图片未完整下载，可重试');
          if(!running||version!==generation)break;
          const write=storage.put({url,blob,bytes:blob.size,sha256:im.sha256});writes.add(write);
          try{await write;present.add(url);failed.delete(url);}finally{writes.delete(write);}
        }catch(e){
          if(version!==generation)break;
          failed.add(url);
          if(e.name==='QuotaExceededError'){error='浏览器存储空间不足，请清理本地图片缓存后重试';pause('error');}
          else if(!controller.signal.aborted)error=e.message;
          else error='部分图片下载超时，可点击继续缓存重试';
        }finally{clearTimeout(timeout);controllers.delete(controller);notify();}
      }
    }
    await Promise.all(Array.from({length:concurrency},worker));
    if(version===generation){running=false;status=queue.some(im=>!present.has(key(im.url)))?'partial':'complete';notify();}
  }
  async function source(url){
    if(/[?&]_retry=/.test(url))return url;
    try{
      const row=await storage.get(url);
      if(row?.blob?.size&&row.blob.size===row.bytes)return URL.createObjectURL(row.blob);
    }catch{ }
    return url;
  }
  async function mount(img,url,valid=()=>img.isConnected){
    const sourceUrl=await source(url);
    if(!valid()){if(sourceUrl.startsWith('blob:'))URL.revokeObjectURL(sourceUrl);return;}
    sources.get(img)?.();
    if(sourceUrl.startsWith('blob:')){
      const release=()=>{URL.revokeObjectURL(sourceUrl);img.removeEventListener('load',release);img.removeEventListener('error',release);if(sources.get(img)===release)sources.delete(img);};
      sources.set(img,release);
      img.addEventListener('load',release,{once:true});img.addEventListener('error',release,{once:true});
    }
    img.src=sourceUrl;
  }
  async function clear(){
    pause();await init();if(!initialized)return;await Promise.allSettled([...writes]);
    const prefix=localPath('/api/review/media/'),urls=(await storage.keys()).filter(url=>url.startsWith(prefix));
    await storage.remove(urls);for(const url of urls){present.delete(url);failed.delete(url);}status='ready';error='';notify();
  }
  return{init,start,pause,source,mount,clear,stats,has:async url=>{try{return !!await storage.get(key(url));}catch{return false;}},
    releaseHidden(){for(const [img,release] of sources)if(!img.isConnected)release();},
    stop(){pause();for(const release of sources.values())release();listeners.clear();},
    subscribe(listener){listeners.add(listener);listener(stats());return()=>listeners.delete(listener);}};
}
