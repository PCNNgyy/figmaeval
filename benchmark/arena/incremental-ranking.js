import {cohortProgressSection} from './review-progress.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const statusLabel={complete:'排序完成','awaiting-vote':'等待下一次比较',reviewing:'复核中','paused-tie':'平局待复核','paused-cycle':'循环偏好待复核','paused-unable':'无法比较待处理'};
const stageLabel={'initial-left':'首批四模型','initial-right':'首批四模型',merge:'有序列表归并',batch:'准备下一批','batch-pair':'新增两模型比较','binary-insert':'单模型二分插入',complete:'完成'};

export function sortingReviewGroups(s){
  const key=v=>JSON.stringify([v.a,v.b].sort()),relevant=new Set(s.votes.filter(v=>s.issue?.vote_ids?.includes(v.id)).map(key));
  return [...relevant].map(k=>{
    const votes=s.votes.filter(v=>key(v)===k),last=votes.at(-1),[a,b]=JSON.parse(k);
    return{a,b,vote_id:last.id,count:votes.length,choices:[...new Set(votes.map(v=>v.outcome==='win'?`${v.winner} 更好`:v.outcome==='tie'?'平局':'无法比较'))]};
  });
}

export function renderSortingPause({data,app,api,next,toast,backToTasks}){
  const s=data.sorting,cycle=s.status==='paused-cycle',tie=s.status==='paused-tie';
  const groups=sortingReviewGroups(s),duplicate=cycle&&groups.length===1&&groups[0].count>1;
  app.innerHTML=`<section class="card">${backToTasks?'<button id="sorting-back-to-tasks" class="quiet">← 返回题目列表</button>':''}<div class="eyebrow">Incremental ranking · 暂停复核</div><h1>${duplicate?'同一组作品的判断不一致':cycle?'出现循环偏好':tie?'这次选择为平局':'本题暂时无法继续比较'}</h1><p>${esc(s.case_id)} · 已记录 ${s.actual_votes} 次真实投票。</p><p>${duplicate?'这两份作品曾得到相反的整体判断。重新比较这一组并确认一次即可，不需要选择该修改哪条旧记录。':cycle?'同一会话中出现了互相矛盾的先后关系，请重新查看下面的比较。':tie?'平局已经保存，请重新比较并确认整体选择。':'问题已保存；处理访问或稿件问题后，可重新比较。'}</p>${s.issue?.cycle?`<div class="notice">${s.issue.cycle.map(esc).join(' ＞ ')}</div>`:''}<div class="sorting-review-list">${groups.map(g=>`<article class="sorting-review-card"><h2>${esc(g.a)} / ${esc(g.b)}</h2><p>此前 ${g.count} 次有效记录：${g.choices.map(esc).join('；')}</p><button class="primary" data-review-sort-vote="${esc(g.vote_id)}">重新比较这两份作品</button></article>`).join('')}</div><p class="note">请逐屏查看后确认整体选择。本次确认将替代本轮这两份作品之间的旧判断，原始记录仍保留；其他作品和其他题的判断继续保留。如仍有其他冲突，系统会继续列出需要复核的比较。</p></section>`;
  app.querySelector('#sorting-back-to-tasks')?.addEventListener('click',backToTasks);
  app.querySelectorAll('[data-review-sort-vote]').forEach(b=>b.onclick=async()=>{
    app.querySelectorAll('[data-review-sort-vote]').forEach(x=>x.disabled=true);
    try{await api('/api/review/sort/review',{session_id:s.session_id,vote_id:b.dataset.reviewSortVote,revision:s.revision});await next();}
    catch(e){toast(e.message);app.querySelectorAll('[data-review-sort-vote]').forEach(x=>x.disabled=false);}
  });
}

export function renderSortingComplete({app,data}){
  app.innerHTML=`<section class="card completion"><div class="brand-mark">✓</div><h1>全部题目排序已完成</h1><p>已完成 ${data.progress.completed_sessions} 道题的全部模型排序，记录已自动保存。</p><p class="note">本轮输出每道题、每位评审各自的相对顺序。管理台可查看真实投票、归并过程和最终顺序。</p></section>`;
}

