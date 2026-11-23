/**
 * @file src/services/apiKey/apiKeyDeviceService.js
 * @description 기기 화이트리스트, 기기별 비밀 토큰(X-Device-Token) 바인딩, 마스터 기기 등록 및 기기 차단/삭제 관리 서비스
 * - 📱 [마스터 등록 & 재발급 복구] registerOrVerifyDevice로 0대 또는 재발급 PENDING 시 1호기 토큰 발급
 * - 🛡️ [이중 기기 위조 방어] verifyAndTouchDevice로 deviceId + SHA-256 해시 토큰 상수 시간 검증
 * - 🚫 [기기 개별 관리] getUserDevices, blockDevice, unblockDevice, deleteDevice 제공
 */

import crypto from 'crypto';
import {
  DEFAULT_MAX_DEVICES,
  hashApiKey,
  safeEqualHex,
  sanitizeDeviceId,
  readApiKeysData,
  writeApiKeysData,
  touchApiKeysData
} from './apiKeyStore.js';

/**
 * 기기 전용 랜덤 비밀 토큰 생성 (192-bit)
 * @returns {string}
 */
export function generateDeviceToken() {
  return `dt_${crypto.randomBytes(24).toString('hex')}`;
}

/**
 * 🔑 [POST /api/auth/device/register 전용]
 * - 등록 기기가 0대인 최초 상태이거나, 관리자에 의해 키가 재발급된 직후(PENDING & isReissued) 상태:
 *   1번째 마스터 기기로 등록하고 새 `deviceToken`을 발급합니다.
 * - 이미 기기가 1대 이상 등록된 일반 ACTIVE 상태: 동일 `deviceId` + 유효한 `deviceToken`을 가진 기기만 통과시킵니다.
 * @param {string} folderName
 * @param {Object} [params={}]
 * @returns {{ allowed: boolean, newlyRegistered?: boolean, deviceToken?: string|null, reason?: string, message?: string, device?: Object|null }}
 */
export function registerOrVerifyDevice(folderName, { deviceId, deviceName = '', deviceToken = '', clientIp = '' } = {}) {
  if (!folderName) return { allowed: false, reason: 'INVALID_FOLDER_NAME' };

  const cleanDeviceId = sanitizeDeviceId(deviceId);
  if (!cleanDeviceId) {
    return {
      allowed: false,
      reason: 'DEVICE_ID_REQUIRED',
      message: '유효한 기기 식별자(X-Device-Id)가 필요합니다.'
    };
  }

  const cleanDeviceName = String(deviceName || '').trim().slice(0, 50) || '웹 리더 기기';
  const cleanIp = String(clientIp || '').trim().slice(0, 45) || '127.0.0.1';

  const list = readApiKeysData();
  const index = list.findIndex(item => item.folderName === folderName);
  if (index === -1) {
    return { allowed: false, reason: 'USER_NOT_FOUND' };
  }

  const user = list[index];
  user.devices = user.devices || {};
  const maxLimit = user.maxDevices || DEFAULT_MAX_DEVICES;
  const now = new Date().toISOString();
  const existingDevice = Object.hasOwn(user.devices, cleanDeviceId) ? user.devices[cleanDeviceId] : null;
  const isReissuedPending = user.status === 'PENDING' && Boolean(user.isReissued);

  // 🌟 재발급 직후(PENDING & isReissued)인 경우 기존 옛 tokenHash 잠금을 해제하고 새 deviceToken으로 재등록 허용
  if (existingDevice && isReissuedPending) {
    if (existingDevice.status === 'blocked') {
      return { allowed: false, reason: 'DEVICE_BLOCKED', device: existingDevice };
    }
    const issuedDeviceToken = generateDeviceToken();
    const tokenHash = hashApiKey(issuedDeviceToken);

    existingDevice.tokenHash = tokenHash;
    existingDevice.lastSeen = now;
    existingDevice.lastIp = cleanIp;
    if (cleanDeviceName && cleanDeviceName !== '웹 리더 기기') {
      existingDevice.deviceName = cleanDeviceName;
    }

    writeApiKeysData(list);
    console.log(`🔄 [ApiKeyManager:ReissuedMasterSync] 재발급 키 마스터 기기 토큰 재등록 완료: '${cleanDeviceName}' (${cleanDeviceId}) ➔ '${user.memo}'`);
    return { allowed: true, newlyRegistered: true, deviceToken: issuedDeviceToken, device: existingDevice };
  }

  // 1. 이미 등록된 일반 ACTIVE 기기인 경우: 반드시 기존 tokenHash와 일치하는 X-Device-Token이 있어야 통과
  if (existingDevice) {
    if (existingDevice.status === 'blocked') {
      return { allowed: false, reason: 'DEVICE_BLOCKED', device: existingDevice };
    }
    if (!existingDevice.tokenHash || !deviceToken || typeof deviceToken !== 'string' || !deviceToken.trim()) {
      return {
        allowed: false,
        reason: 'DEVICE_TOKEN_REQUIRED',
        message: '보안 기기 토큰이 필요합니다. 6자리 연결 번호로 로그인하거나 관리자 페이지에서 기기를 재발급해 주세요.'
      };
    }
    const providedHash = hashApiKey(deviceToken);
    if (!safeEqualHex(providedHash, existingDevice.tokenHash)) {
      return {
        allowed: false,
        reason: 'DEVICE_TOKEN_INVALID',
        message: '기기 보안 토큰이 일치하지 않습니다. 6자리 연결 번호로 다시 로그인해 주세요.'
      };
    }

    existingDevice.lastSeen = now;
    existingDevice.lastIp = cleanIp;
    if (cleanDeviceName && cleanDeviceName !== '웹 리더 기기') {
      existingDevice.deviceName = cleanDeviceName;
    }
    writeApiKeysData(list);
    return { allowed: true, newlyRegistered: false, deviceToken: null, device: existingDevice };
  }

  const currentDeviceCount = Object.keys(user.devices).length;

  // 2. 최초 0대 상태이거나 재발급 직후일 때 1호기(Master) 등록 및 비밀 토큰 발급 허용
  if (currentDeviceCount === 0 || isReissuedPending) {
    const issuedDeviceToken = generateDeviceToken();
    const tokenHash = hashApiKey(issuedDeviceToken);
    const newDevice = {
      deviceId: cleanDeviceId,
      deviceName: cleanDeviceName,
      tokenHash,
      firstSeen: now,
      lastSeen: now,
      lastIp: cleanIp,
      status: 'active'
    };
    user.devices[cleanDeviceId] = newDevice;
    writeApiKeysData(list);
    console.log(`📱 [ApiKeyManager:MasterRegistered] 1번째 마스터 기기 등록 & 토큰 발급 완료: '${cleanDeviceName}' (${cleanDeviceId}) ➔ '${user.memo}' (1/${maxLimit}대)`);
    return { allowed: true, newlyRegistered: true, deviceToken: issuedDeviceToken, device: newDevice };
  }

  // 3. 이미 1대 이상 등록된 상태에서 미등록 기기는 자동 등록 불가 (6자리 번호 필요)
  return {
    allowed: false,
    reason: 'DEVICE_UNREGISTERED',
    message: '등록되지 않았거나 삭제된 기기입니다. 6자리 번호로 다시 로그인해 주세요.'
  };
}

