# GitHub 브릿지 (bridge/)

피클·뮤즈 같은 폰 AI가 PC 작업을 시키는 통로입니다.
Claude Code가 PC에서 돌아가면서 이 repo의 명령 파일을 읽어 실행하고,
결과를 다시 이 repo에 올립니다.

## 동작 방식

1. **명령 넣기**: `bridge/inbox/`에 `.md` 파일로 할 일을 적어 push합니다.
   (파일명 예: `0002-냉장고-재렌더.md`)
2. **실행**: PC의 Claude Code(`watch.sh`)가 60초마다 repo를 확인해 새 명령을 실행합니다.
3. **결과 확인**: `bridge/results/`에 `<파일명>.result.md`로 결과가 올라옵니다.
4. **정리**: 실행이 끝난 명령 파일은 `bridge/done/`으로 이동합니다.

## PC 설치 단계 (똑똑이님 PC에서 한 번만)

1. **Node.js 18 이상 설치**: https://nodejs.org (LTS 버전으로 설치)
2. **Claude Code 설치** (터미널·명령 프롬프트에서):
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```
3. **로그인**:
   ```bash
   claude
   ```
   → Pro 계정으로 로그인합니다. 유료 구독에 포함돼 있어 추가 요금은 없습니다.
   (단, Pro 주간 사용량 한도는 그대로 적용됩니다.)
4. **repo 클론**:
   ```bash
   git clone https://github.com/oouuu2-dot/ai-team-room.git
   cd ai-team-room
   ```
5. **감시 스크립트 실행**:
   ```bash
   bash bridge/watch.sh
   ```
   → 60초마다 inbox를 확인합니다. 종료는 `Ctrl+C`.
   → 백그라운드로 계속 돌리려면:
   ```bash
   nohup bash bridge/watch.sh > bridge/watch.log 2>&1 &
   ```
   → Windows면 Git Bash에서 실행하거나 WSL을 쓰세요.

## 명령 파일 형식

- **위치**: `bridge/inbox/` 안에 `.md` 파일로 만듭니다.
- **파일명**: `0001-할일-요약.md` (앞 숫자 순으로 관리합니다.)
- **본문**: 할 일을 한국어로 구체적으로 적습니다. 한 파일 = 한 작업입니다.
- Claude Code는 본문 내용을 그대로 실행합니다. 경로나 파일명을 정확히 적어주세요.

예 (`bridge/inbox/0001-test.md`):
```text
bridge 연결 테스트입니다. 현재 날짜와 시간을 알려줘.
```

## 안전 주의 — 꼭 읽어주세요

- **명령 파일은 이 repo에 push할 수 있는 사람(소유자)만 작성하세요.**
  Claude Code가 PC에서 명령을 그대로 실행하기 때문에,
  모르는 사람이 넣은 명령이 실행되면 위험합니다.
- 파일 삭제·포맷·계정 정보·결제 같은 위험한 명령은 넣지 마세요.
- PC의 중요한 파일은 미리 백업해 두세요.
- 처음엔 `0001-test.md` 같은 무해한 명령으로 연결을 테스트하세요.
