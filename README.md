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

아울러 설정에 따라 Google Drive 대신 **내 개인 서버 디스크(./data/books, ./data/settings)를 클라우드 저장소로 직접 사용**할 수 있습니다.

### 기본 구조

    EPUB Web Viewer (브라우저)
           │
           │ HTTPS :443
           ▼
    Caddy / Reverse Proxy
           │
           ▼ (127.0.0.1:3001)
    Refresh Token & Storage Server (Node.js)
           │
           ├── ⚙️ 관리자 제어 센터 (/admin)
           ├── 🔒 암호화된 Refresh Token (data/token.enc)
           ├── 📁 자체 파일 저장소 (data/books, data/settings)
           └── ☁️ Google OAuth / Drive API

---

## ✨ 주요 특징

- 개인 서버에서 직접 운영
- **웹 관리자 제어 센터 (/admin)**: 브라우저에서 편리하게 시스템 설정, 토큰 상태 확인 및 스토리지 모드 ON/OFF 제어
- **보안 인증 관문**: ADMIN_PASSWORD 기반 잠금 화면 및 24시간 쿠키 세션 인증 탑재
- **자체 스토리지 모드 (Self-Hosted Storage)**: Google Drive 없이 개인 서버 디스크 기반 자체 스토리지 및 빠른 동기화 지원
- **빠른 올인원 통합 스냅샷 (/api/storage/snapshot)**: 단 1회의 API 요청으로 도서, 설정, 업적, 통계 데이터를 일괄 조회
- **원클릭 주소 복사**: 웹 제어 센터에서 GitHub 주소, 서버 접속 URL, 구글 Redirect URI 1초 클립보드 복사
- **원클릭 대화형 설치 스크립트 (setup.sh)**: 환경 파일 준비, Caddy 연동, Node.js 의존성 설치 및 PM2 등록 지원. 방화벽 동작은 설치 스크립트 버전과 서버 환경에 따라 달라지므로, 실행 전 설치 안내의 포트 정책을 확인해야 합니다.
- Google OAuth 2.0 Authorization Code Flow 사용
- Google 공식 Node.js OAuth 라이브러리 사용
- Refresh Token 서버 보관
- Refresh Token AES-256-GCM 암호화 저장
- 브라우저에 Refresh Token 직접 전달하지 않음
- Access Token 필요 시 자동 갱신
- OAuth state 검증
- CORS Origin 제한
- 환경변수를 통한 Client ID / Client Secret 관리
- HTTPS Reverse Proxy 환경 지원
- PM2 등을 이용한 프로세스 자동 재시작 지원

---

## 📁 자체 스토리지 동작 방식

자체 스토리지 모드는 Google Drive API를 거치지 않고 개인 서버의 디스크를 직접 저장소로 사용합니다.

- 도서 메타데이터, EPUB 원본, 표지 이미지 및 독서 관련 설정을 개인 서버에 저장
- 통합 스냅샷 API를 통한 도서 목록 및 설정 데이터 일괄 조회
- 기존 EPUB Web Viewer의 동기화 및 정합성 대사 엔진과 연동
- 여러 기기에서 동일한 개인 서버 저장소를 공유
- Google Drive OAuth 인증 없이 자체 스토리지 사용 가능

저장소 데이터는 운영자가 관리하는 개인 서버의 디스크에 보관되며, 실제 저장 용량과 가용성은 서버 환경에 따라 달라집니다.

---

## 🛠️ 요구사항

- **Node.js**: v18.0.0 이상
- **Google Cloud Console**: OAuth 2.0 Client ID 및 Client Secret (구글 연동 시)
- HTTPS를 사용할 수 있는 개인 서버 환경 권장
- Google Drive API 사용 설정 (구글 연동 시)

Node.js 버전은 사용하는 배포 환경에 따라 최신 LTS 버전을 사용하는 것을 권장합니다.

---

## 📦 설치

### 서버 파일 안내

서버의 주요 파일과 모듈별 역할은 별도 문서에 정리되어 있습니다.

- [`리프레시서버파일안내.md`](리프레시서버파일안내.md): 서버 아키텍처, 파일 카탈로그, 모듈 간 의존성 및 주요 공개 인터페이스

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

