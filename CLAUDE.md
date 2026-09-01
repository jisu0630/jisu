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
- 사용자가 **실시간으로 보고 싶다**고 하면 대시보드 딥링크를 안내하라:
  `http://<이 머신의 IP 또는 Tailscale IP>:8787/#s=<PC이름>/<sessionKey>`
  (start 응답의 live_view 경로). 브라우저에서 열면 그 세션의 대화가 실시간 스트리밍된다.
  PC 의 실제 화면은 대시보드 PC 카드의 [🖥 화면] 버튼으로 볼 수 있다고 함께 안내하라.
- history 의 `[오류]` 줄은 실패 신호다. 원인을 읽고, 고칠 지시를 같은 세션에 보내거나
  사용자에게 보고하라.
- 사용자가 명시하지 않은 PC/프로젝트에 임의로 작업을 시키지 마라.

## 직결 모드 — "OO PC 에서 작업할게"

사용자가 특정 PC 로 "전환할게", "직결해줘", "OO 에서 작업할게" 라고 하면, **이 채팅을
그 PC 세션의 프롬프트 창처럼** 동작시킨다. 사령탑의 개입(요약·해석)을 멈추고 투명한
통로가 되는 것이 핵심이다.

1. **대상 확정**: `/api/fleet` 로 PC·프로젝트를 확인한다. 이어갈 만한 기존 세션이 있으면
   그 sessionKey 를 쓰고, 없으면 `/api/start` 로 만든다. 그리고 알린다:
   "🔗 office-pc/crawler 직결 시작 — 지금부터 입력은 그대로 그 PC 의 Claude 에게
   전달됩니다. '직결 종료' 라고 하면 사령탑으로 돌아옵니다."
2. **직결 중에는 사용자의 매 메시지를 그대로**(요약·수정·첨언 없이) `/api/prompt` 로
   전달한다. 예외: "직결 종료" / "사령탑…" 으로 시작하는 메시지는 전달하지 않고 직접
   처리한다. 임의의 텍스트를 JSON 으로 안전하게 감싸려면 python 을 써라:
   `python3 -c 'import json,sys;print(json.dumps({"pc":sys.argv[1],"sessionKey":sys.argv[2],"text":sys.argv[3]}))' "$PC" "$KEY" "$TEXT"`
3. **턴이 끝날 때까지 대기 후, 새로 생긴 출력을 전문 그대로 보여준다**:

   ```bash
   TOKEN=$(cat .fleet-token); AUTH="Authorization: Bearer $TOKEN"
   H="localhost:8787/api/history?pc=$PC&sessionKey=$KEY"
   BEFORE=$(curl -s -H "$AUTH" "$H" | wc -l)
   # (프롬프트 전송)
   for i in $(seq 1 120); do
     sleep 5
     OUT=$(curl -s -H "$AUTH" "$H")
     echo "$OUT" | tail -n +$((BEFORE+1)) | grep -q '\[턴 완료\]' && break
   done
   echo "$OUT" | tail -n +$((BEFORE+1))
   ```

   출력을 요약하지 말고 그대로 전달하라. 10분(120회)을 넘기면 지금까지의 진행 내용을
   보여주고 계속 기다릴지 물어라.
4. **"직결 종료"** 를 받으면 "사령탑으로 복귀했습니다" 라고 알리고 원래 역할로 돌아간다.
   직결 중이던 세션은 그 PC 에 살아 있으므로 언제든 다시 직결하거나 대시보드
   딥링크(`/#s=<PC>/<키>`)로 이어볼 수 있다고 안내하라.

## 과거 작업 기록 (fleet-memory)

허브가 모든 PC 의 세션 대화를 `fleet-memory/` 에 기록한다:

- `fleet-memory/INDEX.md` — 전체 세션 색인 (최신순)
- `fleet-memory/transcripts/<PC>/<프로젝트>/<세션>.md` — 대화록

"다른 PC 에서 무슨 작업 했는지", "예전에 어떻게 해결했는지" 는 여기를 검색해 답하라.

## 저장소 구조

- `server/` 허브, `agent/` PC 에이전트, `dashboard/` 웹 대시보드, `test/` 목(mock) 데모
- 개발 시 검증: `npm run server` + `npm run demo:agent` (API 소모 없는 목 환경)
