export {};
type Model = typeof import('../data/paper').models[number];
type Dimension = typeof import('../data/paper').dimensions[number];
type Step = typeof import('../data/paper').steps[number];
const data = JSON.parse(document.querySelector('#page-data')!.textContent!) as { tasks: {screen: string}[]; models: Model[]; dimensions: Dimension[]; steps: Step[]; base: string };
const { models, dimensions, steps, base } = data;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-task]')];
const previewTask = $<HTMLSelectElement>('preview-task');
const previews = document.querySelectorAll<HTMLElement>('[data-preview]');
function selectPreview(value: string) {
  previewTask.value = value;
  previews.forEach(preview => { preview.hidden = preview.dataset.preview !== value; });
  const detail = $<HTMLAnchorElement>('gallery-detail');
  const starter = value === 'starter';
  detail.textContent = starter ? 'Explore the starter file ↘' : data.tasks[Number(value)].screen + ' ↘';
  detail.hash = starter ? 'benchmark' : 'showcase';
}

function showPreview(value: string) {
  if (value === 'starter') selectPreview(value);
  else selectTask(Number(value));
}

previewTask.addEventListener('change', () => {
  pauseGallery();
  showPreview(previewTask.value);
});

function selectTask(index: number, focus = false) {
  selectPreview(String(index));
  tabs.forEach((tab,i) => {
    tab.setAttribute('aria-selected', String(i === index));
    tab.tabIndex = i === index ? 0 : -1;
    $(tab.getAttribute('aria-controls')!).hidden = i !== index;
  });
  if (focus) tabs[index].focus();
}
tabs.forEach((tab,index) => {
  tab.addEventListener('click', () => selectTask(index));
  tab.addEventListener('keydown', event => {
    const next = {ArrowRight:(index+1)%tabs.length,ArrowLeft:(index+tabs.length-1)%tabs.length,Home:0,End:tabs.length-1}[event.key];
    if (next !== undefined) {event.preventDefault();selectTask(next,true);}
  });
});

const canvas = document.querySelector<HTMLElement>('.design-canvas')!;
const galleryPlay = $<HTMLButtonElement>('gallery-play');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let playing = !reducedMotion.matches;
let inView = false;
let slideTimer: ReturnType<typeof setTimeout> | undefined;

function advanceGallery(delta: number) {
  const options = previewTask.options;
  const next = (previewTask.selectedIndex + delta + options.length) % options.length;
  showPreview(options[next].value);
}

function scheduleGallery() {
  clearTimeout(slideTimer);
  galleryPlay.setAttribute('aria-label', playing ? 'Pause gallery' : 'Play gallery');
  galleryPlay.firstElementChild!.textContent = playing ? 'Ⅱ' : '▶';
  if (playing && inView && !document.hidden) {
    slideTimer = setTimeout(() => {
      advanceGallery(1);
      scheduleGallery();
    }, 6500);
  }
}

function pauseGallery() {
  playing = false;
  scheduleGallery();
}

for (const control of [previewTask, $('previous-preview'), $('next-preview'), $('gallery-detail'), ...tabs, ...canvas.querySelectorAll('button[data-zoom]')]) {
  control.addEventListener('focus', pauseGallery);
  control.addEventListener('click', pauseGallery);
}
$('previous-preview').addEventListener('click', () => advanceGallery(-1));
$('next-preview').addEventListener('click', () => advanceGallery(1));
galleryPlay.addEventListener('click', () => { playing = !playing; scheduleGallery(); });
document.addEventListener('visibilitychange', scheduleGallery);
reducedMotion.addEventListener('change', pauseGallery);
new IntersectionObserver(([entry]) => {
  inView = entry.isIntersecting;
  scheduleGallery();
}, { threshold: 0.25 }).observe(canvas);

const arrivals = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    if (!reducedMotion.matches) {
      entry.target.animate([{ opacity: 0.45, transform: 'translateY(22px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: 520, easing: 'cubic-bezier(.22,.7,.25,1)' });
    }
    arrivals.unobserve(entry.target);
  }
}, { threshold: 0.12 });
document.querySelectorAll('.section-top, .overview-links, .result-highlights, .scale-band dl').forEach(node => arrivals.observe(node));

