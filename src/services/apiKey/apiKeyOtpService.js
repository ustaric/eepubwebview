/**
 * @file src/services/apiKey/apiKeyOtpService.js
 * @description 3분 유효 6자리 일회용 기기 연결 번호(OTP) 발급, 만료 청소 및 게스트 기기 교환 서비스
 * - 🔢 [1회성 6자리 OTP] issueDeviceOtp / verifyAndExchangeDeviceOtp 제공 및 재사용 원천 차단
 * - ⏱️ [인메모리 TTL 관리] deviceOtpStore(Map) 단독 소유 및 60초 만료 청소 타이머 내장
 * - 🔒 [계정·기기 선검증] 폐기/만료/차단/기기한도 검사 후 게스트 기기 등록 및 deviceToken 발급
 */

import crypto from 'crypto';
import {
  DEFAULT_MAX_DEVICES,
  hashApiKey,
  sanitizeDeviceId,
  readApiKeysData,
  writeApiKeysData
} from './apiKeyStore.js';
import { generateDeviceToken } from './apiKeyDeviceService.js';

// 🔢 6자리 기기 연결 OTP 유효 시간 (3분: 180,000ms)
const OTP_TTL_MS = 3 * 60 * 1000;

/**
 * 🔒 6자리 일회용 연결 번호 인메모리 저장소
 * @type {Map<string, { code: string, folderName: string, apiKey: string, expiresAt: number }>}
 */
const deviceOtpStore = new Map();

// 1분마다 만료된 OTP 자동 청소
setInterval(() => {
  const now = Date.now();
  for (const [code, item] of deviceOtpStore.entries()) {
    if (now > item.expiresAt) {
      deviceOtpStore.delete(code);
    }
  }
}, 60 * 1000);

/**
 * [Host 기기] 3분 유효 6자리 일회용 연결 번호를 발급합니다.
 * @param {string} folderName
 * @param {string} rawApiKey
 * @returns {{ success: boolean, code?: string, displayCode?: string, expiresInSeconds?: number, error?: string }}
 */
export function issueDeviceOtp(folderName, rawApiKey) {
  if (!folderName || !rawApiKey) {
    return { success: false, error: '인증 정보가 부족합니다.' };
  }

  let code = '';
  let exists = true;
  let attempts = 0;

  while (exists && attempts < 20) {
    code = String(crypto.randomInt(100000, 1000000));
    exists = deviceOtpStore.has(code);
    attempts++;
  }

  const now = Date.now();
  const expiresAt = now + OTP_TTL_MS;

  deviceOtpStore.set(code, {
    code,
    folderName,
    apiKey: rawApiKey,
    expiresAt
  });

  const displayCode = `${code.substring(0, 3)}-${code.substring(3)}`;
  console.log(`🔢 [ApiKeyManager:OTP] 6자리 연결 번호 발급 완료: [${displayCode}] ➔ 서재: '${folderName}' (3분 유효)`);

  return {
    success: true,
    code,
    displayCode,
    expiresInSeconds: 180
  };
}

/**
 * 🔢 [Guest 기기] 6자리 연결 번호 검증, 기기 정식 등록, 기기 비밀 토큰(deviceToken) 발급 및 API 키 교환 (1회성 파쇄)
 * @param {string} inputCode - 6자리 숫자 코드
 * @param {Object} [deviceInfo={}] - 게스트 기기 식별 정보
 * @param {string} [deviceInfo.deviceId]
 * @param {string} [deviceInfo.deviceName]
 * @param {string} [deviceInfo.clientIp]
 * @returns {{ success: boolean, folderName?: string, apiKey?: string, deviceToken?: string|null, error?: string }}
 */
