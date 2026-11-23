import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../_worker.js', import.meta.url), 'utf8');
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const sent = [];
  const env = { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: '-123', TELEGRAM_USER_ID: '42', TELEGRAM_WEBHOOK_SECRET: 'test-secret',
    DB: { prepare(sql) {
      let args = [];
      return { bind(...v) { args = v; return this; },
        async first() { return db.prepare(sql).get(...args); },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; } };
    }, async batch(statements) {
      db.exec('begin');
      try { const result = []; for (const s of statements) result.push(await s.run()); db.exec('commit'); return result; }
      catch (e) { db.exec('rollback'); throw e; }
    } } };
  const api = runInNewContext(source.replace('export default {', 'const worker = {') +
    '\n({ telegramEligible, telegramSummary, telegramRoute, telegramWebhook, postMessage, flushTelegram, runChair })',
    { Response, Request, URL, AbortSignal, console, fetch: async (url, options) => {
      sent.push(JSON.parse(options.body)); return Response.json({ ok: !env.fail });
    } });
  return { db, env, api, sent };
}
function webhook(f, text, { id = 10, user = 42, chat = -123, secret = 'test-secret' } = {}) {
  return f.api.telegramWebhook(new Request('https://room/telegram/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify({ update_id: id, message: { from: { id: user }, chat: { id: chat }, text } }),
  }), f.env);
}
test('all room commands route, ordinary text defaults to orders', () => {
  const f = fixture();
  for (const [cmd, room] of [['blog','blog'],['threads','threads'],['store','store'],['insta','instagram'],['general','general']]) {
    assert.equal(f.api.telegramRoute(`/${cmd}@sorabbang_team_bot hello`).room, room);
    assert.equal(f.api.telegramRoute(`/${cmd} hello`).content, 'hello');
  }
  assert.equal(f.api.telegramRoute('hello').room, 'orders'); f.db.close();
});
test('webhook authenticates group and person, deduplicates and never echoes', async () => {
  const f = fixture();
  assert.equal((await webhook(f, 'hello', { secret: 'wrong' })).status, 403);
  await webhook(f, 'hello', { user: 9 }); await webhook(f, 'hello', { chat: -9 });
  assert.equal(f.db.prepare('select count(*) n from messages').get().n, 0);
  await webhook(f, '/general 연결 확인'); await webhook(f, '/general 연결 확인');
  await webhook(f, '기본 지시', { id: 11 });
  const rows = f.db.prepare('select room_slug,sender,content from messages').all();
  assert.equal(rows.length, 2); assert.equal(rows[0].sender, '똑똑이');
  assert.equal(rows[0].room_slug, 'general'); assert.equal(rows[1].room_slug, 'orders');
  assert.equal(f.db.prepare('select count(*) n from telegram_outbox').get().n, 0);
  f.db.close();
});
test('only requested reports are queued and delivered once with three lines', async () => {
  const f = fixture();
  for (const [room, content] of [['general','평범한 글'], ['to-me','질문'], ['blog','@똑똑이 확인'], ['general','[피클 브리핑] 오늘'], ['store','작업 완료\n둘\n셋\n넷']])
    await f.api.postMessage(f.env, room, { sender: '코덱스', content });
  await f.api.flushTelegram(f.env); await f.api.flushTelegram(f.env);
  assert.equal(f.sent.length, 4);
  assert.equal(f.sent[0].text, '[똑똑이에게 온 채팅] 코덱스: 질문');
  assert.equal(f.sent[3].text, '[스마트스토어] 코덱스: 작업 완료\n둘\n셋…');
  assert.ok(f.api.telegramSummary('종합', { sender: '코덱스', content: '가'.repeat(4000) }).length <= 1000);
  f.db.close();
});
test('failed deliveries remain queued for cron retry', async () => {
  const f = fixture(); f.env.fail = true;
  await f.api.postMessage(f.env, 'general', { sender: '코덱스', content: '완료' });
  await f.api.flushTelegram(f.env);
  assert.equal(f.db.prepare('select sent_at from telegram_outbox').get().sent_at, null);
  f.env.fail = false; f.db.exec('update telegram_outbox set lease_until = null');
  await f.api.flushTelegram(f.env);
  assert.ok(f.db.prepare('select sent_at from telegram_outbox').get().sent_at); f.db.close();
});
test('Telegram questions are picked up by the existing chair rules', async () => {
  const f = fixture(); await webhook(f, '/blog 어떻게 작성하나요?');
  // Existing chair checks questions in its configured time window.
  await f.api.runChair(f.env);
  assert.ok(f.db.prepare("select id from messages where sender = '의장' and reply_to_id = 1").get());
  f.db.close();
});
