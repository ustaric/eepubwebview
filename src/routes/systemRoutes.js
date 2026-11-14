/**
 * @file src/routes/storageRoutes.js
 * @description 자체 스토리지 모드(/api/storage/*) REST API 및 보안 가드 전담 라우터
 * - 🔑 [지능형 관리자 쿠키 & 듀얼 API 키 검증] 관리자 웹 세션(admin_session) 및 Root/User API 키 완벽 동시 지원
 * - 🚫 [미등록/삭제 기기 403 즉시 차단] 장부에서 삭제된 기기의 임의 재접속 원천 거부 및 6자리 번호 재로그인 요구
 * - 📱 [등록 기기 관리 REST API 탑재] GET /api/storage/devices 및 DELETE /api/storage/devices/:id 슬롯 반환
 * - 🖼️ [표지 이미지 books/ 직통 매칭] /covers/ 및 /books/*.webp 요청 시 books/ 폴더 내 실물 WebP 표지 100% 반환
 * - 🚦 [용량 초과 사전 차단 & 동기화 여유 한도] Content-Length 할당량 초과 시 413 거부 및 분당 600회 대량 동기화 허용
 * - 📂 [다중 공유 라이브러리 & 기기별 폴더 칩 권한] shared_folders.json 기반 On/Off 스위치, 다중 폴더, 스키마 검증 및 기기별 Stealth 권한 필터링 완비
 * - ⚡ [하위 폴더 깊은 경로 복사 지원] 2024년/05월/15일/책이름.epub 형태의 경로 정규화 및 안전한 0초 복사(/import) 지원
 * - 📖 [도서 메타 & EPUB 바이너리] 스트리밍 송수신, 무손실 파쇄 및 IndexedDB 캐싱 완비
 */

import fs from 'fs';
import path from 'path';
import { storageService } from '../storageService.js';
import { auditLogger } from '../auditLogger.js';
import { apiKeyManager } from '../apiKeyManager.js';
import { readEnvFile } from '../envManager.js';
import { isAuthenticated } from '../adminController.js';
import {
  extractApiKey,
  extractDeviceInfo,
  isAllowedClientOrigin,
  checkRateLimit,
  setCorsHeaders,
  sendJsonResponse,
  readRequestBodyBuffer
} from '../httpUtils.js';

// 📁 다중 공유 폴더 설정 저장 파일 경로
const SHARED_FOLDERS_CONFIG_FILE = './data/shared_folders.json';

/**
 * 📂 다중 공유 폴더 설정 안전 조회 헬퍼 (하위 호환성 100% 보장)
 * @param {Object} env 
 * @returns {{ enabled: boolean, folders: Array<{ id: string, name: string, path: string, enabled: boolean, allowedDevices: string[] }> }}
 */
function getSharedFoldersConfig(env) {
  let config = { enabled: true, folders: [] };

  if (fs.existsSync(SHARED_FOLDERS_CONFIG_FILE)) {
    try {
      const raw = fs.readFileSync(SHARED_FOLDERS_CONFIG_FILE, 'utf-8');
      config = JSON.parse(raw);
    } catch (e) {
      console.warn('⚠️ [StorageRoutes] shared_folders.json 파싱 실패 (기본값 복구):', e.message);
    }
  }

  // 기존 .env의 SHARED_BOOKS_DIR가 있고 폴더 목록이 비어있다면 자동 1개 등록 (마이그레이션)
  const legacyDir = env.SHARED_BOOKS_DIR;
  if (config.folders.length === 0 && legacyDir && fs.existsSync(legacyDir)) {
    config.folders.push({
      id: 'default',
      name: '기본 공유 서재',
      path: legacyDir,
      enabled: true,
      allowedDevices: ['*'] // '*' = 전체 기기 허용
    });
    saveSharedFoldersConfig(config);
  }

  return config;
}

/**
 * 💾 다중 공유 폴더 설정 안전 저장 헬퍼
 * @param {Object} config 
 */
