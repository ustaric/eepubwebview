/**
 * @file server.js
 * @description 개인용 Google Drive Refresh Token 및 자체 스토리지 제어 통합 HTTP 서버
 * - 📁 모듈 분리: src/envManager.js, src/adminController.js, src/storageService.js, src/auditLogger.js 조립
 * - 🛡️ [출처 검증 가드] ALLOWED_ORIGIN 기반 브라우저 Origin/Referer 검증으로 외부 비인가 스크립트 차단
 * - 🚦 [지능형 Rate Limit] 관리자 로그인 1분 5회 락 & 스토리지 API 1분 120회 폭주 방어
 * - 📊 [실시간 활동 로깅 Hook 탑재] auditLogger 연동으로 스냅샷, EPUB 다운로드, 표지 삭제, 차단 활동 링 버퍼 기록
 * - 🛠️ [환경변수 전 항목 완비] PORT, HOST, READER_URL, TOKEN_FILE 포함 전 11대 설정값 실시간 파싱 및 보존
 * - ⚡ 자체 스토리지 모드 REST API 엔드포인트 완비 (/api/storage/...)
 */

import http from 'http';
import fs from 'fs';
import { URL } from 'url';
import { config } from './config.js';
import { generateAuthUrl, verifyState, exchangeCodeForTokens, getFreshAccessToken } from './googleAuth.js';
import { hasRefreshToken } from './tokenStore.js';

// 🌟 분리된 4대 전담 모듈 import
import { readEnvFile, writeEnvFile, ensureStorageDirectories } from './src/envManager.js';
import {
  isAuthenticated,
  createAdminSession,
  destroyAdminSession,
  parseCookies,
  renderLoginPageHtml,
  renderAdminSettingsHtml
} from './src/adminController.js';
import { storageService } from './src/storageService.js';
import { auditLogger } from './src/auditLogger.js';

/**
 * 🛡️ [Rate Limiting] 메모리 기반 IP별 요청 제한 저장소
 */
const rateLimitMap = new Map();
const loginAttemptMap = new Map();

// 주기적 메모리 청소 (5분 간격)
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimitMap.entries()) {
    if (now > data.resetTime) rateLimitMap.delete(ip);
  }
  for (const [ip, data] of loginAttemptMap.entries()) {
    if (now > data.resetTime) loginAttemptMap.delete(ip);
  }
}, 5 * 60 * 1000);

/**
 * 클라이언트 실제 IP 추출
 * @param {http.IncomingMessage} req 
 * @returns {string}
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

/**
 * 일반 엔드포인트 및 스토리지 API 요청 속도 제한 (1분당 120회)
 * @param {http.IncomingMessage} req 
 * @param {number} [maxRequests=120]
 * @returns {boolean} 허용 여부
 */
function checkRateLimit(req, maxRequests = 120) {
  const ip = getClientIp(req);
  const now = Date.now();
  const windowMs = 60 * 1000;

  let record = rateLimitMap.get(ip);
  if (!record || now > record.resetTime) {
    record = { count: 1, resetTime: now + windowMs };
    rateLimitMap.set(ip, record);
    return true;
  }

  record.count += 1;
  if (record.count > maxRequests) {
    console.warn(`⚠️ [RateLimit Blocked] 과도한 요청 차단됨: IP ${ip} (요청 수: ${record.count})`);
    return false;
  }

  return true;
}

/**
 * 🔒 [관리자 로그인 전용 브루트포스 차단] 1분 내 5회 실패 시 15분간 차단
 * @param {string} ip 
 * @returns {{ allowed: boolean, remainingAttempts: number, waitMinutes?: number }}
 */
function checkLoginRateLimit(ip) {
  const now = Date.now();
  const record = loginAttemptMap.get(ip);

  if (!record) return { allowed: true, remainingAttempts: 5 };

  if (record.blockedUntil && now < record.blockedUntil) {
    const waitMinutes = Math.ceil((record.blockedUntil - now) / (60 * 1000));
    return { allowed: false, remainingAttempts: 0, waitMinutes };
  }

  if (now > record.resetTime) {
    loginAttemptMap.delete(ip);
    return { allowed: true, remainingAttempts: 5 };
  }

  if (record.failCount >= 5) {
    record.blockedUntil = now + (15 * 60 * 1000); // 15분 차단
    return { allowed: false, remainingAttempts: 0, waitMinutes: 15 };
  }

  return { allowed: true, remainingAttempts: 5 - record.failCount };
}

