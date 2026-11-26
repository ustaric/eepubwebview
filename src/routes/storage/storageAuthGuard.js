/**
 * @file src/routes/storage/storageAuthGuard.js
 * @description 자체 스토리지 API(/api/storage/*) 공통 인증·보안·기기 화이트리스트 게이트 모듈
 * - 🚦 [요청 제한 & 모드 확인] 분당 600회 Rate Limit 및 STORAGE_MODE === 'true' 검증
 * - 🔒 [Root / User API 키 인증] 상수 시간 Root 키 비교, 빈 키 차단, 만료·폐기 키 거부 및 공용 폴백 우회 차단
 * - 📱 [기기 화이트리스트 & 토큰 검증] X-Device-Id 형식·예약어, verifyAndTouchDevice(토큰·차단·한도·미등록) 검증
 * - 🧭 [최소 권한 컨텍스트 반환] Fail-Closed 샌드박스 검증 후 하위 라우터가 사용할 authContext 반환
 */

import { auditLogger } from '../../auditLogger.js';
import { apiKeyManager } from '../../apiKeyManager.js';
import { readEnvFile } from '../../envManager.js';
import { isAuthenticated } from '../../adminController.js';
import {
  extractApiKey,
  extractDeviceInfo,
  checkRateLimit,
  safeCompareSecret,
  sendJsonResponse
} from '../../httpUtils.js';

// 🛡️ 기기 식별자 형식 및 프로토타입 오염 예약어 가드
const DEVICE_ID_REGEX = /^[a-zA-Z0-9_-]{8,64}$/;
const FORBIDDEN_DEVICE_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);

/**
 * 🔍 요청 출처(Origin 또는 Referer origin) 안전 추출 헬퍼
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
function getSafeOriginLabel(req) {
  if (req.headers.origin) return String(req.headers.origin).trim();
  if (req.headers.referer) {
    try {
      return new URL(req.headers.referer).origin;
    } catch (_) {
      return '';
    }
  }
  return '';
}

/**
 * 🔍 민감 원문 없이 인증 헤더 상태 태그만 산출하는 진단 헬퍼
 * @param {import('http').IncomingMessage} req
 * @param {URL} reqUrl
 * @returns {string}
 */
function getAuthDiagnosticState(req, reqUrl) {
  const rawApiHeader = req.headers['x-api-key'];
  let apiKeyPart = 'apiKey:none';
  if (rawApiHeader !== undefined) {
    apiKeyPart = String(rawApiHeader).trim() ? 'apiKey:header_present' : 'apiKey:header_empty';
  } else if (reqUrl.searchParams.has('apiKey')) {
    apiKeyPart = reqUrl.searchParams.get('apiKey')?.trim() ? 'apiKey:query_present' : 'apiKey:query_empty';
  }

  const rawAuthHeader = req.headers['authorization'];
  let authPart = 'auth:none';
  if (rawAuthHeader) {
    authPart = String(rawAuthHeader).startsWith('Bearer ') ? 'auth:bearer_present' : 'auth:other_present';
  }

  return `${apiKeyPart}|${authPart}`;
}

/**
 * 🛡️ API 키 헤더/Bearer/쿼리가 명시되었으나 공백·빈 문자열인지 판별합니다.
 * @param {import('http').IncomingMessage} req
 * @param {URL} reqUrl
 * @returns {boolean}
 */
function hasExplicitEmptyApiKey(req, reqUrl) {
  if (req.headers['x-api-key'] !== undefined && !String(req.headers['x-api-key']).trim()) {
    return true;
  }
  const authHeader = req.headers['authorization'];
  if (authHeader !== undefined) {
    const trimmedAuth = String(authHeader).trim();
    if (!trimmedAuth || (trimmedAuth.toLowerCase().startsWith('bearer') && !trimmedAuth.replace(/^Bearer\s*/i, '').trim())) {
      return true;
    }
  }
  if (reqUrl.searchParams.has('apiKey') && !String(reqUrl.searchParams.get('apiKey') || '').trim()) {
    return true;
  }
  return false;
}

/**
 * 자체 스토리지 요청의 공통 보안·인증·기기 화이트리스트를 검증하고 컨텍스트를 반환합니다.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @param {URL} reqUrl
 * @param {string} clientIp
 * @param {string} userAgent
 * @returns {{ handled: boolean, context: Object|null }}
 */
