/**
 * @file src/routes/storage/storageBookRoutes.js
 * @description 자체 스토리지 스냅샷, 도서 메타데이터·보관·EPUB 바이너리 및 표지 이미지(/api/storage/snapshot, /books*, /archive*, /covers*) 라우터
 * - 📚 [통합 스냅샷] GET /api/storage/snapshot 및 기기별 remoteLibraryAccessible 권한 플래그 반환
 * - 📖 [도서 메타 & 보관함] GET/POST/DELETE /api/storage/books/:id, GET /api/storage/archive/:id (메타 저장 용량 통제 포함)
 * - 📦 [EPUB 바이너리 I/O] 사전·사후 실측 용량 할당량(413) 직렬화 검사 및 GET/HEAD/POST /api/storage/books/:id/epub 스트리밍
 * - 🖼️ [표지 이미지 I/O] 용량 할당량(413) 직렬화 검사 및 /api/storage/covers/* · /api/storage/books/*.webp 직통 매칭
 */

import fs from 'fs';
import path from 'path';
import { storageService } from '../../storageService.js';
import { auditLogger } from '../../auditLogger.js';
import { checkRemoteLibraryAccessible } from '../../services/storage/remoteLibraryEngine.js';
import {
  resolveStorageContext,
  sanitizeFileName,
  withUserStorageLock
} from '../../services/storage/storageContext.js';
import {
  setCorsHeaders,
  sendJsonResponse,
  readRequestBodyBuffer
} from '../../httpUtils.js';

/**
 * 스냅샷, 도서 메타/EPUB, 보관함 및 표지 이미지 관련 HTTP 요청을 처리합니다.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @param {string} clientIp
 * @param {string} userAgent
 * @param {Object} context - storageAuthGuard에서 검증된 인증 컨텍스트
 * @returns {Promise<boolean>} 라우트 처리 여부
 */
