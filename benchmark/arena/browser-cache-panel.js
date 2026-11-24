const size=bytes=>`${(bytes/1024/1024).toFixed(1)} MB`;
let unsubscribe=()=>{};
export const browserCachePanel=()=>`<section class="browser-cache-panel" aria-labelledby="browser-cache-title"><div class="browser-cache-heading"><div><h2 id="browser-cache-title">评审前，先把图片存到这台浏览器</h2><p class="note">缓存后打开题目可直接读取本地图片；刷新后仍可使用。进入评审会暂停下载，可返回这里继续。</p></div><div class="browser-cache-actions"><button id="cache-all" class="primary" disabled>一键缓存全部图片</button><button id="cache-pause" hidden>暂停</button><button id="cache-clear" class="quiet" disabled>清理图片缓存</button></div></div><progress id="cache-progress" value="0" max="1" aria-label="本地图片缓存进度"></progress><p id="cache-status" class="note" role="status">正在检查本地缓存…</p><p class="note cache-local-note">仅保存在当前浏览器；请在缓存完成前保持此页面打开。缓存图片不会提交评审结果。</p></section>`;
export function bindBrowserCachePanel(app,cache){
  unsubscribe();if(!cache)return()=>{};
  const all=app.querySelector('#cache-all'),pause=app.querySelector('#cache-pause'),clear=app.querySelector('#cache-clear');
  unsubscribe=cache.subscribe(state=>{
    if(!all.isConnected)return;
    const unavailable=['loading','unavailable'].includes(state.status),complete=state.total>0&&state.cached===state.total;
    all.disabled=unavailable||state.running||complete;all.textContent=complete?'全部图片已缓存':state.cached||state.failed?'继续缓存 / 重试':'一键缓存全部图片';
    pause.hidden=!state.running;clear.disabled=unavailable||state.running||!state.stored;
    const progress=app.querySelector('#cache-progress');progress.max=Math.max(1,state.total);progress.value=state.cached;
    const phase=state.running?'后台缓存中':state.status==='review'?'已暂停，优先加载当前评审':state.status==='paused'?'已暂停':complete?'缓存完成':state.cached?'可继续缓存':'尚未开始缓存';
    app.querySelector('#cache-status').textContent=unavailable?(state.error||'正在检查本地缓存…'):`${phase} · ${state.cached} / ${state.total} 张 · ${size(state.cachedBytes)} / ${size(state.bytes)}${state.failed?` · ${state.failed} 张待重试`:''}${state.error?' · '+state.error:''}`;
    for(const c of state.cases){
      const card=[...app.querySelectorAll('[data-lobby-case]')].find(el=>el.dataset.lobbyCase===c.case_id);if(!card)continue;
      const label=card.querySelector('[data-case-cache-status]'),button=card.querySelector('[data-cache-task]');
      label.textContent=`本地图片 ${c.cached}/${c.total} · ${size(c.bytes)}`;
      button.disabled=state.running||unavailable||c.cached===c.total;button.textContent=c.cached===c.total?'已缓存':c.cached?'继续缓存':'缓存本题';
    }
  });
  all.onclick=()=>cache.start();pause.onclick=()=>cache.pause();
  clear.onclick=()=>cache.clear().catch(e=>{app.querySelector('#cache-status').textContent=e.message;});
  app.querySelectorAll('[data-cache-task]').forEach(button=>button.onclick=()=>cache.start(button.dataset.cacheTask));
  return unsubscribe;
}
