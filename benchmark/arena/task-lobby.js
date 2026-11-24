import {browserCachePanel,bindBrowserCachePanel} from './browser-cache-panel.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const labels={'awaiting-vote':'评审中',reviewing:'复核中','paused-cycle':'待复核','paused-tie':'待复核','paused-unable':'待处理',complete:'已完成'};
export function taskLobbyProgress(tasks){
  return{completed:tasks.filter(t=>t.my_rounds.some(r=>r.status==='complete')).length,
    completedBeforeOrNow:tasks.filter(t=>t.my_rounds.some(r=>r.status==='complete'||r.previous_completed_models>0)).length,
    pendingExtensions:tasks.filter(t=>t.my_rounds.some(r=>r.previous_completed_models>0&&r.status!=='complete')).length,
    savedVotes:tasks.reduce((n,t)=>n+t.my_rounds.reduce((v,r)=>v+r.actual_votes,0),0)};
}
export function renderTaskLobby({data,app,onSelect,warmup}){
  const tasks=data.tasks,summary=taskLobbyProgress(tasks),modelCount=tasks[0]?.model_count||0;
  app.innerHTML=`<section class="task-lobby"><div class="page-heading"><div><div class="eyebrow">Design Arena</div><h1>选择一道设计任务</h1><p class="muted">任选题目开始，或继续上次进度。每轮对该题全部模型作品排出相对顺序。</p></div><div class="task-lobby-summary"><strong>${summary.completedBeforeOrNow} / ${tasks.length}</strong><span>已完成过的题目（含原阶段）</span><span>当前 ${modelCount} 模型已完成 ${summary.completed} 题 · ${summary.pendingExtensions} 题待补评</span><span>已保存 ${summary.savedVotes} 次整体判断</span></div></div>${warmup?.localCache?browserCachePanel():''}<div class="task-lobby-toolbar"><input id="task-lobby-search" class="field" type="search" placeholder="搜索题号或任务名称" aria-label="搜索题目"><label><input id="task-lobby-unfinished" type="checkbox"> 只看我未完成的</label><span class="note">${data.reviewer_count} 位已登记评审</span></div><div class="task-lobby-grid">${tasks.map(t=>{
    const own=t.my_rounds[0],finished=own?.status==='complete',extension=!!own?.previous_completed_models&&!finished;
    return `<article class="task-lobby-card" data-lobby-case="${esc(t.case_id)}"><div class="task-lobby-card-top"><span class="note">${esc(t.case_id)}</span>${own?`<span class="badge ${finished?'':'amber'}">${extension&&own.status==='awaiting-vote'?'待补评':labels[own.status]||'评审中'}</span>`:''}</div><h2>${esc(t.title)}</h2><p class="note">${t.model_count} 份匿名模型作品</p>${own?.previous_completed_models?`<p class="note stage-history-notice">原 ${own.previous_completed_models} 模型排序已完成并保留${extension?` · 本次新增 ${t.model_count-own.previous_completed_models} 份，继续补评即可`:''}</p>`:''}${t.review_update?`<p class="note task-update-notice">${esc(t.review_update.lobby_message||'稿件已更新 · 请继续复核相关比较')}</p>`:''}<div class="task-lobby-counts"><span><strong>${t.completed_reviewers}</strong> 人已完成当前 ${t.model_count} 模型</span><span><strong>${t.previously_completed_reviewers||0}</strong> 人完成过原阶段</span><span>${t.participants} 人参与过</span></div>${warmup?.localCache?`<div class="task-cache-row"><span class="note" data-case-cache-status>正在检查缓存…</span><button class="quiet" data-cache-task="${esc(t.case_id)}" disabled>缓存本题</button></div>`:''}<div class="task-lobby-card-bottom"><span class="note">${own?`我的第 ${own.round} 轮 · ${own.actual_votes} 次选择`:'我还未开始'}</span><button class="primary" data-select-task="${esc(t.case_id)}" data-new-round="${!!finished}">${finished?'再评一轮':extension?'继续补评':own?'继续评审':'开始评审'} →</button></div></article>`;
  }).join('')}</div><p id="task-lobby-empty" class="note" hidden>没有匹配的题目。</p><p class="footer-note">原阶段的完成记录、投票和排序继续保留；扩展模型后只需接续补评。当前完成数仅指已排完本批全部模型；同一人可完成多轮，各轮独立保存。打开题目或缓存图片不会增加评审人数。</p></section>`;
  function filter(){const q=app.querySelector('#task-lobby-search').value.trim().toLowerCase(),unfinished=app.querySelector('#task-lobby-unfinished').checked;let n=0;
    for(const t of tasks){const show=`${t.case_id} ${t.title}`.toLowerCase().includes(q)&&(!unfinished||t.my_rounds[0]?.status!=='complete');app.querySelector(`[data-lobby-case="${t.case_id}"]`).hidden=!show;if(show)n++;}
    app.querySelector('#task-lobby-empty').hidden=!!n;
  }
  app.querySelector('#task-lobby-search').oninput=filter;app.querySelector('#task-lobby-unfinished').onchange=filter;
  const unbindCache=bindBrowserCachePanel(app,warmup?.localCache);
  app.querySelectorAll('[data-select-task]').forEach(b=>b.onclick=async()=>{
    app.querySelectorAll('[data-select-task]').forEach(x=>x.disabled=true);warmup?.pause();
    try{await onSelect(b.dataset.selectTask,b.dataset.newRound==='true');unbindCache();}
    catch{app.querySelectorAll('[data-select-task]').forEach(x=>x.disabled=false);warmup?.resume();}
  });
  warmup?.lobby(tasks.toSorted((a,b)=>a.completed_reviewers-b.completed_reviewers));
}
