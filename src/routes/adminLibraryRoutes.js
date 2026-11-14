/**
 * @file src/routes/adminLibraryRoutes.js
 * @description 관리자 제어 센터 - 사용자 서재 도서·오류파일·묘비 관리 전용 AJAX 라우터
 * - 🔒 [관리자 세션 검증] 외부에서 isAdminAuthenticated 상태 주입으로 순환 참조 0% 보장
 * - 📦 [안전 바디 수신] readRequestBodyBuffer 크기 제한으로 비정상 JSON 페이로드 차단
 * - 📋 [보안 감사 추적] 모든 삭제/CFI초기화/묘비해제 내역을 auditLogger에 영구 기록
 */

import { URL } from 'url';
import { auditLogger } from '../auditLogger.js';
import { readRequestBodyBuffer } from '../httpUtils.js';
import {
  inspectUserLibrary,
  deleteUserBookAsset,
  removeUserTombstone
} from '../services/storage/adminLibraryInspector.js';

/**
 * 관리자 AJAX JSON 응답 전송 헬퍼
 * @param {import('http').ServerResponse} res 
 * @param {number} statusCode 
 * @param {any} payload 
 */
function sendAdminJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/**
 * 🛠️ 관리자 사용자 서재(도서/오류파일/묘비) 관리 AJAX 라우트를 처리합니다.
 * @param {import('http').IncomingMessage} req 
 * @param {import('http').ServerResponse} res 
 * @param {string} pathname 
 * @param {string} clientIp 
 * @param {string} userAgent 
 * @param {{ isAdminAuthenticated: boolean }} authContext 
 * @returns {Promise<boolean>} 라우트 처리 여부
 */
export async function handleAdminLibraryRoute(req, res, pathname, clientIp, userAgent, { isAdminAuthenticated }) {
  // 1. 사용자 서재 실측 조회 (GET /admin/users/library?folderName=user_xxxx)
  if (req.method === 'GET' && pathname === '/admin/users/library') {
    if (!isAdminAuthenticated) {
      sendAdminJson(res, 401, { error: 'UNAUTHORIZED' });
      return true;
    }

    try {
      const reqUrl = new URL(req.url, 'http://localhost');
      const folderName = reqUrl.searchParams.get('folderName')?.trim() || '';
      const data = inspectUserLibrary(folderName);
      sendAdminJson(res, 200, { ok: true, ...data });
    } catch (err) {
      const status = err.message?.startsWith('INVALID_') ? 400 : 500;
      sendAdminJson(res, status, { ok: false, error: err.message });
    }
    return true;
  }

  // 2. 도서 전체/개별파일 삭제 및 CFI 초기화 (POST /admin/users/library/delete-asset)
  if (req.method === 'POST' && pathname === '/admin/users/library/delete-asset') {
    if (!isAdminAuthenticated) {
      sendAdminJson(res, 401, { error: 'UNAUTHORIZED' });
      return true;
    }

    try {
      const buffer = await readRequestBodyBuffer(req, 1024 * 1024);
      const payload = JSON.parse(buffer.toString('utf-8') || '{}');
      const { folderName, action, bookId, fileName, location, addToTombstone, title } = payload;

      const result = deleteUserBookAsset(folderName, {
        action,
        bookId,
        fileName,
        location,
        addToTombstone: Boolean(addToTombstone),
        title
      });

      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: `🧹 관리자 도서 정리 (${action})`,
        target: `${fileName || bookId || '-'} (${folderName})`,
        status: 200,
        user: 'Root Admin'
      });

      sendAdminJson(res, 200, result);
    } catch (err) {
      const status = err.message?.startsWith('INVALID_') || err.message?.startsWith('UNSUPPORTED_') ? 400 : 500;
      sendAdminJson(res, status, { ok: false, error: err.message });
    }
    return true;
  }

  // 3. 특정 묘비 항목 해제 (POST /admin/users/tombstones/delete)
  if (req.method === 'POST' && pathname === '/admin/users/tombstones/delete') {
    if (!isAdminAuthenticated) {
      sendAdminJson(res, 401, { error: 'UNAUTHORIZED' });
      return true;
    }

    try {
      const buffer = await readRequestBodyBuffer(req, 1024 * 1024);
      const payload = JSON.parse(buffer.toString('utf-8') || '{}');
      const { folderName, bookId } = payload;

      const result = removeUserTombstone(folderName, bookId);

      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '🪦 관리자 묘비 해제',
        target: `${bookId} (${folderName})`,
        status: 200,
        user: 'Root Admin'
      });

      sendAdminJson(res, 200, result);
    } catch (err) {
      const status = err.message?.startsWith('INVALID_') ? 400 : 500;
      sendAdminJson(res, status, { ok: false, error: err.message });
    }
    return true;
  }

  return false;
}