# 🔑 Personal Google Drive Refresh Token & Storage Server

EPUB Web Viewer 사용자를 위한 초경량 전용 Google OAuth Refresh Token 및 자체 스토리지(Self-Hosted Storage) 서버입니다.

사용자의 개인 서버(Oracle Linux, Ubuntu, Synology, NAS 등)에서 직접 구동되며, Google Drive 연동에 필요한 Refresh Token을 서버에 안전하게 보관하고 Access Token을 필요할 때 자동으로 갱신하는 것을 목적으로 합니다. 
또한 선택에 따라 Google Drive를 거치지 않고 **개인 서버 디스크에 도서와 독서 진도율을 빠르게 직접 동기화 하도록 구현한 올인원 스토리지 모드**를 지원합니다.

이 프로젝트는 **개인 서버에서 개인이 직접 사용하는 것을 주된 목적으로 합니다.**

---

## 🐛 EPUB Web Viewer 피드백

EPUB Web Viewer를 사용하면서 발견한 버그나 개선 의견을 남겨 주세요.

### 작성 방법

1. 기존 Issues에서 비슷한 내용이 있는지 확인해 주세요.
2. 같은 내용이 없다면 새 Issue를 작성해 주세요.
3. 버그의 경우 발생 상황과 재현 방법을 함께 적어 주세요.
4. GitHub 로그인이 필요합니다.