function saveSharedFoldersConfig(config) {
  try {
    const dir = path.dirname(SHARED_FOLDERS_CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SHARED_FOLDERS_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) {
    console.error('❌ [StorageRoutes] shared_folders.json 저장 실패:', e.message);
  }
}

export async function handleStorageRoute(req, res, pathname, reqUrl, clientIp, userAgent) {
  if (!pathname.startsWith('/api/storage/')) {
    return false;
  }

  // 1. 스토리지 API 요청 횟수 제한 (1분 600회: 대량 마이그레이션 및 표지·메타 일괄 동기화 허용)
  if (!checkRateLimit(req, 600)) {
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '요청 횟수 초과 차단', target: pathname, status: 429 });
    sendJsonResponse(req, res, 429, { error: 'RATE_LIMIT_EXCEEDED: 요청 횟수가 초과되었습니다. 잠시 후 다시 시도해 주세요.' });
    return true;
  }

  // 2. STORAGE_MODE 활성화 여부 검증
  const env = readEnvFile();
  if (env.STORAGE_MODE !== 'true') {
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '스토리지 모드 비활성 거절', target: pathname, status: 403 });
    sendJsonResponse(req, res, 403, { error: 'STORAGE_MODE_DISABLED: 개인 서버 저장소 모드가 비활성화되어 있습니다.' });
    return true;
  }

  // 3. 관리자 쿠키 세션 & API 키 인증 및 사용자/기기 화이트리스트 가드
  let targetUserFolder = null;
  let userQuotaBytes = 1073741824;
  let authenticatedUserMemo = 'Root Admin';
  let isRootAdmin = false;

  const rootMasterKey = env.STORAGE_API_KEY?.trim();
  const isEnforceApiKey = env.ENFORCE_STORAGE_API_KEY === 'true';
  const providedApiKey = extractApiKey(req, reqUrl);
  const { deviceId, deviceName } = extractDeviceInfo(req, reqUrl);

  // 🌟 [핵심 개선] 관리자 웹 제어 센터 세션 쿠키가 유효한 경우 즉시 Root Admin 권한 부여!
  if (isAuthenticated(req)) {
    isRootAdmin = true;
    targetUserFolder = null;
    authenticatedUserMemo = 'Root Admin (Web Session)';
  } else if (rootMasterKey && providedApiKey && providedApiKey === rootMasterKey) {
    targetUserFolder = null;
    authenticatedUserMemo = 'Root Admin';
    isRootAdmin = true;
    auditLogger.recordApiKeyUsage({ ip: clientIp, userAgent, path: pathname, method: req.method, userMemo: 'Root Admin' });
  } else if (providedApiKey) {
    const auth = apiKeyManager.authenticateApiKey(providedApiKey);
    if (auth.authenticated && auth.user) {
      targetUserFolder = auth.user.folderName;
      userQuotaBytes = auth.user.storageQuotaBytes || (1024 * 1024 * 1024);
      authenticatedUserMemo = `${auth.user.memo} (${auth.user.folderName})`;

      if (deviceId) {
        const deviceResult = apiKeyManager.verifyAndTouchDevice(auth.user.folderName, { deviceId, deviceName, clientIp });

        if (!deviceResult.allowed && deviceResult.reason === 'DEVICE_BLOCKED') {
          auditLogger.recordAccessLog({
            ip: clientIp,
            userAgent,
            action: '🚫 차단된 기기 접근 차단',
            target: `${deviceName || deviceId} (${auth.user.memo})`,
            status: 403,
            user: authenticatedUserMemo
          });
          sendJsonResponse(req, res, 403, { error: 'DEVICE_BLOCKED: 관리자에 의해 차단된 기기입니다.', deviceId });
          return true;
        }

        if (!deviceResult.allowed && deviceResult.reason === 'DEVICE_LIMIT_EXCEEDED') {
          auditLogger.recordAccessLog({
            ip: clientIp,
            userAgent,
            action: '🚫 기기 등록 한도 초과',
            target: `${deviceName || deviceId} (${deviceResult.maxDevices || 6}대 한도 초과)`,
            status: 403,
            user: authenticatedUserMemo
          });
          sendJsonResponse(req, res, 403, {
            error: `DEVICE_LIMIT_EXCEEDED: 허용된 최대 등록 기기 수(${deviceResult.maxDevices || 6}대)를 초과했습니다.`,
            maxDevices: deviceResult.maxDevices || 6
          });
          return true;
        }

        if (!deviceResult.allowed && deviceResult.reason === 'DEVICE_UNREGISTERED') {
          auditLogger.recordAccessLog({
            ip: clientIp,
            userAgent,
            action: '🚫 미등록/삭제된 기기 차단',
            target: `${deviceName || deviceId} (${auth.user.memo})`,
            status: 403,
            user: authenticatedUserMemo
          });
          sendJsonResponse(req, res, 403, {
            error: 'DEVICE_UNREGISTERED: 등록되지 않았거나 삭제된 기기입니다. 6자리 번호로 다시 로그인해 주세요.',
            deviceId
          });
          return true;
        }
      }

      auditLogger.recordApiKeyUsage({ ip: clientIp, userAgent, path: pathname, method: req.method, userMemo: auth.user.memo });
    } else if (auth.reason === 'API_KEY_EXPIRED') {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '만료된 API 키 차단', target: pathname, status: 401 });
      sendJsonResponse(req, res, 401, { error: 'API_KEY_EXPIRED: 사용 기간이 종료된 키입니다.' });
      return true;
    } else if (auth.reason === 'API_KEY_REVOKED') {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '폐기된 API 키 차단', target: pathname, status: 401 });
      sendJsonResponse(req, res, 401, { error: 'API_KEY_REVOKED: 폐기된 API 키입니다.' });
      return true;
    } else if (isEnforceApiKey) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'API 키 인증 실패 차단', target: pathname, status: 401 });
      sendJsonResponse(req, res, 401, { error: 'UNAUTHORIZED_API_KEY: 유효한 API 키가 필요합니다.' });
      return true;
    } else if (!isAllowedClientOrigin(req)) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '비인가 출처 차단', target: pathname, status: 403 });
      sendJsonResponse(req, res, 403, { error: 'FORBIDDEN_ORIGIN: 승인되지 않은 도메인 접근입니다.' });
      return true;
    }
  } else if (isEnforceApiKey) {
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'API 키 누락 차단', target: pathname, status: 401 });
    sendJsonResponse(req, res, 401, { error: 'UNAUTHORIZED_API_KEY: X-API-KEY 헤더가 누락되었습니다.' });
    return true;
  } else if (!isAllowedClientOrigin(req)) {
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '비인가 출처 차단', target: pathname, status: 403 });
    sendJsonResponse(req, res, 403, { error: 'FORBIDDEN_ORIGIN: 승인되지 않은 도메인 접근입니다.' });
    return true;
  }

  // 4. 크래시 리포트 수신 (인증/RateLimit/STORAGE_MODE 가드 통과 후 처리)
  if (req.method === 'POST' && pathname.startsWith('/api/storage/crash-reports/')) {
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
      maxDevices: 6,
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

  // -------------------------------------------------------------------------
  // 🎛️ [신규] 관리자용 다중 공유 폴더 및 기기별 권한 제어 REST API
  // -------------------------------------------------------------------------
  if (pathname === '/api/storage/admin/shared-folders') {
    if (!isRootAdmin) {
      sendJsonResponse(req, res, 403, { error: 'ROOT_ADMIN_REQUIRED: 공유 폴더 설정은 루트 관리자만 가능합니다.' });
      return true;
    }

    if (req.method === 'GET') {
      const config = getSharedFoldersConfig(env);
      sendJsonResponse(req, res, 200, { ok: true, config });
      return true;
    }

    if (req.method === 'POST') {
      try {
        const buffer = await readRequestBodyBuffer(req, 5 * 1024 * 1024);
        const newConfig = JSON.parse(buffer.toString('utf-8') || '{}');

        if (!newConfig || typeof newConfig !== 'object' || Array.isArray(newConfig) || !Array.isArray(newConfig.folders)) {
          sendJsonResponse(req, res, 400, { error: 'INVALID_CONFIG: enabled(boolean) 및 folders(array) 형식이 필요합니다.' });
          return true;
        }

        const sanitizedFolders = [];
        for (let idx = 0; idx < newConfig.folders.length; idx++) {
          const f = newConfig.folders[idx];
          if (!f || typeof f !== 'object' || typeof f.path !== 'string' || !f.path.trim()) {
            sendJsonResponse(req, res, 400, { error: `INVALID_FOLDER_ITEM: 유효하지 않은 공유 폴더 항목입니다 (index=${idx}).` });
            return true;
          }
          sanitizedFolders.push({
            id: String(f.id || `folder_${Date.now()}_${idx}`).trim(),
            name: String(f.name || path.basename(f.path.trim()) || '공유 서재').trim(),
            path: f.path.trim(),
            enabled: f.enabled !== false,
            allowedDevices: Array.isArray(f.allowedDevices)
              ? f.allowedDevices.map((d) => String(d).trim()).filter(Boolean)
              : ['*']
          });
        }

        const sanitizedConfig = {
          enabled: Boolean(newConfig.enabled),
          folders: sanitizedFolders
        };

        saveSharedFoldersConfig(sanitizedConfig);

        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '⚙️ 공유 폴더 설정 갱신',
          target: `폴더 ${sanitizedConfig.folders.length}개 (기능활성: ${sanitizedConfig.enabled})`,
          status: 200,
          user: authenticatedUserMemo
        });

        sendJsonResponse(req, res, 200, { ok: true, message: '공유 폴더 설정이 저장되었습니다.', config: sanitizedConfig });
        return true;
      } catch (err) {
        sendJsonResponse(req, res, 500, { error: err.message });
        return true;
      }
    }
  }

  // 7. ⚡ 공유 도서 내부 복사 (/api/storage/remote-library/import)
  if (req.method === 'POST' && pathname === '/api/storage/remote-library/import') {
    const config = getSharedFoldersConfig(env);
    if (!config.enabled) {
      sendJsonResponse(req, res, 403, { ok: false, error: 'FEATURE_DISABLED', message: '공유 도서 라이브러리 기능이 비활성화되어 있습니다.' });
      return true;
    }

    try {
      const buffer = await readRequestBodyBuffer(req, 5 * 1024 * 1024);
      const payload = JSON.parse(buffer.toString('utf-8') || '{}');
      const rawRelativePath = payload.relativePath;
      const targetFolderId = payload.folderId;

      if (!rawRelativePath) {
        sendJsonResponse(req, res, 400, { error: 'relativePath 필드가 누락되었습니다.' });
        return true;
      }

      // 🌟 [보안 및 경로 정규화] 슬래시 통일 및 상위 디렉터리 탈출(..) 차단
      const normalizedRelPath = rawRelativePath.replace(/\\/g, '/').replace(/^\/+/, '');
      if (normalizedRelPath.includes('..')) {
        sendJsonResponse(req, res, 400, { error: 'INVALID_PATH: 잘못된 경로 형식입니다 (상위 경로 이동 불가).' });
        return true;
      }

      // 대상 공유 폴더 결정
      let matchedFolder = null;
      if (targetFolderId) {
        matchedFolder = config.folders.find(f => f.id === targetFolderId && f.enabled);
      } else {
        matchedFolder = config.folders.find(f => f.enabled && (isRootAdmin || f.allowedDevices.includes('*') || (deviceId && f.allowedDevices.includes(deviceId))));
      }

      if (!matchedFolder || !fs.existsSync(matchedFolder.path)) {
        sendJsonResponse(req, res, 404, { ok: false, error: 'SHARED_FOLDER_NOT_FOUND', message: '접근 가능한 공유 도서 폴더를 찾을 수 없습니다.' });
        return true;
      }

      // 권한 검증
      if (!isRootAdmin && !matchedFolder.allowedDevices.includes('*') && (!deviceId || !matchedFolder.allowedDevices.includes(deviceId))) {
        sendJsonResponse(req, res, 403, { ok: false, error: 'PERMISSION_DENIED', message: '해당 공유 폴더에 접근할 수 있는 권한이 없습니다.' });
        return true;
      }

      const importResult = storageService.importRemoteBookToLibrary(matchedFolder.path, normalizedRelPath, targetUserFolder);
      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '⚡ 공유 도서 내부 복사',
        target: `${importResult.fileName} ➔ ${targetUserFolder || 'root'} (폴더: ${matchedFolder.name})`,
        status: 200,
        user: authenticatedUserMemo
      });

      sendJsonResponse(req, res, 200, importResult);
      return true;
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '공유 도서 복사 실패', target: err.message, status: 500, user: authenticatedUserMemo });
      sendJsonResponse(req, res, 500, { error: err.message });
      return true;
    }
  }

  // 8. 📚 공유 도서 목록 조회 (/api/storage/remote-library)
  if (req.method === 'GET' && pathname === '/api/storage/remote-library') {
    const config = getSharedFoldersConfig(env);

    if (!config.enabled || config.folders.length === 0) {
      sendJsonResponse(req, res, 200, { ok: true, enabled: false, totalBooks: 0, folders: [], books: [] });
      return true;
    }

    // 🌟 [기기별 폴더 칩 Stealth 필터링] 요청한 기기에 권한이 부여된 폴더만 엄격 선별
    const allowedFolders = config.folders.filter(f => {
      if (!f.enabled) return false;
      if (!fs.existsSync(f.path)) return false;
      if (isRootAdmin) return true;
      if (f.allowedDevices.includes('*')) return true;
      return Boolean(deviceId && f.allowedDevices.includes(deviceId));
    });

    if (allowedFolders.length === 0) {
      sendJsonResponse(req, res, 200, { ok: true, enabled: true, totalBooks: 0, folders: [], books: [] });
      return true;
    }

    let aggregatedBooks = [];
    const foldersMeta = [];

    for (const folder of allowedFolders) {
      try {
        const permCheck = storageService.testDirectoryPermissions(folder.path);
        if (!permCheck.readable) continue;

        const books = storageService.getRemoteBooks(folder.path) || [];
        foldersMeta.push({
          id: folder.id,
          name: folder.name,
          bookCount: books.length
        });

        for (const b of books) {
          aggregatedBooks.push({
            ...b,
            folderId: folder.id,
            folderName: folder.name,
            relativePath: (b.relativePath || '').replace(/\\/g, '/')
          });
        }
      } catch (folderErr) {
        console.warn(`⚠️ [StorageRoutes] 폴더 '${folder.name}' 스캔 예외:`, folderErr.message);
      }
    }

    auditLogger.recordAccessLog({
      ip: clientIp,
      userAgent,
      action: '📚 공유 서재 목록 조회',
      target: `총 ${aggregatedBooks.length}권 (허용 폴더 ${foldersMeta.length}개)`,
      status: 200,
      user: authenticatedUserMemo
    });

    sendJsonResponse(req, res, 200, {
      ok: true,
      enabled: true,
      totalBooks: aggregatedBooks.length,
      folders: foldersMeta,
      books: aggregatedBooks
    });
    return true;
  }

  // 9. 공유 도서 파일 스트리밍 다운로드 (/api/storage/remote-library/download)
  if (req.method === 'GET' && pathname === '/api/storage/remote-library/download') {
    const config = getSharedFoldersConfig(env);
    const reqFile = reqUrl.searchParams.get('file');
    const folderId = reqUrl.searchParams.get('folderId');

    if (!config.enabled || !reqFile) {
      sendJsonResponse(req, res, 400, { error: 'file 쿼리 파라미터가 누락되었거나 기능이 꺼져있습니다.' });
      return true;
    }

    // 🌟 [보안 및 경로 정규화] 상위 디렉터리 탈출(..) 차단
    const normalizedReqFile = reqFile.replace(/\\/g, '/').replace(/^\/+/, '');
    if (normalizedReqFile.includes('..')) {
      sendJsonResponse(req, res, 400, { error: 'INVALID_PATH: 잘못된 경로 형식입니다 (상위 경로 이동 불가).' });
      return true;
    }

    let targetFolder = null;
    if (folderId) {
      targetFolder = config.folders.find(f => f.id === folderId && f.enabled);
    } else {
      targetFolder = config.folders.find(f => f.enabled && (isRootAdmin || f.allowedDevices.includes('*') || (deviceId && f.allowedDevices.includes(deviceId))));
    }

    if (!targetFolder || !fs.existsSync(targetFolder.path)) {
      sendJsonResponse(req, res, 404, { error: '공유 폴더를 찾을 수 없습니다.' });
      return true;
    }

    // 🔒 [기기별 폴더 접근 권한 검증] /import와 동일한 allowedDevices 검사 적용
    if (!isRootAdmin && !targetFolder.allowedDevices.includes('*') && (!deviceId || !targetFolder.allowedDevices.includes(deviceId))) {
      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '🚫 공유 도서 다운로드 권한 차단',
        target: `${normalizedReqFile} (폴더: ${targetFolder.name}, 기기: ${deviceId || 'unknown'})`,
        status: 403,
        user: authenticatedUserMemo
      });
      sendJsonResponse(req, res, 403, { error: 'PERMISSION_DENIED: 해당 공유 폴더에 접근할 수 있는 권한이 없습니다.' });
      return true;
    }

    const fileInfo = storageService.getRemoteBookFilePath(targetFolder.path, normalizedReqFile);
    if (!fileInfo) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '공유 도서 다운로드 실패', target: normalizedReqFile, status: 404, user: authenticatedUserMemo });
      sendJsonResponse(req, res, 404, { error: '도서 파일을 찾을 수 없습니다.' });
      return true;
    }

    const isTxt = fileInfo.fileName.toLowerCase().endsWith('.txt');
    const contentType = isTxt ? 'text/plain; charset=utf-8' : 'application/epub+zip';

    auditLogger.recordAccessLog({
      ip: clientIp,
      userAgent,
      action: isTxt ? '📄 TXT 도서 스트리밍' : '📖 EPUB 도서 스트리밍',
      target: fileInfo.fileName,
      status: 200,
      user: authenticatedUserMemo
    });

    setCorsHeaders(req, res);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': fileInfo.size,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileInfo.fileName)}"`
    });
    fs.createReadStream(fileInfo.filePath).pipe(res);
    return true;
  }

  // 10. 서재 스냅샷 조회 (/api/storage/snapshot)
  if (req.method === 'GET' && pathname === '/api/storage/snapshot') {
    try {
      const snapshot = await storageService.getUnifiedSnapshot(targetUserFolder);
      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '📚 서재 스냅샷 조회',
        target: `${targetUserFolder || 'root'} (활성 ${snapshot.cloudBooks.length}권 / 보관 ${snapshot.cloudArchivedBooks.length}권)`,
        status: 200,
        user: authenticatedUserMemo
      });
      sendJsonResponse(req, res, 200, snapshot);
      return true;
    } catch (err) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '서재 스냅샷 실패', target: err.message, status: 500, user: authenticatedUserMemo });
      sendJsonResponse(req, res, 500, { error: err.message });
      return true;
    }
  }

  // 11. 도서 메타데이터 저장 및 조회 (/api/storage/books/:id)
  if (pathname.startsWith('/api/storage/books/') && !pathname.endsWith('/epub')) {
    const rawEnd = pathname.replace('/api/storage/books/', '');
    const decodedEnd = decodeURIComponent(rawEnd);
    const isBooksFolderOnlyCheck = decodedEnd.toLowerCase().endsWith('.json');
    const bookId = decodedEnd.replace(/\.json$/i, '');

    if (rawEnd.endsWith('.webp')) {
      const coverFileName = decodeURIComponent(rawEnd);
      const info = storageService.getCoverImagePath(coverFileName, targetUserFolder);
      if (!info) {
        sendJsonResponse(req, res, 404, { error: '표지를 찾을 수 없습니다.' });
        return true;
      }
      setCorsHeaders(req, res);
      res.writeHead(200, {
        'Content-Type': 'image/webp',
        'Content-Length': info.size,
        'Cache-Control': 'public, max-age=86400'
      });
      if (req.method === 'HEAD') { res.end(); return true; }
      fs.createReadStream(info.filePath).pipe(res);
      return true;
    }

    if (req.method === 'POST') {
      try {
        const buffer = await readRequestBodyBuffer(req, 5 * 1024 * 1024);
        const bookData = JSON.parse(buffer.toString('utf-8'));
        storageService.saveBookMetadata(bookId, bookData, targetUserFolder);

        const actionName = bookData.isArchived ? '📁 도서 보관 처리' : '📖 도서 메타 저장';
        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: actionName,
          target: `${bookData.title || bookId} (${targetUserFolder || 'root'})`,
          status: 200,
          user: authenticatedUserMemo
        });
        sendJsonResponse(req, res, 200, { ok: true, bookId });
        return true;
      } catch (err) {
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '도서 메타 저장 실패', target: bookId, status: 500, user: authenticatedUserMemo });
        sendJsonResponse(req, res, 500, { error: err.message });
        return true;
      }
    }

    if (req.method === 'GET') {
      const meta = storageService.getBookMetadata(bookId, targetUserFolder);
      if (!meta || (isBooksFolderOnlyCheck && meta.isArchived === true)) {
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '도서 메타 조회 실패', target: bookId, status: 404, user: authenticatedUserMemo });
        sendJsonResponse(req, res, 404, { error: '도서를 찾을 수 없습니다.' });
        return true;
      }
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '도서 메타 조회', target: `${meta.title || bookId} (${targetUserFolder || 'root'})`, status: 200, user: authenticatedUserMemo });
      sendJsonResponse(req, res, 200, meta);
      return true;
    }

    if (req.method === 'DELETE') {
      const count = storageService.deleteBookAll(bookId, targetUserFolder);
      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '🗑️ 도서 완전 삭제',
        target: `${bookId} (${count}개 파일 파쇄 / ${targetUserFolder || 'root'})`,
        status: 200,
        user: authenticatedUserMemo
      });
      sendJsonResponse(req, res, 200, { ok: true, deletedFiles: count });
      return true;
    }
  }

  // 11-B. 보관함(archive/) 도서 메타데이터 조회 (/api/storage/archive/:id)
  if (req.method === 'GET' && pathname.startsWith('/api/storage/archive/')) {
    const rawEnd = pathname.replace('/api/storage/archive/', '');
    const bookId = decodeURIComponent(rawEnd).replace(/\.json$/i, '');
    const meta = storageService.getBookMetadata(bookId, targetUserFolder);
    if (!meta || meta.isArchived !== true) {
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '보관 도서 메타 조회 실패', target: bookId, status: 404, user: authenticatedUserMemo });
      sendJsonResponse(req, res, 404, { error: '보관 도서를 찾을 수 없습니다.' });
      return true;
    }
    auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '보관 도서 메타 조회', target: `${meta.title || bookId} (${targetUserFolder || 'root'})`, status: 200, user: authenticatedUserMemo });
    sendJsonResponse(req, res, 200, meta);
    return true;
  }

  // 12. EPUB 도서 바이너리 업로드 및 다운로드 (/api/storage/books/:id/epub)
  if (pathname.startsWith('/api/storage/books/') && pathname.endsWith('/epub')) {
    const rawSegment = pathname.replace('/api/storage/books/', '').replace(/\/epub$/, '');
    const bookId = decodeURIComponent(rawSegment);

    if (req.method === 'POST') {
      const contentLength = Number(req.headers['content-length'] || 0);
      if (targetUserFolder && contentLength > 0) {
        const quotaCheck = storageService.checkUserStorageQuota(targetUserFolder, contentLength, userQuotaBytes);
        if (!quotaCheck.allowed) {
          auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '용량 초과 업로드 차단', target: `${bookId} (${targetUserFolder})`, status: 413, user: authenticatedUserMemo });
          sendJsonResponse(req, res, 413, { error: 'STORAGE_QUOTA_EXCEEDED: 저장 용량을 초과했습니다.' });
          return true;
        }
      }

      try {
        const buffer = await readRequestBodyBuffer(req, 100 * 1024 * 1024);
        storageService.saveBookEpub(bookId, buffer, targetUserFolder);

        const sizeMb = (buffer.length / 1024 / 1024).toFixed(1);
        auditLogger.recordAccessLog({
          ip: clientIp,
          userAgent,
          action: '📦 EPUB 업로드',
          target: `${bookId} (${sizeMb}MB / ${targetUserFolder || 'root'})`,
          status: 200,
          user: authenticatedUserMemo
        });
        sendJsonResponse(req, res, 200, { ok: true, bookId, size: buffer.length });
        return true;
      } catch (err) {
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'EPUB 업로드 실패', target: bookId, status: 500, user: authenticatedUserMemo });
        sendJsonResponse(req, res, 500, { error: err.message });
        return true;
      }
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const info = storageService.getBookEpubPath(bookId, targetUserFolder);
      if (!info) {
        if (req.method === 'HEAD') {
          setCorsHeaders(req, res);
          res.writeHead(404);
          res.end();
          return true;
        }
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: 'EPUB 다운로드 실패', target: bookId, status: 404, user: authenticatedUserMemo });
        sendJsonResponse(req, res, 404, { error: 'EPUB 파일을 찾을 수 없습니다.' });
        return true;
      }

      setCorsHeaders(req, res);
      res.writeHead(200, {
        'Content-Type': 'application/epub+zip',
        'Content-Length': info.size,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(bookId)}.epub"`
      });

      if (req.method === 'HEAD') {
        res.end();
        return true;
      }

      const sizeMb = (info.size / 1024 / 1024).toFixed(1);
      auditLogger.recordAccessLog({
        ip: clientIp,
        userAgent,
        action: '📖 EPUB 다운로드',
        target: `${bookId} (${sizeMb}MB / ${targetUserFolder || 'root'})`,
        status: 200,
        user: authenticatedUserMemo
      });

      fs.createReadStream(info.filePath).pipe(res);
      return true;
    }
  }

  // 13. 표지 이미지 관리 (/api/storage/covers/:fileName)
  if (pathname.startsWith('/api/storage/covers/')) {
    const fileName = decodeURIComponent(pathname.replace('/api/storage/covers/', ''));

    if (req.method === 'POST') {
      try {
        const buffer = await readRequestBodyBuffer(req, 10 * 1024 * 1024);
        storageService.saveCoverImage(fileName, buffer, targetUserFolder);
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '🖼️ 표지 업로드', target: `${fileName} (${targetUserFolder || 'root'})`, status: 200, user: authenticatedUserMemo });
        sendJsonResponse(req, res, 200, { ok: true, fileName });
        return true;
      } catch (err) {
        auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '표지 업로드 실패', target: fileName, status: 500, user: authenticatedUserMemo });
        sendJsonResponse(req, res, 500, { error: err.message });
        return true;
      }
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const info = storageService.getCoverImagePath(fileName, targetUserFolder);
      if (!info) {
        sendJsonResponse(req, res, 404, { error: '표지를 찾을 수 없습니다.' });
        return true;
      }

      setCorsHeaders(req, res);
      res.writeHead(200, {
        'Content-Type': 'image/webp',
        'Content-Length': info.size,
        'Cache-Control': 'public, max-age=86400'
      });

      if (req.method === 'HEAD') {
        res.end();
        return true;
      }

      fs.createReadStream(info.filePath).pipe(res);
      return true;
    }

    if (req.method === 'DELETE') {
      storageService.deleteCoverImage(fileName, targetUserFolder);
      auditLogger.recordAccessLog({ ip: clientIp, userAgent, action: '🖼️ 표지 단일 삭제', target: `${fileName} (${targetUserFolder || 'root'})`, status: 200, user: authenticatedUserMemo });
      sendJsonResponse(req, res, 200, { ok: true, fileName });
      return true;
    }
  }

  // 14. 시스템 및 동기화 설정 파일 관리 (/api/storage/settings/:fileName)
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