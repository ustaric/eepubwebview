/**
 * @file src/services/apiKey/apiKeyUserService.js
 * @description 사용자 API 키 발급, 인증, 24시간 활성화/만료 정리, 재발급, 용량/기기 한도 조정 및 관리자 집계 서비스
 * - 🔑 [발급 & 원터치 활성화] 24시간 활성화 윈도우, 최초 접속 시 ACTIVE 전환 및 샌드박스 폴더 골격 자동 생성
 * - 🔄 [무손실 재발급] 키 분실 시 도서·설정을 보존하고 기기 슬롯만 초기화해 즉시 재연결 지원
 * - 🧹 [만료 고아 정리] 신규 미접속 키만 폴더 회수, 기존 서재·재발급 키는 EXPIRED 전환 후 데이터 보존
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  USERS_DIR,
  ACTIVATION_WINDOW_MS,
  DEFAULT_MAX_DEVICES,
  ensureDir,
  hashApiKey,
  safeEqualHex,
  getDirectorySize,
  generateUniqueFolderName,
  validateUserDirectory,
  readApiKeysData,
  writeApiKeysData,
  touchApiKeysData
} from './apiKeyStore.js';

/**
 * 🎲 [신규 API 키 발급 및 서재 폴더 골격 즉시 생성]
 * @param {Object} [options={}]
 * @param {string} [options.memo="새 사용자"] - 사용자 식별 메모/이름
 * @param {number} [options.quotaMb=1024] - 할당 도서 저장 용량 (MB 단위, 기본 1GB)
 * @param {number} [options.maxDevices=6] - 최대 등록 허용 기기 수 (기본 6대)
 * @param {string} [options.role="user"] - 역할 ("admin" | "user")
 * @returns {{ apiKey: string, folderName: string, memo: string, expiresAt: string, quotaMb: number, maxDevices: number }}
 */
export function issueApiKey({ memo = '새 사용자', quotaMb = 1024, maxDevices = DEFAULT_MAX_DEVICES, role = 'user' } = {}) {
  ensureDir(USERS_DIR);

  const folderName = generateUniqueFolderName();
  const userRoot = path.join(USERS_DIR, folderName);
  ensureDir(path.join(userRoot, 'books'));
  ensureDir(path.join(userRoot, 'settings'));
  ensureDir(path.join(userRoot, 'archive'));

  const rawSecret = crypto.randomBytes(24).toString('hex');
  const apiKey = `sk_live_${rawSecret}`;
  const keyHash = hashApiKey(apiKey);

  const now = Date.now();
  const expiresAt = new Date(now + ACTIVATION_WINDOW_MS).toISOString();

  const record = {
    folderName,
    memo: String(memo).trim() || '새 사용자',
    keyHash,
    role: role === 'admin' ? 'admin' : 'user',
    status: 'PENDING',
    storageQuotaBytes: Math.max(10, Number(quotaMb) || 1024) * 1024 * 1024,
    maxDevices: Math.max(1, parseInt(maxDevices, 10) || DEFAULT_MAX_DEVICES),
    devices: {},
    createdAt: new Date(now).toISOString(),
    activatedAt: null,
    expiresAt: expiresAt,
    lastAccessedAt: null
  };

  const list = readApiKeysData();
  list.push(record);
  writeApiKeysData(list);

  console.log(`🔑 [ApiKeyManager:Issued] 새 API 키 발급 완료: 폴더='${folderName}', 메모='${record.memo}', 마감='${expiresAt}', 기기한도=${record.maxDevices}대`);

  return {
    apiKey,
    folderName,
    memo: record.memo,
    expiresAt: record.expiresAt,
    quotaMb: Math.round(record.storageQuotaBytes / 1024 / 1024),
    maxDevices: record.maxDevices
  };
}

/**
 * 🛡️ [API 키 인증 및 24시간 활성화 상태 전이]
 * @param {string} [rawKey=''] - 클라이언트가 전달한 원문 API 키
 * @param {{ activatePending?: boolean }} [options={}] - PENDING 키의 즉시 ACTIVE 전이 여부
 * @returns {Object} 인증 결과 객체
 */
