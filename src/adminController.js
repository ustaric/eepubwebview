/**
 * @file src/adminController.js
 * @description 관리자 웹 제어 센터 라우터, 쿠키 인증, 브루트포스 락, 공유 폴더 탐색 API 및 설정 저장 전담 컨트롤러 (Controller)
 * - 🎨 [MVC 패턴 완성] 거대 HTML 뷰 템플릿을 src/adminViews.js로 완전 분리하여 초경량 순수 컨트롤러로 슬림화
 * - 🚦 [관리자 통합 라우트 디스패처] handleAdminRoute 제공으로 server.js와 직통 위임 유지
 * - 📁 [간이 파일 탐색기 API 탑재] GET /admin/fs-tree 제공으로 서버 최상위 루트부터 자유로운 디렉터리 브라우징 지원
 * - 🛡️ [실시간 폴더 권한 실측 API] POST /admin/test-folder 제공으로 Node/PM2 프로세스의 읽기 권한 유무 즉각 검증
 * - 🔒 [로그인 5회 브루트포스 락] IP별 실패 횟수 추적 및 1분 내 5회 오류 시 15분 차단 가드 모듈 내 캡슐화
 * - 🛠️ [공유 도서 폴더(SHARED_BOOKS_DIR) 포함 전 환경변수 영구 반영] .env 파일 원자적 동기화
 */

import fs from 'fs';
import crypto from 'crypto';
import { readEnvFile, writeEnvFile, ensureStorageDirectories } from './envManager.js';
import { storageService } from './storageService.js';
import { auditLogger } from './auditLogger.js';

// 🌟 분리된 순수 View 렌더러 import
import { renderLoginPageHtml, renderAdminSettingsHtml } from './adminViews.js';

// 하위 호환성 및 테스트를 위한 Re-export 계약 보존
export { renderLoginPageHtml, renderAdminSettingsHtml };

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
 * 로그인 성공 시 실패 기록 소독
 * @param {string} ip 
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
 * 🔑 관리자 세션 토큰 발급 및 등록
 * @returns {string} 세션 토큰
 */
export function createAdminSession() {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessionTokens.add(token);
  return token;
}

/**
 * 🚪 관리자 세션 파기 (로그아웃)
 * @param {string} token 
 */
export function destroyAdminSession(token) {
  if (token) {
    adminSessionTokens.delete(token);
  }
}

/**
 * 🌟 [관리자 라우트 전담 통합 디스패처]
 * server.js로부터 /admin/* 및 /settings 요청을 위임받아 100% 처리
 * 
 * @param {import('http').IncomingMessage} req 
 * @param {import('http').ServerResponse} res 
 * @param {string} pathname 
 * @param {string} clientIp 
 * @param {string} userAgent 
 * @returns {Promise<boolean>} 처리 완료 여부
 */
export async function handleAdminRoute(req, res, pathname, clientIp, userAgent) {
  // 1. 관리자 로그인 처리 (POST /admin/login)
  if (req.method === 'POST' && pathname === '/admin/login') {
    const loginGuard = checkLoginRateLimit(clientIp);
    if (!loginGuard.allowed) {
      console.warn(`⛔ [Login Lock] 무차별 대입 방어로 IP ${clientIp} 차단 중 (${loginGuard.waitMinutes}분 남음)`);
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '관리자 로그인 시도', target: '차단 잠금', status: 429 });
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
    return true;
  }

  // 2. 관리자 로그아웃 처리 (GET /admin/logout)
  if (req.method === 'GET' && pathname === '/admin/logout') {
    const cookies = parseCookies(req);
    destroyAdminSession(cookies['admin_session']);
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '관리자 로그아웃', target: '세션 파기', status: 200 });
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
  // 🔍 4. [신규] 관리자 간이 탐색기용 디렉터리 트리 조회 API (GET /admin/fs-tree)
  // =========================================================================
  if (req.method === 'GET' && pathname === '/admin/fs-tree') {
    if (!isAuthenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'UNAUTHORIZED: 관리자 로그인이 필요합니다.' }));
      return true;
    }

    const reqUrl = new URL(req.url, 'http://localhost');
    const targetPath = reqUrl.searchParams.get('path') || '/';

    const treeData = storageService.getDirectoryTree(targetPath);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(treeData));
    return true;
  }

  // =========================================================================
  // 🛡️ 5. [신규] 폴더 권한 실측 검증 API (POST /admin/test-folder)
  // =========================================================================
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

  // 6. 크래시 리포트 다운로드 (GET /admin/crash-reports/download/:fileName)
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
      res.end(JSON.stringify({ error: '크래시 리포트 파일을 찾을 수 없습니다.' }));
      return true;
    }

    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '크래시 리포트 다운로드', target: fileName, status: 200 });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': info.size,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`
    });
    const readStream = fs.createReadStream(info.filePath);
    readStream.pipe(res);
    return true;
  }

  // 7. 크래시 리포트 단일 삭제 (GET /admin/crash-reports/delete/:fileName)
  if (req.method === 'GET' && pathname.startsWith('/admin/crash-reports/delete/')) {
    if (!isAuthenticated(req)) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return true;
    }

    const fileName = decodeURIComponent(pathname.replace('/admin/crash-reports/delete/', ''));
    storageService.deleteCrashReport(fileName);
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '크래시 리포트 삭제', target: fileName, status: 200 });
    res.writeHead(302, { Location: '/admin' });
    res.end();
    return true;
  }

  // 8. 크래시 리포트 전체 비우기 (GET /admin/crash-reports/clear)
  if (req.method === 'GET' && pathname === '/admin/crash-reports/clear') {
    if (!isAuthenticated(req)) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return true;
    }

    storageService.clearAllCrashReports();
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '크래시 리포트 전체 삭제', target: 'all', status: 200 });
    res.writeHead(302, { Location: '/admin' });
    res.end();
    return true;
  }

  // 9. 환경변수 전체 파싱 및 영구 저장 (POST /admin/save)
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

        // 🌟 [신규] 관리자 지정 공유 도서 폴더 경로 파싱 및 권한 실측 검증
        const sharedBooksDir = params.get('SHARED_BOOKS_DIR')?.trim() || '';
        updates.SHARED_BOOKS_DIR = sharedBooksDir;

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

        let successMsg = isStorageMode
          ? '설정이 저장되었습니다! 도서 로컬 저장소(./data/books)가 활성화되었습니다.'
          : '설정이 성공적으로 저장되었습니다. (인증 프록시 모드)';

        if (sharedBooksDir) {
          successMsg += ` [공유 서재: ${sharedBooksDir}]`;
        }

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
    return true;
  }

  return false;
}