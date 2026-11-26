import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
test('PC sync downloads bytes to isolated card folder, uploads only named stable results and waits for quality approval',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'shorts-sync-test-')),materials=path.join(root,'input'),outputs=path.join(root,'output');
 await fs.copyFile(new URL('../shorts-sync/sync.mjs',import.meta.url),path.join(root,'sync.mjs'));
 const bytes=Buffer.from('fixture media bytes'),uploads=new Map();let next=0,completions=0;
 const card={id:7,version:1,product:'fixture',stage:'render',assignee:'클로드',archived:false,littly_kr:'245',littly_jp:'23',script:{confirmed:true,pc_synced:false,final_kr:'대본',final_jp:'台本'},files:{},outputs:{}};
 for(const slot of ['source','narration_kr','narration_jp'])card.files[slot]={id:slot,name:slot==='source'?'source.mp4':'voice.mp3',mime:slot==='source'?'video/mp4':'audio/mpeg',size:bytes.length,url:'/api/shorts-workroom/7/files/'+slot,synced:false};
 const server=http.createServer(async(req,res)=>{
 try{assert.equal(req.headers.authorization,'Bearer test-only');let input=Buffer.alloc(0);for await(const b of req)input=Buffer.concat([input,b]);
 const u=new URL(req.url,'http://localhost'),p=u.pathname.replace('/api/shorts-workroom',''),body=req.headers['content-type']==='application/json'&&input.length?JSON.parse(input):input;
 let data;
 if(p===''&&req.method==='GET')data={storage_ready:true,cards:[card]};
 else if(p==='/7'&&req.method==='GET')data={card};
 else if(p==='/7'&&req.method==='PATCH'){
 assert.equal(body.version,card.version);card.version++;
 if(body.action==='pc_synced'){for(const [slot,f]of Object.entries(body.files))if(card.files[slot].id===f.id)card.files[slot].synced=true;card.script.pc_synced=true;}
 if(body.action==='complete_render'){completions++;card.stage='done';}data={card};
 }else if(p==='/7/files'&&req.method==='POST'){const id='u'+(++next);uploads.set(id,{...body,bytes:[]});data={id,part_size:8*1048576};}
 else if(p.includes('/part')&&req.method==='POST'){uploads.get(p.split('/')[3]).bytes.push(input);data={ok:true};}
 else if(p.endsWith('/complete')){const id=p.split('/')[3],f=uploads.get(id);assert.deepEqual(Buffer.concat(f.bytes),bytes);card.files[f.slot]={id};data={card};}
 else if(req.method==='GET'&&p.startsWith('/7/files/')){res.end(bytes);return;}
 else throw Error('Unexpected route '+req.method+' '+p);
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,...data}));
 }catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.message}));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 await fs.writeFile(path.join(root,'config.json'),JSON.stringify({api_url:`http://127.0.0.1:${server.address().port}`,materials_dir:materials,outputs_dir:outputs}));
 const out=path.join(outputs,'7.fixture 한245 일23');await fs.mkdir(out,{recursive:true});
 for(const name of ['완성본_한.mp4','완성본_일.mp4','unrelated.mp4']){await fs.writeFile(path.join(out,name),bytes);await fs.utimes(path.join(out,name),new Date(0),new Date(0));}
 async function run(){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[path.join(root,'sync.mjs')],{env:{...process.env,SHORTS_ROOM_KEY:'test-only'}});let err='';p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error(err)));});}
 try{
 await run();assert.deepEqual(await fs.readFile(path.join(materials,'7.fixture','fixture.mp4')),bytes);assert.equal(await fs.readFile(path.join(materials,'7.fixture','대본_한.txt'),'utf8'),'대본');
 assert.equal(uploads.size,2);assert.equal(completions,0);
 await run();assert.equal(uploads.size,2,'same hash must not upload twice');
 const hash=createHash('sha256').update(bytes).digest('hex');await fs.writeFile(path.join(out,'검수완료.json'),JSON.stringify({card_id:7,reviewed:true,video_kr_sha256:hash,video_jp_sha256:hash}));
 await run();assert.equal(completions,1);assert.equal(card.stage,'done');
 }finally{await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});}
});
