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
  '피클3': { role: '숏츠 · 키워드·대본', color: '#7ed957', emoji: '🐥' },
  '피클4': { role: '피클4', color: '#b388ff', emoji: '🐼' },
  '피클5': { role: '5번 · 먼저 일하기', color: '#ffd166', emoji: '🐯' },
  '피클5': { role: '5번 · 먼저 일하기', color: '#ffd166', emoji: '🐯' },
  '뮤즈': { role: '기획 · 노션 정리 · 리서치', color: '#d9a7ff', emoji: '🌸' },
  '클로드': { role: '블로그 원고 · 벤치마킹', color: '#ffa94d', emoji: '🦊' },
  '숏츠.딸깍이': { role: '숏츠 제작 · 협업', color: '#ff8b6b', emoji: '🎬' },
  'Gemini': { role: '빠른 리서치 · 상위노출 분석', color: '#2dd4bf', emoji: '🐰' },
  '코덱스': { role: '코드 · 자동화 · 회의실 개발', color: '#60a5fa', emoji: '🦈' },
  '의장': { role: '회의 진행 · 역할 배정', color: '#8b5cf6', emoji: '🤖' },
  '부이~': { role: '조사 · 가격 비교 · 정리', color: '#f0b070', emoji: '🦊' },
};

const AGENT_ALIASES = { '브이': '부이~', '부이': '부이~', '부이~': '부이~', v: '부이~',
  gemini: 'Gemini', '재미나이': 'Gemini', codex: '코덱스', '코덱스': '코덱스', claude: '클로드', '클로드': '클로드' };
function canonicalAgent(value) {
  const name = String(value || '').trim();
  return AGENT_ALIASES[name.toLowerCase()] || name;
}
function normalizeMentions(content) {
  return String(content || '').replace(/(^|[\s(])@(숏츠\.딸깍이|[가-힣A-Za-z0-9_~]+)/g,
    (_all, prefix, name) => prefix + '@' + canonicalAgent(name));
}

// 방 목록은 D1 의 rooms 테이블이 기준입니다. (schema.sql 기본값: general / instagram / blog / store / later)

const PALETTE = ['#ff5c8a', '#6fc3ff', '#f0b070', '#a78bfa', '#5ed6a8', '#ffd166', '#ff8b6b', '#8fb8ff'];
const OWNER_ROOM_NAME = '가자상노!!방';

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
  const raw = canonicalAgent(sender);
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
    content: normalizeMentions(row.content),
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
          content: normalizeMentions(parent.content).slice(0, 300),
        }
      : null;
  }
  return messages;
}

// 방 목록을 읽기 전에 기본 방과 표시 이름을 맞춥니다. 방 slug와 메시지는 유지합니다.
// INSERT OR IGNORE라 이미 있으면 아무 일도 안 생깁니다. D1 콘솔을 따로 거칠 필요가 없습니다.
async function ensureRooms(env) {
  try {
    await env.DB.prepare(
      `insert or ignore into rooms (slug, name, description, position) values ('to-me', '가자상노!!방', 'AI들이 똑똑이님께 물어볼 때 쓰는 방', 6)`
    ).run();
    await env.DB.prepare("update rooms set name = ? where slug = 'to-me' and name != ?")
      .bind(OWNER_ROOM_NAME, OWNER_ROOM_NAME).run();
    await env.DB.prepare(
      `insert or ignore into rooms (slug, name, description, position) values ('orders', '지시방', '똑똑이님이 지시를 올리는 방 · AI들이 역할 나눠서 실행', 7)`
    ).run();
    await env.DB.prepare(
      `insert or ignore into rooms (slug, name, description, position) values ('threads', '스레드', '스레드 분석·벤치마킹·발행 준비', 8)`
    ).run();
    await env.DB.prepare(
      `insert or ignore into rooms (slug, name, description, position) values ('shorts', '숏츠', '숏츠 제작·협업', 10)`
    ).run();
    await env.DB.prepare(
      `insert or ignore into rooms (slug, name, description, position) values ('pickles', '피클 토론방', '피클1~5가 함께 대화하는 방', 9)`
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
  const sender = canonicalAgent(payload.sender);
  const content = normalizeMentions(String(payload.content || '').trim());
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
  await queueTelegram(env, row);
  if (sender !== CHAIR_NAME) await syncChecklistFromMessage(env, row);
  return { message: messages[0] };
}


// Telegram credentials are Cloudflare secrets only. Never log request URLs.
async function ensureTelegram(env) {
  await env.DB.prepare(`create table if not exists telegram_inbox (update_id integer primary key)` ).run();
  await env.DB.prepare(`create table if not exists telegram_outbox (
    message_id integer primary key, text text not null, sent_at text,
    lease_until text, attempts integer not null default 0)` ).run();
}

function ownerActionMessage(row) {
  return row.room_slug === 'to-me' || /^\s*(?:[❤♥]\uFE0F?\s*)+(?:똑똑이\s*)?확인/.test(String(row.content || ''));
}
function telegramEligible(row) {
  if (ownerActionMessage(row) || /@똑똑이|\[피클 브리핑\]|완료/.test(String(row.content || ''))) return true;
  // 전 방 새 글 알림(2026-11-25): AI 팀원의 새 글을 짧게 알림. 뮤즈·의장·똑똑이 본인 글은 제외(재촉·알림 루프 방지).
  const sender = String(row.sender || '').trim();
  if (sender === '뮤즈' || sender === '의장' || sender === '똑똑이') return false;
  return true;
}
function ownerAddressed(row) {
  return ownerActionMessage(row) || /@똑똑이(?:\s|[.,!?]|$)|\[피클 브리핑\]/.test(String(row.content || ''));
}
function telegramRoomUrl(row) {
  return `https://ai-team-room.oouuu2.workers.dev/?room=${encodeURIComponent(row.room_slug || 'general')}`;
}

function telegramSummary(roomName, row) {
  const content = String(row.content || '').trim();
  const prefix = `[${row.room_slug === 'to-me' ? OWNER_ROOM_NAME : roomName}] ${String(row.sender || '').trim()}: `;
  if (!ownerAddressed(row)) {
    const firstLine = content.split(/\r?\n/).map(line => line.trim()).find(Boolean) || '(첨부 또는 내용 없음)';
    return prefix + Array.from(firstLine).slice(0,120).join('') + ' ...';
  }
  const roomUrl = ownerActionMessage(row)
    ? '\n\n처리방: https://muse.ai/library/artifacts/ceoribang'
    : `\n\n회의실: ${telegramRoomUrl(row)}`;
  // Telegram sendMessage limit is 4096 chars; keep a margin for prefix + room link.
  // Send the full text (no 3-line cut) so Telegram's own "read more" expands it on tap.
  const maxBody = 4000 - prefix.length - roomUrl.length;
  const body = content.length > maxBody ? content.slice(0, Math.max(0, maxBody)).replace(/[\uD800-\uDBFF]$/,'') + '…' : content;
  return prefix + body + roomUrl;
}

async function queueTelegram(env, row) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !telegramEligible(row)) return;
  await ensureTelegram(env);
  const room = await getRoom(env, row.room_slug);
  await env.DB.prepare('insert or ignore into telegram_outbox (message_id, text) values (?, ?)')
    .bind(row.id, telegramSummary(room ? room.name : row.room_slug, row)).run();
}

