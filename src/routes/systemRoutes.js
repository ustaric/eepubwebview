/**
 * @file src/routes/systemRoutes.js
 * @description 시스템 헬스체크, 자원 관제 및 Discord 웹훅 라우터
 * - 🩺 [서버 헬스체크] GET /api/health 스토리지 상태, 토큰 보유 및 API 키 검증
 * - 📊 [실시간 자원 사용량] GET /api/admin/system-stats CPU(1분 평균), RAM, DISK 점유율 반환 (관리자 세션 필수)
 * - 🔔 [Discord 웹훅 설정 & 조회] GET/POST /api/admin/discord-webhook 웹훅 URL 및 6대 알림 필터, 정기보고 설정 영구 저장 (관리자 세션 필수)
 * - 🧪 [고도화된 테스트 연계] POST action: "test" 시 실시간 체크된 alertTypes, dailyDigest를 수신하여 디스코드 카드로 전송
 */

import { hasRefreshToken } from '../../tokenStore.js';
import { apiKeyManager } from '../apiKeyManager.js';
import { auditLogger } from '../auditLogger.js';
import { readEnvFile, writeEnvFile } from '../envManager.js';
import { systemMonitor } from '../systemMonitor.js';
import { isAuthenticated } from '../adminController.js';
import {
  extractApiKey,
  extractDeviceInfo,
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
  // 1. 서버 헬스체크
  if (req.method === 'GET' && pathname === '/api/health') {
    const env = readEnvFile();
    const providedApiKey = extractApiKey(req, reqUrl);
    const { deviceId, deviceName } = extractDeviceInfo(req, reqUrl);
    let isAuthorizedHealth = isAuthenticated(req);

    if (providedApiKey) {
      const rootMasterKey = env.STORAGE_API_KEY?.trim();
      if (rootMasterKey && providedApiKey === rootMasterKey) {
        isAuthorizedHealth = true;
        auditLogger.recordApiKeyUsage({ ip: clientIp, userAgent, path: pathname, method: req.method, userMemo: 'Root Admin' });
      } else {
        const auth = apiKeyManager.authenticateApiKey(providedApiKey);
        if (auth.authenticated && auth.user) {
          isAuthorizedHealth = true;
          auditLogger.recordApiKeyUsage({ ip: clientIp, userAgent, path: pathname, method: req.method, userMemo: auth.user.memo });
          if (deviceId) {
            apiKeyManager.verifyAndTouchDevice(auth.user.folderName, { deviceId, deviceName, clientIp });
          }
        }
      }
    }

    sendJsonResponse(req, res, 200, {
      ok: true,
      service: 'gdrive-refresh-server',
      hasToken: hasRefreshToken(),
      storageMode: env.STORAGE_MODE === 'true',
      multiUserReady: true,
      sharedBooksDir: isAuthorizedHealth ? (env.SHARED_BOOKS_DIR || null) : null,
      hasStorageApiKey: Boolean(env.STORAGE_API_KEY),
      enforceApiKey: env.ENFORCE_STORAGE_API_KEY === 'true',
      timestamp: new Date().toISOString()
    });
    return true;
  }

  // 2. 실시간 시스템 자원 사용량 (가로 게이지 바용 - 관리자 세션 필수)
  if (req.method === 'GET' && pathname === '/api/admin/system-stats') {
    if (!isAuthenticated(req)) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '🚫 미인증 관리자 자원조회 차단', target: pathname, status: 401 });
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

    // 🌟 [GET] 현재 저장된 웹훅 URL 및 알림 필터 목록, 정기보고 설정 반환
    if (req.method === 'GET') {
      const env = readEnvFile();
      sendJsonResponse(req, res, 200, {
        ok: true,
        webhookUrl: env.DISCORD_WEBHOOK_URL || '',
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

        // 🌟 [테스트 발송] 체크된 6대 항목 및 정기보고 옵션을 systemMonitor로 함께 전달
        if (action === 'test') {
          const env = readEnvFile();
          const targetAlertTypes = alertTypes !== undefined ? alertTypes : (env.DISCORD_ALERT_TYPES || '500,RESOURCE');
          const targetDailyDigest = dailyDigest !== undefined ? dailyDigest : (env.DISCORD_DAILY_DIGEST === 'true');

          const testResult = await systemMonitor.testDiscordWebhook(webhookUrl, {
            alertTypes: targetAlertTypes,
            dailyDigest: targetDailyDigest
          });
          sendJsonResponse(req, res, testResult.ok ? 200 : 400, testResult);
          return true;
        }

        // 🌟 [설정 저장]
        if (action === 'save') {
          const cleanUrl = (webhookUrl || '').trim();

          // alertTypes 정규화 (배열 또는 문자열 대응)
          let cleanAlertTypes = '500,RESOURCE';
          if (Array.isArray(alertTypes)) {
            cleanAlertTypes = alertTypes.join(',');
          } else if (typeof alertTypes === 'string') {
            cleanAlertTypes = alertTypes.trim();
          }

          const isDailyDigest = dailyDigest === true || dailyDigest === 'true';

          // .env 파일에 알림 옵션 3종 영구 저장
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
            webhookUrl: cleanUrl,
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