export function authenticateApiKey(rawKey = '', { activatePending = true } = {}) {
  if (!rawKey || typeof rawKey !== 'string' || !rawKey.trim()) {
    return { authenticated: false, reason: 'API_KEY_EMPTY' };
  }

  const keyHash = hashApiKey(rawKey);
  const list = readApiKeysData();
  const index = list.findIndex(item => safeEqualHex(item.keyHash, keyHash));

  if (index === -1) {
    return { authenticated: false, reason: 'API_KEY_NOT_FOUND' };
  }

  const user = list[index];
  const now = Date.now();
  let mustFlushImmediately = false;

  if (user.status === 'REVOKED') {
    return { authenticated: false, reason: 'API_KEY_REVOKED' };
  }

  if (user.status === 'PENDING') {
    const deadline = new Date(user.expiresAt).getTime();
    if (now > deadline) {
      user.status = 'EXPIRED';
      list[index] = user;
      writeApiKeysData(list);
      console.warn(`⏳ [ApiKeyManager:Expired] 24시간 내 미접속으로 키 만료: 폴더='${user.folderName}'`);
      return { authenticated: false, reason: 'API_KEY_EXPIRED' };
    }

    if (activatePending) {
      user.status = 'ACTIVE';
      user.activatedAt = new Date(now).toISOString();
      user.expiresAt = null;
      mustFlushImmediately = true;
      console.log(`✨ [ApiKeyManager:Activated] 사용자 서재 활성화 완료: 폴더='${user.folderName}'`);
    }
  } else if (user.status === 'EXPIRED') {
    return { authenticated: false, reason: 'API_KEY_EXPIRED' };
  }

  if (activatePending || user.status === 'ACTIVE') {
    user.lastAccessedAt = new Date(now).toISOString();
    list[index] = user;
    touchApiKeysData(list, { immediate: mustFlushImmediately });
  }

  const safeCheck = validateUserDirectory(user.folderName);
  if (!safeCheck.safe) {
    return { authenticated: false, reason: 'INVALID_USER_DIRECTORY' };
  }

  return {
    authenticated: true,
    user: {
      folderName: user.folderName,
      memo: user.memo,
      role: user.role,
      storageQuotaBytes: user.storageQuotaBytes,
      userRootPath: safeCheck.realPath,
      maxDevices: user.maxDevices || DEFAULT_MAX_DEVICES
    }
  };
}

/**
 * 사용자별 최대 등록 가능 기기 한도를 변경합니다.
 * @param {string} [folderName='']
 * @param {number} [maxDevices=DEFAULT_MAX_DEVICES]
 * @returns {{ success: boolean, folderName?: string, maxDevices?: number, memo?: string, error?: string }}
 */
export function updateUserMaxDevices(folderName = '', maxDevices = DEFAULT_MAX_DEVICES) {
  if (!folderName) return { success: false, error: '폴더명이 지정되지 않았습니다.' };

  const list = readApiKeysData();
  const index = list.findIndex(item => item.folderName === folderName);
  if (index === -1) {
    return { success: false, error: '해당 사용자를 찾을 수 없습니다.' };
  }

  const validLimit = Math.max(1, Math.min(50, parseInt(maxDevices, 10) || DEFAULT_MAX_DEVICES));
  list[index].maxDevices = validLimit;

  writeApiKeysData(list);
  console.log(`⚙️ [ApiKeyManager:MaxDevicesUpdated] 사용자('${folderName}') 최대 기기 한도 변경: ${validLimit} 대`);

  return { success: true, folderName, maxDevices: validLimit, memo: list[index].memo };
}

/**
 * 🔄 [API 키 재발급]
 * - 도서 파일, 보관함, 전역 설정, 독서 진행률은 100% 무손실 보존합니다.
 * - 구버전 키로 묶여있던 `devices` 목록을 초기화(`devices = {}`)하여,
 *   재발급된 키를 입력한 첫 번째 기기가 Deadlock 없이 즉시 새 마스터 기기로 등록될 수 있도록 합니다.
 * @param {string} [folderName='']
 * @returns {{ success: boolean, newApiKey?: string, folderName?: string, memo?: string, expiresAt?: string, error?: string }}
 */