/**
 * 관리자 로그인 실패 횟수 기록
 * @param {string} ip 
 */
function recordLoginFailure(ip) {
  const now = Date.now();
  let record = loginAttemptMap.get(ip);
  if (!record || now > record.resetTime) {
    record = { failCount: 1, resetTime: now + (60 * 1000), blockedUntil: 0 };
  } else {
    record.failCount += 1;
  }
  loginAttemptMap.set(ip, record);
}

/**
 * 관리자 로그인 성공 시 실패 기록 초기화
 * @param {string} ip 
 */
function clearLoginFailure(ip) {
  loginAttemptMap.delete(ip);
}

/**
 * 🛡️ [출처 검증 가드] ALLOWED_ORIGIN 기반 웹 뷰어 Origin / Referer 검증
 * @param {http.IncomingMessage} req 
 * @returns {boolean}
 */
function isAllowedClientOrigin(req) {
  const env = readEnvFile();
  const allowedConfig = env.ALLOWED_ORIGIN || config.security.allowedOrigin;

  if (!allowedConfig || allowedConfig === '*') return true;

  const allowedList = allowedConfig.split(',').map((s) => s.trim().toLowerCase());

  // 1. Origin 헤더 검사
  const origin = req.headers.origin;
  if (origin) {
    return allowedList.includes(origin.toLowerCase());
  }

  // 2. Referer 헤더 검사 (GET 다운로드 또는 직접 탐색 시)
  const referer = req.headers.referer;
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      const refererOrigin = refererUrl.origin.toLowerCase();
      return allowedList.includes(refererOrigin);
    } catch (e) {
      return false;
    }
  }

  // Origin과 Referer가 둘 다 없는 경우 (동일 서버 직접 호출이 아니면 차단)
  const secFetchSite = req.headers['sec-fetch-site'];
  if (secFetchSite === 'same-origin') return true;

  return false;
}

/**
 * CORS 응답 헤더 세팅
 * @param {http.IncomingMessage} req 
 * @param {http.ServerResponse} res 
 */
