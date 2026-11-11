/**
 * @file src/adminController.js
 * @description 관리자 웹 제어 센터 라우터, 쿠키 인증, 브루트포스 락, 다중 사용자 API 관리 및 설정 저장 전담 컨트롤러
 * - 📱 [기기 관리 라우트 탑재] /admin/users/devices/block, unblock, delete 지원으로 특정 기기 핀포인트 밴 및 슬롯 반환
 * - 📱 [기기 한도 변경 라우트] POST /admin/users/update-max-devices 지원으로 계정별 최대 허용 기기 수(기본 6대) 조절
 * - ⚙️ [용량 변경 라우트 탑재] POST /admin/users/update-quota 지원으로 사용자별 도서 할당 용량 실시간 갱신
 * - 👥 [다중 사용자 관리 라우트 탑재] /admin/users/create, /admin/users/reissue, /admin/users/delete 핸들러
 * - 🔑 [발급 키 1회 복사 지원] 신규/재발급 성공 시 원문 API 키를 관리자 화면에 즉시 모달로 표출
 * - 🚦 [관리자 통합 라우트 디스패처] handleAdminRoute 제공으로 server.js와 직통 위임 유지
 * - 📁 [간이 파일 탐색기 API 탑재] GET /admin/fs-tree 제공으로 서버 디렉터리 브라우징 지원
 * - 🛡️ [실시간 폴더 권한 실측 API] POST /admin/test-folder 제공으로 프로세스 읽기 권한 즉시 검증
 * - 📥 [보안 감사 로그 다운로드/삭제] securityGuard 연동 실시간 로그 다운로드 및 영구 파쇄 지원
 * - 🔒 [로그인 5회 브루트포스 락] IP별 실패 횟수 추적 및 1분 내 5회 오류 시 15분 차단 가드 캡슐화
 * - 🔔 [디스코드 환경변수 무손실 보존] 전체 설정 저장 시 DISCORD_ALERT_TYPES, DISCORD_DAILY_DIGEST 보존
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { readEnvFile, writeEnvFile, ensureStorageDirectories } from './envManager.js';
import { storageService } from './storageService.js';
import { auditLogger } from './auditLogger.js';
import { validateSafePath } from './securityGuard.js';
import { apiKeyManager } from './apiKeyManager.js';

// 🌟 분리된 순수 View 렌더러 import
import { renderLoginPageHtml, renderAdminSettingsHtml } from './adminViews.js';

export { renderLoginPageHtml, renderAdminSettingsHtml };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const LOGS_DIR = path.resolve(ROOT_DIR, 'data/logs');

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

export function createAdminSession() {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessionTokens.add(token);
  return token;
}

export function destroyAdminSession(token) {
  if (token) {
    adminSessionTokens.delete(token);
  }
}

/**
 * 🌟 [관리자 라우트 전담 통합 디스패처]
 */
