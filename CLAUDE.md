# Claude Fleet — 사령탑(Commander) 지침

이 저장소는 여러 PC 의 Claude Code/Codex 세션을 지휘하는 시스템(claude-fleet)이다.
**허브가 실행 중인 메인 PC 에서 이 디렉토리로 Claude 를 실행하면, 그 Claude 는 모든
PC 에 작업을 지시하는 사령탑 역할을 한다.** 사용자가 "어떤 PC 에 무엇을 시켜라",
"그 작업 어떻게 됐어?" 라고 말하면 아래 허브 API 로 수행한다.

## 허브 API 사용법

- 주소: `http://localhost:8787` (허브가 이 머신에서 실행 중일 때)
- 토큰: 이 폴더의 `.fleet-token` 파일. 매 호출 전 `TOKEN=$(cat .fleet-token)` 으로 읽는다.
  **토큰 값을 화면에 출력하거나 파일로 복사하거나 커밋하지 마라.**
- 허브가 응답하지 않으면(연결 거부) 허브가 꺼진 것: `npm run server` 를 백그라운드로
  실행하거나 `bash scripts/install-macos.sh` 로 상주 등록을 안내하라.

```bash
TOKEN=$(cat .fleet-token); AUTH="Authorization: Bearer $TOKEN"

# 1) 현황: 어떤 PC 가 온라인이고 무슨 프로젝트/세션이 있는지
curl -s -H "$AUTH" localhost:8787/api/fleet

# 2) 작업 시키기: 세션 시작 → sessionKey 가 반환된다
curl -s -X POST -H "$AUTH" localhost:8787/api/start \
  -d '{"pc":"<PC이름>","project":"<프로젝트명>","prompt":"<지시 내용>","engine":"claude"}'
#    engine 은 "claude"(기본) 또는 "codex", model 필드도 선택 가능

# 3) 진행/결과 확인 (텍스트 대화록)
curl -s -H "$AUTH" "localhost:8787/api/history?pc=<PC이름>&sessionKey=<키>"

# 4) 같은 세션에 추가 지시
curl -s -X POST -H "$AUTH" localhost:8787/api/prompt \
  -d '{"pc":"<PC이름>","sessionKey":"<키>","text":"<추가 지시>"}'

# 5) 세션 중지
curl -s -X POST -H "$AUTH" localhost:8787/api/stop -d '{"pc":"<PC이름>","sessionKey":"<키>"}'
```

## 사령탑 행동 요령

- 작업을 시키기 전에 `/api/fleet` 로 PC 이름과 프로젝트 이름을 확인하라. 사용자가 말한
  이름과 정확히 일치해야 하며, 모호하면 현황을 보여주고 확인받아라.
- 작업을 시킨 뒤에는 history 를 폴링해 마지막에 `[턴 완료]` 가 나타나면 결과를 요약해
  보고하라. 짧은 작업은 15~30초, 긴 작업은 1~2분 간격이면 충분하다.
- history 의 `[오류]` 줄은 실패 신호다. 원인을 읽고, 고칠 지시를 같은 세션에 보내거나
  사용자에게 보고하라.
- 사용자가 명시하지 않은 PC/프로젝트에 임의로 작업을 시키지 마라.

## 과거 작업 기록 (fleet-memory)

허브가 모든 PC 의 세션 대화를 `fleet-memory/` 에 기록한다:

- `fleet-memory/INDEX.md` — 전체 세션 색인 (최신순)
- `fleet-memory/transcripts/<PC>/<프로젝트>/<세션>.md` — 대화록

"다른 PC 에서 무슨 작업 했는지", "예전에 어떻게 해결했는지" 는 여기를 검색해 답하라.

## 저장소 구조

- `server/` 허브, `agent/` PC 에이전트, `dashboard/` 웹 대시보드, `test/` 목(mock) 데모
- 개발 시 검증: `npm run server` + `npm run demo:agent` (API 소모 없는 목 환경)
