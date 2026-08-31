#!/usr/bin/env bash
# macOS 용 claude-fleet 자동 시작 설치 스크립트
# - .fleet-token 이 있으면 허브를, fleet-agent.config.json 이 있으면 에이전트를
#   launchd(로그인 시 자동 시작 + 죽으면 재시작)에 등록한다.
# 사용:  npm run setup 을 먼저 마친 뒤  bash scripts/install-macos.sh
# 해제:  bash scripts/install-macos.sh uninstall
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$(pwd)"
NODE="$(command -v node)"
LA="$HOME/Library/LaunchAgents"
mkdir -p "$LA" "$REPO/logs"

HUB_LABEL="com.claude-fleet.hub"
AGENT_LABEL="com.claude-fleet.agent"

unload_one() {
  launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
  rm -f "$LA/$1.plist"
}

if [[ "${1:-}" == "uninstall" ]]; then
  unload_one "$HUB_LABEL"
  unload_one "$AGENT_LABEL"
  echo "자동 시작 등록을 해제했습니다."
  exit 0
fi

write_plist() { # $1=label $2=js경로
  cat > "$LA/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string>
    <string>$REPO/$2</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$REPO/logs/$1.log</string>
  <key>StandardErrorPath</key><string>$REPO/logs/$1.log</string>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$LA/$1.plist"
  echo "등록 완료: $1  (로그: logs/$1.log)"
}

installed=0
if [[ -f .fleet-token ]]; then
  write_plist "$HUB_LABEL" "server/server.js"
  installed=1
fi
if [[ -f fleet-agent.config.json ]]; then
  write_plist "$AGENT_LABEL" "agent/agent.js"
  installed=1
fi

if [[ $installed -eq 0 ]]; then
  echo "설정 파일이 없습니다. 먼저 npm run setup 을 실행하세요."
  echo "  (허브: .fleet-token 생성 / 에이전트: fleet-agent.config.json 생성)"
  exit 1
fi

echo ""
echo "완료! 이제 로그인하면 자동으로 시작되고, 프로세스가 죽어도 재시작됩니다."
echo "상태 확인:  launchctl list | grep claude-fleet"
echo ""
echo "⚠ 맥미니가 잠들면 허브도 멈춥니다. 시스템 설정 → 에너지 절약(또는 디스플레이)에서"
echo "  '디스플레이가 꺼져 있을 때 자동으로 잠자기 방지' 를 켜두세요."
