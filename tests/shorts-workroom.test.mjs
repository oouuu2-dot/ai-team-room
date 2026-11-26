import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {runInNewContext} from 'node:vm';
import {webcrypto,createHmac} from 'node:crypto';
const src=readFileSync(new URL('../_worker.js',import.meta.url),'utf8');
function fixture(storage=true){
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){let args=[];return {bind(...v){args=v;return this;},async first(){return db.prepare(sql).get(...args);},async all(){return {results:db.prepare(sql).all(...args)};},async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:r.changes,last_row_id:Number(r.lastInsertRowid)}};}};},async batch(stmts){db.exec('BEGIN');try{const r=[];for(const s of stmts)r.push(await s.run());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const objects=new Map(),uploads=new Map();let n=0;
 const R2={async createMultipartUpload(key){const uploadId=String(++n);uploads.set(uploadId,{key,parts:new Map()});return {uploadId};},resumeMultipartUpload(key,id){const u=uploads.get(id);assert.equal(u.key,key);return {async uploadPart(number,bytes){u.parts.set(number,new Uint8Array(bytes));return {partNumber:number,etag:'etag'+number};},async complete(parts){const b=Buffer.concat(parts.map(p=>Buffer.from(u.parts.get(p.partNumber))));objects.set(key,b);return {size:b.length};}};},async head(key){const b=objects.get(key);return b?{size:b.length}:null;},async get(key,options){const b=objects.get(key);if(!b)return null;let body=b,range;if(options?.range){const match=options.range.get('range').match(/bytes=(\d+)-(\d*)/);const offset=Number(match[1]),end=match[2]?Math.min(Number(match[2]),b.length-1):b.length-1;range={offset,length:end-offset+1};body=b.subarray(offset,end+1);}return {body,size:b.length,httpEtag:'"etag"',range};}};
 const env={DB,ROOM_KEY:'test',...(storage?{SHORTS_FILES:R2}:{})};
 const api=runInNewContext(src.replace('export default {','const worker = {')+'\n({handleApi,shortsApi,swRead,swSave,swTicketValid,officeStorage})',{Request,Response,Headers,URL,console,crypto:webcrypto,Uint8Array,TextEncoder,TextDecoder,atob,btoa});
 async function call(route='',method='GET',body,auth=true,headers={}){const req=new Request('https://test/api/shorts-workroom'+route,{method,headers:{...(auth?{Authorization:'Bearer test'}:{}),...headers},body:body===undefined?undefined:body instanceof Uint8Array?body:JSON.stringify(body)});const handler=auth&&method!=='GET'?api.shortsApi:api.handleApi;const r=await handler(req,env,new URL(req.url));return {status:r.status,data:r.headers.get('content-type')?.includes('json')?await r.json():await r.arrayBuffer(),headers:r.headers};}
 return {db,env,api,call};
}
async function create(f){const r=await f.call('','POST',{product:'시험 제품',actor:'뮤즈'});assert.equal(r.status,201);return r.data.card;}
async function mutate(f,c,action,body={}){return f.call('/'+c.id,'PATCH',{version:c.version,actor:'똑똑이',action,...body});}
test('authentication, card isolation, optimistic concurrency, source validation',async()=>{
 const f=fixture();assert.equal((await f.call('','GET',undefined,false)).status,401);
 let c=await create(f);assert.equal((await mutate(f,c,'confirm_source')).status,400);
 assert.equal((await mutate(f,c,'save',{sources:[{url:'javascript:alert(1)'}]})).status,400);
 const saved=await mutate(f,c,'save',{sources:[{url:'https://example.com/clip',review:'pass',main:true}]});
 assert.equal((await mutate(f,c,'save',{note:'stale'})).status,409);c=saved.data.card;
 c=(await mutate(f,c,'confirm_source')).data.card;assert.equal(c.stage,'script');assert.equal(c.assignee,'피클3');
 assert.equal(f.db.prepare('select count(*) n from shorts_events').get().n,1);
 assert.equal(f.db.prepare("select count(*) n from messages where room_slug='shorts'").get().n,1);
 await f.call();assert.equal(f.db.prepare("select count(*) n from messages where room_slug='shorts'").get().n,1);
 const other=await create(f);assert.equal(other.stage,'source');f.db.close();
});
test('render requires both scripts, confirmed materials and exact file sync identities; rewind clears old completion',async()=>{
 const f=fixture();let c=await create(f);
 c=(await mutate(f,c,'save',{sources:[{url:'https://example.com/v',review:'pass',main:true}]})).data.card;
 c=(await mutate(f,c,'confirm_source')).data.card;
 assert.equal((await mutate(f,c,'confirm_script')).status,400);
 c=(await mutate(f,c,'save',{script:{draft_kr:'초안',draft_jp:'下書き',final_kr:'확정',final_jp:'確定'}})).data.card;
 c=(await mutate(f,c,'submit_draft')).data.card;assert.equal(c.assignee,'클로드');
 c=(await mutate(f,c,'submit_final')).data.card;assert.equal(c.assignee,'똑똑이');
 c=(await mutate(f,c,'confirm_script')).data.card;assert.equal(c.stage,'narration');
 c.files={source:{id:'s'},narration_kr:{id:'k'},narration_jp:{id:'j'}};c=await f.api.swSave(f.env,c,c.version);
 c=(await mutate(f,c,'save',{littly_kr:'245',littly_jp:'23'})).data.card;
 c=(await mutate(f,c,'pc_synced',{files:{source:{id:'wrong'},narration_kr:{id:'k'},narration_jp:{id:'j'}},script_version:'확정\n確定'})).data.card;assert.equal(c.stage,'narration');
 c=(await mutate(f,c,'pc_synced',{files:{source:{id:'s'}},script_version:'확정\n確定'})).data.card;assert.equal(c.stage,'render');
 assert.equal((await mutate(f,c,'complete_render')).status,400);
 c.files.video_kr={id:'vk'};c.files.video_jp={id:'vj'};c=await f.api.swSave(f.env,c,c.version);
 c=(await mutate(f,c,'complete_render')).data.card;assert.equal(c.stage,'done');
 c=(await mutate(f,c,'rewind',{note:'수정'})).data.card;assert.equal(c.stage,'render');assert.equal(c.files.video_kr,undefined);f.db.close();
});
test('multipart bytes, size limits, retry, scoped expiring media tickets and range playback',async()=>{
 const f=fixture(),c=await create(f),size=8*1024*1024+17;
 assert.equal((await f.call(`/${c.id}/files`,'POST',{slot:'source',name:'a.mp4',mime:'video/mp4',size:500*1024*1024+1})).status,400);
 assert.equal((await f.call(`/${c.id}/files`,'POST',{slot:'source',name:'a.svg',mime:'image/svg+xml',size:5})).status,400);
 const init=await f.call(`/${c.id}/files`,'POST',{slot:'source',name:'a.mp4',mime:'video/mp4',size});assert.equal(init.status,201);const id=init.data.id;
 assert.equal((await f.call(`/${c.id}/files/${id}/complete`,'POST',{})).status,400);
 assert.equal((await f.call(`/${c.id}/files/${id}/part?number=1`,'POST',new Uint8Array(4))).status,400);
 assert.equal((await f.call(`/${c.id}/files/${id}/part?number=1`,'POST',new Uint8Array(8*1024*1024).fill(7))).status,200);
 assert.equal((await f.call(`/${c.id}/files/${id}/part?number=2`,'POST',new Uint8Array(17).fill(9))).status,200);
 const complete=await f.call(`/${c.id}/files/${id}/complete`,'POST',{});assert.equal(complete.status,200);
 const again=await f.call(`/${c.id}/files/${id}/complete`,'POST',{});assert.equal(again.data.card.version,complete.data.card.version);
 const ticket=(await f.call(`/${c.id}/files/${id}/ticket`,'POST',{})).data.url.split('?')[1];
 const ranged=await f.call(`/${c.id}/files/${id}?${ticket}`,'GET',undefined,false,{Range:'bytes=8388608-8388610'});assert.equal(ranged.status,206);assert.deepEqual([...new Uint8Array(ranged.data)],[9,9,9]);
 assert.equal((await f.call(`/${c.id}/files/wrong?${ticket}`,'GET',undefined,false)).status,401);
 f.db.prepare('update shorts_tickets set expires=0').run();assert.equal((await f.call(`/${c.id}/files/${id}?${ticket}`,'GET',undefined,false)).status,401);f.db.close();
});
test('missing R2 is explicit and does not claim upload success',async()=>{const f=fixture(false),c=await create(f);assert.equal((await f.call()).data.storage_ready,false);assert.equal((await f.call(`/${c.id}/files`,'POST',{})).status,503);f.db.close();});
test('public legacy mutations stop before database access after move to office',async()=>{
 const f=fixture();
 const req=new Request('https://test/api/shorts-workroom',{method:'POST',headers:{Authorization:'Bearer test'},body:JSON.stringify({product:'must not create'})});
 const response=await f.api.handleApi(req,f.env,new URL(req.url));
 assert.equal(response.status,410);assert.equal((await response.json()).target,'https://oouuu2.pythonanywhere.com/');
 assert.equal(f.db.prepare("select count(*) n from sqlite_master where name='shorts_cards'").get().n,0);f.db.close();
});
test('office file gateway works without D1 and checks scoped signed capabilities and receipts',async()=>{
 const f=fixture();f.env.DB={prepare(){throw Error('Gateway must never query D1');}};
 const cid=12,fid='00000000-0000-4000-8000-000000000001',size=17;
 function token(purpose,extra={}){const body=Buffer.from(JSON.stringify({purpose,file_id:fid,card_id:cid,key:`office/cards/${cid}/${fid}`,size,mime:'video/mp4',name:'검증.mp4',exp:Math.floor(Date.now()/1000)+1800,...extra})).toString('base64url');return body+'.'+createHmac('sha256','test').update(body).digest('base64url');}
 async function call(action,ticket,body,method='POST',query=''){
 const u=new URL('https://test/api/office-shorts-storage/'+action+'?ticket='+ticket+query),req=new Request(u,{method,body:body===undefined?undefined:body instanceof Uint8Array?body:JSON.stringify(body)});
 return f.api.handleApi(req,f.env,u);}
 assert.equal((await call('start','forged',{})).status,401);
 assert.equal((await call('start',token('read'),{})).status,403);
 assert.equal((await call('start',token('upload',{exp:0}),{})).status,401);
 const ticket=token('upload'),start=await (await call('start',ticket,{})).json();
 const part=await (await call('part',ticket,new Uint8Array(size).fill(7),'POST','&number=1&upload_id='+start.upload_id)).json();
 const complete=await (await call('complete',ticket,{upload_id:start.upload_id,parts:[part.part]})).json();
 const [payload,signature]=complete.receipt.split('.');assert.equal(signature,createHmac('sha256','test').update(payload).digest('base64url'));
 assert.equal(JSON.parse(Buffer.from(payload,'base64url')).purpose,'receipt');
 const r=await call('read',token('read'),undefined,'GET');assert.equal(r.status,200);assert.deepEqual([...new Uint8Array(await r.arrayBuffer())],Array(size).fill(7));
 f.db.close();
});

