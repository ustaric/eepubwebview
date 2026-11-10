/**
 * @file src/routes/systemRoutes.js
 * @description 시스템 헬스체크, 자원 관제 및 Discord 웹훅 라우터
 * - 🩺 [서버 헬스체크] GET /api/health 스토리지 상태, 토큰 보유 및 API 키 검증
 * - 📊 [실시간 자원 사용량] GET /api/admin/system-stats CPU(1분 평균), RAM, DISK 점유율 반환
 * - 🔔 [Discord 웹훅 설정] POST /api/admin/discord-webhook 웹훅 URL 저장 및 즉시 테스트 발송
 */

import { hasRefreshToken } from '../../tokenStore.js';
import { apiKeyManager } from '../apiKeyManager.js';
import { auditLogger } from '../auditLogger.js';
import { readEnvFile, writeEnvFile } from '../envManager.js';
import { systemMonitor } from '../systemMonitor.js';
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

    if (providedApiKey) {
      const rootMasterKey = env.STORAGE_API_KEY?.trim();
      if (rootMasterKey && providedApiKey === rootMasterKey) {
        auditLogger.recordApiKeyUsage({ ip: clientIp, userAgent, path: pathname, method: req.method, userMemo: 'Root Admin' });
      } else {
        const auth = apiKeyManager.authenticateApiKey(providedApiKey);
        if (auth.authenticated && auth.user) {
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
      sharedBooksDir: env.SHARED_BOOKS_DIR || null,
      hasStorageApiKey: Boolean(env.STORAGE_API_KEY),
      enforceApiKey: env.ENFORCE_STORAGE_API_KEY === 'true',
      timestamp: new Date().toISOString()
    });
    return true;
  }

  // 2. 실시간 시스템 자원 사용량 (가로 게이지 바용)
  if (req.method === 'GET' && pathname === '/api/admin/system-stats') {
    const stats = systemMonitor.getSystemStats();
    sendJsonResponse(req, res, 200, { ok: true, stats });
    return true;
  }

  // 3. Discord 웹훅 URL 저장 및 테스트 발송
  if (req.method === 'POST' && pathname === '/api/admin/discord-webhook') {
    try {
      const buffer = await readRequestBodyBuffer(req, 1024 * 64);
      const payload = JSON.parse(buffer.toString('utf-8') || '{}');
      const { webhookUrl, action } = payload;

      if (action === 'test') {
        const testResult = await systemMonitor.testDiscordWebhook(webhookUrl);
        sendJsonResponse(req, res, testResult.ok ? 200 : 400, testResult);
        return true;
      }

      if (action === 'save') {
        const env = readEnvFile();
        env.DISCORD_WEBHOOK_URL = (webhookUrl || '').trim();
        writeEnvFile(env);
        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '⚙️ 디스코드 웹훅 설정 저장',
          target: env.DISCORD_WEBHOOK_URL ? '웹훅 등록' : '웹훅 제거',
          status: 200,
          user: 'Root Admin'
        });
        sendJsonResponse(req, res, 200, { ok: true, message: 'Discord 웹훅 설정이 저장되었습니다.' });
        return true;
      }

      sendJsonResponse(req, res, 400, { error: '잘못된 액션 요청입니다.' });
      return true;
    } catch (err) {
      sendJsonResponse(req, res, 500, { error: err.message });
      return true;
    }
  }

  return false;
}