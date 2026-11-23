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
test('Korean slash and colon room aliases preserve the message body', () => {
  const f = fixture();
  for (const [alias, room] of [['블로그','blog'],['스레드','threads'],['스토어','store'],['스스','store'],['인스타','instagram'],['종합','general'],['지시','orders']]) {
    for (const prefix of [`/${alias} `, `/${alias}@sorabbang_team_bot `, `${alias}:`, `${alias} : `, `${alias}：`]) {
      const routed = f.api.telegramRoute(prefix + '내용: @코덱스\n두 번째 줄');
      assert.equal(routed.room, room);
      assert.equal(routed.content, '내용: @코덱스\n두 번째 줄');
    }
    assert.equal(f.api.telegramRoute(`/${alias}`).content, '');
    assert.equal(f.api.telegramRoute(`${alias}:`).content, '');
  }
  for (const text of ['/인스타그램 확인', '/blogger hello', '블로그 글 써줘', '/인스타@other_bot 안녕', '내용 중 블로그: 그대로']) {
    assert.equal(f.api.telegramRoute(text).room, 'orders');
    assert.equal(f.api.telegramRoute(text).content, text);
  }
  f.db.close();
});
test('Korean routing reaches the authenticated webhook and defaults remain unchanged', async () => {
  const f = fixture();
  await webhook(f, '/인스타 하하집 확인', {id:100});
  await webhook(f, '블로그: 원고 확인', {id:101});
  await webhook(f, '아무 접두어 없는 요청', {id:102});
  const rows = f.db.prepare('select room_slug,content from messages order by id').all();
  assert.equal(rows[0].room_slug, 'instagram'); assert.equal(rows[0].content, '하하집 확인');
  assert.equal(rows[1].room_slug, 'blog'); assert.equal(rows[1].content, '원고 확인');
  assert.equal(rows[2].room_slug, 'orders');
  f.db.close();
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
test('all progress is delivered folded, with attention markers only where needed', async () => {
  const f = fixture();
  for (const [room, content] of [['general','평범한 글'], ['to-me','질문'], ['blog','@똑똑이 확인'], ['general','[피클 브리핑] 오늘'], ['store','작업 완료\n둘\n셋\n넷']])
    await f.api.postMessage(f.env, room, { sender: '코덱스', content });
  await f.api.flushTelegram(f.env); await f.api.flushTelegram(f.env);
  assert.equal(f.sent.length, 5);
  assert.match(f.sent[1].text, /^❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️\n똑똑이 확인\n/);
  assert.match(f.sent[2].text, /^❤️❤️❤️❤️❤️❤️❤️❤️❤️❤️\n똑똑이 확인\n/);
  assert.ok(!f.sent[0].text.includes('똑똑이 확인'));
  assert.ok(f.sent.every((message) => message.parse_mode === 'HTML' && message.text.includes('<blockquote expandable>')));
  const full = '첫 줄\n\n두 번째\n세 번째\n네 번째';
  assert.ok(f.api.telegramSummary('종합',{sender:'코덱스',content:full}).includes('<blockquote expandable>'+full+'</blockquote>'));
  const long = f.api.telegramSummary('종합', { sender: '코덱스', content: '가'.repeat(5000) });
  assert.equal(long.replace(/<[^>]*>/g,'').length,4096); assert.ok(!long.includes('…')); assert.ok(!long.includes('...'));
  f.db.close();
});
test('failed deliveries remain queued for cron retry', async () => {
  const f = fixture(); f.env.fail = true;
  await f.api.postMessage(f.env, 'general', { sender: '코덱스', content: '@똑똑이 완료' });
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

test('Pickle commands route and discussion is sent without inbound echo', async () => {
  const f = fixture();
  f.db.exec("delete from rooms where slug='pickles'");
  for (const prefix of ['/pickles ', '/피클 ', '/피클토론 ', '피클:', '피클토론:']) {
    assert.equal(f.api.telegramRoute(prefix+'회의').room,'pickles');
    assert.equal(f.api.telegramRoute(prefix+'회의').content,'회의');
  }
  await webhook(f,'/피클토론 의견 주세요',{id:200});
  assert.equal(f.db.prepare("select count(*) n from rooms where slug='pickles'").get().n,1);
  assert.equal(f.db.prepare('select room_slug from messages').get().room_slug,'pickles');
  assert.equal(f.db.prepare('select count(*) n from telegram_outbox').get().n,0);
  await f.api.postMessage(f.env,'pickles',{sender:'피클1',content:'첫 의견입니다'});
  await f.api.postMessage(f.env,'pickles',{sender:'피클2',content:'두 번째 의견입니다'});
  await f.api.postMessage(f.env,'pickles',{sender:'피클2',content:'@똑똑이 최종 의견입니다'});
  await f.api.flushTelegram(f.env); await f.api.flushTelegram(f.env);
  assert.equal(f.sent.length,3);
  assert.match(f.sent[0].text,/피클 토론방.*피클1/);
  assert.match(f.sent[2].text,/피클 토론방.*피클2/);
  f.db.close();
});

test('old queued messages are regenerated in the current folded format', async () => {
  const f=fixture();
  await f.api.postMessage(f.env,'general',{sender:'코덱스',content:'그냥 완료'});
  await f.api.postMessage(f.env,'general',{sender:'코덱스',content:'@똑똑이 하나\n둘\n셋\n넷'});
  f.db.prepare('update telegram_outbox set text=? where message_id=1').run('이전 완료 알림');
  f.db.exec("update telegram_outbox set text='이전 잘린 요약…' where message_id=2");
  await f.api.flushTelegram(f.env);
  assert.equal(f.sent.length,2);
  assert.ok(f.sent[1].text.includes('<blockquote expandable>@똑똑이 하나\n둘\n셋\n넷</blockquote>'));
  f.db.close();
});

test('folded HTML escapes user text and keeps Unicode message boundaries valid', () => {
  const f=fixture();
  const html=f.api.telegramSummary('<방>',{room_slug:'to-me',sender:'<AI>',content:'<b>안녕</b> & 확인'});
  assert.ok(html.includes('&lt;b&gt;안녕&lt;/b&gt; &amp; 확인'));
  assert.ok(!html.includes('<b>'));
  const long=f.api.telegramSummary('종합',{sender:'코덱스',content:'😀'.repeat(5000)});
  const visible=long.replace(/<[^>]*>/g,'');
  assert.ok(visible.length<=4096);
  assert.ok(!/[\uD800-\uDBFF]$/.test(visible));
  f.db.close();
});
