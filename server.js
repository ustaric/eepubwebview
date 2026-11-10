/**
 * @file server.js
 * @description 개인용 Google Drive Refresh Token 및 다중 사용자 자체 스토리지 제어 통합 HTTP 서버
 * - ⚡ [구글 공식 로그인 0초 직통 점프] 중간 HTML 게이트 없이 클릭 즉시 구글 계정 선택 화면으로 302 다이렉트 이동
 * - 🔢 [6자리 단기 기기 연결 OTP 라우트] /api/auth/otp/issue 및 /api/auth/otp/verify 탑재로 카메라 없는 초간편 번호 로그인
 * - 📱 [기기 식별 및 차단 미들웨어 탑재] X-Device-Id 헤더 검증으로 차단 기기(403) 및 6대 슬롯 초과(403) 실시간 차단
 * - 👥 [다중 사용자 샌드박스 직통 라우팅] apiKeyManager 연동으로 사용자별 data/users/{folderName}/ 투명 연결
 * - 🔑 [지능형 듀얼 API 키 가드] 루트 관리자 마스터 키(data/books) + 다중 사용자 키(data/users) 완벽 공존
 * - 🚦 [용량 초과 사전 차단] Content-Length 사전 검사로 잔여 용량 초과 시 바디 수신 전 413 즉시 거부
 * - 🛡️ [기존 뷰어 100% 무회귀] 엄격모드 비활성 시 기존 ALLOWED_ORIGIN 출처 검증으로 안전 호환
 * - 🛡️ [securityGuard 결속] nosniff, SAMEORIGIN 등 기본 HTTP 보안 응답 헤더 전역 자동 주입
 * - 🚦 [엔드포인트별 차등 바디 제한] EPUB 100MB / 표지 10MB / JSON 5MB 차등 제한으로 메모리 고갈 DoS 원천 방어
 * - 🚫 [비인가 HTTP 메서드 차단] GET, HEAD, POST, DELETE, OPTIONS 외 변칙 메서드 405 차단
 * - 📁 [책임 기반 완벽 분리] 관리자 라우트(/admin/*)를 adminController.handleAdminRoute로 100% 위임 슬림화
 * - ⚡ [서버 내부 도서 직통 복사 API 완비] POST /api/storage/remote-library/import 제공으로 2중 트래픽 원천 차단
 * - 📚 [공유 라이브러리 도서 목록 및 다운로드 API] GET /api/storage/remote-library 및 download 엔드포인트 탑재
 * - 🚦 [지능형 Rate Limit] 스토리지 API 1분 120회 폭주 방어
 * - 📊 [실시간 활동 로깅 Hook 탑재] auditLogger 연동으로 사용자별 활동 내역 실시간 기록
 * - 🛡️ [STORAGE_MODE 검증 가드] 어드민 설정(STORAGE_MODE=true) 활성 시에만 로컬 도서 저장 허용
 * - 🖼️ [HEAD 메서드 지원 탑재] 표지 이미지 선조회(HEAD) 요청 정식 수용으로 가짜 404 및 중복 업로드 원천 차단
 * - 📊 [시스템 자원 감시 & 디스코드 웹훅] systemMonitor 연동으로 CPU/RAM/DISK 1분 평균 연산 및 알림 완비
 */

import http from 'http';
import fs from 'fs';
import { URL } from 'url';
import { config } from './config.js';
import { generateAuthUrl, verifyState, exchangeCodeForTokens, getFreshAccessToken } from './googleAuth.js';
import { hasRefreshToken } from './tokenStore.js';

// 🌟 분리된 전담 모듈 import
import { readEnvFile, writeEnvFile } from './src/envManager.js';
import { handleAdminRoute } from './src/adminController.js';
import { storageService } from './src/storageService.js';
import { auditLogger } from './src/auditLogger.js';
import { injectSecurityHeaders } from './src/securityGuard.js';
import { apiKeyManager } from './src/apiKeyManager.js';
import { systemMonitor } from './src/systemMonitor.js';

// 허용된 정규 HTTP 메서드 목록
const ALLOWED_HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS']);

/**
 * 🛡️ [Rate Limiting] 메모리 기반 IP별 요청 제한 저장소
 */
