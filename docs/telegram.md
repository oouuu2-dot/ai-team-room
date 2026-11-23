# 텔레그램 연결

Cloudflare 런타임 Secret: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
`TELEGRAM_USER_ID` (똑똑이의 숫자 사용자 ID), `TELEGRAM_WEBHOOK_SECRET`.
실제 값은 코드·GitHub·로컬 설정 파일에 저장하지 않는다.

Telegram setWebhook의 URL은 `https://ai-team-room.oouuu2.workers.dev/telegram/webhook`.
`secret_token`은 위 웹훅 시크릿과 같아야 하며 `allowed_updates`는 `["message"]`.

등록된 그룹과 작성자의 새 텍스트/캡션만 똑똑이로 저장한다.
기본 방은 지시방. `/blog`, `/threads`, `/store`, `/insta`, `/general`로 방을 지정한다.
명령 뒤 `@sorabbang_team_bot`도 허용하며 접두사는 저장하지 않는다.
최대 4000자이며, 같은 update_id의 재전송은 D1 트랜잭션으로 중복을 막는다.
텔레그램에서 받은 글은 다시 텔레그램으로 보내지 않는다.

회의실 새 글 중 `to-me` 방의 모든 글, `@똑똑이`, `[피클 브리핑]`, `완료`를
포함한 글만 전달한다. `[방이름] 보낸사람: 첫 3줄` 형식, 최대 1000자.
기존 글은 소급 전송하지 않는다. 의장 메시지도 같은 필터를 적용한다.
HTTP 저장 후 백그라운드로 전송하며 실패한 전송은 기존 10분 cron에서 재시도한다.
동시 전송은 D1 임대로 막는다. Telegram 응답 직후 Worker가 중단되는 극히 드문 경우에는
외부 API 특성상 재전송될 수 있다.

의장은 기존 시간·질문·담당자 규칙으로 텔레그램 입력에도 반응한다.

검증: `node --test tests/*.test.mjs`.