function setCorsHeaders(req, res) {
  const requestOrigin = req.headers.origin;
  const env = readEnvFile();
  const configuredOrigin = env.ALLOWED_ORIGIN || config.security.allowedOrigin;

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

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/**
 * JSON 응답 전송 헬퍼
 */
function sendJsonResponse(req, res, statusCode, payload) {
  setCorsHeaders(req, res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

/**
 * 안내 HTML 응답 전송 헬퍼
 */
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
 * HTTP 요청 Body 버퍼 수신 헬퍼 (최대 100MB 안전 제한)
 * @param {http.IncomingMessage} req 
 * @param {number} [maxBytes=104857600] 100MB
 * @returns {Promise<Buffer>}
 */
function readRequestBodyBuffer(req, maxBytes = 104857600) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;

    req.on('data', chunk => {
      received += chunk.length;
      if (received > maxBytes) {
        req.destroy();
        reject(new Error(`요청 크기가 한도(${maxBytes / 1024 / 1024}MB)를 초과했습니다.`));
      } else {
        chunks.push(chunk);
      }
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', err => reject(err));
  });
}

/**
 * HTTP 요청 Router
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
  const clientIp = getClientIp(req);
  const userAgent = req.headers['user-agent'] || '';

  console.log(`[Request] ${req.method} ${pathname} (IP: ${clientIp})`);

  // =========================================================================
  // 1. 서버 헬스체크
  // =========================================================================
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

  // =========================================================================
  // 2. 관리자 인증 & 대시보드 라우트 (src/adminController 위임)
  // =========================================================================
  if (req.method === 'POST' && pathname === '/admin/login') {
    const loginGuard = checkLoginRateLimit(clientIp);
    if (!loginGuard.allowed) {
      console.warn(`⛔ [Login Lock] 무차별 대입 방어로 IP ${clientIp} 차단 중 (${loginGuard.waitMinutes}분 남음)`);
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '관리자 로그인 시도', target: '차단 잠금', status: 429 });
      const html = renderLoginPageHtml(`로그인 시도 횟수가 초과되었습니다. ${loginGuard.waitMinutes}분 후에 다시 시도해 주세요.`, false);
      res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const inputPass = params.get('password')?.trim() || '';
      const env = readEnvFile();
      const currentPass = env.ADMIN_PASSWORD;

      if (!currentPass || currentPass.trim() === '') {
        if (!inputPass) {
          const html = renderLoginPageHtml('비밀번호를 입력해 주세요.', true);
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }

        writeEnvFile({ ADMIN_PASSWORD: inputPass });
        console.log('🔒 [Admin] 신규 관리자 비밀번호가 .env에 영구 등록되었습니다.');
        clearLoginFailure(clientIp);
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '관리자 비밀번호 설정', target: '최초 등록', status: 200 });

        const sessionToken = createAdminSession();
        res.writeHead(302, {
          'Set-Cookie': `admin_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
          'Location': '/admin'
        });
        res.end();
        return;
      }

      if (inputPass === currentPass) {
        clearLoginFailure(clientIp);
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '관리자 로그인 성공', target: '대시보드 진입', status: 200 });
        const sessionToken = createAdminSession();
        res.writeHead(302, {
          'Set-Cookie': `admin_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
          'Location': '/admin'
        });
        res.end();
      } else {
        recordLoginFailure(clientIp);
        const remaining = 5 - (loginAttemptMap.get(clientIp)?.failCount || 0);
        console.warn(`⚠️ [Login Failed] 관리자 비밀번호 불일치 (IP: ${clientIp}, 잔여 시도: ${Math.max(0, remaining)}회)`);
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '관리자 로그인 실패', target: `비번 오류 (남은시도: ${Math.max(0, remaining)})`, status: 401 });
        const html = renderLoginPageHtml(`비밀번호가 올바르지 않습니다. (남은 시도: ${Math.max(0, remaining)}회)`, false);
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      }
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/admin/logout') {
    const cookies = parseCookies(req);
    destroyAdminSession(cookies['admin_session']);
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '관리자 로그아웃', target: '세션 파기', status: 200 });
    res.writeHead(302, {
      'Set-Cookie': 'admin_session=; Path=/; HttpOnly; Max-Age=0',
      'Location': '/admin'
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && (pathname === '/admin' || pathname === '/settings')) {
    const env = readEnvFile();
    const isInitialSetup = !env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.trim() === '';

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

  // 🔬 [관리자 전용] 크래시 리포트 다운로드 라우트
  if (req.method === 'GET' && pathname.startsWith('/admin/crash-reports/download/')) {
    if (!isAuthenticated(req)) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return;
    }

    const fileName = decodeURIComponent(pathname.replace('/admin/crash-reports/download/', ''));
    const info = storageService.getCrashReportPath(fileName);
    if (!info) {
      return sendJsonResponse(req, res, 404, { error: '크래시 리포트 파일을 찾을 수 없습니다.' });
    }

    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '크래시 리포트 다운로드', target: fileName, status: 200 });
    setCorsHeaders(req, res);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': info.size,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`
    });
    const readStream = fs.createReadStream(info.filePath);
    readStream.pipe(res);
    return;
  }

  // 🔬 [관리자 전용] 크래시 리포트 단일 삭제 라우트
  if (req.method === 'GET' && pathname.startsWith('/admin/crash-reports/delete/')) {
    if (!isAuthenticated(req)) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return;
    }

    const fileName = decodeURIComponent(pathname.replace('/admin/crash-reports/delete/', ''));
    storageService.deleteCrashReport(fileName);
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '크래시 리포트 삭제', target: fileName, status: 200 });
    res.writeHead(302, { Location: '/admin' });
    res.end();
    return;
  }

  // 🔬 [관리자 전용] 크래시 리포트 전체 비우기 라우트
  if (req.method === 'GET' && pathname === '/admin/crash-reports/clear') {
    if (!isAuthenticated(req)) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return;
    }

    storageService.clearAllCrashReports();
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '크래시 리포트 전체 삭제', target: 'all', status: 200 });
    res.writeHead(302, { Location: '/admin' });
    res.end();
    return;
  }

  // 🛠️ [환경변수 전체 파싱 및 저장] POST /admin/save
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

        // 🌟 [추가 1] 네트워크 및 파일 경로 4대 기본 설정
        const port = params.get('PORT')?.trim();
        if (port) updates.PORT = port;

        const host = params.get('HOST')?.trim();
        if (host) updates.HOST = host;

        const tokenFile = params.get('TOKEN_FILE')?.trim();
        if (tokenFile) updates.TOKEN_FILE = tokenFile;

        const readerUrl = params.get('READER_URL')?.trim();
        if (readerUrl) updates.READER_URL = readerUrl;

        // 🌟 [기존 6대 설정]
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
          console.log('🔒 [Admin] 관리자 비밀번호가 갱신되었습니다.');
        }

        writeEnvFile(updates);

        if (isStorageMode) {
          ensureStorageDirectories();
        }

        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '시스템 설정 저장', target: '.env 전체 갱신', status: 200 });

        const successMsg = isStorageMode
          ? '설정이 저장되었습니다! 도서 로컬 저장소(./data/books)가 활성화되었습니다.'
          : '설정이 성공적으로 저장되었습니다. (인증 프록시 모드)';

        const html = renderAdminSettingsHtml(req, successMsg);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        console.error('[Admin Save Error]', err);
        const html = renderAdminSettingsHtml(req, null, '설정 저장 오류: ' + err.message);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      }
    });
    return;
  }

  // =========================================================================
  // 3. 🌟 자체 스토리지 모드 REST API 엔드포인트 (src/storageService 위임)
  // =========================================================================

  // 🔬 [크래시 리포트 수신] POST /api/storage/crash-reports/:fileName (항상 수신 보장)
  if (req.method === 'POST' && pathname.startsWith('/api/storage/crash-reports/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/crash-reports/', ''));
    try {
      const buffer = await readRequestBodyBuffer(req);
      const reportData = JSON.parse(buffer.toString('utf-8'));
      storageService.saveCrashReport(fileName, reportData);
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '크래시 리포트 수신', target: fileName, status: 200 });
      return sendJsonResponse(req, res, 200, { ok: true, fileName, status: 'saved' });
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '크래시 리포트 저장 실패', target: fileName, status: 500 });
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

  // 🛡️ [스토리지 엔드포인트 보안 가드 1] 속도 제한 (Rate Limiting: 1분 120회)
  if (pathname.startsWith('/api/storage/')) {
    if (!checkRateLimit(req, 120)) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '요청 횟수 초과 차단', target: pathname, status: 429 });
      return sendJsonResponse(req, res, 429, {
        error: 'RATE_LIMIT_EXCEEDED: 요청 횟수가 초과되었습니다. 잠시 후 다시 시도해 주세요.'
      });
    }
  }

  // 🛡️ [스토리지 엔드포인트 보안 가드 2] 허용된 웹 뷰어 Origin / Referer 검증
  if (pathname.startsWith('/api/storage/')) {
    if (!isAllowedClientOrigin(req)) {
      console.warn(`⛔ [Origin Blocked] 비인가 클라이언트의 스토리지 접근 차단됨 (IP: ${clientIp}, Origin: ${req.headers.origin}, Referer: ${req.headers.referer})`);
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '비인가 출처 차단', target: pathname, status: 403 });
      return sendJsonResponse(req, res, 403, {
        error: 'FORBIDDEN_ORIGIN: 승인되지 않은 도메인에서의 스토리지 접근입니다.'
      });
    }
  }

  // 🛡️ [스토리지 엔드포인트 보안 가드 3] STORAGE_MODE 검증 가드
  if (pathname.startsWith('/api/storage/')) {
    const env = readEnvFile();
    if (env.STORAGE_MODE !== 'true') {
      console.warn(`⛔ [Storage Blocked] 개인 서버 저장소 모드가 비활성화되어 요청이 거부되었습니다. Path: ${pathname}`);
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '스토리지 모드 비활성 거절', target: pathname, status: 403 });
      return sendJsonResponse(req, res, 403, {
        error: 'STORAGE_MODE_DISABLED: 개인 서버 저장소 모드가 비활성화되어 있습니다. 관리자 대시보드(/admin)에서 활성화해 주세요.'
      });
    }
  }

  // ⚡ [올인원 통합 스냅샷 단일 쿼리] GET /api/storage/snapshot
  if (req.method === 'GET' && pathname === '/api/storage/snapshot') {
    try {
      const snapshot = await storageService.getUnifiedSnapshot();
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '📚 서재 스냅샷 조회', target: `활성 ${snapshot.cloudBooks.length}권 / 보관 ${snapshot.cloudArchivedBooks.length}권`, status: 200 });
      return sendJsonResponse(req, res, 200, snapshot);
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '서재 스냅샷 실패', target: err.message, status: 500 });
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

  // 📖 [도서 메타데이터 JSON 저장] POST /api/storage/books/:id
  if (req.method === 'POST' && pathname.startsWith('/api/storage/books/') && !pathname.endsWith('/epub')) {
    const bookId = decodeURIComponent(pathname.replace('/api/storage/books/', ''));
    try {
      const buffer = await readRequestBodyBuffer(req);
      const bookData = JSON.parse(buffer.toString('utf-8'));
      storageService.saveBookMetadata(bookId, bookData);
      const actionName = bookData.isArchived ? '📁 도서 보관 처리' : '📖 도서 메타 저장';
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: actionName, target: bookData.title || bookId, status: 200 });
      return sendJsonResponse(req, res, 200, { ok: true, bookId });
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '도서 메타 저장 실패', target: bookId, status: 500 });
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

  // 📖 [도서 메타데이터 JSON 조회] GET /api/storage/books/:id
  if (req.method === 'GET' && pathname.startsWith('/api/storage/books/') && !pathname.endsWith('/epub')) {
    const bookId = decodeURIComponent(pathname.replace('/api/storage/books/', ''));
    const meta = storageService.getBookMetadata(bookId);
    if (!meta) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '도서 메타 조회 실패', target: bookId, status: 404 });
      return sendJsonResponse(req, res, 404, { error: '도서를 찾을 수 없습니다.' });
    }
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '도서 메타 조회', target: meta.title || bookId, status: 200 });
    return sendJsonResponse(req, res, 200, meta);
  }

  // 📦 [EPUB 바이너리 파일 업로드] POST /api/storage/books/:id/epub
  if (req.method === 'POST' && pathname.startsWith('/api/storage/books/') && pathname.endsWith('/epub')) {
    const bookId = decodeURIComponent(pathname.replace('/api/storage/books/', '').replace('/epub', ''));
    try {
      const buffer = await readRequestBodyBuffer(req);
      storageService.saveBookEpub(bookId, buffer);
      const sizeMb = (buffer.length / 1024 / 1024).toFixed(1);
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '📦 EPUB 업로드', target: `${bookId} (${sizeMb}MB)`, status: 200 });
      return sendJsonResponse(req, res, 200, { ok: true, bookId, size: buffer.length });
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'EPUB 업로드 실패', target: bookId, status: 500 });
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

  // 📦 [EPUB 바이너리 파일 스트리밍 다운로드] GET /api/storage/books/:id/epub
  if (req.method === 'GET' && pathname.startsWith('/api/storage/books/') && pathname.endsWith('/epub')) {
    const bookId = decodeURIComponent(pathname.replace('/api/storage/books/', '').replace('/epub', ''));
    const info = storageService.getBookEpubPath(bookId);
    if (!info) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'EPUB 다운로드 실패', target: bookId, status: 404 });
      return sendJsonResponse(req, res, 404, { error: 'EPUB 파일을 찾을 수 없습니다.' });
    }

    const sizeMb = (info.size / 1024 / 1024).toFixed(1);
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '📖 EPUB 다운로드', target: `${bookId} (${sizeMb}MB)`, status: 200 });

    setCorsHeaders(req, res);
    res.writeHead(200, {
      'Content-Type': 'application/epub+zip',
      'Content-Length': info.size,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(bookId)}.epub"`
    });
    const readStream = fs.createReadStream(info.filePath);
    readStream.pipe(res);
    return;
  }

  // 🖼️ [표지 이미지 업로드] POST /api/storage/covers/:fileName
  if (req.method === 'POST' && pathname.startsWith('/api/storage/covers/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/covers/', ''));
    try {
      const buffer = await readRequestBodyBuffer(req);
      storageService.saveCoverImage(fileName, buffer);
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '🖼️ 표지 업로드', target: fileName, status: 200 });
      return sendJsonResponse(req, res, 200, { ok: true, fileName });
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '표지 업로드 실패', target: fileName, status: 500 });
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

  // 🖼️ [표지 이미지 다운로드] GET /api/storage/covers/:fileName
  if (req.method === 'GET' && pathname.startsWith('/api/storage/covers/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/covers/', ''));
    const info = storageService.getCoverImagePath(fileName);
    if (!info) {
      return sendJsonResponse(req, res, 404, { error: '표지를 찾을 수 없습니다.' });
    }

    setCorsHeaders(req, res);
    res.writeHead(200, {
      'Content-Type': 'image/webp',
      'Content-Length': info.size
    });
    const readStream = fs.createReadStream(info.filePath);
    readStream.pipe(res);
    return;
  }

  // 🖼️ [표지 이미지 단일 삭제] DELETE /api/storage/covers/:fileName
  if (req.method === 'DELETE' && pathname.startsWith('/api/storage/covers/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/covers/', ''));
    storageService.deleteCoverImage(fileName);
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '🖼️ 표지 단일 삭제', target: fileName, status: 200 });
    return sendJsonResponse(req, res, 200, { ok: true, fileName });
  }

  // 🗑️ [도서 완전 삭제 트랜잭션] DELETE /api/storage/books/:id
  if (req.method === 'DELETE' && pathname.startsWith('/api/storage/books/')) {
    const bookId = decodeURIComponent(pathname.replace('/api/storage/books/', ''));
    const count = storageService.deleteBookAll(bookId);
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '🗑️ 도서 완전 삭제', target: `${bookId} (${count}개 파일 파쇄)`, status: 200 });
    return sendJsonResponse(req, res, 200, { ok: true, deletedFiles: count });
  }

  // ⚙️ [설정/통계/업적/묘비 JSON 저장] POST /api/storage/settings/:fileName
  if (req.method === 'POST' && pathname.startsWith('/api/storage/settings/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/settings/', ''));
    try {
      const buffer = await readRequestBodyBuffer(req);
      const data = JSON.parse(buffer.toString('utf-8'));
      storageService.saveSettingsFile(fileName, data);
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '⚙️ 시스템 데이터 동기화', target: fileName, status: 200 });
      return sendJsonResponse(req, res, 200, { ok: true, fileName });
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '시스템 동기화 실패', target: fileName, status: 500 });
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

  // ⚙️ [설정/통계/업적/묘비 JSON 조회] GET /api/storage/settings/:fileName
  if (req.method === 'GET' && pathname.startsWith('/api/storage/settings/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/settings/', ''));
    const data = storageService.getSettingsFile(fileName);
    if (!data) return sendJsonResponse(req, res, 404, { error: '설정 파일을 찾을 수 없습니다.' });
    return sendJsonResponse(req, res, 200, data);
  }

  // =========================================================================
  // 4. 기존 Google OAuth 인증 라우트 (하위 호환 100% 보존)
  // =========================================================================
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
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'Google OAuth 토큰 교환 성공', target: '토큰 암호화 저장', status: 200 });
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

  if (req.method === 'GET' && pathname === '/api/access-token') {
    if (!checkRateLimit(req, 60)) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '토큰 발급 횟수 초과', target: '/api/access-token', status: 429 });
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

      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '토큰 발급 실패', target: clientMessage, status: statusCode });
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
  console.log(`   - 허용 출처: ${config.security.allowedOrigin}`);
  console.log(`   - 토큰 상태: ${hasRefreshToken() ? '저장됨 ✅' : '미등록 (로그인 필요 ⚠️)'}`);
  console.log('====================================================');
});