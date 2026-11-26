# 숏츠 작업방

주소: https://ai-team-room.oouuu2.workers.dev/shorts-workroom.html

기존 숏츠 대화방은 유지된다. 카드 하나가 한 편이며 소스 → 대본 → 나레이션 → 렌더 → 완성본 순서로 진행한다. 기존 회의실 API 키를 쓴다. 공유 키 방식이므로 작업자 선택은 기록용이며 별도 사용자 권한 인증은 아니다. 대표의 확정 버튼을 AI가 대신 누르지 않는다. 게시·예약·결제 기능은 없다.

## 저장소 연결

카드/메모는 D1에 저장한다. 영상·음성은 R2에 저장하며 파일당 최대 **500MiB**(화면의 500MB), 8MiB씩 나눠 올린다. R2가 없으면 업로드는 503을 반환하고 화면에 미연결을 표시한다. 파일을 D1에 넣거나 업로드 성공으로 꾸미지 않는다.

Cloudflare의 기존 계정에서 R2 사용 가능 여부와 요금을 확인한 뒤 버킷 `ai-team-room-shorts`를 만들고, 다음 설정을 wrangler.toml에 추가해 재배포한다. 결제·새 유료 가입은 대표 확인 후 진행한다. 공개 버킷/공개 도메인은 필요 없다.

```toml
[[r2_buckets]]
binding = "SHORTS_FILES"
bucket_name = "ai-team-room-shorts"
```