export function verifyAndExchangeDeviceOtp(inputCode, { deviceId = '', deviceName = '', clientIp = '' } = {}) {
  if (!inputCode) return { success: false, error: '연결 번호를 입력해 주세요.' };

  const cleanCode = String(inputCode).replace(/[^0-9]/g, '').trim();
  if (cleanCode.length !== 6) {
    return { success: false, error: '6자리 숫자를 올바르게 입력해 주세요.' };
  }

  const item = deviceOtpStore.get(cleanCode);
  if (!item) {
    return { success: false, error: '유효하지 않거나 이미 만료된 연결 번호입니다.' };
  }

  const now = Date.now();
  if (now > item.expiresAt) {
    deviceOtpStore.delete(cleanCode);
    return { success: false, error: '유효 시간(3분)이 초과되었습니다. 번호를 다시 발급받으세요.' };
  }

  let issuedDeviceToken = null;

  // 🔒 [계정 및 기기 차단 상태 선제 검증] 루트 관리자가 아닌 일반 사용자 계정의 폐기·만료·기기차단·deviceId 검증
  if (item.folderName !== 'root') {
    const list = readApiKeysData();
    const index = list.findIndex(u => u.folderName === item.folderName);
    if (index === -1) {
      deviceOtpStore.delete(cleanCode);
      return { success: false, error: '폐기되었거나 존재하지 않는 사용자 계정입니다.' };
    }

    const user = list[index];
    if (user.status === 'REVOKED' || user.status === 'EXPIRED') {
      deviceOtpStore.delete(cleanCode);
      return { success: false, error: '사용 중지되었거나 만료된 API 키입니다.' };
    }

    if (user.status === 'PENDING' && user.expiresAt && now > new Date(user.expiresAt).getTime()) {
      user.status = 'EXPIRED';
      writeApiKeysData(list);
      deviceOtpStore.delete(cleanCode);
      return { success: false, error: '활성화 기한이 만료된 API 키입니다.' };
    }

    const cleanDeviceId = sanitizeDeviceId(deviceId);
    if (!cleanDeviceId) {
      return {
        success: false,
        error: '유효한 기기 식별자(X-Device-Id)가 누락되었습니다. 브라우저를 새로고침한 뒤 다시 시도해 주세요.'
      };
    }

    const cleanDeviceName = String(deviceName || '').trim().slice(0, 50) || '웹 리더 기기';
    const cleanIp = String(clientIp || '').trim().slice(0, 45) || '127.0.0.1';

    user.devices = user.devices || {};
    const existingDevice = Object.hasOwn(user.devices, cleanDeviceId) ? user.devices[cleanDeviceId] : null;
    if (existingDevice && existingDevice.status === 'blocked') {
      console.warn(`⛔ [ApiKeyManager:OTPBlocked] 차단된 기기의 OTP 우회 승인 차단: '${cleanDeviceId}' ➔ '${user.memo}'`);
      return {
        success: false,
        error: '관리자에 의해 차단된 기기입니다. 관리자 화면에서 차단을 먼저 해제해 주세요.'
      };
    }

    const maxLimit = user.maxDevices || DEFAULT_MAX_DEVICES;
    const currentCount = Object.keys(user.devices).length;

    if (!existingDevice && currentCount >= maxLimit) {
      return {
        success: false,
        error: `기기 등록 한도(${maxLimit}대)를 초과했습니다. 기존 기기를 먼저 정리해 주세요.`
      };
    }

    // 🔐 기기 전용 비밀 토큰 신규 발급 (디스크엔 SHA-256 해시만 보관)
    issuedDeviceToken = generateDeviceToken();
    const tokenHash = hashApiKey(issuedDeviceToken);
    const nowIso = new Date().toISOString();

    user.devices[cleanDeviceId] = {
      deviceId: cleanDeviceId,
      deviceName: cleanDeviceName,
      tokenHash,
      firstSeen: existingDevice?.firstSeen || nowIso,
      lastSeen: nowIso,
      lastIp: cleanIp,
      status: 'active'
    };

    writeApiKeysData(list);
    console.log(`📱 [ApiKeyManager:OTPRegister] OTP 인증 기기 등록 & 비밀 토큰 발급 완료: '${cleanDeviceName}' (${cleanDeviceId}) ➔ '${user.memo}'`);
  }

  // 1회성 즉시 파기 (Replay Attack 방어)
  deviceOtpStore.delete(cleanCode);

  return {
    success: true,
    folderName: item.folderName,
    apiKey: item.apiKey,
    deviceToken: issuedDeviceToken
  };
}