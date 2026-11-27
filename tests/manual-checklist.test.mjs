import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
const source=readFileSync(new URL('../_worker.js',import.meta.url),'utf8');
function fixture(){
 const db=new DatabaseSync(':memory:');
 const DB={prepare(sql){let args=[];return {bind(...v){args=v;return this},async first(){return db.prepare(sql).get(...args)},async all(){return {results:db.prepare(sql).all(...args)}},async run(){return db.prepare(sql).run(...args)}}}};
 const api=runInNewContext(source.replace('export default {','const worker = {')+'\n({handleApi})',{Request,Response,Headers,URL,console});
 async function call(method='GET',body=null,day='2026-11-28',auth=true){const url=new URL('https://room.test/api/manual-checklist?date='+day);return api.handleApi(new Request(url,{method,headers:{...(auth?{'X-Room-Key':'test'}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),{DB,ROOM_KEY:'test'},url);}
 return {db,call};
}
test('owner checklist persists, isolates days, and prevents stale writes',async()=>{
 const f=fixture();let d=await(await f.call()).json();assert.deepEqual(d.sections.map(s=>s.items.length),[6,11]);
 const body={date:'2026-11-28',scope:'daily',id:'shorts',done:true,version:0};
 assert.equal((await f.call('PATCH',body)).status,200);
 d=await(await f.call()).json();assert.equal(d.sections[0].items[0].done,true);
 assert.equal((await f.call('PATCH',body)).status,409);
 d=await(await f.call('GET',null,'2026-11-29')).json();assert.equal(d.sections[0].items[0].done,false);assert.equal(d.sections[1].items.length,0);
 f.db.close();
});
test('auth and request validation apply to manual checklist',async()=>{
 const f=fixture();assert.equal((await f.call('GET',null,'2026-11-28',false)).status,401);
 assert.equal((await f.call('GET',null,'2026-02-30')).status,400);
 assert.equal((await f.call('PATCH',{date:'2026-11-28',scope:'today',id:'invented',done:true,version:0})).status,400);
 f.db.close();
});
