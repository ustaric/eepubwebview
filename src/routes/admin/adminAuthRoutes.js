/**
 * @file src/routes/admin/adminAuthRoutes.js
 * @description 관리자 세션 토큰, 쿠키 인증, 로그인 5회 브루트포스 차단 및 로그인·대시보드 화면 라우터
 * - 🔒 [세션 & 브루트포스 SSOT] adminSessionTokens(Set), loginAttemptMap(Map) 및 5분 정리 타이머 단독 소유
 * - 🛡️ [로그인 5회 차단] 1분 내 5회 실패 시 15분 차단 및 auditLogger 401/429 기록
 * - 🖥️ [화면 렌더링] GET /admin, /settings 요청 시 로그인 페이지 또는 관리자 콘솔 HTML 반환
 */

import crypto from 'crypto';
import { readEnvFile, writeEnvFile } from '../../envManager.js';
import { auditLogger } from '../../auditLogger.js';
import { renderLoginPageHtml, renderAdminSettingsHtml } from '../../adminViews.js';

// 🔒 [관리자 인증 세션] 유효 세션 토큰 저장소 (메모리 격리)
const adminSessionTokens = new Set();

// 🔒 [관리자 로그인 전용 브루트포스 차단 맵] (1분 내 5회 실패 시 15분 락)
const loginAttemptMap = new Map();

// 5분마다 만료된 로그인 차단 기록 정리
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of loginAttemptMap.entries()) {
    if (now > data.resetTime && (!data.blockedUntil || now > data.blockedUntil)) {
      loginAttemptMap.delete(ip);
    }
  }
}, 5 * 60 * 1000);

/**
 * 🔒 [관리자 로그인 브루트포스 검사]
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
 * 로그인 실패 횟수 기록
 * @param {string} ip
 * @returns {void}
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
 * 로그인 성공 시 실패 이력 초기화
 * @param {string} ip
 * @returns {void}
 */
function clearLoginFailure(ip) {
  loginAttemptMap.delete(ip);
}

/**
 * 🍪 요청 헤더에서 쿠키 파싱
 * @param {import('http').IncomingMessage} req
 * @returns {Record<string, string>}
 */
export function parseCookies(req) {
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
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
export function isAuthenticated(req) {
  const env = readEnvFile();
  const adminPassword = env.ADMIN_PASSWORD;

  if (!adminPassword || adminPassword.trim() === '') {
    return false;
  }

  const cookies = parseCookies(req);
  const sessionToken = cookies['admin_session'];
  return Boolean(sessionToken && adminSessionTokens.has(sessionToken));
}

/**
 * 새 관리자 세션 토큰 발급 및 등록
 * @returns {string}
 */
export function createAdminSession() {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessionTokens.add(token);
  return token;
}

/**
 * 지정 관리자 세션 토큰 파기
 * @param {string} token
 * @returns {void}
 */
export function destroyAdminSession(token) {
  if (token) {
    adminSessionTokens.delete(token);
  }
}

/**
 * 관리자 로그인, 로그아웃 및 메인 대시보드 HTML 화면 요청을 처리합니다.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @param {string} clientIp
 * @param {string} userAgent
 * @returns {Promise<boolean>} 라우트 처리 여부
 */
export async function handleAdminAuthRoute(req, res, pathname, clientIp, userAgent) {
  // 1. 관리자 로그인 처리 (POST /admin/login)
  if (req.method === 'POST' && pathname === '/admin/login') {
    const loginGuard = checkLoginRateLimit(clientIp);
    if (!loginGuard.allowed) {
      console.warn(`⛔ [Login Lock] 무차별 대입 방어로 IP ${clientIp} 차단 중 (${loginGuard.waitMinutes}분 남음)`);
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '관리자 로그인 시도', target: '차단 잠금', status: 429, user: 'Root Admin' });
      const html = renderLoginPageHtml(`로그인 시도 횟수가 초과되었습니다. ${loginGuard.waitMinutes}분 후에 다시 시도해 주세요.`, false);
      res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return true;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
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
          clearLoginFailure(clientIp);
          auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '관리자 비밀번호 설정', target: '최초 등록', status: 200, user: 'Root Admin' });

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
          auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '관리자 로그인 성공', target: '대시보드 진입', status: 200, user: 'Root Admin' });
          const sessionToken = createAdminSession();
          res.writeHead(302, {
            'Set-Cookie': `admin_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
            'Location': '/admin'
          });
          res.end();
        } else {
          recordLoginFailure(clientIp);
          const remaining = 5 - (loginAttemptMap.get(clientIp)?.failCount || 0);
          console.warn(`🔒 [AuthTrace:AdminLogin] 비번 오류 | 호출자: [POST /admin/login] | IP: ${clientIp} | 남은시도: ${Math.max(0, remaining)} | auditLogger 401 기록 전달`);
          auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '관리자 로그인 실패', target: `비번 오류 (남은시도: ${Math.max(0, remaining)})`, status: 401, user: 'Root Admin' });
          const html = renderLoginPageHtml(`비밀번호가 올바르지 않습니다. (남은 시도: ${Math.max(0, remaining)}회)`, false);
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      } catch (err) {
        console.error('❌ [AdminController:LoginError] 로그인 처리 중 예외 발생:', err);
        if (!res.headersSent && !res.writableEnded) {
          const html = renderLoginPageHtml('로그인 처리 중 서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.', false);
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      }
    });
    return true;
  }

  // 2. 관리자 로그아웃 처리 (GET /admin/logout)
  if (req.method === 'GET' && pathname === '/admin/logout') {
    const cookies = parseCookies(req);
    destroyAdminSession(cookies['admin_session']);
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '관리자 로그아웃', target: '세션 파기', status: 200, user: 'Root Admin' });
    res.writeHead(302, {
      'Set-Cookie': 'admin_session=; Path=/; HttpOnly; Max-Age=0',
      'Location': '/admin'
    });
    res.end();
    return true;
  }

  // 3. 관리자 메인 화면 렌더링 (GET /admin 또는 /settings)
  if (req.method === 'GET' && (pathname === '/admin' || pathname === '/settings')) {
    const env = readEnvFile();
    const isInitialSetup = !env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.trim() === '';

    if (!isAuthenticated(req)) {
      const html = renderLoginPageHtml(null, isInitialSetup);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      res.end(html);
      return true;
    }

    const html = renderAdminSettingsHtml(req);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(html);
    return true;
  }

  return false;
}