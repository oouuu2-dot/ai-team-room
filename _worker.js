/**
 * AI 팀 회의실 — Cloudflare Pages Functions (advanced mode, _worker.js)
 *
 * 정적 파일(index.html)은 env.ASSETS 로 서빙하고, /api/* 는 D1(env.DB) 로 처리합니다.
 * 인증: Authorization: Bearer <ROOM_KEY 또는 API_KEY>  (또는 X-Room-Key 헤더, ?key= 쿼리)
 */

// ---------- 참여자(역할) 목록 ----------
// 이름을 바꾸려면 여기와 index.html 의 SENDERS 배열을 함께 바꾸세요.
const AGENTS = {
  '똑똑이': { role: '대표 · 최종 결정', color: '#ff6fa5', emoji: '👑' },
  '피클1': { role: '지비.하하 · 인스타 카드뉴스·릴스·예약', color: '#ff5c8a', emoji: '🦉' },
  '피클2': { role: '유닉 · 설문·스레드·애플파이·임시저장', color: '#6fc3ff', emoji: '🦄' },
  '뮤즈': { role: '기획 · 노션 정리 · 리서치', color: '#d9a7ff', emoji: '🌸' },
  '클로드': { role: '블로그 원고 · 벤치마킹', color: '#ffa94d', emoji: '🦊' },
  'Gemini': { role: '빠른 리서치 · 상위노출 분석', color: '#2dd4bf', emoji: '🐰' },
  '코덱스': { role: '코드 · 자동화 · 회의실 개발', color: '#60a5fa', emoji: '🦈' },
  '의장': { role: '회의 진행 · 역할 배정', color: '#8b5cf6', emoji: '🤖' },
};

// 방 목록은 D1 의 rooms 테이블이 기준입니다. (schema.sql 기본값: general / instagram / blog / store / later)

const PALETTE = ['#ff5c8a', '#6fc3ff', '#f0b070', '#a78bfa', '#5ed6a8', '#ffd166', '#ff8b6b', '#8fb8ff'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Room-Key',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS },
  });
}

function text(body, status = 200, type = 'text/plain; charset=utf-8') {
  return new Response(body, { status, headers: { 'content-type': type, 'cache-control': 'no-store', ...CORS } });
}

// 이름이 AGENTS 에 있으면 역할 배지를, 없으면 '참여자' 배지를 붙입니다.
function meta(sender) {
  const raw = String(sender == null ? '' : sender).trim();
  if (AGENTS[raw]) {
    const a = AGENTS[raw];
    return { name: raw, role: a.role, color: a.color, emoji: a.emoji };
  }
  let h = 0;
  for (const ch of raw) h = (h * 31 + ch.codePointAt(0)) % 100000;
  return { name: raw, role: '참여자', color: PALETTE[h % PALETTE.length], emoji: raw.slice(0, 1) };
}

function readKey(request, url) {
  const auth = request.headers.get('authorization') || '';
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  const x = request.headers.get('x-room-key');
  if (x && x.trim()) return x.trim();
  return (url.searchParams.get('key') || url.searchParams.get('passcode') || '').trim();
}

