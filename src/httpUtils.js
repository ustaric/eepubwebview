/**
 * @file src/httpUtils.js
 * @description HTTP 요청 파싱, CORS, Rate Limiting 및 응답 생성 전담 공통 인프라 유틸리티 모듈
 * - 🛡️ [CORS & 보안 헤더 자동 주입] injectSecurityHeaders 연동, ALLOWED_ORIGIN 기반 동적 CORS 및 Vary: Origin 캐시 격리 헤더 제어
 * - 🚦 [IP 기반 요청 폭주 방어] 1분 단위 요청 제한 및 5분 주기 메모리 자가 소독(GC)
 * - 🔒 [OTP 무차별 대입 방어] 1분 내 5회 실패 시 10분 강제 락 및 실시간 대기 시간(분) 산출
 * - 🔑 [인증 식별자 지능형 추출] Header(X-API-KEY / Authorization Bearer) 및 URL Query(?apiKey) 통합 파싱
 * - 📱 [기기 식별 헤더 정규화] X-Device-Id 및 안전하게 URL 디코딩된 X-Device-Name 추출
 * - 📦 [차등 바디 수신 버퍼] 스트리밍 청크 누적 및 한도 초과 즉시 연결 파기(Fail-Safe)
 */

import { URL } from 'url';
import { config } from '../config.js';
import { readEnvFile } from './envManager.js';
import { injectSecurityHeaders } from './securityGuard.js';

/**
 * 🛡️ [Rate Limiting] 메모리 기반 IP별 요청 제한 저장소
 */
const rateLimitMap = new Map();

/**
 * 🔒 [OTP 무차별 대입 방어 맵] (1분 내 5회 실패 시 10분 락)
 */
const otpAttemptMap = new Map();

// 5분 주기 만료된 RateLimit 메모리 자가 소독
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

/**
 * 클라이언트의 실제 IP 주소를 추출합니다. (리버스 프록시 X-Forwarded-For 지원)
 * @param {import('http').IncomingMessage} req 
 * @returns {string}
 */
export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

/**
 * IP별 분당 요청 횟수를 검사합니다.
 * @param {import('http').IncomingMessage} req 
 * @param {number} [maxRequests=120] 
 * @returns {boolean} 허용 여부
 */
export function checkRateLimit(req, maxRequests = 120) {
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
 * OTP 인증 시도 횟수 제한을 검사합니다. (5회 실패 시 10분 락)
 * @param {string} ip 
 * @returns {{ allowed: boolean, waitMinutes?: number }}
 */
export function checkOtpRateLimit(ip) {
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

/**
 * OTP 인증 실패 카운트를 1 증가시킵니다.
 * @param {string} ip 
 */
export function recordOtpFailure(ip) {
  const now = Date.now();
  let record = otpAttemptMap.get(ip);
  if (!record || now > record.resetTime) {
    record = { failCount: 1, resetTime: now + (60 * 1000), blockedUntil: 0 };
  } else {
    record.failCount += 1;
  }
  otpAttemptMap.set(ip, record);
}

/**
 * OTP 인증 성공 시 실패 카운트를 소독합니다.
 * @param {string} ip 
 */
export function clearOtpFailure(ip) {
  otpAttemptMap.delete(ip);
}

/**
 * 헤더, Bearer 토큰, 쿼리 파라미터에서 API 키를 통합 추출합니다.
 * @param {import('http').IncomingMessage} req 
 * @param {URL} reqUrl 
 * @returns {string|null}
 */
export function extractApiKey(req, reqUrl) {
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

/**
 * 헤더 또는 쿼리에서 기기 식별 정보를 안전하게 추출합니다.
 * @param {import('http').IncomingMessage} req 
 * @param {URL} reqUrl 
 * @returns {{ deviceId: string, deviceName: string }}
 */
export function extractDeviceInfo(req, reqUrl) {
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

/**
 * 엄격 출처(ALLOWED_ORIGIN) 설정 여부 및 클라이언트 요청 출처 유효성을 검증합니다.
 * @param {import('http').IncomingMessage} req 
 * @returns {boolean}
 */
export function isAllowedClientOrigin(req) {
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

/**
 * 보안 응답 헤더 및 CORS 접근 허용 헤더를 주입합니다.
 * @param {import('http').IncomingMessage} req 
 * @param {import('http').ServerResponse} res 
 */
export function setCorsHeaders(req, res) {
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

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-API-KEY, X-Device-Id, X-Device-Name');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/**
 * JSON 응답을 전송합니다.
 * @param {import('http').IncomingMessage} req 
 * @param {import('http').ServerResponse} res 
 * @param {number} statusCode 
 * @param {any} payload 
 */
export function sendJsonResponse(req, res, statusCode, payload) {
  setCorsHeaders(req, res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

/**
 * OAuth 완료 또는 에러 안내용 HTML 페이지 응답을 전송합니다.
 * @param {import('http').IncomingMessage} req 
 * @param {import('http').ServerResponse} res 
 * @param {number} statusCode 
 * @param {string} title 
 * @param {string} message 
 * @param {boolean} [isSuccess=true] 
 */
export function sendHtmlResponse(req, res, statusCode, title, message, isSuccess = true) {
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
 * 요청 바디(Body)를 Buffer로 안전하게 수신합니다. (최대 바이트 초과 시 연결 즉각 파기)
 * @param {import('http').IncomingMessage} req 
 * @param {number} [maxBytes=5242880] 
 * @returns {Promise<Buffer>}
 */
export function readRequestBodyBuffer(req, maxBytes = 5242880) {
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