export function reissueApiKey(folderName = '') {
  if (!folderName) return { success: false, error: '폴더명이 지정되지 않았습니다.' };

  const list = readApiKeysData();
  const index = list.findIndex(item => item.folderName === folderName);
  if (index === -1) {
    return { success: false, error: '해당 폴더의 사용자를 찾을 수 없습니다.' };
  }

  const rawSecret = crypto.randomBytes(24).toString('hex');
  const newApiKey = `sk_live_${rawSecret}`;
  const newHash = hashApiKey(newApiKey);

  const now = Date.now();
  const expiresAt = new Date(now + ACTIVATION_WINDOW_MS).toISOString();

  list[index].keyHash = newHash;
  list[index].status = 'PENDING';
  list[index].expiresAt = expiresAt;
  list[index].activatedAt = null;
  list[index].isReissued = true;
  list[index].devices = {}; // 🌟 기기 슬롯 클린 리셋 ➔ 새 키 첫 기기 즉시 연결 허용

  writeApiKeysData(list);
  console.log(`🔄 [ApiKeyManager:Reissued] API 키 재발급 및 기기 슬롯 리셋 완료 (도서/설정 보존): '${folderName}' ➔ 새 만료기한: ${expiresAt}`);

  return {
    success: true,
    newApiKey,
    folderName,
    memo: list[index].memo,
    expiresAt
  };
}

/**
 * 사용자별 저장 용량 할당량(MB)을 변경합니다.
 * @param {string} [folderName='']
 * @param {number} [quotaMb=1024]
 * @returns {{ success: boolean, folderName?: string, quotaMb?: number, memo?: string, error?: string }}
 */
export function updateUserQuota(folderName = '', quotaMb = 1024) {
  if (!folderName) return { success: false, error: '폴더명이 지정되지 않았습니다.' };

  const list = readApiKeysData();
  const index = list.findIndex(item => item.folderName === folderName);
  if (index === -1) {
    return { success: false, error: '해당 사용자를 찾을 수 없습니다.' };
  }

  const validMb = Math.max(50, Math.min(1024000, parseInt(quotaMb, 10) || 1024));
  list[index].storageQuotaBytes = validMb * 1024 * 1024;

  writeApiKeysData(list);
  console.log(`⚙️ [ApiKeyManager:QuotaUpdated] 사용자('${folderName}') 저장 용량 변경 완료: ${validMb} MB`);

  return {
    success: true,
    folderName,
    quotaMb: validMb,
    memo: list[index].memo
  };
}

/**
 * API 키를 폐기하고 선택 시 사용자 폴더를 영구 삭제합니다.
 * @param {string} [folderName='']
 * @param {boolean} [deleteFolder=false]
 * @returns {{ success: boolean, error?: string }}
 */
export function revokeApiKey(folderName = '', deleteFolder = false) {
  if (!folderName) return { success: false, error: '폴더명이 지정되지 않았습니다.' };

  const list = readApiKeysData();
  const index = list.findIndex(item => item.folderName === folderName);
  if (index === -1) {
    return { success: false, error: '해당 사용자를 찾을 수 없습니다.' };
  }

  list.splice(index, 1);
  writeApiKeysData(list);

  if (deleteFolder) {
    const userRoot = path.join(USERS_DIR, folderName);
    const safeCheck = validateUserDirectory(folderName);
    if (safeCheck.safe && fs.existsSync(userRoot)) {
      try {
        fs.rmSync(userRoot, { recursive: true, force: true });
        console.log(`🗑️ [ApiKeyManager:Purge] 사용자 폴더 영구 삭제 완료: '${userRoot}'`);
      } catch (e) {
        console.warn(`⚠️ [ApiKeyManager] 폴더 삭제 실패:`, e.message);
      }
    }
  } else {
    console.log(`🔒 [ApiKeyManager:Revoked] API 키만 폐기됨 (도서 폴더 보존): '${folderName}'`);
  }

  return { success: true };
}

/**
 * 🧹 24시간 활성화 기한이 지난 PENDING 계정을 정리합니다.
 * @returns {void}
 */
