/**
 * @file src/routes/storage/storageSystemDataRoutes.js
 * @description 자체 스토리지 시스템 데이터·기기 슬롯·크래시 리포트(/api/storage/crash-reports*, /devices*, /settings*) 라우터
 * - 🛑 [크래시 리포트 수신] ENABLE_CRASH_REPORTS=false 시 403 차단 및 JSON 저장
 * - 📱 [등록 기기 관리] GET /api/storage/devices 및 DELETE /api/storage/devices/:id 슬롯 반환
 * - ⚙️ [설정 파일 I/O] GET/POST /api/storage/settings/:fileName 동기화 처리
 */

import { storageService } from '../../storageService.js';
import { auditLogger } from '../../auditLogger.js';
import { apiKeyManager } from '../../apiKeyManager.js';
import {
  sendJsonResponse,
  readRequestBodyBuffer
} from '../../httpUtils.js';

/**
 * 크래시 리포트, 기기 관리 및 설정 파일 관련 HTTP 요청을 처리합니다.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @param {string} clientIp
 * @param {string} userAgent
 * @param {Object} context - storageAuthGuard에서 검증된 인증 컨텍스트
 * @returns {Promise<boolean>} 라우트 처리 여부
 */
export async function handleStorageSystemDataRoute(req, res, pathname, clientIp, userAgent, context) {
  const {
    env,
    targetUserFolder,
    userMaxDevices,
    authenticatedUserMemo
  } = context;

  // 4. 크래시 리포트 수신 (거버넌스 가드: ENABLE_CRASH_REPORTS=false 시 안전 차단)
  if (req.method === 'POST' && pathname.startsWith('/api/storage/crash-reports/')) {
    if (env.ENABLE_CRASH_REPORTS === 'false') {
      sendJsonResponse(req, res, 403, { error: 'CRASH_REPORTS_DISABLED: 크래시 리포트 수신이 비활성화되어 있습니다.' });
      return true;
    }

    const fileName = decodeURIComponent(pathname.replace('/api/storage/crash-reports/', ''));
    try {
      const buffer = await readRequestBodyBuffer(req, 5 * 1024 * 1024);
      const reportData = JSON.parse(buffer.toString('utf-8'));
      storageService.saveCrashReport(fileName, reportData);

      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '크래시 리포트 수신',
        target: fileName,
        status: 200,
        user: authenticatedUserMemo
      });
      sendJsonResponse(req, res, 200, { ok: true, fileName, status: 'saved' });
      return true;
    } catch (err) {
      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '크래시 리포트 저장 실패',
        target: fileName,
        status: 500,
        user: authenticatedUserMemo
      });
      sendJsonResponse(req, res, 500, { error: err.message });
      return true;
    }
  }

  // 5. 등록된 기기 목록 조회 (GET /api/storage/devices)
  if (req.method === 'GET' && pathname === '/api/storage/devices') {
    const devices = targetUserFolder ? apiKeyManager.getUserDevices(targetUserFolder) : [];
    sendJsonResponse(req, res, 200, {
      ok: true,
      maxDevices: userMaxDevices,
      totalDevices: devices.length,
      devices
    });
    return true;
  }

  // 6. 안 쓰는 기기 슬롯 삭제 및 반환 (DELETE /api/storage/devices/:deviceId)
  if (req.method === 'DELETE' && pathname.startsWith('/api/storage/devices/')) {
    const targetDeviceId = decodeURIComponent(pathname.replace('/api/storage/devices/', ''));
    if (!targetUserFolder) {
      sendJsonResponse(req, res, 400, { error: '루트 관리자 계정은 기기 관리가 지원되지 않습니다.' });
      return true;
    }

    const deleteResult = apiKeyManager.deleteDevice(targetUserFolder, targetDeviceId);
    if (!deleteResult.success) {
      sendJsonResponse(req, res, 400, { error: deleteResult.error || '기기 삭제에 실패했습니다.' });
      return true;
    }

    auditLogger.recordAccessLog({
      ip: clientIp,
      userAgent,
      action: '📱 기기 슬롯 반환(삭제)',
      target: targetDeviceId,
      status: 200,
      user: authenticatedUserMemo
    });

    sendJsonResponse(req, res, 200, { ok: true, message: '기기가 성공적으로 삭제되었습니다.', deviceId: targetDeviceId });
    return true;
  }

  // 15. 시스템 및 동기화 설정 파일 관리 (/api/storage/settings/:fileName)
  if (pathname.startsWith('/api/storage/settings/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/settings/', ''));

    if (req.method === 'POST') {
      try {
        const buffer = await readRequestBodyBuffer(req, 5 * 1024 * 1024);
        const data = JSON.parse(buffer.toString('utf-8'));
        storageService.saveSettingsFile(fileName, data, targetUserFolder);
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '⚙️ 시스템 데이터 동기화', target: `${fileName} (${targetUserFolder || 'root'})`, status: 200, user: authenticatedUserMemo });
        sendJsonResponse(req, res, 200, { ok: true, fileName });
        return true;
      } catch (err) {
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '시스템 동기화 실패', target: fileName, status: 500, user: authenticatedUserMemo });
        sendJsonResponse(req, res, 500, { error: err.message });
        return true;
      }
    }

    if (req.method === 'GET') {
      const data = storageService.getSettingsFile(fileName, targetUserFolder);
      if (!data) {
        sendJsonResponse(req, res, 404, { error: '설정 파일을 찾을 수 없습니다.' });
        return true;
      }
      sendJsonResponse(req, res, 200, data);
      return true;
    }
  }

  return false;
}