/**
 * 접속 기기의 유효성과 기기별 비밀 토큰(X-Device-Token) 일치 여부를 엄격 검증합니다.
 * @param {string} folderName
 * @param {Object} [params={}]
 * @returns {{ allowed: boolean, reason?: string, message?: string, device?: Object|null }}
 */
export function verifyAndTouchDevice(folderName, { deviceId, deviceName = '', deviceToken = '', clientIp = '' } = {}) {
  if (!folderName) return { allowed: false, reason: 'INVALID_FOLDER_NAME' };

  const cleanDeviceId = sanitizeDeviceId(deviceId);
  if (!cleanDeviceId) {
    return {
      allowed: false,
      reason: 'DEVICE_ID_REQUIRED',
      message: '유효한 기기 식별자(X-Device-Id)가 필요합니다.'
    };
  }

  const cleanDeviceName = String(deviceName || '').trim().slice(0, 50) || '웹 리더 기기';
  const cleanIp = String(clientIp || '').trim().slice(0, 45) || '127.0.0.1';

  const list = readApiKeysData();
  const index = list.findIndex(item => item.folderName === folderName);
  if (index === -1) {
    return { allowed: false, reason: 'USER_NOT_FOUND' };
  }

  const user = list[index];
  user.devices = user.devices || {};
  const now = new Date().toISOString();

  const device = Object.hasOwn(user.devices, cleanDeviceId) ? user.devices[cleanDeviceId] : null;

  // 1. 이미 정식 등록된 기기인 경우
  if (device) {
    if (device.status === 'blocked') {
      const isIpChanged = device.lastIp !== cleanIp;
      device.lastSeen = now;
      device.lastIp = cleanIp;
      touchApiKeysData(list, { immediate: isIpChanged });
      return { allowed: false, reason: 'DEVICE_BLOCKED', device };
    }

    // 🔐 기기 비밀 토큰(X-Device-Token) 엄격 검증
    if (!device.tokenHash || !deviceToken || typeof deviceToken !== 'string' || !deviceToken.trim()) {
      return {
        allowed: false,
        reason: 'DEVICE_TOKEN_REQUIRED',
        message: '보안 기기 토큰이 필요합니다. 6자리 번호로 다시 로그인하거나 관리자 화면에서 기기 슬롯을 초기화한 뒤 다시 연결해 주세요.'
      };
    }

    const providedHash = hashApiKey(deviceToken);
    if (!safeEqualHex(providedHash, device.tokenHash)) {
      console.warn(`⛔ [ApiKeyManager:InvalidDeviceToken] 기기 토큰 불일치 차단: 폴더='${folderName}', 기기='${cleanDeviceId}'`);
      return {
        allowed: false,
        reason: 'DEVICE_TOKEN_INVALID',
        message: '기기 보안 토큰이 유효하지 않습니다. 다시 로그인해 주세요.'
      };
    }

    const isNameChanged = Boolean(cleanDeviceName && cleanDeviceName !== '웹 리더 기기' && device.deviceName !== cleanDeviceName);
    const isIpChanged = device.lastIp !== cleanIp;

    device.lastSeen = now;
    device.lastIp = cleanIp;
    if (isNameChanged) {
      device.deviceName = cleanDeviceName;
    }
    touchApiKeysData(list, { immediate: isNameChanged || isIpChanged });
    return { allowed: true, device };
  }

  const currentDeviceCount = Object.keys(user.devices).length;

  // 2. 등록 기기가 0대인 최초 상태 또는 재발급 직후 상태: 마스터 기기 등록 유도
  if (currentDeviceCount === 0 || (user.status === 'PENDING' && user.isReissued)) {
    return {
      allowed: false,
      reason: 'MASTER_DEVICE_REGISTRATION_REQUIRED',
      message: '최초 마스터 기기 등록이 필요합니다. 설정에서 [연결] 버튼을 눌러 기기 토큰을 발급받아 주세요.'
    };
  }

  // 3. 🚨 [화이트리스트 방어] 이미 1대 이상 등록되어 있는데 장부에 없는 기기 (삭제된 기기 또는 미승인 기기)
  console.warn(`⛔ [ApiKeyManager:UnregisteredDevice] 미등록(또는 삭제된) 기기 접근 차단: 폴더='${folderName}', 기기='${cleanDeviceId}'`);
  return {
    allowed: false,
    reason: 'DEVICE_UNREGISTERED',
    message: '등록되지 않았거나 삭제된 기기입니다. 6자리 번호로 다시 로그인해 주세요.'
  };
}

