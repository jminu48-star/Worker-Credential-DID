@echo off
chcp 65001 >nul
cd /d "%~dp0"
title WorkerBadge 관제
set HARDHAT_DISABLE_TELEMETRY_PROMPT=true

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js 가 설치되어 있지 않습니다. 열리는 페이지에서 LTS 버전을 설치한 뒤 다시 실행하세요.
  start "" https://nodejs.org
  pause
  exit /b 1
)

set NEED_INSTALL=
if not exist node_modules set NEED_INSTALL=1
if not exist node_modules\cloudflared set NEED_INSTALL=1
if not exist node_modules\@vladmandic\face-api set NEED_INSTALL=1
if defined NEED_INSTALL (
  echo 필요한 파일을 설치합니다. 1~3분 걸려요...
  call npm install
  if errorlevel 1 ( echo [!] 설치 실패. 인터넷 연결을 확인하세요. & pause & exit /b 1 )
)

echo 프로그램을 시작합니다. 휴대폰용 인터넷 주소를 만들고(10~30초) 브라우저가 열립니다.
echo [중요] 프로그램을 쓰는 동안 이 검은 창을 닫지 마세요. 끝낼 때만 닫으세요.
call npm run phone
echo.
echo [!] 프로그램이 멈췄습니다. 위의 오류 메시지를 캡처해서 보내 주세요.
pause
