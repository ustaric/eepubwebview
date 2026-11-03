/**
 * @file server.js
 * @description 개인용 Google Drive Refresh Token 및 자체 스토리지 제어 HTTP 서버 (ADMIN_PASSWORD 기반 관리자 보안 인증 탑재)
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { URL } from 'url';
import { config } from './config.js';
import { generateAuthUrl, verifyState, exchangeCodeForTokens, getFreshAccessToken } from './googleAuth.js';
import { hasRefreshToken } from './tokenStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_PATH = path.resolve(__dirname, '.env');

// 공식 깃허브 저장소 주소
const GITHUB_REPO_URL = 'https://github.com/ustaric/refresh-server';

// 🔒 [관리자 인증 세션] 유효 세션 토큰 저장소 (메모리 격리)
const adminSessionTokens = new Set();

/**
 * 🛡️ [Rate Limiting] 메모리 기반 IP별 요청 제한 저장소
 */
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 60;

setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimitMap.entries()) {
    if (now > data.resetTime) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000);

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

function checkRateLimit(req) {
  const ip = getClientIp(req);
  const now = Date.now();

  let record = rateLimitMap.get(ip);
  if (!record || now > record.resetTime) {
    record = { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(ip, record);
    return true;
  }

  record.count += 1;
  if (record.count > RATE_LIMIT_MAX_REQUESTS) {
    console.warn(`⚠️ [RateLimit Blocked] 과도한 요청 차단됨: IP ${ip} (요청 수: ${record.count})`);
    return false;
  }

  return true;
}

function setCorsHeaders(req, res) {
  const requestOrigin = req.headers.origin;
  const configuredOrigin = config.security.allowedOrigin;

  if (configuredOrigin === '*' || !configuredOrigin) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin || '*');
  } else {
    const allowedList = configuredOrigin.split(',').map((s) => s.trim());
    if (requestOrigin && allowedList.includes(requestOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', allowedList[0] || 'null');
    }
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJsonResponse(req, res, statusCode, payload) {
  setCorsHeaders(req, res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function sendHtmlResponse(req, res, statusCode, title, message, isSuccess = true) {
  setCorsHeaders(req, res);
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });

  const icon = isSuccess ? '✅' : '❌';
  const color = isSuccess ? '#10b981' : '#ef4444';
  const returnUrl = config.security.readerUrl || '/';

  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - EPUB Reader Auth</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background-color: #0f172a;
      color: #f8fafc;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 16px;
      box-sizing: border-box;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 32px;
      max-width: 480px;
      width: 100%;
      text-align: center;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);
    }
    .icon {
      font-size: 48px;
      margin-bottom: 16px;
    }
    h1 {
      font-size: 20px;
      margin: 0 0 12px 0;
      color: ${color};
    }
    p {
      color: #94a3b8;
      font-size: 14px;
      line-height: 1.6;
      margin: 0 0 24px 0;
      word-break: keep-all;
    }
    .btn {
      display: inline-block;
      background: #3b82f6;
      color: #ffffff;
      padding: 10px 20px;
      border-radius: 6px;
      text-decoration: none;
      font-size: 14px;
      font-weight: 500;
      transition: background 0.2s;
    }
    .btn:hover {
      background: #2563eb;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="${returnUrl}" class="btn">EPUB 서재로 돌아가기</a>
  </div>
</body>
</html>`;

  res.end(html);
}

/**
 * 📁 .env 파일 읽기 헬퍼
 */
function readEnvFile() {
  const envData = {};
  if (!fs.existsSync(ENV_PATH)) return envData;

  const content = fs.readFileSync(ENV_PATH, 'utf-8');
  content.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.substring(0, idx).trim();
      const val = trimmed.substring(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      envData[key] = val;
    }
  });
  return envData;
}

/**
 * 📁 .env 파일 쓰기 헬퍼 (ADMIN_PASSWORD 보존)
 */
function writeEnvFile(newValues) {
  const current = readEnvFile();
  const merged = { ...current, ...newValues };

  const lines = [
    `PORT=${merged.PORT || '3001'}`,
    `HOST=${merged.HOST || '127.0.0.1'}`,
    `GOOGLE_CLIENT_ID=${merged.GOOGLE_CLIENT_ID || ''}`,
    `GOOGLE_CLIENT_SECRET=${merged.GOOGLE_CLIENT_SECRET || ''}`,
    `GOOGLE_REDIRECT_URI=${merged.GOOGLE_REDIRECT_URI || ''}`,
    `TOKEN_ENCRYPTION_KEY=${merged.TOKEN_ENCRYPTION_KEY || ''}`,
    `TOKEN_FILE=${merged.TOKEN_FILE || './data/token.enc'}`,
    `ALLOWED_ORIGIN=${merged.ALLOWED_ORIGIN || '*'}`,
    `STORAGE_MODE=${merged.STORAGE_MODE === 'true' ? 'true' : 'false'}`,
    `ADMIN_PASSWORD=${merged.ADMIN_PASSWORD || ''}`
  ];

  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf-8');
}

/**
 * 📦 저장소 모드 필수 디렉터리 자동 생성 및 권한 세팅
 */
function ensureStorageDirectories() {
  const dirs = [
    path.resolve(__dirname, 'data'),
    path.resolve(__dirname, 'data/books'),
    path.resolve(__dirname, 'data/settings'),
    path.resolve(__dirname, 'data/archive')
  ];

  dirs.forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    }
  });
  console.log('📁 [StorageMode] 필수 저장소 디렉터리 검증 및 권한 세팅 완료 (./data/books, ./data/settings)');
}

/**
 * 🍪 요청 헤더에서 쿠키 파싱
 */
function parseCookies(req) {
  const list = {};
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return list;

  cookieHeader.split(';').forEach((cookie) => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
}

/**
 * 🔒 관리자 인증 세션 유효성 검사
 */
function isAuthenticated(req) {
  const env = readEnvFile();
  const adminPassword = env.ADMIN_PASSWORD;

  // 비밀번호가 아예 설정되지 않은 최초 상태면 로그인 페이지에서 등록 유도
  if (!adminPassword || adminPassword.trim() === '') {
    return false;
  }

  const cookies = parseCookies(req);
  const sessionToken = cookies['admin_session'];
  return Boolean(sessionToken && adminSessionTokens.has(sessionToken));
}

/**
 * 🔑 관리자 로그인 화면 렌더러
 */
function renderLoginPageHtml(errorMessage = null, isInitialSetup = false) {
  const title = isInitialSetup ? '🔒 관리자 비밀번호 최초 설정' : '🔑 관리자 로그인';
  const subtitle = isInitialSetup 
    ? '서버를 보호하기 위해 새 관리자 비밀번호를 먼저 등록하세요.' 
    : '서버 제어 센터에 접근하려면 관리자 비밀번호를 입력하세요.';

  let errorBanner = '';
  if (errorMessage) {
    errorBanner = `<div class="alert alert-error">❌ ${errorMessage}</div>`;
  }

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - EPUB Server</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --danger: #ef4444;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 16px;
      box-sizing: border-box;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 32px 24px;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);
      text-align: center;
    }
    .icon {
      font-size: 40px;
      margin-bottom: 12px;
    }
    h2 {
      margin: 0 0 8px 0;
      font-size: 20px;
    }
    p {
      color: var(--text-muted);
      font-size: 13px;
      margin: 0 0 20px 0;
      line-height: 1.5;
    }
    .alert {
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 16px;
      background: rgba(239, 68, 68, 0.15);
      color: var(--danger);
      border: 1px solid rgba(239, 68, 68, 0.3);
      text-align: left;
    }
    input[type="password"] {
      width: 100%;
      background: #0f172a;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      padding: 12px;
      font-size: 15px;
      box-sizing: border-box;
      outline: none;
      margin-bottom: 16px;
      transition: border-color 0.2s;
    }
    input[type="password"]:focus {
      border-color: var(--primary);
    }
    button {
      width: 100%;
      background: var(--primary);
      color: white;
      border: none;
      border-radius: 8px;
      padding: 12px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover {
      background: var(--primary-hover);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${isInitialSetup ? '🔒' : '🔑'}</div>
    <h2>${title}</h2>
    <p>${subtitle}</p>
    ${errorBanner}
    <form method="POST" action="/admin/login">
      <input type="password" name="password" placeholder="비밀번호 입력" required autofocus autocomplete="current-password">
      <button type="submit">${isInitialSetup ? '비밀번호 등록 및 대시보드 진입' : '대시보드 잠금 해제'}</button>
    </form>
  </div>
</body>
</html>`;
}

/**
 * 🎨 웹 설정 대시보드 HTML 렌더러
 */
function renderAdminSettingsHtml(req, successMessage = null, errorMessage = null) {
  const env = readEnvFile();
  const hasToken = hasRefreshToken();
  const isStorageMode = env.STORAGE_MODE === 'true';

  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || `${config.host}:${config.port}`;
  const currentServerUrl = `${protocol}://${host}`;

  const readerUrl = config.security.readerUrl || '/';
  const clientId = env.GOOGLE_CLIENT_ID || '';
  const redirectUri = env.GOOGLE_REDIRECT_URI || `${currentServerUrl}/auth/google/callback`;
  const allowedOrigin = env.ALLOWED_ORIGIN || '*';
  const hasSecret = Boolean(env.GOOGLE_CLIENT_SECRET);
  const hasKey = Boolean(env.TOKEN_ENCRYPTION_KEY);

  let alertBanner = '';
  if (successMessage) {
    alertBanner = `<div class="alert alert-success">✔ ${successMessage}</div>`;
  } else if (errorMessage) {
    alertBanner = `<div class="alert alert-error">❌ ${errorMessage}</div>`;
  }

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>⚙️ EPUB Server 제어 센터</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 24px 16px;
      display: flex;
      justify-content: center;
      min-height: 100vh;
      box-sizing: border-box;
    }
    .container {
      max-width: 640px;
      width: 100%;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
    }
    .header h1 {
      font-size: 22px;
      margin: 0 0 4px 0;
      font-weight: 700;
    }
    .header p {
      color: var(--text-muted);
      font-size: 13px;
      margin: 0;
    }
    .btn-logout {
      background: #334155;
      color: #f1f5f9;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 13px;
      text-decoration: none;
      transition: background 0.2s;
    }
    .btn-logout:hover {
      background: var(--danger);
      border-color: var(--danger);
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 24px;
      margin-bottom: 20px;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
    }
    .section-title {
      font-size: 16px;
      font-weight: 600;
      margin: 0 0 16px 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .badge {
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 9999px;
      font-weight: 500;
    }
    .badge-success { background: rgba(16, 185, 129, 0.15); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-warning { background: rgba(245, 158, 11, 0.15); color: var(--warning); border: 1px solid rgba(245, 158, 11, 0.3); }
    .badge-info { background: rgba(59, 130, 246, 0.15); color: var(--primary); border: 1px solid rgba(59, 130, 246, 0.3); }

    .copy-box {
      display: flex;
      align-items: center;
      background: #0f172a;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px 10px;
      margin-top: 6px;
    }
    .copy-text {
      flex: 1;
      font-family: monospace;
      font-size: 13px;
      color: #38bdf8;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .btn-copy {
      background: #334155;
      color: var(--text);
      border: none;
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      margin-left: 8px;
      transition: background 0.2s;
      flex-shrink: 0;
    }
    .btn-copy:hover {
      background: #475569;
    }
    .btn-copy.copied {
      background: var(--success);
      color: white;
    }

    .form-group {
      margin-bottom: 16px;
    }
    .form-group:last-child {
      margin-bottom: 0;
    }
    label {
      display: block;
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    input[type="text"], input[type="password"] {
      width: 100%;
      background: #0f172a;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      padding: 10px 12px;
      font-size: 14px;
      box-sizing: border-box;
      outline: none;
      transition: border-color 0.2s;
    }
    input[type="text"]:focus, input[type="password"]:focus {
      border-color: var(--primary);
    }

    .toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px;
      background: #0f172a;
      border: 1px solid var(--border);
      border-radius: 10px;
    }
    .toggle-info h4 {
      margin: 0 0 4px 0;
      font-size: 14px;
    }
    .toggle-info p {
      margin: 0;
      font-size: 12px;
      color: var(--text-muted);
    }
    .switch {
      position: relative;
      display: inline-block;
      width: 48px;
      height: 26px;
      flex-shrink: 0;
    }
    .switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .slider {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background-color: #334155;
      transition: .3s;
      border-radius: 34px;
    }
    .slider:before {
      position: absolute;
      content: "";
      height: 18px;
      width: 18px;
      left: 4px;
      bottom: 4px;
      background-color: white;
      transition: .3s;
      border-radius: 50%;
    }
    input:checked + .slider {
      background-color: var(--success);
    }
    input:checked + .slider:before {
      transform: translateX(22px);
    }

    .btn-submit {
      width: 100%;
      background: var(--primary);
      color: white;
      border: none;
      border-radius: 8px;
      padding: 12px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn-submit:hover {
      background: var(--primary-hover);
    }

    .btn-return {
      display: block;
      text-align: center;
      background: transparent;
      color: var(--text-muted);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
      font-size: 14px;
      text-decoration: none;
      margin-top: 12px;
      transition: all 0.2s;
    }
    .btn-return:hover {
      background: rgba(255,255,255,0.05);
      color: var(--text);
    }

    .alert {
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 14px;
      margin-bottom: 20px;
    }
    .alert-success {
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .alert-error {
      background: rgba(239, 68, 68, 0.15);
      color: var(--danger);
      border: 1px solid rgba(239, 68, 68, 0.3);
    }
    .oauth-btn {
      display: inline-block;
      background: #475569;
      color: #fff;
      padding: 8px 14px;
      border-radius: 6px;
      text-decoration: none;
      font-size: 13px;
      font-weight: 500;
      margin-top: 10px;
    }
    .oauth-btn:hover { background: #64748b; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1>⚙️ EPUB Server 제어 센터</h1>
        <p>Google OAuth 갱신 프록시 및 로컬 동기화 스토리지 통합 제어</p>
      </div>
      <a href="/admin/logout" class="btn-logout">🔒 로그아웃</a>
    </div>

    ${alertBanner}

    <!-- 🌟 원클릭 주요 주소 복사 카드 -->
    <div class="card">
      <div class="section-title">
        <span>📋 주요 접속 정보 원클릭 복사</span>
        <span class="badge badge-info">빠른 복사 지원</span>
      </div>

      <div class="form-group">
        <label>🐙 프로젝트 공식 GitHub 저장소</label>
        <div class="copy-box">
          <span class="copy-text" id="text-github">${GITHUB_REPO_URL}</span>
          <button type="button" class="btn-copy" onclick="copyToClipboard('${GITHUB_REPO_URL}', this)">복사</button>
        </div>
      </div>

      <div class="form-group">
        <label>🌐 현재 서버 주소 (웹 뷰어 설정창에 입력할 주소)</label>
        <div class="copy-box">
          <span class="copy-text" id="text-server">${currentServerUrl}</span>
          <button type="button" class="btn-copy" onclick="copyToClipboard('${currentServerUrl}', this)">복사</button>
        </div>
      </div>

      <div class="form-group">
        <label>🔗 구글 콘솔에 등록할 리디렉션 URI (Redirect URI)</label>
        <div class="copy-box">
          <span class="copy-text" id="text-redirect">${redirectUri}</span>
          <button type="button" class="btn-copy" onclick="copyToClipboard('${redirectUri}', this)">복사</button>
        </div>
      </div>
    </div>

    <form method="POST" action="/admin/save">
      <!-- 1. Google OAuth 인증 상태 및 재인증 -->
      <div class="card">
        <div class="section-title">
          <span>🔑 Google OAuth 토큰 상태</span>
          <span class="badge ${hasToken ? 'badge-success' : 'badge-warning'}">
            ${hasToken ? '토큰 보유 (정상)' : '미인증 (연동 필요)'}
          </span>
        </div>
        <p style="font-size: 13px; color: var(--text-muted); margin: 0 0 12px 0;">
          Google Drive 연동용 Refresh Token이 서버에 암호화되어 안전하게 보관되고 있는지 나타냅니다.
        </p>
        <a href="/auth/google" class="oauth-btn">🔗 Google 계정 로그인 / 재인증 시작</a>
      </div>

      <!-- 2. 스토리지 모드 선택 (저장소 기능 토글) -->
      <div class="card">
        <div class="section-title">
          <span>📁 개인 서버 저장소 모드 (Self-Hosted Storage)</span>
          <span class="badge ${isStorageMode ? 'badge-success' : 'badge-info'}">
            ${isStorageMode ? '로컬 저장소 활성' : '인증 프록시 모드'}
          </span>
        </div>

        <div class="toggle-row">
          <div class="toggle-info">
            <h4>개인 서버에 책/설정 직접 저장</h4>
            <p>체크 시 Google Drive 대신 이 서버의 디스크(./data/books)에 책과 진도율을 동기화합니다.</p>
          </div>
          <label class="switch">
            <input type="checkbox" name="STORAGE_MODE" value="true" ${isStorageMode ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        </div>
      </div>

      <!-- 3. 상세 환경변수 설정 (.env 연동) -->
      <div class="card">
        <div class="section-title">
          <span>🛠️ 시스템 상세 설정 (.env)</span>
        </div>

        <div class="form-group">
          <label>Google Client ID</label>
          <input type="text" name="GOOGLE_CLIENT_ID" value="${clientId}" placeholder="your-client-id.apps.googleusercontent.com">
        </div>

        <div class="form-group">
          <label>Google Client Secret ${hasSecret ? '<span style="color:var(--success); font-size:11px;">(현재 등록됨)</span>' : ''}</label>
          <input type="password" name="GOOGLE_CLIENT_SECRET" placeholder="${hasSecret ? '•••••••• (변경 시에만 새로 입력)' : 'GOCSPX-...'}" autocomplete="new-password">
        </div>

        <div class="form-group">
          <label>Google Redirect URI</label>
          <input type="text" name="GOOGLE_REDIRECT_URI" value="${redirectUri}" placeholder="https://내서버도메인/auth/google/callback">
        </div>

        <div class="form-group">
          <label>토큰 암호화 마스터 키 ${hasKey ? '<span style="color:var(--success); font-size:11px;">(현재 등록됨)</span>' : ''}</label>
          <input type="password" name="TOKEN_ENCRYPTION_KEY" placeholder="${hasKey ? '•••••••• (변경 시에만 새로 입력)' : '32자 이상의 무작위 비밀키'}" autocomplete="new-password">
        </div>

        <div class="form-group">
          <label>허용 웹 뷰어 Origin (CORS)</label>
          <input type="text" name="ALLOWED_ORIGIN" value="${allowedOrigin}" placeholder="https://내뷰어주소.vercel.app 또는 *">
        </div>

        <div class="form-group">
          <label>🔒 관리자 페이지 비밀번호 변경 (.env 자동 반영)</label>
          <input type="password" name="NEW_ADMIN_PASSWORD" placeholder="•••••••• (비밀번호 변경 시에만 새 비밀번호 입력)" autocomplete="new-password">
        </div>
      </div>

      <button type="submit" class="btn-submit">💾 설정 저장 및 환경 적용</button>
      <a href="${readerUrl}" class="btn-return">📖 EPUB 웹 서재로 돌아가기</a>
    </form>
  </div>

  <script>
    function copyToClipboard(text, btnElement) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          showCopiedEffect(btnElement);
        });
      } else {
        const tempInput = document.createElement('input');
        tempInput.value = text;
        document.body.appendChild(tempInput);
        tempInput.select();
        document.execCommand('copy');
        document.body.removeChild(tempInput);
        showCopiedEffect(btnElement);
      }
    }

    function showCopiedEffect(btn) {
      const originalText = btn.textContent;
      btn.textContent = '✔ 복사됨!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = originalText;
        btn.classList.remove('copied');
      }, 1800);
    }
  </script>
</body>
</html>`;
}

/**
 * HTTP 요청 라우터
 */
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || `${config.host}:${config.port}`;
  const reqUrl = new URL(req.url, `${protocol}://${host}`);
  const pathname = reqUrl.pathname;

  console.log(`[Request] ${req.method} ${pathname} (IP: ${getClientIp(req)})`);

  // 1. 서버 헬스체크
  if (req.method === 'GET' && pathname === '/api/health') {
    const env = readEnvFile();
    return sendJsonResponse(req, res, 200, {
      ok: true,
      service: 'gdrive-refresh-server',
      hasToken: hasRefreshToken(),
      storageMode: env.STORAGE_MODE === 'true',
      timestamp: new Date().toISOString()
    });
  }

  // 2. 🌟 관리자 로그인 처리 (POST /admin/login)
  if (req.method === 'POST' && pathname === '/admin/login') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const inputPass = params.get('password')?.trim() || '';
      const env = readEnvFile();
      const currentPass = env.ADMIN_PASSWORD;

      // 1) 최초 설정인 경우: 입력된 비밀번호를 .env에 즉시 저장하고 세션 발급
      if (!currentPass || currentPass.trim() === '') {
        if (!inputPass) {
          const html = renderLoginPageHtml('비밀번호를 입력해 주세요.', true);
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }

        writeEnvFile({ ADMIN_PASSWORD: inputPass });
        console.log('🔒 [Admin] 신규 관리자 비밀번호가 .env에 영구 등록되었습니다.');

        const sessionToken = crypto.randomBytes(32).toString('hex');
        adminSessionTokens.add(sessionToken);

        res.writeHead(302, {
          'Set-Cookie': `admin_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
          'Location': '/admin'
        });
        res.end();
        return;
      }

      // 2) 기존 비밀번호 검증
      if (inputPass === currentPass) {
        const sessionToken = crypto.randomBytes(32).toString('hex');
        adminSessionTokens.add(sessionToken);

        res.writeHead(302, {
          'Set-Cookie': `admin_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
          'Location': '/admin'
        });
        res.end();
      } else {
        const html = renderLoginPageHtml('비밀번호가 올바르지 않습니다.', false);
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      }
    });
    return;
  }

  // 3. 🌟 관리자 로그아웃 처리 (GET /admin/logout)
  if (req.method === 'GET' && pathname === '/admin/logout') {
    const cookies = parseCookies(req);
    const sessionToken = cookies['admin_session'];
    if (sessionToken) {
      adminSessionTokens.delete(sessionToken);
    }
    res.writeHead(302, {
      'Set-Cookie': 'admin_session=; Path=/; HttpOnly; Max-Age=0',
      'Location': '/admin'
    });
    res.end();
    return;
  }

  // 4. 🌟 관리자 제어 대시보드 화면 서빙 (GET /admin 및 GET /settings)
  if (req.method === 'GET' && (pathname === '/admin' || pathname === '/settings')) {
    const env = readEnvFile();
    const isInitialSetup = !env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.trim() === '';

    // 인증되지 않았으면 로그인(또는 최초 설정) 화면 표시
    if (!isAuthenticated(req)) {
      const html = renderLoginPageHtml(null, isInitialSetup);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    const html = renderAdminSettingsHtml(req);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // 5. 🌟 웹 관리자 설정 저장 처리 (POST /admin/save - 인증 필수)
  if (req.method === 'POST' && pathname === '/admin/save') {
    if (!isAuthenticated(req)) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const updates = {};

        const isStorageMode = params.get('STORAGE_MODE') === 'true';
        updates.STORAGE_MODE = isStorageMode ? 'true' : 'false';

        const clientId = params.get('GOOGLE_CLIENT_ID')?.trim();
        if (clientId) updates.GOOGLE_CLIENT_ID = clientId;

        const clientSecret = params.get('GOOGLE_CLIENT_SECRET')?.trim();
        if (clientSecret) updates.GOOGLE_CLIENT_SECRET = clientSecret;

        const redirectUri = params.get('GOOGLE_REDIRECT_URI')?.trim();
        if (redirectUri) updates.GOOGLE_REDIRECT_URI = redirectUri;

        const encKey = params.get('TOKEN_ENCRYPTION_KEY')?.trim();
        if (encKey) updates.TOKEN_ENCRYPTION_KEY = encKey;

        const origin = params.get('ALLOWED_ORIGIN')?.trim();
        if (origin) updates.ALLOWED_ORIGIN = origin;

        const newAdminPassword = params.get('NEW_ADMIN_PASSWORD')?.trim();
        if (newAdminPassword) {
          updates.ADMIN_PASSWORD = newAdminPassword;
          console.log('🔒 [Admin] 관리자 비밀번호가 새 비밀번호로 갱신되었습니다.');
        }

        writeEnvFile(updates);

        if (isStorageMode) {
          ensureStorageDirectories();
        }

        const successMsg = isStorageMode
          ? '설정이 저장되었습니다! 도서 로컬 저장소(./data/books)가 자동으로 활성화되었습니다.'
          : '설정이 성공적으로 저장되었습니다. (인증 프록시 모드)';

        const html = renderAdminSettingsHtml(req, successMsg);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        console.error('[Admin Save Error]', err);
        const html = renderAdminSettingsHtml(req, null, '설정 저장 중 오류가 발생했습니다: ' + err.message);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      }
    });
    return;
  }

  // 6. Google OAuth 로그인 시작
  if (req.method === 'GET' && pathname === '/auth/google') {
    try {
      const authUrl = generateAuthUrl();
      res.writeHead(302, { Location: authUrl });
      res.end();
      return;
    } catch (err) {
      console.error('[OAuth Init Error]', err.message);
      return sendHtmlResponse(req, res, 500, '로그인 시작 오류', 'Google 로그인 URL을 생성하지 못했습니다. 설정 값을 확인해 주세요.', false);
    }
  }

  // 7. Google OAuth 콜백 처리
  if (req.method === 'GET' && pathname === '/auth/google/callback') {
    const code = reqUrl.searchParams.get('code');
    const state = reqUrl.searchParams.get('state');
    const error = reqUrl.searchParams.get('error');

    if (error) {
      console.error('[OAuth Callback Error]', error);
      return sendHtmlResponse(req, res, 400, 'Google 승인 거부', `Google 인증이 거부되었습니다: ${error}`, false);
    }

    if (!state || !verifyState(state)) {
      console.error('[OAuth State Mismatch] State 검증 실패');
      return sendHtmlResponse(req, res, 400, '인증 실패 (State 검증 실패)', '보안 검증(State)에 실패했습니다. 다시 시도해 주세요.', false);
    }

    if (!code) {
      return sendHtmlResponse(req, res, 400, '인증 코드 누락', 'Google로부터 Authorization Code를 수신하지 못했습니다.', false);
    }

    try {
      await exchangeCodeForTokens(code);
      return sendHtmlResponse(
        req,
        res,
        200,
        'Google Drive 연동 성공',
        'Google Drive 인증 정보가 서버에 안전하게 암호화되어 저장되었습니다. 이제 웹 뷰어에서 클라우드 동기화 기능을 사용할 수 있습니다.',
        true
      );
    } catch (err) {
      console.error('[OAuth Exchange Failed]', err.message);
      return sendHtmlResponse(req, res, 500, '토큰 교환 실패', `인증 토큰을 저장하지 못했습니다: ${err.message}`, false);
    }
  }

  // 8. Access Token 발급 요청
  if (req.method === 'GET' && pathname === '/api/access-token') {
    if (!checkRateLimit(req)) {
      return sendJsonResponse(req, res, 429, {
        error: '요청 횟수가 초과되었습니다. 잠시 후 다시 시도해 주세요.'
      });
    }

    try {
      const tokenPayload = await getFreshAccessToken();
      return sendJsonResponse(req, res, 200, tokenPayload);
    } catch (err) {
      const statusCode = err.status || 500;
      const clientMessage = statusCode === 401
        ? 'Google 계정 연동이 필요합니다. 먼저 /auth/google 을 통해 인증해 주세요.'
        : 'Access Token 발급에 실패했습니다.';

      return sendJsonResponse(req, res, statusCode, {
        error: clientMessage
      });
    }
  }

  // 기본 루트 접속 시 관리자 대시보드로 이동
  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(302, { Location: '/admin' });
    res.end();
    return;
  }

  return sendJsonResponse(req, res, 404, { error: 'Not Found' });
});

server.listen(config.port, config.host, () => {
  console.log('====================================================');
  console.log(`🚀 Personal EPUB Server 가 구동되었습니다.`);
  console.log(`   - 바인딩: http://${config.host}:${config.port}`);
  console.log(`   - 제어 센터: http://${config.host}:${config.port}/admin`);
  console.log(`   - 토큰 상태: ${hasRefreshToken() ? '저장됨 ✅' : '미등록 (로그인 필요 ⚠️)'}`);
  console.log('====================================================');
});