const modes = document.querySelectorAll<HTMLButtonElement>('[data-mode]');
modes.forEach(mode => mode.addEventListener('click', () => {
  const overlay = mode.dataset.mode === 'wipe';
  modes.forEach(button => button.setAttribute('aria-pressed', String(button === mode)));
  document.querySelectorAll<HTMLElement>('.comparison-stage').forEach(stage => { stage.hidden = overlay; });
  document.querySelectorAll<HTMLElement>('.wipe-stage').forEach(stage => { stage.hidden = !overlay; });
}));
document.querySelectorAll<HTMLInputElement>('.wipe-input').forEach(input => {
  input.addEventListener('input', () => {
    input.parentElement!.style.setProperty('--split', input.value + '%');
    input.setAttribute('aria-valuetext', input.value + ' percent Claude Opus');
  });
});

const dialog = $<HTMLDialogElement>('image-dialog');
function openDialog(content: HTMLElement, caption: string) {
  $('dialog-caption').textContent = caption;
  $('dialog-content').replaceChildren(content);
  dialog.showModal();
  document.body.style.overflow = 'hidden';
}
document.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach(button => button.addEventListener('click', () => {
  const content = button.querySelector('.paper-crop')!.cloneNode(true) as HTMLElement;
  content.querySelector('img')!.loading = 'eager';
  openDialog(content, button.dataset.caption!);
}));
document.querySelectorAll<HTMLButtonElement>('[data-figure]').forEach(button => button.addEventListener('click', () => {
  const img = document.createElement('img');
  img.src = `${base}assets/${button.dataset.figure}`;
  img.alt = button.dataset.caption!;
  openDialog(img, button.dataset.caption!);
}));
$('close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => {if (event.target === dialog) dialog.close();});
dialog.addEventListener('close', () => {document.body.style.overflow = '';});

let activeStep = 0;
let playback: ReturnType<typeof setInterval> | undefined;
const replay = $<HTMLButtonElement>('replay');
const stepButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-step]')];
function stopPlayback() {
  clearInterval(playback);playback = undefined;
  replay.setAttribute('aria-pressed','false');
  replay.querySelector('span')!.textContent = 'Play sequence';
}
function selectStep(index: number) {
  activeStep = index;
  stepButtons.forEach((button,i) => {
    button.classList.toggle('active',i === index);
    button.setAttribute('aria-pressed',String(i === index));
    button.querySelector('.step-marker')!.textContent = i <= index ? '✓' : '◇';
  });
  const step = steps[index];
  const image = $<HTMLImageElement>('process-image');
  image.src = `${base}assets/${step.image}`;
  image.alt = step.title;
  $('step-title').textContent = step.title;
  $('step-description').textContent = step.description;
  $('step-count').textContent = `${index+1} / ${steps.length}`;
}
stepButtons.forEach((button,i) => button.addEventListener('click',() => {stopPlayback();selectStep(i);}));
replay.addEventListener('click', () => {
  if (playback) {stopPlayback();return;}
  if (activeStep === steps.length-1) selectStep(0);
  replay.setAttribute('aria-pressed','true');
  replay.querySelector('span')!.textContent = 'Pause sequence';
  playback = setInterval(() => {
    if (activeStep >= steps.length-1) {stopPlayback();return;}
    selectStep(activeStep+1);
    if (activeStep === steps.length-1) stopPlayback();
  },3000);
});
document.addEventListener('visibilitychange', () => {if(document.hidden) stopPlayback();});

