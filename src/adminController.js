/**
 * @file src/adminController.js
 * @description 관리자 웹 제어 센터 통합 파사드(Facade) 및 라우트 오케스트레이터
 * - 🧩 [ESM 파사드 분리] adminAuthRoutes(세션·로그인·대시보드) + adminLibraryRoutes + adminUserRoutes + adminSystemRoutes 조합
 * - 🔄 [100% 공개 계약 보존] 기존 parseCookies, isAuthenticated, createAdminSession, destroyAdminSession, render*, handleAdminRoute 유지
 * - ⚡ [비관리자 경로 무부하 통과] /admin*, /settings 외 경로는 readEnvFile 호출 없이 즉시 false 반환
 */

import { handleAdminLibraryRoute } from './routes/adminLibraryRoutes.js';
import { renderLoginPageHtml, renderAdminSettingsHtml } from './adminViews.js';
import {
  parseCookies,
  isAuthenticated,
  createAdminSession,
  destroyAdminSession,
  handleAdminAuthRoute
} from './routes/admin/adminAuthRoutes.js';
import { handleAdminUserRoute } from './routes/admin/adminUserRoutes.js';
import { handleAdminSystemRoute } from './routes/admin/adminSystemRoutes.js';

export {
  renderLoginPageHtml,
  renderAdminSettingsHtml,
  parseCookies,
  isAuthenticated,
  createAdminSession,
  destroyAdminSession
};

/**
 * 🌟 [관리자 라우트 전담 통합 디스패처]
 * 관리자 로그인/로그아웃, 제어 센터 HTML 렌더링, 사용자·기기·로그·크래시 리포트·설정 저장 요청을 처리합니다.
 * @param {import('http').IncomingMessage} req - HTTP 요청 객체
 * @param {import('http').ServerResponse} res - HTTP 응답 객체
 * @param {string} pathname - 정규화된 요청 경로
 * @param {string} clientIp - 클라이언트 IP 주소
 * @param {string} userAgent - 요청 User-Agent 헤더
 * @returns {Promise<boolean>} 라우트 처리 완료 여부
 */
export async function handleAdminRoute(req, res, pathname, clientIp, userAgent) {
  if (!pathname.startsWith('/admin') && pathname !== '/settings') {
    return false;
  }

  if (await handleAdminAuthRoute(req, res, pathname, clientIp, userAgent)) {
    return true;
  }

  const isAdminAuthenticated = isAuthenticated(req);

  if (await handleAdminLibraryRoute(req, res, pathname, clientIp, userAgent, {
    isAdminAuthenticated
  })) {
    return true;
  }

  if (await handleAdminUserRoute(req, res, pathname, clientIp, userAgent, {
    isAdminAuthenticated
  })) {
    return true;
  }

  if (await handleAdminSystemRoute(req, res, pathname, clientIp, userAgent, {
    isAdminAuthenticated
  })) {
    return true;
  }

  return false;
}