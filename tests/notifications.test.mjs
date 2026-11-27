import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
const source=readFileSync(new URL('../_worker.js',import.meta.url),'utf8');
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec('create table messages(id integer primary key,room_slug text,sender text,content text,reply_to_id integer,created_at text)');
 const DB={prepare(sql){let args=[];return {bind(...v){args=v;return this},async first(){return db.prepare(sql).get(...args)},async all(){return {results:db.prepare(sql).all(...args)}},async run(){return db.prepare(sql).run(...args)}}},async batch(list){return Promise.all(list.map(s=>s.run()))}};
 const api=runInNewContext(source.replace('export default {','const worker = {')+'\n({botMentions,notificationSnapshot,handleApi})',{Request,Response,Headers,URL,console});
 return {db,api,env:{DB,ROOM_KEY:'test'}};
}
test('mentions deduplicate and exclude unknown bots and sender',()=>{
 const f=fixture();
 assert.deepEqual(Array.from(f.api.botMentions('@코덱스 @클로드 @코덱스 @unknown @뮤즈','뮤즈')),['코덱스','클로드']);
 f.db.close();
});
test('response state requires the mentioned bot replying to the exact message',async()=>{
 const f=fixture(),insert=f.db.prepare('insert into messages values(?,?,?,?,?,?)');
 insert.run(1,'general','똑똑이','@코덱스 @클로드 확인',null,'2026-11-27T01:00:00Z');
 insert.run(2,'general','코덱스','접수',1,'2026-11-27T01:01:00Z');
 insert.run(3,'general','클로드','다른 일',null,'2026-11-27T01:02:00Z');
 const result=await f.api.notificationSnapshot(f.env,'general',[1]);
 assert.equal(result.requests[0].targets.find(x=>x.name==='코덱스').replied,true);
 assert.equal(result.requests[0].targets.find(x=>x.name==='클로드').replied,false);
 assert.equal(result.actors.find(x=>x.name==='클로드').last_message_at,'2026-11-27T01:02:00Z');
 insert.run(4,'orders','클로드','지시방에서 접수',1,'2026-11-27T01:03:00Z');
 assert.equal((await f.api.notificationSnapshot(f.env,'general',[1])).requests[0].targets.find(x=>x.name==='클로드').replied,true);
 assert.equal((await f.api.notificationSnapshot(f.env,'other',[1])).requests.length,0);
 f.db.close();
});
test('build endpoint is public and notifications require authentication',async()=>{
 const f=fixture();
 const version=new Request('https://test/api/version');
 assert.equal((await f.api.handleApi(version,{},new URL(version.url))).status,200);
 const req=new Request('https://test/api/notifications?room=general');
 assert.equal((await f.api.handleApi(req,f.env,new URL(req.url))).status,401);
 f.db.close();
});
test('new build shows the update button while the current build stays quiet',async()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const code=html.slice(html.indexOf('  function checkVersion(){'),html.indexOf("  $('applyUpdate').onclick="));
 for(const build of ['current','next']){
  const banner={hidden:true};
  const check=runInNewContext(code+'\ncheckVersion',{CLIENT_BUILD:'current',$:()=>banner,fetch:async()=>({json:async()=>({build})})});
  await check();assert.equal(banner.hidden,build==='current');
 }
});
