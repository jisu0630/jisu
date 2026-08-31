# Claude Fleet

여러 PC에서 돌아가는 여러 프로젝트의 Claude Code 세션을 **웹 브라우저 한 화면에서 실시간으로 모니터링하고, 프롬프트를 직접 입력**할 수 있는 시스템입니다.

```
[PC 1: agent] ──┐
[PC 2: agent] ──┼─ ws ──> [허브 서버 (server/)] <── ws ── [브라우저 대시보드 (dashboard/)]
[PC 3: agent] ──┘
```

- **허브(server/)** — 항상 켜져 있는 머신 1대(집 서버, NAS, 클라우드 VM 등)에서 실행. 대시보드 HTML을 서빙하고 에이전트↔대시보드 사이 메시지를 중계하며, 세션별 최근 이벤트 500개를 버퍼링해 나중에 열어도 히스토리가 보입니다.
- **에이전트(agent/)** — 각 PC에서 상주. 대시보드 명령을 받아 `claude --print --input-format stream-json --output-format stream-json` 프로세스를 프로젝트 디렉터리에서 띄우고, 출력 이벤트를 실시간으로 허브에 흘려보냅니다. 프로세스가 죽은 세션에 프롬프트를 보내면 `--resume <session_id>` 로 자동 재개합니다.
- **대시보드(dashboard/)** — 의존성 없는 HTML 한 장. PC/프로젝트/세션 목록, 실시간 트랜스크립트(어시스턴트 답변, 도구 사용, 도구 결과, 턴 비용), 프롬프트 입력창.

## 빠른 시작

요구사항: Node.js 18+, 각 PC에 Claude Code CLI 설치 및 로그인.

**모든 머신에서 같은 한 줄** 을 실행하고, 설치 도우미의 질문에 답하면 됩니다:

```bash
git clone https://github.com/jisu0630/jisu.git claude-fleet
cd claude-fleet && npm install && npm run setup
```

- **허브가 될 머신** (항상 켜둘 1대): 도우미에서 `1` 선택 → 토큰이 자동 생성됩니다 → `npm run server`
- **각 PC**: 도우미에서 `2` 선택 → 허브 IP·토큰 입력(연결/토큰 검증 자동) → 프로젝트 경로 등록 → `npm run agent`

수동으로 설정하려면 `agent/fleet-agent.config.example.json` 을 복사해 `fleet-agent.config.json` 을 만들고, 허브는 `FLEET_TOKEN=... npm run server` 로 실행해도 됩니다.

**macOS(맥미니 등)에서는** setup 후 아래 한 줄로 로그인 시 자동 시작 + 죽으면 재시작까지 등록됩니다 (허브/에이전트 설정된 것만 자동 감지, 해제는 `uninstall` 인자):

```bash
bash scripts/install-macos.sh
```

다른 OS에서 터미널을 닫아도 유지하려면 pm2 / systemd / tmux 등으로 상주시키세요:

```bash
npx pm2 start "npm run agent" --name claude-fleet-agent
```

Windows는 작업 스케줄러에 `node agent\agent.js` 를 로그온 시 실행으로 등록하면 됩니다.

### 3. 대시보드

브라우저에서 허브 주소(`http://허브호스트:8787`)를 열고 `FLEET_TOKEN` 을 입력하면 끝. PC 카드에서 프로젝트의 **[새 세션]** 을 눌러 첫 프롬프트를 보내고, 이후 하단 입력창에서 대화를 이어갑니다. 휴대폰 브라우저에서도 동작합니다.

## 데모 모드 (API 소모 없이 시험)

실제 Claude 대신 응답을 흉내내는 목(mock)으로 전체 흐름을 확인할 수 있습니다:

```bash
FLEET_TOKEN=demo-token-demo-token-demo npm run server   # 터미널 1
npm run demo:agent                                       # 터미널 2
# 브라우저에서 http://localhost:8787 접속, 토큰 demo-token-demo-token-demo 입력
```

## 에이전트 설정 항목

| 키 | 설명 |
|---|---|
| `hub` | 허브 WebSocket 주소 (`ws://host:8787`, TLS 뒤라면 `wss://…`) |
| `token` | 허브의 `FLEET_TOKEN` 과 동일한 값 |
| `pcName` | 대시보드에 표시될 PC 이름 (생략 시 hostname) |
| `projects` | `{name, path}` 배열 — 이 PC에서 세션을 띄울 수 있는 프로젝트들 |
| `permissionMode` | `acceptEdits`(기본) / `bypassPermissions` 등. 아래 주의 참고 |
| `model` | 세션 모델 지정 (생략 시 기본 모델) |
| `includePartialMessages` | `true` 면 토큰 단위 실시간 스트리밍 (트래픽 증가) |
| `claudeBin` | claude 실행 파일 (기본 `claude`, 경로 지정 가능) |
| `engines.codex` | 설정하면 대시보드에서 Codex 세션도 시작 가능 (아래 참고) |
| `models` | 새 세션·헤더의 모델 드롭다운 목록. 기본값: claude `fable/opus/sonnet/haiku`, codex `gpt-5.1-codex/-mini/gpt-5.1`. 예: `"models": { "claude": ["opus"], "codex": ["gpt-5.1-codex"] }` |

