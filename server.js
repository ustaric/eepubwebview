/**
 * @file server.js
 * @description 개인용 Google Drive Refresh Token 및 다중 사용자 자체 스토리지 제어 통합 HTTP 서버
 * - 👥 [다중 사용자 샌드박스 직통 라우팅] apiKeyManager 연동으로 사용자별 data/users/{folderName}/ 투명 연결
 * - 🔑 [지능형 듀얼 API 키 가드] 루트 관리자 마스터 키(data/books) + 다중 사용자 키(data/users) 완벽 공존
 * - 🚦 [용량 초과 사전 차단] Content-Length 사전 검사로 잔여 용량 초과 시 바디 수신 전 413 즉시 거부
 * - 🛡️ [기존 뷰어 100% 무회귀] 엄격모드 비활성 시 기존 ALLOWED_ORIGIN 출처 검증으로 안전 호환
 * - 🛡️ [securityGuard 결속] nosniff, SAMEORIGIN 등 기본 HTTP 보안 응답 헤더 전역 자동 주입
 * - 🚦 [엔드포인트별 차등 바디 제한] EPUB 100MB / 표지 10MB / JSON 5MB 차등 제한으로 메모리 고갈 DoS 원천 방어
 * - 🚫 [비인가 HTTP 메서드 차단] GET, HEAD, POST, DELETE, OPTIONS 외 변칙 메서드 405 차단
 * - 🔒 [Google 로그인 비밀번호 관문 탑재] /auth/google 진입 시 관리자 비밀번호 검증으로 타인의 구글 계정 덮어쓰기 원천 차단
 * - 📁 [책임 기반 완벽 분리] 관리자 라우트(/admin/*)를 adminController.handleAdminRoute로 100% 위임 슬림화
 * - ⚡ [서버 내부 도서 직통 복사 API 완비] POST /api/storage/remote-library/import 제공으로 2중 트래픽 원천 차단
 * - 📚 [공유 라이브러리 도서 목록 및 다운로드 API] GET /api/storage/remote-library 및 download 엔드포인트 탑재
 * - 🚦 [지능형 Rate Limit] 스토리지 API 1분 120회 폭주 방어
 * - 📊 [실시간 활동 로깅 Hook 탑재] auditLogger 연동으로 사용자별 활동 내역 실시간 기록
 * - 🛡️ [STORAGE_MODE 검증 가드] 어드민 설정(STORAGE_MODE=true) 활성 시에만 로컬 도서 저장 허용
 * - 🖼️ [HEAD 메서드 지원 탑재] 표지 이미지 선조회(HEAD) 요청 정식 수용으로 가짜 404 및 중복 업로드 원천 차단
 */

import http from 'http';
import fs from 'fs';
import { URL } from 'url';
import { config } from './config.js';
import { generateAuthUrl, verifyState, exchangeCodeForTokens, getFreshAccessToken } from './googleAuth.js';
import { hasRefreshToken } from './tokenStore.js';

// 🌟 분리된 전담 모듈 import
import { readEnvFile } from './src/envManager.js';
import { handleAdminRoute, isAuthenticated, createAdminSession } from './src/adminController.js';
import { renderAuthGateHtml } from './src/adminViews.js';
import { storageService } from './src/storageService.js';
import { auditLogger } from './src/auditLogger.js';
import { injectSecurityHeaders } from './src/securityGuard.js';
import { apiKeyManager } from './src/apiKeyManager.js';

// 허용된 정규 HTTP 메서드 목록
const ALLOWED_HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS']);

/**
 * 🛡️ [Rate Limiting] 메모리 기반 IP별 요청 제한 저장소
 */
const rateLimitMap = new Map();

