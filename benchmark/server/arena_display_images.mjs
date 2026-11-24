import fs from 'node:fs';
import path from 'node:path';
export function readDisplayImages(directory,snapshot){
 const file=path.join(directory,'display-media.json');if(!fs.existsSync(file))return new Map();
 const data=JSON.parse(fs.readFileSync(file));if(data.kind!=='arena-lossless-display/v1'||!data.variants)throw Error('Invalid lossless display manifest');
 const originals=new Map(snapshot.candidates.flatMap(c=>c.images.map(im=>[im.sha256,im]))),result=new Map();
 for(const [sha,v] of Object.entries(data.variants)){
  const im=originals.get(sha);
  if(!im||v.source_sha256!==sha||v.file!==`display-media/${sha}.webp`||!/^[a-f0-9]{64}$/.test(v.sha256)||!/^[a-f0-9]{64}$/.test(v.pixel_sha256)
   ||v.width!==im.width||v.height!==im.height||!Number.isSafeInteger(v.bytes)||v.bytes<=0)throw Error('Display copy does not match frozen evidence');
  result.set(sha,v);
 }
 return result;
}
