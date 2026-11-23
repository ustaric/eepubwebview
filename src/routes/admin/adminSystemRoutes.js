/**
 * @file src/routes/admin/adminSystemRoutes.js
 * @description 관리자 콘솔 파일 탐색기, 폴더 권한 검증, 감사 로그, 크래시 리포트 및 .env 환경설정 저장 라우터
 * - 📁 [디렉터리 브라우징 & 권한 실측] GET /admin/fs-tree, POST /admin/test-folder
 * - 📥 [감사 로그 & 크래시 리포트] ?preview=1 미리보기, 다운로드, 삭제/비우기 지원
 * - 🛡️ [환경변수 무손실 저장] POST /admin/save 시 Discord 설정 및 STORAGE_API_KEY 보존, 마스킹 문자열 덮어쓰기 차단
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readEnvFile, writeEnvFile, ensureStorageDirectories, isMaskedSecretValue } from '../../envManager.js';
import { storageService } from '../../storageService.js';
import { auditLogger } from '../../auditLogger.js';
import { validateSafePath } from '../../securityGuard.js';
import { renderAdminSettingsHtml } from '../../adminViews.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../../..');
const LOGS_DIR = path.resolve(ROOT_DIR, 'data/logs');

/**
 * 관리자 콘솔의 파일 탐색, 감사 로그, 크래시 리포트 및 시스템 설정 저장 요청을 처리합니다.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @param {string} clientIp
 * @param {string} userAgent
 * @param {{ isAdminAuthenticated?: boolean }} [options={}]
 * @returns {Promise<boolean>} 라우트 처리 여부
 */
export async function handleAdminSystemRoute(req, res, pathname, clientIp, userAgent, { isAdminAuthenticated = false } = {}) {
  // 5. 간이 탐색기 디렉터리 트리 조회 API (GET /admin/fs-tree)
  if (req.method === 'GET' && pathname === '/admin/fs-tree') {
    if (!isAdminAuthenticated) {
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
    if (!isAdminAuthenticated) {
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

  // 7. 일자별 보안 감사 로그 바로 보기(?preview=1) 및 다운로드 (GET /admin/logs/download)
  if (req.method === 'GET' && pathname === '/admin/logs/download') {
    const reqUrl = new URL(req.url, 'http://localhost');
    const isPreview = reqUrl.searchParams.get('preview') === '1';

    if (!isAdminAuthenticated) {
      if (isPreview) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
      } else {
        res.writeHead(302, { Location: '/admin' });
        res.end();
      }
      return true;
    }

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

    if (isPreview) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(formattedJson);
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
    if (!isAdminAuthenticated) {
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

  // 9. 크래시 리포트 바로 보기(?preview=1) 및 다운로드
  if (req.method === 'GET' && pathname.startsWith('/admin/crash-reports/download/')) {
    const reqUrl = new URL(req.url, 'http://localhost');
    const isPreview = reqUrl.searchParams.get('preview') === '1';

    if (!isAdminAuthenticated) {
      if (isPreview) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
      } else {
        res.writeHead(302, { Location: '/admin' });
        res.end();
      }
      return true;
    }

    const fileName = decodeURIComponent(pathname.replace('/admin/crash-reports/download/', ''));
    const info = storageService.getCrashReportPath(fileName);
    if (!info) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '리포트 파일 없음' }));
      return true;
    }

    if (isPreview) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': info.size
      });
      const readStream = fs.createReadStream(info.filePath);
      readStream.pipe(res);
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
    if (!isAdminAuthenticated) {
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
    if (!isAdminAuthenticated) {
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
    if (!isAdminAuthenticated) {
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

        // 🌟 [무손실 보존] 기존 env에 저장되어 있던 Discord 관제 3대 설정 및 STORAGE_API_KEY 보존
        const currentEnv = readEnvFile();
        if (currentEnv.DISCORD_WEBHOOK_URL) {
          updates.DISCORD_WEBHOOK_URL = currentEnv.DISCORD_WEBHOOK_URL;
        }
        if (currentEnv.DISCORD_ALERT_TYPES !== undefined) {
          updates.DISCORD_ALERT_TYPES = currentEnv.DISCORD_ALERT_TYPES;
        }
        if (currentEnv.DISCORD_DAILY_DIGEST !== undefined) {
          updates.DISCORD_DAILY_DIGEST = currentEnv.DISCORD_DAILY_DIGEST;
        }
        if (currentEnv.STORAGE_API_KEY) {
          updates.STORAGE_API_KEY = currentEnv.STORAGE_API_KEY;
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

        const isEnableRootApiKey = params.get('ENABLE_ROOT_API_KEY') === 'true';
        updates.ENABLE_ROOT_API_KEY = isEnableRootApiKey ? 'true' : 'false';

        const isEnforceApiKey = params.get('ENFORCE_STORAGE_API_KEY') === 'true';
        updates.ENFORCE_STORAGE_API_KEY = isEnforceApiKey ? 'true' : 'false';

        const clientId = params.get('GOOGLE_CLIENT_ID')?.trim();
        if (clientId) updates.GOOGLE_CLIENT_ID = clientId;

        const clientSecret = params.get('GOOGLE_CLIENT_SECRET')?.trim();
        if (clientSecret) {
          if (isMaskedSecretValue(clientSecret)) {
            console.warn('🛡️ [AdminSave] 마스킹 문자열로 GOOGLE_CLIENT_SECRET 덮어쓰기 차단');
          } else {
            updates.GOOGLE_CLIENT_SECRET = clientSecret;
          }
        }

        const redirectUri = params.get('GOOGLE_REDIRECT_URI')?.trim();
        if (redirectUri) updates.GOOGLE_REDIRECT_URI = redirectUri;

        const encKey = params.get('TOKEN_ENCRYPTION_KEY')?.trim();
        if (encKey) {
          if (isMaskedSecretValue(encKey)) {
            console.warn('🛡️ [AdminSave] 마스킹 문자열로 TOKEN_ENCRYPTION_KEY 덮어쓰기 차단');
          } else {
            updates.TOKEN_ENCRYPTION_KEY = encKey;
          }
        }

        const origin = params.get('ALLOWED_ORIGIN')?.trim();
        if (origin) updates.ALLOWED_ORIGIN = origin;

        const newAdminPassword = params.get('NEW_ADMIN_PASSWORD')?.trim();
        if (newAdminPassword) {
          if (isMaskedSecretValue(newAdminPassword)) {
            console.warn('🛡️ [AdminSave] 마스킹 문자열로 ADMIN_PASSWORD 덮어쓰기 차단');
          } else {
            updates.ADMIN_PASSWORD = newAdminPassword;
          }
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