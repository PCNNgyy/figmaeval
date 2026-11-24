export const SCREEN_SELECTION_POLICY='task-screen-names/v2';
export const frameKey=name=>String(name).normalize('NFKC').toLowerCase().replace(/[\s_\-–—·.:/()[\]]+/g,'');
const numbered=name=>/^\s*\d{2}[_ .·-]+\S/.test(String(name));
const library=name=>/^(?:(?:\d{2})[_ .·-]+)?(?:components?|tokens?|icons?|foundations?|assets?|media|library|patterns?|design[ _-]*system|ui[ _-]*(?:kit|system))(?=$|[ _\s.·-])/i.test(String(name).trim());
function texts(value){
  if(Array.isArray(value))return value.flatMap(texts);
  if(!value||typeof value!=='object')return [];
  return value.kind==='text'?[value.text]:Object.values(value).flatMap(texts);
}

export function requiredScreenNames(task){
  const declared=task?.required_frames||[],page=task?.pages?.find(p=>/^00(?:\b|[\s·._-])/.test(p.name||''));
  const literals=[...new Set(texts(page).join('\n').match(/\b\d{2}_[A-Za-z0-9_]+\b/g)||[])];
  const extra=literals.filter(name=>!name.endsWith('_')&&!literals.some(other=>other!==name&&other.startsWith(name+'_')));
  const seen=new Set();
  return [...declared,...extra].filter(name=>{
    const key=frameKey(name);if(!name||seen.has(key))return false;seen.add(key);return true;
  }).sort((a,b)=>(Number(a.match(/^\d+/)?.[0])||0)-(Number(b.match(/^\d+/)?.[0])||0));
}

export function isReviewScreenName(name,required=[]){
  if(required.length)return required.some(expected=>frameKey(expected)===frameKey(name));
  return numbered(name)&&!library(name);
}

export function selectReviewImages(images,required=[]){
  return {images:images.filter(im=>isReviewScreenName(im.name,required)),
    excluded:images.filter(im=>!isReviewScreenName(im.name,required)).map(im=>({...im,
      reason:numbered(im.name)?'not-in-task-screen-list':'supporting-board-or-unmatched-name'}))};
}
