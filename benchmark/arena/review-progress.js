const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

export function identityProgressLines(p){
  const lines=[];
  if(Number.isInteger(p.tasks_per_cycle)&&Number.isInteger(p.completed_tasks)){
    lines.push(`已完成过 ${p.completed_any_stage_tasks??p.completed_tasks}/${p.tasks_per_cycle} 题（含原阶段）`);
    lines.push(`已开始 ${p.started_tasks??0} 题 · ${p.pending_extension_tasks??0} 题待补评`);
  }else if(Number.isInteger(p.completed_sessions))lines.push(`已完成 ${p.completed_sessions} 轮`);
  lines.push(`${p.actual_votes??p.voted??p.done??0} 次投票已保存`);
  if(p.blocked)lines.push('当前题待复核');
  return lines;
}

export function cohortProgressSection(d,localPath){
 const cohorts=d.cohort_progress||[{version:'current',label:d.snapshot.name,model_count:d.snapshot.models,review_href:localPath('/?view=review'),admin_href:localPath('/?view=admin'),reviewers:d.reviewers}];
 return `<section class="card" id="cohort-review-progress"><div class="section-top"><h2>评审入口与进度</h2><span class="note">各批次分别统计，历史记录继续保留</span></div>${d.cohort_progress_error?`<p class="inline-error">其他批次进度暂未读取：${esc(d.cohort_progress_error)}</p>`:''}${cohorts.map(c=>`<div data-cohort-progress="${esc(c.version)}"><div class="section-top"><h3>${esc(c.label)}</h3><div class="actions"><a class="external" href="${esc(c.review_href)}" target="_blank" rel="noopener noreferrer">打开本批评审入口 ↗</a><a class="external" href="${esc(c.admin_href)}">本批管理台 →</a></div></div><div class="table-wrap"><table><thead><tr><th>评审</th><th>已开始</th><th>已完成过（含原阶段）</th><th>待补评</th><th>当前 ${c.model_count} 模型已完成</th><th>已保存投票</th></tr></thead><tbody>${c.reviewers.map(r=>`<tr><td>${esc(r.label)}</td><td>${r.started_tasks??0}/${r.tasks_per_cycle}</td><td>${r.completed_any_stage_tasks??r.completed_tasks}/${r.tasks_per_cycle}</td><td>${r.pending_extension_tasks??0} 题</td><td>${r.completed_tasks} 题</td><td>${r.actual_votes} 次</td></tr>`).join('')||'<tr><td colspan="6">尚无已登记评审</td></tr>'}</tbody></table></div></div>`).join('')}<p class="note">已开始包含尚未评完的题目；原阶段的投票、逐屏选择和排序继续保留。每次加入2份作品后归并，接着原进度补评即可。</p></section>`;
}
