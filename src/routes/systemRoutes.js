/**
 * @file src/routes/systemRoutes.js
 * @description 시스템 헬스체크, 자원 관제 및 Discord 웹훅 라우터
 * - 🩺 [서버 헬스체크 & 최소 노출 검증] GET /api/health Rate Limit 적용, ENABLE_ROOT_API_KEY 스위치 기반 Root 키 제어, needsDeviceRegistration 및 remoteLibraryAccessible 플래그 제공
 * - 📊 [실시간 자원 사용량] GET /api/admin/system-stats CPU(1분 평균), RAM, DISK 점유율 반환 (관리자 세션 필수)
 * - 🔔 [Discord 웹훅 마스킹 조회·안전 저장] GET/POST /api/admin/discord-webhook 웹훅 URL 마스킹 반환, 마스킹 값 전송 시 기존 URL 보존 및 6대 필터 전체 해제('NONE') 지원
 * - 🧪 [고도화된 테스트 연계] POST action: "test" 시 마스킹 URL 자동 복원 및 실시간 체크된 alertTypes, dailyDigest를 디스코드 카드로 전송
 */

import { hasRefreshToken } from '../../tokenStore.js';
import { apiKeyManager } from '../apiKeyManager.js';
import { auditLogger } from '../auditLogger.js';
import { readEnvFile, writeEnvFile, maskSecretValue, isMaskedSecretValue } from '../envManager.js';
import { systemMonitor } from '../systemMonitor.js';
import { isAuthenticated } from '../adminController.js';
import { checkRemoteLibraryAccessible } from '../services/storage/remoteLibraryEngine.js';
import {
  extractApiKey,
  extractDeviceInfo,
  checkRateLimit,
  safeCompareSecret,
  sendJsonResponse,
  readRequestBodyBuffer
} from '../httpUtils.js';

/**
 * 시스템 관련 HTTP 요청을 처리합니다.
 * @param {import('http').IncomingMessage} req 
 * @param {import('http').ServerResponse} res 
 * @param {string} pathname 
 * @param {URL} reqUrl 
 * @param {string} clientIp 
 * @param {string} userAgent 
 * @returns {Promise<boolean>} 라우트 처리 여부
 */
