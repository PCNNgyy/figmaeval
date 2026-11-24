import {sortingProgressText} from './incremental-ranking.js';
import {createScreenMarksUI} from './screen-marks.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const label={A:'A 更好',B:'B 更好',tie:'差不多',unable:'无法判断'};
let dispose=()=>{};

export function leavePairScreens(){dispose();}

export async function renderPairScreens({data,api,app,session,toast,requirementsPanel,localPath,openImages,next,warmup,backToTasks}){
  dispose();
  document.body.classList.add('pair-review');
  const pair=data.pair, notes=new Map(), viewedRows=new Set(), attemptedViews=new Set(),imageTimers=new Set();
  let imageObserver;
  warmup?.pause();
  let screens=pair.screen_comparison,index=Math.max(0,screens.rows.findIndex(r=>!r.vote));
  let disposed=false,working=false,scaleMode='readable',zoom=.75,effectiveScale=.75,resizeFrame=0,mode='single',briefOpen=true,finalChoice='',overallComment='',feedbackComment='',imageGeneration=0;
  const $=selector=>app.querySelector(selector);
  const screenMarks=createScreenMarksUI({pair,app,api,toast,isBusy:()=>working,setBusy:value=>{working=value;updateDisabled();},onSaved:()=>render()});
  try{
    const saved=JSON.parse(localStorage.getItem('arena-readable-scale-v3')||'null');
    if(saved&&['readable','fit','width','manual'].includes(saved.mode)){
      scaleMode=saved.mode;zoom=Number.isFinite(saved.zoom)?Math.max(.1,Math.min(2,saved.zoom)):.75;
    }
  }catch{}
  const zoomSteps=[10,25,50,75,90,100,125,150,175,200];
  function layoutImages(){
    if(disposed)return;
    const canvas=$('.pair-canvas');if(!canvas)return;
    const rows=mode==='all'?screens.rows:[current()];
    const images=rows.flatMap(row=>['A','B'].flatMap(side=>row[side]===null?[]:[pair.drafts[side].images[row[side]]]));
    const maxWidth=Math.max(1,...images.map(im=>im.width)),maxHeight=Math.max(1,...images.map(im=>im.height));
    const gap=parseFloat(getComputedStyle($('.paired-drafts')).columnGap)||10;
    const columnWidth=Math.max(1,(canvas.clientWidth-gap)/2-2);
    const imageHeight=Math.max(80,innerHeight-(canvas.getBoundingClientRect().top+scrollY)-$('.paired-head').offsetHeight-$('.pair-votebar').offsetHeight-16);
    effectiveScale=scaleMode==='manual'?zoom:scaleMode==='width'?columnWidth/maxWidth:
      scaleMode==='fit'?Math.min(1,columnWidth/maxWidth,imageHeight/maxHeight):Math.min(1,columnWidth/maxWidth);
    const widths=['A','B'].map(side=>Math.max(columnWidth+2,...rows.flatMap(row=>row[side]===null?[]:[pair.drafts[side].images[row[side]].width*effectiveScale+2])));
    $('.paired-drafts').style.gridTemplateColumns=widths.map(w=>`${w}px`).join(' ');
    app.querySelectorAll('.pair-shot').forEach(figure=>{
      const row=screens.rows[Number(figure.dataset.imageRow)],img=figure.querySelector('img');
      if(img){const side=figure.closest('[data-side]').dataset.side,im=pair.drafts[side].images[row[side]];
        img.style.width=`${im.width*effectiveScale}px`;img.style.height=`${im.height*effectiveScale}px`;
      }
    });
    if(mode==='all')for(const row of rows){
      const at=screens.rows.indexOf(row),figures=[...app.querySelectorAll(`[data-image-row="${at}"]`)];
      for(const selector of ['figcaption','.screen-mark-toolbar']){
        const headings=figures.map(f=>f.querySelector(selector)).filter(Boolean);
        for(const h of headings)h.style.minHeight='';
        const height=Math.max(0,...headings.map(h=>h.offsetHeight));
        for(const h of headings)h.style.minHeight=`${height}px`;
      }
      const height=Math.max(0,...['A','B'].flatMap(side=>row[side]===null?[]:[pair.drafts[side].images[row[side]].height*effectiveScale]));
      const headingHeight=Math.max(0,...figures.map(f=>(f.querySelector('figcaption')?.offsetHeight||0)+(f.querySelector('.screen-mark-toolbar')?.offsetHeight||0)));
      for(const f of figures)f.style.minHeight=`${height+headingHeight}px`;
    }
    const select=$('#pair-zoom');if(select)select.value=scaleMode==='manual'?String(Math.round(zoom*100)):scaleMode;
    $('#pair-scale-label').textContent=`${Math.round(effectiveScale*100)}% · 上下滚动页面查看完整画面`;
    $('#pair-zoom-out').disabled=working||effectiveScale<=.1;
    $('#pair-zoom-in').disabled=working||effectiveScale>=2;
    $('#pair-fit').setAttribute('aria-pressed',String(scaleMode==='fit'));
    $('#pair-size').setAttribute('aria-pressed',String(scaleMode==='manual'&&zoom===1));
  }
  function setScale(mode,value=zoom){
    if(working)return;scaleMode=mode;zoom=Math.max(.1,Math.min(2,value));
    try{localStorage.setItem('arena-readable-scale-v3',JSON.stringify({mode:scaleMode,zoom}));}catch{}
    layoutImages();
  }
  function stepScale(direction){
    const value=effectiveScale*100;
    const next=direction>0?zoomSteps.find(v=>v>value+.1):zoomSteps.findLast(v=>v<value-.1);
    if(next!==undefined)setScale('manual',next/100);
  }
  const resize=()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(layoutImages);};
  const resizeObserver=new ResizeObserver(resize);

  const version=()=>({pair_id:pair.id,plan_hash:screens.plan_hash});
  const current=()=>screens.rows[index];
  const commentFor=row=>notes.get(row.id)??row.vote?.comment??'';
  function texts(block){
    if(!block)return [];
    if(Array.isArray(block))return block.flatMap(texts);
    if(typeof block!=='object')return [];
    return block.kind==='text'?[block.zh||block.text||'']:Object.values(block).flatMap(texts);
  }
  const brief=pair.requirements?.pages?.filter(p=>/^(00|01)/.test(p.name))
    .map(p=>[`${/^00/.test(p.name)?'设计任务与要求':'视觉规范与基础要求'} · ${p.name}`,...texts(p.sections)].join('\n'))
    .join('\n\n')||pair.query;

  async function finalSubmit(choice,reason=''){
      if(working)return;
    working=true;updateDisabled();
    try{
      if(choice!=='unable')for(const side of ['A','B'])if(!pair.drafts[side].seen){
        await api('/api/review/seen',{pair_id:pair.id,side,method:'gallery'});pair.drafts[side].seen=true;
      }
      await api('/api/review/vote',{pair_id:pair.id,choice,reason,
        comment:choice==='unable'?feedbackComment:overallComment,
        requirements_hash:pair.requirements?.version||null,
        screen_plan_hash:screens.plan_hash,screen_votes_hash:screens.votes_hash});
      app.querySelectorAll('dialog[open]').forEach(d=>d.close());
      dispose();toast(choice==='unable'?'问题已记录，逐屏记录保留':'整体选择已保存');
      await next();window.scrollTo(0,0);
    }catch(e){working=false;updateDisabled();toast(e.message);}
  }
  async function choose(choice){
    if(working||mode!=='single')return;
    const row=current(),comment=commentFor(row).trim();
    if(choice==='unable'&&!comment)return toast('请说明这一屏无法判断的原因');
    if(choice!=='unable'&&!imagesReady())return toast('请等待当前两侧的原图加载完成');
    working=true;updateDisabled();
    try{
      screens=await api('/api/review/screen-vote',{...version(),slot_id:row.id,choice,comment,
        revision:row.vote?.revision||0,viewed:choice!=='unable'});
      notes.delete(row.id);
      app.querySelectorAll('dialog[open]').forEach(d=>d.close());
      const remaining=screens.rows.findIndex((r,i)=>i>index&&!r.vote);
      const first=screens.rows.findIndex(r=>!r.vote);
      index=remaining>=0?remaining:first>=0?first:index;
      working=false;render();
      if(scrollY>0)scrollToScreen();
      if(screens.tally.complete)openFinal();
    }catch(e){working=false;updateDisabled();toast(e.message);}
  }
  function imagesLoaded(){
    return ['A','B'].every(side=>current()[side]===null||(()=>{
      const img=$(`#paired-${side} [data-image-row="${index}"] img`);
      return img?.complete&&img.naturalWidth>0&&img.dataset.decoded==='true';
    })());
  }
  const receiptKey=()=>JSON.stringify([screens.plan_hash,current().id,current().A,current().B]);
  function cacheImages(){return ['A','B'].flatMap(side=>current()[side]===null?[]:[{side,index:current()[side],...pair.drafts[side].images[current()[side]]}]);}
  function imagesReady(){return imagesLoaded()&&(!cacheImages().some(im=>im.media_key)||viewedRows.has(receiptKey()));}
  async function confirmImages(){
    if(mode!=='single'||working||!imagesLoaded())return;
    const key=receiptKey(),images=cacheImages();
    if(!images.some(im=>im.media_key)||attemptedViews.has(key))return;
    attemptedViews.add(key);
    const ahead=screens.rows.slice(index+1,index+2).flatMap(r=>['A','B'].flatMap(side=>r[side]===null?[]:[pair.drafts[side].images[r[side]]]));
    warmup?.task(pair.case_id);warmup?.add(ahead,0,pair.case_id);warmup?.resume();
    try{
      await api('/api/review/screen-viewed',{...version(),slot_id:current().id,
        images:images.map(im=>({side:im.side,index:im.index-1,media_key:im.media_key}))});
      if(disposed)return;
      viewedRows.add(key);
    }catch(e){if(!disposed)toast(e.message);}
    updateDisabled();
  }
  function updateDisabled(){
    if(disposed||!$('#pair-prev'))return;
    app.querySelectorAll('[data-screen-mark]').forEach(b=>b.disabled=working||b.closest('.pair-shot')?.querySelector('img')?.dataset.decoded!=='true');
    app.querySelectorAll('[data-screen-choice]').forEach(b=>{
      const row=current(),c=b.dataset.screenChoice;
      b.disabled=working||mode!=='single'||!imagesReady()||c==='tie'&&(row.A===null||row.B===null)||['A','B'].includes(c)&&row[c]===null;
    });
    app.querySelectorAll('[data-align],[data-row],[data-mode],[data-final-row],[data-full-image],#pair-size,#pair-fit,#pair-zoom,#pair-zoom-out,#pair-zoom-in,#pair-tools,#pair-notes,#pair-unable,#pair-feedback-submit,#pair-skip-submit,#pair-unable-submit,#pair-requirements,#pair-brief-toggle,#pair-task-list').forEach(b=>b.disabled=working);
    $('#pair-prev').disabled=working||index===0;
    $('#pair-next').disabled=working||index===screens.rows.length-1;
    $('#pair-show-final').disabled=working||!screens.tally.complete;
    const confirm=$('#pair-confirm-submit');if(confirm)confirm.disabled=working||!finalChoice;
    app.querySelectorAll('[data-overall],#pair-back').forEach(b=>b.disabled=working);
    const status=$('#pair-save-state');
    if(status)status.textContent=working?'正在保存…':mode==='all'?'点选任意画板，返回逐屏比较':current().vote?`本屏已保存：${label[current().vote.choice]}`:imagesReady()?'选择后自动保存，进入下一屏':'正在加载原图…';
    if(mode==='single'&&imagesReady())warmup?.resume();
    resize();
    confirmImages();
  }
  function scrollToScreen(){
    const canvas=$('.pair-canvas');if(canvas)window.scrollTo({top:Math.max(0,canvas.getBoundingClientRect().top+scrollY-8),behavior:'instant'});
  }
  function move(at){if(working)return;const scrolled=scrollY>0;index=Math.max(0,Math.min(at,screens.rows.length-1));mode='single';render();if(scrolled)scrollToScreen();}

  function imageMarkup(side,row,at){
    const imageIndex=row[side],im=imageIndex===null?null:pair.drafts[side].images[imageIndex];
    return `<figure class="pair-shot ${at===index?'is-current':''}" data-image-row="${at}">${mode==='all'?`<figcaption><button data-row="${at}">${at+1} · ${esc(row.name)}${row.vote?` · ${label[row.vote.choice]}`:''}</button></figcaption>`:''}${im?screenMarks.markup(side,imageIndex,screens.images[side].find(x=>x.index===imageIndex)?.name||row.name):''}${im?`<button class="pair-image-open" data-pair-zoom="${side}" data-image-index="${imageIndex}" data-open-row="${at}" aria-label="${mode==='all'?'比较':'放大'}方案 ${side} · ${esc(row.name)}"><img data-source-url="${esc(localPath(im.url))}" data-bitmap-bytes="${im.width*im.height*4}" alt="方案 ${side} · ${esc(row.name)}" decoding="async" fetchpriority="${mode==='single'?'high':'auto'}" ${mode==='all'?'loading="lazy"':''}></button><button type="button" class="pair-image-retry" data-image-retry="${side}:${imageIndex}" hidden>原图加载较慢，点此重试</button>`:`<div class="pair-missing"><strong>未找到对应画板</strong><p>${esc(row.name)}</p><button data-fix-row="${at}">核对画板对应关系</button></div>`}</figure>`;
  }
  function sidePanel(side){
    const draft=pair.drafts[side];
    return `<section class="paired-draft" data-side="${side}"><header class="paired-head"><strong><span class="pair-letter">${side}</span>方案 ${side}</strong><span class="paired-head-links">${mode==='single'&&current()[side]!==null?`<button data-full-image="${side}">查看完整原图 ↗</button>`:''}${draft.url?`<a target="_blank" rel="noopener noreferrer" href="${esc(draft.url.startsWith('/')?localPath(draft.url):draft.url)}">打开 Figma${draft.figma_alias?' · '+esc(draft.figma_alias):''} ↗</a>${draft.figma_alias&&mode==='single'&&current()[side]!==null?`<a target="_blank" rel="noopener noreferrer" href="${esc(localPath(draft.url))+'?screen='+current()[side]}">定位本屏 ↗</a>`:''}`:''}</span></header><div class="paired-image-frame ${mode==='all'?'all-screens':''}" id="paired-${side}">${mode==='all'?screens.rows.map((r,i)=>imageMarkup(side,r,i)).join(''):imageMarkup(side,current(),index)}</div></section>`;
  }
  function dots(attribute='row'){
    return screens.rows.map((r,i)=>`<button data-${attribute}="${i}" class="${r.vote?'v-'+r.vote.choice:''} ${attribute==='row'&&i===index?'current':''}" aria-label="第 ${i+1} 屏 ${esc(r.name)} · ${r.vote?label[r.vote.choice]:'未比较'}" ${attribute==='row'&&i===index?'aria-current="step"':''} title="${esc(r.name)} · ${r.vote?label[r.vote.choice]:'未比较'}">${i+1}</button>`).join('');
  }
  function openFinal(){
    if(working||!screens.tally.complete)return;
    const t=screens.tally,dialog=$('#pair-final-dialog');
    dialog.innerHTML=`<p class="pair-modal-kicker">最后一步 · 整体判断</p><h2 id="pair-final-title">综合全部 ${t.total} 屏，哪份整体设计更好？</h2><nav class="pair-screen-dots" aria-label="逐屏比较结果">${dots('final-row')}</nav><p class="pair-final-tally">逐屏结果：<strong class="color-A">A 赢 ${t.A} 屏</strong> · 差不多 ${t.tie} 屏 · <strong class="color-B">B 赢 ${t.B} 屏</strong>${t.unable?` · 无法判断 ${t.unable} 屏`:''}</p><p class="pair-modal-note">逐屏结果仅供参考。请综合关键页面、完整性和视觉一致性，确认整体选择。</p><div class="pair-overall-choices">${data.choices.filter(c=>c!=='unable').map(c=>`<button data-overall="${c}" class="vote-${c} ${finalChoice===c?'selected':''}" aria-pressed="${finalChoice===c}">${c==='tie'?'整体差不多':`方案 ${c} 整体更好`} <kbd>${c==='A'?'1':c==='tie'?'2':data.choices.includes('tie')?'3':'2'}</kbd></button>`).join('')}</div><details class="pair-optional"><summary>添加整体备注（可选）</summary><textarea id="pair-overall-comment" aria-label="整体判断备注" maxlength="2000" rows="2">${esc(overallComment)}</textarea></details><div class="pair-final-actions"><button id="pair-back" class="pair-text-button">← 回去再看 <kbd>Esc</kbd></button><button id="pair-confirm-submit" class="primary" ${finalChoice?'':'disabled'}>${finalChoice?'确认提交':'请先选择'} <kbd>Enter</kbd></button></div><p class="pair-modal-footnote">确认提交表示已查看全部产品屏；这一场只计一张整体票。</p>`;
    dialog.querySelectorAll('[data-overall]').forEach(b=>b.onclick=()=>selectOverall(b.dataset.overall));
    $('#pair-overall-comment').oninput=e=>overallComment=e.target.value;
    $('#pair-confirm-submit').onclick=()=>finalSubmit(finalChoice);
    $('#pair-back').onclick=()=>dialog.close();
    dialog.querySelectorAll('[data-final-row]').forEach(b=>b.onclick=()=>{dialog.close();move(Number(b.dataset.finalRow));});
    dialog.showModal();
  }
  function selectOverall(choice){
    if(working||!data.choices.includes(choice))return;
    finalChoice=choice;
    app.querySelectorAll('[data-overall]').forEach(b=>{const active=b.dataset.overall===choice;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));});
    $('#pair-confirm-submit').innerHTML='确认提交 <kbd>Enter</kbd>';updateDisabled();
  }
  function openNotes(){
    const dialog=$('#pair-notes-dialog');
    dialog.innerHTML=`<h2 id="pair-notes-title">第 ${index+1} 屏 · 添加备注</h2><p class="pair-modal-note">备注可选，随本屏的下一次选择一起保存。</p><textarea id="screen-comment" aria-label="逐屏备注" maxlength="1000" rows="4" placeholder="记录具体优点或问题">${esc(commentFor(current()))}</textarea><div class="pair-final-actions"><button id="pair-close-notes" class="primary">完成</button></div>`;
    $('#screen-comment').oninput=e=>notes.set(current().id,e.target.value);
    $('#pair-close-notes').onclick=()=>{dialog.close();$('#pair-notes').textContent=commentFor(current())?'备注 · 已填写':'备注';};
    dialog.showModal();$('#screen-comment').focus();
  }
  function openUnable(){
    if(working)return;
    if(mode!=='single'){mode='single';render();}
    const dialog=$('#pair-unable-dialog');
    dialog.innerHTML=`<h2 id="pair-unable-title">第 ${index+1} 屏 · 无法判断</h2><p class="pair-modal-note">只记录问题，不指定这一屏的胜负。</p><textarea id="screen-comment" aria-label="无法判断的原因" maxlength="1000" rows="3" placeholder="请说明原因，例如缺图、画板不对应或原图无法加载">${esc(commentFor(current()))}</textarea><div class="pair-final-actions"><button id="pair-unable-cancel">取消</button><button id="pair-unable-submit" class="primary">记录本屏，继续</button></div><details class="pair-optional"><summary>整组都无法比较？</summary><select id="pair-feedback-reason" aria-label="整组无法比较的原因"><option value="access">Figma 无法访问</option><option value="incomplete-view">无法确认完整产物</option><option value="identity-leak">发现模型身份</option><option value="other">其他原因</option></select><textarea id="pair-feedback-comment" aria-label="整组问题说明" maxlength="2000" placeholder="补充说明（可选）">${esc(feedbackComment)}</textarea><button id="pair-skip-submit">${data.sorting?'记录问题，暂停本题':'记录整组问题，跳过本轮'}</button></details>`;
    $('#screen-comment').oninput=e=>notes.set(current().id,e.target.value);
    $('#pair-unable-submit').onclick=()=>choose('unable');
    $('#pair-unable-cancel').onclick=()=>dialog.close();
    $('#pair-feedback-comment').oninput=e=>feedbackComment=e.target.value;
    $('#pair-skip-submit').onclick=()=>finalSubmit('unable',$('#pair-feedback-reason').value);
    dialog.showModal();$('#screen-comment').focus();
  }
  function openTools(){
    const row=current(),dialog=$('#pair-tools-dialog');
    const attachments=['A','B'].flatMap(side=>(screens.excluded?.[side]||[]).map(im=>({side,...im})));
    dialog.innerHTML=`<h2 id="pair-tools-title">画板对应与附属资料</h2><p class="pair-modal-note">当前按任务中的产品屏名称匹配。仅在对应错误时调整；修改后，受影响的逐屏选择需要重新确认。</p>${['A','B'].map(side=>`<label class="pair-align-label">方案 ${side} · 第 ${index+1} 屏<select data-align="${side}" aria-label="${side} 对应画板">${row[side]===null?'<option value="" selected>未找到对应画板</option>':''}${screens.images[side].map((im,i)=>`<option value="${im.index}" ${im.index===row[side]?'selected':''}>${i+1} · ${esc(im.name)}</option>`).join('')}</select></label>`).join('')}${attachments.length?`<details class="pair-supporting pair-optional"><summary>附属资料 ${attachments.length} 张 · 不计产品屏数</summary><ul>${attachments.map(im=>`<li>方案 ${im.side} · ${esc(im.name)} <a href="${esc(localPath(pair.drafts[im.side].images[im.index].url))}" target="_blank" rel="noopener noreferrer">查看原图 ↗</a></li>`).join('')}</ul></details>`:''}<div class="pair-final-actions"><button id="pair-close-tools" class="primary">完成</button></div>`;
    dialog.querySelectorAll('[data-align]').forEach(select=>select.onchange=async()=>{
      if(select.value==='')return;working=true;updateDisabled();
      try{screens=await api('/api/review/screen-align',{...version(),slot_id:row.id,side:select.dataset.align,image_index:Number(select.value)});working=false;dialog.close();render();toast('画板对应已保存，受影响项请重新比较');}
      catch(e){working=false;dialog.close();render();toast(e.message);}
    });
    $('#pair-close-tools').onclick=()=>dialog.close();dialog.showModal();
  }
  function render(){
    warmup?.pause();
    imageObserver?.disconnect();
    if(typeof IntersectionObserver!=='undefined')imageObserver=new IntersectionObserver(entries=>{
      for(const entry of entries)if(entry.isIntersecting){entry.target.loadCachedImage?.();imageObserver.unobserve(entry.target);}
    },{rootMargin:'600px'});
    for(const timer of imageTimers)clearTimeout(timer);imageTimers.clear();
    const generation=++imageGeneration;
    const row=current(),t=screens.tally;
    app.innerHTML=`<div class="pair-workspace" data-viewer-version="readable-zoom-v2"><section class="pair-brief ${briefOpen?'':'is-collapsed'}"><header><div class="pair-task-title"><span>设计任务</span><h1>${esc(pair.case_id)} · ${esc(pair.title)}</h1></div><div class="pair-brief-actions">${backToTasks?'<button id="pair-task-list">← 选题</button>':''}<button id="pair-requirements">完整需求与规范 ↗</button><button id="pair-brief-toggle" aria-expanded="${briefOpen}">${briefOpen?'收起需求':'展开需求'}</button></div></header>${pair.review_update?`<p class="note" role="status">${esc(pair.review_update.message)}</p>`:''}<div class="pair-brief-text" ${briefOpen?'':'hidden'}>${esc(brief)}</div></section><section class="pair-controls"><div class="pair-toolbar"><div class="pair-segments" role="group" aria-label="查看模式"><button data-mode="single" aria-pressed="${mode==='single'}" class="${mode==='single'?'active':''}">逐屏对比</button><button data-mode="all" aria-pressed="${mode==='all'}" class="${mode==='all'?'active':''}">全部屏幕</button></div><span class="pair-screen-name" title="${esc(row.name)}">${esc(row.name)}${row.A===null||row.B===null?' · 未匹配':''}</span><div class="pair-pager"><button id="pair-prev" aria-label="上一屏">‹</button><span>第 ${index+1} / ${t.total} 屏</span><button id="pair-next" aria-label="下一屏">›</button><span class="pair-compared">已比较 ${t.voted}/${t.total}</span></div></div><div class="pair-progress-row"><nav class="pair-screen-dots" aria-label="逐屏进度">${dots()}</nav><div class="pair-legend"><span class="color-A">● A 更好</span><span>● 差不多</span><span class="color-B">● B 更好</span></div><div class="pair-view-tools"><div class="pair-zoom-controls" role="group" aria-label="图片缩放"><button id="pair-zoom-out" aria-label="缩小图片">−</button><select id="pair-zoom" aria-label="图片缩放比例"><option value="readable">清晰大小</option><option value="fit">整屏显示</option><option value="width">适合列宽</option>${zoomSteps.map(v=>`<option value="${v}">${v}%</option>`).join('')}</select><button id="pair-zoom-in" aria-label="放大图片">＋</button><button id="pair-fit" aria-pressed="${scaleMode==='fit'}">整屏</button><button id="pair-size" aria-pressed="${scaleMode==='manual'&&zoom===1}">原图100%</button></div><button id="pair-tools">对应 / 资料</button></div></div></section><div class="pair-canvas" role="region" aria-label="两份作品共用的对比画布" tabindex="0"><div class="paired-drafts">${sidePanel('A')}${sidePanel('B')}</div></div><footer class="pair-votebar"><div class="pair-vote-actions"><span class="pair-current-label">第 ${index+1} 屏</span><div class="pair-screen-choices">${['A','tie','B'].map((c,i)=>`<button data-screen-choice="${c}" class="vote-${c} ${row.vote?.choice===c?'selected':''}" aria-pressed="${row.vote?.choice===c}" disabled>${label[c]} <kbd>${i+1}</kbd></button>`).join('')}</div><button id="pair-unable">无法判断 <kbd>4</kbd></button><button id="pair-notes" class="pair-text-button">${commentFor(row)?'备注 · 已填写':'备注'}</button><button id="pair-show-final" class="primary" ${t.complete?'':'disabled'}>${t.complete?'整体判断 →':`还剩 ${t.total-t.voted} 屏`}</button></div><div class="pair-footer-hint"><span id="pair-save-state" role="status"></span><span id="pair-scale-label"></span><span>← → 翻屏 · 1 / 2 / 3 选择 · 点击图片放大</span><span>${data.sorting?esc(sortingProgressText(data.sorting)):data.tournament?`第 ${data.tournament.number} 轮 · 第 ${data.tournament.step}/5 场`:'匿名比较'} · ${data.progress.voted} 票已保存</span></div></footer></div><dialog id="pair-final-dialog" class="pair-modal pair-final-dialog" aria-labelledby="pair-final-title"></dialog><dialog id="pair-notes-dialog" class="pair-modal" aria-labelledby="pair-notes-title"></dialog><dialog id="pair-unable-dialog" class="pair-modal" aria-labelledby="pair-unable-title"></dialog><dialog id="pair-tools-dialog" class="pair-modal" aria-labelledby="pair-tools-title"></dialog><dialog id="pair-requirements-dialog" class="pair-modal pair-requirements-dialog" aria-labelledby="pair-requirements-title"><div class="pair-requirements-head"><h2 id="pair-requirements-title">完整需求与规范</h2><button id="pair-close-requirements" aria-label="关闭需求">关闭 ×</button></div>${requirementsPanel(pair)}<details class="pair-optional"><summary>表格中的原始 query</summary><pre>${esc(pair.query)}</pre></details>${pair.source_url?`<a href="${esc(pair.source_url)}" target="_blank" rel="noopener noreferrer">打开只读任务模板 ↗</a>`:''}</dialog>`;
    if(data.sorting?.status==='reviewing')$('.pair-brief').insertAdjacentHTML('beforeend','<p class="note" role="status">正在统一复核这两份作品：请逐屏查看后确认整体选择。本次确认会替代本轮这两份作品之间的旧判断，所有历史记录继续保留。左右位置可能变化，请按作品内容判断。</p>');
    app.querySelectorAll('[data-row]').forEach(b=>b.onclick=()=>move(Number(b.dataset.row)));
    $('#pair-prev').onclick=()=>move(index-1);$('#pair-next').onclick=()=>move(index+1);
    app.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{if(working)return;mode=b.dataset.mode;render();});
    $('#pair-size').onclick=()=>setScale('manual',1);
    $('#pair-fit').onclick=()=>setScale('fit');
    $('#pair-zoom-out').onclick=()=>stepScale(-1);$('#pair-zoom-in').onclick=()=>stepScale(1);
    $('#pair-zoom').onchange=e=>{const value=e.target.value;setScale(['readable','fit','width'].includes(value)?value:'manual',Number(value)/100||zoom);};

    $('#pair-task-list')?.addEventListener('click',()=>{if(!working){dispose();backToTasks();}});
    $('#pair-tools').onclick=openTools;$('#pair-notes').onclick=openNotes;$('#pair-unable').onclick=openUnable;
    $('#pair-show-final').onclick=openFinal;
    $('#pair-brief-toggle').onclick=()=>{briefOpen=!briefOpen;const panel=$('.pair-brief');panel.classList.toggle('is-collapsed',!briefOpen);$('.pair-brief-text').hidden=!briefOpen;$('#pair-brief-toggle').textContent=briefOpen?'收起需求':'展开需求';$('#pair-brief-toggle').setAttribute('aria-expanded',String(briefOpen));layoutImages();};
    $('#pair-requirements').onclick=()=>$('#pair-requirements-dialog').showModal();
    $('#pair-close-requirements').onclick=()=>$('#pair-requirements-dialog').close();
    app.querySelectorAll('[data-fix-row]').forEach(b=>b.onclick=()=>{move(Number(b.dataset.fixRow));openTools();});
    app.querySelectorAll('[data-pair-zoom]').forEach(b=>b.onclick=()=>{
      if(mode==='all')return move(Number(b.dataset.openRow));
      const side=b.dataset.pairZoom,visible=screens.images[side];
      openImages(visible.map(im=>pair.drafts[side].images[im.index]),visible.findIndex(im=>im.index===Number(b.dataset.imageIndex)));
    });
    app.querySelectorAll('[data-full-image]').forEach(b=>b.onclick=()=>{
      const side=b.dataset.fullImage,visible=screens.images[side];
      openImages(visible.map(im=>pair.drafts[side].images[im.index]),visible.findIndex(im=>im.index===current()[side]));
    });
    app.querySelectorAll('[data-screen-choice]').forEach(b=>b.onclick=()=>choose(b.dataset.screenChoice));
    app.querySelectorAll('[data-image-retry]').forEach(b=>b.onclick=()=>{
      const [side,n]=b.dataset.imageRetry.split(':'),im=pair.drafts[side].images[Number(n)],url=new URL(im.url,location.origin);
      url.searchParams.set('_retry',Date.now());im.url=url.pathname+url.search;render();
    });
    warmup?.images?.releaseHidden();
    warmup?.localCache?.releaseHidden();
    app.querySelectorAll('.paired-image-frame img').forEach(placeholder=>{
      const img=mode==='single'&&warmup?.images?warmup.images.mount(placeholder):placeholder;
      const cached=img.dataset.decoded==='true'&&img.complete&&img.naturalWidth>0;
      let decoding=false;img.dataset.decoded='false';
      img.closest('.pair-image-open')?.classList.add('is-loading');
      const retry=img.closest('.pair-shot')?.querySelector('[data-image-retry]');
      const live=()=>!disposed&&generation===imageGeneration&&img.isConnected;
      const timer=setTimeout(()=>{imageTimers.delete(timer);if(live()&&img.dataset.decoded!=='true'){img.closest('.pair-image-open')?.classList.remove('is-loading');if(retry)retry.hidden=false;}},20000);imageTimers.add(timer);
      const decoded=async()=>{
        if(decoding)return;decoding=true;
        try {
          if(!cached){
            try{await img.decode();}catch(error){if(!live()||!img.complete||!img.naturalWidth)throw error;await img.decode();}
          }
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          if(!live())return;
          clearTimeout(timer);imageTimers.delete(timer);if(retry)retry.hidden=true;
          img.dataset.decoded='true';img.closest('.pair-image-open')?.classList.remove('is-loading');updateDisabled();
        } catch {if(live()){clearTimeout(timer);imageTimers.delete(timer);img.alt='原图解码失败，请点击重试';img.closest('.pair-image-open')?.classList.remove('is-loading');if(retry){retry.textContent='原图加载失败，点此重试';retry.hidden=false;}updateDisabled();}}
      };
      img.onload=decoded;
      img.onerror=()=>{if(live()){clearTimeout(timer);imageTimers.delete(timer);img.alt='原图加载失败，请点击重试';img.closest('.pair-image-open')?.classList.remove('is-loading');if(retry){retry.textContent='原图加载失败，点此重试';retry.hidden=false;}updateDisabled();}};
      if(!img.getAttribute('src')){
        img.loadCachedImage=()=>{delete img.loadCachedImage;const url=img.dataset.sourceUrl;
          if(warmup?.localCache)warmup.localCache.mount(img,url,live);else if(live())img.src=url;
        };
        if(mode==='all'&&imageObserver)imageObserver.observe(img);else img.loadCachedImage();
      }
      if(img.complete&&img.naturalWidth>0)decoded();
    });
    app.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('cancel',e=>{if(working)e.preventDefault();}));
    resizeObserver.disconnect();resizeObserver.observe($('.pair-canvas'));
    screenMarks.bind();
    updateDisabled();
  }
  const keyboard=e=>{
    if(working||e.repeat||e.ctrlKey||e.metaKey||e.altKey||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;
    const dialog=document.querySelector('dialog[open]');
    if(dialog){
      if(dialog.id!=='pair-final-dialog')return;
      const choice=(data.choices.includes('tie')?{1:'A',2:'tie',3:'B'}:{1:'A',2:'B',3:'B'})[e.key];
      if(choice){e.preventDefault();selectOverall(choice);}
      else if(e.key==='Enter'){e.preventDefault();if(finalChoice)finalSubmit(finalChoice);}
      return;
    }
    if(e.key==='ArrowLeft'){e.preventDefault();move(index-1);}
    else if(e.key==='ArrowRight'){e.preventDefault();move(index+1);}
    else if(e.key==='4'){e.preventDefault();openUnable();}
    else if(['1','2','3'].includes(e.key)){
      e.preventDefault();const c={1:'A',2:'tie',3:'B'}[e.key],button=$(`[data-screen-choice="${c}"]`);
      if(!button.disabled)choose(c);
    }
  };
  document.addEventListener('keydown',keyboard);window.addEventListener('resize',resize);
  dispose=()=>{disposed=true;imageObserver?.disconnect();for(const timer of imageTimers)clearTimeout(timer);imageTimers.clear();resizeObserver.disconnect();cancelAnimationFrame(resizeFrame);window.removeEventListener('resize',resize);document.removeEventListener('keydown',keyboard);document.body.classList.remove('pair-review');dispose=()=>{};};
  render();if(screens.tally.complete)openFinal();
}
