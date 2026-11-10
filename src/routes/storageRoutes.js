/**
 * @file src/routes/storageRoutes.js
 * @description 자체 스토리지 모드(/api/storage/*) REST API 및 보안 가드 전담 라우터
 * - 🔑 [지능형 듀얼 API 키 & 기기 검증] Root 관리자 키 + 다중 사용자 키 실시간 인증 및 차단/슬롯 초과(403) 차단
 * - 🚫 [미등록/삭제 기기 403 즉시 차단] 장부에서 삭제된 기기의 임의 재접속 원천 거부 및 6자리 번호 재로그인 요구
 * - 📱 [등록 기기 관리 REST API 탑재] GET /api/storage/devices 및 DELETE /api/storage/devices/:id 슬롯 반환
 * - 🚦 [용량 초과 사전 차단] Content-Length 검사로 사용자 할당량 초과 시 413 즉시 거부
 * - ⚡ [공유 라이브러리 I/O] 목록 조회, 다운로드 스트리밍 및 서버 내부 0초 복사(/import) 지원
 * - 📖 [도서 메타 & EPUB 바이너리] 스트리밍 송수신, 무손실 파쇄 및 IndexedDB 캐싱 완비
 * - 🖼️ [표지 이미지 I/O] HEAD 선조회 및 WebP 캐시 제어
 */

import fs from 'fs';
import { storageService } from '../storageService.js';
import { auditLogger } from '../auditLogger.js';
import { apiKeyManager } from '../apiKeyManager.js';
import { readEnvFile } from '../envManager.js';
import {
  extractApiKey,
  extractDeviceInfo,
  isAllowedClientOrigin,
  checkRateLimit,
  setCorsHeaders,
  sendJsonResponse,
  readRequestBodyBuffer
} from '../httpUtils.js';

/**
 * 스토리지(/api/storage/*) 관련 HTTP 요청을 처리합니다.
 * @param {import('http').IncomingMessage} req 
 * @param {import('http').ServerResponse} res 
 * @param {string} pathname 
 * @param {URL} reqUrl 
 * @param {string} clientIp 
 * @param {string} userAgent 
 * @returns {Promise<boolean>} 라우트 처리 여부
 */