export async function handleSystemRoute(req, res, pathname, reqUrl, clientIp, userAgent) {
  // 1. 서버 헬스체크 및 경량 API 키·기기 토큰 검증
  if (req.method === 'GET' && pathname === '/api/health') {
    if (!checkRateLimit(req, 120)) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '헬스체크 요청 초과 차단', target: pathname, status: 429 });
      sendJsonResponse(req, res, 429, { error: 'RATE_LIMIT_EXCEEDED: 요청 횟수가 초과되었습니다. 잠시 후 다시 시도해 주세요.' });
      return true;
    }

    const env = readEnvFile();
    const providedApiKey = extractApiKey(req, reqUrl);
    const { deviceId, deviceName, deviceToken } = extractDeviceInfo(req, reqUrl);
    const hasAdminSession = isAuthenticated(req);
    const isRootApiKeyEnabled = env.ENABLE_ROOT_API_KEY === 'true';
    const rootMasterKey = env.STORAGE_API_KEY?.trim();

    let isAuthorizedHealth = false;
    let isRootHealth = false;
    let apiKeyValid = null;
    let authReason = null;
    let deviceAuthorized = null;
    let deviceReason = null;
    let needsDeviceRegistration = false;
    let userRole = null;

    if (providedApiKey !== null) {
      if (!providedApiKey) {
        apiKeyValid = false;
        authReason = 'API_KEY_EMPTY';
      } else if (isRootApiKeyEnabled && rootMasterKey && safeCompareSecret(providedApiKey, rootMasterKey)) {
        isAuthorizedHealth = true;
        isRootHealth = true;
        apiKeyValid = true;
        authReason = 'ROOT_KEY';
        deviceAuthorized = true;
        userRole = 'root';
        auditLogger.recordApiKeyUsage({ ip: clientIp, userAgent, path: pathname, method: req.method, userMemo: 'Root Admin' });
      } else {
        // /api/health 조회만으로는 PENDING 키를 ACTIVE로 전이하지 않음
        const auth = apiKeyManager.authenticateApiKey(providedApiKey, { activatePending: false });
        if (auth.authenticated && auth.user) {
          apiKeyValid = true;
          authReason = 'VALID';

          const deviceResult = apiKeyManager.verifyAndTouchDevice(auth.user.folderName, {
            deviceId,
            deviceName,
            deviceToken,
            clientIp
          });
          deviceAuthorized = Boolean(deviceResult.allowed);
          deviceReason = deviceResult.allowed ? null : (deviceResult.reason || 'DEVICE_UNAUTHORIZED');

          // 등록 기기 0대이거나 재발급 직후라 마스터 등록이 필요한 상태임을 명시 전달
          if (deviceResult.reason === 'MASTER_DEVICE_REGISTRATION_REQUIRED') {
            needsDeviceRegistration = true;
          }

          if (deviceResult.allowed) {
            isAuthorizedHealth = true;
            userRole = auth.user.role || 'user';
            auditLogger.recordApiKeyUsage({ ip: clientIp, userAgent, path: pathname, method: req.method, userMemo: auth.user.memo });
          }
        } else {
          apiKeyValid = false;
          authReason = auth.reason || 'API_KEY_NOT_FOUND';
        }
      }
    } else if (hasAdminSession) {
      isAuthorizedHealth = true;
      isRootHealth = true;
      apiKeyValid = true;
      authReason = 'ADMIN_SESSION';
      deviceAuthorized = true;
      userRole = 'admin';
    }

    const remoteLibraryAccessible = (isAuthorizedHealth && env.STORAGE_MODE === 'true')
      ? checkRemoteLibraryAccessible(env, { isRootAdmin: isRootHealth, deviceId })
      : null;

    sendJsonResponse(req, res, 200, {
      ok: true,
      service: 'gdrive-refresh-server',
      hasToken: hasRefreshToken(),
      storageMode: env.STORAGE_MODE === 'true',
      multiUserReady: true,
      sharedBooksDir: isAuthorizedHealth ? (env.SHARED_BOOKS_DIR || null) : null,
      remoteLibraryAccessible,
      hasStorageApiKey: Boolean(isRootApiKeyEnabled && rootMasterKey),
      rootApiKeyEnabled: isRootApiKeyEnabled,
      enforceApiKey: env.ENFORCE_STORAGE_API_KEY === 'true',
      apiKeyValid,
      authReason,
      deviceAuthorized,
      deviceReason,
      needsDeviceRegistration,
      userRole: isAuthorizedHealth ? userRole : null,
      timestamp: new Date().toISOString()
    });
    return true;
  }

  // 2. 실시간 시스템 자원 사용량 (가로 게이지 바용 - 관리자 세션 필수)
  if (req.method === 'GET' && pathname === '/api/admin/system-stats') {
    if (!isAuthenticated(req)) {
      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '🔒 관리자 세션 만료/미인증 조회',
        target: pathname,
        status: 401,
        alertMinCount: 2,
        alertWindowMs: 60000
      });
      sendJsonResponse(req, res, 401, { error: 'UNAUTHORIZED: 관리자 로그인이 필요합니다.' });
      return true;
    }

    const stats = systemMonitor.getSystemStats();
    sendJsonResponse(req, res, 200, { ok: true, stats });
    return true;
  }

  // 3. Discord 웹훅 URL 및 세부 알림 필터 조회, 저장 및 테스트 발송 (관리자 세션 필수)
  if (pathname === '/api/admin/discord-webhook') {
    if (!isAuthenticated(req)) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '🚫 미인증 웹훅 설정 접근 차단', target: pathname, status: 401 });
      sendJsonResponse(req, res, 401, { error: 'UNAUTHORIZED: 관리자 로그인이 필요합니다.' });
      return true;
    }

    if (req.method === 'GET') {
      const env = readEnvFile();
      const rawWebhookUrl = env.DISCORD_WEBHOOK_URL || '';
      sendJsonResponse(req, res, 200, {
        ok: true,
        webhookUrl: maskSecretValue(rawWebhookUrl),
        hasWebhook: Boolean(rawWebhookUrl),
        alertTypes: env.DISCORD_ALERT_TYPES || '500,RESOURCE',
        dailyDigest: env.DISCORD_DAILY_DIGEST === 'true'
      });
      return true;
    }

    if (req.method === 'POST') {
      try {
        const buffer = await readRequestBodyBuffer(req, 1024 * 64);
        const payload = JSON.parse(buffer.toString('utf-8') || '{}');
        const { webhookUrl, action, alertTypes, dailyDigest } = payload;

        if (action === 'test') {
          const env = readEnvFile();
          const rawInputUrl = typeof webhookUrl === 'string' ? webhookUrl.trim() : '';
          const targetWebhookUrl = isMaskedSecretValue(rawInputUrl)
            ? (env.DISCORD_WEBHOOK_URL || '').trim()
            : rawInputUrl;

          const targetAlertTypes = alertTypes !== undefined ? alertTypes : (env.DISCORD_ALERT_TYPES || '500,RESOURCE');
          const targetDailyDigest = dailyDigest !== undefined ? dailyDigest : (env.DISCORD_DAILY_DIGEST === 'true');

          const testResult = await systemMonitor.testDiscordWebhook(targetWebhookUrl, {
            alertTypes: targetAlertTypes,
            dailyDigest: targetDailyDigest
          });
          sendJsonResponse(req, res, testResult.ok ? 200 : 400, testResult);
          return true;
        }

        if (action === 'save') {
          const env = readEnvFile();
          const rawInputUrl = typeof webhookUrl === 'string' ? webhookUrl.trim() : '';
          let cleanUrl = rawInputUrl;

          if (isMaskedSecretValue(rawInputUrl)) {
            cleanUrl = (env.DISCORD_WEBHOOK_URL || '').trim();
          } else if (rawInputUrl !== '' && !rawInputUrl.startsWith('https://discord.com/api/webhooks/')) {
            sendJsonResponse(req, res, 400, {
              ok: false,
              error: '올바른 Discord 웹훅 URL 형식이 아닙니다. (https://discord.com/api/webhooks/...)'
            });
            return true;
          }

          let cleanAlertTypes = 'NONE';
          if (Array.isArray(alertTypes)) {
            const filtered = alertTypes.map(s => String(s).trim()).filter(Boolean);
            cleanAlertTypes = filtered.length > 0 ? filtered.join(',') : 'NONE';
          } else if (typeof alertTypes === 'string') {
            const trimmedTypes = alertTypes.trim();
            cleanAlertTypes = trimmedTypes ? trimmedTypes : 'NONE';
          } else {
            cleanAlertTypes = env.DISCORD_ALERT_TYPES || '500,RESOURCE';
          }

          const isDailyDigest = dailyDigest === true || dailyDigest === 'true';

          writeEnvFile({
            DISCORD_WEBHOOK_URL: cleanUrl,
            DISCORD_ALERT_TYPES: cleanAlertTypes,
            DISCORD_DAILY_DIGEST: isDailyDigest ? 'true' : 'false'
          });

          auditLogger.recordAccessLog({
            ip: clientIp,
            userAgent,
            action: '⚙️ 디스코드 관제 설정 저장',
            target: cleanUrl ? `알림 필터(${cleanAlertTypes}), 정기보고(${isDailyDigest})` : '웹훅 제거',
            status: 200,
            user: 'Root Admin'
          });

          sendJsonResponse(req, res, 200, {
            ok: true,
            message: cleanUrl ? 'Discord 관제 알림 설정이 저장되었습니다.' : 'Discord 웹훅이 제거되었습니다.',
            webhookUrl: maskSecretValue(cleanUrl),
            hasWebhook: Boolean(cleanUrl),
            alertTypes: cleanAlertTypes,
            dailyDigest: isDailyDigest
          });
          return true;
        }

        sendJsonResponse(req, res, 400, { error: '잘못된 액션 요청입니다.' });
        return true;
      } catch (err) {
        sendJsonResponse(req, res, 500, { error: err.message });
        return true;
      }
    }
  }

  return false;
}