#!/usr/bin/env bash

# ==============================================================================
# Personal EPUB Server - Refresh Token & Storage Server
# Ubuntu / Debian / Oracle Linux 통합 설치 및 환경 구성 스크립트
#
# 주요 기능
# - .env 15대 표준 환경변수 자동 검증 및 무작위 암호화 키(32바이트) 자동 채번
# - 기존 .env 설정 100% 무손실 보존
# - UFW / firewalld / iptables-nft 자동 감지 및 웹 필수 포트(80, 443) 안전 추가
# - Caddy 리버스 프록시 자동 백업, 설정 검증 및 리로드
# - Node.js (v18+) / npm / PM2 무중단 데몬 등록 및 부팅 자동 실행
# - 10회 로컬 헬스체크 및 관리자 관제 센터 안내
#
# 보안 정책
# - SSH 22번 규칙 임의 변경 및 삭제 금지
# - Oracle Cloud (OCI) Agent 및 관리 규칙 보존
# - 방화벽 전체 초기화(Flush) 원천 차단
# - Caddy 사용 시 Node.js 내부 포트(3001) 외부 노출 차단
# - RPCbind(111) 등 기존 시스템 서비스 무단 변경 금지
# ==============================================================================

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

APP_NAME="refresh-server"
APP_PORT="3001"
DOMAIN_NAME=""
CADDY_PRESENT=0
FIREWALL_CHANGED=0

# ------------------------------------------------------------------------------
# 공통 함수
# ------------------------------------------------------------------------------

info() {
    echo -e "${BLUE}ℹ $1${NC}"
}

success() {
    echo -e "${GREEN}✔ $1${NC}"
}

warn() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

error() {
    echo -e "${RED}❌ $1${NC}"
}

ask_yes_no() {
    local answer
    read -r -p "$1 [y/N]: " answer
    [[ "$answer" =~ ^[Yy]$ ]]
}

# ------------------------------------------------------------------------------
# 0. 기본 환경 확인
# ------------------------------------------------------------------------------

clear

echo -e "${CYAN}================================================================${NC}"
echo -e "${CYAN}   Personal EPUB Server - 안전한 자동 설치기${NC}"
echo -e "${CYAN}================================================================${NC}"
echo ""

if [ ! -f "package.json" ]; then
    error "package.json 파일이 없습니다."
    echo "refresh-server 저장소 폴더 내부에서 실행하세요."
    exit 1
fi

if [ "$EUID" -eq 0 ]; then
    error "root 계정이 아닌 일반 사용자 계정으로 실행하세요."
    echo "예: ubuntu 계정에서 ./setup.sh"
    exit 1
fi

if ! command -v sudo >/dev/null 2>&1; then
    error "sudo 명령을 찾을 수 없습니다."
    exit 1
fi

if ! sudo -v; then
    error "관리자 권한 인증에 실패했습니다."
    exit 1
fi

# ------------------------------------------------------------------------------
# 1. 환경 설정 파일 점검 및 15대 표준 환경변수 안전 보장
# ------------------------------------------------------------------------------

echo -e "${BLUE}[1/5] 환경 설정 점검${NC}"

# 무작위 32바이트 암호화 키 생성 헬퍼
generate_random_key() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
    else
        head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
    fi
}

if [ ! -f ".env" ]; then
    RANDOM_KEY=$(generate_random_key)
    if [ -f ".env.example" ]; then
        cp .env.example .env
        success ".env.example 기반 .env 생성 완료"
    else
        cat <<EOF > .env
PORT=3001
HOST=127.0.0.1
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
TOKEN_ENCRYPTION_KEY=${RANDOM_KEY}
TOKEN_FILE=./data/token.enc
ALLOWED_ORIGIN=*
STORAGE_MODE=true
SHARED_BOOKS_DIR=
ADMIN_PASSWORD=
READER_URL=https://epubwebview.vercel.app
STORAGE_API_KEY=
ENFORCE_STORAGE_API_KEY=true
DISCORD_WEBHOOK_URL=
EOF
        success "15대 표준 환경변수 템플릿 기반 .env 생성 완료"
    fi
    chmod 600 .env
else
    success "기존 .env 설정 유지"
fi

