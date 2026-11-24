export function createDecodedImages({localPath,budget=96*1024*1024,limit=8,makeImage=()=>new Image()}={}){
  const entries=new Map();let bytes=0,stopped=false;
  const touch=(url,entry)=>{entries.delete(url);entries.set(url,entry);};
  function trim(required=0){
    for(const [url,entry] of entries){
      if(bytes+required<=budget&&entries.size+(required?1:0)<=limit)break;
      if(entry.image.isConnected||(required&&entry.recentUntil>Date.now()))continue;
      entries.delete(url);bytes-=entry.bytes;
    }
    return bytes+required<=budget&&entries.size+(required?1:0)<=limit;
  }
  function mount(placeholder){
    if(stopped)return placeholder;
    const url=placeholder.dataset.sourceUrl||placeholder.getAttribute('src');let entry=entries.get(url);
    if(entry&&!entry.image.isConnected&&entry.image.complete&&entry.image.naturalWidth>0){
      const image=entry.image,decoded=image.dataset.decoded;
      for(const attr of [...placeholder.attributes])if(attr.name!=='src'&&image.getAttribute(attr.name)!==attr.value)image.setAttribute(attr.name,attr.value);
      image.dataset.decoded=decoded||'false';
      placeholder.replaceWith(image);entry.recentUntil=Date.now()+30000;touch(url,entry);return image;
    }
    if(!entry||!entry.image.isConnected){
      if(entry){entries.delete(url);bytes-=entry.bytes;}
      const size=Number(placeholder.dataset.bitmapBytes)||0;
      entry={image:placeholder,bytes:size,recentUntil:Date.now()+30000};entries.set(url,entry);bytes+=size;trim();
    }
    return placeholder;
  }
  async function prepare(items){
    for(const im of items){
      if(stopped)return;
      const url=localPath(im.url);if(entries.has(url))continue;
      const size=im.width*im.height*4;if(!Number.isFinite(size)||size>budget||!trim(size))continue;
      const image=makeImage();image.decoding='async';image.fetchPriority='low';image.dataset.decoded='false';
      const entry={image,bytes:size};entries.set(url,entry);bytes+=size;image.src=url;
      try{await image.decode();if(!image.isConnected)image.dataset.decoded='true';}
      catch{if(entries.get(url)===entry){entries.delete(url);bytes-=size;}}
    }
  }
  function releaseHidden(){
    for(const [url,entry] of entries)if(!entry.image.isConnected&&!entry.image.complete){
      entry.image.onload=null;entry.image.onerror=null;entry.image.removeAttribute('src');entries.delete(url);bytes-=entry.bytes;
    }
  }
  return{mount,prepare,releaseHidden,stop(){stopped=true;releaseHidden();entries.clear();bytes=0;},stats:()=>({entries:entries.size,bytes,budget})};
}