설치 스크립트를 실행합니다.

    chmod +x setup.sh
    ./setup.sh

설치 과정에서 다음 작업을 진행합니다.

1. `.env` 파일을 확인하고, 없는 경우 `.env.example`을 바탕으로 생성
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
| TCP 80 | Caddy HTTP 및 인증서 처리 | 필요 |
| TCP 443 | Caddy HTTPS | 필요 |
| TCP 3001 | Node.js 애플리케이션 기본 포트 | Caddy 사용 시 공개하지 않음 |

Node.js 서버는 가능하면 `127.0.0.1`에 바인딩하고 Caddy가 로컬 주소로 전달하도록 구성하세요. `.env`에서 `PORT`를 변경했다면 실제 서비스 포트도 함께 확인해야 합니다.

Caddy를 사용하지 않고 Node.js 포트에 직접 접속하는 구성을 선택한 경우에만 해당 포트의 외부 접근을 별도로 허용해야 합니다. 이 방식은 HTTPS와 접근 통제를 별도로 구성해야 하므로 권장 구성은 아닙니다.

**Oracle Cloud 사용 시 주의사항**

- OCI VCN의 Security List 또는 Network Security Group에서도 필요한 인그레스 규칙을 설정해야 합니다.
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

## ⚙️ 환경 설정

### 1. 웹 제어 센터를 통한 편리한 설정 (추천)
서버를 구동한 후 브라우저로 https://your-domain.example.com/admin 에 접속하여 마우스로 직접 설정을 입력하고 저장할 수 있습니다.

### 2. .env 파일을 통한 직접 설정
.env.example을 참고하여 .env 파일을 생성합니다.

    cp .env.example .env

예:

    GOOGLE_CLIENT_ID=your-client-id
    GOOGLE_CLIENT_SECRET=your-client-secret
    GOOGLE_REDIRECT_URI=https://your-domain.example.com/auth/google/callback

    TOKEN_ENCRYPTION_KEY=your-32-byte-encryption-key

    ALLOWED_ORIGIN=https://your-viewer.example.com
    PORT=3001
    HOST=127.0.0.1
    STORAGE_MODE=false
    ADMIN_PASSWORD=your-secure-admin-password

실제 값은 사용하는 Google Cloud 프로젝트와 개인 서버 환경에 맞게 설정해야 합니다.

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