/**
 * 사용자의 등록 기기 목록을 최근 접속순으로 반환합니다.
 * @param {string} [folderName='']
 * @returns {Array<Object>}
 */
export function getUserDevices(folderName = '') {
  if (!folderName) return [];
  const list = readApiKeysData();
  const user = list.find(item => item.folderName === folderName);
  if (!user || !user.devices) return [];

  return Object.values(user.devices)
    .map(d => ({
      deviceId: d.deviceId,
      deviceName: d.deviceName,
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
      lastIp: d.lastIp,
      status: d.status,
      hasToken: Boolean(d.tokenHash)
    }))
    .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
}

/**
 * 특정 기기를 차단 상태로 전환합니다.
 * @param {string} folderName
 * @param {string} deviceId
 * @returns {{ success: boolean, device?: Object, error?: string }}
 */
export function blockDevice(folderName, deviceId) {
  const cleanId = sanitizeDeviceId(deviceId);
  if (!folderName || !cleanId) return { success: false, error: '인자가 유효하지 않습니다.' };

  const list = readApiKeysData();
  const user = list.find(item => item.folderName === folderName);
  if (!user || !user.devices || !Object.hasOwn(user.devices, cleanId)) {
    return { success: false, error: '해당 기기를 찾을 수 없습니다.' };
  }

  user.devices[cleanId].status = 'blocked';
  writeApiKeysData(list);
  console.log(`⛔ [ApiKeyManager:DeviceBlocked] 기기 차단됨: '${cleanId}' ➔ 사용자: '${user.memo}'`);

  return { success: true, device: user.devices[cleanId] };
}

/**
 * 차단된 기기를 활성 상태로 복구합니다.
 * @param {string} folderName
 * @param {string} deviceId
 * @returns {{ success: boolean, device?: Object, error?: string }}
 */
export function unblockDevice(folderName, deviceId) {
  const cleanId = sanitizeDeviceId(deviceId);
  if (!folderName || !cleanId) return { success: false, error: '인자가 유효하지 않습니다.' };

  const list = readApiKeysData();
  const user = list.find(item => item.folderName === folderName);
  if (!user || !user.devices || !Object.hasOwn(user.devices, cleanId)) {
    return { success: false, error: '해당 기기를 찾을 수 없습니다.' };
  }

  user.devices[cleanId].status = 'active';
  writeApiKeysData(list);
  console.log(`🟢 [ApiKeyManager:DeviceUnblocked] 기기 차단 해제됨: '${cleanId}' ➔ 사용자: '${user.memo}'`);

  return { success: true, device: user.devices[cleanId] };
}

/**
 * 등록 기기를 삭제해 슬롯을 반환합니다.
 * @param {string} folderName
 * @param {string} deviceId
 * @returns {{ success: boolean, error?: string }}
 */
export function deleteDevice(folderName, deviceId) {
  const cleanId = sanitizeDeviceId(deviceId);
  if (!folderName || !cleanId) return { success: false, error: '인자가 유효하지 않습니다.' };

  const list = readApiKeysData();
  const user = list.find(item => item.folderName === folderName);
  if (!user || !user.devices || !Object.hasOwn(user.devices, cleanId)) {
    return { success: false, error: '해당 기기를 찾을 수 없습니다.' };
  }

  delete user.devices[cleanId];
  writeApiKeysData(list);
  console.log(`🗑️ [ApiKeyManager:DeviceDeleted] 기기 삭제 및 슬롯 반환: '${cleanId}' ➔ 사용자: '${user.memo}'`);

  return { success: true };
}