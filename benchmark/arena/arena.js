import {identityProgressLines} from './review-progress.js';
import {createImageWarmup} from './image-warmup.js';
import {renderTaskLobby} from './task-lobby.js';
import {leavePairScreens} from './pair-screens.js';
import {renderSortingPause,renderSortingComplete,renderSortingAdmin} from './incremental-ranking.js';
import {taskStatisticsCards, agreementCard, taskTable, bindTaskTable} from './task-statistics.js';
import {judgeScoresCard,bindJudgeScores} from './judge-scores.js';
import {renderScreenMarksAdmin} from './screen-marks.js';
const app = document.querySelector('#app');
const basePath = document.querySelector('meta[name="arena-base"]')?.content || '';
const localPath = (url) => `${basePath}${url}`;
const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (n) => n == null ? '—' : `${(n * 100).toFixed(1)}%`;
const number = (n, digits = 2) => n == null ? '—' : Number(n).toFixed(digits);
let session, current, busy = false, adminTimer, imageSet = [], imageAt = 0;
let leaderboardTimer, imageWarmup, imageRequest=0;
const methods = {};
async function api(url, body) {
  const response = await fetch(localPath(url), body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '网络请求失败，请重试');
  return data;
}
function toast(message) {
  const t = document.querySelector('#toast'); t.textContent = message; t.classList.remove('hidden');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add('hidden'), 4500);
}
function link(url, text, className = '') { return `<a class="${className}" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(text)}</a>`; }
function showIdentity() {
  document.querySelector('#identity').textContent = session.label || '';
  document.querySelector('#logout').classList.toggle('hidden', !session.role);
}
document.querySelector('#logout').onclick = async () => { imageWarmup?.stop(); await api('/api/logout', {}); localStorage.removeItem('arena-active-profile'); location.assign(localPath('/?view=review')); };
async function leaderboard() {
  clearTimeout(leaderboardTimer);
  document.title = 'Figma 模型评分排名 · Design Arena';
  document.querySelector('.brand small').textContent = 'Figma 设计模型评分';
  const d = await api('/api/leaderboard');
  app.innerHTML = `<section class="leaderboard"><div class="leaderboard-heading"><div><div class="eyebrow">CC Evaluation</div><h1>模型评分排名</h1><p class="muted">Opus 5.5 评审 · 固定 v4 量表 · 满分 ${d.max_score} 分</p></div><button id="refresh-ranking" class="quiet">刷新排名 ↻</button></div><div class="card leaderboard-card"><table class="leaderboard-table"><thead><tr><th>排名</th><th>模型</th><th>平均分</th></tr></thead><tbody>${d.rows.map((m) => `<tr class="${m.rank === 1 ? 'leading-model' : ''}"><td><span class="place ${m.rank && m.rank <= 3 ? 'place-top' : ''}">${m.rank === null ? '—' : String(m.rank).padStart(2, '0')}</span></td><td class="leaderboard-model">${escape(m.model_name)}</td><td class="leaderboard-score">${number(m.mean_score)}</td></tr>`).join('')}</tbody></table></div><div class="leaderboard-footer"><p>${d.complete ? '完整评测均分，所有模型均已完成全部题目评分；0分计入均分。' : '阶段均分，按各模型已完成评分的题目计算；0分计入均分。'}</p><span>${d.updated_at ? `更新于 ${new Date(d.updated_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京）` : '等待评分'}</span></div></section>`;
  document.querySelector('#refresh-ranking').onclick = () => leaderboard().catch((e) => toast(e.message));
  leaderboardTimer = setTimeout(() => { if (document.visibilityState === 'visible') leaderboard().catch((e) => toast(e.message)); }, 60000);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('链接已复制'); }
  catch { const el = document.createElement('textarea'); el.value = text; document.body.append(el); el.select();
    const done = document.execCommand('copy'); el.remove(); toast(done ? '链接已复制' : '复制失败，请长按链接复制'); }
}
function legacyLanding(error = '') {
  app.innerHTML = `<div class="card landing"><div class="eyebrow">Human preference evaluation</div><h1>让设计师来选<br>更好的设计。</h1><p>同一道设计任务，两份匿名的 Figma 产物。<br>完整查看后，选择你更愿意交付给客户的一份。</p><ol><li>使用组织者提供的个人评审链接进入。</li><li>先阅读任务与规范，再查看两份03 Workspace。</li><li>独立投票，进度自动保存，随时回来继续。</li></ol><p class="note">每位评审使用各自的链接；请勿共用。需要 Figma 查看权限时，请向组织者申请。</p><form id="access-form" class="access-form"><input class="field" name="access" aria-label="评审链接或访问码" placeholder="粘贴评审链接或访问码" required autocomplete="off"><button class="primary">进入</button></form><div id="login-error" class="inline-error">${escape(error)}</div></div>`;
  document.querySelector('#access-form').onsubmit = async (e) => {
    e.preventDefault(); let access = new FormData(e.target).get('access').trim();
    if (access.includes('#')) access = new URLSearchParams(access.split('#')[1]).get('invite') || new URLSearchParams(access.split('#')[1]).get('admin') || access;
    try { await api('/api/session', { access }); await init(); }
    catch (err) { document.querySelector('#login-error').textContent = err.message; }
  };
}
function savedProfiles() {
  try { return JSON.parse(localStorage.getItem('arena-profiles')||'[]').filter(p=>p.name&&/^[A-Za-z0-9_-]{40,128}$/.test(p.secret)); } catch { return []; }
}
function newProfileSecret() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
async function enterProfile(name, secret) {
  await api('/api/reviewers/enroll', {name,profile_secret:secret});
  const profiles=savedProfiles().filter(p=>p.secret!==secret);profiles.push({name,secret});
  localStorage.setItem('arena-profiles',JSON.stringify(profiles));localStorage.setItem('arena-active-profile',secret);
  await init();
}
async function existingReviewerLanding(error='') {
  app.innerHTML='<section class="card landing"><h1>选择你的评审身份</h1><p class="muted">正在读取已有进度…</p></section>';
  let reviewers;
  try { ({reviewers}=await api('/api/reviewers/existing')); }
  catch(err) {
    app.innerHTML=`<section class="card landing"><h1>暂时无法读取评审身份</h1><p class="inline-error">${escape(err.message)}</p><button id="retry-reviewer-list">重新加载</button></section>`;
    document.querySelector('#retry-reviewer-list').onclick=()=>existingReviewerLanding();return;
  }
  app.innerHTML=`<section class="card landing"><div class="eyebrow">继续已有评审</div><h1>选择你的评审身份</h1><p>请选择你自己的身份，继续之前的题目和进度。</p><div class="saved-profiles" aria-label="已有评审身份">${reviewers.map(r=>`<button class="quiet" data-existing-reviewer="${escape(r.id)}"><strong>${escape(r.label)}</strong><br><span class="muted tiny">${identityProgressLines(r.progress).map(line=>`<span class="identity-progress-line">${escape(line)}</span>`).join('')}</span></button>`).join('')||'<p class="note">当前没有可继续的评审身份。</p>'}</div><p class="note">选择身份不会新建账号，已保存的投票、评分和待复核状态继续保留。</p><div id="login-error" class="inline-error">${escape(error)}</div>${session.open_registration?'<button id="new-reviewer" class="quiet">新增评审</button>':''}</section>`;
  document.querySelectorAll('[data-existing-reviewer]').forEach(button=>{
    button.onclick=async()=>{
      document.querySelectorAll('[data-existing-reviewer],#new-reviewer').forEach(item=>item.disabled=true);
      try {
        await api('/api/reviewers/select-existing',{reviewer_id:button.dataset.existingReviewer});
        localStorage.removeItem('arena-active-profile');await init();
      } catch(err) { await existingReviewerLanding(err.message); }
    };
  });
  const add=document.querySelector('#new-reviewer');
  if(add)add.onclick=()=>{
    landing();
    const back=document.createElement('button');back.className='quiet';back.textContent='返回已有评审身份';back.onclick=()=>existingReviewerLanding();
    document.querySelector('#app .landing').append(back);
  };
}
function landing(error='') {
  if(!session?.open_registration)return legacyLanding(error);
  const linking=session.role==='reviewer'&&!session.profile_registered,profiles=savedProfiles();
  const prefill=linking?session.label:localStorage.getItem('ui-eval-reviewer')||'',formSecret=newProfileSecret();
  app.innerHTML=`<div class="card landing"><div class="eyebrow">Human preference evaluation</div><h1>让设计师来选<br>更好的设计。</h1><p>同一道任务，两份匿名产物。<br>先阅读中文需求，完整查看后，选择更值得交付的一份。</p><ol><li>首次填写姓名或内部昵称进入。</li><li>${session.sorting_algorithm?'每题全部模型参与，逐屏查看后比较，逐步排出完整顺序。':'每题随机4份稿件，完成5次二选一。'}</li><li>进度自动保存，可随时回来继续。</li></ol><form id="profile-form"><label for="reviewer-name">姓名 / 内部昵称</label><div class="access-form"><input id="reviewer-name" class="field" name="name" placeholder="填写姓名或内部昵称" required maxlength="40" autocomplete="name" value="${escape(prefill)}"><button class="primary">${linking?'保存姓名并继续':'开始评审'}</button></div></form><p class="note">${linking?'当前个人链接的投票和进度将保留，填写姓名即可继续。':'无需密码，身份保存在当前浏览器。请使用自己的身份；共用电脑时先退出再切换。'}</p>${!linking&&profiles.length?`<div class="saved-profiles"><p class="note">继续此浏览器中保存的评审身份：</p>${profiles.map((p,i)=>`<button data-profile="${i}">${escape(p.name)} · 继续</button>`).join('')}</div>`:''}<div id="login-error" class="inline-error">${escape(error)}</div><details class="legacy-access"><summary>使用之前的个人链接 / 管理码</summary><form id="access-form" class="access-form"><input class="field" name="access" aria-label="评审链接或访问码" placeholder="粘贴旧链接或访问码" required autocomplete="off"><button>进入</button></form></details></div>`;
  document.querySelector('#profile-form').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;
    try {await enterProfile(new FormData(e.target).get('name').trim(),formSecret);}
    catch(err){b.disabled=false;document.querySelector('#login-error').textContent=err.message;}
  };
  document.querySelectorAll('[data-profile]').forEach(b=>{b.onclick=async()=>{b.disabled=true;try{const p=profiles[Number(b.dataset.profile)];await enterProfile(p.name,p.secret);}catch(e){b.disabled=false;document.querySelector('#login-error').textContent=e.message;}};});
  document.querySelector('#access-form').onsubmit=async e=>{e.preventDefault();let access=new FormData(e.target).get('access').trim();
    if(access.includes('#')){const params=new URLSearchParams(access.split('#')[1]);access=params.get('invite')||params.get('admin')||access;}
    try{await api('/api/session',{access});await init();}catch(err){document.querySelector('#login-error').textContent=err.message;}
  };
}
async function admin() {
  await adminContent();
  if(session.screen_marking)await renderScreenMarksAdmin({app,api,localPath});
}
async function adminContent() {
  const d = await api('/api/admin/dashboard'), s = d.snapshot, r = d.ranking;
  if(d.sorting){
    try{d.cohort_progress=(await api('/api/admin/cohort-progress')).cohorts;}catch(e){d.cohort_progress_error=e.message;}
    renderSortingAdmin({data:d,app,localPath,ccCard:ccRankingCard,agreementCard,refresh:()=>admin().catch(e=>toast(e.message))});
    bindJudgeScores(app,d.judge_scores);
    clearTimeout(adminTimer);adminTimer=setTimeout(()=>{if(document.visibilityState==='visible')admin().catch(()=>{});},60000);return;
  }
  if(s.protocol==='design-arena-tournament/v3')return tournamentAdmin(d);
  if(s.protocol==='design-arena-b2/v2')return b2Admin(d);
  const audit = d.delivery_audit, counts = audit?.counts || {};
  const modelCodes = new Map(r.rows.map((m, i) => [m.model_id, String(i + 1)]));
  const rankRows = r.rows.map((m, i) => `<tr><td class="rank">${m.votes ? String(i + 1).padStart(2, '0') : '—'}</td><td class="model-name"><strong>${escape(m.model_name)}</strong></td><td><span class="score">${number(m.score)}</span></td><td class="muted">${m.votes ? `${number(m.lower)} ~ ${number(m.upper)}` : '等待有效投票'}</td><td>${m.wins}</td><td>${m.losses}</td><td>${m.votes}</td><td>${pct(m.win_rate)}</td><td>${m.evaluated_cases} / ${m.candidates}</td></tr>`).join('');
  app.innerHTML = `<div class="page-heading"><div><div class="eyebrow">Arena overview</div><h1>设计盲评 · 管理台</h1><p class="muted">${escape(s.name)} · 稿件已冻结，后台补跑不会替换本轮版本。</p></div><span class="badge">${d.valid_votes ? '投票进行中 · 暂定排名' : '等待设计师投票'}</span></div>
    <div class="stats"><div class="stat"><span>固定候选产物</span><strong>${s.candidates}</strong><span>${s.cases}道任务 · ${s.models}个模型</span></div><div class="stat"><span>同题比较组合</span><strong>${s.pairs}</strong><span>2位评审独立完成，共${s.target_votes}次判断</span></div><div class="stat"><span>已记录有效票</span><strong>${d.valid_votes}</strong><span>${d.unable}次无法比较，未计入胜负</span></div><div class="stat"><span>双人偏好一致率</span><strong>${pct(r.agreement.rate)}</strong><span>${r.agreement.compared}组已获得两位评审的有效票</span></div></div>
    ${audit ? `<section class="card"><div class="section-top"><h2>03交付核查</h2><a class="external" href="${escape(localPath('/api/admin/delivery-audit'))}" download>下载逐条核查记录</a></div><div class="notice">已确认${(counts.partial || 0) + (counts.empty || 0) + (counts.wrong_workspace || 0)}份存在缺页、空画板或页面错误；${counts.unverified || 0}份缺少可用核查记录；${counts.uncertain_content || 0}份内容证据不足。另${counts.no_obvious_omissions || 0}份通过画板清单与内容存在检查，这不代表设计、交互或任务细节已全部完成。</div><p class="note">105是候选轨迹数，不是完成设计数。截图覆盖完整也不代表设计完整。核查记录只供组织者查看，保留本轮稿件与已有投票，未给盲评人增加模型或检查结果提示。</p></section>` : ''}
    <section class="card"><div class="section-top"><h2>发给设计同学的入口</h2><span class="muted tiny">两人独立评审 · 同一组左右互换</span></div><div class="invite-grid">${d.reviewers.map((reviewer) => `<div class="invite"><div><strong>${escape(reviewer.label)}</strong><p>已处理${reviewer.done}/${reviewer.total}组 · 有效${reviewer.voted}票 · 待处理${reviewer.remaining}组</p></div>${reviewerInviteButton(reviewer)}</div>`).join('')}</div><p class="note">请分别发送两个入口，评审页面不显示模型身份、AI分数或另一人的选择。管理入口请由组织者保留。</p></section>
    <section class="card"><div class="section-top"><h2>模型排名与票数</h2><div class="actions"><button id="refresh">刷新</button><a class="external" href="${escape(localPath('/api/admin/export'))}" download>导出投票与结果 JSON</a></div></div><div class="table-wrap"><table><thead><tr><th>排名</th><th>模型</th><th>TrueSkill 分</th><th>不确定区间 μ±2σ</th><th>胜票</th><th>负票</th><th>有效对局</th><th>胜率</th><th>已评题目 / 候选题目</th></tr></thead><tbody>${rankRows}</tbody></table></div><p class="note">分数越高表示在当前有效对局中更受偏好，初始μ=25。没有投票时不展示先验分。比较仅在同题内进行；全局TrueSkill汇总这些偏好，并考虑对手强度。</p><div class="notice">本轮各模型覆盖题目不齐，排名为阶段性结果，不能替代完整30题横评。${r.connected ? '当前有效比较图已连通。' : '当前有效比较图尚未覆盖并连通所有模型。'} ${s.recovered_evidence_pending}份历史找回稿的截图仍待处理；共${s.live_view_required}份需直接查看完整Figma后确认可评。无法访问不当作失败。</div></section>
    <div class="two-col"><section class="card"><h2>谁赢了谁</h2><p class="note">行模型胜过列模型的票数。横线表示暂无有效比较。</p><div class="table-wrap"><table class="matrix"><thead><tr><th>胜方 ↓ / 对手 →</th>${r.rows.map((m) => `<th>${modelCodes.get(m.model_id)}</th>`).join('')}</tr></thead><tbody>${r.rows.map((m) => `<tr><th>${modelCodes.get(m.model_id)}</th>${r.rows.map((n) => { const count = r.matrix[`${m.model_id}:${n.model_id}`] || 0; return `<td class="${count ? 'has-votes' : ''}">${m.model_id === n.model_id ? '·' : count || '—'}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div><div class="legend">${r.rows.map((m) => `<span>${modelCodes.get(m.model_id)} · ${escape(m.model_name)}</span>`).join('')}</div></section><section class="card"><h2>无法比较的反馈</h2>${d.reports.length ? d.reports.slice(-12).reverse().map((item) => `<div class="report"><strong>${escape(item.case_id)} · ${escape(item.reviewer)}</strong><p>${escape(reasonLabel(item.reason))}${item.comment ? ` · ${escape(item.comment)}` : ''}</p><span class="muted">${new Date(item.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</span></div>`).join('') : '<div class="empty">尚无反馈</div>'}</section></div>
    <details class="card"><summary>查看30道题的覆盖与投票进度</summary><div class="table-wrap"><table><thead><tr><th>题目</th><th>候选稿件</th><th>参与模型</th><th>有效票 / 目标判断</th></tr></thead><tbody>${d.coverage.map((c) => `<tr><td><strong>${escape(c.case_id)} · ${escape(c.title)}</strong></td><td>${c.candidates}</td><td class="tiny">${c.models.map(escape).join(' / ')}</td><td>${c.votes} / ${c.pairs * 2}</td></tr>`).join('')}</tbody></table></div></details>
    <details class="card"><summary>统计方法与版本</summary><p class="note">${escape(r.explanation)}</p><p class="note">采用同题匿名A/B、二选一、双方完整查看后投票的流程。全局TrueSkill用于当前稀疏样本的阶段排名；与UI-Bench的逐题更新后跨题均分有所区别。导出中同时包含每个模型已获投票题目的逐题均分与覆盖数。固定v4的自动评分保持独立。</p><p class="note">固定于北京时间 ${new Date(s.frozen_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · 快照 ${escape(s.hash.slice(0, 16))}</p><p class="method-links">${link(r.reference, 'UI-Bench 原文')} · ${link('https://trueskill.org/', 'TrueSkill 参数与方法')}</p></details><p class="footer-note">投票保存在独立数据库 · 自动保存 · 最后更新 ${new Date(d.updated_at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京）</p>`;
  document.querySelectorAll('[data-copy]').forEach((button) => { button.onclick = () => copy(button.dataset.copy); });
  document.querySelector('#refresh').onclick = () => admin().catch((e) => toast(e.message));
  clearTimeout(adminTimer); adminTimer = setTimeout(() => { if (document.visibilityState === 'visible') admin().catch(() => {}); }, 60000);
}
function reviewerInviteButton(reviewer) {
  return reviewer.invite ? `<button data-copy="${escape(new URL(reviewer.invite,location.origin).href)}">复制评审链接</button>`
    : '<span class="muted tiny">个人评审链接由组织者提供</span>';
}
function ccRankingCard(d) {
  if(d.judge_scores)return judgeScoresCard(d.judge_scores,localPath);
  if(d.judge_scores_error)return `<section class="card" id="judge-scores"><h2>多模型自动评分对照</h2><p class="muted">${escape(d.judge_scores_error)}</p></section>`;
  const cc = d.cc_leaderboard;
  if (!cc) return `<section class="card" id="cc-ranking"><h2>CC v4 评分排名</h2><p class="muted">${escape(d.cc_leaderboard_error || 'CC评分来源尚未配置')}</p></section>`;
  const updated = cc.updated_at ? new Date(cc.updated_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京）' : '等待评分';
  return `<section class="card" id="cc-ranking"><div class="section-top"><div><h2>CC v4 评分排名</h2><p class="note">${escape(cc.judge)} · 固定 v4 · 满分 ${cc.max_score} 分 · 已评分 ${cc.scored_count} / ${cc.total_count} 份</p></div></div><div class="table-wrap"><table><thead><tr><th>排名</th><th>模型</th><th>平均分（/ ${cc.max_score}）</th><th>已评分 / 计划题数</th></tr></thead><tbody>${cc.rows.map(m => `<tr><td class="rank">${m.rank ?? '—'}</td><td class="model-name"><strong>${escape(m.model_name)}</strong></td><td class="score">${number(m.mean_score)}</td><td>${m.scored_count} / ${m.total_count}</td></tr>`).join('')}</tbody></table></div><p class="note">${cc.complete?'所有模型均已完成全部题目评分，按完整评测计算均分，真实0分计入。':'按已完成的正式 v4 评分计算均分，真实0分计入，缺分不补零；各模型覆盖可能不同，当前为阶段排名。'}每分钟自动刷新。</p><p class="note">最近评分更新：${escape(updated)}。此榜实时汇总；下方人评与V4一致性仍使用本轮冻结的稿件和分数。</p></section>`;
}
function b2Admin(d) {
  const s=d.snapshot,r=d.ranking,stats=d.daily_statistics,agreement=d.v4_comparison;
  const tiles=[['已接入模型',stats.models],['导入题数',stats.tasks],['通过完整性检查',stats.qualified],['V4 评分完成',stats.v4_scored],['已创建 Pair',stats.pairs],['有效人评票',`${stats.valid_votes} / ${s.target_votes}`]];
  app.innerHTML=`<div class="page-heading"><div><div class="eyebrow">Design Arena · B2</div><h1>设计盲评 · 管理台</h1><p class="muted">${escape(s.name)} · 本轮稿件与分数版本已固定</p></div><span class="badge">${d.valid_votes?'盲评进行中':'等待设计师投票'}</span></div>
    <div class="stats b2-stats">${tiles.map(([label,value])=>`<div class="stat"><span>${label}</span><strong>${escape(value)}</strong></div>`).join('')}</div>
    ${ccRankingCard(d)}
    <section class="card"><h2>评测安排</h2><p>每题 4 组比较，覆盖该题全部可用模型；两位设计师各自完成 ${s.pairs} 组，共计划收集 ${s.target_votes} 票有效评价。</p><p class="note">当前接入 ${s.models} 个模型。配对同时均衡模型曝光和对手次数，只比较同一道题的产物。支持左胜、右胜、平局和无效；无效反馈可重新分配。</p>${d.requirements ? `<p class="note">${d.requirements.cases}题中文需求已就绪：设计师可直接查看任务目标、交付画板清单、逐屏要求与英文原文对照。</p>` : ''}</section>
    <section class="card"><div class="section-top"><h2>设计师入口与进度</h2><span class="muted tiny">同一组左右互换 · 独立评价</span></div><div class="invite-grid">${d.reviewers.map(v=>`<div class="invite"><div><strong>${escape(v.label)}</strong><p>有效 ${v.voted} / ${v.total} 票 · 平局 ${v.ties} · 无效 ${v.skipped} · 待处理 ${v.remaining} 组</p></div>${reviewerInviteButton(v)}</div>`).join('')}</div><p class="note">评审端隐藏模型名称、V4 分数和另一位设计师的选择。组织者请保留管理链接。</p></section>
    <section class="card"><div class="section-top"><h2>人类偏好排名</h2><div class="actions"><button id="refresh">刷新</button><a class="external" href="${escape(localPath('/api/admin/export'))}" download>完整数据 JSON</a><a class="external" href="${escape(localPath('/api/admin/export.csv'))}" download>人评 × V4 CSV</a></div></div><div class="table-wrap"><table><thead><tr><th>排名</th><th>模型</th><th>偏好胜率</th><th>胜</th><th>负</th><th>平局</th><th>有效对局</th><th>已评题目 / 候选题目</th></tr></thead><tbody>${r.rows.map(m=>`<tr><td class="rank">${m.rank??'—'}</td><td class="model-name"><strong>${escape(m.model_name)}</strong></td><td class="score">${pct(m.win_rate)}</td><td>${m.wins}</td><td>${m.losses}</td><td>${m.ties}</td><td>${m.votes}</td><td>${m.evaluated_cases} / ${m.candidates}</td></tr>`).join('')}</tbody></table></div><p class="note">${escape(r.explanation)}</p><p class="note">模型的可用题目可能不同。${r.connected?'有效比较图已连通。':'有效比较图尚未覆盖并连通全部模型。'}未收齐有效票时，请结合题目覆盖理解阶段排名。</p></section>
    <div class="two-col"><section class="card"><h2>两位设计师的一致性</h2><p class="score">${pct(r.agreement.rate)}</p><p class="note">${r.agreement.agreed} / ${r.agreement.compared} 组独立判断一致；两人都判平局也计为一致。</p></section><section class="card"><h2>人类偏好与 V4 对照</h2><p class="score">${pct(agreement.agreement_rate)}</p><p class="note">${agreement.agreed_votes} / ${agreement.comparable_votes} 票与同一份产物的 V4 排序一致；${agreement.missing_v4_votes} 票缺少完整 V4 对照。当前 ${s.candidates-stats.v4_scored} 份产物未有正式 V4 分数。</p><p class="note">仅比较相同题目、相同 run 的分数；V4 同分记为平局，无效票和缺分不填零。</p></section></div>
    <details class="card"><summary>逐题覆盖与有效票</summary><div class="table-wrap"><table><thead><tr><th>题目</th><th>可用产物</th><th>参与模型</th><th>比较组</th><th>有效票 / 目标</th></tr></thead><tbody>${d.coverage.map(c=>`<tr><td>${escape(c.case_id)} · ${escape(c.title)}</td><td>${c.candidates}</td><td class="tiny">${c.models.map(escape).join(' / ')}</td><td>${c.pairs}</td><td>${c.votes} / ${c.pairs*2}</td></tr>`).join('')}</tbody></table></div></details>
    <section class="card"><h2>无效反馈</h2>${d.reports.length?d.reports.slice(-12).reverse().map(v=>`<div class="report"><strong>${escape(v.case_id)} · ${escape(v.reviewer)}</strong><p>${escape(reasonLabel(v.reason))}${v.comment?' · '+escape(v.comment):''}</p></div>`).join(''):'<p class="muted">尚无反馈</p>'}</section><p class="footer-note">固定于 ${new Date(s.frozen_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}（北京） · 快照 ${escape(s.hash.slice(0,16))}</p>`;
  document.querySelectorAll('[data-copy]').forEach(b=>{b.onclick=()=>copy(b.dataset.copy);});
  document.querySelector('#refresh').onclick=()=>admin().catch(e=>toast(e.message));
  clearTimeout(adminTimer);adminTimer=setTimeout(()=>{if(document.visibilityState==='visible')admin().catch(()=>{});},60000);
}
function reasonLabel(reason) { return ({ access: 'Figma无法打开 / 没有权限', 'incomplete-view': '无法确认完整03产物', 'identity-leak': '发现模型身份信息', other: '其他问题' })[reason] || reason; }
function deliveryCard(d){
  if(!d.external_delivery)return '';
  return `<section class="card"><h2>外部交付批次</h2>${d.external_delivery.update_note?`<p class="note">${escape(d.external_delivery.update_note)}</p>`:""}<p>本批 ${d.snapshot.cases}题 × ${d.snapshot.models}模型，共 ${d.snapshot.candidates}份产物；CC为交付包中的Opus 5.5 / fixed_v4结果，0分计入统计。</p><p class="note">截图已校验PNG、尺寸和SHA-256，按交付清单冻结。交付包未包含原始推理trace，本次未独立认证屏数完整性；不会标记为原流水线的trace/屏数验收通过。低分及不完整产物保留参与比较。</p><p class="note">${d.review_mode==='screenshots-only'?'评审端仅展示匿名截图；运行副本链接保留在管理导出中。':'评审端展示匿名A/B截图及03产物Figma入口；Figma文件标题和所有者等信息可能暴露身份。'}原始模板可查看；原型交互和图层质量不能仅凭截图核验。</p></section>`;
}
function screenComparisonCard(d){
  const s=d.screen_comparison;if(!s)return '';
  return `<section class="card"><div class="section-top"><h2>逐屏比较 → 整体选择</h2><a class="external" href="${escape(localPath('/api/admin/screens.csv'))}" download>导出逐屏记录 CSV</a></div><p>已开始 ${s.started_comparisons} 场逐屏比较，保存 ${s.saved_screens} 条逐屏记录。按任务要求的产品屏名称配对，可手动交换；缺屏及同名重复单独提示。</p>${s.selection?`<p>本批 ${s.selection.product_screens} 张产品屏截图参与比较；${s.selection.excluded_boards} 张组件、规范、素材或未匹配画板单独保留，不计产品屏数。</p>`:''}<p class="note">逐屏支持A更好、B更好、差不多及无法对应/判断。全部记录后，设计师独立确认整份产物的选择；整体可以与逐屏多数不同。每场仅整体选择计一张BT票，逐屏记录不增加BT票数或CC一致率的分母。历史整体票保留，不补造逐屏记录；完整JSON保留图片校验值、对应调整和修改历史。</p></section>`;
}
function samplingCard(d) {
  const sampling=d.sampling;
  if(!sampling)return '';
  const p=sampling.policy,active=p.algorithm==='active-fisher-information/v1';
  return `<section class="card" id="sampling-policy"><div class="section-top"><h2>模型与初赛配对采样</h2><span class="badge">${active?'主动采样 · Active sampling':'均匀随机采样'}</span></div>${active?`<p>每次分配新一轮时，只根据已有人工票计算四模型组合和初赛配对的预计信息增益；${Math.round(p.exploration_fraction*100)}%均匀探索，其余按信息增益加权抽样。仍是同题4模型、5场比较，所有实际票等权进入BT。</p><p class="note">更有助于减少排名不确定性的组合更容易被抽到；所有组合都保留被抽中的机会。用于采样的数值稳定项不加入榜单评分，也不生成虚拟票。CC分数不参与抽签。</p><p class="note">这是按DesignArena公开原则实现的本地方法，官方具体采样公式和权重尚未取得；本地探索率、温度 ${p.temperature}、稳定项 ${p.prior_precision} 均可审计，不宣称与其私有实现完全相同。</p>`:'<p>四个模型不放回均匀抽取，初赛配对随机；当前未使用基于人工票的信息增益加权。</p>'}<p class="note">已分配轮次：均匀采样 ${sampling.assigned_counts['uniform-four-without-replacement']||0} 轮 · 主动采样 ${sampling.assigned_counts['active-fisher-information/v1']||0} 轮。策略切换只影响新分配，已开始的轮次保持原抽签。</p><p class="note">完整JSON保留每轮采样策略、依据的人工票、全部候选配置概率和选中配置的概率，便于复核。人评与CC的一致率按实际抽样票统计，不等于所有模型对均匀评测的一致率。题目仍按本轮题目循环覆盖。</p>${link('https://notes.designarena.ai/methodology/','DesignArena 主动采样说明')}</section>`;
}
function tournamentAdmin(d) {
  const s=d.snapshot,r=d.ranking,cc=d.v4_comparison,ts=d.tournaments||[],single=d.reviewers.length===1;
  const status={ 'awaiting-connected-comparisons':'等待比较覆盖全部模型', 'separated-no-finite-mle':'当前胜负完全分离，继续收集交叉胜负后才可估计有限BT排名', converged:'BT迭代已收敛', 'iteration-limit':'已达200次迭代上限，分数暂未收敛' }[r.status];
  app.innerHTML=`<div class="page-heading"><div><div class="eyebrow">DesignArena · Four-model tournament</div><h1>设计盲评 · 管理台</h1><p class="muted">${escape(s.name)} · ${s.cases}题 × ${s.models}模型 · ${d.reviewers.length} 位设计师 · 产物与CC分数已冻结</p></div><span class="badge">独立新轮 · 持续收票</span></div>
    ${taskStatisticsCards(d.task_statistics)}
    ${ccRankingCard(d)}
    ${deliveryCard(d)}
    ${screenComparisonCard(d)}
    <section class="card"><h2>对战规则</h2><p>同一道题抽取4个不同模型：两场初赛 → 胜者对战 → 败者对战 → 中间两名对战。每轮5次整体二选一，形成4份稿件的顺序；只把实际5张整体票送入Bradley–Terry，每票等权。</p><p class="note">${single?'由一位设计师完成全部评审。':'参评设计师独立抽签和投票。'}每完成 ${s.cases} 道题、${s.cases*5} 次整体选择，再打乱任务开启下一轮；逐屏选择次数另计。${d.screen_comparison?'无法比较时保存反馈并跳过当前四模型轮次，此前有效票保留，不指定后续胜负。':'不能完整比较时暂停当前轮，恢复后继续，不随机指定胜负。'}已有旧轮投票已归档，本轮独立计分。</p></section>
    ${samplingCard(d)}
    <section class="card"><div class="section-top"><h2>设计师入口与进度</h2><div class="actions"><a class="external" href="${escape(localPath('/?view=review'))}">进入统一评审入口 →</a><button data-copy="${escape(new URL(localPath('/?view=review'),location.origin).href)}">复制统一入口</button></div></div><p class="note">首次填写姓名或内部昵称，各人独立抽签和保存进度。原有评审链接仍可继续。评审端隐藏模型名称、CC分数和其他人的选择。</p><div class="invite-grid">${d.reviewers.map(v=>`<div class="invite"><div><strong>${escape(v.label)}</strong><p>完成 ${v.completed_sessions} 轮${v.skipped_sessions?` · 跳过 ${v.skipped_sessions} 轮`:''} · 有效 ${v.voted} 票 · 第 ${v.cycle} 次任务覆盖${v.blocked?' · 当前轮待处理反馈':''}</p></div></div>`).join('')}</div></section>
    <section class="card"><div class="section-top"><h2>Bradley–Terry 偏好排名</h2><div class="actions"><button id="refresh">刷新</button><a class="external" href="${escape(localPath('/api/admin/export'))}" download>完整轮次与投票 JSON</a><a class="external" href="${escape(localPath('/api/admin/export.csv'))}" download>人评 × V4 CSV</a></div></div><div class="notice">${escape(status)}。${r.iterations} 次迭代。每模型少于50场为待积累，50～199场为初步结果；${single?'当前为单设计师评审，排名反映该设计师的偏好。':'排名反映本轮参评设计师的偏好。'}</div><div class="table-wrap"><table><thead><tr><th>排名</th><th>模型</th><th>BT Rating</th><th>胜率</th><th>胜 / 负</th><th>有效对局</th><th>已评题目 / 候选题目</th><th>状态</th></tr></thead><tbody>${r.rows.map(m=>`<tr><td class="rank">${m.rank??'—'}</td><td class="model-name"><strong>${escape(m.model_name)}</strong></td><td class="score">${number(m.rating)}</td><td>${pct(m.win_rate)}</td><td>${m.wins} / ${m.losses}</td><td>${m.votes}</td><td>${m.evaluated_cases} / ${m.candidates}</td><td>${!m.chart_eligible?'不足50场':m.preliminary?'初步结果':'样本阈值已达到'}</td></tr>`).join('')}</tbody></table></div><p class="note">${escape(r.explanation)}</p><p class="note">Rating是相对偏好强度，不是53分制的质量分，也不是置信区间。分数没有人为初始分或虚拟票。未达50场的模型在表中保留用于核对，不列入正式图榜。</p>${link(r.reference,'DesignArena 官方方法说明')}</section>
    ${agreementCard(d.task_statistics)}
    ${taskTable(d.task_statistics,localPath('/api/admin/tasks.csv'))}
    <section class="card"><h2>待处理反馈</h2>${d.reports.length?d.reports.map(v=>`<div class="report"><strong>${escape(v.case_id)} · ${escape(v.reviewer)}</strong><p>${escape(reasonLabel(v.reason))}${v.comment?' · '+escape(v.comment):''}</p></div>`).join(''):'<p class="muted">尚无反馈</p>'}</section><p class="footer-note">固定于 ${new Date(s.frozen_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}（北京） · 快照 ${escape(s.hash.slice(0,16))}</p>`;
  bindTaskTable(d.task_statistics);
  document.querySelectorAll('[data-copy]').forEach(b=>{b.onclick=()=>copy(b.dataset.copy);});
  document.querySelector('#refresh').onclick=()=>admin().catch(e=>toast(e.message));
  clearTimeout(adminTimer);adminTimer=setTimeout(()=>{if(document.visibilityState==='visible')admin().catch(()=>{});},60000);
}
function panel(side, draft) {
  return `<section class="card draft" data-side="${side}"><div class="draft-header"><div class="draft-name"><span class="letter">${side}</span><div><strong>候选 ${side}</strong><small>03 · Workspace</small></div></div>${draft.url?link(draft.url, '打开 Figma · Page03 ↗', 'external open-figma'):'<span class="badge">匿名截图</span>'}</div><div class="viewer" id="viewer-${side}">${gallery(side, draft)}</div><div class="viewer-tools"><button data-gallery="${side}" ${draft.images.length ? '' : 'disabled'}>已有画板 ${draft.images.length}张</button>${draft.url?`<button data-embed="${side}">嵌入Figma查看</button>`:''}<span class="muted">${draft.url?'可在新标签页完整查看':'逐张放大查看交付的全部截图'}</span></div><label class="confirm-view"><input type="checkbox" data-confirm="${side}" ${draft.seen ? 'checked disabled' : ''}><span>我已完整查看 ${side} 的${draft.url?'03产物，包括全部现有画板':'全部交付截图'}；可以据此比较设计质量。</span></label></section>`;
}
function gallery(side, draft) {
  if (!draft.images.length) return `<div class="live-only"><div class="live-symbol">▧</div><h3>请直接查看完整 Figma 产物</h3><p>这份稿件暂无完整画板预览。请打开03 Workspace，检查全部现有画板与流程后再确认。</p>${link(draft.url, '打开03 Workspace ↗', 'external open-figma')}<p>打不开、看到参考页或发现模型身份时，请选择“无法比较”并记录问题。</p></div>`;
  return `<div class="gallery">${draft.images.map((image, i) => `<button class="screen" data-zoom="${side}:${i}" aria-label="放大${side}画板${i + 1}"><img src="${escape(localPath(image.url))}" alt="候选${side} · 产品画板${i + 1}" loading="lazy"><span>画板 ${i + 1} / ${draft.images.length} · ${image.width} × ${image.height} · 点击放大</span></button>`).join('')}</div>`;
}
function requirementTexts(value) {
  if (Array.isArray(value)) return value.flatMap(requirementTexts);
  if (!value || typeof value !== 'object') return [];
  return value.kind === 'text' ? [value] : Object.values(value).flatMap(requirementTexts);
}
function requirementBlock(block) {
  if (block.kind === 'text') return `<p class="requirement-text">${escape(block.zh)}</p>`;
  if (block.kind === 'table') return `${(block.heading || []).map(requirementBlock).join('')}<div class="table-wrap"><table class="requirements-table"><thead><tr>${block.headers.map(cell => `<th>${cell.map(requirementBlock).join('')}</th>`).join('')}</tr></thead><tbody>${block.rows.map(row => `<tr>${row.map(cell => `<td>${cell.map(requirementBlock).join('')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${(block.notes || []).map(requirementBlock).join('')}`;
  const nested = block.blocks || [];
  return `<div class="requirement-group">${nested.map(requirementBlock).join('')}</div>`;
}
function originalRequirements(section) {
  return `<details class="requirements-original"><summary>对照英文原文</summary><pre>${escape(requirementTexts(section).map(t => t.text).join('\n'))}</pre></details>`;
}
function requirementSection(section, requiredFrames) {
  const first = section.blocks?.[0], title = first?.zh || section.name || '设计要求';
  const body = first?.kind === 'text' ? { ...section, blocks: section.blocks.slice(1) } : section;
  if (/FRAMES.*(?:EXACT|DELIVER)/i.test(section.name || '')) return `<section class="requirement-section"><h4>交付画板清单 · ${requiredFrames.length}屏</h4><div class="requirement-frames">${requiredFrames.map(name => `<code>${escape(name)}</code>`).join('')}</div>${originalRequirements(section)}</section>`;
  if (section.name === 'Header') return `<div class="requirement-header">${requirementBlock(section)}${originalRequirements(section)}</div>`;
  if (/ASSIGNMENT/i.test(section.name || '')) return `<section class="requirement-section"><h4>${escape(title)}</h4>${requirementBlock(body)}${originalRequirements(section)}</section>`;
  return `<details class="requirement-section"><summary>${escape(title)}</summary>${requirementBlock(body)}${originalRequirements(section)}</details>`;
}
function requirementsPanel(pair) {
  const req = pair.requirements;
  if (!req) return '';
  const task = req.pages.find(p => /^00/.test(p.name)), foundations = req.pages.find(p => /^01/.test(p.name));
  return `<div class="requirements-panel"><h3>设计任务与要求（中文）</h3><p class="note">以下为原始模板00任务页和01规范页的中文译文，保留英文原文供核对固定文案。下方比较的是两份独立副本的03产物。</p>${task.sections.map(section => requirementSection(section, req.required_frames)).join('')}<details class="requirement-section"><summary>视觉规范与基础要求 · 01 Foundations</summary>${foundations.sections.map(section => requirementBlock(section) + originalRequirements(section)).join('')}</details></div>`;
}
async function reviewHome() {
  leavePairScreens();
  if(!session.sorting_algorithm)return review();
  imageWarmup ||= createImageWarmup({api,localPath});
  const data=await api('/api/review/tasks');
  renderTaskLobby({data,app,warmup:imageWarmup,onSelect:async(case_id,new_round)=>{
    try{await api('/api/review/tasks/select',{case_id,new_round});await review();window.scrollTo(0,0);}
    catch(e){toast(e.message);throw e;}
  }});
}
async function review() {
  leavePairScreens();
  current = await api('/api/review/next'); busy = false;
  const { pair, progress: p } = current;
  if (!pair) {
    if(current.sorting?.status==='complete')return reviewHome();
    if(current.sorting?.status?.startsWith('paused-'))return renderSortingPause({data:current,app,api,next:review,toast,backToTasks:reviewHome});
    if(current.sorting?.complete)return renderSortingComplete({data:current,app});
    if(current.tournament?.blocked){
      app.innerHTML=`<section class="card completion"><div class="eyebrow">Progress saved</div><h1>当前轮暂时无法比较</h1><p>反馈已保存，有效 ${p.voted} 票。请先处理访问或稿件问题，恢复后继续同一场；不会据此指定胜负。</p><button class="primary" id="retry-unable">问题已处理，继续本轮</button></section>`;
      document.querySelector('#retry-unable').onclick=async()=>{await api('/api/review/retry-unable',{});await review();};return;
    }
    app.innerHTML = `<div class="card completion"><div class="brand-mark">✓</div><div class="eyebrow">Session saved</div><h1>本轮比较已处理完毕</h1><p class="muted">已提交 ${p.voted} 票${p.skipped ? `，另有 ${p.skipped} 组暂时无法比较` : ''}。<br>全部记录已保存，可以关闭页面。</p>${p.skipped ? '<button class="primary" id="retry-unable">重新查看无法比较的组</button>' : ''}<p class="note">请保持独立判断，待另一位评审完成后由组织者汇总。</p></div>`;
    document.querySelector('#retry-unable')?.addEventListener('click', async () => { await api('/api/review/retry-unable', {}); await review(); });
    return;
  }
  if(pair.screen_comparison){
    const {renderPairScreens}=await import('./pair-screens.js');
    return renderPairScreens({data:current,api,app,session,toast,requirementsPanel,localPath,next:review,warmup:imageWarmup,backToTasks:session.sorting_algorithm?reviewHome:null,
      openImages:(images,index)=>{imageWarmup?.pause();imageSet=images;imageAt=index;zoomImage();document.querySelector('#image-dialog').showModal();}});
  }
  for (const side of ['A', 'B']) methods[side] = pair.drafts[side].images.length ? 'gallery' : 'figma';
  app.innerHTML = `<div class="page-heading"><div><div class="eyebrow">Blind comparison</div><h1>哪份设计更值得交付？</h1><p class="muted">同一道任务 · 两份匿名产物 · 先完整查看，再做选择</p></div><div class="progress-wrap"><div class="progress-text"><span>${escape(session.label)} · 已处理 ${p.done} / ${p.total}组</span><span>${p.voted}票已保存</span></div><div class="progress-track"><div id="progress-fill" class="progress-fill"></div></div></div></div>
    <div class="review-intro"><div><strong>独立判断整体交付质量</strong>综合任务完成度、使用体验、视觉表现，以及设计规范与组件的使用。两份都不完美时，也请选择相对更好的一份。</div><span>任务与规范见00/01/02，有04时也读取。<br>本轮每份稿件的运行版本固定。</span></div>
    <section class="card review-brief"><div class="section-top"><h2>${escape(pair.case_id)} · ${escape(pair.title)}</h2>${link(pair.source_url, '阅读任务与规范（只读模板） ↗', 'external')}</div>${requirementsPanel(pair)}<details><summary>查看表格中的原始 query</summary><pre>${escape(pair.query)}</pre></details></section>
    <div class="drafts">${panel('A', pair.drafts.A)}${panel('B', pair.drafts.B)}</div>
    <section class="card vote-card"><div class="vote-heading"><h2>在满足这道题的设计要求下，你更愿意把哪份稿件交付给客户？</h2><p class="note" id="vote-hint">请先确认完整查看A、B两份产物。</p></div><div class="vote-actions"><button class="vote-choice" data-vote="A" disabled>选择 A</button><button class="vote-choice" data-vote="B" disabled>选择 B</button><button class="quiet" id="show-unable">无法比较 / 反馈问题</button></div><div class="vote-meta"><textarea id="comment" class="field" aria-label="比较备注" placeholder="选填：你的判断理由，或指出具体页面的问题（最多2000字）" maxlength="2000"></textarea><div id="unable-form" class="unable-form hidden"><select id="unable-reason" class="field" aria-label="无法比较的原因"><option value="access">Figma无法打开 / 没有权限</option><option value="incomplete-view">无法确认完整03产物</option><option value="identity-leak">发现模型身份信息</option><option value="other">其他问题</option></select><button id="submit-unable">记录并看下一组</button></div></div><p class="footer-note">有效票自动保存 · 无法比较单独记录，不计入胜负 · 左右位置已打乱</p></section>`;
  if(current.choices?.includes('tie')){
    const tie=document.createElement('button');tie.className='vote-choice';tie.dataset.vote='tie';tie.disabled=true;tie.textContent='平局 · 质量接近';
    document.querySelector('.vote-actions').insertBefore(tie,document.querySelector('#show-unable'));
    document.querySelector('#show-unable').textContent='无效 / 无法比较';
    document.querySelector('.review-intro > div').innerHTML='<strong>独立判断整体交付质量</strong>综合任务完成度、使用体验、视觉表现，以及规范和组件的使用。质量接近可判平局；无法完整查看或发现身份信息时，请选择无效并说明原因。';
    document.querySelector('.vote-card > .footer-note').textContent='胜负与平局均为有效票 · 无效反馈不计入胜率 · 左右位置已打乱';
  }
  if(pair.requirements)document.querySelector('.review-intro > span').textContent='请先阅读下方中文任务需求，展开逐屏清单与固定数据核对。\n规范、组件和素材也可在原始模板中查阅。';
  if(current.tournament){
    document.querySelector('.progress-text').innerHTML=`<span>${escape(session.label)} · 第 ${current.tournament.number} 轮 · 第 ${current.tournament.step}/5 场</span><span>${p.voted}票已保存</span>`;
    document.querySelector('#submit-unable').textContent=current.tournament.unable_action==='skip-session'?'保存反馈，继续下一组':'保存反馈，暂停当前轮';
    document.querySelector('.review-intro > div').innerHTML='<strong>独立判断整体交付质量</strong>当前题随机4份稿件，共做5次二选一。综合任务完成度、使用体验、视觉表现及规范和组件的使用，选择相对更值得交付的一份。随时关闭页面，回来可继续。';
  }
  if(!pair.drafts.A.url&&!pair.drafts.B.url){
    document.querySelector('.review-intro > div').innerHTML='<strong>独立比较两份设计</strong>依据任务要求、内容完整性、视觉和静态使用体验，选择相对更值得交付的一份。请逐张查看全部交付截图；原型交互和图层组织无法仅凭截图验证。';
    document.querySelector('.review-intro > span').textContent='请先阅读中文需求，再逐张放大查看。\n两份均存在问题时，仍选择相对更好的一份。';
  }
  document.querySelector('#progress-fill').style.width = `${current.tournament?(current.tournament.step-1)/5*100:p.done / p.total * 100}%`;
  wireViewers();
  document.querySelectorAll('[data-confirm]').forEach((input) => { input.onchange = async () => {
    if (!input.checked) return;
    try { input.disabled = true; await api('/api/review/seen', { pair_id: pair.id, side: input.dataset.confirm, method: methods[input.dataset.confirm] }); pair.drafts[input.dataset.confirm].seen = true; enableVotes(); }
    catch (e) { input.disabled = false; input.checked = false; toast(e.message); }
  }; });
  document.querySelectorAll('[data-gallery]').forEach((button) => { button.onclick = () => {
    const side = button.dataset.gallery; document.querySelector(`#viewer-${side}`).innerHTML = gallery(side, pair.drafts[side]); methods[side] = 'gallery'; wireViewers();
  }; });
  document.querySelectorAll('[data-embed]').forEach((button) => { button.onclick = () => {
    const side = button.dataset.embed; const iframe = document.createElement('iframe');
    iframe.title = `候选${side}完整03 Workspace`; iframe.allowFullscreen = true;
    iframe.src = `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(pair.drafts[side].url)}`;
    document.querySelector(`#viewer-${side}`).replaceChildren(iframe); methods[side] = 'figma';
  }; });
  document.querySelectorAll('[data-vote]').forEach((button) => { button.onclick = () => submit(button.dataset.vote); });
  document.querySelector('#show-unable').onclick = () => document.querySelector('#unable-form').classList.toggle('hidden');
  document.querySelector('#submit-unable').onclick = () => submit('unable');
  enableVotes();
}
function enableVotes() {
  const ready = ['A', 'B'].every((s) => current.pair.drafts[s].seen);
  document.querySelectorAll('[data-vote]').forEach((button) => { button.disabled = !ready || busy; });
  document.querySelector('#vote-hint').textContent = ready ? '两份产物已确认查看，可以投票。' : '请先确认完整查看A、B两份产物。';
}
function wireViewers() {
  document.querySelectorAll('.open-figma').forEach((a) => { a.onclick = () => { methods[a.closest('[data-side]').dataset.side] = 'figma'; }; });
  document.querySelectorAll('[data-zoom]').forEach((button) => { button.onclick = () => {
    const [side, index] = button.dataset.zoom.split(':'); imageSet = current.pair.drafts[side].images; imageAt = Number(index);
    zoomImage(); document.querySelector('#image-dialog').showModal();
  }; });
  document.querySelectorAll('.screen img').forEach((img) => { img.onerror = () => {
    img.alt = '截图无法载入，请刷新重试或反馈组织者'; img.closest('.screen').classList.add('error');
  }; });
}
async function zoomImage() {
  const request=++imageRequest;
  const element=document.querySelector('#zoom-image'),scroller=document.querySelector('#image-scroll'),end=document.querySelector('#image-end');
  const status=document.querySelector('#image-load-state');
  const reset=()=>{(scroller||document.querySelector('#image-dialog')).scrollTo(0,0);};
  if(end)end.hidden=true;
  scroller.setAttribute('aria-busy','true');element.classList.add('image-loading');
  if(status){status.hidden=false;status.textContent='正在加载完整原图…';}
  element.onload=null;element.onerror=null;element.decoding='async';element.fetchPriority='high';
  const img=imageSet[imageAt];
  element.removeAttribute('src');
  element.width=img.width;element.height=img.height;
  document.querySelector('#image-number').textContent = `画板 ${imageAt + 1} / ${imageSet.length} · ${img.width} × ${img.height}`;
  document.querySelector('#original-image').href=localPath(img.original_url||img.url);
  document.querySelector('#prev-image').disabled = imageAt === 0;
  document.querySelector('#next-image').disabled = imageAt === imageSet.length - 1;
  document.querySelector('#image-dialog').scrollTop = 0;
  reset();
  try{
    if(imageWarmup?.localCache)await imageWarmup.localCache.mount(element,localPath(img.url),()=>request===imageRequest&&element.isConnected);
    else element.src=localPath(img.url);
    if(request!==imageRequest)return;
    await element.decode();
    if(request!==imageRequest)return;
    element.classList.remove('image-loading');scroller.setAttribute('aria-busy','false');if(status)status.hidden=true;if(end)end.hidden=false;reset();
    const nearby=imageSet.slice(imageAt+1,imageAt+2).filter(im=>im.media_key);
    imageWarmup?.add(nearby,0,current?.pair?.case_id);
  }catch{
    if(request!==imageRequest)return;
    element.classList.remove('image-loading');scroller.setAttribute('aria-busy','false');if(end)end.hidden=true;
    if(status){status.hidden=false;status.textContent='原图加载失败，请关闭后重新打开或刷新重试';}
    toast('原图加载失败，请刷新或反馈问题');
  }
}
document.querySelector('#image-size').onclick=e=>{const original=document.querySelector('#image-dialog').classList.toggle('original-size');e.target.textContent=original?'适合宽度':'原始尺寸 1:1';};
document.querySelector('#close-image').onclick = () => document.querySelector('#image-dialog').close();
document.querySelector('#image-dialog').addEventListener('close',()=>imageWarmup?.resume());
document.querySelector('#prev-image').onclick = () => { if (imageAt > 0) { imageAt--; zoomImage(); } };
document.querySelector('#next-image').onclick = () => { if (imageAt < imageSet.length - 1) { imageAt++; zoomImage(); } };
async function submit(choice) {
  if (busy) return; busy = true; enableVotes();
  document.querySelector('#submit-unable').disabled = true;
  try {
    await api('/api/review/vote', { pair_id: current.pair.id, choice, reason: document.querySelector('#unable-reason').value, comment: document.querySelector('#comment').value, requirements_hash:current.pair.requirements?.version || null });
    toast(choice === 'unable' ? '问题已记录，未计入胜负' : '投票已保存');
    await review(); window.scrollTo({ top: 0, behavior: 'instant' });
  } catch (e) { busy = false; enableVotes(); document.querySelector('#submit-unable').disabled = false; toast(e.message); }
}
async function init() {
  if (!['admin', 'review'].includes(new URLSearchParams(location.search).get('view'))) {
    clearTimeout(adminTimer);
    session = {}; showIdentity(); await leaderboard(); return;
  }
  clearTimeout(leaderboardTimer);
  session = await api('/api/session'); showIdentity();
  document.querySelector('.brand small').textContent = 'Figma 人工设计盲评';
  const publicAdminView=new URLSearchParams(location.search).get('view')==='admin'&&session.public_admin;
  document.title=session.role==='admin'||publicAdminView?'设计盲评管理台 · Design Arena':'匿名设计比较 · Design Arena';
  if(publicAdminView&&!session.role){session.label='公开管理台';showIdentity();}
  const view=new URLSearchParams(location.search).get('view');
  if (view==='admin'&&(session.role === 'admin'||publicAdminView)) await admin();
  else if (session.role === 'reviewer'&&(!session.open_registration||session.profile_registered||session.reviewer_selection)) await reviewHome();
  else if (session.reviewer_selection) await existingReviewerLanding();
  else {
    const active=localStorage.getItem('arena-active-profile'),saved=savedProfiles().find(p=>p.secret===active);
    if(!session.role&&session.open_registration&&saved){try{await enterProfile(saved.name,saved.secret);return;}catch{localStorage.removeItem('arena-active-profile');}}
    landing();
  }
}
async function boot() {
  const access = new URLSearchParams(location.hash.slice(1));
  const value = access.get('admin') || access.get('invite');
  if (value) {
    clearTimeout(leaderboardTimer); clearTimeout(adminTimer);
    const url = new URL(location.href); url.hash = ''; url.searchParams.set('view', access.has('admin') ? 'admin' : 'review');
    history.replaceState(null, '', url.pathname + url.search);
    try { await api('/api/session', { access: value }); }
    catch (e) { session = {}; showIdentity(); landing(e.message); return; }
  }
  await init();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const view = new URLSearchParams(location.search).get('view');
  if (view === 'admin' && (session?.role === 'admin'||session?.public_admin)) {
    admin().catch((e) => toast(e.message));
  } else if (!['admin', 'review'].includes(view)) {
    leaderboard().catch((e) => toast(e.message));
  }
});
const connectionError = (e) => { app.innerHTML = `<div class="card landing"><h1>暂时无法连接</h1><p class="error">${escape(e.message)}</p><p>请稍后刷新重试。</p></div>`; };
window.addEventListener('hashchange', () => {
  const access = new URLSearchParams(location.hash.slice(1));
  if (access.has('admin') || access.has('invite')) boot().catch(connectionError);
});
boot().catch(connectionError);