- 웹 관리자 페이지(/admin) ADMIN_PASSWORD 잠금 및 24시간 세션 쿠키 인증
- 자체 스토리지 모드 시 Path Traversal(../) 경로 조작 공격 원천 차단
- 최대 100MB 파일 바디 수신 버퍼링 제한으로 메모리 고갈 방어
- Google OAuth 2.0 Authorization Code Flow 사용
- OAuth state 검증
- Refresh Token AES-256-GCM 암호화 저장
- Refresh Token을 브라우저에 전달하지 않음
- Google Client Secret을 소스 코드에 저장하지 않음
- 암호화 키를 소스 코드에 저장하지 않음
- Token 및 Secret을 로그에 출력하지 않음
- CORS Origin 제한
- Node.js 서버를 외부에 직접 노출하지 않는 구조 권장
- HTTPS 사용 권장
- 필요한 Google API 권한만 요청
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
- 자체 스토리지 파일 쓰기/읽기 소독
- OAuth 인증 흐름
- OAuth state 검증
- Refresh Token 암호화 저장
- Refresh Token의 브라우저 미전달
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
| `GET` | `/api/health` | 서버 헬스체크 및 스토리지 모드 상태 확인 |
| `GET` | `/admin` | 관리자 웹 대시보드 화면 |
| `POST` | `/admin/login` | 관리자 로그인 및 세션 쿠키 발급 |
| `GET` | `/admin/logout` | 관리자 세션 파기 및 로그아웃 |
| `POST` | `/admin/save` | 관리자 환경설정(.env) 저장 및 스토리지 모드 반영 |
| `GET` | `/api/storage/snapshot` | 도서, 설정, 통계, 업적 및 묘비 데이터 통합 조회 |
| `POST` | `/api/storage/books/:id` | 도서 메타데이터(JSON) 저장 |
| `GET` | `/api/storage/books/:id` | 도서 메타데이터(JSON) 조회 |
| `POST` | `/api/storage/books/:id/epub` | 도서 원본 EPUB 바이너리 업로드 |
| `GET` | `/api/storage/books/:id/epub` | 도서 원본 EPUB 스트리밍 다운로드 |
| `POST` | `/api/storage/covers/:fileName` | 도서 표지 이미지(WebP) 업로드 |
| `GET` | `/api/storage/covers/:fileName` | 도서 표지 이미지(WebP) 다운로드 |
| `DELETE` | `/api/storage/books/:id` | 도서 메타데이터, EPUB 원본 및 표지 파일 삭제 |
| `POST` | `/api/storage/settings/:fileName` | 전역 설정/통계/업적/묘비 JSON 저장 |
| `GET` | `/api/storage/settings/:fileName` | 전역 설정/통계/업적/묘비 JSON 조회 |
| `GET` | `/auth/google` | Google OAuth 로그인 시작 |
| `GET` | `/auth/google/callback` | Google OAuth 인증 완료 후 Callback 처리 |
| `GET` | `/api/access-token` | 저장된 Refresh Token을 사용하여 Google Access Token 발급 |

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
    ├── server.js              # 메인 엔트리포인트 (HTTP 라우터)
    ├── setup.sh               # 대화형 원클릭 설치 스크립트
    ├── .env                   # 환경변수 (ADMIN_PASSWORD 포함, chmod 600 권장)
    ├── src/
    │   ├── envManager.js      # .env 파싱 및 data 폴더 관리
    │   ├── adminController.js # 관리자 대시보드 렌더링 및 세션 쿠키 인증
    │   └── storageService.js  # 순수 디스크 기반 도서/설정 I/O 엔진
    └── data/
        ├── token.enc          # 암호화된 Google Refresh Token
        ├── books/             # 도서 메타(.json) 및 EPUB 파일 저장소
        ├── settings/          # settings, achievements, stats, 묘비 저장소
        └── archive/           # 보관된 도서 저장소

다음과 같은 파일이나 디렉터리는 공개 저장소에 포함하지 않는 것을 권장합니다.

    .env
    data/
    data/token.enc

예를 들어:

    chmod 600 .env
    chmod 600 data/token.enc
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
    .env
    data/token.enc

특히 GitHub Issue, Discord, 커뮤니티 게시물 등에 인증 정보나 Token을 그대로 붙여 넣지 마세요.

문제 해결을 위해 로그를 공유할 때도 Access Token, Refresh Token, Client Secret, 암호화 키, 관리자 비밀번호 등의 민감한 정보가 포함되어 있지 않은지 확인하세요.

---

## 📌 범위와 한계

이 프로젝트는 개인 서버에서 Google Drive 연동을 안정적으로 유지하거나 자체 스토리지를 가볍게 운영하기 위한 **작고 단순한 OAuth & Storage 서버**를 목표로 합니다.

다음과 같은 대규모 서비스용 기능은 기본적으로 목표로 하지 않습니다.

- 다중 사용자 중앙 관리
- 사용자별 권한 관리
- 관리자 계정 시스템
- 대규모 Token 관리 시스템
- 고가용성 클러스터
- 중앙 모니터링 시스템
- 기업용 보안 인프라
- HSM 기반 Key Management
- 대규모 분산 환경

개인 서버 환경에서 필요한 수준의 단순성과 관리 편의성을 우선합니다.

---

## 📚 참고 문서

Google OAuth 2.0 관련 설정 및 보안 사항은 항상 최신 Google 공식 문서를 우선적으로 확인하세요.

- [Google OAuth 2.0 — 웹 서버 애플리케이션](https://developers.google.com/identity/protocols/oauth2/web-server?hl=ko)
- [Google OAuth 2.0 Scopes](https://developers.google.com/identity/protocols/oauth2/scopes?hl=ko)

Google의 OAuth 문서는 사용자가 필요한 범위(scope)만 요청하도록 하고, 웹 서버 애플리케이션에서는 적절한 OAuth 클라이언트 라이브러리를 사용하는 것을 권장합니다.

---

## 📄 License

프로젝트의 라이선스 정책은 저장소의 LICENSE 파일을 확인하세요.