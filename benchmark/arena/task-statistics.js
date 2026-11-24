const esc = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const pct = n => n===null?'—':`${(n*100).toFixed(1)}%`;
const statuses = {'not-started':'未开始','in-progress':'评审中','first-cycle-complete':'首轮已完成','has-skips':'首轮含跳过'};
const state = {filter:'all',query:'',expanded:new Set()};
const fraction = t => t.comparable_votes ? `${t.agreed_votes} / ${t.comparable_votes}` : '暂无可比较票';
function choice(row,prefix){
  const value=row[prefix==='human'?'human_preference':'v4_preference'];
  return value==='tie'?'同分 / 平局':value==='invalid'?'无法比较':value==='first'?row.first_model:value==='second'?row.second_model:'缺分';
}
function detail(t){
  return `<div class="task-detail"><h3>${esc(t.case_id)} · ${esc(t.title)}</h3><p class="note">首轮目标是每位评审对该题完成一轮四模型比较（5票），并不等于该题${t.candidates}个模型已全部对比。后续轮次继续计入偏好分析，但不增加首轮进度。</p>
    <h4>评审进度</h4><div class="table-wrap"><table><thead><tr><th>评审</th><th>首轮有效票 / 5</th><th>首轮状态</th><th>累计有效票</th><th>无法比较</th><th>与CC一致 / 可比较</th></tr></thead><tbody>${t.reviewers.map(r=>`<tr><td>${esc(r.reviewer_name)}</td><td>${r.first_cycle_votes} / 5</td><td>${r.first_cycle_complete?'完成':r.first_cycle_skipped?'已跳过':'待完成'}</td><td>${r.valid_votes}</td><td>${r.unable}</td><td>${r.agreed_votes} / ${r.comparable_votes}</td></tr>`).join('')}</tbody></table></div>
    <h4>逐模型覆盖与分数</h4><div class="table-wrap"><table><thead><tr><th>模型</th><th>CC v4（/53）</th><th>人评出现次数</th><th>胜 / 负 / 平</th><th>完整截图</th></tr></thead><tbody>${t.models.map(m=>`<tr><td>${esc(m.model_name)}</td><td>${m.cc_score??'缺分'}</td><td>${m.votes}</td><td>${m.wins} / ${m.losses} / ${m.ties}</td><td>${m.images}张</td></tr>`).join('')}</tbody></table></div>
    <h4>逐票偏好对照</h4>${t.comparisons.length?`<div class="table-wrap"><table><thead><tr><th>评审</th><th>模型一 · CC分</th><th>模型二 · CC分</th><th>人类选择</th><th>CC选择</th><th>是否一致</th><th>备注</th></tr></thead><tbody>${t.comparisons.map(v=>`<tr><td>${esc(v.reviewer_name)}</td><td>${esc(v.first_model)} · ${v.first_v4??'缺分'}</td><td>${esc(v.second_model)} · ${v.second_v4??'缺分'}</td><td>${esc(choice(v,'human'))}</td><td>${esc(choice(v,'cc'))}</td><td class="${v.agreement?'good':''}">${v.agreement===null?'不纳入':v.agreement?'一致':'不一致'}</td><td>${esc(v.comment||v.reason||'—')}</td></tr>`).join('')}</tbody></table></div>`:'<p class="note">该题尚无人评投票，不填0%一致率。</p>'}</div>`;
}
export function taskStatisticsCards(data){
  const s=data.summary;
  return `<div class="stats b2-stats" id="task-overview">${[
    ['已评题目',`${s.rated_tasks} / ${s.total_tasks}`,`${s.unrated_tasks}题尚无人评`],
    ['首轮完成题目',`${s.first_cycle_completed_tasks} / ${s.total_tasks}`,'当前全部参评人的该题首轮均已完成'],
    ['首轮有效票进度',`${s.first_cycle_votes} / ${s.first_cycle_target}`,`${s.reviewers}位评审 × ${s.total_tasks}题 × 5票`],
    ['累计有效人评票',s.valid_votes,`${s.unable}次无法比较不计入胜负`],
    ['CC v4评分',`${s.cc_scored} / ${s.candidates}`,'本轮冻结分数，0分正常计入'],
    ['完整截图产物',`${s.screenshots_ready} / ${s.candidates}`,'逐屏保留原图，不裁切或拉伸']
  ].map(([label,value,note])=>`<div class="stat"><span>${esc(label)}</span><strong>${value}</strong><span>${esc(note)}</span></div>`).join('')}</div>`;
}
export function agreementCard(data){
  const s=data.summary;
  return `<section class="card" id="human-cc-agreement"><h2>人类偏好与 CC v4 对照</h2><div class="agreement-grid"><div><p class="note">按实际投票汇总（micro）</p><p class="score">${pct(s.micro_agreement_rate)}</p><p>${s.agreed_votes} / ${s.comparable_votes}票一致</p></div><div><p class="note">各题等权平均（macro）</p><p class="score">${pct(s.macro_agreement_rate)}</p><p>仅含有可比较票的 ${s.macro_tasks} / ${s.total_tasks}题</p></div><div><p class="note">CC分数不同时的一致率</p><p class="score">${pct(s.directional_agreement_rate)}</p><p>${s.directional_agreed_votes} / ${s.directional_votes}票一致</p></div></div><p class="note">CC同分 ${s.cc_tie_votes}票单独计数：二选一人评与CC同分不算完全一致；右侧指标排除这些票。${s.missing_cc_votes}票缺分，${s.unable}次无法比较均不纳入一致率；未评题不补零。逐题分母与逐票记录见下表。当前是已收集样本的描述统计，不代表全${s.total_tasks}题或更广泛设计师群体的结论。</p></section>`;
}
export function taskTable(data,csvUrl){
  return `<section class="card" id="per-task-statistics"><div class="section-top"><div><h2>逐题评审进度与偏好一致性</h2><p class="note">每题独立统计；展开可看逐模型分数、每位评审进度和逐票对照。</p></div><a class="external" href="${esc(csvUrl)}" download>导出逐题 CSV</a></div><div class="task-filters"><input id="task-search" class="field" aria-label="搜索题目" placeholder="搜索题号或任务名" value="${esc(state.query)}"><select id="task-filter" class="field" aria-label="筛选评审进度">${[['all','全部题目'],['rated','已有投票'],['not-started','尚无投票'],['first-cycle-complete','首轮已完成']].map(([value,text])=>`<option value="${value}" ${state.filter===value?'selected':''}>${text}</option>`).join('')}</select><span id="task-filter-count" class="note"></span></div><div class="table-wrap"><table class="task-table"><thead><tr><th>题目</th><th>首轮票数 / 目标</th><th>已评模型</th><th>不同模型对</th><th>累计有效票</th><th>与CC一致 / 可比较</th><th>一致率</th><th>首轮状态</th></tr></thead><tbody>${data.tasks.map(t=>`<tr data-task="${esc(t.case_id)}"><td><button class="task-expand quiet" data-expand="${esc(t.case_id)}" aria-expanded="${state.expanded.has(t.case_id)}">${state.expanded.has(t.case_id)?'▾':'▸'} ${esc(t.case_id)} · ${esc(t.title)}</button></td><td>${t.first_cycle_votes} / ${t.first_cycle_target}</td><td>${t.evaluated_models} / ${t.candidates}</td><td>${t.unique_pairs} / ${t.possible_pairs}</td><td>${t.valid_votes}</td><td>${fraction(t)}</td><td>${pct(t.agreement_rate)}</td><td><span class="badge ${t.first_cycle_complete?'':'amber'}">${statuses[t.status]}</span></td></tr><tr data-task-detail="${esc(t.case_id)}" ${state.expanded.has(t.case_id)?'':'hidden'}><td colspan="8">${detail(t)}</td></tr>`).join('')}</tbody></table></div><p class="note">“首轮完成”按当前全部参评人计算；新增评审后目标会增加，各人的原有进度保留。已评模型和不同模型对只计算实际有效投票，不使用推断胜负。</p></section>`;
}
export function bindTaskTable(data){
  function filter(){let shown=0;for(const t of data.tasks){const visible=(!state.query||`${t.case_id} ${t.title}`.toLowerCase().includes(state.query.toLowerCase()))&&(state.filter==='all'||state.filter==='rated'&&t.valid_votes>0||state.filter==='not-started'&&!t.valid_votes||state.filter==='first-cycle-complete'&&t.first_cycle_complete);
    document.querySelector(`[data-task="${t.case_id}"]`).hidden=!visible;
    document.querySelector(`[data-task-detail="${t.case_id}"]`).hidden=!visible||!state.expanded.has(t.case_id);if(visible)shown++;}
    document.querySelector('#task-filter-count').textContent=`显示 ${shown} / ${data.tasks.length}题`;
  }
  document.querySelector('#task-search').oninput=e=>{state.query=e.target.value;filter();};
  document.querySelector('#task-filter').onchange=e=>{state.filter=e.target.value;filter();};
  document.querySelectorAll('[data-expand]').forEach(b=>{b.onclick=()=>{const id=b.dataset.expand;if(state.expanded.has(id))state.expanded.delete(id);else state.expanded.add(id);b.setAttribute('aria-expanded',state.expanded.has(id));b.textContent=`${state.expanded.has(id)?'▾':'▸'} ${id} · ${data.tasks.find(t=>t.case_id===id).title}`;filter();};});
  filter();
}