// 타이밍 공격을 피하려고 길이를 맞춰 비교합니다.
function same(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function authorized(request, env, url) {
  const key = readKey(request, url);
  if (!key) return false;
  const valid = [env.API_KEY, env.ROOM_KEY].filter(Boolean);
  return valid.some((v) => same(v, key));
}

function decorate(row) {
  const m = meta(row.sender);
  const out = {
    id: row.id,
    room: row.room_slug,
    sender: m.name,
    role: m.role,
    color: m.color,
    emoji: m.emoji,
    content: row.content,
    reply_to_id: row.reply_to_id || null,
    created_at: row.created_at,
  };
  if (row.attachment_id) {
    out.attachment = {
      id: row.attachment_id,
      filename: row.att_filename || 'file',
      mime_type: row.att_mime_type || 'application/octet-stream',
      size: row.att_size || 0,
      url: `/api/attachments/${row.attachment_id}`,
    };
  }
  return out;
}

async function attachReplies(env, messages, slug) {
  const ids = [...new Set(messages.map((m) => m.reply_to_id).filter(Boolean))];
  if (!ids.length) return messages;
  const holes = ids.map(() => '?').join(',');
  const res = await env.DB.prepare(
    `select id, sender, content, created_at from messages where room_slug = ? and id in (${holes})`
  )
    .bind(slug, ...ids)
    .all();
  const map = new Map((res.results || []).map((r) => [r.id, r]));
  for (const m of messages) {
    const parent = m.reply_to_id ? map.get(m.reply_to_id) : null;
    m.reply_to = parent
      ? {
          id: parent.id,
          sender: meta(parent.sender).name,
          content: String(parent.content).slice(0, 300),
        }
      : null;
  }
  return messages;
}

// 방 목록을 읽기 전에, 없을 수 있는 두 방(지시방·똑똑이에게 온 채팅)을 먼저 만들어 둡니다.
// INSERT OR IGNORE라 이미 있으면 아무 일도 안 생깁니다. D1 콘솔을 따로 거칠 필요가 없습니다.
async function ensureRooms(env) {
  try {
    await env.DB.prepare(
      `insert or ignore into rooms (slug, name, description, position) values ('to-me', '똑똑이에게 온 채팅', 'AI들이 똑똑이님께 물어볼 때 쓰는 방', 6)`
    ).run();
    await env.DB.prepare(
      `insert or ignore into rooms (slug, name, description, position) values ('orders', '지시방', '똑똑이님이 지시를 올리는 방 · AI들이 역할 나눠서 실행', 7)`
    ).run();
    await env.DB.prepare(
      `insert or ignore into rooms (slug, name, description, position) values ('threads', '스레드', '스레드 분석·벤치마킹·발행 준비', 8)`
    ).run();
  } catch (e) {
    // rooms 테이블이 아직 없으면 아래 SELECT가 기존처럼 에러를 냅니다.
  }
}

async function roomList(env) {
  await ensureRooms(env);
  await ensureReadMarksTable(env);
  const res = await env.DB.prepare(
    `select r.slug, r.name, r.description, r.position,
            (select count(*) from messages m where m.room_slug = r.slug) as message_count,
            (select max(id) from messages m where m.room_slug = r.slug) as last_id,
            (select created_at from messages m where m.room_slug = r.slug order by id desc limit 1) as last_message_at,
            (select count(*) from messages m where m.room_slug = r.slug and m.sender != '똑똑이' and m.id > coalesce((select last_read_id from read_marks rm where rm.room_slug = r.slug), 0)) as unread
       from rooms r
      order by r.position, r.slug`
  ).all();
  return res.results || [];
}

async function ensureReadMarksTable(env) {
  await env.DB.prepare(
    `create table if not exists read_marks (
       room_slug text primary key,
       last_read_id integer not null default 0,
       updated_at text not null default (datetime('now'))
     )`
  ).run();
}

async function getReadMark(env, slug) {
  await ensureReadMarksTable(env);
  const row = await env.DB.prepare('select last_read_id from read_marks where room_slug = ?').bind(slug).first();
  return row ? (parseInt(row.last_read_id, 10) || 0) : 0;
}

async function getRoom(env, slug) {
  return env.DB.prepare('select slug, name, description from rooms where slug = ?').bind(slug).first();
}

async function listMessages(env, slug, after, limit) {
  let rows;
  if (after > 0) {
    const res = await env.DB.prepare(
      `select m.*, a.filename as att_filename, a.mime_type as att_mime_type, a.size as att_size
         from messages m
         left join attachments a on a.id = m.attachment_id
        where m.room_slug = ? and m.id > ?
        order by m.id asc limit ?`
    )
      .bind(slug, after, limit)
      .all();
    rows = res.results || [];
  } else {
    const res = await env.DB.prepare(
      `select m.*, a.filename as att_filename, a.mime_type as att_mime_type, a.size as att_size
         from messages m
         left join attachments a on a.id = m.attachment_id
        where m.room_slug = ?
        order by m.id desc limit ?`
    )
      .bind(slug, limit)
      .all();
    rows = (res.results || []).reverse();
  }
  const messages = rows.map(decorate);
  await attachReplies(env, messages, slug);
  const latest = messages.length ? messages[messages.length - 1].id : 0;
  return { messages, latest };
}

async function postMessage(env, slug, payload) {
  const sender = String(payload.sender || '').trim();
  const content = String(payload.content || '').trim();
  const att = payload.attachment && typeof payload.attachment === 'object' ? payload.attachment : null;
  if (!sender) return { error: 'sender 가 필요합니다.', status: 400 };
  if (!content && !att) return { error: 'content 또는 attachment 가 필요합니다.', status: 400 };
  if (content.length > 4000) return { error: 'content 는 4000자까지 가능합니다.', status: 400 };
  if (sender.length > 24) return { error: 'sender 가 너무 깁니다.', status: 400 };

  let attachmentId = null;
  if (att) {
    const filename = String(att.filename || 'file').trim().slice(0, 180) || 'file';
    const mimeType = String(att.mime_type || 'application/octet-stream').trim().slice(0, 120) || 'application/octet-stream';
    let b64 = String(att.data_base64 || '').trim();
    const commaIdx = b64.indexOf(',');
    if (b64.startsWith('data:') && commaIdx !== -1) b64 = b64.slice(commaIdx + 1);
    if (!b64) return { error: 'attachment.data_base64 가 필요합니다.', status: 400 };
    if (b64.length > 980000) return { error: '첨부 파일은 약 700KB 이하만 가능합니다.', status: 413 };
    const size = Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
    const attRes = await env.DB.prepare(
      `insert into attachments (room_slug, filename, mime_type, size, data_base64, created_at)
       values (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    )
      .bind(slug, filename, mimeType, Math.max(0, size), b64)
      .run();
    attachmentId = attRes.meta && attRes.meta.last_row_id;
  }

  let replyTo = null;
  const rt = payload.reply_to_id ?? payload.reply_to;
  if (rt !== null && rt !== undefined && rt !== '') {
    const n = parseInt(rt, 10);
    if (Number.isFinite(n) && n > 0) {
      const parent = await env.DB.prepare('select id from messages where room_slug = ? and id = ?').bind(slug, n).first();
      if (parent) replyTo = n;
    }
  }

  const res = await env.DB.prepare(
    `insert into messages (room_slug, sender, content, reply_to_id, attachment_id, created_at)
     values (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  )
    .bind(slug, sender, content, replyTo, attachmentId)
    .run();

  const id = res.meta && res.meta.last_row_id;
  const row = await env.DB.prepare(
    `select m.*, a.filename as att_filename, a.mime_type as att_mime_type, a.size as att_size
       from messages m
       left join attachments a on a.id = m.attachment_id
      where m.id = ?`
  )
    .bind(id)
    .first();
  const messages = [decorate(row)];
  await attachReplies(env, messages, slug);
  return { message: messages[0] };
}


// ---------- 결재·체크리스트 ----------
// group_name: '매일' = 노션에서 가져온 항목, 'M.DD'(예: 11.23) = 회의실에서 추가한 오늘 날짜 항목.
// D1에는 첫 사용 시 CREATE TABLE IF NOT EXISTS 로 자동 생성합니다.
const CHECKLIST_STATUSES = ['todo', 'waiting', 'done', 'approved', 'rejected'];

// 한국 날짜 기준 오늘 날짜를 'M.DD' 형식으로 돌려줍니다 (예: 11.23).
function todayLabel() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return (d.getUTCMonth() + 1) + '.' + String(d.getUTCDate()).padStart(2, '0');
}

async function ensureChecklistTable(env) {
  await env.DB.prepare(
    `create table if not exists checklist (
       id integer primary key autoincrement,
       title text not null,
       group_name text,
       assignee text,
       status text not null default 'todo',
       source text,
       reason text,
       created_at text not null default (datetime('now'))
     )`
  ).run();
  // 내용(detail)·링크(link) 컬럼 추가 (이미 있으면 무시)
  try { await env.DB.prepare(`alter table checklist add column detail text`).run(); } catch (e) {}
  try { await env.DB.prepare(`alter table checklist add column link text`).run(); } catch (e) {}
  try { await env.DB.prepare(`alter table checklist add column progress integer not null default 0`).run(); } catch (e) {}
}

function checklistRow(row) {
  return {
    id: row.id,
    title: row.title,
    group_name: row.group_name || '',
    assignee: row.assignee || '',
    status: row.status,
    source: row.source || '',
    reason: row.reason || '',
    detail: row.detail || '',
    link: row.link || '',
    progress: Math.max(0, Math.min(100, parseInt(row.progress, 10) || 0)),
    started_at: row.started_at || '',
    last_activity_at: row.last_activity_at || '',
    created_at: row.created_at,
  };
}

async function listChecklist(env) {
  await ensureChecklistTable(env);
  const res = await env.DB.prepare(
    `select c.id, c.title, c.group_name, c.assignee, c.status, c.source, c.reason, c.detail, c.link, c.progress, c.created_at,
            (select min(m.created_at) from messages m where m.sender = c.assignee and m.created_at > c.created_at) as started_at,
            (select max(m.created_at) from messages m where m.sender = c.assignee) as last_activity_at
       from checklist c order by group_name, id`
  ).all();
  return (res.results || []).map(checklistRow);
}

// ---------- 의장 봇 (10분마다 방을 확인해 사회를 봅니다) ----------
// Cloudflare Cron Trigger가 scheduled(event, env, ctx)를 10분마다 부릅니다.
// 규칙: 최근 10분 안에 올라온 똑똑이님 메시지 중 답글이 아직 없는 것만 처리합니다.
//       방마다 최대 1개, 같은 질문에는 이미 남긴 의장 메시지가 있으면 다시 안 남깁니다.
//       의장 자신의 메시지에는 절대 반응하지 않습니다 (똑똑이님 메시지만 봅니다).
const CHAIR_NAME = '의장';
// 토큰 절약: 의논도 최대 2명까지만 부릅니다 (담당자 + 뮤즈 정리). 5명 전원 호출은 토큰만 먹어요.

// 키워드로 담당 AI를 정합니다.
function routeQuestion(content) {
  const t = String(content || '');
  if (/인스타|릴스|카드뉴스|숏츠|스레드|지비|하하|유닉/.test(t)) return '피클1';
  if (/블로그|원고|카페|체험단|글쓰기/.test(t)) return '클로드';
  if (/순위|분석|상위노출|노출|검색|데이터랩/.test(t)) return 'Gemini';
  if (/코드|자동화|개발|회의실|디자인|버그|에러/.test(t)) return '코덱스';
  return '뮤즈';
}

// 할 일 제목·담당자로 그 일이 있는 방을 정합니다 (방으로 가기·재촉용).
function roomForItem(title, assignee) {
  const t = String(title || '');
  if (/스레드|드레쓰/.test(t)) return 'threads';
  if (/카드뉴스|카뉴|릴스|숏츠|인스타/.test(t)) return 'instagram';
  if (/블로그|원고|전자책/.test(t)) return 'blog';
  if (/스마트스토어|상품명|애플파이|순위/.test(t)) return 'store';
  if (assignee === '피클1') return 'instagram';
  if (assignee === '피클2') return 'threads';
  if (assignee === '클로드') return 'blog';
  if (assignee === '브이' || assignee === '부이' || assignee === '부이~') return 'store';
  return 'general';
}

function questionSummary(content) {
  const one = String(content || '').replace(/\s+/g, ' ').trim();
  return one.length > 200 ? one.slice(0, 200) + '…' : one;
}

async function runChair(env) {
  const rooms = await roomList(env);
  for (const room of rooms) {
    // 최근 10분 안의 똑똑이님 메시지 (오래된 순)
    const res = await env.DB.prepare(
      `select id, sender, content, created_at from messages
        where room_slug = ? and sender = '똑똑이'
          and datetime(created_at) >= datetime('now', '-10 minutes')
        order by id asc limit 20`
    ).bind(room.slug).all();
    const questions = res.results || [];
    for (const q of questions) {
      // 이미 답글이 달렸으면 패스
      const replied = await env.DB.prepare(
        'select id from messages where room_slug = ? and reply_to_id = ? limit 1'
      ).bind(room.slug, q.id).first();
      if (replied) continue;
      // 이미 의장 메시지가 달렸으면 패스 (중복 방지)
      const chaired = await env.DB.prepare(
        "select id from messages where room_slug = ? and reply_to_id = ? and sender = '의장' limit 1"
      ).bind(room.slug, q.id).first();
      if (chaired) continue;

      const isDiscussion = /의논|토론/.test(q.content || '');
      const assignee = routeQuestion(q.content);
      let content;
      if (isDiscussion) {
        // 토큰 절약: 담당자 + 정리 담당(뮤즈)만 부릅니다.
        const order = assignee === '뮤즈' ? '@뮤즈' : `@${assignee} @뮤즈`;
        content =
          `${order} — 똑똑이님이 의논을 요청했어요. 각자 자기 역할 입장에서 2줄 이내로 짧게 의견 남기고, 뮤즈가 정리해주세요.\n` +
          `질문: ${questionSummary(q.content)}`;
      } else {
        content =
          `@${assignee}, 똑똑이님 질문에 답해주세요. 답은 요약으로, 5줄 이내로 짧게.\n` +
          `질문: ${questionSummary(q.content)}`;
      }
      // 기존 메시지 저장 로직을 그대로 재사용합니다.
      await postMessage(env, room.slug, { sender: CHAIR_NAME, content, reply_to_id: q.id });
      break; // 한 번 실행에 방마다 최대 1개
    }
  }
  await dailyReminder(env);
  await stallNudge(env);
}

// 안 진행되는 일 재촉: 배정받고 1시간이 지나도 확인 답글이 없으면 의장이 1시간마다 불러서 확인을 재촉합니다.
// (키링은 회의실에 없어서 제외. 같은 담당자는 4시간 안에 한 번만 부릅니다.)
async function stallNudge(env) {
  const m = await env.DB.prepare(
    "select CAST(strftime('%M', 'now', '+9 hours') AS INTEGER) as mm"
  ).first();
  if (!m || m.mm >= 10) return; // 매시 정각 사이클에만 1번
  const rows = await env.DB.prepare(
    `select c.id, c.title, c.assignee from checklist c
       where c.status in ('todo', 'waiting') and c.assignee is not null and c.assignee != '' and c.assignee != '키링'
         and datetime(c.created_at) <= datetime('now', '-1 hour')
         and not exists (select 1 from messages m where m.sender = c.assignee and m.created_at > c.created_at)
       order by c.id asc limit 3`
  ).all();
  const items = rows.results || [];
  for (const it of items) {
    const room = roomForItem(it.title, it.assignee);
    const called = await env.DB.prepare(
      `select id from messages where room_slug = ? and sender = '의장'
         and content like ? and datetime(created_at) >= datetime('now', '-4 hours') limit 1`
    ).bind(room, `%@${it.assignee}%`).first();
    if (called) continue;
    await postMessage(env, room, {
      sender: CHAIR_NAME,
      content: `@${it.assignee}, '${it.title}' 아직 확인 전이에요. '네, 확인했습니다. 진행하겠습니다.'라고 답해주세요. 진행 상황도 알려주세요.`,
    });
  }
}

// 매일 할 일 알림: 저녁 19시(KST) 이후에 [매일] 항목이 아직 안 끝났으면
// '똑똑이에게 온 채팅' 방에 하루 1번만 알림을 남깁니다.
async function dailyReminder(env) {
  const hour = await env.DB.prepare(
    "select CAST(strftime('%H', 'now', '+9 hours') AS INTEGER) as h"
  ).first();
  if (!hour || hour.h < 19) return;
  const counted = await env.DB.prepare(
    "select count(*) as n from checklist where group_name = '매일' and instr(title, '매일') > 0 and status = 'todo'"
  ).first();
  const n = (counted && counted.n) || 0;
  if (!n) return;
  // 오늘 이미 알림을 남겼으면 패스
  const sent = await env.DB.prepare(
    `select id from messages where room_slug = 'to-me' and sender = '의장'
       and content like '[매일 할 일 알림]%'
       and date(datetime(created_at), '+9 hours') = date('now', '+9 hours') limit 1`
  ).first();
  if (sent) return;
  const rows = await env.DB.prepare(
    "select title from checklist where group_name = '매일' and instr(title, '매일') > 0 and status = 'todo' order by id asc limit 5"
  ).all();
  const titles = (rows.results || []).map((r) => '- ' + r.title).join('\n');
  const more = n > 5 ? `\n외 ${n - 5}건` : '';
  await postMessage(env, 'to-me', {
    sender: CHAIR_NAME,
    content:
      `[매일 할 일 알림] 똑똑이님, 오늘 매일 할 일 ${n}건이 아직 안 끝났어요. 처리해주세요.\n` +
      titles + more,
  });
}

const DOCS_TEMPLATE = `# AI 팀 회의실 API 사용법

사람 1명과 여러 AI 에이전트가 한 화면의 방(Room)별로 대화하는 경량 회의실입니다.
AI 는 아래 API 로 사람처럼 읽고 쓸 수 있습니다. (Claude Code, Codex, GPT, 커스텀 봇 모두 동일)

## 참여자(역할)
| 이름 | 역할 | 이모지 |
| --- | --- | --- |
__AGENTS_TABLE__

이름은 자유롭게 쓰셔도 됩니다. 목록에 없는 이름은 '참여자' 배지로 표시됩니다.

## 접속 정보
- BASE URL: __BASE__
- API KEY: __KEY__
- 인증 헤더: Authorization: Bearer __KEY__  (또는 X-Room-Key: __KEY__)
- 방(slug): __ROOMS__

## 1) 방 목록
curl -s -H "Authorization: Bearer __KEY__" "__BASE__/api/rooms"

## 2) 메시지 읽기
# after 를 생략하면 최근 메시지(기본 50건, 오래된 순)를 돌려줍니다.
curl -s -H "Authorization: Bearer __KEY__" "__BASE__/api/rooms/__FIRST_ROOM__/messages?limit=50"

# 마지막으로 본 id 이후의 새 메시지만 (폴링용)
curl -s -H "Authorization: Bearer __KEY__" "__BASE__/api/rooms/__FIRST_ROOM__/messages?after=12&limit=50"

## 3) 메시지 보내기
curl -s -X POST "__BASE__/api/rooms/__FIRST_ROOM__/messages" \\
  -H "Authorization: Bearer __KEY__" \\
  -H "Content-Type: application/json" \\
  -d '{"sender":"Dev","content":"배포 스크립트 점검 끝났습니다.","reply_to_id":12}'

- sender: 참여자 이름(24자 이내). 목록에 없는 이름은 '참여자' 배지로 표시됩니다.
- content: 1~4000자. 줄바꿈, **굵게**, \`코드\`, 목록(- ), 링크, @멘션이 화면에서 렌더링됩니다.
- reply_to_id: 선택. 답글 대상 메시지 id.

## 응답 예시
{"ok":true,"room":{"slug":"general","name":"종합"},
 "messages":[{"id":13,"sender":"Dev","role":"개발 · 자동화","content":"...",
              "reply_to_id":12,"reply_to":{"id":12,"sender":"CEO","content":"..."},
              "created_at":"2026-01-01T02:50:11.412Z"}],
 "latest_id":13}

- created_at 은 UTC(ISO8601)이고 화면에는 한국 시간으로 표시됩니다.
- 다음 폴링은 마지막으로 받은 id 를 after 로 넘기면 됩니다.

## 그 밖의 엔드포인트
- GET /api/agents — 참여자 목록
- GET /api/checklist — 결재·체크리스트 목록
- POST /api/checklist — 체크리스트 항목 추가 (group_name 생략 시 오늘 날짜)
- PATCH /api/checklist/:id — 체크리스트 상태 변경 (todo/waiting/done/approved/rejected) · 담당자(assignee)·내용(detail)·링크(link) 수정 가능
- GET /api/attachments/:id — 첨부 이미지/파일 조회 (인증 필요, ?key= 지원)
- GET /api/docs?format=json — 이 안내의 JSON 버전
- GET /api/health — 상태 확인(인증 불필요)

(참고: POST /api/rooms/:slug/messages 본문에 attachment: { filename, mime_type, data_base64 } 를 넣으면 약 700KB 이하 파일을 함께 첨부할 수 있습니다.)

## 주의
- 메시지는 회의실 DB 에 남고 참여자 모두가 읽습니다.
- API KEY 는 외부에 공개하지 마세요.
- HTTP 클라이언트가 기본 User-Agent(python-urllib 등)를 쓰면 Cloudflare 가 403으로 막는 경우가 있습니다.
  "User-Agent: ai-team-room-agent/1.0" 처럼 UA 를 지정하세요. (curl 기본 UA 는 정상 동작)
`;

async function docsText(env, url) {
  const list = await roomList(env);
  const rooms = list.map((r) => `${r.slug}(${r.name})`).join(', ') || '(방 없음)';
  const firstRoom = list[0];
  const table = Object.entries(AGENTS)
    .map(([name, m]) => `| ${name} | ${m.role} | ${m.emoji} |`)
    .join('\n');
  return DOCS_TEMPLATE
    .replaceAll('__AGENTS_TABLE__', table)
    .replaceAll('__BASE__', url.origin)
    .replaceAll('__KEY__', env.API_KEY || '(API_KEY 미설정)')
    .replaceAll('__ROOMS__', rooms)
    .replaceAll('__FIRST_ROOM__', firstRoom ? firstRoom.slug : 'general');
}

async function handleApi(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = request.method.toUpperCase();

  if (parts[1] === 'health') {
    let dbOk = false;
    try {
      const r = await env.DB.prepare('select 1 as ok').first();
      dbOk = !!(r && Number(r.ok) === 1);
    } catch (e) {
      dbOk = false;
    }
    return json({ ok: dbOk, service: 'ai-team-room', db: dbOk, time: new Date().toISOString() });
  }

  if (!authorized(request, env, url)) {
    return json(
      { ok: false, error: 'unauthorized', message: 'API 키가 필요합니다. Authorization: Bearer <API_KEY>' },
      401
    );
  }

  if (parts[1] === 'docs' || parts[1] === 'guide') {
    if ((url.searchParams.get('format') || '') === 'json') {
      const rooms = await roomList(env);
      return json({
        ok: true,
        name: 'AI 팀 회의실 API',
        base_url: url.origin,
        auth: 'Authorization: Bearer <API_KEY> (또는 X-Room-Key: <API_KEY>)',
        rooms: rooms.map((r) => ({ slug: r.slug, name: r.name })),
        agents: Object.entries(AGENTS).map(([name, m]) => ({ name, role: m.role, color: m.color, emoji: m.emoji })),
        endpoints: [
          { method: 'GET', path: '/api/rooms', note: '방 목록' },
          { method: 'GET', path: '/api/rooms/:slug/messages?after=<id>&limit=50', note: '메시지 조회' },
          {
            method: 'POST',
            path: '/api/rooms/:slug/messages',
            body: { sender: 'Dev', content: '안녕하세요', reply_to_id: 12 },
            note: '메시지 전송',
          },
          { method: 'GET', path: '/api/rooms/:slug/read-mark', note: '똑똑이 확인완료 위치 조회' },
          {
            method: 'POST',
            path: '/api/rooms/:slug/read-mark',
            body: { last_read_id: 123 },
            note: '똑똑이 확인완료 위치 저장 (생략 시 최신 메시지까지)',
          },
          { method: 'GET', path: '/api/checklist', note: '결재·체크리스트 목록' },
          {
            method: 'POST',
            path: '/api/checklist',
            body: { title: '할 일', group_name: '매일', assignee: '피클1', source: 'notion' },
            note: '체크리스트 항목 추가 (group_name 생략 시 오늘 날짜)',
          },
          {
            method: 'PATCH',
            path: '/api/checklist/:id',
            body: { status: 'approved', reason: '' },
            note: '체크리스트 상태 변경 (todo/waiting/done/approved/rejected) · 담당자(assignee) 변경 가능',
          },
          { method: 'GET', path: '/api/agents', note: '참여자 목록' },
          { method: 'GET', path: '/api/health', note: '상태 확인(인증 불필요)' },
        ],
        note: 'python-urllib 등 기본 User-Agent 는 Cloudflare 가 403으로 막는 경우가 있습니다. UA 를 지정하세요.',
      });
    }
    return text(await docsText(env, url));
  }

  if (parts[1] === 'agents' && method === 'GET') {
    return json({
      ok: true,
      agents: Object.entries(AGENTS).map(([name, m]) => ({ name, role: m.role, color: m.color, emoji: m.emoji })),
    });
  }

  if (parts[1] === 'attachments' && parts.length === 3 && method === 'GET') {
    const id = parseInt(parts[2], 10);
    if (!Number.isFinite(id) || id <= 0) {
      return json({ ok: false, error: 'invalid_id' }, 400);
    }
    const row = await env.DB.prepare('select filename, mime_type, data_base64 from attachments where id = ?')
      .bind(id)
      .first();
    if (!row) return json({ ok: false, error: 'not_found' }, 404);
    const bin = atob(row.data_base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const mime = row.mime_type || 'application/octet-stream';
    const isInline = mime.startsWith('image/');
    const disp = (isInline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(row.filename || 'file');
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': mime,
        'content-disposition': disp,
        'cache-control': 'private, max-age=86400',
        ...CORS,
      },
    });
  }

  // ---------- 결재·체크리스트 ----------
  if (parts[1] === 'checklist') {
    if (method === 'GET' && parts.length === 2) {
      return json({ ok: true, items: await listChecklist(env) });
    }
    if (method === 'POST' && parts.length === 2) {
      let payload;
      try {
        payload = await request.json();
      } catch (e) {
        return json({ ok: false, error: 'invalid_json', message: 'JSON 본문이 필요합니다.' }, 400);
      }
      const title = String((payload && payload.title) || '').trim();
      if (!title) return json({ ok: false, error: 'invalid_request', message: 'title 이 필요합니다.' }, 400);
      if (title.length > 200) return json({ ok: false, error: 'invalid_request', message: 'title 은 200자까지 가능합니다.' }, 400);
      // 그룹을 안 보내면 오늘 날짜(M.DD)로 자동 지정합니다.
      const group = String((payload && payload.group_name) || '').trim() || todayLabel();
      const assignee = String((payload && payload.assignee) || '').trim().slice(0, 24);
      const source = String((payload && payload.source) || '').trim().slice(0, 40);
      const detail = String((payload && payload.detail) || '').trim().slice(0, 2000);
      const link = String((payload && payload.link) || '').trim().slice(0, 500);
      await ensureChecklistTable(env);
      const res = await env.DB.prepare(
        `insert into checklist (title, group_name, assignee, status, source, detail, link, created_at)
         values (?, ?, ?, 'todo', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      )
        .bind(title, group, assignee || null, source || null, detail || null, link || null)
        .run();
      const id = res.meta && res.meta.last_row_id;
      const row = await env.DB.prepare('select * from checklist where id = ?').bind(id).first();
      return json({ ok: true, item: checklistRow(row) }, 201);
    }
    if (method === 'PATCH' && parts.length === 3) {
      const id = parseInt(parts[2], 10);
      if (!Number.isFinite(id) || id <= 0) return json({ ok: false, error: 'invalid_id' }, 400);
      let payload;
      try {
        payload = await request.json();
      } catch (e) {
        return json({ ok: false, error: 'invalid_json', message: 'JSON 본문이 필요합니다.' }, 400);
      }
      await ensureChecklistTable(env);
      const existing = await env.DB.prepare('select * from checklist where id = ?').bind(id).first();
      if (!existing) return json({ ok: false, error: 'not_found', message: '항목이 없습니다.' }, 404);
      const status = payload && payload.status !== undefined && payload.status !== null && String(payload.status).trim() !== ''
        ? String(payload.status).trim() : existing.status;
      if (!CHECKLIST_STATUSES.includes(status)) {
        return json({ ok: false, error: 'invalid_request', message: 'status 는 todo/done/approved/rejected 중 하나여야 합니다.' }, 400);
      }
      const reason = payload && payload.reason !== undefined ? String(payload.reason).trim().slice(0, 500) : (existing.reason || '');
      const detail = payload && payload.detail !== undefined ? String(payload.detail).trim().slice(0, 2000) : (existing.detail || '');
      const link = payload && payload.link !== undefined ? String(payload.link).trim().slice(0, 500) : (existing.link || '');
      const progress = payload && payload.progress !== undefined && payload.progress !== null && String(payload.progress).trim() !== ''
        ? Math.max(0, Math.min(100, parseInt(payload.progress, 10) || 0)) : (parseInt(existing.progress, 10) || 0);
      const assignee = payload && payload.assignee !== undefined ? String(payload.assignee).trim().slice(0, 24) : (existing.assignee || '');
      await env.DB.prepare('update checklist set status = ?, reason = ?, detail = ?, link = ?, progress = ?, assignee = ? where id = ?')
        .bind(status, reason || null, detail || null, link || null, progress, assignee || null, id)
        .run();
      const row = await env.DB.prepare('select * from checklist where id = ?').bind(id).first();
      return json({ ok: true, item: checklistRow(row) });
    }
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }

  if (parts[1] === 'rooms' && parts.length === 2 && method === 'GET') {
    return json({ ok: true, rooms: await roomList(env) });
  }

  if (parts[1] === 'rooms' && parts.length === 4 && parts[3] === 'messages') {
    const slug = decodeURIComponent(parts[2]);
    const room = await getRoom(env, slug);
    if (!room) return json({ ok: false, error: 'room_not_found', message: `방 '${slug}' 이 없습니다.` }, 404);

    if (method === 'GET') {
      const after = parseInt(url.searchParams.get('after') || '0', 10) || 0;
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);
      const { messages, latest } = await listMessages(env, slug, after, limit);
      return json({ ok: true, room, messages, latest_id: latest });
    }

    if (method === 'POST') {
      let payload;
      try {
        payload = await request.json();
      } catch (e) {
        return json({ ok: false, error: 'invalid_json', message: 'JSON 본문이 필요합니다.' }, 400);
      }
      const out = await postMessage(env, slug, payload || {});
      if (out.error) return json({ ok: false, error: 'invalid_request', message: out.error }, out.status || 400);
      return json({ ok: true, room, message: out.message }, 201);
    }

    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }

  // ---------- 똑똑이 확인완료 표시 (방마다 읽은 위치 저장) ----------
  if (parts[1] === 'rooms' && parts.length === 4 && parts[3] === 'read-mark') {
    const slug = decodeURIComponent(parts[2]);
    const room = await getRoom(env, slug);
    if (!room) return json({ ok: false, error: 'room_not_found', message: `방 '${slug}' 이 없습니다.` }, 404);

    if (method === 'GET') {
      return json({ ok: true, room: slug, last_read_id: await getReadMark(env, slug) });
    }

    if (method === 'POST') {
      let payload;
      try { payload = await request.json(); } catch (e) { payload = {}; }
      let lastId = parseInt(payload && payload.last_read_id, 10);
      if (!Number.isFinite(lastId) || lastId < 0) {
        const row = await env.DB.prepare('select max(id) as m from messages where room_slug = ?').bind(slug).first();
        lastId = (row && row.m) || 0;
      }
      await ensureReadMarksTable(env);
      await env.DB.prepare(
        `insert into read_marks (room_slug, last_read_id, updated_at) values (?, ?, datetime('now'))
         on conflict(room_slug) do update set last_read_id = excluded.last_read_id, updated_at = datetime('now')`
      ).bind(slug, lastId).run();
      return json({ ok: true, room: slug, last_read_id: lastId });
    }

    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }

  return json({ ok: false, error: 'not_found', message: '알 수 없는 API 경로입니다. /api/docs 를 확인하세요.' }, 404);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runChair(env).catch((err) => console.error('[chair]', err && err.message ? err.message : err))
    );
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json(
          { ok: false, error: 'server_error', message: String(err && err.message ? err.message : err) },
          500
        );
      }
    }
    return env.ASSETS.fetch(request);
  },
};
