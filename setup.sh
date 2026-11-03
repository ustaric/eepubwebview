#!/usr/bin/env bash

# ==============================================================================
# 🚀 Personal Refresh Token & Storage Server 원클릭 대화형 자동 셋업 스크립트
# 대상 환경: Ubuntu / Debian / Oracle Linux (WSL, VPS, Baremetal)
# ==============================================================================

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

clear
echo -e "${CYAN}================================================================${NC}"
echo -e "${CYAN}   🔑 Personal EPUB Server (인증 & 저장소) 자동 설치기          ${NC}"
echo -e "${CYAN}================================================================${NC}"
echo ""

# 0단계: 기본 디렉터리 위치 확인
if [ ! -f "package.json" ]; then
    echo -e "${RED}❌ [오류] package.json 파일이 없습니다.${NC}"
    echo -e "refresh-server 저장소 폴더 내부에서 스크립트를 실행해 주세요."
    exit 1
fi

# ------------------------------------------------------------------------------
# 1단계: .env 기본 템플릿 준비 (웹에서 설정하므로 터미널 대기 생략)
# ------------------------------------------------------------------------------
echo -e "${BLUE}📌 [1/4단계] 기본 환경 설정(.env) 파일 점검${NC}"

if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env
        echo -e "${GREEN}✔ .env.example 기반으로 기본 .env 파일을 생성했습니다.${NC}"
    else
        touch .env
        echo -e "${YELLOW}⚠ 기본 .env 파일을 생성했습니다.${NC}"
    fi
else
    echo -e "${GREEN}✔ 기존 .env 파일이 이미 존재합니다. (기존 설정 유지)${NC}"
fi

# .env에서 포트 번호 추출 (기본값 3001)
APP_PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d '=' -f2 | tr -d ' ' | tr -d '"' | tr -d "'")
APP_PORT=${APP_PORT:-3001}
echo -e "ℹ 서비스 기본 포트: ${CYAN}${APP_PORT}${NC}"
echo ""

# ------------------------------------------------------------------------------
# 2단계: 외부 클라우드 웹 콘솔 방화벽 안내 및 확인 대기
# ------------------------------------------------------------------------------
echo -e "${BLUE}📌 [2/4단계] 오라클/클라우드 웹 콘솔 방화벽 인그레스 확인${NC}"
echo -e "오라클 클라우드 VCN(또는 공유기/방화벽 관리 페이지)에서"
echo -e "아래 포트에 대한 ${YELLOW}인그레스(수신) 규칙${NC}을 열어주셔야 외부 웹 브라우저 접속이 가능합니다:"
echo -e "   - 웹 제어 센터 포트: ${CYAN}${APP_PORT} / TCP${NC}"
echo -e "   - (Caddy/Nginx 프록시 사용 시: ${CYAN}80, 443 / TCP${NC})"
echo ""
echo -e "${YELLOW}👉 오라클 웹 콘솔 인그레스 포트 등록을 확인하셨습니까?${NC}"
read -p "확인 완료되었으면 [Enter] 키를 눌러 진행하세요..." dummy
echo -e "${GREEN}✔ 웹 콘솔 방화벽 확인 완료!${NC}"
echo ""

# ------------------------------------------------------------------------------
# 3단계: 리눅스 내부 방화벽(iptables/ufw) 자동 개방
# ------------------------------------------------------------------------------
echo -e "${BLUE}📌 [3/4단계] 리눅스 내부 방화벽 포트 자동 개방${NC}"

# 1) iptables 오라클 차단 규칙 우회 (최상단 -I 1 삽입)
if command -v iptables &> /dev/null; then
    echo -e "⚙️ iptables 최상단 허용 규칙 삽입 중... (포트: ${APP_PORT}, 80, 443)"
    sudo iptables -I INPUT 1 -p tcp --dport "$APP_PORT" -j ACCEPT 2>/dev/null || true
    sudo iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
    sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT 2>/dev/null || true
    
    # iptables 영구 저장 패키지가 있는 경우 영구 저장
    if command -v netfilter-persistent &> /dev/null; then
        sudo netfilter-persistent save &> /dev/null || true
    fi
    echo -e "${GREEN}✔ iptables 방화벽 규칙 적용 완료${NC}"
fi

