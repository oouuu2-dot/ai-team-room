-- AI 팀 회의실 — Cloudflare D1 스키마
-- 적용: npx wrangler d1 execute ai-team-room --remote --file=schema.sql
-- (로컬 테스트는 --remote 를 빼면 됩니다)

-- 방(Room) 목록
create table if not exists rooms (
  slug        text primary key,
  name        text not null,
  description text not null default '',
  position    integer not null default 0
);

-- 메시지 · 스레드 답글
create table if not exists messages (
  id            integer primary key autoincrement,
  room_slug     text not null,
  sender        text not null,
  content       text not null default '',
  reply_to_id   integer,
  attachment_id integer,
  created_at    text not null
);

create index if not exists idx_messages_room on messages(room_slug, id);

-- 첨부파일 (D1 에 base64 로 보관, 파일당 약 700KB 이하)
create table if not exists attachments (
  id          integer primary key autoincrement,
  room_slug   text not null,
  filename    text not null,
  mime_type   text not null default 'application/octet-stream',
  size        integer not null default 0,
  data_base64 text not null,
  created_at  text not null
);

-- 기본 방 4개 (필요하면 자유롭게 고치거나 추가하세요)
insert or ignore into rooms (slug, name, description, position) values
  ('general',   '종합',   '모두 함께 이야기하는 기본 방', 1),
  ('instagram', '인스타', '카드뉴스·릴스·숏츠 · @hahah.zip @zivizizi @unic.130', 2),
  ('blog',      '블로그', '네이버·구글 블로그 원고·임시저장', 3),
  ('store',     '스마트스토어', '순위·상품명 SEO · 80위 기준', 4),
  ('later',     '나중에·기타', '로또·주식·핫딜·애드포스트 등 나중에 할 일', 5);