async function flushTelegram(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  await ensureTelegram(env);
  const rows = await env.DB.prepare(`select o.message_id, o.text, m.room_slug, m.sender, m.content, r.name as room_name
    from telegram_outbox o left join messages m on m.id=o.message_id left join rooms r on r.slug=m.room_slug
    where o.sent_at is null and (o.lease_until is null or datetime(o.lease_until) < datetime('now'))
    order by o.message_id limit 20`).all();
  for (const row of rows.results || []) {
    const claim = await env.DB.prepare(`update telegram_outbox set lease_until = datetime('now', '+2 minutes'), attempts = attempts + 1
      where message_id = ? and sent_at is null and (lease_until is null or datetime(lease_until) < datetime('now'))`)
      .bind(row.message_id).run();
    if (!claim.meta?.changes) continue;
    try {
      const text = row.room_slug ? telegramSummary(row.room_name || row.room_slug,row) : row.text;
      const payload = {chat_id:env.TELEGRAM_CHAT_ID,text};
      // Telegram entities use UTF-16 offsets, matching JS string lengths. No HTML parsing of user text.
      if (row.room_slug && !ownerAddressed(row)) payload.entities=[{type:'text_link',offset:0,length:text.length,url:telegramRoomUrl(row)}];
      const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error('telegram_send_failed');
      await env.DB.prepare("update telegram_outbox set sent_at = datetime('now'), lease_until = null where message_id = ?")
        .bind(row.message_id).run();
    } catch {
      // Keep the lease and retry on the next cron; do not expose bot URLs/tokens.
      console.error('[telegram] delivery deferred');
      break;
    }
  }
}

function telegramRoute(text) {
  const match = /^\/(blog|threads|store|insta|general)(?:@sorabbang_team_bot)?(?:\s+|$)/i.exec(text);
  return { room: match ? ({ insta: 'instagram' }[match[1].toLowerCase()] || match[1].toLowerCase()) : 'orders',
    content: (match ? text.slice(match[0].length) : text).trim() };
}