// 주기적 메모리 청소 (5분 간격)
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimitMap.entries()) {
    if (now > data.resetTime) rateLimitMap.delete(ip);
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
 * 🔑 [API 키 추출 헬퍼] 요청 헤더 및 쿼리 파라미터에서 API 키 파싱
 * @param {http.IncomingMessage} req 
 * @param {URL} reqUrl 
 * @returns {string|null}
 */
function extractApiKey(req, reqUrl) {
  // 1. X-API-KEY 헤더
  const customHeader = req.headers['x-api-key'];
  if (customHeader) return String(customHeader).trim();

  // 2. Authorization: Bearer <key>
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }

  // 3. 쿼리 파라미터 ?apiKey=... (다운로드나 브라우저 직접 탐색 시)
  const queryKey = reqUrl.searchParams.get('apiKey');
  if (queryKey) return queryKey.trim();

  return null;
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

  // 2. Referer 헤더 검사
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

  const secFetchSite = req.headers['sec-fetch-site'];
  if (secFetchSite === 'same-origin') return true;

  return false;
}

/**
 * CORS 응답 헤더 세팅 및 보안 헤더 자동 주입
 * @param {http.IncomingMessage} req 
 * @param {http.ServerResponse} res 
 */
function setCorsHeaders(req, res) {
  injectSecurityHeaders(res);

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

  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-API-KEY');
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
 * HTTP 요청 Body 버퍼 수신 헬퍼 (엔드포인트별 차등 제한 지원)
 * @param {http.IncomingMessage} req 
 * @param {number} [maxBytes=5242880] 기본값 5MB
 * @returns {Promise<Buffer>}
 */
function readRequestBodyBuffer(req, maxBytes = 5242880) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;

    req.on('data', chunk => {
      received += chunk.length;
      if (received > maxBytes) {
        req.destroy();
        reject(new Error(`요청 크기가 한도(${(maxBytes / 1024 / 1024).toFixed(1)}MB)를 초과했습니다.`));
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
  // 🛡️ 기본 보안 응답 헤더 주입
  injectSecurityHeaders(res);

  // 🛡️ 비인가 HTTP 메서드 원천 차단
  if (!ALLOWED_HTTP_METHODS.has(req.method)) {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: `METHOD_NOT_ALLOWED: 지원하지 않는 HTTP 메서드입니다 (${req.method})` }));
    return;
  }

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
  // 1. 서버 헬스체크 (API 키 포함 시 즉시 활성화 트리거 탑재)
  // =========================================================================
  if (req.method === 'GET' && pathname === '/api/health') {
    const env = readEnvFile();
    const providedApiKey = extractApiKey(req, reqUrl);

    // 🌟 [핵심 보강] 웹 뷰어 연결 테스트 시 API 키가 있으면 즉시 활성화(ACTIVE) 전환 및 접속 기록!
    if (providedApiKey) {
      const rootMasterKey = env.STORAGE_API_KEY?.trim();
      if (rootMasterKey && providedApiKey === rootMasterKey) {
        auditLogger.recordApiKeyUsage({ ip: clientIp, userAgent, path: pathname, method: req.method, userMemo: 'Root Admin' });
      } else {
        const auth = apiKeyManager.authenticateApiKey(providedApiKey);
        if (auth.authenticated && auth.user) {
          auditLogger.recordApiKeyUsage({ ip: clientIp, userAgent, path: pathname, method: req.method, userMemo: auth.user.memo });
        }
      }
    }

    return sendJsonResponse(req, res, 200, {
      ok: true,
      service: 'gdrive-refresh-server',
      hasToken: hasRefreshToken(),
      storageMode: env.STORAGE_MODE === 'true',
      multiUserReady: true,
      sharedBooksDir: env.SHARED_BOOKS_DIR || null,
      hasStorageApiKey: Boolean(env.STORAGE_API_KEY),
      enforceApiKey: env.ENFORCE_STORAGE_API_KEY === 'true',
      timestamp: new Date().toISOString()
    });
  }

  // =========================================================================
  // 2. 관리자 인증 & 대시보드 라우트 (src/adminController 위임)
  // =========================================================================
  if (pathname.startsWith('/admin') || pathname === '/settings') {
    const handled = await handleAdminRoute(req, res, pathname, clientIp, userAgent);
    if (handled) return;
  }

  // =========================================================================
  // 3. 🌟 자체 스토리지 모드 REST API 엔드포인트
  // =========================================================================

  // 🔬 [크래시 리포트 수신] POST /api/storage/crash-reports/:fileName (5MB 제한)
  if (req.method === 'POST' && pathname.startsWith('/api/storage/crash-reports/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/crash-reports/', ''));
    try {
      const buffer = await readRequestBodyBuffer(req, 5 * 1024 * 1024);
      const reportData = JSON.parse(buffer.toString('utf-8'));
      storageService.saveCrashReport(fileName, reportData);

      const env = readEnvFile();
      const configuredApiKey = env.STORAGE_API_KEY?.trim();
      const providedApiKey = extractApiKey(req, reqUrl);
      if (configuredApiKey && providedApiKey === configuredApiKey) {
        auditLogger.recordApiKeyUsage({ ip: clientIp, userAgent, path: pathname, method: req.method });
      }

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

  // 🛡️ [스토리지 엔드포인트 보안 가드 2] STORAGE_MODE 검증 가드
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

  // 🛡️ [스토리지 엔드포인트 보안 가드 3] 🔑 지능형 듀얼 API 키 및 다중 사용자 샌드박스 인증
  let targetUserFolder = null; // null이면 루트 관리자 fallback (data/books)
  let userQuotaBytes = 1073741824; // 기본 1GB

  if (pathname.startsWith('/api/storage/')) {
    const env = readEnvFile();
    const rootMasterKey = env.STORAGE_API_KEY?.trim();
    const isEnforceApiKey = env.ENFORCE_STORAGE_API_KEY === 'true';
    const providedApiKey = extractApiKey(req, reqUrl);

    // 1순위: 루트 관리자 마스터 키 일치 검증 (기존 단일 서재 data/books 100% 무회귀)
    if (rootMasterKey && providedApiKey && providedApiKey === rootMasterKey) {
      targetUserFolder = null; // 루트 서재 직통
      auditLogger.recordApiKeyUsage({
        ip: clientIp,
        userAgent,
        path: pathname,
        method: req.method
      });
    }
    // 2순위: 다중 사용자 API 키 검증 (apiKeyManager 연동 ➔ data/users/{folderName}/ 샌드박스)
    else if (providedApiKey) {
      const auth = apiKeyManager.authenticateApiKey(providedApiKey);
      if (auth.authenticated && auth.user) {
        targetUserFolder = auth.user.folderName;
        userQuotaBytes = auth.user.storageQuotaBytes || (1024 * 1024 * 1024);

        auditLogger.recordApiKeyUsage({
          ip: clientIp,
          userAgent,
          path: pathname,
          method: req.method
        });
      } else if (auth.reason === 'API_KEY_EXPIRED') {
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '만료된 API 키 차단', target: pathname, status: 401 });
        return sendJsonResponse(req, res, 401, {
          error: 'API_KEY_EXPIRED: 24시간 내 미접속으로 만료되었거나 사용 기간이 종료된 키입니다. 관리자에게 재발급을 요청하세요.'
        });
      } else if (auth.reason === 'API_KEY_REVOKED') {
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '폐기된 API 키 차단', target: pathname, status: 401 });
        return sendJsonResponse(req, res, 401, {
          error: 'API_KEY_REVOKED: 폐기된 API 키입니다. 관리자에게 문의하세요.'
        });
      } else if (isEnforceApiKey) {
        console.warn(`⛔ [ApiKey Blocked] 유효하지 않은 API 키 (IP: ${clientIp}, Path: ${pathname})`);
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'API 키 인증 실패 차단', target: pathname, status: 401 });
        return sendJsonResponse(req, res, 401, {
          error: 'UNAUTHORIZED_API_KEY: 유효한 API 키가 필요합니다. 관리자 설정(/admin)을 확인해 주세요.'
        });
      } else {
        // 엄격 모드가 꺼져 있을 때: 기존 출처 검증 fallback
        if (!isAllowedClientOrigin(req)) {
          auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '비인가 출처 차단', target: pathname, status: 403 });
          return sendJsonResponse(req, res, 403, { error: 'FORBIDDEN_ORIGIN: 승인되지 않은 도메인에서의 스토리지 접근입니다.' });
        }
      }
    } else if (isEnforceApiKey) {
      console.warn(`⛔ [ApiKey Blocked] API 키 누락 차단 (IP: ${clientIp}, Path: ${pathname})`);
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'API 키 누락 차단', target: pathname, status: 401 });
      return sendJsonResponse(req, res, 401, {
        error: 'UNAUTHORIZED_API_KEY: X-API-KEY 헤더가 누락되었습니다.'
      });
    } else {
      // 키가 없고 엄격 모드도 꺼진 경우 ➔ 기존 출처 검증 fallback
      if (!isAllowedClientOrigin(req)) {
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '비인가 출처 차단', target: pathname, status: 403 });
        return sendJsonResponse(req, res, 403, { error: 'FORBIDDEN_ORIGIN: 승인되지 않은 도메인에서의 스토리지 접근입니다.' });
      }
    }
  }

  // =========================================================================
  // ⚡ 공유 도서 서버 내부 0초 직통 복사 (POST /api/storage/remote-library/import)
  // =========================================================================
  if (req.method === 'POST' && pathname === '/api/storage/remote-library/import') {
    const env = readEnvFile();
    const sharedDir = env.SHARED_BOOKS_DIR;

    if (!sharedDir || !fs.existsSync(sharedDir)) {
      return sendJsonResponse(req, res, 404, {
        ok: false,
        error: 'SHARED_BOOKS_DIR_NOT_FOUND',
        message: '공유 도서 폴더가 설정되지 않았거나 존재하지 않습니다.'
      });
    }

    try {
      const buffer = await readRequestBodyBuffer(req, 5 * 1024 * 1024);
      const payload = JSON.parse(buffer.toString('utf-8') || '{}');
      const relativePath = payload.relativePath;

      if (!relativePath) {
        return sendJsonResponse(req, res, 400, { error: 'relativePath 필드가 누락되었습니다.' });
      }

      console.log(`⚡ [API:Import] 공유 도서 복사 요청: '${relativePath}' (대상 서재: ${targetUserFolder || 'root'})`);

      const importResult = storageService.importRemoteBookToLibrary(sharedDir, relativePath, targetUserFolder);
      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '⚡ 공유 도서 내부 복사',
        target: `${importResult.fileName} ➔ ${targetUserFolder || 'root'}`,
        status: 200
      });

      return sendJsonResponse(req, res, 200, importResult);
    } catch (err) {
      console.error(`❌ [API:Import] 공유 도서 복사 실패:`, err.message);
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '공유 도서 복사 실패', target: err.message, status: 500 });
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

  // =========================================================================
  // 📚 공유 라이브러리 도서 목록 조회 (GET /api/storage/remote-library)
  // =========================================================================
  if (req.method === 'GET' && pathname === '/api/storage/remote-library') {
    const env = readEnvFile();
    const sharedDir = env.SHARED_BOOKS_DIR;

    if (!sharedDir || !fs.existsSync(sharedDir)) {
      return sendJsonResponse(req, res, 404, {
        ok: false,
        error: 'SHARED_BOOKS_DIR_NOT_FOUND',
        message: '공유 도서 폴더가 설정되지 않았거나 존재하지 않습니다.'
      });
    }

    const permCheck = storageService.testDirectoryPermissions(sharedDir);
    if (!permCheck.readable) {
      return sendJsonResponse(req, res, 403, {
        ok: false,
        error: 'PERMISSION_DENIED',
        message: `공유 폴더 읽기 권한이 없습니다: ${permCheck.error || ''}`
      });
    }

    const books = storageService.getRemoteBooks(sharedDir);
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '📚 공유 서재 목록 조회', target: `${books.length}권`, status: 200 });
    return sendJsonResponse(req, res, 200, {
      ok: true,
      sharedDir,
      totalBooks: books.length,
      books
    });
  }

  // =========================================================================
  // 📖 공유 도서 원본 실시간 스트리밍 다운로드 (GET /api/storage/remote-library/download)
  // =========================================================================
  if (req.method === 'GET' && pathname === '/api/storage/remote-library/download') {
    const env = readEnvFile();
    const sharedDir = env.SHARED_BOOKS_DIR;
    const reqFile = reqUrl.searchParams.get('file');

    if (!sharedDir || !reqFile) {
      return sendJsonResponse(req, res, 400, { error: 'file 쿼리 파라미터가 누락되었습니다.' });
    }

    const fileInfo = storageService.getRemoteBookFilePath(sharedDir, reqFile);
    if (!fileInfo) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '공유 도서 다운로드 실패', target: reqFile, status: 404 });
      return sendJsonResponse(req, res, 404, { error: '도서 파일을 찾을 수 없거나 접근이 거부되었습니다.' });
    }

    const isTxt = fileInfo.fileName.toLowerCase().endsWith('.txt');
    const contentType = isTxt ? 'text/plain; charset=utf-8' : 'application/epub+zip';

    auditLogger.recordAccessLog({
      ip: clientIp,
      userAgent,
      action: isTxt ? '📄 TXT 도서 스트리밍' : '📖 EPUB 도서 스트리밍',
      target: fileInfo.fileName,
      status: 200
    });

    setCorsHeaders(req, res);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': fileInfo.size,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileInfo.fileName)}"`
    });

    const readStream = fs.createReadStream(fileInfo.filePath);
    readStream.pipe(res);
    return;
  }

  // ⚡ [올인원 통합 스냅샷 단일 쿼리] GET /api/storage/snapshot (사용자 서재 격리 지원)
  if (req.method === 'GET' && pathname === '/api/storage/snapshot') {
    try {
      const snapshot = await storageService.getUnifiedSnapshot(targetUserFolder);
      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '📚 서재 스냅샷 조회',
        target: `${targetUserFolder || 'root'} (활성 ${snapshot.cloudBooks.length}권 / 보관 ${snapshot.cloudArchivedBooks.length}권)`,
        status: 200
      });
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
      const buffer = await readRequestBodyBuffer(req, 5 * 1024 * 1024);
      const bookData = JSON.parse(buffer.toString('utf-8'));
      storageService.saveBookMetadata(bookId, bookData, targetUserFolder);

      const actionName = bookData.isArchived ? '📁 도서 보관 처리' : '📖 도서 메타 저장';
      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: actionName,
        target: `${bookData.title || bookId} (${targetUserFolder || 'root'})`,
        status: 200
      });
      return sendJsonResponse(req, res, 200, { ok: true, bookId });
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '도서 메타 저장 실패', target: bookId, status: 500 });
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

  // 📖 [도서 메타데이터 JSON 조회] GET /api/storage/books/:id
  if (req.method === 'GET' && pathname.startsWith('/api/storage/books/') && !pathname.endsWith('/epub')) {
    const bookId = decodeURIComponent(pathname.replace('/api/storage/books/', ''));
    const meta = storageService.getBookMetadata(bookId, targetUserFolder);
    if (!meta) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '도서 메타 조회 실패', target: bookId, status: 404 });
      return sendJsonResponse(req, res, 404, { error: '도서를 찾을 수 없습니다.' });
    }
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '도서 메타 조회', target: `${meta.title || bookId} (${targetUserFolder || 'root'})`, status: 200 });
    return sendJsonResponse(req, res, 200, meta);
  }

  // 📦 [EPUB 바이너리 파일 업로드] POST /api/storage/books/:id/epub (용량 초과 사전 차단 가드 탑재)
  if (req.method === 'POST' && pathname.startsWith('/api/storage/books/') && pathname.endsWith('/epub')) {
    const bookId = decodeURIComponent(pathname.replace('/api/storage/books/', '').replace('/epub', ''));
    const contentLength = Number(req.headers['content-length'] || 0);

    // 🚦 [용량 사전 검증] 메모리에 바디를 받기 전에 사용자 할당량 초과 여부 즉시 판정
    if (targetUserFolder && contentLength > 0) {
      const quotaCheck = storageService.checkUserStorageQuota(targetUserFolder, contentLength, userQuotaBytes);
      if (!quotaCheck.allowed) {
        console.warn(`⛔ [Quota Exceeded] 사용자('${targetUserFolder}') 저장 용량 초과 거절 (요청: ${(contentLength / 1024 / 1024).toFixed(1)}MB, 잔여: ${(quotaCheck.remainingBytes / 1024 / 1024).toFixed(1)}MB)`);
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '용량 초과 업로드 차단', target: `${bookId} (${targetUserFolder})`, status: 413 });
        return sendJsonResponse(req, res, 413, {
          error: 'STORAGE_QUOTA_EXCEEDED: 할당된 저장 용량을 초과하여 도서를 업로드할 수 없습니다.'
        });
      }
    }

    try {
      const buffer = await readRequestBodyBuffer(req, 100 * 1024 * 1024);
      storageService.saveBookEpub(bookId, buffer, targetUserFolder);

      const sizeMb = (buffer.length / 1024 / 1024).toFixed(1);
      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '📦 EPUB 업로드',
        target: `${bookId} (${sizeMb}MB / ${targetUserFolder || 'root'})`,
        status: 200
      });
      return sendJsonResponse(req, res, 200, { ok: true, bookId, size: buffer.length });
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'EPUB 업로드 실패', target: bookId, status: 500 });
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

  // 📦 [EPUB 바이너리 파일 스트리밍 다운로드] GET /api/storage/books/:id/epub
  if (req.method === 'GET' && pathname.startsWith('/api/storage/books/') && pathname.endsWith('/epub')) {
    const rawSegment = pathname.replace('/api/storage/books/', '').replace(/\/epub$/, '');
    const bookId = decodeURIComponent(rawSegment);

    console.log(`📦 [API:Download] EPUB 스트리밍 다운로드 요청: '${bookId}' (서재: ${targetUserFolder || 'root'})`);

    const info = storageService.getBookEpubPath(bookId, targetUserFolder);
    if (!info) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'EPUB 다운로드 실패', target: bookId, status: 404 });
      return sendJsonResponse(req, res, 404, { error: 'EPUB 파일을 찾을 수 없습니다.' });
    }

    const sizeMb = (info.size / 1024 / 1024).toFixed(1);
    auditLogger.recordAccessLog({
      ip: clientIp,
      userAgent,
      action: '📖 EPUB 다운로드',
      target: `${bookId} (${sizeMb}MB / ${targetUserFolder || 'root'})`,
      status: 200
    });

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
      const buffer = await readRequestBodyBuffer(req, 10 * 1024 * 1024);
      storageService.saveCoverImage(fileName, buffer, targetUserFolder);
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '🖼️ 표지 업로드', target: `${fileName} (${targetUserFolder || 'root'})`, status: 200 });
      return sendJsonResponse(req, res, 200, { ok: true, fileName });
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '표지 업로드 실패', target: fileName, status: 500 });
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

  // 🖼️ [표지 이미지 다운로드 및 선조회] GET / HEAD /api/storage/covers/:fileName
  if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/api/storage/covers/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/covers/', ''));
    const info = storageService.getCoverImagePath(fileName, targetUserFolder);
    if (!info) {
      return sendJsonResponse(req, res, 404, { error: '표지를 찾을 수 없습니다.' });
    }

    setCorsHeaders(req, res);
    res.writeHead(200, {
      'Content-Type': 'image/webp',
      'Content-Length': info.size,
      'Cache-Control': 'public, max-age=86400'
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const readStream = fs.createReadStream(info.filePath);
    readStream.pipe(res);
    return;
  }

  // 🖼️ [표지 이미지 단일 삭제] DELETE /api/storage/covers/:fileName
  if (req.method === 'DELETE' && pathname.startsWith('/api/storage/covers/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/covers/', ''));
    storageService.deleteCoverImage(fileName, targetUserFolder);
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '🖼️ 표지 단일 삭제', target: `${fileName} (${targetUserFolder || 'root'})`, status: 200 });
    return sendJsonResponse(req, res, 200, { ok: true, fileName });
  }

  // 🗑️ [도서 완전 삭제 트랜잭션] DELETE /api/storage/books/:id
  if (req.method === 'DELETE' && pathname.startsWith('/api/storage/books/')) {
    const bookId = decodeURIComponent(pathname.replace('/api/storage/books/', ''));
    const count = storageService.deleteBookAll(bookId, targetUserFolder);
    auditLogger.recordAccessLog({
      ip: clientIp,
      userAgent,
      action: '🗑️ 도서 완전 삭제',
      target: `${bookId} (${count}개 파일 파쇄 / ${targetUserFolder || 'root'})`,
      status: 200
    });
    return sendJsonResponse(req, res, 200, { ok: true, deletedFiles: count });
  }

  // ⚙️ [설정/통계/업적/묘비 JSON 저장] POST /api/storage/settings/:fileName
  if (req.method === 'POST' && pathname.startsWith('/api/storage/settings/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/settings/', ''));
    try {
      const buffer = await readRequestBodyBuffer(req, 5 * 1024 * 1024);
      const data = JSON.parse(buffer.toString('utf-8'));
      storageService.saveSettingsFile(fileName, data, targetUserFolder);
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '⚙️ 시스템 데이터 동기화', target: `${fileName} (${targetUserFolder || 'root'})`, status: 200 });
      return sendJsonResponse(req, res, 200, { ok: true, fileName });
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '시스템 동기화 실패', target: fileName, status: 500 });
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

  // ⚙️ [설정/통계/업적/묘비 JSON 조회] GET /api/storage/settings/:fileName
  if (req.method === 'GET' && pathname.startsWith('/api/storage/settings/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/settings/', ''));
    const data = storageService.getSettingsFile(fileName, targetUserFolder);
    if (!data) return sendJsonResponse(req, res, 404, { error: '설정 파일을 찾을 수 없습니다.' });
    return sendJsonResponse(req, res, 200, data);
  }

  // =========================================================================
  // 4. 🌟 Google OAuth 인증 라우트 (비밀번호 게이트웨이 탑재)
  // =========================================================================

  // 1) [GET /auth/google] 로그인 시작 링크
  if (req.method === 'GET' && pathname === '/auth/google') {
    if (isAuthenticated(req)) {
      try {
        const authUrl = generateAuthUrl();
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '구글 계정 연동 시작', target: '관리자 인증 통과 ➔ 구글 이동', status: 302 });
        res.writeHead(302, { Location: authUrl });
        res.end();
        return;
      } catch (err) {
        console.error('[OAuth Init Error]', err.message);
        return sendHtmlResponse(req, res, 500, '로그인 시작 오류', 'Google 로그인 URL을 생성하지 못했습니다. 설정 값을 확인해 주세요.', false);
      }
    }

    const html = renderAuthGateHtml();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // 2) [POST /auth/google] 게이트웨이 비밀번호 제출
  if (req.method === 'POST' && pathname === '/auth/google') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const inputPass = params.get('password')?.trim() || '';
      const env = readEnvFile();
      const currentPass = env.ADMIN_PASSWORD;

      if (currentPass && inputPass === currentPass) {
        const sessionToken = createAdminSession();
        try {
          const authUrl = generateAuthUrl();
          auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '구글 게이트 비밀번호 인증 성공', target: '구글 로그인 화면 점프', status: 302 });
          res.writeHead(302, {
            'Set-Cookie': `admin_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
            'Location': authUrl
          });
          res.end();
          return;
        } catch (err) {
          return sendHtmlResponse(req, res, 500, '로그인 시작 오류', 'Google 로그인 URL을 생성하지 못했습니다.', false);
        }
      } else {
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '구글 게이트 비밀번호 오류', target: '접근 차단', status: 401 });
        const html = renderAuthGateHtml('관리자 비밀번호가 올바르지 않습니다.');
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
    });
    return;
  }

  // 3) [GET /auth/google/callback] Google 승인 후 돌아오는 콜백 라우트
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
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'Google OAuth 토큰 교환 성공', target: '토큰 암호화 저장 완료', status: 200 });
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

  // 4) [GET /api/access-token] 평소 독서 중 백그라운드 자동 갱신 엔드포인트
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
        ? 'Google 계정 연동이 필요합니다. 먼저 /auth/google 을 통해 Google 계정을 연동해 주세요.'
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