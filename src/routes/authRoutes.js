/**
 * @file src/routes/authRoutes.js
 * @description Google OAuth 및 6자리 단기 기기 연결 번호(OTP) 인증 전담 라우터
 * - ⚡ [구글 공식 로그인 0초 직통 점프] GET /auth/google 클릭 즉시 302 구글 계정 선택 화면으로 다이렉트 이동
 * - 🔄 [Google OAuth 콜백 & 토큰 교환] GET /auth/google/callback 승인 코드 수신 및 암호화 보관
 * - 🕒 [백그라운드 자동 갱신] GET /api/access-token 호출 시 인증/출처 검증 후 신선한 Google Access Token 즉시 발급
 * - 🔢 [6자리 OTP 번호 발급] POST /api/auth/otp/issue 3분 유효 일회용 번호 생성
 * - ✨ [6자리 OTP 기기 등록 결속] POST /api/auth/otp/verify 인증 성공 시 해당 기기를 정식 승인 장부에 자동 각인
 */

import { generateAuthUrl, verifyState, exchangeCodeForTokens, getFreshAccessToken } from '../../googleAuth.js';
import { apiKeyManager } from '../apiKeyManager.js';
import { auditLogger } from '../auditLogger.js';
import { readEnvFile } from '../envManager.js';
import { isAuthenticated } from '../adminController.js';
import {
  extractApiKey,
  extractDeviceInfo,
  isAllowedClientOrigin,
  checkOtpRateLimit,
  recordOtpFailure,
  clearOtpFailure,
  sendJsonResponse,
  sendHtmlResponse,
  readRequestBodyBuffer,
  checkRateLimit
} from '../httpUtils.js';

/**
 * 인증 및 OTP 관련 HTTP 요청을 처리합니다.
 * @param {import('http').IncomingMessage} req 
 * @param {import('http').ServerResponse} res 
 * @param {string} pathname 
 * @param {URL} reqUrl 
 * @param {string} clientIp 
 * @param {string} userAgent 
 * @param {string} protocol 
 * @param {string} host 
 * @returns {Promise<boolean>} 라우트 처리 여부
 */
