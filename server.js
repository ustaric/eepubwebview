/**
 * @file server.js
 * @description 개인용 Google Drive Refresh Token 및 자체 스토리지 제어 통합 HTTP 서버
 * - 📁 모듈 분리: src/envManager.js, src/adminController.js, src/storageService.js 조립
 * - 🛡️ [STORAGE_MODE 검증 가드] 어드민 설정(STORAGE_MODE=true) 활성 시에만 로컬 도서 저장 허용 (비활성 시 403 차단)
 * - 🔬 [크래시 리포트 수신 & 웹 다운로드 센터] 클라이언트 진단 JSON 수신 및 어드민 웹 원클릭 다운로드/삭제 완비
 * - ⚡ 자체 스토리지 모드 REST API 엔드포인트 완비 (/api/storage/...)
 */

import http from 'http';
import fs from 'fs';
import { URL } from 'url';
import { config } from './config.js';
import { generateAuthUrl, verifyState, exchangeCodeForTokens, getFreshAccessToken } from './googleAuth.js';
import { hasRefreshToken } from './tokenStore.js';

// 🌟 분리된 3대 전담 모듈 import
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

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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

  console.log(`[Request] ${req.method} ${pathname} (IP: ${getClientIp(req)})`);

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

        const sessionToken = createAdminSession();
        res.writeHead(302, {
          'Set-Cookie': `admin_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
          'Location': '/admin'
        });
        res.end();
        return;
      }

      if (inputPass === currentPass) {
        const sessionToken = createAdminSession();
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

  if (req.method === 'GET' && pathname === '/admin/logout') {
    const cookies = parseCookies(req);
    destroyAdminSession(cookies['admin_session']);
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
    res.writeHead(302, { Location: '/admin' });
    res.end();
    return;
  }

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
          console.log('🔒 [Admin] 관리자 비밀번호가 갱신되었습니다.');
        }

        writeEnvFile(updates);

        if (isStorageMode) {
          ensureStorageDirectories();
        }

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

  // 🔬 [크래시 리포트 수신] POST /api/storage/crash-reports/:fileName (STORAGE_MODE와 무관하게 결함 수집 항상 허용)
  if (req.method === 'POST' && pathname.startsWith('/api/storage/crash-reports/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/crash-reports/', ''));
    try {
      const buffer = await readRequestBodyBuffer(req);
      const reportData = JSON.parse(buffer.toString('utf-8'));
      storageService.saveCrashReport(fileName, reportData);
      return sendJsonResponse(req, res, 200, { ok: true, fileName, status: 'saved' });
    } catch (err) {
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

  // 🛡️ [STORAGE_MODE 검증 가드] 도서 및 설정 저장소 엔드포인트는 어드민에서 켜져 있을 때만 통과
  if (pathname.startsWith('/api/storage/')) {
    const env = readEnvFile();
    if (env.STORAGE_MODE !== 'true') {
      console.warn(`⛔ [Storage Blocked] 개인 서버 저장소 모드가 비활성화되어 요청이 거부되었습니다. Path: ${pathname}`);
      return sendJsonResponse(req, res, 403, {
        error: 'STORAGE_MODE_DISABLED: 개인 서버 저장소 모드가 비활성화되어 있습니다. 관리자 대시보드(/admin)에서 활성화해 주세요.'
      });
    }
  }

  // ⚡ [올인원 통합 스냅샷 단일 쿼리] GET /api/storage/snapshot
  if (req.method === 'GET' && pathname === '/api/storage/snapshot') {
    try {
      const snapshot = await storageService.getUnifiedSnapshot();
      return sendJsonResponse(req, res, 200, snapshot);
    } catch (err) {
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
      return sendJsonResponse(req, res, 200, { ok: true, bookId });
    } catch (err) {
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

  // 📖 [도서 메타데이터 JSON 조회] GET /api/storage/books/:id
  if (req.method === 'GET' && pathname.startsWith('/api/storage/books/') && !pathname.endsWith('/epub')) {
    const bookId = decodeURIComponent(pathname.replace('/api/storage/books/', ''));
    const meta = storageService.getBookMetadata(bookId);
    if (!meta) return sendJsonResponse(req, res, 404, { error: '도서를 찾을 수 없습니다.' });
    return sendJsonResponse(req, res, 200, meta);
  }

  // 📦 [EPUB 바이너리 파일 업로드] POST /api/storage/books/:id/epub
  if (req.method === 'POST' && pathname.startsWith('/api/storage/books/') && pathname.endsWith('/epub')) {
    const bookId = decodeURIComponent(pathname.replace('/api/storage/books/', '').replace('/epub', ''));
    try {
      const buffer = await readRequestBodyBuffer(req);
      storageService.saveBookEpub(bookId, buffer);
      return sendJsonResponse(req, res, 200, { ok: true, bookId, size: buffer.length });
    } catch (err) {
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

  // 📦 [EPUB 바이너리 파일 스트리밍 다운로드] GET /api/storage/books/:id/epub
  if (req.method === 'GET' && pathname.startsWith('/api/storage/books/') && pathname.endsWith('/epub')) {
    const bookId = decodeURIComponent(pathname.replace('/api/storage/books/', '').replace('/epub', ''));
    const info = storageService.getBookEpubPath(bookId);
    if (!info) return sendJsonResponse(req, res, 404, { error: 'EPUB 파일을 찾을 수 없습니다.' });

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
      return sendJsonResponse(req, res, 200, { ok: true, fileName });
    } catch (err) {
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

  // 🖼️ [표지 이미지 다운로드] GET /api/storage/covers/:fileName
  if (req.method === 'GET' && pathname.startsWith('/api/storage/covers/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/covers/', ''));
    const info = storageService.getCoverImagePath(fileName);
    if (!info) return sendJsonResponse(req, res, 404, { error: '표지를 찾을 수 없습니다.' });

    setCorsHeaders(req, res);
    res.writeHead(200, {
      'Content-Type': 'image/webp',
      'Content-Length': info.size
    });
    const readStream = fs.createReadStream(info.filePath);
    readStream.pipe(res);
    return;
  }

  // 🗑️ [도서 완전 삭제 트랜잭션] DELETE /api/storage/books/:id
  if (req.method === 'DELETE' && pathname.startsWith('/api/storage/books/')) {
    const bookId = decodeURIComponent(pathname.replace('/api/storage/books/', ''));
    const count = storageService.deleteBookAll(bookId);
    return sendJsonResponse(req, res, 200, { ok: true, deletedFiles: count });
  }

  // ⚙️ [설정/통계/업적/묘비 JSON 저장] POST /api/storage/settings/:fileName
  if (req.method === 'POST' && pathname.startsWith('/api/storage/settings/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/settings/', ''));
    try {
      const buffer = await readRequestBodyBuffer(req);
      const data = JSON.parse(buffer.toString('utf-8'));
      storageService.saveSettingsFile(fileName, data);
      return sendJsonResponse(req, res, 200, { ok: true, fileName });
    } catch (err) {
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