"""Gemini 회의실 봇 — Gemini가 AI 팀 회의실에 상주하며 답글을 답니다.

실행: GitHub Actions(10분마다) 또는 PC에서 직접 실행.
필요한 환경 변수:
  GEMINI_API_KEY — Google AI Studio에서 발급 (무료 티어 가능)
  ROOM_KEY       — 회의실 API 키
  GEMINI_MODEL   — (선택) 기본값 gemini-2.0-flash

동작:
  - 7개 방의 최근 메시지를 읽는다.
  - 최근 15분 안에 올라왔고, Gemini를 부르는(@Gemini / 재미니 / [Gemini])
    메시지 중 Gemini가 아직 답하지 않은 것만 골라 답한다.
  - 답은 요약만, 5줄 이내, 한국어로.
  - 한 번 실행에 최대 3건까지만 답한다 (API 사용량·스팸 방지).
"""
import os
import sys
from datetime import datetime, timezone

import requests

ROOM_BASE = "https://ai-team-room.oouuu2.workers.dev"
ROOMS = ["general", "orders", "instagram", "blog", "store", "threads", "to-me"]
MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
LOOKBACK_SECONDS = 15 * 60
MAX_REPLIES_PER_RUN = 3
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"}
CALL_WORDS = ["@gemini", "gemini", "재미니", "재미나", "[gemini]"]

SYSTEM = (
    "너는 AI 팀 회의실의 'Gemini'(재미니)야. 빠른 리서치·상위노출 분석 담당이야. "
    "한국어로 답해. 요약만, 5줄 이내로 짧게. 확정이 안 된 건 '검증 전'이라고 밝혀."
)


def parse_time(s):
    try:
        return datetime.fromisoformat((s or "").replace("Z", "+00:00"))
    except Exception:
        return None


def room_get(slug, key, limit=30):
    r = requests.get(
        f"{ROOM_BASE}/api/rooms/{slug}/messages",
        params={"limit": limit, "key": key}, headers=UA, timeout=30,
    )
    r.raise_for_status()
    return r.json().get("messages", [])


def room_post(slug, key, content, reply_to_id=None):
    body = {"sender": "Gemini", "content": content}
    if reply_to_id:
        body["reply_to_id"] = reply_to_id
    r = requests.post(
        f"{ROOM_BASE}/api/rooms/{slug}/messages",
        params={"key": key}, json=body, headers=UA, timeout=30,
    )
    r.raise_for_status()
    return r.json()


def calls_gemini(content):
    low = (content or "").lower()
    return any(w in low for w in CALL_WORDS)


def gemini_reply(api_key, room, sender, content):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    prompt = (
        f"{SYSTEM}\n\n"
        f"[방: {room}]\n"
        f"{sender}: {content}\n\n"
        "위 메시지에 답해줘. 답은 요약만, 5줄 이내, 한국어."
    )
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"maxOutputTokens": 600, "temperature": 0.7},
    }
    r = requests.post(url, params={"key": api_key}, json=payload, timeout=60)
    r.raise_for_status()
    data = r.json()
    return data["candidates"][0]["content"]["parts"][0]["text"].strip()


def main():
    room_key = os.environ.get("ROOM_KEY")
    api_key = os.environ.get("GEMINI_API_KEY")
    if not room_key or not api_key:
        print("ROOM_KEY or GEMINI_API_KEY missing")
        return 1
    now = datetime.now(timezone.utc)
    replied = 0
    for slug in ROOMS:
        if replied >= MAX_REPLIES_PER_RUN:
            break
        try:
            msgs = room_get(slug, room_key)
        except Exception as e:
            print(f"[{slug}] read failed: {e}")
            continue
        replied_to = {
            m.get("reply_to_id")
            for m in msgs
            if m.get("sender") == "Gemini" and m.get("reply_to_id")
        }
        for m in msgs:
            if replied >= MAX_REPLIES_PER_RUN:
                break
            if m.get("sender") == "Gemini":
                continue
            if m.get("id") in replied_to:
                continue
            created = parse_time(m.get("created_at") or "")
            if created is None or (now - created).total_seconds() > LOOKBACK_SECONDS:
                continue
            if not calls_gemini(m.get("content", "")):
                continue
            try:
                text = gemini_reply(api_key, slug, m.get("sender", "?"), m.get("content", ""))
            except Exception as e:
                print(f"[{slug}] gemini failed for msg {m.get('id')}: {e}")
                continue
            try:
                room_post(slug, room_key, text, reply_to_id=m.get("id"))
                print(f"[{slug}] replied to msg {m.get('id')}")
                replied += 1
            except Exception as e:
                print(f"[{slug}] post failed for msg {m.get('id')}: {e}")
    print(f"done, replied={replied}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