[EPUB Web Viewer Issues](https://github.com/ustaric/epubwebview/issues)

> ⚠️ 개인정보, 비밀번호, 인증 토큰, Google Client Secret, Refresh Token, EPUB 원본 파일 등 민감한 정보를 Issue에 작성하지 마세요.
>
> 작성한 Issue 내용과 GitHub 사용자명은 공개될 수 있습니다.

감사합니다.

---

## 📖 Refresh Token & Storage Server

이 서버는 EPUB Web Viewer에서 Google Drive를 장기간 사용할 때 발생하는 Access Token 만료 문제를 해결하기 위한 개인용 OAuth 서버입니다.

Google OAuth 인증 과정에서 발급된 Refresh Token은 서버에 암호화하여 저장하고, 브라우저에는 Refresh Token을 전달하지 않습니다.

브라우저가 Access Token을 필요로 할 때 서버가 Google OAuth 서버와 통신하여 새로운 Access Token을 발급받아 반환합니다.

아울러 설정에 따라 Google Drive 대신 **내 개인 서버 디스크(./data/books, ./data/users, ./data/settings)를 클라우드 저장소로 직접 사용**할 수 있습니다.

### 기본 구조

    EPUB Web Viewer (브라우저 / 모바일 기기)
           │
           │ HTTPS :443
           ▼
    Caddy / Reverse Proxy
           │
           ▼ (127.0.0.1:3001)
    Refresh Token & Storage Server (Node.js)
           │
           ├── ⚙️ 관리자 제어 센터 (/admin - 4단 탭 대시보드)
           ├── 🔒 암호화된 Refresh Token (data/token.enc)
           ├── 👥 다중 사용자 격리 서재 (data/users/{userId})
           ├── 📁 공용 파일 저장소 (data/books, data/settings)
           ├── 📚 다중 공유 서재 & 기기별 칩 권한 거버넌스
           ├── 📱 6자리 단기 OTP 기기 연결 & 6대 슬롯 화이트리스트
           ├── 🔔 Discord 실시간 자원(80%) 및 500 장애 관제
           └── ☁️ Google OAuth / Drive API

---

## ✨ 주요 특징

- **개인 서버 직접 운영**: Oracle Cloud, Ubuntu, Debian, Synology NAS 등 완벽 지원
- **웹 관리자 제어 센터 (/admin)**: 브라우저에서 편리하게 시스템 설정, 토큰 상태 확인 및 4단 탭([📊 관제 대시보드] | [👥 사용자 관리] | [📁 공유 서재 관리] | [⚙️ 시스템 설정]) 제어
- **보안 인증 관문**: ADMIN_PASSWORD 기반 잠금 화면 및 24시간 쿠키 세션 인증 탑재, 1분 내 5회 연속 실패 시 15분 브루트포스 차단
- **자체 스토리지 모드 (Self-Hosted Storage)**: Google Drive 없이 개인 서버 디스크 기반 자체 스토리지 및 초고속 동기화 지원
- **다중 사용자 샌드박스 서재**: 개별 사용자 전용 폴더(data/users/{userId}) 완전 격리, 사용자별 도서 저장 용량(MB) 실시간 조절
- **6자리 단기 OTP 기기 연결**: 복잡한 비밀키 입력 없이 3분 유효 6자리 일회용 번호로 태블릿, 스마트폰 초고속 로그인
- **2단계 화이트리스트 기기 거버넌스**: 계정당 기본 최대 6대 기기 한도 검증, 미등록/삭제 기기 자동 재등록 원천 차단 및 특정 기기 핀포인트 밴(Ban)
- **다중 공유 서재 & 은닉형 칩 권한**: 서버 내 여러 폴더를 공유 서재로 등록하고, 기기별 폴더 칩 클릭 한 번으로 권한 부여/회수(권한 없는 폴더는 클라이언트에 미표출)
- **서버 내부 초고속 도서 복사**: 공유 서재 도서를 클라이언트 왕복 트래픽 없이 서버 디스크 내부에서 0.001초 만에 개인 서재로 다이렉트 복사(/import)
- **실시간 자원 및 장애 감시**: CPU(1분 이동평균), RAM, DISK 10초 실측 가로 게이지 표출, 80% 초과 시 및 HTTP 500 서버 장애 발생 시 Discord 웹훅 즉시 알림
- **빠른 올인원 통합 스냅샷 (/api/storage/snapshot)**: 단 1회의 API 요청으로 도서, 설정, 업적, 통계 데이터를 일괄 조회 및 고아 표지 자가 소독
- **원클릭 주소 복사**: 웹 제어 센터에서 GitHub 주소, 서버 접속 URL, 구글 Redirect URI 1초 클립보드 복사
- **원클릭 대화형 설치 스크립트 (setup.sh)**: 환경 파일 준비, Caddy 연동, Node.js 의존성 설치 및 PM2 등록 지원
- **Google OAuth 2.0 공식 표준**: Authorization Code Flow 사용, Refresh Token 서버 AES-256-GCM 암호화 보관, 브라우저 미전달
- **보안 감사 로그 아카이브**: 외부 침입 및 실패 요청(HTTP >= 400)만 년/월/일 계층형 영구 보관, 웹 화면에서 1클릭 다운로드 및 삭제
- **Access Token 필요 시 자동 갱신** 및 OAuth state 검증
- **CORS Origin 제한** 및 환경변수를 통한 Client ID / Client Secret 관리
- **HTTPS Reverse Proxy 환경 지원** 및 PM2 프로세스 자동 재시작 지원

---

## 📁 자체 스토리지 동작 방식

자체 스토리지 모드는 Google Drive API를 거치지 않고 개인 서버의 디스크를 직접 저장소로 사용합니다.

- 도서 메타데이터, EPUB 원본, 표지 이미지 및 독서 관련 설정을 개인 서버 디스크에 안전하게 저장
- 통합 스냅샷 API를 통한 도서 목록 및 설정 데이터 일괄 조회 및 네트워크 오버헤드 최소화
- 기존 EPUB Web Viewer의 동기화 및 정합성 대사 엔진과 완벽 연동
- 다중 사용자 API 키 검증으로 사용자별 서재 격리 및 할당 용량(Quota) 초과 시 사전 차단
- 6자리 OTP 인증을 통해 등록된 정식 승인 기기(최대 6대)만 접속을 허용하는 화이트리스트 운영
- Google Drive OAuth 인증 없이 자체 스토리지 단독 사용 가능

저장소 데이터는 운영자가 관리하는 개인 서버의 디스크에 보관되며, 실제 저장 용량과 가용성은 서버 환경에 따라 달라집니다.

---

## 🛠️ 요구사항

- **Node.js**: v18.0.0 이상 (LTS 권장)
- **Google Cloud Console**: OAuth 2.0 Client ID 및 Client Secret (구글 연동 시 필수)
- **Linux 개인 서버**: Ubuntu / Debian / Oracle Linux 등 권장
- **Reverse Proxy**: Caddy (권장, setup.sh 자동 구성 지원) 또는 Nginx (HTTPS 필수)
- Google Drive API 사용 설정 (구글 연동 시)

Node.js 버전은 사용하는 배포 환경에 따라 최신 LTS 버전을 사용하는 것을 권장합니다.

---

## 📦 설치

### 서버 파일 안내

서버의 주요 파일과 모듈별 역할은 별도 문서에 상세히 정리되어 있습니다.

- `리프레시서버파일안내.md`: 서버 아키텍처, 17대 모듈별 상세 역할, 의존성 관계 및 공개 함수 명세

처음 설치하거나 서버 구조를 파악할 때 README와 함께 참고하세요.

### 설치 전 준비

- Ubuntu / Debian / Oracle Linux 등 지원되는 Linux 서버
- Node.js v18.0.0 이상 및 npm
- 외부 HTTPS 접속을 위한 도메인과 DNS 설정 권장
- Caddy 또는 Nginx 등 Reverse Proxy 사용 권장
- Google Drive 연동 시 Google Cloud OAuth Client 정보

운영 서버에서는 일반 사용자 계정으로 접속하고, 설치 과정에서 필요한 관리자 작업에만 `sudo`를 사용하세요. root 계정으로 설치 스크립트를 직접 실행하지 않는 것을 권장합니다.

### 방법 1. 원클릭 대화형 설치 (권장)

저장소를 복제하고 서버 폴더로 이동합니다.

    git clone https://github.com/ustaric/refresh-server.git
    cd refresh-server

설치 스크립트에 실행 권한을 부여하고 실행합니다.

    chmod +x setup.sh
    ./setup.sh

설치 과정에서 다음 작업을 진행합니다.

1. `.env` 파일을 확인하고, 없는 경우 15대 표준 환경변수 템플릿을 바탕으로 생성
2. 서비스 포트 등 기본 환경 설정 확인
3. 클라우드 방화벽 및 서버 내부 방화벽 설정 확인
4. Caddy 설치 여부 확인 및 도메인 입력에 따른 Reverse Proxy 설정
5. npm 패키지 설치
6. PM2 설치 여부 확인 및 서버 프로세스 등록
7. 로컬 헬스체크 및 관리자 페이지 접속 주소 안내

기존 `.env`가 있으면 설치 스크립트가 해당 설정을 보존하는지 확인하고, 실행 전 별도 백업을 권장합니다.

### 방화벽 및 포트 설정

Caddy Reverse Proxy를 사용하는 일반적인 구성에서는 외부에 필요한 웹 포트만 공개합니다.

| 포트 | 용도 | 외부 공개 |
| :--- | :--- | :--- |
| TCP 22 | SSH 관리 접속 | 관리자 접속 IP로 제한 권장 |
| TCP 80 | Caddy HTTP 및 Let's Encrypt 인증서 처리 | 필수 개방 |
| TCP 443 | Caddy HTTPS 암호화 웹 트래픽 | 필수 개방 |
| TCP 3001 | Node.js 애플리케이션 기본 포트 | Caddy 사용 시 로컬(127.0.0.1) 바인딩, 비공개 |

Node.js 서버는 가능하면 `127.0.0.1`에 바인딩하고 Caddy가 로컬 주소로 전달하도록 구성하세요. `.env`에서 `PORT`를 변경했다면 실제 서비스 포트도 함께 확인해야 합니다.

Caddy를 사용하지 않고 Node.js 포트에 직접 접속하는 구성을 선택한 경우에만 해당 포트의 외부 접근을 별도로 허용해야 합니다. 이 방식은 HTTPS와 접근 통제를 별도로 구성해야 하므로 권장 구성은 아닙니다.

**Oracle Cloud (OCI) 사용 시 주의사항**

- OCI VCN의 Security List 또는 Network Security Group에서도 필요한 인그레스(80, 443) 규칙을 설정해야 합니다.
- Ubuntu 내부 방화벽과 OCI 클라우드 방화벽은 별개입니다. 양쪽 설정을 모두 확인하세요.
- 기존 SSH 접속 규칙과 Oracle Cloud Agent 관리 규칙을 임의로 삭제하거나 초기화하지 마세요.
- 방화벽 규칙 전체 초기화 명령이나 `nft flush ruleset`을 실행하지 마세요.
- 설치 스크립트가 실제로 어떤 방화벽 관리 도구(UFW, firewalld, iptables 등)를 사용하는지 확인하고, 기존 규칙의 보존 및 재부팅 후 유지 여부를 점검하세요.
- RPCbind 등 기존 시스템 서비스는 사용 여부를 확인하지 않고 임의로 중지하지 마세요.

방화벽 설정이 이미 완료된 운영 서버에서는 설치 스크립트가 기존 규칙을 변경하는지 먼저 검토한 뒤 실행하세요. SSH 원격 접속 중 방화벽 정책을 변경할 때는 현재 접속을 유지하고, 별도 SSH 세션으로 재접속이 가능한지 확인하는 것이 안전합니다.

### 설치 후 확인

PM2 프로세스 상태를 확인합니다.

    pm2 status

실시간 서버 로그를 확인합니다.

    pm2 logs refresh-server

로컬 헬스체크를 실행합니다.

    curl -i http://127.0.0.1:3001/api/health

실제 서비스 포트가 3001이 아니라면 `.env`의 `PORT` 값에 맞춰 주소를 변경하세요.

Caddy를 사용하는 경우 브라우저에서 다음 주소로 관리자 페이지에 접속합니다.

    https://your-domain.example.com/admin

설치 스크립트가 출력한 접속 주소와 실제 도메인 설정을 확인하세요.

### 방법 2. 수동 설치

설치 스크립트를 사용하지 않고 직접 구성할 수도 있습니다.

    git clone https://github.com/ustaric/refresh-server.git
    cd refresh-server
    cp .env.example .env
    npm install

`.env`에 서비스 포트, 관리자 비밀번호, 필요한 OAuth 설정 등을 입력한 뒤 실행합니다.

    npm start

운영 환경에서는 PM2 등의 프로세스 관리자를 이용할 수 있습니다.

    npm install -g pm2
    pm2 start server.js --name refresh-server
    pm2 save

PM2 부팅 자동 실행은 다음 명령으로 등록할 수 있습니다.

    pm2 startup

명령 실행 결과에 표시되는 `sudo` 명령을 안내에 따라 실행한 뒤 다시 `pm2 save`를 실행하세요.

수동 설치에서는 Reverse Proxy, 방화벽, HTTPS, 부팅 자동 실행을 직접 구성하고 확인해야 합니다.

---

## ☁️ Google Cloud 설정

Google Cloud Console에서 OAuth 2.0 Client ID를 생성해야 합니다.

웹 애플리케이션용 OAuth Client를 생성한 후 서버의 OAuth Callback 주소를 **승인된 리디렉션 URI(Authorized redirect URI)**에 정확하게 등록해야 합니다.

예:

    https://your-domain.example.com/auth/google/callback

http / https, 도메인, 경로 및 후행 / 등이 등록된 URI와 정확히 일치해야 합니다.

Google 공식 문서:

[Google OAuth 2.0 — 웹 서버 애플리케이션](https://developers.google.com/identity/protocols/oauth2/web-server?utm_source=chatgpt.com)

Google은 OAuth 구현 시 직접 프로토콜을 구현하기보다 검증된 OAuth 클라이언트 라이브러리를 사용하는 것을 권장합니다.

---

## ⚙️ 환경 설정 (전체 15대 환경변수 명세)

### 1. 웹 제어 센터를 통한 편리한 설정 (추천)
서버를 구동한 후 브라우저로 `https://your-domain.example.com/admin` 에 접속하여 마우스로 직접 설정을 입력하고 저장할 수 있습니다.

### 2. .env 파일을 통한 직접 설정

    PORT=3001
    HOST=127.0.0.1
    GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
    GOOGLE_CLIENT_SECRET=GOCSPX-your-client-secret
    GOOGLE_REDIRECT_URI=https://your-domain.example.com/auth/google/callback
    TOKEN_ENCRYPTION_KEY=your-32-byte-secure-encryption-key
    TOKEN_FILE=./data/token.enc
    ALLOWED_ORIGIN=https://your-viewer.example.com,http://localhost:5173
    STORAGE_MODE=true
    SHARED_BOOKS_DIR=/home/ubuntu/shared_books
    ADMIN_PASSWORD=your-secure-admin-password
    READER_URL=https://your-viewer.example.com
    STORAGE_API_KEY=your-master-storage-api-key
    ENFORCE_STORAGE_API_KEY=true
    DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

실제 값은 사용하는 Google Cloud 프로젝트와 개인 서버 환경에 맞게 설정해야 합니다.

### 📋 15대 환경변수 상세 역할 안내

| 환경변수 키 | 기본값 | 설명 |
| :--- | :--- | :--- |
| `PORT` | `3001` | 서버 HTTP 수신 포트 |
| `HOST` | `127.0.0.1` | 서버 바인딩 주소 (Caddy 사용 시 127.0.0.1 권장) |
| `GOOGLE_CLIENT_ID` | (공백) | Google Cloud Console OAuth 2.0 Client ID |
| `GOOGLE_CLIENT_SECRET` | (공백) | Google Cloud Console OAuth 2.0 Client Secret |
| `GOOGLE_REDIRECT_URI` | (공백) | 구글 콘솔에 등록된 승인 리디렉션 URI |
| `TOKEN_ENCRYPTION_KEY` | (공백) | Refresh Token 암호화용 32바이트 비밀키 |
| `TOKEN_FILE` | `./data/token.enc` | 암호화된 구글 토큰 저장 경로 |
| `ALLOWED_ORIGIN` | `*` | CORS 허용 도메인 목록 (쉼표로 복수 지정 가능) |
| `STORAGE_MODE` | `true` | 자체 스토리지 엔진 활성화 여부 (`true` / `false`) |
| `SHARED_BOOKS_DIR` | (공백) | 기본 공유 도서 라이브러리 디렉터리 경로 |
| `ADMIN_PASSWORD` | (공백) | 관리자 대시보드(/admin) 로그인 비밀번호 |
| `READER_URL` | `https://epubwebview.vercel.app` | 관리자 화면에서 '서재로 돌아가기' 클릭 시 이동할 웹 뷰어 URL |
| `STORAGE_API_KEY` | (공백) | 루트 관리자 전용 마스터 스토리지 API 키 |
| `ENFORCE_STORAGE_API_KEY` | `true` | 올바른 API 키 없는 스토리지 요청 차단 여부 (`true` 시 화이트리스트 강제) |
| `DISCORD_WEBHOOK_URL` | (공백) | 시스템 자원 80% 초과 및 HTTP 500 장애 발생 시 실시간 경보받을 Discord 웹훅 |

### 중요

.env에는 Google Client Secret 및 암호화 키 등 중요한 정보가 포함될 수 있으므로 공개 저장소에 업로드하지 마세요.

    .env
    .env.*
    !.env.example

    data/

---

## 🔐 보안

이 프로젝트는 Google OAuth 및 Google Drive API를 사용하므로 **Google의 최신 공식 OAuth 2.0 문서와 보안 권장사항을 우선적으로 따르는 것을 원칙으로 합니다.**

Google OAuth 구현은 공식 문서 및 공식 클라이언트 라이브러리를 기준으로 지속적으로 수정·보완합니다.

[Google OAuth 2.0 공식 문서](https://developers.google.com/identity/protocols/oauth2/web-server?utm_source=chatgpt.com)

### 프로젝트에서 적용하는 보안 원칙

현재 프로젝트는 다음과 같은 보안 원칙을 적용하고 있습니다.

- 웹 관리자 페이지(/admin) ADMIN_PASSWORD 잠금, 24시간 세션 쿠키 인증 및 5회 실패 시 15분 브루트포스 락
- 2단계 화이트리스트 기기 거버넌스(6자리 OTP 인증 통과 기기만 등록, 미등록/삭제 기기 자동 재등록 원천 차단)
- 자체 스토리지 모드 시 `fs.realpathSync` 기반 Path Traversal(`../`) 및 악의적 심볼릭 링크 탈출 공격 원천 차단
- 최대 100MB 파일 바디 수신 버퍼링 제한으로 메모리 고갈(OOM) 방어
- Google OAuth 2.0 Authorization Code Flow 사용 및 OAuth state 검증
- Refresh Token AES-256-GCM 암호화 저장 및 브라우저 미전달
- Google Client Secret 및 암호화 키를 소스 코드에 저장하지 않음
- Token, Secret, 비밀번호를 감사 로그 및 콘솔에 평문 출력하지 않는 실시간 마스킹 탑재
- 보안 위협 및 실패 요청(HTTP >= 400)만 년/월/일 계층형으로 영구 보관하여 일상 트래픽으로 인한 로그 디스크 오염 방지
- CORS Origin 제한 및 Node.js 서버를 외부에 직접 노출하지 않는 구조 권장
- HTTPS 사용 권장 및 필요한 Google API 권한만 요청
- 민감한 설정 파일 및 Token 파일의 파일 권한 관리

Google은 웹 서버 OAuth 애플리케이션에서 state를 통한 요청 상태 검증, 정확한 redirect URI 설정, Client Secret 보호 및 적절한 OAuth 라이브러리 사용 등을 중요한 보안 사항으로 안내하고 있습니다.

---

## 🔄 보안 업데이트 및 수정

보안은 한 번 구현하고 끝나는 것이 아니라 지속적으로 검토하고 개선해야 하는 부분이라고 생각합니다.

따라서 이 프로젝트 역시 사용 과정이나 코드 검토를 통해 **보안상의 구멍, 오류 또는 개선할 부분이 발견될 경우 계속해서 수정·보완합니다.**

현재 구현된 보안 기능이 모든 환경에서 완전한 보안을 보장한다는 의미는 아닙니다.

특히 OAuth, Google API 및 관련 라이브러리의 변경이나 새로운 보안 문제가 확인될 경우 해당 내용을 검토하여 필요한 수정을 진행합니다.

보안 문제를 발견한 경우 공개 Issue에 인증 토큰, Client Secret, 암호화 키 등의 민감한 정보를 포함하지 말고 별도로 알려 주세요.

---

## 🛡️ 보안 책임 범위

### 프로젝트에서 관리하는 부분

프로젝트 자체에서는 다음과 같은 애플리케이션 보안을 관리합니다.

- 관리자 제어 센터 세션 인증 및 Rate Limit 방어
- 다중 사용자 샌드박스 격리 및 사용자별 Quota 용량 통제
- 6자리 OTP 기기 등록 및 승인 기기 화이트리스트 관리
- 자체 스토리지 파일 쓰기/읽기 소독
- OAuth 인증 흐름 및 OAuth state 검증
- Refresh Token 암호화 저장 및 브라우저 미전달
- Access Token 갱신 처리
- Client Secret 및 암호화 키의 소스 코드 외부 관리
- 민감한 정보의 로그 노출 방지
- CORS 설정
- 알려진 보안 문제 및 구현 오류의 지속적인 수정

### 개인 서버 운영자가 관리하는 부분

이 프로젝트는 개인 서버에서 직접 운영하는 것을 전제로 합니다.

따라서 다음과 같은 **서버 및 운영 환경의 보안은 설치·운영자가 직접 관리해야 합니다.**

- 관리자 비밀번호(ADMIN_PASSWORD)의 복잡도 및 안전한 관리
- 운영체제 보안 업데이트
- 서버 계정 및 비밀번호 관리
- SSH 접근 보안
- 방화벽 설정 (80, 443 외 불필요한 포트 차단)
- 외부에 공개하는 포트 관리
- Reverse Proxy 및 HTTPS 설정
- .env 파일 및 암호화 Token 파일의 접근 권한
- 서버에 대한 물리적·네트워크 접근 제어
- 백업 파일 및 저장장치 보안
- 사용 중인 NAS, VPS, Oracle Cloud 등의 플랫폼 보안 설정

즉,

> **프로젝트의 애플리케이션 보안은 프로젝트에서 지속적으로 관리하고, 개인 서버의 운영 환경 보안은 서버 운영자가 직접 관리합니다.**

개인 서버의 잘못된 설정이나 운영 환경에서 발생하는 보안 문제까지 이 프로젝트가 보장하는 것은 아닙니다.

---

## 🔑 Token 보관

Google Refresh Token은 서버 측에서만 보관하며 암호화하여 저장합니다.

    Browser
       │
       │ Access Token 요청
       ▼
    Refresh Token Server
       │
       │ 암호화된 Refresh Token 복호화
       ▼
    Google OAuth Server
       │
       │ 새로운 Access Token
       ▼
    Refresh Token Server
       │
       │ Access Token
       ▼
    Browser

**Refresh Token 자체는 브라우저로 전달하지 않는 것을 원칙으로 합니다.**

---

## 🌐 API

| Method | Endpoint | 설명 |
| :--- | :--- | :--- |
| `GET` | `/api/health` | 서버 헬스체크, 스토리지 모드 및 토큰 등록 상태 확인 |
| `GET` | `/api/admin/system-stats` | CPU(1분 이동평균), RAM, DISK 실시간 자원 점유율 반환 |
| `GET` | `/api/admin/discord-webhook` | 현재 등록된 Discord 웹훅 주소 조회 |
| `POST` | `/api/admin/discord-webhook` | Discord 웹훅 URL 저장 및 즉시 테스트 발송 |
| `POST` | `/api/auth/otp/issue` | 게스트 기기 연결을 위한 3분 유효 6자리 일회용 번호 발급 |
| `POST` | `/api/auth/otp/verify` | 6자리 번호 검증, 게스트 기기 정식 화이트리스트 승인 및 키 교환 |
| `GET` | `/auth/google` | Google OAuth 공식 로그인 창으로 302 직통 이동 |
| `GET` | `/auth/google/callback` | Google 인가 코드 수신 및 Refresh Token 암호화 보관 |
| `GET` | `/api/access-token` | 암호화된 Refresh Token 기반 신규 Google Access Token 발급 |
| `GET` | `/api/storage/snapshot` | 도서 목록, 설정, 통계, 업적, 묘비 데이터 올인원 일괄 조회 |
| `POST` | `/api/storage/books/:id` | 도서 메타데이터(JSON) 저장 (보관/복원 상태에 따른 물리 이동 포함) |
| `GET` | `/api/storage/books/:id` | 도서 메타데이터(JSON) 조회 |
| `DELETE` | `/api/storage/books/:id` | 도서 메타, EPUB 원본 파일, 모든 표지 이미지 영구 일괄 파쇄 |
| `POST` | `/api/storage/books/:id/epub` | 도서 원본 EPUB 바이너리 스트리밍 업로드 (용량 한도 사전 검사) |
| `GET` | `/api/storage/books/:id/epub` | 도서 원본 EPUB 스트리밍 다운로드 |
| `POST` | `/api/storage/covers/:fileName` | 도서 표지 이미지(WebP) 업로드 |
| `GET` / `HEAD` | `/api/storage/covers/:fileName` | 도서 표지 이미지 다운로드 및 캐시 헤더 반환 |
| `DELETE` | `/api/storage/covers/:fileName` | 단일 표지 이미지 파일 삭제 |
| `POST` | `/api/storage/settings/:fileName`| 전역 설정/통계/업적/묘비 JSON 저장 |
| `GET` | `/api/storage/settings/:fileName` | 전역 설정/통계/업적/묘비 JSON 조회 |
| `POST` | `/api/storage/crash-reports/:name`| 뷰어 줄 잘림/공백 등 조판 결함 진단 리포트 수신 |
| `GET` | `/api/storage/remote-library` | 해당 기기에 권한이 부여된 공유 서재 도서 목록 조회 |
| `GET` | `/api/storage/remote-library/download` | 공유 서재 도서 원본 스트리밍 다운로드 |
| `POST` | `/api/storage/remote-library/import` | 공유 도서를 서버 내부 디스크에서 내 서재로 0초 다이렉트 복사 |
| `GET` | `/api/storage/devices` | 내 서재에 등록된 기기 목록(최대 6대) 조회 |
| `DELETE` | `/api/storage/devices/:id` | 안 쓰는 기기를 등록 목록에서 삭제하고 기기 슬롯 반환 |
| `GET` / `POST` | `/api/storage/admin/shared-folders` | [관리자] 다중 공유 서재 On/Off, 폴더 추가/삭제 및 기기별 칩 권한 제어 |
| `GET` | `/admin` (또는 `/settings`) | 관리자 4단 탭 대시보드 화면 |
| `POST` | `/admin/login` | 관리자 로그인 및 세션 쿠키 발급 (브루트포스 락 탑재) |
| `GET` | `/admin/logout` | 관리자 세션 파기 및 로그아웃 |
| `POST` | `/admin/save` | 시스템 환경변수(.env) 전체 저장 및 즉시 반영 |
| `GET` | `/admin/fs-tree` | 서버 디렉터리 브라우징 간이 탐색기 트리 조회 |
| `POST` | `/admin/test-folder` | 서버 특정 디렉터리 프로세스 읽기 권한 실측 검증 |
| `GET` | `/admin/logs/download` | 일자별 보안 감사 로그 JSON 다운로드 |
| `GET` | `/admin/logs/delete` | 일자별 보안 감사 로그 파일 영구 삭제 |
| `POST` | `/admin/users/create` | 새 사용자 API 키 발급 및 서재 폴더 생성 |
| `POST` | `/admin/users/reissue` | 사용자 데이터 보존 상태로 API 키만 재발급 |
| `POST` | `/admin/users/update-quota` | 사용자별 도서 저장 용량(MB) 실시간 변경 |
| `POST` | `/admin/users/update-max-devices`| 사용자별 최대 등록 허용 기기 수 변경 |
| `POST` | `/admin/users/devices/block` | 특정 기기 핀포인트 차단(Ban) |
| `POST` | `/admin/users/devices/unblock` | 특정 기기 차단 해제 |
| `POST` | `/admin/users/devices/delete` | 관리자 화면에서 특정 기기 슬롯 삭제 |
| `POST` | `/admin/users/delete` | 사용자 API 키 폐기 또는 도서 폴더 영구 삭제 |

---

## 🔒 HTTPS 및 Reverse Proxy

외부에서 서버에 접근하는 경우 HTTPS 사용을 권장합니다.

일반적인 구성은 다음과 같습니다.

    Internet
       │
       │ HTTPS :443
       ▼
    Caddy / Nginx
       │
       │ localhost:3001
       ▼
    Node.js Server

Node.js 서버는 가능하면 127.0.0.1에만 바인딩하고 외부 접근은 Caddy 또는 Nginx와 같은 Reverse Proxy를 통해 처리하는 것을 권장합니다.

Caddy를 사용하는 경우 setup.sh 실행 시 자동으로 구성되며, 수동 설정 시 Caddyfile 예시는 다음과 같습니다:

    your-domain.example.com {
        handle /admin* {
            reverse_proxy 127.0.0.1:3001
        }
        handle /settings* {
            reverse_proxy 127.0.0.1:3001
        }
        handle /auth/* {
            reverse_proxy 127.0.0.1:3001
        }
        handle /api/* {
            reverse_proxy 127.0.0.1:3001
        }
        handle {
            reverse_proxy 127.0.0.1:3001
        }
    }

---

## 🚀 실행

개발 환경:

    npm start

운영 환경에서는 PM2 등의 프로세스 관리자를 사용할 수 있습니다 (setup.sh 실행 시 자동 구성됨).

    pm2 start
    pm2 save
    pm2 startup

운영 환경에 맞게 프로세스 관리 방법을 선택하세요.

---

## 📁 데이터 및 디렉터리 구조

    refresh-server/
    ├── server.js                   # 초슬림 HTTP 파사드 엔트리포인트 (보안 헤더 & 글로벌 라우팅)
    ├── setup.sh                    # Caddy 연동, 방화벽 및 PM2 원클릭 대화형 설치기
    ├── config.js                   # 환경변수 검증 및 전역 설정 객체
    ├── googleAuth.js               # Google OAuth2 토큰 발급/교환/갱신 클라이언트
    ├── tokenStore.js               # Refresh Token AES-256-GCM 암호화 파일 영구 보관소
    ├── package.json                # 패키지 명세
    ├── .env                        # 15대 환경변수 (chmod 600 권장)
    ├── src/
    │   ├── adminController.js      # 관리자 인증, 브루트포스 락, 세션 및 액션 컨트롤러
    │   ├── adminViews.js           # 관리자 화면 뷰 오케스트레이터 파사드
    │   ├── apiKeyManager.js        # 다중 사용자 키 발급, SHA-256 해싱, 6자리 OTP 및 기기 거버넌스
    │   ├── auditLogger.js          # 실시간 30건 메모리 링 버퍼 및 일자별 보안 침입 로그 아카이버
    │   ├── envManager.js           # .env 15대 환경변수 무손실 읽기/쓰기 및 필수 디렉터리 생성
    │   ├── httpUtils.js            # CORS, Rate Limiting, OTP 대입 방어, 바디 버퍼 등 공통 유틸
    │   ├── securityGuard.js        # realpath 기반 경로 탈출 차단, 확장자 검증, 민감정보 마스킹
    │   ├── storageService.js       # 도서 메타, EPUB, 표지 I/O 및 올인원 스냅샷 수집 엔진
    │   ├── systemMonitor.js        # CPU(1분 이동평균)/RAM/DISK 모니터링 및 Discord 웹훅 알림
    │   ├── routes/
    │   │   ├── authRoutes.js       # Google OAuth 및 6자리 OTP 인증 REST 라우터
    │   │   ├── storageRoutes.js    # 자체 스토리지, 공유 서재, 기기 관제 REST 라우터
    │   │   └── systemRoutes.js     # 헬스체크, 자원 통계 및 Discord 웹훅 라우터
    │   └── views/
    │       ├── adminAuthViews.js   # 로그인 및 Google 자동 점프 뷰
    │       ├── adminDashboardTab.js# 실시간 자원 게이지 및 로그 아카이브 뷰
    │       ├── adminFolderModal.js # 간이 파일 탐색기 모달 다이얼로그
    │       ├── adminSettingsTab.js # 시스템 설정 및 원클릭 복사 뷰
    │       └── adminUsersTab.js    # 사용자 서재 및 기기 관리 모달 뷰
    └── data/
        ├── token.enc               # AES-256-GCM 암호화된 Google Refresh Token
        ├── shared_folders.json     # 다중 공유 서재 목록 및 기기별 Stealth 권한 설정 파일
        ├── books/                  # 루트 서재 도서 메타(.json), EPUB 및 표지(.webp)
        ├── settings/               # 루트 서재 전역 설정, 통계, 업적, 묘비 JSON
        ├── archive/                # 보관 처리된 도서 저장소
        ├── users/                  # 다중 사용자 격리 서재 (user_xxxx/books, archive, settings)
        ├── api/                    # 사용자 장부 (api-keys.json - 해시값 및 기기 화이트리스트 보관)
        ├── logs/                   # 일자별 영구 보관 침입/차단 로그 (YYYY/MM/DD/audit-*.jsonl)
        └── crash-reports/          # 뷰어 조판 결함 진단 리포트 JSON 보관소

다음과 같은 파일이나 디렉터리는 공개 저장소에 포함하지 않는 것을 권장합니다.

    .env
    data/
    data/token.enc

예를 들어:

    chmod 600 .env
    chmod 600 data/token.enc 2>/dev/null || true
    chmod 700 data

서버 환경에 따라 필요한 권한은 적절하게 조정해야 합니다.

---

## 🧩 개인 서버 운영을 위한 프로젝트

이 프로젝트는 중앙 서버에서 여러 사용자의 Google 계정을 관리하는 서비스가 아닙니다.

각 사용자가 자신의 서버와 Google Cloud 프로젝트를 직접 구성하는 **개인용 / Self-hosted 구조**를 기본으로 합니다.

예:

    사용자
     ├─ 개인 Google 계정
     ├─ 개인 Google Cloud OAuth Client
     ├─ 개인 Oracle / NAS / Linux 서버
     └─ 개인 Refresh Token & Storage Server

따라서 별도의 중앙 Token 서버에 Google Refresh Token을 전달할 필요가 없습니다.

---

## ⚠️ 주의사항

다음 정보는 다른 사람에게 공개하지 마세요.

    Google Client Secret
    TOKEN_ENCRYPTION_KEY
    Google Refresh Token
    ADMIN_PASSWORD
    STORAGE_API_KEY
    .env
    data/token.enc

특히 GitHub Issue, Discord, 커뮤니티 게시물 등에 인증 정보나 Token을 그대로 붙여 넣지 마세요.

문제 해결을 위해 로그를 공유할 때도 Access Token, Refresh Token, Client Secret, 암호화 키, 관리자 비밀번호 등의 민감한 정보가 포함되어 있지 않은지 확인하세요.

---

## 📌 범위와 한계

이 프로젝트는 개인 서버에서 Google Drive 연동을 안정적으로 유지하거나 자체 스토리지를 가볍게 운영하기 위한 **작고 단순한 OAuth & Storage 서버**를 목표로 합니다.

다음과 같은 대규모 기업형 서비스용 기능은 기본적으로 목표로 하지 않습니다.

- 대규모 중앙 Token 관리 시스템
- 고가용성 클러스터 및 대규모 분산 로드밸런싱
- 기업용 HSM 기반 Key Management
- 복잡한 다계층 결제/빌링 시스템

개인 서버 환경에서 필요한 수준의 높은 단순성과 관리 편의성, 안전한 데이터 보존을 최우선으로 합니다.

---

## 📚 참고 문서

Google OAuth 2.0 관련 설정 및 보안 사항은 항상 최신 Google 공식 문서를 우선적으로 확인하세요.

- [Google OAuth 2.0 — 웹 서버 애플리케이션](https://developers.google.com/identity/protocols/oauth2/web-server?hl=ko)
- [Google OAuth 2.0 Scopes](https://developers.google.com/identity/protocols/oauth2/scopes?hl=ko)

Google의 OAuth 문서는 사용자가 필요한 범위(scope)만 요청하도록 하고, 웹 서버 애플리케이션에서는 적절한 OAuth 클라이언트 라이브러리를 사용하는 것을 권장합니다.

---

## 📄 License

프로젝트의 라이선스 정책은 저장소의 LICENSE 파일을 확인하세요.