export function cleanupExpiredPendingKeys() {
  const list = readApiKeysData();
  const now = Date.now();
  let changed = false;

  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    if (item.status === 'PENDING') {
      const deadline = new Date(item.expiresAt).getTime();
      if (now > deadline) {
        const userRoot = path.join(USERS_DIR, item.folderName);
        const hasExistingDevices = Boolean(item.devices && Object.keys(item.devices).length > 0);
        const isReissuedAccount = Boolean(item.isReissued);
        const hasStoredFiles = ['books', 'archive', 'settings'].some((sub) => {
          const subDir = path.join(userRoot, sub);
          try {
            return fs.existsSync(subDir) && fs.readdirSync(subDir).length > 0;
          } catch (_) {
            return true;
          }
        });

        if (isReissuedAccount || hasExistingDevices || hasStoredFiles) {
          console.warn(`⏳ [ApiKeyManager:ExpirePreserve] 기존 서재/재발급 계정('${item.folderName}') 24시간 미접속 ➔ 데이터 보존 상태로 EXPIRED 전환`);
          item.status = 'EXPIRED';
          changed = true;
        } else {
          console.log(`🧹 [ApiKeyManager:Cleanup] 24시간 미사용 고아 폴더 정리: '${item.folderName}'`);
          const safeCheck = validateUserDirectory(item.folderName);
          if (safeCheck.safe && fs.existsSync(userRoot)) {
            try {
              fs.rmSync(userRoot, { recursive: true, force: true });
            } catch (e) {}
          }
          list.splice(i, 1);
          changed = true;
        }
      }
    }
  }

  if (changed) {
    writeApiKeysData(list);
  }
}

/**
 * 관리자 페이지용 사용자·기기·용량·도서 권수 집계 목록을 반환합니다.
 * @returns {Array<Object>}
 */
export function getUserListForAdmin() {
  cleanupExpiredPendingKeys();
  const list = readApiKeysData();
  const now = Date.now();

  return list.map(u => {
    const userRoot = path.join(USERS_DIR, u.folderName);
    const booksDir = path.join(userRoot, 'books');
    const archiveDir = path.join(userRoot, 'archive');
    const usedBytes = getDirectorySize(userRoot);
    const quotaBytes = u.storageQuotaBytes || (1024 * 1024 * 1024);

    let activeCount = 0;
    let archivedCount = 0;
    if (fs.existsSync(booksDir)) {
      try {
        activeCount = fs.readdirSync(booksDir).filter(f => f.endsWith('.json')).length;
      } catch (e) {}
    }
    if (fs.existsSync(archiveDir)) {
      try {
        archivedCount = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json')).length;
      } catch (e) {}
    }
    const totalBookCount = activeCount + archivedCount;

    let remainingHours = null;
    if (u.status === 'PENDING' && u.expiresAt) {
      const diffMs = new Date(u.expiresAt).getTime() - now;
      remainingHours = diffMs > 0 ? (diffMs / (1000 * 60 * 60)).toFixed(1) : '0.0';
    }

    const devicesMap = u.devices || {};
    const devicesList = Object.values(devicesMap);
    const blockedDeviceCount = devicesList.filter(d => d.status === 'blocked').length;

    return {
      folderName: u.folderName,
      memo: u.memo,
      role: u.role || 'user',
      status: u.status,
      bookCount: totalBookCount,
      activeCount,
      archivedCount,
      usedBytes,
      usedMb: (usedBytes / (1024 * 1024)).toFixed(1),
      quotaMb: Math.round(quotaBytes / (1024 * 1024)),
      percent: Math.min(100, Math.round((usedBytes / quotaBytes) * 100)),
      maxDevices: u.maxDevices || DEFAULT_MAX_DEVICES,
      deviceCount: devicesList.length,
      blockedDeviceCount,
      devices: devicesList
        .map(d => ({
          deviceId: d.deviceId,
          deviceName: d.deviceName,
          firstSeen: d.firstSeen,
          lastSeen: d.lastSeen,
          lastIp: d.lastIp,
          status: d.status,
          hasToken: Boolean(d.tokenHash)
        }))
        .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen)),
      createdAt: u.createdAt,
      activatedAt: u.activatedAt,
      expiresAt: u.expiresAt,
      remainingHours,
      lastAccessedAt: u.lastAccessedAt
    };
  });
}