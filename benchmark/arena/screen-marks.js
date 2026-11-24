const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const labelText=label=>label==='good'?'Good case':label==='bad'?'Bad case':'未标记';

export function createScreenMarksUI({pair,app,api,toast,isBusy,setBusy,onSaved}) {
  const get=(side,index)=>pair.screen_marks?.[side]?.find(m=>m.image_index===index);
  function markup(side,index,name) {
    const mark=get(side,index);if(!mark)return '';
    return `<div class="screen-mark-toolbar"><span class="screen-mark-state ${mark.label||''}" title="${esc(mark.reason)}">本屏：${labelText(mark.label)}</span><button type="button" data-screen-mark="${side}:${index}" data-screen-name="${esc(name)}" aria-label="标记方案 ${side} 的 ${esc(name)}">${mark.label?'查看 / 编辑理由':'标记 good / bad case'}</button></div>`;
  }
  function bind() {
    for(const button of app.querySelectorAll('[data-screen-mark]'))button.onclick=()=>{
      if(isBusy())return;
      const [side,value]=button.dataset.screenMark.split(':'),index=Number(value),mark=get(side,index);
      if(!mark)return;
      const image=button.closest('.pair-shot')?.querySelector('img');
      if(!image?.complete||!image.naturalWidth||image.dataset.decoded!=='true')return toast('请先等待这张屏幕的原图加载完成');
      const dialog=document.createElement('dialog');dialog.className='pair-modal screen-mark-dialog';
      dialog.setAttribute('aria-labelledby','screen-mark-title');
      dialog.innerHTML=`<h2 id="screen-mark-title">标记本屏案例</h2><p class="pair-modal-note">方案 ${side} · ${esc(button.dataset.screenName)} · 原稿第 ${index+1} 张<br>仅标记这一张屏幕。相同屏幕在其他比较中出现时，会保留你的标记。</p><div class="screen-mark-options">${['good','bad'].map(label=>`<label><input type="radio" name="case-label" value="${label}" ${mark.label===label?'checked':''}>${labelText(label)}</label>`).join('')}</div><label for="screen-mark-reason">理由（必填）</label><textarea id="screen-mark-reason" rows="4" maxlength="2000" placeholder="描述这张屏幕的具体优点或问题">${esc(mark.reason)}</textarea><p class="inline-error" id="screen-mark-error" role="alert"></p><div class="pair-final-actions"><button type="button" id="screen-mark-cancel">取消</button>${mark.label?'<button type="button" id="screen-mark-clear">清除标记</button>':''}<button type="button" class="primary" id="screen-mark-save">保存标记</button></div>`;
      app.append(dialog);
      dialog.addEventListener('cancel',event=>{if(isBusy())event.preventDefault();});
      const close=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove(),{once:true});
      dialog.querySelector('#screen-mark-cancel').onclick=close;
      async function save(clear=false) {
        const label=clear?null:dialog.querySelector('input:checked')?.value;
        const reason=clear?'':dialog.querySelector('textarea').value.trim();
        const error=dialog.querySelector('#screen-mark-error');
        if(!clear&&(!label||!reason)){error.textContent='请选择 good / bad case，并填写理由';return;}
        setBusy(true);dialog.querySelectorAll('button,input,textarea').forEach(el=>el.disabled=true);
        try {
          const result=await api('/api/review/screen-mark',{pair_id:pair.id,side,image_index:index,label,reason,
            revision:mark.revision,evidence_version:mark.evidence_version,media_key:pair.drafts[side].images[index].media_key});
          Object.assign(mark,result.mark);dialog.close();setBusy(false);onSaved();toast(clear?'本屏标记已清除':'本屏案例和理由已保存');
        } catch(e) {setBusy(false);dialog.querySelectorAll('button,input,textarea').forEach(el=>el.disabled=false);error.textContent=e.message;}
      }
      dialog.querySelector('#screen-mark-save').onclick=()=>save();
      if(mark.label)dialog.querySelector('#screen-mark-clear').onclick=()=>save(true);
      dialog.showModal();dialog.querySelector('textarea').focus();
    };
  }
  return {markup,bind};
}