export async function handleStorageBookRoute(req, res, pathname, clientIp, userAgent, context) {
  const {
    env,
    targetUserFolder,
    userQuotaBytes,
    authenticatedUserMemo,
    isRootAdmin,
    deviceId
  } = context;

  // 11. 서재 스냅샷 조회 (/api/storage/snapshot)
  if (req.method === 'GET' && pathname === '/api/storage/snapshot') {
    try {
      const snapshot = await storageService.getUnifiedSnapshot(targetUserFolder);
      const remoteLibraryAccessible = checkRemoteLibraryAccessible(env, { isRootAdmin, deviceId });
      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '📚 서재 스냅샷 조회',
        target: `${targetUserFolder || 'root'} (활성 ${snapshot.cloudBooks.length}권 / 보관 ${snapshot.cloudArchivedBooks.length}권)`,
        status: 200,
        user: authenticatedUserMemo
      });
      sendJsonResponse(req, res, 200, {
        ...snapshot,
        remoteLibraryAccessible
      });
      return true;
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '서재 스냅샷 실패', target: err.message, status: 500, user: authenticatedUserMemo });
      sendJsonResponse(req, res, 500, { error: err.message });
      return true;
    }
  }

  // 12. 도서 메타데이터 저장 및 조회 (/api/storage/books/:id)
  if (pathname.startsWith('/api/storage/books/') && !pathname.endsWith('/epub')) {
    const rawEnd = pathname.replace('/api/storage/books/', '');
    const decodedEnd = decodeURIComponent(rawEnd);
    const isBooksFolderOnlyCheck = decodedEnd.toLowerCase().endsWith('.json');
    const bookId = decodedEnd.replace(/\.json$/i, '');

    if (rawEnd.endsWith('.webp') && (req.method === 'GET' || req.method === 'HEAD')) {
      const coverFileName = decodeURIComponent(rawEnd);
      const info = storageService.getCoverImagePath(coverFileName, targetUserFolder);
      if (!info) {
        if (req.method === 'HEAD') {
          setCorsHeaders(req, res);
          res.writeHead(404);
          res.end();
          return true;
        }
        sendJsonResponse(req, res, 404, { error: '표지를 찾을 수 없습니다.' });
        return true;
      }
      setCorsHeaders(req, res);
      res.writeHead(200, {
        'Content-Type': 'image/webp',
        'Content-Length': info.size,
        'Cache-Control': 'public, max-age=86400'
      });
      if (req.method === 'HEAD') { res.end(); return true; }
      fs.createReadStream(info.filePath).pipe(res);
      return true;
    }

    if (req.method === 'POST') {
      try {
        const buffer = await readRequestBodyBuffer(req, 5 * 1024 * 1024);
        const bookData = JSON.parse(buffer.toString('utf-8'));

        const writeResult = await withUserStorageLock(targetUserFolder, () => {
          if (targetUserFolder) {
            const safeId = sanitizeFileName(bookId);
            const ctx = resolveStorageContext(targetUserFolder);
            const existingPaths = safeId
              ? [path.join(ctx.booksDir, `${safeId}.json`), path.join(ctx.archiveDir, `${safeId}.json`)]
              : [];
            const hasExistingMeta = existingPaths.some((p) => fs.existsSync(p));
            const quotaCheck = storageService.checkUserStorageQuota(targetUserFolder, buffer.length, userQuotaBytes, {
              existingPaths
            });
            const isSmallProgressUpdate = hasExistingMeta && (quotaCheck.netIncomingBytes || 0) <= 4096;
            if (!quotaCheck.allowed && !isSmallProgressUpdate) {
              return { quotaExceeded: true };
            }
          }

          storageService.saveBookMetadata(bookId, bookData, targetUserFolder);
          return { quotaExceeded: false };
        });

        if (writeResult.quotaExceeded) {
          auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '용량 초과 메타 저장 차단', target: `${bookId} (${targetUserFolder})`, status: 413, user: authenticatedUserMemo });
          sendJsonResponse(req, res, 413, { error: 'STORAGE_QUOTA_EXCEEDED: 저장 용량을 초과했습니다.' });
          return true;
        }

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
      if (!meta || (isBooksFolderOnlyCheck && meta.isArchived === true)) {
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '도서 메타 조회 실패', target: bookId, status: 404, user: authenticatedUserMemo });
        sendJsonResponse(req, res, 404, { error: '도서를 찾을 수 없습니다.' });
        return true;
      }
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '도서 메타 조회', target: `${meta.title || bookId} (${targetUserFolder || 'root'})`, status: 200, user: authenticatedUserMemo });
      sendJsonResponse(req, res, 200, meta);
      return true;
    }

    if (req.method === 'DELETE') {
      const count = await withUserStorageLock(targetUserFolder, () =>
        storageService.deleteBookAll(bookId, targetUserFolder)
      );
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

  // 12-B. 보관함(archive/) 도서 메타데이터 조회 (/api/storage/archive/:id)
  if (req.method === 'GET' && pathname.startsWith('/api/storage/archive/')) {
    const rawEnd = pathname.replace('/api/storage/archive/', '');
    const bookId = decodeURIComponent(rawEnd).replace(/\.json$/i, '');
    const meta = storageService.getBookMetadata(bookId, targetUserFolder);
    if (!meta || meta.isArchived !== true) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '보관 도서 메타 조회 실패', target: bookId, status: 404, user: authenticatedUserMemo });
      sendJsonResponse(req, res, 404, { error: '보관 도서를 찾을 수 없습니다.' });
      return true;
    }
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '보관 도서 메타 조회', target: `${meta.title || bookId} (${targetUserFolder || 'root'})`, status: 200, user: authenticatedUserMemo });
    sendJsonResponse(req, res, 200, meta);
    return true;
  }

  // 13. EPUB 도서 바이너리 업로드 및 다운로드 (/api/storage/books/:id/epub)
  if (pathname.startsWith('/api/storage/books/') && pathname.endsWith('/epub')) {
    const rawSegment = pathname.replace('/api/storage/books/', '').replace(/\/epub$/, '');
    const bookId = decodeURIComponent(rawSegment);

    if (req.method === 'POST') {
      const safeId = sanitizeFileName(bookId);
      const existingEpubPaths = (targetUserFolder && safeId)
        ? (() => {
            const ctx = resolveStorageContext(targetUserFolder);
            return [path.join(ctx.booksDir, `${safeId}.epub`), path.join(ctx.archiveDir, `${safeId}.epub`)];
          })()
        : [];

      const contentLength = Number(req.headers['content-length'] || 0);
      if (targetUserFolder && contentLength > 0) {
        const preQuotaCheck = storageService.checkUserStorageQuota(targetUserFolder, contentLength, userQuotaBytes, {
          existingPaths: existingEpubPaths
        });
        if (!preQuotaCheck.allowed) {
          auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '용량 초과 업로드 차단', target: `${bookId} (${targetUserFolder})`, status: 413, user: authenticatedUserMemo });
          sendJsonResponse(req, res, 413, { error: 'STORAGE_QUOTA_EXCEEDED: 저장 용량을 초과했습니다.' });
          return true;
        }
      }

      try {
        const buffer = await readRequestBodyBuffer(req, 100 * 1024 * 1024);

        const writeResult = await withUserStorageLock(targetUserFolder, () => {
          if (targetUserFolder) {
            const quotaCheck = storageService.checkUserStorageQuota(targetUserFolder, buffer.length, userQuotaBytes, {
              existingPaths: existingEpubPaths
            });
            if (!quotaCheck.allowed) {
              return { quotaExceeded: true };
            }
          }

          storageService.saveBookEpub(bookId, buffer, targetUserFolder);
          return { quotaExceeded: false };
        });

        if (writeResult.quotaExceeded) {
          auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '용량 초과 업로드 차단 (실측)', target: `${bookId} (${targetUserFolder})`, status: 413, user: authenticatedUserMemo });
          sendJsonResponse(req, res, 413, { error: 'STORAGE_QUOTA_EXCEEDED: 저장 용량을 초과했습니다.' });
          return true;
        }

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

    if (req.method === 'GET' || req.method === 'HEAD') {
      const info = storageService.getBookEpubPath(bookId, targetUserFolder);
      if (!info) {
        if (req.method === 'HEAD') {
          setCorsHeaders(req, res);
          res.writeHead(404);
          res.end();
          return true;
        }
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'EPUB 다운로드 실패', target: bookId, status: 404, user: authenticatedUserMemo });
        sendJsonResponse(req, res, 404, { error: 'EPUB 파일을 찾을 수 없습니다.' });
        return true;
      }

      setCorsHeaders(req, res);
      res.writeHead(200, {
        'Content-Type': 'application/epub+zip',
        'Content-Length': info.size,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(bookId)}.epub"`
      });

      if (req.method === 'HEAD') {
        res.end();
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

      fs.createReadStream(info.filePath).pipe(res);
      return true;
    }
  }

  // 14. 표지 이미지 관리 (/api/storage/covers/:fileName)
  if (pathname.startsWith('/api/storage/covers/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/covers/', ''));

    if (req.method === 'POST') {
      const safeCoverName = sanitizeFileName(String(fileName || '').replace(/^covers[/\\]/i, ''));
      const existingCoverPaths = (targetUserFolder && safeCoverName)
        ? (() => {
            const ctx = resolveStorageContext(targetUserFolder);
            return [path.join(ctx.booksDir, safeCoverName), path.join(ctx.archiveDir, safeCoverName)];
          })()
        : [];

      const contentLength = Number(req.headers['content-length'] || 0);
      if (targetUserFolder && contentLength > 0) {
        const preQuotaCheck = storageService.checkUserStorageQuota(targetUserFolder, contentLength, userQuotaBytes, {
          existingPaths: existingCoverPaths
        });
        if (!preQuotaCheck.allowed) {
          auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '용량 초과 표지 업로드 차단', target: `${fileName} (${targetUserFolder})`, status: 413, user: authenticatedUserMemo });
          sendJsonResponse(req, res, 413, { error: 'STORAGE_QUOTA_EXCEEDED: 저장 용량을 초과했습니다.' });
          return true;
        }
      }

      try {
        const buffer = await readRequestBodyBuffer(req, 10 * 1024 * 1024);

        const writeResult = await withUserStorageLock(targetUserFolder, () => {
          if (targetUserFolder) {
            const quotaCheck = storageService.checkUserStorageQuota(targetUserFolder, buffer.length, userQuotaBytes, {
              existingPaths: existingCoverPaths
            });
            if (!quotaCheck.allowed) {
              return { quotaExceeded: true };
            }
          }

          storageService.saveCoverImage(fileName, buffer, targetUserFolder);
          return { quotaExceeded: false };
        });

        if (writeResult.quotaExceeded) {
          auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '용량 초과 표지 업로드 차단 (실측)', target: `${fileName} (${targetUserFolder})`, status: 413, user: authenticatedUserMemo });
          sendJsonResponse(req, res, 413, { error: 'STORAGE_QUOTA_EXCEEDED: 저장 용량을 초과했습니다.' });
          return true;
        }

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
        if (req.method === 'HEAD') {
          setCorsHeaders(req, res);
          res.writeHead(404);
          res.end();
          return true;
        }
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
      await withUserStorageLock(targetUserFolder, () =>
        storageService.deleteCoverImage(fileName, targetUserFolder)
      );
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '🖼️ 표지 단일 삭제', target: `${fileName} (${targetUserFolder || 'root'})`, status: 200, user: authenticatedUserMemo });
      sendJsonResponse(req, res, 200, { ok: true, fileName });
      return true;
    }
  }

  return false;
}