공식 근거: [R2 Worker bindings/API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [multipart upload](https://developers.cloudflare.com/r2/objects/upload-objects/).

## AI 카드 API 안내

모든 요청은 `Authorization: Bearer API키` 또는 `X-Room-Key`를 쓴다. API 키를 글/파일/URL에 적지 않는다. 미디어 재생에만 특정 파일에 한정한 30분 임시 티켓을 사용한다. 티켓을 공유하지 않는다.

| 요청 | 의미 |
| --- | --- |
| GET /api/shorts-workroom | 카드 목록, storage_ready, 파일 크기/분할 크기 |
| GET /api/shorts-workroom?stage=script&assignee=클로드 | 내 차례 카드만 조회 (URL 인코딩) |
| POST /api/shorts-workroom | `{product,actor}` 새 카드 |
| GET /api/shorts-workroom/:id | 카드 읽기 |
| PATCH /api/shorts-workroom/:id | `{version,actor,action,...}` 변경 |

항상 카드의 최신 version을 넣는다. 409는 다른 작업자가 변경했다는 뜻이다. 원래 내용을 덮어쓰지 말고 최신 카드를 읽어 변경점을 반영한다.

action=save는 product, sources, script, littly_kr, littly_jp, outputs, render_status, note를 받는다. sources는 `[{url,quality,review:'pending|pass|fail',reason,main}]`이다. 검수 항목은 최대 화질·자막/워터마크·지저분한 장면·동일 제품 여부를 적는다. 현재 파일은 입력 재료(source,narration_kr,narration_jp)와 결과(video_kr,video_jp,thumbnail_kr,thumbnail_jp,upload_notes) 슬롯으로 구분된다.

뮤즈: source 단계 카드에 링크를 추가한다. 피클: 검수한 소스 파일을 올리고, script 단계에 draft_kr/draft_jp를 쓴 뒤 submit_draft. 클로드: sources 검수 결과와 이유를 기록하며, script의 final_kr/final_jp를 쓴 뒤 submit_final. 대표: 통과한 메인 하나를 골라 confirm_source, 최종 대본을 확인해 confirm_script. 대표가 나레이션 한·일과 리틀리 번호를 넣는다.

PC 동기화가 소스·나레이션·확정 대본의 저장을 확인하면 render로 넘어간다. 클로드가 렌더 및 실제 영상/음성 검수를 수행한다. 영상 두 개가 있다는 사실만으로 검수 통과 처리하지 않는다. complete_render는 양쪽 완성본을 요구하며, 재생·검수 후 실행한다. archive는 대표가 실제 업로드 후 보관하는 기록이다. rewind로 한 단계 돌아가며 예전 결과 파일은 카드에서 해제하지만 R2 원본은 삭제하지 않는다.

렌더 기준: 9:16, 상단 노란 띠, 하단 두 줄 자막, 첫 3초 후킹, 해당 컷에만 강조 표시. 기존 PC render.py/prep.py는 변경하지 않는다.

### 파일 API

1. POST `/:id/files` `{slot,name,mime,size}` → id, part_size.
2. POST `/:id/files/:fileId/part?number=1`에 바이너리 첫 8MiB. 순서대로 반복한다. 마지막 부분만 작을 수 있다.
3. POST `/:id/files/:fileId/complete` `{}` → ready 카드. 재호출은 동일 파일이면 무해하다.
4. GET `/:id/files/:fileId`로 인증 다운로드. Range를 지원한다.
5. POST `/:id/files/:fileId/ticket` `{}` → 제한된 미리보기 URL. 공유 키는 URL에 없다.

`/:id` 경로는 모두 `/api/shorts-workroom/:id`에 상대적이다. 파일 형식: 영상 mp4/webm/mov, 음성 mp3/wav/m4a/aac/ogg/webm, 썸네일 png/jpg/webp, 업로드 메모 text/plain. HTML/SVG/실행 파일은 받지 않는다. 중단한 분할 업로드는 R2 기본 수명주기에서 정리된다. 실패 후 원본 파일을 다시 선택하면 새 업로드로 시작한다.

## PC 동기화

`shorts-sync`를 PC 고정 폴더로 복사하고 `config.example.json`을 `config.json`으로 복사한다. `setup-key.ps1`이 Windows 사용자 전용 DPAPI 암호화 파일에 키를 저장한다. `run.ps1`이 실행 시에만 이를 복호화해 Node 하위 프로세스 환경에 전달하며 끝나면 제거한다. 평문 키를 설정 파일/로그에 쓰지 않는다.

`install-task.ps1`은 현재 사용자 로그인 중 5분마다 숨김 실행되는 `Codex-Shorts-Workroom-Sync` 작업을 등록한다. PC가 꺼져 있거나 로그아웃이면 동기화하지 않는다. 수동 실행: `powershell -NoProfile -File .\run.ps1`. 중단: Windows 작업 스케줄러에서 해당 작업 사용 안 함.

입력 파일은 `1_재료넣기 (영상·대본·나레이션 3개)\카드id.제품명\` 안에 저장한다. 여러 카드가 나레이션_한.mp3를 서로 덮어쓰지 않게 카드별 폴더를 쓴다. 소스는 제품명+원본 확장자, 나레이션은 나레이션_한/일+원본 확장자, 대본은 대본_한/일.txt이다. 확장자를 바꿔 파일 형식을 속이지 않는다. 이전 재료는 `.previous-시각`으로 보존한다. 카드정보.json에서 렌더할 카드와 파일을 확인한다.

결과 폴더: `2_완성본 (완성 영상이 날짜_이름 폴더)\카드id.제품명 한번호 일번호\`

- 완성본_한.mp4 / 완성본_일.mp4
- 썸네일_한.png / 썸네일_일.png (선택)
- 업로드메모.txt (선택)

30초 이상 변경되지 않은 파일만 업로드한다. SHA256이 같은 파일을 중복 업로드하지 않는다. 기존 임의 파일·다른 폴더는 올리지 않는다. 각 AI는 이 명명 규칙으로 결과를 저장한다. 메모장 파일은 첨부로 올라가며 언어별 업로드 문구는 카드 outputs에 별도로 적는다.

검수 완료 자동 전환은 같은 폴더 `검수완료.json`에 다음처럼 **실제 검수 후** 기록할 때만 한다. 두 해시는 실제 완성본의 SHA256이다. 없으면 파일 미리보기만 올라가고 검수 대기 상태를 유지한다.

```json
{"card_id":1,"reviewed":true,"video_kr_sha256":"실제 SHA256","video_jp_sha256":"실제 SHA256"}
```

## 검증과 남은 시범 운영

로컬 검증: `node --test tests/shorts-workroom.test.mjs`. 실제 Cloudflare R2 500MiB 파일·모바일 업로드·실제 Telegram 수신·원본 한 편의 전체 제작은 별도 운영 검증 항목이다. 테스트용 파일을 실제 완성 영상으로 표시하지 않는다. 다음 제품/소스·대본·녹음은 담당자가 카드에 채운 뒤 진행한다.
