/**
 * @file server.js
 * @description 개인용 Google Drive Refresh Token 및 다중 사용자 자체 스토리지 제어 통합 HTTP 서버
 * - 🚀 [초슬림 ESM 파사드 아키텍처] 모든 도메인 로직을 서브 라우터(system, auth, admin, storage)로 100% 위임
 * - 🛡️ [글로벌 보안 가드] ALLOWED_HTTP_METHODS(5대 메서드), securityGuard 보안 헤더 주입 및 OPTIONS 프리플라이트 자동 처리
 * - 🧯 [최상위 비동기 예외 방어] 프록시 프로토콜 정규화 및 미포착 라우트 예외 500 JSON 안전 응답 처리
 * - 🚦 [지능형 URL 디스패처] systemRoutes ➔ authRoutes ➔ adminController ➔ storageRoutes 순차 위임
 * - 📊 [백그라운드 자원 감시 가동] systemMonitor 연동으로 1분 이동평균 연산 및 80% 초과 30분 쿨다운 감시
 */

import http from 'http';
import { URL } from 'url';
import { config } from './config.js';
import { hasRefreshToken } from './tokenStore.js';
import { injectSecurityHeaders } from './src/securityGuard.js';
import { systemMonitor } from './src/systemMonitor.js';
import { handleAdminRoute } from './src/adminController.js';

// 🌟 분리된 도메인 전담 모듈 및 라우터 import
import { getClientIp, setCorsHeaders, sendJsonResponse } from './src/httpUtils.js';
import { handleSystemRoute } from './src/routes/systemRoutes.js';
import { handleAuthRoute } from './src/routes/authRoutes.js';
import { handleStorageRoute } from './src/routes/storageRoutes.js';

// 허용된 정규 HTTP 메서드 목록
const ALLOWED_HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS']);

const server = http.createServer(async (req, res) => {
  // 1. 글로벌 보안 헤더 주입
  injectSecurityHeaders(res);

  // 2. 비인가 변칙 HTTP 메서드 차단 (405)
  if (!ALLOWED_HTTP_METHODS.has(req.method)) {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: `METHOD_NOT_ALLOWED: 지원하지 않는 HTTP 메서드입니다 (${req.method})` }));
    return;
  }

  // 3. CORS 프리플라이트(OPTIONS) 0초 즉시 응답
  if (req.method === 'OPTIONS') {
    setCorsHeaders(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const rawProto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim().toLowerCase();
    const protocol = (rawProto === 'https' || rawProto === 'http') ? rawProto : 'http';
    const host = req.headers.host || `${config.host}:${config.port}`;
    const reqUrl = new URL(req.url, `${protocol}://${host}`);
    const pathname = reqUrl.pathname;
    const clientIp = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';

    console.log(`[Request] ${req.method} ${pathname} (IP: ${clientIp})`);

    // =========================================================================
    // 🧭 도메인 책임별 서브 라우터 순차 디스패치 위임
    // =========================================================================

    // [도메인 1] 시스템 헬스체크 & 실시간 관제 라우터 (/api/health, /api/admin/system-stats, /api/admin/discord-webhook)
    if (await handleSystemRoute(req, res, pathname, reqUrl, clientIp, userAgent)) {
      return;
    }

    // [도메인 2] Google OAuth & 6자리 OTP 인증 라우터 (/auth/google/*, /api/auth/otp/*, /api/access-token)
    if (await handleAuthRoute(req, res, pathname, reqUrl, clientIp, userAgent, protocol, host)) {
      return;
    }

    // [도메인 3] 관리자 인증 & 대시보드 라우터 (/admin/*, /settings)
    if (pathname.startsWith('/admin') || pathname === '/settings') {
      const handled = await handleAdminRoute(req, res, pathname, clientIp, userAgent);
      if (handled) return;
    }

    // [도메인 4] 자체 스토리지 REST API 라우터 (/api/storage/*)
    if (await handleStorageRoute(req, res, pathname, reqUrl, clientIp, userAgent)) {
      return;
    }

    // 기본 루트(/) 접속 시 관리자 대시보드로 302 이동
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return;
    }

    // 매칭되는 라우트가 없는 경우 404
    return sendJsonResponse(req, res, 404, { error: 'Not Found' });
  } catch (err) {
    console.error(`❌ [Server Unhandled Error] ${req.method} ${req.url}:`, err);
    if (!res.headersSent && !res.writableEnded) {
      try {
        sendJsonResponse(req, res, 500, {
          error: 'INTERNAL_SERVER_ERROR',
          message: err?.message || '서버 요청 처리 중 예기치 않은 오류가 발생했습니다.'
        });
      } catch (_) {
        if (!res.writableEnded) res.end();
      }
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

// 서버 구동 및 백그라운드 자원 감시 루프 시작
server.listen(config.port, config.host, () => {
  console.log('====================================================');
  console.log(`🚀 Personal EPUB Server 가 구동되었습니다.`);
  console.log(`   - 바인딩: http://${config.host}:${config.port}`);
  console.log(`   - 제어 센터: http://${config.host}:${config.port}/admin`);
  console.log(`   - 허용 출처: ${config.security.allowedOrigin}`);
  console.log(`   - 토큰 상태: ${hasRefreshToken() ? '저장됨 ✅' : '미등록 (로그인 필요 ⚠️)'}`);
  console.log('====================================================');

  // 📊 시스템 자원(CPU 1분 평균/RAM/DISK) 감시 엔진 자동 가동
  systemMonitor.startMonitoring();
});