export async function handleAuthRoute(req, res, pathname, reqUrl, clientIp, userAgent, protocol, host) {
  // 1. 6자리 일회용 연결 번호(OTP) 발급
  if (req.method === 'POST' && pathname === '/api/auth/otp/issue') {
    const providedApiKey = extractApiKey(req, reqUrl);
    if (!providedApiKey) {
      sendJsonResponse(req, res, 401, { error: 'API 키가 필요합니다.' });
      return true;
    }

    const env = readEnvFile();
    const rootMasterKey = env.STORAGE_API_KEY?.trim();
    let folderName = 'root';

    if (rootMasterKey && providedApiKey === rootMasterKey) {
      folderName = 'root';
    } else {
      const auth = apiKeyManager.authenticateApiKey(providedApiKey);
      if (!auth.authenticated || !auth.user) {
        sendJsonResponse(req, res, 401, { error: '유효하지 않은 API 키입니다.' });
        return true;
      }
      folderName = auth.user.folderName;
    }

    const otpResult = apiKeyManager.issueDeviceOtp(folderName, providedApiKey);
    if (!otpResult.success) {
      sendJsonResponse(req, res, 500, { error: otpResult.error });
      return true;
    }

    auditLogger.recordAccessLog({
      ip: clientIp,
      userAgent,
      action: '🔢 기기 연결 번호 발급',
      target: otpResult.displayCode,
      status: 200,
      user: folderName
    });

    sendJsonResponse(req, res, 200, {
      ok: true,
      code: otpResult.code,
      displayCode: otpResult.displayCode,
      expiresInSeconds: otpResult.expiresInSeconds
    });
    return true;
  }

  // 2. 6자리 일회용 연결 번호(OTP) 검증 및 정식 기기 등록 (화이트리스트 각인)
  if (req.method === 'POST' && pathname === '/api/auth/otp/verify') {
    const otpGuard = checkOtpRateLimit(clientIp);
    if (!otpGuard.allowed) {
      sendJsonResponse(req, res, 429, {
        error: `시도 횟수가 초과되었습니다. ${otpGuard.waitMinutes}분 후에 다시 시도해 주세요.`
      });
      return true;
    }

    try {
      const buffer = await readRequestBodyBuffer(req, 1024 * 1024);
      const payload = JSON.parse(buffer.toString('utf-8') || '{}');
      const inputCode = payload.code;

      // 헤더 및 바디에서 게스트 기기 식별 정보 추출
      const headerDevice = extractDeviceInfo(req, reqUrl);
      const guestDeviceId = payload.deviceId || headerDevice.deviceId || '';
      const guestDeviceName = payload.deviceName || headerDevice.deviceName || '';

      const exchangeResult = apiKeyManager.verifyAndExchangeDeviceOtp(inputCode, {
        deviceId: guestDeviceId,
        deviceName: guestDeviceName,
        clientIp
      });

      if (!exchangeResult.success) {
        recordOtpFailure(clientIp);
        sendJsonResponse(req, res, 400, { error: exchangeResult.error });
        return true;
      }

      clearOtpFailure(clientIp);

      const currentServerUrl = `${protocol}://${host}`;
      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '✨ 기기 연결 번호 인증 성공',
        target: `${inputCode} (${guestDeviceName || guestDeviceId || '신규 기기'})`,
        status: 200,
        user: exchangeResult.folderName
      });

      sendJsonResponse(req, res, 200, {
        ok: true,
        serverUrl: currentServerUrl,
        apiKey: exchangeResult.apiKey,
        folderName: exchangeResult.folderName
      });
      return true;
    } catch (err) {
      sendJsonResponse(req, res, 400, { error: '잘못된 요청 형식입니다.' });
      return true;
    }
  }

  // 3. Google OAuth 로그인 점프 (중간 HTML 없이 302 다이렉트 이동)
  if (req.method === 'GET' && pathname === '/auth/google') {
    try {
      const authUrl = generateAuthUrl();
      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '구글 계정 연동 시작',
        target: '구글 공식 인증 창으로 즉시 이동',
        status: 302,
        user: 'Root Admin'
      });
      res.writeHead(302, { Location: authUrl });
      res.end();
      return true;
    } catch (err) {
      console.error('[OAuth Init Error]', err.message);
      sendHtmlResponse(req, res, 500, '로그인 시작 오류', 'Google 로그인 URL을 생성하지 못했습니다. Google Client ID 및 Secret 설정을 확인해 주세요.', false);
      return true;
    }
  }

  // 4. Google OAuth 콜백 처리
  if (req.method === 'GET' && pathname === '/auth/google/callback') {
    const code = reqUrl.searchParams.get('code');
    const state = reqUrl.searchParams.get('state');
    const error = reqUrl.searchParams.get('error');

    if (error) {
      sendHtmlResponse(req, res, 400, 'Google 승인 거부', `Google 인증이 거부되었습니다: ${error}`, false);
      return true;
    }

    if (!state || !verifyState(state)) {
      sendHtmlResponse(req, res, 400, '인증 실패 (State 검증 실패)', '보안 검증(State)에 실패했습니다. 다시 시도해 주세요.', false);
      return true;
    }

    if (!code) {
      sendHtmlResponse(req, res, 400, '인증 코드 누락', 'Google로부터 Authorization Code를 수신하지 못했습니다.', false);
      return true;
    }

    try {
      await exchangeCodeForTokens(code);
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'Google OAuth 토큰 교환 성공', target: '토큰 암호화 저장 완료', status: 200, user: 'Root Admin' });
      sendHtmlResponse(
        req,
        res,
        200,
        'Google Drive 연동 성공',
        'Google Drive 인증 정보가 서버에 안전하게 암호화되어 저장되었습니다. 이제 웹 뷰어에서 클라우드 동기화 기능을 사용할 수 있습니다.',
        true
      );
      return true;
    } catch (err) {
      sendHtmlResponse(req, res, 500, '토큰 교환 실패', `인증 토큰을 저장하지 못했습니다: ${err.message}`, false);
      return true;
    }
  }

  // 5. Google Access Token 갱신 발급
  if (req.method === 'GET' && pathname === '/api/access-token') {
    if (!checkRateLimit(req, 60)) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '토큰 발급 횟수 초과', target: '/api/access-token', status: 429 });
      sendJsonResponse(req, res, 429, { error: '요청 횟수가 초과되었습니다. 잠시 후 다시 시도해 주세요.' });
      return true;
    }

    // 🔒 [보안 가드] 관리자 세션, 유효 API 키, 또는 허용된 웹뷰어 출처 검증
    const providedApiKey = extractApiKey(req, reqUrl);
    const env = readEnvFile();
    const rootMasterKey = env.STORAGE_API_KEY?.trim();
    let isAuthorizedTokenRequest = isAuthenticated(req);

    if (!isAuthorizedTokenRequest && providedApiKey) {
      if (rootMasterKey && providedApiKey === rootMasterKey) {
        isAuthorizedTokenRequest = true;
      } else {
        const auth = apiKeyManager.authenticateApiKey(providedApiKey);
        if (!auth.authenticated) {
          auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '🚫 토큰 발급 API 키 인증 실패', target: auth.reason || pathname, status: 401 });
          sendJsonResponse(req, res, 401, { error: 'UNAUTHORIZED_API_KEY: 유효한 API 키가 필요합니다.' });
          return true;
        }
        isAuthorizedTokenRequest = true;
      }
    }

    if (!isAuthorizedTokenRequest) {
      const configuredOrigin = (env.ALLOWED_ORIGIN || '').trim();
      const hasBrowserSourceHeader = Boolean(req.headers.origin || req.headers.referer || req.headers['sec-fetch-site']);

      if (!isAllowedClientOrigin(req) || ((!configuredOrigin || configuredOrigin === '*') && !hasBrowserSourceHeader)) {
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '🚫 미인가 토큰 발급 차단', target: pathname, status: 403 });
        sendJsonResponse(req, res, 403, { error: 'FORBIDDEN: 허용된 웹뷰어 출처 또는 유효한 인증 정보가 필요합니다.' });
        return true;
      }
    }

    try {
      const tokenPayload = await getFreshAccessToken();
      sendJsonResponse(req, res, 200, tokenPayload);
      return true;
    } catch (err) {
      const statusCode = err.status || 500;
      const clientMessage = statusCode === 401
        ? 'Google 계정 연동이 필요합니다. 먼저 /auth/google 을 통해 Google 계정을 연동해 주세요.'
        : 'Access Token 발급에 실패했습니다.';

      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '토큰 발급 실패', target: clientMessage, status: statusCode });
      sendJsonResponse(req, res, statusCode, { error: clientMessage });
      return true;
    }
  }

  return false;
}