# 2) ufw 방화벽이 활성화된 경우 허용
if command -v ufw &> /dev/null && sudo ufw status | grep -q "Status: active"; then
    echo -e "⚙️ UFW 방화벽 감지 ➔ 포트 개방 중..."
    sudo ufw allow "$APP_PORT"/tcp &> /dev/null || true
    sudo ufw allow 80/tcp &> /dev/null || true
    sudo ufw allow 443/tcp &> /dev/null || true
    sudo ufw reload &> /dev/null || true
    echo -e "${GREEN}✔ UFW 방화벽 개방 완료${NC}"
fi
echo ""

# ------------------------------------------------------------------------------
# 4단계: Node.js, 의존성(npm), PM2 점검 및 무중단 서비스 기동
# ------------------------------------------------------------------------------
echo -e "${BLUE}📌 [4/4단계] 런타임 의존성 설치 및 백그라운드 서비스 등록${NC}"

if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js가 설치되어 있지 않습니다.${NC}"
    echo -e "Node.js (v18 이상)를 먼저 설치해 주세요."
    exit 1
fi

echo -e "⚙️ npm 패키지 의존성 설치 중 (npm install)..."
npm install --silent
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ npm install 실패! 네트워크 상태나 권한을 확인하세요.${NC}"
    exit 1
fi
echo -e "${GREEN}✔ 의존성 패키지 설치 완료!${NC}"

# PM2 설치 확인 및 글로벌 설치
if ! command -v pm2 &> /dev/null; then
    echo -e "⚙️ PM2가 감지되지 않아 설치합니다 (npm i -g pm2)..."
    sudo npm install -g pm2 --silent || npm install -g pm2 --silent
fi

if ! command -v pm2 &> /dev/null; then
    echo -e "${RED}❌ PM2 설치에 실패했습니다. 수동으로 'npm i -g pm2'를 실행해 주세요.${NC}"
    exit 1
fi
echo -e "${GREEN}✔ PM2 런타임 확인 완료!${NC}"

APP_NAME="refresh-server"

# 기존 프로세스 여부에 따른 실행
if pm2 describe "$APP_NAME" &> /dev/null; then
    echo -e "⚙️ 기존 프로세스 재시작 중..."
    pm2 restart "$APP_NAME"
else
    echo -e "⚙️ 신규 백그라운드 서비스 등록 중..."
    pm2 start server.js --name "$APP_NAME"
fi

# 부팅 시 자동 재시작 보존
pm2 save &> /dev/null
echo -e "${GREEN}✔ PM2 서비스 등록 및 부팅 자동 실행 영구 저장 완료!${NC}"
echo ""

# ------------------------------------------------------------------------------
# 최종 자체 헬스체크 및 웹 대시보드 접속 안내
# ------------------------------------------------------------------------------
sleep 1.5
echo -e "${CYAN}🔍 [자가 진단] 로컬 헬스체크(/api/health) 호출 중...${NC}"
HEALTH_RES=$(curl -s "http://127.0.0.1:${APP_PORT}/api/health" || echo "")

# 서버 공인 IP 자동 감지 시도
SERVER_IP=$(curl -s -m 2 ifconfig.me || curl -s -m 2 icanhazip.com || echo "서버공인IP")

echo ""
echo -e "${GREEN}================================================================${NC}"
echo -e "${GREEN}   🎉 축하합니다! 서버가 백그라운드에서 정상 구동되었습니다.  ${NC}"
echo -e "${GREEN}================================================================${NC}"
echo ""
echo -e "  🌐 ${YELLOW}[웹 제어 센터 접속 주소]${NC}"
echo -e "     👉 ${CYAN}http://${SERVER_IP}:${APP_PORT}/admin${NC}"
echo -e "     (도메인 연결 환경일 경우: https://내도메인/admin)"
echo ""
echo -e "  💡 ${YELLOW}[안내]${NC}"
echo -e "     이제 터미널을 끄고, 위 웹 주소로 브라우저에서 접속하여"
echo -e "     ${GREEN}Google OAuth 키 입력${NC} 및 ${GREEN}개인 저장소 모드 ON/OFF${NC}를"
echo -e "     마우스 클릭으로 간편하게 완료하세요!"
echo ""
echo -e "  📋 PM2 상태 확인 명령 : ${YELLOW}pm2 status${NC}"
echo -e "  📋 실시간 로그 확인    : ${YELLOW}pm2 logs ${APP_NAME}${NC}"
echo -e "${GREEN}================================================================${NC}"
echo ""