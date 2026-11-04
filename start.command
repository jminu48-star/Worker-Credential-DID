#!/bin/bash
# macOS: 더블클릭으로 실행 (처음엔 터미널에서 chmod +x start.command)
cd "$(dirname "$0")"
export HARDHAT_DISABLE_TELEMETRY_PROMPT=true
command -v node >/dev/null || { echo "Node.js 가 필요합니다: https://nodejs.org"; open https://nodejs.org; exit 1; }
[[ -d node_modules && -d node_modules/cloudflared && -d node_modules/@vladmandic/face-api ]] || npm install
npm run phone