export async function handleAdminRoute(req, res, pathname, clientIp, userAgent) {
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
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '관리자 로그인 실패', target: `비번 오류 (남은시도: ${Math.max(0, remaining)})`, status: 401, user: 'Root Admin' });
        const html = renderLoginPageHtml(`비밀번호가 올바르지 않습니다. (남은 시도: ${Math.max(0, remaining)}회)`, false);
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return true;
    }

    const html = renderAdminSettingsHtml(req);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return true;
  }

  // =========================================================================
  // 👥 4. 다중 사용자 API 키 & 기기 관리 라우트
  // =========================================================================

  // 1) [새 사용자 키 발급] POST /admin/users/create
  if (req.method === 'POST' && pathname === '/admin/users/create') {
    if (!isAuthenticated(req)) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return true;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const memo = params.get('memo')?.trim() || '새 사용자';
        const quotaMb = parseInt(params.get('quotaMb') || '1024', 10);
        const maxDevices = parseInt(params.get('maxDevices') || '6', 10);

        const result = apiKeyManager.issueApiKey({ memo, quotaMb, maxDevices, role: 'user' });
        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '👥 새 사용자 키 발급',
          target: `${memo} (${result.folderName}, 기기한도: ${result.maxDevices}대)`,
          status: 200,
          user: `${memo} (${result.folderName})`
        });

        const html = renderAdminSettingsHtml(req, '새 사용자 API 키가 발급되었습니다!', null, {
          type: 'CREATE',
          apiKey: result.apiKey,
          folderName: result.folderName,
          memo: result.memo,
          expiresAt: result.expiresAt
        });

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        const html = renderAdminSettingsHtml(req, null, '사용자 키 발급 실패: ' + err.message);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      }
    });
    return true;
  }

  // 2) [사용자 키 재발급] POST /admin/users/reissue
  if (req.method === 'POST' && pathname === '/admin/users/reissue') {
    if (!isAuthenticated(req)) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return true;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const folderName = params.get('folderName')?.trim() || '';

        const result = apiKeyManager.reissueApiKey(folderName);
        if (!result.success) {
          throw new Error(result.error || '재발급 실패');
        }

        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '🔄 사용자 키 재발급',
          target: `${result.memo} (${folderName})`,
          status: 200,
          user: `${result.memo} (${folderName})`
        });

        const html = renderAdminSettingsHtml(req, `'${result.memo}' 사용자의 새 API 키가 발급되었습니다. (기존 책/기기 100% 보존)`, null, {
          type: 'REISSUE',
          apiKey: result.newApiKey,
          folderName: result.folderName,
          memo: result.memo,
          expiresAt: result.expiresAt
        });

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        const html = renderAdminSettingsHtml(req, null, '키 재발급 실패: ' + err.message);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      }
    });
    return true;
  }

  // 3) [사용자 도서 저장 용량 변경] POST /admin/users/update-quota
  if (req.method === 'POST' && pathname === '/admin/users/update-quota') {
    if (!isAuthenticated(req)) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return true;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const folderName = params.get('folderName')?.trim() || '';
        const quotaMb = parseInt(params.get('quotaMb') || '1024', 10);

        const result = apiKeyManager.updateUserQuota(folderName, quotaMb);
        if (!result.success) {
          throw new Error(result.error || '용량 변경 실패');
        }

        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '⚙️ 서재 용량 변경',
          target: `${result.memo} ➔ ${result.quotaMb}MB`,
          status: 200,
          user: `${result.memo} (${folderName})`
        });

        const html = renderAdminSettingsHtml(req, `'${result.memo}' (${folderName}) 서재의 저장 용량이 ${result.quotaMb}MB로 변경되었습니다.`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        const html = renderAdminSettingsHtml(req, null, '용량 변경 실패: ' + err.message);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      }
    });
    return true;
  }

  // 4) [사용자 최대 기기 한도 변경] POST /admin/users/update-max-devices
  if (req.method === 'POST' && pathname === '/admin/users/update-max-devices') {
    const isAjax = req.headers['accept']?.includes('application/json') || req.headers['x-requested-with'] === 'XMLHttpRequest';

    if (!isAuthenticated(req)) {
      if (isAjax) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
      } else {
        res.writeHead(302, { Location: '/admin' });
        res.end();
      }
      return true;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const folderName = params.get('folderName')?.trim() || '';
        const maxDevices = parseInt(params.get('maxDevices') || '6', 10);

        const result = apiKeyManager.updateUserMaxDevices(folderName, maxDevices);
        if (!result.success) {
          throw new Error(result.error || '기기 한도 변경 실패');
        }

        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '📱 기기 한도 변경',
          target: `${result.memo} ➔ 최대 ${result.maxDevices}대`,
          status: 200,
          user: `${result.memo} (${folderName})`
        });

        if (isAjax) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, maxDevices: result.maxDevices }));
        } else {
          const html = renderAdminSettingsHtml(req, `'${result.memo}' (${folderName}) 사용자의 최대 기기 한도가 ${result.maxDevices}대로 변경되었습니다.`);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      } catch (err) {
        if (isAjax) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        } else {
          const html = renderAdminSettingsHtml(req, null, '기기 한도 변경 실패: ' + err.message);
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      }
    });
    return true;
  }

  // 5) [특정 기기 차단 (Ban)] POST /admin/users/devices/block
  if (req.method === 'POST' && pathname === '/admin/users/devices/block') {
    const isAjax = req.headers['accept']?.includes('application/json') || req.headers['x-requested-with'] === 'XMLHttpRequest';

    if (!isAuthenticated(req)) {
      if (isAjax) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
      } else {
        res.writeHead(302, { Location: '/admin' });
        res.end();
      }
      return true;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const folderName = params.get('folderName')?.trim() || '';
        const deviceId = params.get('deviceId')?.trim() || '';

        const result = apiKeyManager.blockDevice(folderName, deviceId);
        if (!result.success) {
          throw new Error(result.error || '기기 차단 실패');
        }

        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '🚫 기기 차단 (Ban)',
          target: `${result.device?.deviceName || deviceId} (${folderName})`,
          status: 200,
          user: 'Root Admin'
        });

        if (isAjax) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, device: result.device }));
        } else {
          const html = renderAdminSettingsHtml(req, `기기('${result.device?.deviceName || deviceId}')가 성공적으로 차단되었습니다.`);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      } catch (err) {
        if (isAjax) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        } else {
          const html = renderAdminSettingsHtml(req, null, '기기 차단 실패: ' + err.message);
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      }
    });
    return true;
  }

  // 6) [특정 기기 차단 해제 (Unban)] POST /admin/users/devices/unblock
  if (req.method === 'POST' && pathname === '/admin/users/devices/unblock') {
    const isAjax = req.headers['accept']?.includes('application/json') || req.headers['x-requested-with'] === 'XMLHttpRequest';

    if (!isAuthenticated(req)) {
      if (isAjax) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
      } else {
        res.writeHead(302, { Location: '/admin' });
        res.end();
      }
      return true;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const folderName = params.get('folderName')?.trim() || '';
        const deviceId = params.get('deviceId')?.trim() || '';

        const result = apiKeyManager.unblockDevice(folderName, deviceId);
        if (!result.success) {
          throw new Error(result.error || '기기 차단 해제 실패');
        }

        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '🟢 기기 차단 해제 (Unban)',
          target: `${result.device?.deviceName || deviceId} (${folderName})`,
          status: 200,
          user: 'Root Admin'
        });

        if (isAjax) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, device: result.device }));
        } else {
          const html = renderAdminSettingsHtml(req, `기기('${result.device?.deviceName || deviceId}')의 차단이 해제되었습니다.`);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      } catch (err) {
        if (isAjax) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        } else {
          const html = renderAdminSettingsHtml(req, null, '기기 차단 해제 실패: ' + err.message);
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      }
    });
    return true;
  }

  // 7) [특정 기기 삭제 (슬롯 반환)] POST /admin/users/devices/delete
  if (req.method === 'POST' && pathname === '/admin/users/devices/delete') {
    const isAjax = req.headers['accept']?.includes('application/json') || req.headers['x-requested-with'] === 'XMLHttpRequest';

    if (!isAuthenticated(req)) {
      if (isAjax) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
      } else {
        res.writeHead(302, { Location: '/admin' });
        res.end();
      }
      return true;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const folderName = params.get('folderName')?.trim() || '';
        const deviceId = params.get('deviceId')?.trim() || '';

        const result = apiKeyManager.deleteDevice(folderName, deviceId);
        if (!result.success) {
          throw new Error(result.error || '기기 삭제 실패');
        }

        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '🗑️ 등록 기기 삭제 (슬롯 반환)',
          target: `${deviceId} (${folderName})`,
          status: 200,
          user: 'Root Admin'
        });

        if (isAjax) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, deletedDeviceId: deviceId }));
        } else {
          const html = renderAdminSettingsHtml(req, `기기가 등록 목록에서 삭제되어 슬롯이 확보되었습니다.`);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      } catch (err) {
        if (isAjax) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        } else {
          const html = renderAdminSettingsHtml(req, null, '기기 삭제 실패: ' + err.message);
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      }
    });
    return true;
  }

  // 8) [사용자 삭제] POST /admin/users/delete
  if (req.method === 'POST' && pathname === '/admin/users/delete') {
    if (!isAuthenticated(req)) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return true;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const folderName = params.get('folderName')?.trim() || '';
        const deleteFolder = params.get('deleteFolder') === 'true';

        const result = apiKeyManager.revokeApiKey(folderName, deleteFolder);
        if (!result.success) {
          throw new Error(result.error || '삭제 실패');
        }

        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: deleteFolder ? '🗑️ 사용자 및 도서 완전 삭제' : '🔒 사용자 API 키 폐기',
          target: folderName,
          status: 200,
          user: folderName
        });

        const successMsg = deleteFolder
          ? `'${folderName}' 사용자의 API 키와 도서 폴더가 영구 삭제되었습니다.`
          : `'${folderName}' 사용자의 API 키가 폐기되었습니다. (도서 폴더 보존)`;

        const html = renderAdminSettingsHtml(req, successMsg);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        const html = renderAdminSettingsHtml(req, null, '사용자 삭제 실패: ' + err.message);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      }
    });
    return true;
  }

  // 5. 간이 탐색기 디렉터리 트리 조회 API (GET /admin/fs-tree)
  if (req.method === 'GET' && pathname === '/admin/fs-tree') {
    if (!isAuthenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
      return true;
    }

    const reqUrl = new URL(req.url, 'http://localhost');
    const targetPath = reqUrl.searchParams.get('path') || '/';
    const treeData = storageService.getDirectoryTree(targetPath);

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(treeData));
    return true;
  }

  // 6. 폴더 권한 실측 검증 API (POST /admin/test-folder)
  if (req.method === 'POST' && pathname === '/admin/test-folder') {
    if (!isAuthenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
      return true;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const folderPath = payload.folderPath || '';
        const testResult = storageService.testDirectoryPermissions(folderPath);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(testResult));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return true;
  }

  // 7. 일자별 보안 감사 로그 다운로드 (GET /admin/logs/download)
  if (req.method === 'GET' && pathname === '/admin/logs/download') {
    if (!isAuthenticated(req)) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return true;
    }

    const reqUrl = new URL(req.url, 'http://localhost');
    const relFile = reqUrl.searchParams.get('file');

    if (!relFile) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'file 파라미터 누락' }));
      return true;
    }

    const pathCheck = validateSafePath(LOGS_DIR, relFile);
    if (!pathCheck.safe) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'FORBIDDEN' }));
      return true;
    }

    const formattedJson = auditLogger.getFormattedLogContent(relFile);
    if (!formattedJson) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '로그 파일 없음' }));
      return true;
    }

    const downloadFileName = path.basename(relFile).replace(/\.jsonl$/i, '.json');
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '📥 감사 로그 다운로드', target: downloadFileName, status: 200, user: 'Root Admin' });

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(downloadFileName)}"`
    });
    res.end(formattedJson);
    return true;
  }

  // 8. 일자별 보안 감사 로그 삭제 (GET /admin/logs/delete)
  if (req.method === 'GET' && pathname === '/admin/logs/delete') {
    if (!isAuthenticated(req)) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return true;
    }

    const reqUrl = new URL(req.url, 'http://localhost');
    const relFile = reqUrl.searchParams.get('file');

    if (relFile) {
      const pathCheck = validateSafePath(LOGS_DIR, relFile);
      if (pathCheck.safe) {
        auditLogger.deleteLogFile(relFile);
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '🗑️ 감사 로그 삭제', target: relFile, status: 200, user: 'Root Admin' });
      }
    }

    res.writeHead(302, { Location: '/admin' });
    res.end();
    return true;
  }

  // 9. 크래시 리포트 다운로드
  if (req.method === 'GET' && pathname.startsWith('/admin/crash-reports/download/')) {
    if (!isAuthenticated(req)) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return true;
    }

    const fileName = decodeURIComponent(pathname.replace('/admin/crash-reports/download/', ''));
    const info = storageService.getCrashReportPath(fileName);
    if (!info) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '리포트 파일 없음' }));
      return true;
    }

    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '크래시 리포트 다운로드', target: fileName, status: 200, user: 'Root Admin' });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': info.size,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`
    });
    const readStream = fs.createReadStream(info.filePath);
    readStream.pipe(res);
    return true;
  }

  // 10. 크래시 리포트 단일 삭제
  if (req.method === 'GET' && pathname.startsWith('/admin/crash-reports/delete/')) {
    if (!isAuthenticated(req)) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return true;
    }

    const fileName = decodeURIComponent(pathname.replace('/admin/crash-reports/delete/', ''));
    storageService.deleteCrashReport(fileName);
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '크래시 리포트 삭제', target: fileName, status: 200, user: 'Root Admin' });
    res.writeHead(302, { Location: '/admin' });
    res.end();
    return true;
  }

  // 11. 크래시 리포트 전체 비우기
  if (req.method === 'GET' && pathname === '/admin/crash-reports/clear') {
    if (!isAuthenticated(req)) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return true;
    }

    storageService.clearAllCrashReports();
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '크래시 리포트 전체 삭제', target: 'all', status: 200, user: 'Root Admin' });
    res.writeHead(302, { Location: '/admin' });
    res.end();
    return true;
  }

  // 12. 환경변수 전체 파싱 및 영구 저장 (POST /admin/save)
  if (req.method === 'POST' && pathname === '/admin/save') {
    if (!isAuthenticated(req)) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return true;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const updates = {};
        
        // 🌟 [핵심 개선] 기존 env에 저장되어 있던 Discord 관제 3대 설정 무손실 보존
        const currentEnv = readEnvFile();
        if (currentEnv.DISCORD_WEBHOOK_URL) {
          updates.DISCORD_WEBHOOK_URL = currentEnv.DISCORD_WEBHOOK_URL;
        }
        if (currentEnv.DISCORD_ALERT_TYPES) {
          updates.DISCORD_ALERT_TYPES = currentEnv.DISCORD_ALERT_TYPES;
        }
        if (currentEnv.DISCORD_DAILY_DIGEST) {
          updates.DISCORD_DAILY_DIGEST = currentEnv.DISCORD_DAILY_DIGEST;
        }

        const port = params.get('PORT')?.trim();
        if (port) updates.PORT = port;

        const host = params.get('HOST')?.trim();
        if (host) updates.HOST = host;

        const tokenFile = params.get('TOKEN_FILE')?.trim();
        if (tokenFile) updates.TOKEN_FILE = tokenFile;

        const readerUrl = params.get('READER_URL')?.trim();
        if (readerUrl) updates.READER_URL = readerUrl;

        const isStorageMode = params.get('STORAGE_MODE') === 'true';
        updates.STORAGE_MODE = isStorageMode ? 'true' : 'false';

        const sharedBooksDir = params.get('SHARED_BOOKS_DIR')?.trim() || '';
        updates.SHARED_BOOKS_DIR = sharedBooksDir;

        const storageApiKey = params.get('STORAGE_API_KEY')?.trim() || '';
        updates.STORAGE_API_KEY = storageApiKey;

        const isEnforceApiKey = params.get('ENFORCE_STORAGE_API_KEY') === 'true';
        updates.ENFORCE_STORAGE_API_KEY = isEnforceApiKey ? 'true' : 'false';

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
        }

        writeEnvFile(updates);

        if (isStorageMode) {
          ensureStorageDirectories();
        }

        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '시스템 설정 저장', target: '.env 전체 갱신', status: 200, user: 'Root Admin' });

        const html = renderAdminSettingsHtml(req, '설정이 성공적으로 저장되었습니다!');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        const html = renderAdminSettingsHtml(req, null, '설정 저장 오류: ' + err.message);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      }
    });
    return true;
  }

  return false;
}