# TOKEN_ENCRYPTION_KEY 가 비어있는 경우 프로세스 크래시 방지를 위해 자동 채번
EXISTING_KEY=$(awk -F= '/^TOKEN_ENCRYPTION_KEY=/ { sub(/^[^=]*=/, ""); gsub(/[[:space:]"\047]/, ""); print $0 }' .env 2>/dev/null)
if [ -z "$EXISTING_KEY" ]; then
    AUTO_GEN_KEY=$(generate_random_key)
    sed -i "s/^TOKEN_ENCRYPTION_KEY=.*/TOKEN_ENCRYPTION_KEY=${AUTO_GEN_KEY}/" .env || true
    info "보안 토큰 암호화 키(TOKEN_ENCRYPTION_KEY) 자동 생성 및 적용 완료"
fi

APP_PORT=$(
    awk -F= '/^PORT=/ {
        sub(/^[^=]*=/, "")
        gsub(/[[:space:]"\047]/, "")
        value = $0
    }
    END { print value }' .env 2>/dev/null
)

APP_PORT=${APP_PORT:-3001}

if ! [[ "$APP_PORT" =~ ^[0-9]+$ ]] ||
   (( APP_PORT < 1 || APP_PORT > 65535 )); then
    error "잘못된 PORT 설정입니다: $APP_PORT"
    exit 1
fi

info "서비스 포트: $APP_PORT"
echo ""

# ------------------------------------------------------------------------------
# 2. Caddy 설치 여부 감지
# ------------------------------------------------------------------------------

echo -e "${BLUE}[2/5] 웹 프록시 환경 감지${NC}"

if command -v caddy >/dev/null 2>&1 &&
   [ -f "/etc/caddy/Caddyfile" ]; then
    CADDY_PRESENT=1
    success "Caddy 감지됨"
else
    info "Caddy 미설치 - 독립 포트 모드"
fi

echo ""

# ------------------------------------------------------------------------------
# 3. 방화벽 자동 감지 및 안전한 규칙 추가
# ------------------------------------------------------------------------------

echo -e "${BLUE}[3/5] 리눅스 방화벽 점검 및 설정${NC}"

FIREWALL_MODE="none"

# ------------------------------------------------------------------------------
# 3-1. UFW 감지
# ------------------------------------------------------------------------------

if command -v ufw >/dev/null 2>&1 &&
   sudo ufw status 2>/dev/null | grep -q "Status: active"; then

    FIREWALL_MODE="ufw"

    info "UFW 활성화 확인"

    if [ "$CADDY_PRESENT" -eq 1 ]; then
        sudo ufw allow 80/tcp
        sudo ufw allow 443/tcp
        success "Caddy용 TCP 80 / 443 허용"
    else
        if ask_yes_no "Node.js 포트 $APP_PORT 를 외부에 직접 개방할까요?"; then
            sudo ufw allow "$APP_PORT/tcp"
            success "Node.js 포트 개방"
        else
            warn "독립 포트 개방 건너뜀"
        fi
    fi

    FIREWALL_CHANGED=1

# ------------------------------------------------------------------------------
# 3-2. firewalld 감지
# ------------------------------------------------------------------------------

elif command -v firewall-cmd >/dev/null 2>&1 &&
     sudo firewall-cmd --state >/dev/null 2>&1; then

    FIREWALL_MODE="firewalld"

    info "firewalld 활성화 확인"

    if [ "$CADDY_PRESENT" -eq 1 ]; then
        sudo firewall-cmd --permanent --add-service=http || true
        sudo firewall-cmd --permanent --add-service=https || true
        success "HTTP / HTTPS 영구 허용 규칙 추가"
    else
        if ask_yes_no "Node.js 포트 $APP_PORT 를 외부에 직접 개방할까요?"; then
            sudo firewall-cmd --permanent \
                --add-port="${APP_PORT}/tcp"
            success "Node.js 포트 영구 허용"
        else
            warn "독립 포트 개방 건너뜀"
        fi
    fi

    if sudo firewall-cmd --reload; then
        success "firewalld 규칙 반영 완료"
    else
        warn "firewalld reload 실패 - 현재 규칙을 확인하세요."
    fi

    FIREWALL_CHANGED=1

# ------------------------------------------------------------------------------
# 3-3. iptables / iptables-nft 감지
# ------------------------------------------------------------------------------

elif command -v iptables >/dev/null 2>&1 &&
     sudo iptables -S INPUT >/dev/null 2>&1; then

    FIREWALL_MODE="iptables"

    IPTABLES_VERSION=$(iptables --version 2>/dev/null || true)

    info "iptables 감지: $IPTABLES_VERSION"

    add_iptables_rule() {
        local port="$1"

        if sudo iptables -C INPUT \
            -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then

            info "TCP $port 기존 허용 규칙 확인 - 중복 추가 생략"

        else
            local insert_pos

            # INPUT 체인의 기존 DROP/REJECT보다 앞에 추가한다.
            # 무조건 1번에 삽입하면 기존 선행 정책을 우회할 수 있다.
            insert_pos=$(
                sudo iptables -L INPUT --line-numbers -n 2>/dev/null |
                awk '$2 == "DROP" || $2 == "REJECT" { print $1; exit }'
            )

            if [[ "$insert_pos" =~ ^[0-9]+$ ]]; then
                if sudo iptables -I INPUT "$insert_pos" \
                    -p tcp --dport "$port" -j ACCEPT; then
                    success "TCP $port 허용 규칙을 기존 차단 규칙 앞에 추가"
                    FIREWALL_CHANGED=1
                else
                    warn "TCP $port 규칙 추가 실패"
                fi
            elif sudo iptables -A INPUT \
                -p tcp --dport "$port" -j ACCEPT; then
                success "TCP $port 허용 규칙을 INPUT 체인 끝에 추가"
                FIREWALL_CHANGED=1
            else
                warn "TCP $port 규칙 추가 실패"
            fi
        fi
    }

    if [ "$CADDY_PRESENT" -eq 1 ]; then
        add_iptables_rule 80
        add_iptables_rule 443

    else
        if ask_yes_no "Node.js 포트 $APP_PORT 를 외부에 직접 개방할까요?"; then
            add_iptables_rule "$APP_PORT"
        else
            warn "독립 포트 개방 건너뜀"
        fi
    fi

    # IPv6 공인 주소 및 기본 정책 확인
    if command -v ip6tables >/dev/null 2>&1; then

        if ip -6 addr show scope global 2>/dev/null |
           grep -q 'inet6'; then

            warn "공인 IPv6 주소가 감지되었습니다."

            IPV6_POLICY=$(
                sudo ip6tables -S INPUT 2>/dev/null |
                head -1 || true
            )

            echo "IPv6 INPUT: $IPV6_POLICY"

            if [[ "$IPV6_POLICY" == *"-P INPUT ACCEPT"* ]]; then
                warn "IPv6 INPUT 기본 정책이 ACCEPT입니다."
                warn "IPv6 외부 접근 정책을 별도로 점검해야 합니다."
            fi

        else
            success "공인 IPv6 주소가 확인되지 않았습니다."
        fi
    fi

    # iptables 규칙은 런타임에만 적용한다.
    # OCI 관리 규칙이 포함될 수 있는 전체 ruleset을 자동 저장하지 않는다.
    if [ "$FIREWALL_CHANGED" -eq 1 ]; then
        warn "iptables 규칙은 현재 런타임에 적용했습니다."
        warn "재부팅 후 유지 설정은 기존 OCI/배포판 방화벽 관리 방식에 맞춰 별도로 확인하세요."
    fi

# ------------------------------------------------------------------------------
# 3-4. 지원되는 방화벽을 찾지 못한 경우
# ------------------------------------------------------------------------------

else

    FIREWALL_MODE="unknown"

    warn "자동으로 관리 가능한 방화벽을 찾지 못했습니다."
    warn "방화벽 규칙을 임의로 변경하지 않았습니다."

    if command -v nft >/dev/null 2>&1; then
        info "nftables 규칙 확인:"
        sudo nft list ruleset
    fi

fi

echo ""
info "방화벽 관리 방식: $FIREWALL_MODE"

if [ "$CADDY_PRESENT" -eq 1 ]; then
    info "외부 개방 대상: TCP 80 / 443"
    info "Node.js $APP_PORT 포트: 외부 개방하지 않음"
fi

info "SSH 22번 및 RPCbind 111번 규칙은 변경하지 않았습니다."
echo ""

# ------------------------------------------------------------------------------
# 4. Caddy 리버스 프록시 설정
# ------------------------------------------------------------------------------

echo -e "${BLUE}[4/5] Caddy 리버스 프록시 설정${NC}"

if [ "$CADDY_PRESENT" -eq 1 ]; then

    if [ ! -f "/etc/caddy/Caddyfile" ]; then
        warn "Caddyfile이 없습니다. 자동 생성을 건너뜁니다."
    else

        read -r -p \
            "사용할 도메인 (예: youun111.duckdns.org / 엔터 시 건너뜀): " \
            DOMAIN_NAME

        if [ -n "$DOMAIN_NAME" ]; then

            # 도메인 입력값 검증
            if ! [[ "$DOMAIN_NAME" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] ||
               [[ "$DOMAIN_NAME" == *".."* ]]; then

                error "올바르지 않은 도메인 형식입니다."
                exit 1
            fi

            CADDYFILE="/etc/caddy/Caddyfile"

            CADDY_BACKUP="${CADDYFILE}.backup.$(date +%Y%m%d_%H%M%S)"

            if ! sudo cp -a "$CADDYFILE" "$CADDY_BACKUP"; then
                error "Caddyfile 백업 실패"
                exit 1
            fi

            success "기존 Caddyfile 백업: $CADDY_BACKUP"

            # Python으로 관리 영역만 안전하게 갱신
            if ! sudo env \
                DOMAIN_NAME="$DOMAIN_NAME" \
                APP_PORT="$APP_PORT" \
                python3 - <<'PY'
import os
import re
import sys
from pathlib import Path

path = Path("/etc/caddy/Caddyfile")

domain = os.environ["DOMAIN_NAME"]
port = os.environ["APP_PORT"]

begin = "# BEGIN EPUB-REFRESH-SERVER"
end = "# END EPUB-REFRESH-SERVER"

block = f"""\
{begin}
{domain} {{
    handle /admin* {{
        reverse_proxy 127.0.0.1:{port}
    }}
    handle /settings* {{
        reverse_proxy 127.0.0.1:{port}
    }}
    handle /auth/* {{
        reverse_proxy 127.0.0.1:{port}
    }}
    handle /api/* {{
        reverse_proxy 127.0.0.1:{port}
    }}
    handle {{
        reverse_proxy 127.0.0.1:{port}
    }}
}}
{end}"""

content = path.read_text()

has_begin = begin in content
has_end = end in content

if has_begin != has_end:
    print("관리 영역 마커가 불완전합니다.")
    sys.exit(2)

if has_begin:
    pattern = re.compile(
        re.escape(begin) + r".*?" + re.escape(end),
        re.DOTALL
    )
    content = pattern.sub(lambda _: block, content, count=1)
else:
    # 동일 도메인의 기존 설정이 있다면 덮어쓰지 않음
    domain_pattern = re.compile(
        r"(?m)^\s*" + re.escape(domain) + r"\s*\{"
    )

    if domain_pattern.search(content):
        print("동일 도메인의 기존 설정이 존재합니다.")
        print("기존 설정을 보호하기 위해 자동 추가를 중단합니다.")
        sys.exit(3)

    content = content.rstrip() + "\n\n" + block + "\n"

path.write_text(content)
PY
            then
                error "Caddyfile 자동 설정 실패"
                warn "기존 백업은 $CADDY_BACKUP 에 보존되어 있습니다."
                exit 1
            fi

            # Caddy 설정 검증
            if sudo caddy validate \
                --config /etc/caddy/Caddyfile \
                --adapter caddyfile; then

                success "Caddy 설정 검증 성공"

                if sudo systemctl reload caddy; then
                    success "Caddy 리로드 완료"
                else
                    error "Caddy 리로드 실패 - 기존 설정으로 복원합니다."
                    if sudo cp -a "$CADDY_BACKUP" "$CADDYFILE"; then
                        sudo systemctl reload caddy || true
                        warn "기존 Caddyfile 복원 완료: $CADDY_BACKUP"
                    else
                        error "백업 복원도 실패했습니다. 백업 파일을 수동으로 복구하세요: $CADDY_BACKUP"
                    fi
                    exit 1
                fi

            else
                error "Caddy 설정 검증 실패"

                sudo cp -a "$CADDY_BACKUP" "$CADDYFILE"

                sudo caddy validate \
                    --config /etc/caddy/Caddyfile \
                    --adapter caddyfile || true

                error "기존 Caddyfile로 복원했습니다."
                exit 1
            fi

        else
            info "도메인 입력 없음 - 기존 Caddyfile 유지"
        fi
    fi

else
    info "Caddy 미사용 - 독립 포트 모드"
fi

echo ""

# ------------------------------------------------------------------------------
# 5. Node.js / npm / PM2 설치 및 서비스 실행
# ------------------------------------------------------------------------------

echo -e "${BLUE}[5/5] Node.js 및 PM2 서비스 설정${NC}"

if ! command -v node >/dev/null 2>&1; then
    error "Node.js가 설치되어 있지 않습니다."
    echo "Node.js v18 이상을 먼저 설치하세요."
    exit 1
fi

NODE_VERSION=$(node -v)
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')

if (( NODE_MAJOR < 18 )); then
    error "Node.js v18 이상이 필요합니다. 현재 버전: $NODE_VERSION"
    exit 1
fi

success "Node.js 확인: $NODE_VERSION"

if ! command -v npm >/dev/null 2>&1; then
    error "npm을 찾을 수 없습니다."
    exit 1
fi

echo "npm 의존성 설치 중..."

if ! npm install --silent; then
    error "npm install 실패"
    exit 1
fi

success "npm 패키지 설치 완료"

if ! command -v pm2 >/dev/null 2>&1; then

    info "PM2 설치 중..."

    if ! sudo npm install -g pm2 --silent; then
        error "PM2 설치 실패"
        exit 1
    fi
fi

if ! command -v pm2 >/dev/null 2>&1; then
    error "PM2 실행 파일을 찾을 수 없습니다."
    exit 1
fi

success "PM2 확인 완료"

# 기존 프로세스 유지 및 재시작
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then

    info "기존 EPUB 서버 재시작"

    if ! pm2 restart "$APP_NAME"; then
        error "PM2 재시작 실패"
        exit 1
    fi

else

    info "신규 EPUB 서버 등록"

    if ! pm2 start server.js --name "$APP_NAME"; then
        error "PM2 실행 실패"
        exit 1
    fi

fi

pm2 save

success "PM2 프로세스 목록 저장 완료"

# ------------------------------------------------------------------------------
# PM2 부팅 자동 실행 상태 확인
# ------------------------------------------------------------------------------

PM2_SERVICE="pm2-${USER}"

if systemctl is-enabled "$PM2_SERVICE" >/dev/null 2>&1; then
    success "PM2 부팅 자동 실행 서비스 활성화 확인"
else
    warn "PM2 부팅 자동 실행 서비스가 확인되지 않았습니다."
    echo "필요하면 다음 명령으로 설정하세요:"
    echo "sudo env PATH=\$PATH:$(dirname "$(command -v node)") \
$(command -v pm2) startup systemd -u $USER --hp $HOME"
fi

echo ""

# ------------------------------------------------------------------------------
# 최종 헬스체크
# ------------------------------------------------------------------------------

echo -e "${CYAN}================================================================${NC}"
echo -e "${CYAN}최종 서버 헬스체크${NC}"
echo -e "${CYAN}================================================================${NC}"

HEALTH_OK=0

for attempt in $(seq 1 10); do

    if curl -fsS \
        --max-time 3 \
        "http://127.0.0.1:${APP_PORT}/api/health" \
        >/dev/null 2>&1; then

        HEALTH_OK=1
        break
    fi

    sleep 1
done

if [ "$HEALTH_OK" -eq 1 ]; then
    success "EPUB 서버 헬스체크 정상"
else
    warn "헬스체크 응답을 받지 못했습니다."
    warn "PM2 로그(pm2 logs refresh-server)와 .env 설정을 확인하세요."
fi

SERVER_IP=$(
    curl -fsS -m 3 https://ifconfig.me 2>/dev/null ||
    curl -fsS -m 3 https://icanhazip.com 2>/dev/null ||
    echo "서버공인IP"
)

echo ""
echo -e "${GREEN}================================================================${NC}"
echo -e "${GREEN}Personal EPUB Server 설치 완료${NC}"
echo -e "${GREEN}================================================================${NC}"

if [ -n "$DOMAIN_NAME" ]; then
    echo -e "🌐 제어 센터: https://${DOMAIN_NAME}/admin"
elif [ "$CADDY_PRESENT" -eq 1 ]; then
    echo -e "🌐 기존 Caddy 설정 유지"
    echo -e "   기존 도메인 및 라우팅으로 접속하세요: https://도메인/admin"
else
    echo -e "🌐 제어 센터: http://${SERVER_IP}:${APP_PORT}/admin"
fi

echo ""
echo -e "📋 PM2 상태: pm2 status"
echo -e "📋 실시간 로그: pm2 logs ${APP_NAME}"
echo -e "📋 메모리 확인: free -h"
echo -e "📋 포트 확인: sudo ss -tulpn"
echo -e "📋 방화벽 확인: sudo iptables -L INPUT -n -v"
echo ""
echo -e "${GREEN}================================================================${NC}"