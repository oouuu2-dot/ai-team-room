#!/usr/bin/env bash
# bridge/watch.sh
# GitHub 브릿지 폴링 스크립트 — Claude Code가 PC에서 실행합니다.
# bridge/inbox/의 명령(.md)을 읽어 Claude Code로 실행하고,
# 결과를 bridge/results/에 올린 뒤 명령을 bridge/done/으로 옮깁니다.
#
# 실행: bash bridge/watch.sh   (repo 루트에서, 종료는 Ctrl+C)
# 폴링 간격 변경: BRIDGE_INTERVAL=120 bash bridge/watch.sh
# 명령 실행 시간 제한 변경: BRIDGE_TIMEOUT=3600 bash bridge/watch.sh
set -u

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INBOX_DIR="$REPO_DIR/bridge/inbox"
RESULTS_DIR="$REPO_DIR/bridge/results"
DONE_DIR="$REPO_DIR/bridge/done"
LOCK_FILE="$REPO_DIR/bridge/.watch.lock"
INTERVAL="${BRIDGE_INTERVAL:-60}"
TIMEOUT_SEC="${BRIDGE_TIMEOUT:-1800}"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

# --- 중복 실행 방지 (lockfile + PID) ---
if [ -f "$LOCK_FILE" ]; then
  OLD_PID="$(cat "$LOCK_FILE" 2>/dev/null || echo "")"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    log "이미 실행 중입니다 (PID $OLD_PID). 종료합니다."
    exit 0
  fi
  log "오래된 lockfile을 제거합니다 (PID ${OLD_PID:-없음})."
  rm -f "$LOCK_FILE"
fi
echo "$$" > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

mkdir -p "$INBOX_DIR" "$RESULTS_DIR" "$DONE_DIR"

log "bridge 감시 시작 (repo: $REPO_DIR, 간격: ${INTERVAL}초)"

while true; do
  # --- claude CLI 확인 ---
  if ! command -v claude >/dev/null 2>&1; then
    log "Claude Code CLI(claude)가 없습니다."
    log "설치: npm install -g @anthropic-ai/claude-code"
    log "그 다음: claude 를 실행해서 Pro 계정으로 로그인하세요."
    log "${INTERVAL}초 뒤 다시 확인합니다."
    sleep "$INTERVAL"
    continue
  fi

  # --- 최신 명령 가져오기 ---
  if ! git -C "$REPO_DIR" pull --rebase --quiet 2>/dev/null; then
    log "git pull 실패 — 다음 주기에 다시 시도합니다."
    sleep "$INTERVAL"
    continue
  fi

  # --- 미처리 명령 찾기 ---
  mapfile -t COMMANDS < <(find "$INBOX_DIR" -maxdepth 1 -name '*.md' -type f 2>/dev/null | sort)

  if [ "${#COMMANDS[@]}" -eq 0 ]; then
    # 빈 inbox면 조용히 대기
    sleep "$INTERVAL"
    continue
  fi

  for CMD_FILE in "${COMMANDS[@]}"; do
    NAME="$(basename "$CMD_FILE" .md)"
    RESULT_FILE="$RESULTS_DIR/${NAME}.result.md"

    log "명령 실행 중: $NAME"

    PROMPT="$(cat "$CMD_FILE")"

    # Claude Code로 실행 (print 모드, 비대화형). 시간 제한을 둬서 무한 대기를 막는다.
    if command -v timeout >/dev/null 2>&1; then
      OUTPUT="$(timeout "$TIMEOUT_SEC" claude -p "$PROMPT" 2>&1)"
      STATUS=$?
    else
      OUTPUT="$(claude -p "$PROMPT" 2>&1)"
      STATUS=$?
    fi

    {
      echo "# 결과: $NAME"
      echo
      echo "- 실행 시각: $(date '+%Y-%m-%d %H:%M:%S')"
      echo "- 종료 코드: $STATUS"
      echo
      echo "## 명령"
      echo
      echo "$PROMPT"
      echo
      echo "## 출력"
      echo
      echo "$OUTPUT"
    } > "$RESULT_FILE"

    # 처리한 명령은 done/으로 이동 (실패해도 이동 — 같은 명령을 무한 반복하지 않는다)
    mv "$CMD_FILE" "$DONE_DIR/${NAME}.md"

    # 결과 + 이동 기록을 push
    git -C "$REPO_DIR" add bridge/results bridge/done 2>/dev/null
    git -C "$REPO_DIR" commit -m "bridge: $NAME 실행 완료 (종료 코드 $STATUS)" --quiet 2>/dev/null
    if ! git -C "$REPO_DIR" push --quiet 2>/dev/null; then
      log "git push 실패 — 다음 주기에 다시 시도합니다."
    else
      log "완료: $NAME (결과: bridge/results/${NAME}.result.md)"
    fi
  done

  sleep "$INTERVAL"
done
