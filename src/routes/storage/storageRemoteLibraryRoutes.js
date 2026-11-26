/**
 * @file src/routes/storage/storageRemoteLibraryRoutes.js
 * @description 자체 스토리지 공유 폴더 설정 및 공유 도서함(/api/storage/remote-library*, /admin/shared-folders) 라우터
 * - 🎛️ [관리자 공유 폴더 설정] GET/POST /api/storage/admin/shared-folders 스키마 검증 및 저장
 * - ⚡ [서버 내부 0초 복사] POST /api/storage/remote-library/import 폴더·기기 권한 및 용량(413) 직렬화 검증 후 직통 복사
 * - 📚 [공유 도서 목록 조회] GET /api/storage/remote-library 기기별 허용 폴더 필터링 및 목록 수집
 * - 📖 [스트리밍 다운로드] GET /api/storage/remote-library/download 경로 탈출 방어 및 스트리밍 전송
 */

import fs from 'fs';
import path from 'path';
import { storageService } from '../../storageService.js';
import { auditLogger } from '../../auditLogger.js';
import {
  getSharedFoldersConfig,
  saveSharedFoldersConfig
} from '../../services/storage/remoteLibraryEngine.js';
import { withUserStorageLock } from '../../services/storage/storageContext.js';
import {
  setCorsHeaders,
  sendJsonResponse,
  readRequestBodyBuffer
} from '../../httpUtils.js';

/**
 * 안전한 Content-Length 산출 헬퍼
 * @param {number} size
 * @returns {number}
 */
function infoSizeFallback(size) {
  return Number.isFinite(size) && size >= 0 ? size : 0;
}

/**
 * 관리자 공유 폴더 설정 및 공유 도서 라이브러리 관련 HTTP 요청을 처리합니다.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @param {URL} reqUrl
 * @param {string} clientIp
 * @param {string} userAgent
 * @param {Object} context - storageAuthGuard에서 검증된 인증 컨텍스트
 * @returns {Promise<boolean>} 라우트 처리 여부
 */