async function telegramWebhook(request, env) {
  if (request.method !== 'POST') return json({ ok: false }, 405);
  if (!env.TELEGRAM_WEBHOOK_SECRET || !same(request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '', env.TELEGRAM_WEBHOOK_SECRET))
    return json({ ok: false }, 403);
  const update = await request.json();
  const message = update.message;
  if (!Number.isSafeInteger(update.update_id) || !message || message.from?.is_bot ||
      !env.TELEGRAM_USER_ID || String(message.from?.id) !== String(env.TELEGRAM_USER_ID) ||
      String(message.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return json({ ok: true });
  const text = message.text || message.caption;
  if (typeof text !== 'string') return json({ ok: true });
  const routed = telegramRoute(text);
  if (!routed.content) return json({ ok: true });
  await ensureRooms(env);
  await ensureTelegram(env);
  // The message and update receipt commit together, so Telegram retries cannot duplicate a post.
  await env.DB.batch([
    env.DB.prepare(`insert into messages (room_slug, sender, content, created_at)
      select ?, '똑똑이', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')
      where not exists (select 1 from telegram_inbox where update_id = ?)`)
      .bind(routed.room, routed.content.slice(0, 4000), update.update_id),
    env.DB.prepare('insert or ignore into telegram_inbox (update_id) values (?)').bind(update.update_id),
  ]);
  return json({ ok: true });
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
  try { await env.DB.prepare(`alter table checklist add column updated_at text`).run(); } catch (e) {}
  try { await env.DB.prepare(`alter table checklist add column approved_at text`).run(); } catch (e) {}
  try { await env.DB.prepare(`alter table checklist add column stages text`).run(); } catch (e) {}
  await env.DB.prepare(`create table if not exists automation_events (
    event_key text primary key, created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`).run();
}

function validateStages(stages) {
  if (!Array.isArray(stages) || stages.length > 12) throw new Error('단계는 최대 12개까지 가능합니다.');
  return stages.map(stage => {
    if (!stage || typeof stage !== 'object' || typeof stage.name !== 'string' || !stage.name.trim() || stage.name.trim().length > 40) {
      throw new Error('단계명은 1~40자로 입력하세요.');
    }
    if (stage.progress !== null && (typeof stage.progress !== 'number' || !Number.isInteger(stage.progress) || stage.progress < 0 || stage.progress > 100)) {
      throw new Error('단계 진행률은 0~100 정수 또는 null(미보고)이어야 합니다.');
    }
    const assignee = canonicalAgent(stage.assignee || '');
    if (assignee.length > 24) throw new Error('담당자는 24자까지 가능합니다.');
    return { name: stage.name.trim(), assignee, progress: stage.progress };
  });
}
function readStages(raw) {
  try { return validateStages(JSON.parse(raw || '[]')); } catch { return []; }
}
function checklistRow(row) {
  return {
    id: row.id,
    title: row.title,
    group_name: row.group_name || '',
    assignee: canonicalAgent(row.assignee),
    status: row.status,
    source: row.source || '',
    reason: row.reason || '',
    detail: row.detail || '',
    link: row.link || '',
    progress: Math.max(0, Math.min(100, parseInt(row.progress, 10) || 0)),
    stages: readStages(row.stages),
    started_at: row.started_at || '',
    last_activity_at: row.last_activity_at || '',
    created_at: row.created_at,
  };
}

async function listChecklist(env) {
  await ensureChecklistTable(env);
  const res = await env.DB.prepare(
    `select c.id, c.title, c.group_name, c.assignee, c.status, c.source, c.reason, c.detail, c.link, c.progress, c.stages, c.created_at,
            (select min(m.created_at) from messages m where m.sender = c.assignee and m.created_at > c.created_at) as started_at,
            (select max(m.created_at) from messages m where m.sender = c.assignee) as last_activity_at
       from checklist c order by group_name, id`
  ).all();
  return (res.results || []).map(checklistRow);
}

// Explicit, authenticated workspace updates. Message text is never treated as board commands.
async function ensureRoomBoards(env) {
  await env.DB.prepare(`create table if not exists room_boards (
    room_slug text primary key, data text not null, updated_at text not null
  )`).run();
}
function validateRoomBoard(data) {
  if (!data || !Array.isArray(data.cards) || data.cards.length > 8 || !Array.isArray(data.productions) || data.productions.length > 24)
    throw new Error('상태 카드 최대 8개, 제작 항목 최대 24개가 필요합니다.');
  const str = (s, max) => { if (typeof s !== 'string' || s.length > max) throw new Error('상태판 텍스트 길이를 확인하세요.'); return s.trim(); };
  const link = data.source_url || '';
  if (typeof link !== 'string' || link.length > 500 || (link && !/^https?:\/\//i.test(link))) throw new Error('확인 링크는 http/https 주소여야 합니다.');
  return {
    headline: str(data.headline || '', 160), source_url: link,
    cards: data.cards.map(c => {
      if (!c || (c.progress !== null && (!Number.isInteger(c.progress) || c.progress < 0 || c.progress > 100))) throw new Error('진행률은 0~100 정수 또는 null입니다.');
      return { title: str(c.title,40), text: str(c.text || '',800), assignee: str(c.assignee || '',80), status: str(c.status || '미보고',40), progress:c.progress };
    }),
    productions: data.productions.map(p => ({title:str(p.title,160),status:str(p.status || '미보고',40),assignee:str(p.assignee || '',80)}))
  };
}

// ---------- 의장 봇 (10분마다 방을 확인해 사회를 봅니다) ----------
// Cloudflare Cron Trigger가 scheduled(event, env, ctx)를 10분마다 부릅니다.
// 규칙: 최근 10분 안에 올라온 똑똑이님 메시지 중 답글이 아직 없는 것만 처리합니다.
//       방마다 최대 1개, 같은 질문에는 이미 남긴 의장 메시지가 있으면 다시 안 남깁니다.
//       의장 자신의 메시지에는 절대 반응하지 않습니다 (똑똑이님 메시지만 봅니다).
const CHAIR_NAME = '의장';
// 토큰 절약: 의논도 최대 2명까지만 부릅니다 (담당자 + 뮤즈 정리). 5명 전원 호출은 토큰만 먹어요.

// 키워드로 담당 AI를 정합니다.
function routeQuestion(content, room = 'general') {
  const t = String(content || '');
  const mentions = [...normalizeMentions(t).matchAll(/(?:^|[\s(])@(숏츠\.딸깍이|[가-힣A-Za-z0-9_~]+)/g)];
  const named = mentions.map((m) => canonicalAgent(m[1])).find((name) => AGENTS[name] && !['똑똑이', '의장'].includes(name));
  if (named) return named;
  return ({ instagram: '피클1', threads: '피클2', blog: '클로드', store: 'Gemini', shorts: '숏츠.딸깍이' })[room] || '뮤즈';
}

function isQuestion(content) {
  const t = String(content || '').trim();
  return /[?？]|어떻|어디|왜|뭐|무엇|언제|누가|얼마|가능한가|맞나요|인가요|할까|될까|되나요|있나요|없나요/.test(t);
}

function messageTaskUpdate(content) {
  const t = String(content || '');
  const ids = [...new Set([...t.matchAll(/#(\d+)\b/g)].map((m) => Number(m[1])))];
  const done = /(?:^|\n)\s*(?:#\d+\s*)?(?:완료(?:했습니다|했어요|됨|입니다)?[.!]?|✅)\s*(?:$|\n|:)/.test(t);
  const progress = /진행률\s*[:：]?\s*(100|[1-9]?\d)\s*%/.exec(t);
  return { ids, done, progress: progress ? Number(progress[1]) : null };
}

async function syncChecklistFromMessage(env, message) {
  const update = messageTaskUpdate(message.content);
  if (!update.done && update.progress === null) return;
  await ensureChecklistTable(env);
  let ids = update.ids;
  let parentId = message.reply_to_id;
  // Only follow this reply chain; an unscoped completion never finishes all tasks.
  for (let depth = 0; !ids.length && parentId && depth < 6; depth++) {
    const parent = await env.DB.prepare('select * from messages where id = ? and room_slug = ?').bind(parentId, message.room_slug).first();
    if (!parent) break;
    ids = messageTaskUpdate(parent.content).ids;
    if (!ids.length) {
      const rows = await env.DB.prepare('select id, title from checklist where status in (\'todo\', \'waiting\')').all();
      const matches = (rows.results || []).filter((item) => parent.content.includes(item.title));
      if (matches.length === 1) ids = [matches[0].id];
    }
    parentId = parent.reply_to_id;
  }
  for (const id of ids) {
    if (update.done && ids.length > 1 &&
      !new RegExp('(?:^|\\n)\\s*#' + id + '\\s*(?:완료(?:했습니다|했어요|됨|입니다)?[.!]?|✅)\\s*(?:$|\\n|:)').test(message.content)) continue;
    const item = await env.DB.prepare('select * from checklist where id = ?').bind(id).first();
    if (!item || item.status === 'rejected' || (!update.done && item.status === 'done')) continue;
    const sender = canonicalAgent(message.sender);
    if (!['똑똑이', '뮤즈', canonicalAgent(item.assignee)].includes(sender)) continue;
    const status = update.done ? 'done' : item.status;
    const progress = update.done ? 100 : update.progress;
    await env.DB.prepare("update checklist set status = ?, progress = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = ?")
      .bind(status, progress, id).run();
  }
}

async function sendAutomationOnce(env, key, room, payload) {
  const claim = await env.DB.prepare('insert or ignore into automation_events (event_key) values (?)').bind(key).run();
  if (!claim.meta || !claim.meta.changes) return false;
  try {
    const result = await postMessage(env, room, payload);
    if (result.error) throw new Error(result.error);
    return true;
  } catch (error) {
    await env.DB.prepare('delete from automation_events where event_key = ?').bind(key).run();
    throw error;
  }
}

// 할 일 제목·담당자로 그 일이 있는 방을 정합니다 (방으로 가기·재촉용).
function roomForItem(title, assignee) {
  const t = String(title || '');
  if (/숏츠/.test(t) || assignee === '숏츠.딸깍이') return 'shorts';
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
  await ensureChecklistTable(env);
  const rooms = await roomList(env);
  for (const room of rooms) {
    // 최근 10분 안의 똑똑이님 메시지 (오래된 순)
    const res = await env.DB.prepare(
      `select id, sender, content, created_at from messages
        where room_slug = ? and sender = '똑똑이'
          and datetime(created_at) >= datetime('now', '-24 hours')
          and datetime(created_at) <= datetime('now', '-10 minutes')
        order by id desc limit 200`
    ).bind(room.slug).all();
    const questions = res.results || [];
    for (const q of questions) {
      if (!isQuestion(q.content)) continue;
      // 이미 답글이 달렸으면 패스
      const replied = await env.DB.prepare(
        `select id from messages where room_slug = ? and sender not in ('의장', '똑똑이')
          and (reply_to_id = ? or reply_to_id in
            (select id from messages where room_slug = ? and sender = '의장' and reply_to_id = ?)) limit 1`
      ).bind(room.slug, q.id, room.slug, q.id).first();
      if (replied) continue;
      // 이미 의장 메시지가 달렸으면 패스 (중복 방지)
      const calls = await env.DB.prepare(
        "select id, created_at from messages where room_slug = ? and reply_to_id = ? and sender = '의장' order by id"
      ).bind(room.slug, q.id).all();
      const previous = calls.results || [];
      if (previous.length >= 2) continue;
      if (previous.length && Date.now() - Date.parse(previous[0].created_at) < 30 * 60 * 1000) continue;

      const isDiscussion = /의논|토론/.test(q.content || '');
      const assignee = routeQuestion(q.content, room.slug);
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
      await sendAutomationOnce(env, `question:${q.id}:${previous.length + 1}`, room.slug,
        { sender: CHAIR_NAME, content, reply_to_id: q.id });
      break; // 한 번 실행에 방마다 최대 1개
    }
  }
  await dailyReminder(env);
  await approvalNudge(env);
}

async function approvalNudge(env) {
  const rows = await env.DB.prepare(`select * from checklist where status = 'approved'
    and approved_at is not null and assignee is not null and assignee != ''
    and datetime(approved_at) <= datetime('now', '-30 minutes')
    and (updated_at is null or datetime(updated_at) <= datetime(approved_at))`).all();
  for (const item of rows.results || []) {
    // Only this card's updated_at suppresses the reminder; unrelated chat does not.
    await sendAutomationOnce(env, `approval:${item.id}:${item.approved_at}`, roomForItem(item.title, item.assignee), {
      sender: CHAIR_NAME,
      content: `@${canonicalAgent(item.assignee)}, #${item.id} 승인 후 30분 동안 진척이 확인되지 않았습니다. 승인 범위의 실행과 진행률을 알려주세요.`,
    });
  }
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
// to-me(가자상노!!방)에 하루 1번만 알림을 남깁니다.
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
- GET /api/rooms/:slug/board — 방 작업실 상태판 (없으면 board:null)
- PATCH /api/rooms/:slug/board — 상태판 전체 교체. {headline,source_url,cards:[{title,text,assignee,status,progress:0~100 또는 null}],productions:[{title,status,assignee}]}. 카드 최대8개·제작24개. 미보고는 null로 보내세요. 메시지는 상태판 명령으로 해석하지 않습니다.
- GET /api/checklist — 결재·체크리스트 목록
- POST /api/checklist — 체크리스트 항목 추가 (group_name 생략 시 오늘 날짜)
- PATCH /api/checklist/:id — 체크리스트 상태 변경 (todo/waiting/done/approved/rejected) · 담당자(assignee)·내용(detail)·링크(link)·단계(stages) 수정 가능. stages: [{name, assignee, progress: 0~100 정수 또는 null(미보고)}], 최대 12개. 생략 시 보존, []로 초기화. 전체 진행률·결재와 독립.
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

  const mediaTicket = url.pathname.startsWith('/api/shorts-workroom/') && request.method === 'GET' && await swTicketValid(env,url);
  if (!mediaTicket && !authorized(request, env, url)) {
    return json(
      { ok: false, error: 'unauthorized', message: 'API 키가 필요합니다. Authorization: Bearer <API_KEY>' },
      401
    );
  }

  if (parts[1] === 'shorts-workroom') {
    if (method !== 'GET') return json({ok:false,error:'workroom_moved_to_office',target:'https://oouuu2.pythonanywhere.com/',message:'카드 작업은 현주 AI 오피스의 숏츠작업실에서 진행합니다. 기존 데이터는 보존됩니다.'},410);
    return shortsApi(request, env, url);
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
          { method: 'GET', path: '/api/rooms/:slug/board', note: '방 작업실 상태판 조회' },
          { method: 'PATCH', path: '/api/rooms/:slug/board', body: {headline:'작업 보고',source_url:'',cards:[{title:'키워드',text:'보고 내용',assignee:'뮤즈',status:'미보고',progress:null}],productions:[]},note:'상태판 전체 교체. 카드 최대8개·제작24개. 미보고는 null. 채팅 자동해석 아님.' },
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
      const assignee = canonicalAgent((payload && payload.assignee) || '').slice(0, 24);
      const source = String((payload && payload.source) || '').trim().slice(0, 40);
      const detail = String((payload && payload.detail) || '').trim().slice(0, 2000);
      const link = String((payload && payload.link) || '').trim().slice(0, 500);
      let stages;
      try { stages = validateStages(payload?.stages ?? []); }
      catch (e) { return json({ ok: false, error: 'invalid_request', message: e.message }, 400); }
      await ensureChecklistTable(env);
      const res = await env.DB.prepare(
        `insert into checklist (title, group_name, assignee, status, source, detail, link, stages, created_at)
         values (?, ?, ?, 'todo', ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      )
        .bind(title, group, assignee || null, source || null, detail || null, link || null, JSON.stringify(stages))
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
      const assignee = canonicalAgent(payload && payload.assignee !== undefined ? payload.assignee : existing.assignee).slice(0, 24);
      const approvalTime = status === 'approved' && existing.status !== 'approved' ? new Date().toISOString() : existing.approved_at;
      let stages = readStages(existing.stages);
      try { if (payload && payload.stages !== undefined) stages = validateStages(payload.stages); }
      catch (e) { return json({ ok: false, error: 'invalid_request', message: e.message }, 400); }
      await env.DB.prepare("update checklist set status = ?, reason = ?, detail = ?, link = ?, progress = ?, assignee = ?, approved_at = ?, stages = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = ?")
        .bind(status, reason || null, detail || null, link || null, progress, assignee || null, approvalTime || null, JSON.stringify(stages), id)
        .run();
      const row = await env.DB.prepare('select * from checklist where id = ?').bind(id).first();
      return json({ ok: true, item: checklistRow(row) });
    }
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }

  if (parts[1] === 'rooms' && parts.length === 2 && method === 'GET') {
    return json({ ok: true, rooms: await roomList(env) });
  }

  if (parts[1] === 'rooms' && parts.length === 4 && parts[3] === 'board') {
    const slug = decodeURIComponent(parts[2]);
    if (!await getRoom(env, slug)) return json({ok:false,error:'room_not_found'},404);
    await ensureRoomBoards(env);
    if (method === 'GET') {
      const row = await env.DB.prepare('select data, updated_at from room_boards where room_slug = ?').bind(slug).first();
      return json({ok:true,room:slug,board:row ? JSON.parse(row.data) : null,updated_at:row?.updated_at || null});
    }
    if (method === 'PATCH') {
      let data;
      try { data = validateRoomBoard(await request.json()); }
      catch(e) { return json({ok:false,error:'invalid_request',message:e.message},400); }
      await env.DB.prepare(`insert into room_boards (room_slug,data,updated_at) values (?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        on conflict(room_slug) do update set data=excluded.data,updated_at=excluded.updated_at`).bind(slug,JSON.stringify(data)).run();
      return json({ok:true,room:slug,board:data});
    }
    return json({ok:false,error:'method_not_allowed'},405);
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

// ---------- 숏츠 작업방 (shared room-key authentication; not per-user ACL) ----------
const SW_MAX_FILE = 500 * 1024 * 1024;
const SW_PART = 8 * 1024 * 1024;
const SW_SLOTS = ['source','narration_kr','narration_jp','video_kr','video_jp','thumbnail_kr','thumbnail_jp','upload_notes'];
async function ensureShorts(env) {
  await env.DB.prepare(`create table if not exists shorts_cards (
    id integer primary key autoincrement, version integer not null default 1,
    data text not null, updated_at text not null)`).run();
  await env.DB.prepare(`create table if not exists shorts_files (
    id text primary key, card_id integer not null, slot text not null, name text not null,
    mime text not null, size integer not null, object_key text not null,
    upload_id text, status text not null, parts text not null default '{}', created_at text not null)`).run();
  await env.DB.prepare(`create table if not exists shorts_events (
    id text primary key, card_id integer not null, version integer not null, text text not null,
    delivered integer not null default 0, lease integer not null default 0)`).run();
  await env.DB.prepare(`create table if not exists shorts_tickets (token text primary key, file_id text not null, expires integer not null)`).run();
}
async function swTicketValid(env,url) {
  const token=url.searchParams.get('ticket');if(!token||!/^[a-f0-9-]{36}$/.test(token))return false;
  const match=url.pathname.match(/^\/api\/shorts-workroom\/(\d+)\/files\/([^/]+)$/);if(!match)return false;
  await ensureShorts(env);
  const row=await env.DB.prepare('select t.file_id from shorts_tickets t join shorts_files f on f.id=t.file_id where t.token=? and t.file_id=? and f.card_id=? and t.expires>?')
    .bind(token,match[2],Number(match[1]),Date.now()).first();return !!row;
}
function swError(message, status=400) { return Object.assign(new Error(message), {status}); }
function swText(value, max=20000) { return String(value ?? '').trim().slice(0,max); }
function swInitial(product) {
  return {product:swText(product,100), stage:'source', assignee:'뮤즈', archived:false,
    sources:[], script:{draft_kr:'',draft_jp:'',final_kr:'',final_jp:'',confirmed:false},
    files:{}, littly_kr:'', littly_jp:'', render_status:'대기', outputs:{}, log:[]};
}
function swReady(c) {
  return ['source','narration_kr','narration_jp'].every(k=>c.files[k]?.id && c.files[k]?.synced)
    && /^\d+$/.test(c.littly_kr) && /^\d+$/.test(c.littly_jp);
}
function swLog(c, actor, text) {
  c.log.push({actor:swText(actor,40),text:swText(text,2000),at:new Date().toISOString()});
  c.log=c.log.slice(-100);
}
async function swRead(env,id) {
  const row=await env.DB.prepare('select * from shorts_cards where id=?').bind(id).first();
  if(!row) throw swError('card_not_found',404);
  return {...JSON.parse(row.data),id:row.id,version:row.version,updated_at:row.updated_at};
}
async function swFlush(env) {
  // Durable event -> normal room message -> existing Telegram outbox.
  // A stable marker makes retries idempotent even if the worker ends after postMessage.
  const rows=await env.DB.prepare('select * from shorts_events where delivered=0 and lease<? order by rowid limit 10').bind(Date.now()).all();
  for(const e of rows.results||[]) {
    const claim=await env.DB.prepare('update shorts_events set lease=? where id=? and delivered=0 and lease<?').bind(Date.now()+120000,e.id,Date.now()).run();
    if(!claim.meta?.changes)continue;
    const marker=`[숏츠카드:${e.id}]`;
    const exists=await env.DB.prepare('select id from messages where room_slug=? and content like ? limit 1').bind('shorts',`%${marker}%`).first();
    if(!exists) await postMessage(env,'shorts',{sender:'코덱스',content:e.text+'\n'+marker});
    await env.DB.prepare('update shorts_events set delivered=1 where id=?').bind(e.id).run();
  }
}
async function swSave(env,c,expected,notice='') {
  const id=c.id, version=expected+1, at=new Date().toISOString();
  const data={...c}; delete data.id;delete data.version;delete data.updated_at;
  const update=env.DB.prepare('update shorts_cards set data=?,version=?,updated_at=? where id=? and version=?')
    .bind(JSON.stringify(data),version,at,id,expected);
  let result;
  if(notice) {
    const text=`@${c.assignee} 숏츠 #${id} ${c.product}: ${notice}\nhttps://ai-team-room.oouuu2.workers.dev/shorts-workroom.html?card=${id}`;
    const results=await env.DB.batch([update,env.DB.prepare('insert or ignore into shorts_events(id,card_id,version,text) select ?,?,?,? where changes()=1').bind(`${id}-${version}`,id,version,text)]);
    result=results[0];
  } else result=await update.run();
  if(!result.meta?.changes) throw swError('version_conflict_reload',409);
  await swFlush(env);
  return swRead(env,id);
}
async function swMutation(env,c,b) {
  const actor=swText(b.actor||'참여자',40), action=b.action||'save';
  let notice='';
  if(action==='save') {
    if(b.product!==undefined){if(c.stage!=='source')throw swError('product_locked_after_source');c.product=swText(b.product,100);}
    if(!c.product)throw swError('product_required');
    if(b.sources!==undefined) {
      if(c.stage!=='source')throw swError('source_already_confirmed');
      if(!Array.isArray(b.sources)||b.sources.length>20)throw swError('sources_max_20');
      c.sources=b.sources.map(s=>{
        let u;try{u=new URL(s.url);}catch{throw swError('invalid_source_url');}
        if(!['http:','https:'].includes(u.protocol))throw swError('invalid_source_url');
        return {url:u.href,quality:swText(s.quality,80),review:['pass','fail','pending'].includes(s.review)?s.review:'pending',reason:swText(s.reason,1000),main:!!s.main};
      });
    }
    if(b.script!==undefined) {
      if(c.stage!=='script')throw swError('script_not_editable_at_this_stage');
      for(const k of ['draft_kr','draft_jp','final_kr','final_jp'])if(b.script[k]!==undefined)c.script[k]=swText(b.script[k]);
    }
    if(b.littly_kr!==undefined||b.littly_jp!==undefined) {
      if(!['source','script','narration'].includes(c.stage))throw swError('numbers_locked_for_render');
      for(const k of ['littly_kr','littly_jp'])if(b[k]!==undefined){c[k]=swText(b[k],10);if(c[k]&&!/^\d+$/.test(c[k]))throw swError('invalid_littly_number');}
    }
    if(b.outputs!==undefined) {
      for(const k of ['title_kr','title_jp','description_kr','description_jp','pinned_kr','pinned_jp','caption_kr','caption_jp','hashtags_kr','hashtags_jp','comment_kr','comment_jp','keyword_kr','keyword_jp'])if(b.outputs[k]!==undefined)c.outputs[k]=swText(b.outputs[k]);
    }
    if(b.render_status!==undefined) {
      if(c.stage!=='render'||!['대기','렌더 중','검수 중'].includes(b.render_status))throw swError('invalid_render_status');
      c.render_status=b.render_status;
    }
    if(b.note)swLog(c,actor,b.note);
  } else if(action==='confirm_source') {
    if(c.stage!=='source'||c.sources.filter(s=>s.main&&s.review==='pass').length!==1)throw swError('one_passed_main_source_required');
    c.stage='script';c.assignee='피클3';notice='소스 확정 · 대본 초안 차례';
  } else if(action==='submit_draft') {
    if(c.stage!=='script'||!c.script.draft_kr||!c.script.draft_jp)throw swError('both_drafts_required');
    c.assignee='클로드';notice='한·일 대본 초안 저장 · 검수 차례';
  } else if(action==='submit_final') {
    if(c.stage!=='script'||!c.script.final_kr||!c.script.final_jp)throw swError('both_final_scripts_required');
    c.assignee='똑똑이';notice='한·일 최종 대본 · 확정 후 녹음해 주세요';
  } else if(action==='confirm_script') {
    if(c.stage!=='script'||!c.script.final_kr||!c.script.final_jp)throw swError('both_final_scripts_required');
    c.script.confirmed=true;c.stage='narration';c.assignee='똑똑이';notice='대본 확정 · 나레이션 한·일과 소스 파일을 올려 주세요';
  } else if(action==='pc_synced') {
    for(const k of ['source','narration_kr','narration_jp'])if(b.files?.[k] && c.files[k]?.id===b.files[k].id){
      c.files[k].synced=true;c.files[k].pc_path=swText(b.files[k].path,500);
    }
    if(b.script_version===c.script.final_kr+'\n'+c.script.final_jp)c.script.pc_synced=true;
  } else if(action==='complete_render') {
    if(c.stage!=='render'||!c.files.video_kr?.id||!c.files.video_jp?.id)throw swError('both_finished_videos_required');
    c.stage='done';c.assignee='똑똑이';c.render_status='완료';notice='한·일 완성본 도착 · 미리보기 확인';
  } else if(action==='archive') {
    if(c.stage!=='done')throw swError('not_finished');c.archived=true;notice='업로드 완료로 보관';
  } else if(action==='cancel') {
    c.archived=true;swLog(c,actor,'제작 취소/검증용 카드 보관 (완료 처리 아님)');
  } else if(action==='rewind') {
    const stages=['source','script','narration','render','done'],i=stages.indexOf(c.stage);
    if(i<=0)throw swError('already_first_stage');
    c.stage=stages[i-1];c.archived=false;
    c.assignee={source:'뮤즈',script:'클로드',narration:'똑똑이',render:'클로드'}[c.stage];
    if(i<=2){c.script.confirmed=false;c.script.pc_synced=false;}
    // Prevent old sync flags / old results from silently advancing a revised card.
    if(c.stage==='narration')for(const f of Object.values(c.files))f.synced=false;
    if(i<=4){delete c.files.video_kr;delete c.files.video_jp;}
    notice='이전 단계로 되돌림 · '+swText(b.note||'수정 요청',500);
  } else throw swError('unknown_action');
  if(c.stage==='narration'&&c.script.confirmed&&c.script.pc_synced&&swReady(c)) {
    c.stage='render';c.assignee='클로드';c.render_status='대기';notice='재료·대본 PC 저장 완료 · 렌더 차례';
  }
  swLog(c,actor,action);
  return swSave(env,c,b.version,notice);
}
async function shortsApi(request,env,url) {
  try {
    await ensureShorts(env);
    const p=url.pathname.split('/').filter(Boolean).slice(2), method=request.method;
    if(!p.length&&method==='GET') {
      let cards=(await env.DB.prepare('select * from shorts_cards order by id desc limit 200').all()).results.map(r=>({...JSON.parse(r.data),id:r.id,version:r.version,updated_at:r.updated_at}));
      for(const k of ['stage','assignee'])if(url.searchParams.has(k))cards=cards.filter(c=>c[k]===url.searchParams.get(k));
      await swFlush(env);
      return json({ok:true,cards,storage_ready:!!env.SHORTS_FILES,max_file_size:SW_MAX_FILE,part_size:SW_PART});
    }
    if(!p.length&&method==='POST') {
      const b=await request.json(),c=swInitial(b.product);
      if(!c.product)throw swError('product_required');swLog(c,b.actor||'뮤즈','카드 생성');
      const r=await env.DB.prepare('insert into shorts_cards(data,updated_at) values(?,?)').bind(JSON.stringify(c),new Date().toISOString()).run();
      return json({ok:true,card:await swRead(env,r.meta.last_row_id)},201);
    }
    const id=Number(p[0]);if(!Number.isSafeInteger(id)||id<1)throw swError('invalid_card_id');
    const c=await swRead(env,id);
    if(p.length===1&&method==='GET')return json({ok:true,card:c});
    if(p.length===1&&method==='PATCH') {
      const b=await request.json();if(b.version!==c.version)throw swError('version_conflict_reload',409);
      return json({ok:true,card:await swMutation(env,c,b)});
    }
    if(p[1]!=='files')throw swError('not_found',404);
    if(!env.SHORTS_FILES)throw swError('R2_binding_SHORTS_FILES_required',503);
    if(p.length===2&&method==='POST') {
      const b=await request.json();
      if(!SW_SLOTS.includes(b.slot)||!Number.isSafeInteger(b.size)||b.size<1||b.size>SW_MAX_FILE)throw swError('invalid_slot_or_size');
      if(['source','narration_kr','narration_jp'].includes(b.slot)&&!['source','script','narration'].includes(c.stage))throw swError('rewind_before_replacing_material',409);
      if(!['source','narration_kr','narration_jp'].includes(b.slot)&&!['render','done'].includes(c.stage))throw swError('output_requires_render_stage',409);
      const fid=crypto.randomUUID(), key=`cards/${id}/${fid}`,name=swText(b.name,180).replace(/[\\/\x00-\x1f]/g,'_'),mime=swText(b.mime||'application/octet-stream',100);
      const validMime=b.slot==='source'||b.slot.startsWith('video_')?['video/mp4','video/webm','video/quicktime']:b.slot.startsWith('narration_')?['audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/mp4','audio/aac','audio/ogg','audio/webm']:b.slot.startsWith('thumbnail_')?['image/png','image/jpeg','image/webp']:['text/plain'];
      if(!validMime.includes(mime))throw swError('unsupported_file_type');
      const upload=await env.SHORTS_FILES.createMultipartUpload(key,{httpMetadata:{contentType:mime}});
      await env.DB.prepare('insert into shorts_files(id,card_id,slot,name,mime,size,object_key,upload_id,status,created_at) values(?,?,?,?,?,?,?,?,?,?)')
        .bind(fid,id,b.slot,name,mime,b.size,key,upload.uploadId,'uploading',new Date().toISOString()).run();
      return json({ok:true,id:fid,part_size:SW_PART},201);
    }
    const f=await env.DB.prepare('select * from shorts_files where id=? and card_id=?').bind(p[2]||'',id).first();
    if(!f)throw swError('file_not_found',404);
    if(p[3]==='ticket'&&method==='POST') {
      if(f.status!=='ready')throw swError('file_not_ready',409);
      const token=crypto.randomUUID();
      await env.DB.prepare('delete from shorts_tickets where expires<?').bind(Date.now()).run();
      await env.DB.prepare('insert into shorts_tickets(token,file_id,expires) values(?,?,?)').bind(token,f.id,Date.now()+30*60000).run();
      return json({ok:true,url:`/api/shorts-workroom/${id}/files/${f.id}?ticket=${token}`,expires_in:1800});
    }
    if(p.length===3&&method==='GET') {
      if(f.status!=='ready')throw swError('file_not_ready',409);
      const range=request.headers.get('range');
      if(range&&!/^bytes=\d*-\d*$/.test(range))throw swError('invalid_range',416);
      const obj=await env.SHORTS_FILES.get(f.object_key,range?{range:request.headers}:undefined);
      if(!obj)throw swError('object_not_found',404);
      const headers=new Headers({...CORS,'content-type':f.mime,'cache-control':'private, no-store','accept-ranges':'bytes','x-content-type-options':'nosniff',
        'content-disposition':`${/^(video\/|audio\/|image\/)/.test(f.mime)?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`});
      headers.set('etag',obj.httpEtag);
      if(obj.range) {const offset=obj.range.offset??Math.max(0,f.size-obj.range.suffix),length=obj.range.length??obj.range.suffix;headers.set('content-range',`bytes ${offset}-${offset+length-1}/${f.size}`);headers.set('content-length',String(length));}
      else headers.set('content-length',String(obj.size));
      return new Response(obj.body,{status:obj.range?206:200,headers});
    }
    if(p[3]==='part'&&method==='POST') {
      if(f.status!=='uploading')throw swError('upload_not_open',409);
      const n=Number(url.searchParams.get('number')),total=Math.ceil(f.size/SW_PART);
      if(!Number.isInteger(n)||n<1||n>total)throw swError('invalid_part');
      const expected=n===total?f.size-SW_PART*(n-1):SW_PART;
      const reader=request.body?.getReader();if(!reader)throw swError('empty_part');
      const chunks=[];let received=0;
      for(;;){const {done,value}=await reader.read();if(done)break;received+=value.byteLength;if(received>expected){await reader.cancel();throw swError('part_size_mismatch');}chunks.push(value);}
      const bytes=new Uint8Array(received);let pos=0;for(const chunk of chunks){bytes.set(chunk,pos);pos+=chunk.byteLength;}
      if(bytes.byteLength!==expected)throw swError('part_size_mismatch');
      const upload=env.SHORTS_FILES.resumeMultipartUpload(f.object_key,f.upload_id);
      const part=await upload.uploadPart(n,bytes);
      // Sequential upload clients; each part updates its JSON path atomically.
      await env.DB.prepare("update shorts_files set parts=json_set(parts, ?, ?) where id=?").bind(`$.\"${n}\"`,part.etag,f.id).run();
      return json({ok:true,part:n});
    }
    if(p[3]==='complete'&&method==='POST') {
      if(f.status==='uploading') {
        const parts=JSON.parse(f.parts),total=Math.ceil(f.size/SW_PART);
        if(Object.keys(parts).length!==total)throw swError('missing_parts');
        await env.SHORTS_FILES.resumeMultipartUpload(f.object_key,f.upload_id).complete(Array.from({length:total},(_,i)=>({partNumber:i+1,etag:parts[i+1]})));
        const head=await env.SHORTS_FILES.head(f.object_key);if(!head||head.size!==f.size)throw swError('uploaded_size_mismatch',409);
        await env.DB.prepare("update shorts_files set status='ready' where id=?").bind(f.id).run();
      }
      const fresh=await swRead(env,id);
      if(fresh.files[f.slot]?.id===f.id)return json({ok:true,card:fresh});
      if(['source','narration_kr','narration_jp'].includes(f.slot)&&!['source','script','narration'].includes(fresh.stage))throw swError('rewind_before_replacing_material',409);
      fresh.files[f.slot]={id:f.id,name:f.name,mime:f.mime,size:f.size,url:`/api/shorts-workroom/${id}/files/${f.id}`,synced:false};
      let notice='';
      if(f.slot.startsWith('video_')&&fresh.stage==='done'){fresh.stage='render';fresh.assignee='클로드';fresh.render_status='검수 중';fresh.archived=false;notice='완성본 교체 · 다시 검수해 주세요';}
      swLog(fresh,'파일 업로드',f.slot+': '+f.name);
      return json({ok:true,card:await swSave(env,fresh,fresh.version,notice)});
    }
    throw swError('not_found',404);
  }catch(e){if(e.status)return json({ok:false,error:e.message},e.status);throw e;}
}


export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runChair(env).catch((err) => console.error('[chair]', err && err.message ? err.message : err)).then(() => flushTelegram(env))
    );
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/telegram/webhook') {
      try { return await telegramWebhook(request, env); }
      catch { return json({ ok: false, error: 'telegram_webhook_failed' }, 500); }
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        const response = await handleApi(request, env, url);
        if (['POST','PATCH'].includes(request.method)) ctx?.waitUntil(flushTelegram(env));
        return response;
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