const search = $<HTMLInputElement>('model-search');
const sort = $<HTMLSelectElement>('result-sort');
function renderResults() {
  const metric = sort.value as 'overall' | 'elo' | 'winRate';
  const ranked = [...models].sort((a,b) => b[metric]-a[metric]);
  const filtered = ranked.filter(m => m.name.toLowerCase().includes(search.value.trim().toLowerCase()));
  $('model-rows').innerHTML = filtered.map(m => {
    const rank = ranked.findIndex(item => item[metric] === m[metric])+1;
    return `<tr><td class="rank">${String(rank).padStart(2,'0')}</td><th scope="row">${escapeHtml(m.name)}${m.overall===86.70?'<span class="best-badge">Top rubric score</span>':''}</th><td class="score-cell"><div><span class="score-bar" style="width:${m.overall}%"></span><strong>${m.overall.toFixed(2)}<small>%</small></strong></div></td><td>${m.elo.toFixed(2)}</td><td>${m.winRate.toFixed(2)}%</td></tr>`;
  }).join('');
  $('no-models').hidden = filtered.length !== 0;
}
search.addEventListener('input',renderResults);
sort.addEventListener('change',renderResults);

const a = $<HTMLSelectElement>('profile-a');
const b = $<HTMLSelectElement>('profile-b');
function renderProfiles() {
  const modelA = models[Number(a.value)], modelB = models[Number(b.value)];
  const center = [230,176], radius = 122;
  const point = (i: number, value: number, extra = 0) => {
    const angle = i*Math.PI/3-Math.PI/2;
    return [center[0]+Math.cos(angle)*(radius*value/100+extra),center[1]+Math.sin(angle)*(radius*value/100+extra)];
  };
  const polygon = (values: number[]) => values.map((value,i)=>point(i,value).join(',')).join(' ');
  const grid = [20,40,60,80,100].map(value => `<polygon points="${polygon(Array(6).fill(value))}" fill="none" stroke="#e4ddeb" stroke-width="1"/>`).join('');
  const axes = dimensions.map((d,i) => {
    const [x,y] = point(i,100), [tx,ty] = point(i,100,30);
    return `<line x1="${center[0]}" y1="${center[1]}" x2="${x}" y2="${y}" stroke="#e9e3ef"/><text x="${tx}" y="${ty+4}" text-anchor="middle" fill="#51495c" font-family="DM Sans,sans-serif" font-size="18">${escapeHtml(d.short)}</text>`;
  }).join('');
  const renderModel = (model: Model,color: string) => `<polygon points="${polygon(model.scores)}" fill="${color}" fill-opacity=".10" stroke="${color}" stroke-width="2"/>` + model.scores.map((value,i) => {
    const [x,y] = point(i,value);
    return `<circle cx="${x}" cy="${y}" r="3" fill="${color}"><title>${escapeHtml(model.name)} · ${escapeHtml(dimensions[i].name)}: ${value.toFixed(2)}%</title></circle>`;
  }).join('');
  $('radar').innerHTML = `<title>${escapeHtml(modelA.name)} compared with ${escapeHtml(modelB.name)} across six rubric dimensions</title>${grid}${axes}<text x="237" y="60" fill="#746c80" font-size="15">100</text>${renderModel(modelA,'#7052e8')}${renderModel(modelB,'#df937b')}`;
  $('radar').setAttribute('aria-label', `${modelA.name} compared with ${modelB.name} across six rubric dimensions`);
  $('profile-values').innerHTML = dimensions.map((d,i) => `<div><span>${escapeHtml(d.name)}</span><strong>${modelA.scores[i].toFixed(2)}</strong><span class="value-divider">/</span><strong>${modelB.scores[i].toFixed(2)}</strong></div>`).join('');
}
a.addEventListener('change',renderProfiles);
b.addEventListener('change',renderProfiles);
renderProfiles();

$('copy-citation').addEventListener('click',async () => {
  const text = $('citation').textContent!;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else throw new Error('Clipboard unavailable');
    $('copy-citation').textContent = 'Copied';
    $('copy-status').textContent = 'BibTeX copied to clipboard.';
    setTimeout(() => {$('copy-citation').textContent = 'Copy BibTeX';},2200);
  } catch {
    const range = document.createRange(); range.selectNodeContents($('citation'));
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    $('copy-citation').textContent = 'Select the citation below';
    $('copy-status').textContent = 'Copy unavailable. Select and copy the citation below.';
  }
});
