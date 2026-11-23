/**
 * @file src/routes/storageRoutes.js
 * @description 자체 스토리지 모드(/api/storage/*) REST API 진입 파사드(Facade) 라우터
 * - 🔒 [인증 게이트 위임] storageAuthGuard를 통해 Rate Limit, STORAGE_MODE, API 키 및 기기 화이트리스트 선검증
 * - 🧩 [ESM 도메인 라우터 분리] 시스템·기기·설정 / 공유 도서함 / 스냅샷·도서·표지 라우터를 순차 위임
 * - 🔄 [100% 계약 보존] 기존 handleStorageRoute(req, res, pathname, reqUrl, clientIp, userAgent) 공개 API 유지
 */

import { authenticateStorageRequest } from './storage/storageAuthGuard.js';
import { handleStorageSystemDataRoute } from './storage/storageSystemDataRoutes.js';
import { handleStorageRemoteLibraryRoute } from './storage/storageRemoteLibraryRoutes.js';
import { handleStorageBookRoute } from './storage/storageBookRoutes.js';

/**
 * 자체 스토리지 모드(/api/storage/*) HTTP 요청을 검증 후 도메인별 서브 라우터로 위임합니다.
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

  const authGate = authenticateStorageRequest(req, res, pathname, reqUrl, clientIp, userAgent);
  if (authGate.handled || !authGate.context) {
    return true;
  }

  const { context } = authGate;

  if (await handleStorageSystemDataRoute(req, res, pathname, clientIp, userAgent, context)) {
    return true;
  }

  if (await handleStorageRemoteLibraryRoute(req, res, pathname, reqUrl, clientIp, userAgent, context)) {
    return true;
  }

  if (await handleStorageBookRoute(req, res, pathname, clientIp, userAgent, context)) {
    return true;
  }

  return false;
}