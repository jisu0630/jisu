# 맥미니 허브 셋업 런북 (Claude 가 이 파일을 읽고 그대로 수행)

이 파일은 **맥미니에서 실행 중인 Claude Code 세션**이 읽고 순서대로 수행하는 지시서다.
사용자는 옆에서 결과만 확인한다. 각 단계는 다시 실행해도 안전하게(idempotent) 작성돼 있다.
대화형 설치 도우미(`npm run setup`)는 쓰지 말고 파일을 직접 만든다.

## 0. 사전 확인

```bash
node -v && npm -v && git --version && claude --version
```
- 하나라도 없으면 멈추고 사용자에게 알려라. (Node 는 `brew install node`)
- 이 저장소가 `~/claude-fleet` 에 없으면:
  `git clone https://github.com/jisu0630/jisu.git ~/claude-fleet`
- 있으면 `cd ~/claude-fleet && git pull`. 이후 모든 작업은 `~/claude-fleet` 에서 한다.

```bash
cd ~/claude-fleet && npm install
```

## 1. 허브 토큰

`.fleet-token` 이 없을 때만 생성한다 (있으면 재사용):

```bash
[ -f .fleet-token ] || openssl rand -hex 24 > .fleet-token
chmod 600 .fleet-token
```

토큰 값은 **사용자에게 알려줘라** (브라우저·노트북 연결에 필요). 단, 커밋하거나 다른
파일에 복사하지는 마라.

## 2. 맥미니 에이전트 설정

`fleet-agent.config.json` 을 아래 내용으로 만든다 (`<TOKEN>` 은 1번 값, `<HOME>` 은
`echo $HOME` 결과). 이미 있으면 hub/token/pcName 만 맞는지 확인하고 projects 는 보존.

```json
{
  "hub": "ws://localhost:8787",
  "token": "<TOKEN>",
  "pcName": "macmini",
  "permissionMode": "acceptEdits",
  "includePartialMessages": false,
  "projects": [
    { "name": "fleet-memory", "path": "<HOME>/claude-fleet/fleet-memory" }
  ]
}
```

사용자에게 "맥미니에서 세션을 돌릴 프로젝트 폴더가 더 있으면 경로를 알려달라"고 물어보고,
있으면 projects 에 추가하라. 없으면 위 그대로 둔다. `fleet-memory` 폴더는 허브가 첫
실행 때 자동 생성한다 (없어도 등록해 둔다).

## 3. 자동 시작 등록 (허브 + 에이전트)

```bash
bash scripts/install-macos.sh
```

- `.fleet-token` 과 `fleet-agent.config.json` 을 감지해 launchd 에 등록하고 바로 띄운다.
- macOS 방화벽 팝업("node 가 수신 연결을 허용할까요?")이 뜨면 사용자에게 **허용**을 누르라고 안내.

확인:
```bash
sleep 3
launchctl list | grep claude-fleet
curl -s localhost:8787/healthz
tail -n 5 logs/com.claude-fleet.agent.log
```
- healthz 가 `{"ok":true,"pcs":1,...}` 이고 에이전트 로그에 `허브 접속 완료` 가 있어야 한다.
- 실패하면 `logs/com.claude-fleet.hub.log` 와 agent 로그를 읽고 원인을 고친 뒤
  `bash scripts/install-macos.sh` 를 다시 실행하라.

## 4. 잠자기 방지 (sudo 필요 — 사용자가 직접)

Claude 는 비밀번호를 입력할 수 없으므로 사용자에게 다음을 터미널에 직접 치라고 안내:

```bash
sudo pmset -a sleep 0 disksleep 0
```

## 5. Tailscale (밖에서 접속용)

```bash
brew list --cask tailscale >/dev/null 2>&1 || brew install --cask tailscale
```
설치 후 로그인은 GUI 라 사용자가 해야 한다: "런치패드 → Tailscale 실행 → 로그인 →
메뉴바 아이콘에서 이 맥의 IP(100.x.x.x) 확인" 을 안내. 로그인 후 아래로 IP 를 읽어라:

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4 2>/dev/null || echo "(Tailscale 미로그인)"
```

## 6. 최종 보고

다음 형식으로 사용자에게 정리해 줘라:

```
=== 맥미니 허브 준비 완료 ===
허브 주소(LAN):       http://<ipconfig getifaddr en0 결과>:8787
허브 주소(Tailscale): http://<Tailscale IP>:8787   (미로그인이면 "나중에")
토큰:                 <TOKEN>
노트북 에이전트 hub 값: ws://<Tailscale IP 또는 LAN IP>:8787
자동 시작: 등록됨 (launchctl list | grep claude-fleet)
잠자기 방지: 사용자가 sudo pmset 실행 필요 (안 했으면 표시)
```

그리고 "브라우저에서 허브 주소를 열고 토큰을 입력하면 macmini 카드가 초록색으로
보여야 합니다" 라고 안내하라.

## 7. (선택) 사령탑 세션 띄우기

사용자가 원하면:
```bash
brew list tmux >/dev/null 2>&1 || brew install tmux
tmux new -d -s fleet "cd ~/claude-fleet && claude --remote-control fleet-commander"
```
그러면 폰 Claude 앱 Code 탭에 `fleet-commander` 세션이 나타난다고 안내.
(이 세션은 `CLAUDE.md` 의 사령탑 지침을 따른다.)

---

# 노트북(윈도우) 을 이 허브에 붙이기 — 노트북의 Claude 세션이 수행

노트북에 이미 `C:\Users\<user>\claude-fleet` 이 있고 노트북 자체 허브가 돌고 있는 경우:

1. 노트북에서 돌고 있는 `node server/server.js` 와 `node agent/agent.js` 프로세스를 종료.
2. `cd claude-fleet && git pull`
3. `fleet-agent.config.json` 수정:
   - `hub` → `ws://<맥미니 Tailscale IP 또는 LAN IP>:8787`
   - `token` → 맥미니 토큰
   - `projects` 에서 `C:\Users\<user>` 같은 홈 폴더 항목은 제거하고 실제 프로젝트 폴더로 교체
     (사용자에게 경로를 물어볼 것)
4. 작업 스케줄러에 로그온 시 자동 실행 등록:
   ```powershell
   $wd = "$env:USERPROFILE\claude-fleet"
   $a = New-ScheduledTaskAction -Execute "node" -Argument "agent\agent.js" -WorkingDirectory $wd
   $t = New-ScheduledTaskTrigger -AtLogOn
   Register-ScheduledTask -TaskName "claude-fleet-agent" -Action $a -Trigger $t -Force
   Start-ScheduledTask -TaskName "claude-fleet-agent"
   ```
5. 5초 후 `logs\agent.log`(또는 스케줄러 출력)에 `허브 접속 완료` 확인, 없으면 hub 주소·토큰·방화벽 점검.
6. 노트북의 기존 `fleet-memory` 폴더가 있고 내용이 있으면 압축해 두었다가 맥미니의
   `~/claude-fleet/fleet-memory` 에 합치라고 안내 (기록 이관, 선택).
