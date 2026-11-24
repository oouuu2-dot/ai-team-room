import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../_worker.js', import.meta.url), 'utf8');
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const env = { ROOM_KEY: 'test', DB: { prepare(sql) {
    let args = [];
    return {
      bind(...values) { args = values; return this; },
      async first() { return db.prepare(sql).get(...args); },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } }; },
    };
  } } };
  const api = runInNewContext(source.replace('export default {', 'const worker = {') +
    '\n({canonicalAgent, normalizeMentions, routeQuestion, isQuestion, messageTaskUpdate, postMessage, ensureChecklistTable, runChair, approvalNudge, handleApi})',
  { Response, Request, URL, console });
  return { db, env, api };
}
async function setup() { const f = fixture(); await f.api.ensureChecklistTable(f.env); return f; }
function item(f, id = 35, assignee = '코덱스') {
  f.db.prepare('insert into checklist (id,title,assignee,status,progress) values (?,?,?,\'todo\',0)').run(id, '특정 개발 작업', assignee);
}
function message(f, sender, content, reply = null, age = '-11 minutes') {
  return Number(f.db.prepare("insert into messages (room_slug,sender,content,reply_to_id,created_at) values ('general',?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now',?))")
    .run(sender, content, reply, age).lastInsertRowid);
}

test('questions and routing follow explicit mention then room then Muse', () => {
  const f = fixture();
  for (const t of ['진행', 'ㅇㅋ', '빼줘', '@브이 확인해']) assert.equal(f.api.isQuestion(t), false);
  assert.equal(f.api.isQuestion('왜 안돼?'), true);
  assert.equal(f.api.routeQuestion('@V 어떻게 해?', 'blog'), '부이~');
  assert.equal(f.api.normalizeMentions('@브이 확인해 @Codex @재미나이 @Claude'), '@부이~ 확인해 @코덱스 @Gemini @클로드');
  assert.equal(f.api.routeQuestion('어떻게 해?', 'threads'), '피클2');
  assert.equal(f.api.routeQuestion('어떻게 해?', 'general'), '뮤즈');
  f.db.close();
});

test('explicit completion updates only the correct card; negative reports do not complete', async () => {
  const f = await setup(); item(f); item(f, 36);
  await f.api.postMessage(f.env, 'general', { sender: 'Codex', content: '#35 완료' });
  assert.deepEqual({...f.db.prepare('select status, progress from checklist where id=35').get()}, {status:'done',progress:100});
  assert.equal(f.db.prepare('select status from checklist where id=36').get().status, 'todo');
  await f.api.postMessage(f.env, 'general', {sender:'코덱스',content:'#36 미완료. 완료 기준 확인 중'});
  assert.equal(f.db.prepare('select status from checklist where id=36').get().status, 'todo');
  f.db.close();
});

test('reply chain scopes progress and completion; an unscoped or wrong agent message cannot finish cards', async () => {
  const f = await setup(); item(f);
  const parent = message(f, '뮤즈', '@코덱스 #35 진행해');
  await f.api.postMessage(f.env, 'general', {sender:'Claude',content:'#35 완료'});
  await f.api.postMessage(f.env, 'general', {sender:'코덱스',content:'완료'});
  assert.equal(f.db.prepare('select status from checklist where id=35').get().status, 'todo');
  const progress = await f.api.postMessage(f.env, 'general', {sender:'Codex',content:'진행률 40%',reply_to_id:parent});
  assert.equal(f.db.prepare('select progress from checklist where id=35').get().progress, 40);
  await f.api.postMessage(f.env, 'general', {sender:'코덱스',content:'✅',reply_to_id:progress.message.id});
  assert.equal(f.db.prepare('select progress from checklist where id=35').get().progress, 100);
  f.db.close();
});

test('chair ignores commands and replies, waits ten minutes, retries only once after 30 minutes', async () => {
  const f = await setup();
  for (const t of ['진행', 'ㅇㅋ', '빼줘']) message(f, '똑똑이', t);
  const answered = message(f, '똑똑이', '답 있나요?'); message(f, '뮤즈', '답변입니다', answered);
  message(f, '똑똑이', '새 질문?', null, '-2 minutes');
  const q = message(f, '똑똑이', '@Codex 왜 안돼?');
  await f.api.runChair(f.env); await f.api.runChair(f.env);
  assert.equal(f.db.prepare("select count(*) n from messages where sender='의장' and reply_to_id=?").get(q).n, 1);
  assert.equal(f.db.prepare("select count(*) n from messages where sender='의장' and reply_to_id!=?").get(q).n, 0);
  f.db.prepare("update messages set created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-31 minutes') where sender='의장'").run();
  await f.api.runChair(f.env); await f.api.runChair(f.env);
  assert.equal(f.db.prepare("select count(*) n from messages where sender='의장' and reply_to_id=?").get(q).n, 2);
  f.db.close();
});

test('approval transition records time, and only one stalled approval reminder is sent', async () => {
  const f = await setup(); item(f);
  const request = new Request('https://room.test/api/checklist/35', {method:'PATCH',headers:{Authorization:'Bearer test','Content-Type':'application/json'},body:JSON.stringify({status:'approved'})});
  const response = await f.api.handleApi(request, f.env, new URL(request.url));
  assert.equal(response.status, 200);
  assert.ok(f.db.prepare('select approved_at from checklist where id=35').get().approved_at);
  f.db.prepare("update checklist set approved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-31 minutes'),updated_at=null where id=35").run();
  await f.api.approvalNudge(f.env); await f.api.approvalNudge(f.env);
  assert.equal(f.db.prepare("select count(*) n from messages where sender='의장'").get().n, 1);
  f.db.close();
});

test('card progress after approval suppresses stalled reminder', async () => {
  const f = await setup(); item(f);
  f.db.exec("update checklist set status='approved',approved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-31 minutes') where id=35");
  await f.api.postMessage(f.env,'general',{sender:'코덱스',content:'#35 진행률 40%'});
  await f.api.approvalNudge(f.env);
  assert.equal(f.db.prepare("select count(*) n from messages where sender='의장'").get().n, 0);
  f.db.close();
});

test('mixed card reports do not mark the unfinished card complete', async () => {
  const f = await setup(); item(f); item(f,36);
  await f.api.postMessage(f.env,'general',{sender:'코덱스',content:'#35 완료\n#36 미완료'});
  assert.equal(f.db.prepare('select status from checklist where id=35').get().status,'done');
  assert.equal(f.db.prepare('select status from checklist where id=36').get().status,'todo');
  f.db.close();
});

test('shorts room is created idempotently, accepts its named sender and routes questions', async () => {
  const f=await setup();
  f.db.exec("delete from rooms where slug='shorts'");
  for(let i=0;i<2;i++) {
    const request=new Request('https://room.test/api/rooms',{headers:{Authorization:'Bearer test'}});
    const response=await f.api.handleApi(request,f.env,new URL(request.url));
    const data=await response.json();
    assert.equal(data.rooms.filter(room=>room.slug==='shorts').length,1);
    assert.equal(data.rooms.find(room=>room.slug==='shorts').name,'숏츠');
  }
  const posted=await f.api.postMessage(f.env,'shorts',{sender:'숏츠.딸깍이',content:'제작 준비'});
  assert.equal(posted.message.sender,'숏츠.딸깍이');
  assert.equal(posted.message.role,'숏츠 제작 · 협업');
  assert.equal(f.api.routeQuestion('어떻게 만들까요?','shorts'),'숏츠.딸깍이');
  assert.equal(f.api.routeQuestion('@숏츠.딸깍이 어떻게?','general'),'숏츠.딸깍이');
  f.db.close();
});