export async function handleStorageRoute(req, res, pathname, reqUrl, clientIp, userAgent) {
  if (!pathname.startsWith('/api/storage/')) {
    return false;
  }

  // 1. 크래시 리포트 수신 (별도 인증 없이 수용)
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
      sendJsonResponse(req, res, 200, { ok: true, fileName, status: 'saved' });
      return true;
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '크래시 리포트 저장 실패', target: fileName, status: 500 });
      sendJsonResponse(req, res, 500, { error: err.message });
      return true;
    }
  }

  // 2. 스토리지 API 요청 횟수 제한 (1분 120회)
  if (!checkRateLimit(req, 120)) {
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '요청 횟수 초과 차단', target: pathname, status: 429 });
    sendJsonResponse(req, res, 429, { error: 'RATE_LIMIT_EXCEEDED: 요청 횟수가 초과되었습니다. 잠시 후 다시 시도해 주세요.' });
    return true;
  }

  // 3. STORAGE_MODE 활성화 여부 검증
  const env = readEnvFile();
  if (env.STORAGE_MODE !== 'true') {
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '스토리지 모드 비활성 거절', target: pathname, status: 403 });
    sendJsonResponse(req, res, 403, { error: 'STORAGE_MODE_DISABLED: 개인 서버 저장소 모드가 비활성화되어 있습니다.' });
    return true;
  }

  // 4. API 키 인증 및 사용자/기기 화이트리스트 가드
  let targetUserFolder = null;
  let userQuotaBytes = 1073741824;
  let authenticatedUserMemo = 'Root Admin';

  const rootMasterKey = env.STORAGE_API_KEY?.trim();
  const isEnforceApiKey = env.ENFORCE_STORAGE_API_KEY === 'true';
  const providedApiKey = extractApiKey(req, reqUrl);
  const { deviceId, deviceName } = extractDeviceInfo(req, reqUrl);

  if (rootMasterKey && providedApiKey && providedApiKey === rootMasterKey) {
    targetUserFolder = null;
    authenticatedUserMemo = 'Root Admin';
    auditLogger.recordApiKeyUsage({ ip: clientIp, userAgent, path: pathname, method: req.method, userMemo: 'Root Admin' });
  } else if (providedApiKey) {
    const auth = apiKeyManager.authenticateApiKey(providedApiKey);
    if (auth.authenticated && auth.user) {
      targetUserFolder = auth.user.folderName;
      userQuotaBytes = auth.user.storageQuotaBytes || (1024 * 1024 * 1024);
      authenticatedUserMemo = `${auth.user.memo} (${auth.user.folderName})`;

      if (deviceId) {
        const deviceResult = apiKeyManager.verifyAndTouchDevice(auth.user.folderName, { deviceId, deviceName, clientIp });

        // 🚨 [방어선 A] 관리자가 직접 밴(차단)한 기기
        if (!deviceResult.allowed && deviceResult.reason === 'DEVICE_BLOCKED') {
          auditLogger.recordAccessLog({
            ip: clientIp,
            userAgent,
            action: '🚫 차단된 기기 접근 차단',
            target: `${deviceName || deviceId} (${auth.user.memo})`,
            status: 403,
            user: authenticatedUserMemo
          });
          sendJsonResponse(req, res, 403, { error: 'DEVICE_BLOCKED: 관리자에 의해 차단된 기기입니다.', deviceId });
          return true;
        }

        // 🚨 [방어선 B] 기기 슬롯(6대) 한도 초과
        if (!deviceResult.allowed && deviceResult.reason === 'DEVICE_LIMIT_EXCEEDED') {
          auditLogger.recordAccessLog({
            ip: clientIp,
            userAgent,
            action: '🚫 기기 등록 한도 초과',
            target: `${deviceName || deviceId} (${deviceResult.maxDevices || 6}대 한도 초과)`,
            status: 403,
            user: authenticatedUserMemo
          });
          sendJsonResponse(req, res, 403, {
            error: `DEVICE_LIMIT_EXCEEDED: 허용된 최대 등록 기기 수(${deviceResult.maxDevices || 6}대)를 초과했습니다.`,
            maxDevices: deviceResult.maxDevices || 6
          });
          return true;
        }

        // 🚨 [방어선 C - 신규] 삭제되었거나 정식 OTP 등록을 거치지 않은 미등록 기기 원천 차단!
        if (!deviceResult.allowed && deviceResult.reason === 'DEVICE_UNREGISTERED') {
          auditLogger.recordAccessLog({
            ip: clientIp,
            userAgent,
            action: '🚫 미등록/삭제된 기기 차단',
            target: `${deviceName || deviceId} (${auth.user.memo})`,
            status: 403,
            user: authenticatedUserMemo
          });
          sendJsonResponse(req, res, 403, {
            error: 'DEVICE_UNREGISTERED: 등록되지 않았거나 삭제된 기기입니다. 6자리 번호로 다시 로그인해 주세요.',
            deviceId
          });
          return true;
        }
      }

      auditLogger.recordApiKeyUsage({ ip: clientIp, userAgent, path: pathname, method: req.method, userMemo: auth.user.memo });
    } else if (auth.reason === 'API_KEY_EXPIRED') {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '만료된 API 키 차단', target: pathname, status: 401 });
      sendJsonResponse(req, res, 401, { error: 'API_KEY_EXPIRED: 사용 기간이 종료된 키입니다.' });
      return true;
    } else if (auth.reason === 'API_KEY_REVOKED') {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '폐기된 API 키 차단', target: pathname, status: 401 });
      sendJsonResponse(req, res, 401, { error: 'API_KEY_REVOKED: 폐기된 API 키입니다.' });
      return true;
    } else if (isEnforceApiKey) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'API 키 인증 실패 차단', target: pathname, status: 401 });
      sendJsonResponse(req, res, 401, { error: 'UNAUTHORIZED_API_KEY: 유효한 API 키가 필요합니다.' });
      return true;
    } else if (!isAllowedClientOrigin(req)) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '비인가 출처 차단', target: pathname, status: 403 });
      sendJsonResponse(req, res, 403, { error: 'FORBIDDEN_ORIGIN: 승인되지 않은 도메인 접근입니다.' });
      return true;
    }
  } else if (isEnforceApiKey) {
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'API 키 누락 차단', target: pathname, status: 401 });
    sendJsonResponse(req, res, 401, { error: 'UNAUTHORIZED_API_KEY: X-API-KEY 헤더가 누락되었습니다.' });
    return true;
  } else if (!isAllowedClientOrigin(req)) {
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '비인가 출처 차단', target: pathname, status: 403 });
    sendJsonResponse(req, res, 403, { error: 'FORBIDDEN_ORIGIN: 승인되지 않은 도메인 접근입니다.' });
    return true;
  }

  // 5. 등록된 기기 목록 조회 (GET /api/storage/devices)
  if (req.method === 'GET' && pathname === '/api/storage/devices') {
    const devices = targetUserFolder ? apiKeyManager.getUserDevices(targetUserFolder) : [];
    sendJsonResponse(req, res, 200, {
      ok: true,
      maxDevices: 6,
      totalDevices: devices.length,
      devices
    });
    return true;
  }

  // 6. 안 쓰는 기기 슬롯 삭제 및 반환 (DELETE /api/storage/devices/:deviceId)
  if (req.method === 'DELETE' && pathname.startsWith('/api/storage/devices/')) {
    const targetDeviceId = decodeURIComponent(pathname.replace('/api/storage/devices/', ''));
    if (!targetUserFolder) {
      sendJsonResponse(req, res, 400, { error: '루트 관리자 계정은 기기 관리가 지원되지 않습니다.' });
      return true;
    }

    const deleteResult = apiKeyManager.deleteDevice(targetUserFolder, targetDeviceId);
    if (!deleteResult.success) {
      sendJsonResponse(req, res, 400, { error: deleteResult.error || '기기 삭제에 실패했습니다.' });
      return true;
    }

    auditLogger.recordAccessLog({
      ip: clientIp,
      userAgent,
      action: '📱 기기 슬롯 반환(삭제)',
      target: targetDeviceId,
      status: 200,
      user: authenticatedUserMemo
    });

    sendJsonResponse(req, res, 200, { ok: true, message: '기기가 성공적으로 삭제되었습니다.', deviceId: targetDeviceId });
    return true;
  }

  // 7. 공유 도서 내부 복사 (/api/storage/remote-library/import)
  if (req.method === 'POST' && pathname === '/api/storage/remote-library/import') {
    const sharedDir = env.SHARED_BOOKS_DIR;
    if (!sharedDir || !fs.existsSync(sharedDir)) {
      sendJsonResponse(req, res, 404, { ok: false, error: 'SHARED_BOOKS_DIR_NOT_FOUND', message: '공유 도서 폴더가 존재하지 않습니다.' });
      return true;
    }

    try {
      const buffer = await readRequestBodyBuffer(req, 5 * 1024 * 1024);
      const payload = JSON.parse(buffer.toString('utf-8') || '{}');
      const relativePath = payload.relativePath;
      if (!relativePath) {
        sendJsonResponse(req, res, 400, { error: 'relativePath 필드가 누락되었습니다.' });
        return true;
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
      sendJsonResponse(req, res, 200, importResult);
      return true;
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '공유 도서 복사 실패', target: err.message, status: 500, user: authenticatedUserMemo });
      sendJsonResponse(req, res, 500, { error: err.message });
      return true;
    }
  }

  // 8. 공유 도서 목록 조회 (/api/storage/remote-library)
  if (req.method === 'GET' && pathname === '/api/storage/remote-library') {
    const sharedDir = env.SHARED_BOOKS_DIR;
    if (!sharedDir || !fs.existsSync(sharedDir)) {
      sendJsonResponse(req, res, 404, { ok: false, error: 'SHARED_BOOKS_DIR_NOT_FOUND', message: '공유 도서 폴더가 존재하지 않습니다.' });
      return true;
    }

    const permCheck = storageService.testDirectoryPermissions(sharedDir);
    if (!permCheck.readable) {
      sendJsonResponse(req, res, 403, { ok: false, error: 'PERMISSION_DENIED', message: `공유 폴더 읽기 권한이 없습니다: ${permCheck.error || ''}` });
      return true;
    }

    const books = storageService.getRemoteBooks(sharedDir);
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '📚 공유 서재 목록 조회', target: `${books.length}권`, status: 200, user: authenticatedUserMemo });
    sendJsonResponse(req, res, 200, { ok: true, sharedDir, totalBooks: books.length, books });
    return true;
  }

  // 9. 공유 도서 파일 스트리밍 다운로드 (/api/storage/remote-library/download)
  if (req.method === 'GET' && pathname === '/api/storage/remote-library/download') {
    const sharedDir = env.SHARED_BOOKS_DIR;
    const reqFile = reqUrl.searchParams.get('file');
    if (!sharedDir || !reqFile) {
      sendJsonResponse(req, res, 400, { error: 'file 쿼리 파라미터가 누락되었습니다.' });
      return true;
    }

    const fileInfo = storageService.getRemoteBookFilePath(sharedDir, reqFile);
    if (!fileInfo) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '공유 도서 다운로드 실패', target: reqFile, status: 404, user: authenticatedUserMemo });
      sendJsonResponse(req, res, 404, { error: '도서 파일을 찾을 수 없습니다.' });
      return true;
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
    fs.createReadStream(fileInfo.filePath).pipe(res);
    return true;
  }

  // 10. 서재 스냅샷 조회 (/api/storage/snapshot)
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
      sendJsonResponse(req, res, 200, snapshot);
      return true;
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '서재 스냅샷 실패', target: err.message, status: 500, user: authenticatedUserMemo });
      sendJsonResponse(req, res, 500, { error: err.message });
      return true;
    }
  }

  // 11. 도서 메타데이터 저장 및 조회 (/api/storage/books/:id)
  if (pathname.startsWith('/api/storage/books/') && !pathname.endsWith('/epub')) {
    const bookId = decodeURIComponent(pathname.replace('/api/storage/books/', ''));

    if (req.method === 'POST') {
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
        sendJsonResponse(req, res, 200, { ok: true, bookId });
        return true;
      } catch (err) {
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '도서 메타 저장 실패', target: bookId, status: 500, user: authenticatedUserMemo });
        sendJsonResponse(req, res, 500, { error: err.message });
        return true;
      }
    }

    if (req.method === 'GET') {
      const meta = storageService.getBookMetadata(bookId, targetUserFolder);
      if (!meta) {
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '도서 메타 조회 실패', target: bookId, status: 404, user: authenticatedUserMemo });
        sendJsonResponse(req, res, 404, { error: '도서를 찾을 수 없습니다.' });
        return true;
      }
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '도서 메타 조회', target: `${meta.title || bookId} (${targetUserFolder || 'root'})`, status: 200, user: authenticatedUserMemo });
      sendJsonResponse(req, res, 200, meta);
      return true;
    }

    if (req.method === 'DELETE') {
      const count = storageService.deleteBookAll(bookId, targetUserFolder);
      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '🗑️ 도서 완전 삭제',
        target: `${bookId} (${count}개 파일 파쇄 / ${targetUserFolder || 'root'})`,
        status: 200,
        user: authenticatedUserMemo
      });
      sendJsonResponse(req, res, 200, { ok: true, deletedFiles: count });
      return true;
    }
  }

  // 12. EPUB 도서 바이너리 업로드 및 다운로드 (/api/storage/books/:id/epub)
  if (pathname.startsWith('/api/storage/books/') && pathname.endsWith('/epub')) {
    const rawSegment = pathname.replace('/api/storage/books/', '').replace(/\/epub$/, '');
    const bookId = decodeURIComponent(rawSegment);

    if (req.method === 'POST') {
      const contentLength = Number(req.headers['content-length'] || 0);
      if (targetUserFolder && contentLength > 0) {
        const quotaCheck = storageService.checkUserStorageQuota(targetUserFolder, contentLength, userQuotaBytes);
        if (!quotaCheck.allowed) {
          auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '용량 초과 업로드 차단', target: `${bookId} (${targetUserFolder})`, status: 413, user: authenticatedUserMemo });
          sendJsonResponse(req, res, 413, { error: 'STORAGE_QUOTA_EXCEEDED: 저장 용량을 초과했습니다.' });
          return true;
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
        sendJsonResponse(req, res, 200, { ok: true, bookId, size: buffer.length });
        return true;
      } catch (err) {
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'EPUB 업로드 실패', target: bookId, status: 500, user: authenticatedUserMemo });
        sendJsonResponse(req, res, 500, { error: err.message });
        return true;
      }
    }

    if (req.method === 'GET') {
      const info = storageService.getBookEpubPath(bookId, targetUserFolder);
      if (!info) {
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'EPUB 다운로드 실패', target: bookId, status: 404, user: authenticatedUserMemo });
        sendJsonResponse(req, res, 404, { error: 'EPUB 파일을 찾을 수 없습니다.' });
        return true;
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
      fs.createReadStream(info.filePath).pipe(res);
      return true;
    }
  }

  // 13. 표지 이미지 관리 (/api/storage/covers/:fileName)
  if (pathname.startsWith('/api/storage/covers/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/covers/', ''));

    if (req.method === 'POST') {
      try {
        const buffer = await readRequestBodyBuffer(req, 10 * 1024 * 1024);
        storageService.saveCoverImage(fileName, buffer, targetUserFolder);
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '🖼️ 표지 업로드', target: `${fileName} (${targetUserFolder || 'root'})`, status: 200, user: authenticatedUserMemo });
        sendJsonResponse(req, res, 200, { ok: true, fileName });
        return true;
      } catch (err) {
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '표지 업로드 실패', target: fileName, status: 500, user: authenticatedUserMemo });
        sendJsonResponse(req, res, 500, { error: err.message });
        return true;
      }
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const info = storageService.getCoverImagePath(fileName, targetUserFolder);
      if (!info) {
        sendJsonResponse(req, res, 404, { error: '표지를 찾을 수 없습니다.' });
        return true;
      }

      setCorsHeaders(req, res);
      res.writeHead(200, {
        'Content-Type': 'image/webp',
        'Content-Length': info.size,
        'Cache-Control': 'public, max-age=86400'
      });

      if (req.method === 'HEAD') {
        res.end();
        return true;
      }

      fs.createReadStream(info.filePath).pipe(res);
      return true;
    }

    if (req.method === 'DELETE') {
      storageService.deleteCoverImage(fileName, targetUserFolder);
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '🖼️ 표지 단일 삭제', target: `${fileName} (${targetUserFolder || 'root'})`, status: 200, user: authenticatedUserMemo });
      sendJsonResponse(req, res, 200, { ok: true, fileName });
      return true;
    }
  }

  // 14. 시스템 및 동기화 설정 파일 관리 (/api/storage/settings/:fileName)
  if (pathname.startsWith('/api/storage/settings/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/settings/', ''));

    if (req.method === 'POST') {
      try {
        const buffer = await readRequestBodyBuffer(req, 5 * 1024 * 1024);
        const data = JSON.parse(buffer.toString('utf-8'));
        storageService.saveSettingsFile(fileName, data, targetUserFolder);
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '⚙️ 시스템 데이터 동기화', target: `${fileName} (${targetUserFolder || 'root'})`, status: 200, user: authenticatedUserMemo });
        sendJsonResponse(req, res, 200, { ok: true, fileName });
        return true;
      } catch (err) {
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '시스템 동기화 실패', target: fileName, status: 500, user: authenticatedUserMemo });
        sendJsonResponse(req, res, 500, { error: err.message });
        return true;
      }
    }

    if (req.method === 'GET') {
      const data = storageService.getSettingsFile(fileName, targetUserFolder);
      if (!data) {
        sendJsonResponse(req, res, 404, { error: '설정 파일을 찾을 수 없습니다.' });
        return true;
      }
      sendJsonResponse(req, res, 200, data);
      return true;
    }
  }

  return false;
}