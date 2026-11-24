const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let sortBy = 'opus55';
const percent = value => Number.isFinite(value) ? (value * 100).toFixed(2) + '%' : '—';

function table(data) {
  const selected = data.judges.find(j => j.id === sortBy) || data.judges[0];
  const lookups = new Map(data.judges.map(j => [j.id, new Map(j.rows.map(r => [r.model_id, r]))]));
  return `<table><thead><tr><th scope="col">生成模型</th>${data.judges.map(j => `<th scope="col" class="${j.id === selected.id ? 'judge-scores-selected' : ''}">${escape(j.name)}<br><span class="muted tiny">${j.scored_count}/${j.total_count} 份${j.complete ? ' · 已完成' : ''}</span></th>`).join('')}</tr></thead><tbody>${selected.rows.map(model => `<tr><th scope="row">${escape(model.model_name)}</th>${data.judges.map(j => {
    const row = lookups.get(j.id).get(model.model_id);
    return `<td class="${j.id === selected.id ? 'judge-scores-selected' : ''}"><strong>${percent(row.win_rate)}</strong><br><span class="muted tiny">${row.rank == null ? '待比较' : `第 ${row.rank} 名`} · ${row.wins ?? '—'} 胜 / ${row.ties ?? '—'} 平 / ${row.losses ?? '—'} 负<br>有效对局 ${row.compared_count ?? '—'}/${row.possible_pairs ?? '—'}<br>均分 ${Number.isFinite(row.mean_score) ? row.mean_score.toFixed(2) : '—'}/${data.max_score} · ${row.scored_count}/${row.total_count} 题</span></td>`;
  }).join('')}</tr>`).join('')}</tbody></table>`;
}

function agreementTable(data) {
  return `<div class="table-wrap" id="judge-agreement-table"><table><thead><tr><th scope="col">评分模型</th><th scope="col">人机一致率</th><th scope="col">一致 / 有效人评</th><th scope="col">覆盖题数 / 不重复对局</th><th scope="col">机器判平 / 人工判平</th><th scope="col">缺机评分排除</th></tr></thead><tbody>${data.judges.map(j => {
    const a = j.human_agreement;
    return `<tr><th scope="row">${escape(j.name)}</th><td><strong>${percent(a?.agreement_rate)}</strong></td><td>${a ? `${a.agreed} / ${a.compared}` : '—'}</td><td>${a ? `${a.cases} / ${a.unique_pairs}` : '—'}</td><td>${a ? `${a.machine_ties} / ${a.human_ties}` : '—'}</td><td>${a?.missing_scores ?? '—'}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

export function judgeScoresCard(data, localPath) {
  const selected = data.judges.some(j => j.id === sortBy) ? sortBy : data.judges[0].id;
  const invalid = data.judges.reduce((sum, j) => sum + j.invalid_count, 0);
  const observed = data.human_agreement;
  const links = [['/api/admin/judge-scores.csv','逐份评分'],['/api/admin/judge-pairs.csv','同题对局'],['/api/admin/judge-agreement.csv','人机一致明细']];
  const sourceNote=data.repeats===3?'各裁判独立评分 3 次取均值，已合入异常 case 的无 G0 重评；未匹配同一产物版本的评分排除。':'同一题内按总分两两比较。';
  return `<section class="card" id="judge-scores"><div class="section-top"><div><h2>同题两两胜率主榜</h2><p class="note">评分模型：${data.judges.map(j => escape(j.name)).join('、')} · 固定 v4 · 满分 ${data.max_score} 分</p></div><div class="judge-scores-exports">${links.map(([url,label]) => `<a class="external" href="${escape(localPath(url))}" download>${label} CSV</a>`).join('')}</div></div><div class="judge-scores-toolbar"><label for="judge-score-sort">按谁的胜率排序 <select id="judge-score-sort" aria-label="按评分模型胜率排序">${data.judges.map(j => `<option value="${escape(j.id)}"${j.id === selected ? ' selected' : ''}>${escape(j.name)}</option>`).join('')}</select></label><span class="note">${data.cases} 题 × ${data.judges[0].rows.length} 个生成模型 · ${data.candidates} 份相同产物</span></div><div class="table-wrap" id="judge-score-table">${table(data)}</div><p class="note">${escape(sourceNote)}高分胜、同分平。胜率 =（胜场 + 0.5 × 平场）/ 有效对局数，各评分模型独立排名。同胜率并列；任一方缺分则排除该对局。均分保留作参考，真实 0 分计入。${invalid ? `${invalid} 份结果未通过校验，未计入。` : ''}</p><h3>同一对局的人机一致率</h3><p class="note">${observed ? `当前有效人工总评 ${observed.eligible_votes} 票 · ${observed.reviewers} 位评审 · ${observed.cases} 题 · ${observed.unique_pairs} 组不重复对局。` : '正在读取有效人评。'}仅比较同题、同产物版本且人工实际评过的对局。</p>${agreementTable(data)}<p class="note">一致率 = 人机判断相同的票数 / 人机均有有效判断的票数。平局仅与平局一致；不同评审或轮次的实际投票分别计数。同一票只计一次，改判前的旧票、停用评审、无法判断、逐屏评价及系统推导关系不计入。人工没评过的对局不计入，暂无有效人评时显示“—”。</p><p class="note">下方既有的人评与 V4 统计仍使用冻结的 Opus 5.5 分数。本表每分钟刷新。</p></section>`;
}

export function bindJudgeScores(app, data) {
  const select = app.querySelector('#judge-score-sort');
  if (!select || !data) return;
  select.onchange = () => {
    sortBy = select.value;
    app.querySelector('#judge-score-table').innerHTML = table(data);
  };
}
