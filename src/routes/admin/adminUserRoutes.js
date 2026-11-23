/**
 * @file src/routes/admin/adminUserRoutes.js
 * @description 관리자 콘솔 다중 사용자 API 키 및 기기 슬롯 관리(/admin/users/*) 라우터
 * - 👥 [사용자 키 관리] /admin/users/create, /reissue, /update-quota, /update-max-devices, /delete
 * - 📱 [기기 제어 관리] /admin/users/devices/block, /unblock, /delete (AJAX JSON 및 HTML 응답 동시 지원)
 */

import { auditLogger } from '../../auditLogger.js';
import { apiKeyManager } from '../../apiKeyManager.js';
import { renderAdminSettingsHtml } from '../../adminViews.js';

/**
 * 관리자 콘솔의 사용자 API 키 및 기기 관리 요청을 처리합니다.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @param {string} clientIp
 * @param {string} userAgent
 * @param {{ isAdminAuthenticated?: boolean }} [options={}]
 * @returns {Promise<boolean>} 라우트 처리 여부
 */
export async function handleAdminUserRoute(req, res, pathname, clientIp, userAgent, { isAdminAuthenticated = false } = {}) {
  // 1) [새 사용자 키 발급] POST /admin/users/create
  if (req.method === 'POST' && pathname === '/admin/users/create') {
    if (!isAdminAuthenticated) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return true;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const memo = params.get('memo')?.trim() || '새 사용자';
        const quotaMb = parseInt(params.get('quotaMb') || '1024', 10);
        const maxDevices = parseInt(params.get('maxDevices') || '6', 10);

        const result = apiKeyManager.issueApiKey({ memo, quotaMb, maxDevices, role: 'user' });
        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '👥 새 사용자 키 발급',
          target: `${memo} (${result.folderName}, 기기한도: ${result.maxDevices}대)`,
          status: 200,
          user: `${memo} (${result.folderName})`
        });

        const html = renderAdminSettingsHtml(req, '새 사용자 API 키가 발급되었습니다!', null, {
          type: 'CREATE',
          apiKey: result.apiKey,
          folderName: result.folderName,
          memo: result.memo,
          expiresAt: result.expiresAt
        });

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        const html = renderAdminSettingsHtml(req, null, '사용자 키 발급 실패: ' + err.message);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      }
    });
    return true;
  }

  // 2) [사용자 키 재발급] POST /admin/users/reissue
  if (req.method === 'POST' && pathname === '/admin/users/reissue') {
    if (!isAdminAuthenticated) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return true;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const folderName = params.get('folderName')?.trim() || '';

        const result = apiKeyManager.reissueApiKey(folderName);
        if (!result.success) {
          throw new Error(result.error || '재발급 실패');
        }

        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '🔄 사용자 키 재발급',
          target: `${result.memo} (${folderName})`,
          status: 200,
          user: `${result.memo} (${folderName})`
        });

        const html = renderAdminSettingsHtml(req, `'${result.memo}' 사용자의 새 API 키가 발급되었습니다. (기존 책/기기 100% 보존)`, null, {
          type: 'REISSUE',
          apiKey: result.newApiKey,
          folderName: result.folderName,
          memo: result.memo,
          expiresAt: result.expiresAt
        });

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        const html = renderAdminSettingsHtml(req, null, '키 재발급 실패: ' + err.message);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      }
    });
    return true;
  }

  // 3) [사용자 도서 저장 용량 변경] POST /admin/users/update-quota
  if (req.method === 'POST' && pathname === '/admin/users/update-quota') {
    if (!isAdminAuthenticated) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return true;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const folderName = params.get('folderName')?.trim() || '';
        const quotaMb = parseInt(params.get('quotaMb') || '1024', 10);

        const result = apiKeyManager.updateUserQuota(folderName, quotaMb);
        if (!result.success) {
          throw new Error(result.error || '용량 변경 실패');
        }

        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '⚙️ 서재 용량 변경',
          target: `${result.memo} ➔ ${result.quotaMb}MB`,
          status: 200,
          user: `${result.memo} (${folderName})`
        });

        const html = renderAdminSettingsHtml(req, `'${result.memo}' (${folderName}) 서재의 저장 용량이 ${result.quotaMb}MB로 변경되었습니다.`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        const html = renderAdminSettingsHtml(req, null, '용량 변경 실패: ' + err.message);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      }
    });
    return true;
  }

  // 4) [사용자 최대 기기 한도 변경] POST /admin/users/update-max-devices
  if (req.method === 'POST' && pathname === '/admin/users/update-max-devices') {
    const isAjax = req.headers['accept']?.includes('application/json') || req.headers['x-requested-with'] === 'XMLHttpRequest';

    if (!isAdminAuthenticated) {
      if (isAjax) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
      } else {
        res.writeHead(302, { Location: '/admin' });
        res.end();
      }
      return true;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const folderName = params.get('folderName')?.trim() || '';
        const maxDevices = parseInt(params.get('maxDevices') || '6', 10);

        const result = apiKeyManager.updateUserMaxDevices(folderName, maxDevices);
        if (!result.success) {
          throw new Error(result.error || '기기 한도 변경 실패');
        }

        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '📱 기기 한도 변경',
          target: `${result.memo} ➔ 최대 ${result.maxDevices}대`,
          status: 200,
          user: `${result.memo} (${folderName})`
        });

        if (isAjax) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, maxDevices: result.maxDevices }));
        } else {
          const html = renderAdminSettingsHtml(req, `'${result.memo}' (${folderName}) 사용자의 최대 기기 한도가 ${result.maxDevices}대로 변경되었습니다.`);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      } catch (err) {
        if (isAjax) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        } else {
          const html = renderAdminSettingsHtml(req, null, '기기 한도 변경 실패: ' + err.message);
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      }
    });
    return true;
  }

  // 5) [특정 기기 차단 (Ban)] POST /admin/users/devices/block
  if (req.method === 'POST' && pathname === '/admin/users/devices/block') {
    const isAjax = req.headers['accept']?.includes('application/json') || req.headers['x-requested-with'] === 'XMLHttpRequest';

    if (!isAdminAuthenticated) {
      if (isAjax) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
      } else {
        res.writeHead(302, { Location: '/admin' });
        res.end();
      }
      return true;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const folderName = params.get('folderName')?.trim() || '';
        const deviceId = params.get('deviceId')?.trim() || '';

        const result = apiKeyManager.blockDevice(folderName, deviceId);
        if (!result.success) {
          throw new Error(result.error || '기기 차단 실패');
        }

        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '🚫 기기 차단 (Ban)',
          target: `${result.device?.deviceName || deviceId} (${folderName})`,
          status: 200,
          user: 'Root Admin'
        });

        if (isAjax) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, device: result.device }));
        } else {
          const html = renderAdminSettingsHtml(req, `기기('${result.device?.deviceName || deviceId}')가 성공적으로 차단되었습니다.`);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      } catch (err) {
        if (isAjax) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        } else {
          const html = renderAdminSettingsHtml(req, null, '기기 차단 실패: ' + err.message);
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      }
    });
    return true;
  }

  // 6) [특정 기기 차단 해제 (Unban)] POST /admin/users/devices/unblock
  if (req.method === 'POST' && pathname === '/admin/users/devices/unblock') {
    const isAjax = req.headers['accept']?.includes('application/json') || req.headers['x-requested-with'] === 'XMLHttpRequest';

    if (!isAdminAuthenticated) {
      if (isAjax) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
      } else {
        res.writeHead(302, { Location: '/admin' });
        res.end();
      }
      return true;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const folderName = params.get('folderName')?.trim() || '';
        const deviceId = params.get('deviceId')?.trim() || '';

        const result = apiKeyManager.unblockDevice(folderName, deviceId);
        if (!result.success) {
          throw new Error(result.error || '기기 차단 해제 실패');
        }

        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '🟢 기기 차단 해제 (Unban)',
          target: `${result.device?.deviceName || deviceId} (${folderName})`,
          status: 200,
          user: 'Root Admin'
        });

        if (isAjax) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, device: result.device }));
        } else {
          const html = renderAdminSettingsHtml(req, `기기('${result.device?.deviceName || deviceId}')의 차단이 해제되었습니다.`);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      } catch (err) {
        if (isAjax) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        } else {
          const html = renderAdminSettingsHtml(req, null, '기기 차단 해제 실패: ' + err.message);
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      }
    });
    return true;
  }

  // 7) [특정 기기 삭제 (슬롯 반환)] POST /admin/users/devices/delete
  if (req.method === 'POST' && pathname === '/admin/users/devices/delete') {
    const isAjax = req.headers['accept']?.includes('application/json') || req.headers['x-requested-with'] === 'XMLHttpRequest';

    if (!isAdminAuthenticated) {
      if (isAjax) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
      } else {
        res.writeHead(302, { Location: '/admin' });
        res.end();
      }
      return true;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const folderName = params.get('folderName')?.trim() || '';
        const deviceId = params.get('deviceId')?.trim() || '';

        const result = apiKeyManager.deleteDevice(folderName, deviceId);
        if (!result.success) {
          throw new Error(result.error || '기기 삭제 실패');
        }

        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '🗑️ 등록 기기 삭제 (슬롯 반환)',
          target: `${deviceId} (${folderName})`,
          status: 200,
          user: 'Root Admin'
        });

        if (isAjax) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, deletedDeviceId: deviceId }));
        } else {
          const html = renderAdminSettingsHtml(req, `기기가 등록 목록에서 삭제되어 슬롯이 확보되었습니다.`);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      } catch (err) {
        if (isAjax) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        } else {
          const html = renderAdminSettingsHtml(req, null, '기기 삭제 실패: ' + err.message);
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        }
      }
    });
    return true;
  }

  // 8) [사용자 삭제] POST /admin/users/delete
  if (req.method === 'POST' && pathname === '/admin/users/delete') {
    if (!isAdminAuthenticated) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return true;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const folderName = params.get('folderName')?.trim() || '';
        const deleteFolder = params.get('deleteFolder') === 'true';

        const result = apiKeyManager.revokeApiKey(folderName, deleteFolder);
        if (!result.success) {
          throw new Error(result.error || '삭제 실패');
        }

        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: deleteFolder ? '🗑️ 사용자 및 도서 완전 삭제' : '🔒 사용자 API 키 폐기',
          target: folderName,
          status: 200,
          user: folderName
        });

        const successMsg = deleteFolder
          ? `'${folderName}' 사용자의 API 키와 도서 폴더가 영구 삭제되었습니다.`
          : `'${folderName}' 사용자의 API 키가 폐기되었습니다. (도서 폴더 보존)`;

        const html = renderAdminSettingsHtml(req, successMsg);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        const html = renderAdminSettingsHtml(req, null, '사용자 삭제 실패: ' + err.message);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      }
    });
    return true;
  }

  return false;
}