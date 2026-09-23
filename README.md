# 🔑 Personal Google Drive Refresh Token Server

EPUB Web Viewer 사용자를 위한 초경량 전용 Google OAuth Refresh Token 서버입니다.
사용자의 개인 서버(Oracle Linux, Synology, NAS 등)에서 구동되며, Google Drive 연동 시 1시간마다 만료되는 Access Token을 자동으로 무중단 갱신합니다.

---

## 🛠️ 요구사항 (Requirements)

- **Node.js**: v18.0.0 이상
- **Google Cloud Console**: OAuth 2.0 Client ID 및 Client Secret

---

## 📦 설치 및 준비 (Installation)

```bash
# refresh-server 디렉터리로 이동
cd refresh-server

# 의존성 패키지 설치
npm install