## Codex 같이 쓰기

각 PC 에 [OpenAI Codex CLI](https://github.com/openai/codex)를 설치·로그인해 두고, 에이전트 설정에 한 줄만 추가하면 됩니다 (`npm run setup` 에서 y 로 답해도 됨):

```json
"engines": { "codex": { "bin": "codex", "extraArgs": ["--full-auto"] } }
```

모델은 [새 세션] 모달에서 고르고, **진행 중에도 세션 헤더의 드롭다운으로 변경**할 수 있습니다 — Claude 는 `--resume` 재시작으로 대화를 유지한 채 다음 프롬프트부터, Codex 는 다음 턴부터 새 모델이 적용됩니다 (턴 진행 중이면 끝난 뒤 적용).

그러면 대시보드의 [새 세션] 모달에 **Claude / Codex 선택**이 생기고, 같은 화면에서 두 엔진 세션을 나란히 띄워 번갈아 쓸 수 있습니다 (세션마다 CLAUDE / CODEX 뱃지 표시). 내부적으로 Codex 는 `codex exec --json` 으로 턴을 실행하고 `codex exec resume <thread_id>` 로 대화를 이어갑니다. 이전 턴이 끝나기 전에 보낸 프롬프트는 대기열에 쌓였다가 자동 전송됩니다.

- `extraArgs` 기본값 `--full-auto` 는 승인 없이 작업공간 쓰기까지 허용하는 모드입니다. 더 조이거나(`--sandbox read-only`) 풀려면(`--dangerously-bypass-approvals-and-sandbox`) 여기서 바꾸세요.
- Codex CLI 의 JSON 이벤트 형식은 버전에 따라 다를 수 있습니다. 알 수 없는 이벤트는 무시되도록 방어적으로 파싱하므로 동작은 하지만, 표시가 이상하면 `codex exec --json "test"` 출력을 확인해 주세요. Codex 사용량은 OpenAI 계정에서 과금됩니다.

## 반드시 읽을 것: 보안

이 시스템은 **웹에서 입력한 프롬프트가 각 PC에서 코드 실행으로 이어지는** 구조입니다. 토큰이 유출되면 모든 PC에서 임의 명령 실행이 가능하므로:

- **허브를 공인 인터넷에 그대로 노출하지 마세요.** [Tailscale](https://tailscale.com) 같은 사설 VPN 안에서만 접근하는 구성을 강력히 권장합니다. 굳이 공개해야 하면 반드시 리버스 프록시(Caddy/nginx)로 **HTTPS/WSS** 를 씌우세요 — 평문 `ws://` 는 토큰이 그대로 노출됩니다.
- `FLEET_TOKEN` 은 충분히 길게(`openssl rand -hex 24`), 저장소에 커밋하지 마세요. (`fleet-agent.config.json` 은 `.gitignore` 처리되어 있습니다.)
- `permissionMode` 주의: 헤드리스(`--print`) 모드에서는 권한 프롬프트에 답할 수 없어, 기본값 `acceptEdits` 에서는 파일 편집은 자동 허용되지만 임의 Bash 명령 등은 거부될 수 있습니다. `bypassPermissions` 로 바꾸면 모든 것이 허용되므로, 신뢰하는 네트워크 + 신뢰하는 사용자만 접근 가능한 환경에서만 쓰세요.

## 한계와 다음 단계

- 이벤트 버퍼는 허브 메모리에만 있어 허브를 재시작하면 히스토리가 사라집니다. (세션 자체는 각 PC에 남아 있어 `--resume` 으로 이어집니다.) 필요해지면 SQLite 저장으로 확장.
- 대시보드에서 권한 프롬프트에 개별 응답하는 기능은 없습니다. 필요하면 Agent SDK의 `canUseTool` 콜백 기반으로 확장 가능.
- 참고: 직접 운영하는 게 부담스러우면 Claude Code 내장 기능인 `claude remote-control` + claude.ai/code 조합이 같은 문제를 관리형으로 풀어줍니다.