const rateLimitMap = new Map();

// 🔒 [OTP 무차별 대입 방어 맵] (1분 내 5회 실패 시 10분 락)
const otpAttemptMap = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimitMap.entries()) {
    if (now > data.resetTime) rateLimitMap.delete(ip);
  }
  for (const [ip, data] of otpAttemptMap.entries()) {
    if (now > data.resetTime && (!data.blockedUntil || now > data.blockedUntil)) {
      otpAttemptMap.delete(ip);
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

function checkOtpRateLimit(ip) {
  const now = Date.now();
  const record = otpAttemptMap.get(ip);
  if (!record) return { allowed: true };

  if (record.blockedUntil && now < record.blockedUntil) {
    const waitMinutes = Math.ceil((record.blockedUntil - now) / (60 * 1000));
    return { allowed: false, waitMinutes };
  }

  if (now > record.resetTime) {
    otpAttemptMap.delete(ip);
    return { allowed: true };
  }

  if (record.failCount >= 5) {
    record.blockedUntil = now + (10 * 60 * 1000);
    return { allowed: false, waitMinutes: 10 };
  }

  return { allowed: true };
}

function recordOtpFailure(ip) {
  const now = Date.now();
  let record = otpAttemptMap.get(ip);
  if (!record || now > record.resetTime) {
    record = { failCount: 1, resetTime: now + (60 * 1000), blockedUntil: 0 };
  } else {
    record.failCount += 1;
  }
  otpAttemptMap.set(ip, record);
}

function clearOtpFailure(ip) {
  otpAttemptMap.delete(ip);
}

function extractApiKey(req, reqUrl) {
  const customHeader = req.headers['x-api-key'];
  if (customHeader) return String(customHeader).trim();

  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }

  const queryKey = reqUrl.searchParams.get('apiKey');
  if (queryKey) return queryKey.trim();

  return null;
}

function extractDeviceInfo(req, reqUrl) {
  let deviceId = req.headers['x-device-id'] || reqUrl.searchParams.get('deviceId') || '';
  let deviceName = req.headers['x-device-name'] || reqUrl.searchParams.get('deviceName') || '';

  if (deviceId) deviceId = String(deviceId).trim();
  if (deviceName) {
    try {
      deviceName = decodeURIComponent(String(deviceName).trim());
    } catch (_) {
      deviceName = String(deviceName).trim();
    }
  }

  return { deviceId, deviceName };
}

function isAllowedClientOrigin(req) {
  const env = readEnvFile();
  const allowedConfig = env.ALLOWED_ORIGIN || config.security.allowedOrigin;

  if (!allowedConfig || allowedConfig === '*') return true;

  const allowedList = allowedConfig.split(',').map((s) => s.trim().toLowerCase());

  const origin = req.headers.origin;
  if (origin) {
    return allowedList.includes(origin.toLowerCase());
  }

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-API-KEY, X-Device-Id, X-Device-Name');
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

const server = http.createServer(async (req, res) => {
  injectSecurityHeaders(res);

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
  // 1. 서버 헬스체크 & 시스템 모니터링 API
  // =========================================================================
  if (req.method === 'GET' && pathname === '/api/health') {
    const env = readEnvFile();
    const providedApiKey = extractApiKey(req, reqUrl);
    const { deviceId, deviceName } = extractDeviceInfo(req, reqUrl);

    if (providedApiKey) {
      const rootMasterKey = env.STORAGE_API_KEY?.trim();
      if (rootMasterKey && providedApiKey === rootMasterKey) {
        auditLogger.recordApiKeyUsage({ ip: clientIp, userAgent, path: pathname, method: req.method, userMemo: 'Root Admin' });
      } else {
        const auth = apiKeyManager.authenticateApiKey(providedApiKey);
        if (auth.authenticated && auth.user) {
          auditLogger.recordApiKeyUsage({ ip: clientIp, userAgent, path: pathname, method: req.method, userMemo: auth.user.memo });
          if (deviceId) {
            apiKeyManager.verifyAndTouchDevice(auth.user.folderName, { deviceId, deviceName, clientIp });
          }
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

  // 📊 [신규] 관리자 대시보드 실시간 자원(CPU, RAM, DISK) 사용량 API
  if (req.method === 'GET' && pathname === '/api/admin/system-stats') {
    const stats = systemMonitor.getSystemStats();
    return sendJsonResponse(req, res, 200, { ok: true, stats });
  }

  // 🔔 [신규] Discord 웹훅 URL 저장 및 테스트 발송 라우트
  if (req.method === 'POST' && pathname === '/api/admin/discord-webhook') {
    try {
      const buffer = await readRequestBodyBuffer(req, 1024 * 64);
      const payload = JSON.parse(buffer.toString('utf-8') || '{}');
      const { webhookUrl, action } = payload;

      if (action === 'test') {
        const testResult = await systemMonitor.testDiscordWebhook(webhookUrl);
        return sendJsonResponse(req, res, testResult.ok ? 200 : 400, testResult);
      }

      if (action === 'save') {
        const env = readEnvFile();
        env.DISCORD_WEBHOOK_URL = (webhookUrl || '').trim();
        writeEnvFile(env);
        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '⚙️ 디스코드 웹훅 설정 저장',
          target: env.DISCORD_WEBHOOK_URL ? '웹훅 등록' : '웹훅 제거',
          status: 200,
          user: 'Root Admin'
        });
        return sendJsonResponse(req, res, 200, { ok: true, message: 'Discord 웹훅 설정이 저장되었습니다.' });
      }

      return sendJsonResponse(req, res, 400, { error: '잘못된 액션 요청입니다.' });
    } catch (err) {
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

  // =========================================================================
  // 🔢 2. 6자리 일회용 연결 번호 (OTP) 발급 및 검증 라우트
  // =========================================================================

  if (req.method === 'POST' && pathname === '/api/auth/otp/issue') {
    const providedApiKey = extractApiKey(req, reqUrl);
    if (!providedApiKey) {
      return sendJsonResponse(req, res, 401, { error: 'API 키가 필요합니다.' });
    }

    const env = readEnvFile();
    const rootMasterKey = env.STORAGE_API_KEY?.trim();
    let folderName = 'root';

    if (rootMasterKey && providedApiKey === rootMasterKey) {
      folderName = 'root';
    } else {
      const auth = apiKeyManager.authenticateApiKey(providedApiKey);
      if (!auth.authenticated || !auth.user) {
        return sendJsonResponse(req, res, 401, { error: '유효하지 않은 API 키입니다.' });
      }
      folderName = auth.user.folderName;
    }

    const otpResult = apiKeyManager.issueDeviceOtp(folderName, providedApiKey);
    if (!otpResult.success) {
      return sendJsonResponse(req, res, 500, { error: otpResult.error });
    }

    auditLogger.recordAccessLog({
      ip: clientIp,
      userAgent,
      action: '🔢 기기 연결 번호 발급',
      target: otpResult.displayCode,
      status: 200,
      user: folderName
    });

    return sendJsonResponse(req, res, 200, {
      ok: true,
      code: otpResult.code,
      displayCode: otpResult.displayCode,
      expiresInSeconds: otpResult.expiresInSeconds
    });
  }

  if (req.method === 'POST' && pathname === '/api/auth/otp/verify') {
    const otpGuard = checkOtpRateLimit(clientIp);
    if (!otpGuard.allowed) {
      return sendJsonResponse(req, res, 429, {
        error: `시도 횟수가 초과되었습니다. ${otpGuard.waitMinutes}분 후에 다시 시도해 주세요.`
      });
    }

    try {
      const buffer = await readRequestBodyBuffer(req, 1024 * 1024);
      const payload = JSON.parse(buffer.toString('utf-8') || '{}');
      const inputCode = payload.code;

      const exchangeResult = apiKeyManager.verifyAndExchangeDeviceOtp(inputCode);
      if (!exchangeResult.success) {
        recordOtpFailure(clientIp);
        return sendJsonResponse(req, res, 400, { error: exchangeResult.error });
      }

      clearOtpFailure(clientIp);

      const currentServerUrl = `${protocol}://${host}`;
      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '✨ 기기 연결 번호 인증 성공',
        target: inputCode,
        status: 200,
        user: exchangeResult.folderName
      });

      return sendJsonResponse(req, res, 200, {
        ok: true,
        serverUrl: currentServerUrl,
        apiKey: exchangeResult.apiKey,
        folderName: exchangeResult.folderName
      });
    } catch (err) {
      return sendJsonResponse(req, res, 400, { error: '잘못된 요청 형식입니다.' });
    }
  }

  // =========================================================================
  // 3. 관리자 인증 & 대시보드 라우트 (src/adminController 위임)
  // =========================================================================
  if (pathname.startsWith('/admin') || pathname === '/settings') {
    const handled = await handleAdminRoute(req, res, pathname, clientIp, userAgent);
    if (handled) return;
  }

  // =========================================================================
  // 4. 자체 스토리지 모드 REST API 엔드포인트
  // =========================================================================

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

  if (pathname.startsWith('/api/storage/')) {
    if (!checkRateLimit(req, 120)) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '요청 횟수 초과 차단', target: pathname, status: 429 });
      return sendJsonResponse(req, res, 429, {
        error: 'RATE_LIMIT_EXCEEDED: 요청 횟수가 초과되었습니다. 잠시 후 다시 시도해 주세요.'
      });
    }
  }

  if (pathname.startsWith('/api/storage/')) {
    const env = readEnvFile();
    if (env.STORAGE_MODE !== 'true') {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '스토리지 모드 비활성 거절', target: pathname, status: 403 });
      return sendJsonResponse(req, res, 403, {
        error: 'STORAGE_MODE_DISABLED: 개인 서버 저장소 모드가 비활성화되어 있습니다. 관리자 대시보드(/admin)에서 활성화해 주세요.'
      });
    }
  }

  let targetUserFolder = null;
  let userQuotaBytes = 1073741824;
  let authenticatedUserMemo = 'Root Admin';

  if (pathname.startsWith('/api/storage/')) {
    const env = readEnvFile();
    const rootMasterKey = env.STORAGE_API_KEY?.trim();
    const isEnforceApiKey = env.ENFORCE_STORAGE_API_KEY === 'true';
    const providedApiKey = extractApiKey(req, reqUrl);
    const { deviceId, deviceName } = extractDeviceInfo(req, reqUrl);

    if (rootMasterKey && providedApiKey && providedApiKey === rootMasterKey) {
      targetUserFolder = null;
      authenticatedUserMemo = 'Root Admin';
      auditLogger.recordApiKeyUsage({
        ip: clientIp,
        userAgent,
        path: pathname,
        method: req.method,
        userMemo: 'Root Admin'
      });
    } else if (providedApiKey) {
      const auth = apiKeyManager.authenticateApiKey(providedApiKey);
      if (auth.authenticated && auth.user) {
        targetUserFolder = auth.user.folderName;
        userQuotaBytes = auth.user.storageQuotaBytes || (1024 * 1024 * 1024);
        authenticatedUserMemo = `${auth.user.memo} (${auth.user.folderName})`;

        if (deviceId) {
          const deviceResult = apiKeyManager.verifyAndTouchDevice(auth.user.folderName, {
            deviceId,
            deviceName,
            clientIp
          });

          if (!deviceResult.allowed && deviceResult.reason === 'DEVICE_BLOCKED') {
            auditLogger.recordAccessLog({
              ip: clientIp,
              userAgent,
              action: '🚫 차단된 기기 접근 차단',
              target: `${deviceName || deviceId} (${auth.user.memo})`,
              status: 403,
              user: authenticatedUserMemo
            });
            return sendJsonResponse(req, res, 403, {
              error: 'DEVICE_BLOCKED: 관리자에 의해 차단된 기기입니다. 관리자에게 문의하세요.',
              deviceId
            });
          }

          if (!deviceResult.allowed && deviceResult.reason === 'DEVICE_LIMIT_EXCEEDED') {
            auditLogger.recordAccessLog({
              ip: clientIp,
              userAgent,
              action: '🚫 기기 등록 한도 초과',
              target: `${deviceName || deviceId} (${deviceResult.maxDevices || 6}대 한도 초과)`,
              status: 403,
              user: authenticatedUserMemo
            });
            return sendJsonResponse(req, res, 403, {
              error: `DEVICE_LIMIT_EXCEEDED: 허용된 최대 등록 기기 수(${deviceResult.maxDevices || 6}대)를 초과했습니다. 관리자 페이지에서 기존 기기를 정리해 주세요.`,
              maxDevices: deviceResult.maxDevices || 6
            });
          }
        }

        auditLogger.recordApiKeyUsage({
          ip: clientIp,
          userAgent,
          path: pathname,
          method: req.method,
          userMemo: auth.user.memo
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
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'API 키 인증 실패 차단', target: pathname, status: 401 });
        return sendJsonResponse(req, res, 401, {
          error: 'UNAUTHORIZED_API_KEY: 유효한 API 키가 필요합니다. 관리자 설정(/admin)을 확인해 주세요.'
        });
      } else {
        if (!isAllowedClientOrigin(req)) {
          auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '비인가 출처 차단', target: pathname, status: 403 });
          return sendJsonResponse(req, res, 403, { error: 'FORBIDDEN_ORIGIN: 승인되지 않은 도메인에서의 스토리지 접근입니다.' });
        }
      }
    } else if (isEnforceApiKey) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'API 키 누락 차단', target: pathname, status: 401 });
      return sendJsonResponse(req, res, 401, {
        error: 'UNAUTHORIZED_API_KEY: X-API-KEY 헤더가 누락되었습니다.'
      });
    } else {
      if (!isAllowedClientOrigin(req)) {
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '비인가 출처 차단', target: pathname, status: 403 });
        return sendJsonResponse(req, res, 403, { error: 'FORBIDDEN_ORIGIN: 승인되지 않은 도메인에서의 스토리지 접근입니다.' });
      }
    }
  }

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

      const importResult = storageService.importRemoteBookToLibrary(sharedDir, relativePath, targetUserFolder);
      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '⚡ 공유 도서 내부 복사',
        target: `${importResult.fileName} ➔ ${targetUserFolder || 'root'}`,
        status: 200,
        user: authenticatedUserMemo
      });

      return sendJsonResponse(req, res, 200, importResult);
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '공유 도서 복사 실패', target: err.message, status: 500, user: authenticatedUserMemo });
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

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
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '📚 공유 서재 목록 조회', target: `${books.length}권`, status: 200, user: authenticatedUserMemo });
    return sendJsonResponse(req, res, 200, {
      ok: true,
      sharedDir,
      totalBooks: books.length,
      books
    });
  }

  if (req.method === 'GET' && pathname === '/api/storage/remote-library/download') {
    const env = readEnvFile();
    const sharedDir = env.SHARED_BOOKS_DIR;
    const reqFile = reqUrl.searchParams.get('file');

    if (!sharedDir || !reqFile) {
      return sendJsonResponse(req, res, 400, { error: 'file 쿼리 파라미터가 누락되었습니다.' });
    }

    const fileInfo = storageService.getRemoteBookFilePath(sharedDir, reqFile);
    if (!fileInfo) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '공유 도서 다운로드 실패', target: reqFile, status: 404, user: authenticatedUserMemo });
      return sendJsonResponse(req, res, 404, { error: '도서 파일을 찾을 수 없거나 접근이 거부되었습니다.' });
    }

    const isTxt = fileInfo.fileName.toLowerCase().endsWith('.txt');
    const contentType = isTxt ? 'text/plain; charset=utf-8' : 'application/epub+zip';

    auditLogger.recordAccessLog({
      ip: clientIp,
      userAgent,
      action: isTxt ? '📄 TXT 도서 스트리밍' : '📖 EPUB 도서 스트리밍',
      target: fileInfo.fileName,
      status: 200,
      user: authenticatedUserMemo
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

  if (req.method === 'GET' && pathname === '/api/storage/snapshot') {
    try {
      const snapshot = await storageService.getUnifiedSnapshot(targetUserFolder);
      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '📚 서재 스냅샷 조회',
        target: `${targetUserFolder || 'root'} (활성 ${snapshot.cloudBooks.length}권 / 보관 ${snapshot.cloudArchivedBooks.length}권)`,
        status: 200,
        user: authenticatedUserMemo
      });
      return sendJsonResponse(req, res, 200, snapshot);
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '서재 스냅샷 실패', target: err.message, status: 500, user: authenticatedUserMemo });
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

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
        status: 200,
        user: authenticatedUserMemo
      });
      return sendJsonResponse(req, res, 200, { ok: true, bookId });
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '도서 메타 저장 실패', target: bookId, status: 500, user: authenticatedUserMemo });
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

  if (req.method === 'GET' && pathname.startsWith('/api/storage/books/') && !pathname.endsWith('/epub')) {
    const bookId = decodeURIComponent(pathname.replace('/api/storage/books/', ''));
    const meta = storageService.getBookMetadata(bookId, targetUserFolder);
    if (!meta) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '도서 메타 조회 실패', target: bookId, status: 404, user: authenticatedUserMemo });
      return sendJsonResponse(req, res, 404, { error: '도서를 찾을 수 없습니다.' });
    }
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '도서 메타 조회', target: `${meta.title || bookId} (${targetUserFolder || 'root'})`, status: 200, user: authenticatedUserMemo });
    return sendJsonResponse(req, res, 200, meta);
  }

  if (req.method === 'POST' && pathname.startsWith('/api/storage/books/') && pathname.endsWith('/epub')) {
    const bookId = decodeURIComponent(pathname.replace('/api/storage/books/', '').replace('/epub', ''));
    const contentLength = Number(req.headers['content-length'] || 0);

    if (targetUserFolder && contentLength > 0) {
      const quotaCheck = storageService.checkUserStorageQuota(targetUserFolder, contentLength, userQuotaBytes);
      if (!quotaCheck.allowed) {
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '용량 초과 업로드 차단', target: `${bookId} (${targetUserFolder})`, status: 413, user: authenticatedUserMemo });
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
        status: 200,
        user: authenticatedUserMemo
      });
      return sendJsonResponse(req, res, 200, { ok: true, bookId, size: buffer.length });
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'EPUB 업로드 실패', target: bookId, status: 500, user: authenticatedUserMemo });
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

  if (req.method === 'GET' && pathname.startsWith('/api/storage/books/') && pathname.endsWith('/epub')) {
    const rawSegment = pathname.replace('/api/storage/books/', '').replace(/\/epub$/, '');
    const bookId = decodeURIComponent(rawSegment);

    const info = storageService.getBookEpubPath(bookId, targetUserFolder);
    if (!info) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'EPUB 다운로드 실패', target: bookId, status: 404, user: authenticatedUserMemo });
      return sendJsonResponse(req, res, 404, { error: 'EPUB 파일을 찾을 수 없습니다.' });
    }

    const sizeMb = (info.size / 1024 / 1024).toFixed(1);
    auditLogger.recordAccessLog({
      ip: clientIp,
      userAgent,
      action: '📖 EPUB 다운로드',
      target: `${bookId} (${sizeMb}MB / ${targetUserFolder || 'root'})`,
      status: 200,
      user: authenticatedUserMemo
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

  if (req.method === 'POST' && pathname.startsWith('/api/storage/covers/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/covers/', ''));
    try {
      const buffer = await readRequestBodyBuffer(req, 10 * 1024 * 1024);
      storageService.saveCoverImage(fileName, buffer, targetUserFolder);
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '🖼️ 표지 업로드', target: `${fileName} (${targetUserFolder || 'root'})`, status: 200, user: authenticatedUserMemo });
      return sendJsonResponse(req, res, 200, { ok: true, fileName });
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '표지 업로드 실패', target: fileName, status: 500, user: authenticatedUserMemo });
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

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

  if (req.method === 'DELETE' && pathname.startsWith('/api/storage/covers/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/covers/', ''));
    storageService.deleteCoverImage(fileName, targetUserFolder);
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '🖼️ 표지 단일 삭제', target: `${fileName} (${targetUserFolder || 'root'})`, status: 200, user: authenticatedUserMemo });
    return sendJsonResponse(req, res, 200, { ok: true, fileName });
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/storage/books/')) {
    const bookId = decodeURIComponent(pathname.replace('/api/storage/books/', ''));
    const count = storageService.deleteBookAll(bookId, targetUserFolder);
    auditLogger.recordAccessLog({
      ip: clientIp,
      userAgent,
      action: '🗑️ 도서 완전 삭제',
      target: `${bookId} (${count}개 파일 파쇄 / ${targetUserFolder || 'root'})`,
      status: 200,
      user: authenticatedUserMemo
    });
    return sendJsonResponse(req, res, 200, { ok: true, deletedFiles: count });
  }

  if (req.method === 'POST' && pathname.startsWith('/api/storage/settings/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/settings/', ''));
    try {
      const buffer = await readRequestBodyBuffer(req, 5 * 1024 * 1024);
      const data = JSON.parse(buffer.toString('utf-8'));
      storageService.saveSettingsFile(fileName, data, targetUserFolder);
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '⚙️ 시스템 데이터 동기화', target: `${fileName} (${targetUserFolder || 'root'})`, status: 200, user: authenticatedUserMemo });
      return sendJsonResponse(req, res, 200, { ok: true, fileName });
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '시스템 동기화 실패', target: fileName, status: 500, user: authenticatedUserMemo });
      return sendJsonResponse(req, res, 500, { error: err.message });
    }
  }

  if (req.method === 'GET' && pathname.startsWith('/api/storage/settings/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/settings/', ''));
    const data = storageService.getSettingsFile(fileName, targetUserFolder);
    if (!data) return sendJsonResponse(req, res, 404, { error: '설정 파일을 찾을 수 없습니다.' });
    return sendJsonResponse(req, res, 200, data);
  }

  // =========================================================================
  // 5. 🌟 Google OAuth 인증 라우트 (중간 HTML 없이 0초 즉시 구글 창 점프)
  // =========================================================================

  // 1) [GET /auth/google] 로그인 링크 ➔ 중간 HTML 게이트 없이 즉각 302 구글 로그인 URL 이동
  if (req.method === 'GET' && pathname === '/auth/google') {
    try {
      const authUrl = generateAuthUrl();
      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '구글 계정 연동 시작',
        target: '구글 공식 인증 창으로 즉시 이동',
        status: 302,
        user: 'Root Admin'
      });
      res.writeHead(302, { Location: authUrl });
      res.end();
      return;
    } catch (err) {
      console.error('[OAuth Init Error]', err.message);
      return sendHtmlResponse(req, res, 500, '로그인 시작 오류', 'Google 로그인 URL을 생성하지 못했습니다. Google Client ID 및 Secret 설정을 확인해 주세요.', false);
    }
  }

  // 2) [GET /auth/google/callback] Google 승인 후 돌아오는 콜백 라우트
  if (req.method === 'GET' && pathname === '/auth/google/callback') {
    const code = reqUrl.searchParams.get('code');
    const state = reqUrl.searchParams.get('state');
    const error = reqUrl.searchParams.get('error');

    if (error) {
      return sendHtmlResponse(req, res, 400, 'Google 승인 거부', `Google 인증이 거부되었습니다: ${error}`, false);
    }

    if (!state || !verifyState(state)) {
      return sendHtmlResponse(req, res, 400, '인증 실패 (State 검증 실패)', '보안 검증(State)에 실패했습니다. 다시 시도해 주세요.', false);
    }

    if (!code) {
      return sendHtmlResponse(req, res, 400, '인증 코드 누락', 'Google로부터 Authorization Code를 수신하지 못했습니다.', false);
    }

    try {
      await exchangeCodeForTokens(code);
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'Google OAuth 토큰 교환 성공', target: '토큰 암호화 저장 완료', status: 200, user: 'Root Admin' });
      return sendHtmlResponse(
        req,
        res,
        200,
        'Google Drive 연동 성공',
        'Google Drive 인증 정보가 서버에 안전하게 암호화되어 저장되었습니다. 이제 웹 뷰어에서 클라우드 동기화 기능을 사용할 수 있습니다.',
        true
      );
    } catch (err) {
      return sendHtmlResponse(req, res, 500, '토큰 교환 실패', `인증 토큰을 저장하지 못했습니다: ${err.message}`, false);
    }
  }

  // 3) [GET /api/access-token] 평소 독서 중 백그라운드 자동 갱신 엔드포인트
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

  // 📊 백그라운드 시스템 모니터링 엔진 자동 가동
  systemMonitor.startMonitoring();
});