const filterState={label:'',case_id:'',model_id:'',search:''};
export async function renderScreenMarksAdmin({app,api,localPath}) {
  const section=document.createElement('section');section.className='card screen-case-library';
  const footer=app.querySelector('.footer-note');if(footer)footer.before(section);else app.append(section);
  section.innerHTML='<h2>屏幕案例库</h2><p class="muted">正在读取标记…</p>';
  let records;
  try {({records}=await api('/api/admin/screen-marks'));}
  catch(e){if(section.isConnected)section.innerHTML=`<h2>屏幕案例库</h2><p class="inline-error">${esc(e.message)}</p>`;return;}
  if(!section.isConnected)return;
  const options=(key,title)=>[...new Map(records.map(r=>[r[key],r[title]])).entries()].sort((a,b)=>String(a[1]).localeCompare(String(b[1]))).map(([value,name])=>`<option value="${esc(value)}">${esc(name)}</option>`).join('');
  section.innerHTML=`<div class="section-top"><div><h2>屏幕案例库</h2><p class="note">每条标记对应一张具体截图，保留评审人和理由；同屏跨对局不重复收录。</p></div><div class="actions"><a class="external" download href="${esc(localPath('/api/admin/screen-marks.csv'))}">导出案例 CSV</a><a class="external" href="${esc(localPath('/api/admin/screen-marks'))}" target="_blank" rel="noopener">案例 JSON</a></div></div><div class="screen-case-filters"><select data-case-filter="label" aria-label="案例类型"><option value="">全部类型</option><option value="good">Good case</option><option value="bad">Bad case</option></select><select data-case-filter="case_id" aria-label="案例题目"><option value="">全部题目</option>${options('case_id','title')}</select><select data-case-filter="model_id" aria-label="案例模型"><option value="">全部模型</option>${options('model_id','model_name')}</select><input data-case-filter="search" aria-label="搜索案例理由" placeholder="搜索屏幕、理由或评审人"></div><p class="note screen-case-count"></p><div class="screen-case-grid"></div>`;
  function render() {
    const q=filterState.search.trim().toLowerCase();
    const filtered=records.filter(r=>(!filterState.label||r.label===filterState.label)&&(!filterState.case_id||r.case_id===filterState.case_id)&&(!filterState.model_id||r.model_id===filterState.model_id)&&(!q||[r.screen_name,r.reason,r.reviewer,r.title].join(' ').toLowerCase().includes(q)));
    section.querySelector('.screen-case-count').textContent=`显示 ${filtered.length} 条 / 共 ${records.length} 条标记`;
    section.querySelector('.screen-case-grid').innerHTML=filtered.map(r=>`<article class="screen-case-card"><a href="${esc(localPath(r.image_url))}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(localPath(r.image_url))}" alt="${esc(r.title+' · '+r.screen_name)}"></a><div><span class="screen-mark-state ${r.label}">${labelText(r.label)}</span><h3>${esc(r.title)} · ${esc(r.screen_name)}</h3><p class="note">${esc(r.model_name)} · ${esc(r.reviewer)} · ${r.width} × ${r.height}</p><p class="screen-case-reason">${esc(r.reason)}</p><p><a href="${esc(localPath(r.image_url))}" target="_blank" rel="noopener">查看完整原图 ↗</a> · <a href="${esc(r.figma_url)}" target="_blank" rel="noopener noreferrer">打开 Figma 画板 ↗</a></p></div></article>`).join('')||'<p class="muted">暂无符合条件的屏幕案例。设计师可在逐屏比较时标记 good / bad case 并填写理由。</p>';
  }
  for(const field of section.querySelectorAll('[data-case-filter]')){
    field.value=filterState[field.dataset.caseFilter];
    if(field.tagName==='SELECT'&&!field.value)filterState[field.dataset.caseFilter]='';
    field.addEventListener('input',()=>{filterState[field.dataset.caseFilter]=field.value;render();});
  }
  render();
}
