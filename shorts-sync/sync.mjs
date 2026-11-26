// Node 18+. No scraping, rendering, publishing or source-file deletion.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const config=JSON.parse(await fs.readFile(path.join(here,'config.json'),'utf8'));
const base=new URL(config.api_url);if(base.protocol!=='https:'&&base.hostname!=='127.0.0.1')throw Error('HTTPS required');
const key=process.env.SHORTS_ROOM_KEY;if(!key)throw Error('SHORTS_ROOM_KEY is required (use run.ps1)');
const materials=path.resolve(config.materials_dir),outputs=path.resolve(config.outputs_dir),statePath=path.join(here,'sync-state.json');
let state={downloads:{},uploads:{}};try{state=JSON.parse(await fs.readFile(statePath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
const lockPath=path.join(here,'sync.lock');let lock;
try{lock=await fs.open(lockPath,'wx');await lock.writeFile(String(process.pid));}catch(e){if(e.code==='EEXIST'){const st=await fs.stat(lockPath);if(Date.now()-st.mtimeMs>60*60*1000)throw Error('Stale sync.lock: check previous process before removing');process.exit(0);}throw e;}
function safe(s){const name=String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').trim().slice(0,100);if(!name||/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name))throw Error('Invalid product name');return name;}
function within(root,...parts){const dest=path.resolve(root,...parts);if(!dest.startsWith(root+path.sep))throw Error('Path escaped root');return dest;}
async function api(route='',method='GET',body){const response=await fetch(new URL('/api/shorts-workroom'+route,base),{method,headers:{Authorization:'Bearer '+key,...(Buffer.isBuffer(body)?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});if(!response.ok){const e=Error('API HTTP '+response.status);e.status=response.status;throw e;}return response.json();}
async function persist(){const tmp=statePath+'.tmp';await fs.writeFile(tmp,JSON.stringify(state,null,2));await fs.rename(tmp,statePath);}
async function digest(p){const h=createHash('sha256');for await(const b of createReadStream(p))h.update(b);return h.digest('hex');}
async function download(card,slot,folder){const f=card.files[slot];if(!f)return null;
 const ext=path.extname(f.name).toLowerCase();if(!/^\.[a-z0-9]{1,6}$/.test(ext))throw Error('Unsupported file extension');
 const name=(slot==='source'?safe(card.product):slot==='narration_kr'?'나레이션_한':'나레이션_일')+ext;
 const dest=within(folder,name),cacheKey=card.id+':'+slot,old=state.downloads[cacheKey];
 if(old?.id===f.id){try{const stat=await fs.stat(dest);if(stat.size===f.size&&await digest(dest)===old.sha256)return {id:f.id,path:dest};}catch(e){if(e.code!=='ENOENT')throw e;}}
 const tmp=dest+'.'+f.id+'.part';const r=await fetch(new URL(f.url,base),{headers:{Authorization:'Bearer '+key},signal:AbortSignal.timeout(600000)});if(!r.ok)throw Error('Download HTTP '+r.status);
 await pipeline(Readable.fromWeb(r.body),createWriteStream(tmp,{flags:'w'}));if((await fs.stat(tmp)).size!==f.size)throw Error('Download size mismatch');
 // Keep the previous version; never silently overwrite manually edited material.
 try{await fs.access(dest);await fs.rename(dest,dest+'.previous-'+Date.now());}catch(e){if(e.code!=='ENOENT')throw e;}
 await fs.rename(tmp,dest);state.downloads[cacheKey]={id:f.id,sha256:await digest(dest)};await persist();return {id:f.id,path:dest};
}
async function upload(card,slot,p){const st=await fs.stat(p);if(Date.now()-st.mtimeMs<30000)return false;
 const hash=await digest(p),k=card.id+':'+slot;if(state.uploads[k]?.sha256===hash&&card.files[slot]?.id===state.uploads[k]?.id)return true;
 const ext=path.extname(p).toLowerCase(),mime={'.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.txt':'text/plain'}[ext];if(!mime)throw Error('Unsupported output extension');
 const init=await api(`/${card.id}/files`,'POST',{slot,name:path.basename(p),mime,size:st.size});
 const file=await fs.open(p,'r');try{for(let offset=0,n=1;offset<st.size;offset+=init.part_size,n++){
 const b=Buffer.alloc(Math.min(init.part_size,st.size-offset));const read=await file.read(b,0,b.length,offset);if(read.bytesRead!==b.length)throw Error('Output changed during upload');await api(`/${card.id}/files/${init.id}/part?number=${n}`,'POST',b);
 }}finally{await file.close();}
 const after=await fs.stat(p);if(after.size!==st.size||after.mtimeMs!==st.mtimeMs)throw Error('Output changed during upload; retry next cycle');
 await api(`/${card.id}/files/${init.id}/complete`,'POST',{});state.uploads[k]={sha256:hash,id:init.id};await persist();return true;
}
async function patch(id,body){for(let attempt=0;attempt<3;attempt++){const c=(await api('/'+id)).card;try{return (await api('/'+id,'PATCH',{...body,version:c.version,actor:'PC 동기화'})).card;}catch(e){if(e.status!==409||attempt===2)throw e;}}}
try{
 const data=await api();if(!data.storage_ready){console.log('R2 storage pending: no file transfer attempted');process.exitCode=2;}else{
 await fs.mkdir(materials,{recursive:true});await fs.mkdir(outputs,{recursive:true});
 for(let card of data.cards.filter(c=>!c.archived)){
 const folder=within(materials,`${card.id}.${safe(card.product)}`);await fs.mkdir(folder,{recursive:true});
 const synced={};for(const slot of ['source','narration_kr','narration_jp']){const f=await download(card,slot,folder);if(f)synced[slot]=f;}
 if(card.script.confirmed){for(const lang of ['kr','jp'])await fs.writeFile(within(folder,`대본_${lang==='kr'?'한':'일'}.txt`),card.script['final_'+lang],'utf8');}
 if(Object.keys(synced).some(k=>!card.files[k].synced)||card.script.confirmed&&!card.script.pc_synced){
 card=await patch(card.id,{action:'pc_synced',files:synced,script_version:card.script.confirmed?card.script.final_kr+'\n'+card.script.final_jp:''});
 }
 await fs.writeFile(within(folder,'카드정보.json'),JSON.stringify(card,null,2));
 // Explicit per-card folder: never guess files from another product or upload every MP4.
 const outputFolder=within(outputs,`${card.id}.${safe(card.product)} 한${safe(card.littly_kr||'미정')} 일${safe(card.littly_jp||'미정')}`);
 if(!['render','done'].includes(card.stage))continue;
 let listing;try{listing=await fs.readdir(outputFolder);}catch(e){if(e.code==='ENOENT')continue;throw e;}
 const mapping={video_kr:'완성본_한.mp4',video_jp:'완성본_일.mp4',thumbnail_kr:'썸네일_한.png',thumbnail_jp:'썸네일_일.png',upload_notes:'업로드메모.txt'};
 for(const [slot,name]of Object.entries(mapping))if(listing.includes(name))await upload(card,slot,within(outputFolder,name));
 // File presence alone is not quality approval. Renderer must explicitly mark review complete.
 if(listing.includes('검수완료.json')&&card.stage==='render'){
 const approval=JSON.parse(await fs.readFile(within(outputFolder,'검수완료.json'),'utf8'));
 if(approval.card_id===card.id&&approval.reviewed===true&&approval.video_kr_sha256&&approval.video_jp_sha256){
 const kr=within(outputFolder,mapping.video_kr),jp=within(outputFolder,mapping.video_jp);
 const latest=(await api('/'+card.id)).card;
 if(await digest(kr)===approval.video_kr_sha256&&await digest(jp)===approval.video_jp_sha256&&latest.files.video_kr?.id===state.uploads[card.id+':video_kr']?.id&&latest.files.video_jp?.id===state.uploads[card.id+':video_jp']?.id)await patch(card.id,{action:'complete_render'});
 }
 }
 console.log('Card '+card.id+': sync checked');
 }
 }
}finally{await lock.close();await fs.unlink(lockPath);}