export function authenticateStorageRequest(req, res, pathname, reqUrl, clientIp, userAgent) {
  const safeOrigin = getSafeOriginLabel(req);

  // 1. 스토리지 API 요청 횟수 제한 (1분 600회)
  if (!checkRateLimit(req, 600)) {
    auditLogger.recordAccessLog({
      ip: clientIp,
      userAgent,
      action: '요청 횟수 초과 차단',
      target: pathname,
      status: 429,
      method: req.method,
      origin: safeOrigin
    });
    sendJsonResponse(req, res, 429, { error: 'RATE_LIMIT_EXCEEDED: 요청 횟수가 초과되었습니다. 잠시 후 다시 시도해 주세요.' });
    return { handled: true, context: null };
  }

  // 2. STORAGE_MODE 활성화 여부 검증
  const env = readEnvFile();
  if (env.STORAGE_MODE !== 'true') {
    auditLogger.recordAccessLog({
      ip: clientIp,
      userAgent,
      action: '스토리지 모드 비활성 거절',
      target: pathname,
      status: 403,
      method: req.method,
      origin: safeOrigin
    });
    sendJsonResponse(req, res, 403, { error: 'STORAGE_MODE_DISABLED: 개인 서버 저장소 모드가 비활성화되어 있습니다.' });
    return { handled: true, context: null };
  }

  // 3. API 키 우선 인증 및 관리자 쿠키 세션·기기 화이트리스트 가드
  let targetUserFolder = null;
  let userQuotaBytes = 1073741824;
  let userMaxDevices = 6;
  let authenticatedUserMemo = 'Root Admin';
  let isRootAdmin = false;

  const isRootApiKeyEnabled = env.ENABLE_ROOT_API_KEY === 'true';
  const rootMasterKey = env.STORAGE_API_KEY?.trim();
  const isEnforceApiKey = env.ENFORCE_STORAGE_API_KEY === 'true';
  const providedApiKey = extractApiKey(req, reqUrl);
  const { deviceId, deviceName, deviceToken } = extractDeviceInfo(req, reqUrl);
  const authState = getAuthDiagnosticState(req, reqUrl);
  const isAdminConfigRoute = pathname === '/api/storage/admin/shared-folders';
  const hasAdminSession = isAuthenticated(req);

  if (isAdminConfigRoute && hasAdminSession) {
    isRootAdmin = true;
    targetUserFolder = null;
    authenticatedUserMemo = 'Root Admin (Web Session)';
  } else if (!providedApiKey && hasExplicitEmptyApiKey(req, reqUrl)) {
    auditLogger.recordAccessLog({
      ip: clientIp,
      userAgent,
      action: '빈 API 키 헤더 차단',
      target: pathname,
      status: 401,
      method: req.method,
      deviceId,
      deviceName,
      origin: safeOrigin,
      authState
    });
    sendJsonResponse(req, res, 401, { error: 'EMPTY_API_KEY: 빈 API 키가 전달되었습니다.' });
    return { handled: true, context: null };
  } else if (providedApiKey) {
    if (isRootApiKeyEnabled && rootMasterKey && safeCompareSecret(providedApiKey, rootMasterKey)) {
      targetUserFolder = null;
      authenticatedUserMemo = 'Root Admin';
      isRootAdmin = true;
      auditLogger.recordApiKeyUsage({ ip: clientIp, userAgent, path: pathname, method: req.method, userMemo: 'Root Admin' });
    } else {
      const hasValidDeviceFormat = Boolean(deviceId && !FORBIDDEN_DEVICE_KEYS.has(deviceId) && DEVICE_ID_REGEX.test(deviceId));
      const auth = apiKeyManager.authenticateApiKey(providedApiKey, { activatePending: hasValidDeviceFormat });

      if (auth.authenticated && auth.user) {
        targetUserFolder = auth.user.folderName;
        userQuotaBytes = auth.user.storageQuotaBytes || (1024 * 1024 * 1024);
        userMaxDevices = auth.user.maxDevices || 6;
        authenticatedUserMemo = `${auth.user.memo} (${auth.user.folderName})`;

        if (!deviceId) {
          auditLogger.recordAccessLog({
            ip: clientIp,
            userAgent,
            action: '🚫 기기 식별자 누락 차단',
            target: `${pathname} (${auth.user.memo})`,
            status: 403,
            user: authenticatedUserMemo,
            method: req.method,
            deviceId,
            deviceName,
            origin: safeOrigin
          });
          sendJsonResponse(req, res, 403, { error: 'DEVICE_ID_REQUIRED: 기기 식별자(X-Device-Id)가 필요합니다.' });
          return { handled: true, context: null };
        }

        if (!hasValidDeviceFormat) {
          auditLogger.recordAccessLog({
            ip: clientIp,
            userAgent,
            action: '🚫 비정상 기기 식별자 차단',
            target: `${pathname} (${auth.user.memo})`,
            status: 403,
            user: authenticatedUserMemo,
            method: req.method,
            deviceId: String(deviceId).slice(0, 32),
            deviceName,
            origin: safeOrigin
          });
          sendJsonResponse(req, res, 403, { error: 'INVALID_DEVICE_ID: 유효하지 않은 기기 식별자 형식입니다.' });
          return { handled: true, context: null };
        }

        const deviceResult = apiKeyManager.verifyAndTouchDevice(auth.user.folderName, {
          deviceId,
          deviceName,
          clientIp,
          deviceToken
        });

        if (!deviceResult.allowed && deviceResult.reason === 'DEVICE_ID_REQUIRED') {
          auditLogger.recordAccessLog({
            ip: clientIp,
            userAgent,
            action: '🚫 기기 식별자 누락 차단',
            target: `${pathname} (${auth.user.memo})`,
            status: 403,
            user: authenticatedUserMemo,
            method: req.method,
            deviceId,
            deviceName,
            origin: safeOrigin
          });
          sendJsonResponse(req, res, 403, { error: 'DEVICE_ID_REQUIRED: 기기 식별자(X-Device-Id)가 필요합니다.' });
          return { handled: true, context: null };
        }

        if (!deviceResult.allowed && (deviceResult.reason === 'DEVICE_TOKEN_REQUIRED' || deviceResult.reason === 'DEVICE_TOKEN_INVALID')) {
          auditLogger.recordAccessLog({
            ip: clientIp,
            userAgent,
            action: `🚫 기기 검증 토큰 오류 차단 (${deviceResult.reason})`,
            target: `${deviceName || deviceId} (${auth.user.memo})`,
            status: 403,
            user: authenticatedUserMemo,
            method: req.method,
            deviceId,
            deviceName,
            origin: safeOrigin
          });
          sendJsonResponse(req, res, 403, {
            error: `${deviceResult.reason}: 기기 보안 토큰 검증에 실패했습니다. 6자리 번호 또는 연결 버튼으로 다시 인증해 주세요.`,
            reason: deviceResult.reason,
            deviceId
          });
          return { handled: true, context: null };
        }

        if (!deviceResult.allowed && deviceResult.reason === 'DEVICE_BLOCKED') {
          auditLogger.recordAccessLog({
            ip: clientIp,
            userAgent,
            action: '🚫 차단된 기기 접근 차단',
            target: `${deviceName || deviceId} (${auth.user.memo})`,
            status: 403,
            user: authenticatedUserMemo,
            method: req.method,
            deviceId,
            deviceName,
            origin: safeOrigin
          });
          sendJsonResponse(req, res, 403, { error: 'DEVICE_BLOCKED: 관리자에 의해 차단된 기기입니다.', deviceId });
          return { handled: true, context: null };
        }

        if (!deviceResult.allowed && deviceResult.reason === 'DEVICE_LIMIT_EXCEEDED') {
          auditLogger.recordAccessLog({
            ip: clientIp,
            userAgent,
            action: '🚫 기기 등록 한도 초과',
            target: `${deviceName || deviceId} (${deviceResult.maxDevices || 6}대 한도 초과)`,
            status: 403,
            user: authenticatedUserMemo,
            method: req.method,
            deviceId,
            deviceName,
            origin: safeOrigin
          });
          sendJsonResponse(req, res, 403, {
            error: `DEVICE_LIMIT_EXCEEDED: 허용된 최대 등록 기기 수(${deviceResult.maxDevices || 6}대)를 초과했습니다.`,
            maxDevices: deviceResult.maxDevices || 6
          });
          return { handled: true, context: null };
        }

        if (!deviceResult.allowed && deviceResult.reason === 'DEVICE_UNREGISTERED') {
          auditLogger.recordAccessLog({
            ip: clientIp,
            userAgent,
            action: '🚫 미등록/삭제된 기기 차단',
            target: `${deviceName || deviceId} (${auth.user.memo})`,
            status: 403,
            user: authenticatedUserMemo,
            method: req.method,
            deviceId,
            deviceName,
            origin: safeOrigin
          });
          sendJsonResponse(req, res, 403, {
            error: 'DEVICE_UNREGISTERED: 등록되지 않았거나 삭제된 기기입니다. 6자리 번호로 다시 로그인해 주세요.',
            deviceId
          });
          return { handled: true, context: null };
        }

        auditLogger.recordApiKeyUsage({ ip: clientIp, userAgent, path: pathname, method: req.method, userMemo: auth.user.memo });
      } else if (auth.reason === 'API_KEY_EXPIRED') {
        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '만료된 API 키 차단',
          target: pathname,
          status: 401,
          method: req.method,
          deviceId,
          deviceName,
          origin: safeOrigin,
          authState
        });
        sendJsonResponse(req, res, 401, { error: 'API_KEY_EXPIRED: 사용 기간이 종료된 키입니다.' });
        return { handled: true, context: null };
      } else if (auth.reason === 'API_KEY_REVOKED') {
        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '폐기된 API 키 차단',
          target: pathname,
          status: 401,
          method: req.method,
          deviceId,
          deviceName,
          origin: safeOrigin,
          authState
        });
        sendJsonResponse(req, res, 401, { error: 'API_KEY_REVOKED: 폐기된 API 키입니다.' });
        return { handled: true, context: null };
      } else {
        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: 'API 키 인증 실패 차단',
          target: pathname,
          status: 401,
          method: req.method,
          deviceId,
          deviceName,
          origin: safeOrigin,
          authState
        });
        sendJsonResponse(req, res, 401, { error: 'UNAUTHORIZED_API_KEY: 유효한 API 키가 필요합니다.' });
        return { handled: true, context: null };
      }
    }
  } else if (hasAdminSession) {
    isRootAdmin = true;
    targetUserFolder = null;
    authenticatedUserMemo = 'Root Admin (Web Session)';
  } else {
    // 🛡️ 공용 폴더 폴백 차단: ENFORCE_STORAGE_API_KEY 설정 여부와 무관하게 유효한 API 키(또는 관리자 세션) 필수
    auditLogger.recordAccessLog({
      ip: clientIp,
      userAgent,
      action: isEnforceApiKey ? 'API 키 누락 차단' : '공용 폴백 차단 (API 키 필수)',
      target: pathname,
      status: 401,
      method: req.method,
      deviceId,
      deviceName,
      origin: safeOrigin,
      authState
    });
    sendJsonResponse(req, res, 401, { error: 'UNAUTHORIZED_API_KEY: 유효한 API 키가 필요합니다.' });
    return { handled: true, context: null };
  }

  // 🔒 Fail-Closed 불변식 가드: 루트 관리자가 아닌 요청은 반드시 사용자 샌드박스 폴더를 보유해야 함
  if (!isRootAdmin && (!targetUserFolder || typeof targetUserFolder !== 'string' || !targetUserFolder.trim())) {
    auditLogger.recordAccessLog({
      ip: clientIp,
      userAgent,
      action: '🚫 사용자 샌드박스 누락 차단',
      target: pathname,
      status: 403,
      method: req.method,
      deviceId,
      deviceName,
      origin: safeOrigin,
      authState
    });
    sendJsonResponse(req, res, 403, { error: 'USER_SANDBOX_REQUIRED: 사용자 전용 저장소 컨텍스트가 확인되지 않았습니다.' });
    return { handled: true, context: null };
  }

  return {
    handled: false,
    context: {
      env,
      targetUserFolder,
      userQuotaBytes,
      userMaxDevices,
      authenticatedUserMemo,
      isRootAdmin,
      deviceId,
      deviceName,
      safeOrigin,
      authState
    }
  };
}