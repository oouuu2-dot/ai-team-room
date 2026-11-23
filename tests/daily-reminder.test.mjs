import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../_worker.js', import.meta.url), 'utf8');
const reminder = source.slice(source.indexOf('async function dailyReminder('), source.indexOf('const DOCS_TEMPLATE'));

async function run(rows, { hour = 20, alreadySent = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('create table checklist (id integer primary key, title text, group_name text, status text)');
  const insert = db.prepare('insert into checklist values (?, ?, ?, ?)');
  rows.forEach((row, i) => insert.run(i + 1, ...row));
  const messages = [];
  const env = { DB: { prepare(sql) {
    return {
      async first() {
        if (sql.includes(' AS INTEGER) as h')) return { h: hour };
        if (sql.includes('from messages')) return alreadySent ? { id: 1 } : undefined;
        return db.prepare(sql).get();
      },
      async all() { return { results: db.prepare(sql).all() }; },
    };
  } } };
  try {
    const dailyReminder = runInNewContext(reminder + '\ndailyReminder', {
      postMessage: async (_env, room, payload) => messages.push({ room, ...payload }),
      CHAIR_NAME: '의장',
    });
    await dailyReminder(env);
    return messages;
  } finally { db.close(); }
}

test('count and preview exclude non-daily titles and finished tasks', async () => {
  const messages = await run([
    ['[매일] 블로그', '매일', 'todo'],
    ['매일 오전 브리핑', '매일', 'todo'],
    ['상품명 모두 쓰기', '매일', 'todo'],
    ['[나중에] 자동화', '매일', 'todo'],
    ['[매일] 완료', '매일', 'done'],
    ['[매일] 승인', '매일', 'approved'],
    ['[매일] 반려', '매일', 'rejected'],
    ['[매일] 다른 그룹', '11.23', 'todo'],
  ]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].room, 'to-me');
  assert.match(messages[0].content, /매일 할 일 2건/);
  assert.match(messages[0].content, /- \[매일\] 블로그\n- 매일 오전 브리핑$/);
  assert.doesNotMatch(messages[0].content, /상품명|나중에|다른 그룹/);
});

test('no reminder when only non-daily tasks remain', async () => {
  assert.equal((await run([['상품명', '매일', 'todo']])).length, 0);
});

test('preview overflow uses the same filtered total', async () => {
  const rows = Array.from({ length: 7 }, (_, i) => [`[매일] 작업 ${i}`, '매일', 'todo']);
  rows.unshift(['매주 작업', '매일', 'todo']);
  const [message] = await run(rows);
  assert.match(message.content, /매일 할 일 7건/);
  assert.match(message.content, /외 2건$/);
  assert.doesNotMatch(message.content, /매주/);
});

test('before 19 KST does not send', async () => {
  assert.equal((await run([['[매일] 작업', '매일', 'todo']], { hour: 18 })).length, 0);
});

test('an existing reminder prevents a duplicate', async () => {
  assert.equal((await run([['[매일] 작업', '매일', 'todo']], { alreadySent: true })).length, 0);
});