export async function handleStorageRemoteLibraryRoute(req, res, pathname, reqUrl, clientIp, userAgent, context) {
  const {
    env,
    targetUserFolder,
    userQuotaBytes,
    authenticatedUserMemo,
    isRootAdmin,
    deviceId
  } = context;

  // 7. 🎛️ 관리자용 다중 공유 폴더 및 기기별 권한 제어 REST API
  if (pathname === '/api/storage/admin/shared-folders') {
    if (!isRootAdmin) {
      sendJsonResponse(req, res, 403, { error: 'ROOT_ADMIN_REQUIRED: 공유 폴더 설정은 루트 관리자만 가능합니다.' });
      return true;
    }

    if (req.method === 'GET') {
      const config = getSharedFoldersConfig(env);
      sendJsonResponse(req, res, 200, { ok: true, config });
      return true;
    }

    if (req.method === 'POST') {
      try {
        const buffer = await readRequestBodyBuffer(req, 5 * 1024 * 1024);
        const newConfig = JSON.parse(buffer.toString('utf-8') || '{}');

        if (!newConfig || typeof newConfig !== 'object' || Array.isArray(newConfig) || !Array.isArray(newConfig.folders)) {
          sendJsonResponse(req, res, 400, { error: 'INVALID_CONFIG: enabled(boolean) 및 folders(array) 형식이 필요합니다.' });
          return true;
        }

        const sanitizedFolders = [];
        for (let idx = 0; idx < newConfig.folders.length; idx++) {
          const f = newConfig.folders[idx];
          if (!f || typeof f !== 'object' || typeof f.path !== 'string' || !f.path.trim()) {
            sendJsonResponse(req, res, 400, { error: `INVALID_FOLDER_ITEM: 유효하지 않은 공유 폴더 항목입니다 (index=${idx}).` });
            return true;
          }
          sanitizedFolders.push({
            id: String(f.id || `folder_${Date.now()}_${idx}`).trim(),
            name: String(f.name || path.basename(f.path.trim()) || '공유 서재').trim(),
            path: f.path.trim(),
            enabled: f.enabled !== false,
            allowedDevices: Array.isArray(f.allowedDevices)
              ? f.allowedDevices.map((d) => String(d).trim()).filter(Boolean)
              : ['*']
          });
        }

        const sanitizedConfig = {
          enabled: Boolean(newConfig.enabled),
          folders: sanitizedFolders
        };

        saveSharedFoldersConfig(sanitizedConfig);

        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '⚙️ 공유 폴더 설정 갱신',
          target: `폴더 ${sanitizedConfig.folders.length}개 (기능활성: ${sanitizedConfig.enabled})`,
          status: 200,
          user: authenticatedUserMemo
        });

        sendJsonResponse(req, res, 200, { ok: true, message: '공유 폴더 설정이 저장되었습니다.', config: sanitizedConfig });
        return true;
      } catch (err) {
        sendJsonResponse(req, res, 500, { error: err.message });
        return true;
      }
    }
  }

  // 8. ⚡ 공유 도서 내부 복사 (/api/storage/remote-library/import)
  if (req.method === 'POST' && pathname === '/api/storage/remote-library/import') {
    const config = getSharedFoldersConfig(env);
    if (!config.enabled) {
      sendJsonResponse(req, res, 403, { ok: false, error: 'FEATURE_DISABLED', message: '공유 도서 라이브러리 기능이 비활성화되어 있습니다.' });
      return true;
    }

    try {
      const buffer = await readRequestBodyBuffer(req, 5 * 1024 * 1024);
      const payload = JSON.parse(buffer.toString('utf-8') || '{}');
      const rawRelativePath = payload.relativePath;
      const targetFolderId = payload.folderId;

      if (!rawRelativePath) {
        sendJsonResponse(req, res, 400, { error: 'relativePath 필드가 누락되었습니다.' });
        return true;
      }

      const normalizedRelPath = rawRelativePath.replace(/\\/g, '/').replace(/^\/+/, '');
      if (normalizedRelPath.includes('..')) {
        sendJsonResponse(req, res, 400, { error: 'INVALID_PATH: 잘못된 경로 형식입니다 (상위 경로 이동 불가).' });
        return true;
      }

      let matchedFolder = null;
      if (targetFolderId) {
        matchedFolder = config.folders.find(f => f.id === targetFolderId && f.enabled);
      } else {
        matchedFolder = config.folders.find(f => f.enabled && (isRootAdmin || f.allowedDevices.includes('*') || (deviceId && f.allowedDevices.includes(deviceId))));
      }

      if (!matchedFolder || !fs.existsSync(matchedFolder.path)) {
        sendJsonResponse(req, res, 404, { ok: false, error: 'SHARED_FOLDER_NOT_FOUND', message: '접근 가능한 공유 도서 폴더를 찾을 수 없습니다.' });
        return true;
      }

      if (!isRootAdmin && !matchedFolder.allowedDevices.includes('*') && (!deviceId || !matchedFolder.allowedDevices.includes(deviceId))) {
        sendJsonResponse(req, res, 403, { ok: false, error: 'PERMISSION_DENIED', message: '해당 공유 폴더에 접근할 수 있는 권한이 없습니다.' });
        return true;
      }

      const importResult = await withUserStorageLock(targetUserFolder, () =>
        storageService.importRemoteBookToLibrary(
          matchedFolder.path,
          normalizedRelPath,
          targetUserFolder,
          targetUserFolder ? userQuotaBytes : null
        )
      );
      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '⚡ 공유 도서 내부 복사',
        target: `${importResult.fileName} ➔ ${targetUserFolder || 'root'} (폴더: ${matchedFolder.name})`,
        status: 200,
        user: authenticatedUserMemo
      });

      sendJsonResponse(req, res, 200, importResult);
      return true;
    } catch (err) {
      if (err?.code === 'STORAGE_QUOTA_EXCEEDED' || err?.statusCode === 413 || String(err?.message || '').startsWith('STORAGE_QUOTA_EXCEEDED')) {
        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '용량 초과 공유 도서 복사 차단',
          target: `${targetUserFolder || 'root'} (${err.message})`,
          status: 413,
          user: authenticatedUserMemo
        });
        sendJsonResponse(req, res, 413, { error: 'STORAGE_QUOTA_EXCEEDED: 저장 용량을 초과했습니다.' });
        return true;
      }
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '공유 도서 복사 실패', target: err.message, status: 500, user: authenticatedUserMemo });
      sendJsonResponse(req, res, 500, { error: err.message });
      return true;
    }
  }

  // 9. 📚 공유 도서 목록 조회 (/api/storage/remote-library)
  if (req.method === 'GET' && pathname === '/api/storage/remote-library') {
    const config = getSharedFoldersConfig(env);

    if (!config.enabled || config.folders.length === 0) {
      sendJsonResponse(req, res, 200, { ok: true, enabled: false, totalBooks: 0, folders: [], books: [] });
      return true;
    }

    const allowedFolders = config.folders.filter(f => {
      if (!f.enabled) return false;
      if (!fs.existsSync(f.path)) return false;
      if (isRootAdmin) return true;
      if (f.allowedDevices.includes('*')) return true;
      return Boolean(deviceId && f.allowedDevices.includes(deviceId));
    });

    if (allowedFolders.length === 0) {
      sendJsonResponse(req, res, 200, { ok: true, enabled: true, totalBooks: 0, folders: [], books: [] });
      return true;
    }

    let aggregatedBooks = [];
    const foldersMeta = [];

    for (const folder of allowedFolders) {
      try {
        const permCheck = storageService.testDirectoryPermissions(folder.path);
        if (!permCheck.readable) continue;

        const books = storageService.getRemoteBooks(folder.path) || [];
        foldersMeta.push({
          id: folder.id,
          name: folder.name,
          bookCount: books.length
        });

        for (const b of books) {
          aggregatedBooks.push({
            ...b,
            folderId: folder.id,
            folderName: folder.name,
            relativePath: (b.relativePath || '').replace(/\\/g, '/')
          });
        }
      } catch (folderErr) {
        console.warn(`⚠️ [StorageRoutes] 폴더 '${folder.name}' 스캔 예외:`, folderErr.message);
      }
    }

    auditLogger.recordAccessLog({
      ip: clientIp,
      userAgent,
      action: '📚 공유 서재 목록 조회',
      target: `총 ${aggregatedBooks.length}권 (허용 폴더 ${foldersMeta.length}개)`,
      status: 200,
      user: authenticatedUserMemo
    });

    sendJsonResponse(req, res, 200, {
      ok: true,
      enabled: true,
      totalBooks: aggregatedBooks.length,
      folders: foldersMeta,
      books: aggregatedBooks
    });
    return true;
  }

  // 10. 공유 도서 파일 스트리밍 다운로드 (/api/storage/remote-library/download)
  if (req.method === 'GET' && pathname === '/api/storage/remote-library/download') {
    const config = getSharedFoldersConfig(env);
    const reqFile = reqUrl.searchParams.get('file');
    const folderId = reqUrl.searchParams.get('folderId');

    if (!config.enabled || !reqFile) {
      sendJsonResponse(req, res, 400, { error: 'file 쿼리 파라미터가 누락되었거나 기능이 꺼져있습니다.' });
      return true;
    }

    const normalizedReqFile = reqFile.replace(/\\/g, '/').replace(/^\/+/, '');
    if (normalizedReqFile.includes('..')) {
      sendJsonResponse(req, res, 400, { error: 'INVALID_PATH: 잘못된 경로 형식입니다 (상위 경로 이동 불가).' });
      return true;
    }

    let targetFolder = null;
    if (folderId) {
      targetFolder = config.folders.find(f => f.id === folderId && f.enabled);
    } else {
      targetFolder = config.folders.find(f => f.enabled && (isRootAdmin || f.allowedDevices.includes('*') || (deviceId && f.allowedDevices.includes(deviceId))));
    }

    if (!targetFolder || !fs.existsSync(targetFolder.path)) {
      sendJsonResponse(req, res, 404, { error: '공유 폴더를 찾을 수 없습니다.' });
      return true;
    }

    if (!isRootAdmin && !targetFolder.allowedDevices.includes('*') && (!deviceId || !targetFolder.allowedDevices.includes(deviceId))) {
      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '🚫 공유 도서 다운로드 권한 차단',
        target: `${normalizedReqFile} (폴더: ${targetFolder.name}, 기기: ${deviceId || 'unknown'})`,
        status: 403,
        user: authenticatedUserMemo
      });
      sendJsonResponse(req, res, 403, { error: 'PERMISSION_DENIED: 해당 공유 폴더에 접근할 수 있는 권한이 없습니다.' });
      return true;
    }

    const fileInfo = storageService.getRemoteBookFilePath(targetFolder.path, normalizedReqFile);
    if (!fileInfo) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '공유 도서 다운로드 실패', target: normalizedReqFile, status: 404, user: authenticatedUserMemo });
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
      'Content-Length': infoSizeFallback(fileInfo.size),
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileInfo.fileName)}"`
    });
    fs.createReadStream(fileInfo.filePath).pipe(res);
    return true;
  }

  return false;
}