export function renderSortingAdmin({data:d,app,localPath,ccCard,agreementCard,refresh}){
  const sessions=d.sorting.sessions,completed=sessions.filter(s=>s.status==='complete'),historical=sessions.filter(s=>s.previous_completed_models>0),models=new Map(d.task_statistics.tasks.flatMap(t=>t.models.map(m=>[m.model_id,m.model_name])));
  const reviewers=new Map(d.reviewers.map(r=>[r.id,r.label]));
  const stage=s=>s.status==='reviewing'?'复核已记录的比较':stageLabel[s.stage]||s.stage;
  app.innerHTML=`<div class="page-heading"><div><div class="eyebrow">Incremental model ranking</div><h1>设计盲评 · 增量排序管理台</h1><p class="muted">同题、同模型版本、同评审会话内排序 · 输出相对顺序</p></div><button id="refresh">刷新</button></div><div class="stats"><div class="stat"><span>已完成过的评审轮次</span><strong>${sessions.filter(s=>s.status==='complete'||s.previous_completed_models>0).length}</strong><span>原阶段 ${historical.length} 轮已保留 · 当前 ${d.snapshot.models} 模型完成 ${completed.length} 轮</span></div><div class="stat"><span>真实投票次数</span><strong>${d.sorting.actual_votes}</strong><span>含复核操作，推导关系不计票</span></div><div class="stat"><span>暂停待复核</span><strong>${sessions.filter(s=>s.status.startsWith('paused-')).length}</strong><span>循环偏好、平局或访问问题</span></div><div class="stat"><span>全部参评模型</span><strong>${d.snapshot.models}</strong><span>${d.snapshot.cases}道题 · 每题覆盖全部模型</span></div></div>${cohortProgressSection(d,localPath)}<section class="card"><div class="section-top"><h2>逐题相对排名</h2><a class="external" href="${esc(localPath('/api/admin/sorting'))}" download>导出排序与证据 JSON</a></div><p class="note">从左到右由好到差。不同题目和评审分别记录，不生成总分、BT分或Rating。尚未完成时不发布完整排名。</p><div class="table-wrap"><table><thead><tr><th>题目</th><th>评审</th><th>状态 / 阶段</th><th>实际票数</th><th>最终相对顺序</th></tr></thead><tbody>${sessions.map(s=>`<tr><td>${esc(s.case_id)} · 第 ${s.round} 轮</td><td>${esc(reviewers.get(s.reviewer_id)||s.reviewer_id)}</td><td>${s.previous_completed_models&&s.status!=='complete'?'待补评 · ':''}${esc(statusLabel[s.status]||s.status)}${s.previous_completed_models?`<small class="muted"> · 原 ${s.previous_completed_models} 模型已完成</small>`:''}<small class="muted"> · ${esc(stage(s))}${s.merge?`（${s.merge.i}/${s.merge.left.length}，${s.merge.j}/${s.merge.right.length}）`:''}</small></td><td>${s.actual_votes}${s.source_session_id?' · 含同会话历史票':''}</td><td>${s.ranking?s.ranking.map(id=>esc(models.get(id)||id)).join(' ＞ '):s.completed_stage_history?.length?`<span class="note">历史 ${s.completed_stage_history[0].model_count} 模型顺序（旧版）</span><br>${s.completed_stage_history[0].ranking.map(id=>esc(models.get(id)||id)).join(' ＞ ')}<br><span class="note">当前 ${d.snapshot.models} 模型待补评</span>`:'待完成'}</td></tr>`).join('')||'<tr><td colspan="5">等待评审开始。</td></tr>'}</tbody></table></div><details><summary>统计与证据说明</summary><p class="note">真实投票和传递关系分表保存；只有仍生效的真实投票用于人评/CC对照。历史票及复核原文完整保留。${d.sorting.legacy_ballots_retained}条其他旧会话投票继续留档，不跨会话复用。</p><a href="${esc(localPath('/api/admin/export'))}" download>完整历史与过程 JSON</a> · <a href="${esc(localPath('/api/admin/export.csv'))}" download>当前真实票与CC对照 CSV</a></details></section>${agreementCard(d.task_statistics)}<section class="card"><h2>逐题进度与CC对照</h2><div class="table-wrap"><table><thead><tr><th>题目</th><th>当前 ${d.snapshot.models} 模型完成评审</th><th>真实投票</th><th>与CC一致 / 可比较</th></tr></thead><tbody>${d.task_statistics.tasks.map(t=>`<tr><td>${esc(t.case_id)} · ${esc(t.title)}</td><td>${t.first_cycle_completed_reviewers}/${d.reviewers.length}</td><td>${t.first_cycle_votes}</td><td>${t.agreed_votes}/${t.comparable_votes}</td></tr>`).join('')}</tbody></table></div></section><details class="card"><summary>原有 CC v4 自动评分榜</summary>${ccCard(d)}</details>`;
  app.querySelector('#refresh').onclick=refresh;
  if(d.judge_scores||d.judge_scores_error){
    const card=app.querySelector('#judge-scores'),wrapper=card.closest('details');
    app.querySelector('.stats').insertAdjacentElement('afterend',card);
    wrapper.remove();
  }
}

export function sortingProgressText(s){
  return s.status==='reviewing'?'正在复核已记录的比较':`${s.previous_completed_models?`原 ${s.previous_completed_models} 模型顺序已保存 · `:''}${stageLabel[s.stage]||'增量排序'} · ${s.model_count} 模型 · 本题已投 ${s.actual_votes} 票`;
}
