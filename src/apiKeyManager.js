/**
 * @file src/apiKeyManager.js
 * @description 다중 사용자 API 키 발급, SHA-256 해싱, 24시간 수명 주기, 기기별 비밀 토큰(deviceToken) 바인딩 및 6자리 단기 OTP 관리 엔진
 * - 🛡️ [2중 기기 위조 원천 방어] 유효 API 키 + X-Device-Id + 기기별 X-Device-Token(SHA-256 해시 + timingSafeEqual) 다중 바인딩 검증
 * - 🧬 [프로토타입 오염 방어] __proto__/constructor 등 금지 deviceId 차단 및 Object.hasOwn 안전 조회 적용
 * - 📱 [최초 1호기 명시 등록] 등록 기기 0대 상태에서만 registerOrVerifyDevice를 통해 마스터 deviceToken 발급 (GET /api/health 자동 발급 차단)
 * - 🔢 [6자리 OTP 기기 토큰 발급·갱신] verifyAndExchangeDeviceOtp 성공 시 게스트 기기를 승인 장부에 등록하고 새 deviceToken 발급
 * - 📱 [기기 식별 및 개별 밴] verifyAndTouchDevice 탑재로 접속 기기 식별, 접속 이력 갱신 및 특정 기기 차단(Ban) 지원
 * - 📱 [계정당 기기 슬롯 거버넌스] updateUserMaxDevices 탑재로 기본 6대 기기 한도 검증 및 관리자 실시간 조절 지원
 * - ⚙️ [저장 용량 사후 조절] updateUserQuota 탑재로 관리자가 사용자별 도서 할당 용량(MB) 실시간 변경 지원
 * - 👥 [보관 도서 합산 집계] getUserListForAdmin에서 books/ 및 archive/ 도서 권수 동시 실측
 * - 🔑 [SHA-256 단방향 해싱] 서버 디스크에는 API 키 및 기기 토큰의 해시값만 저장하여 원문 유출 원천 차단
 * - ⏳ [24시간 활성화 윈도우 & 재발급 서재 보호] 신규 미사용 키만 고아 폴더 회수, 재발급·기존 데이터 보유 서재는 EXPIRED 전환 후 도서 보존
 * - 🟢 [원터치 활성화] 발급 후 24시간 내 최초 1회 인증 성공 시 ACTIVE 상태로 자동 영구 활성화
 * - 📁 [사용자 샌드박스 골격 자동 생성] user_xxxx 채번 시 books/, settings/, archive/ 디렉터리 즉시 준비
 * - 🔄 [무손실 재발급] 키 분실 시 기존 도서/설정/기기 100% 보존 상태로 새 API 키만 교체 발급
 * - 🛡️ [원자적 메타데이터 저장 & 쓰기 스로틀링] .tmp 쓰기 후 renameSync 교체 + 인메모리 캐시/60초 Flush로 디스크 I/O 병목 완화
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { validateSafePath } from './securityGuard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const USERS_DIR = path.resolve(ROOT_DIR, 'data/users');
const API_KEYS_FILE = path.resolve(ROOT_DIR, 'data/api/api-keys.json');

// 기본 24시간 활성화 윈도우 (밀리초 단위: 24시간)
const ACTIVATION_WINDOW_MS = 24 * 60 * 60 * 1000;

// 기본 계정당 최대 허용 기기 수
const DEFAULT_MAX_DEVICES = 6;

// 🔢 6자리 기기 연결 OTP 유효 시간 (3분: 180,000ms)
const OTP_TTL_MS = 3 * 60 * 1000;

// ⚡ 단순 접속 시각(lastAccessedAt / lastSeen) 디스크 쓰기 스로틀링 주기 (60초)
const TOUCH_FLUSH_INTERVAL_MS = 60 * 1000;

// 🧬 객체 프로토타입 오염 방지용 금지 deviceId 키 목록
const FORBIDDEN_OBJECT_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString'
]);

/** @type {Array<ApiKeyRecord>|null} */
let cachedApiKeysList = null;
let cachedFileMtimeMs = 0;
let isApiKeysDirty = false;
let lastApiKeysDiskFlushAt = 0;

/**
 * 🔒 6자리 일회용 연결 번호 인메모리 저장소
 * @type {Map<string, { code: string, folderName: string, apiKey: string, expiresAt: number }>}
 */
const deviceOtpStore = new Map();

/**
 * 1분마다 만료된 OTP 청소 및 지연된 접속 이력 디스크 반영
 */
setInterval(() => {
  const now = Date.now();
  for (const [code, item] of deviceOtpStore.entries()) {
    if (now > item.expiresAt) {
      deviceOtpStore.delete(code);
    }
  }
  flushDirtyApiKeys();
}, 60 * 1000);

// 프로세스 정상 종료 시 미반영 접속 이력 동기 저장
process.on('exit', () => {
  flushDirtyApiKeys(true);
});

/**
 * @typedef {Object} DeviceRecord
 * @property {string} deviceId - 클라이언트 고유 기기 식별자
 * @property {string} deviceName - 기기 모델/브라우저 라벨
 * @property {string} [tokenHash] - 기기 전용 비밀 토큰(X-Device-Token)의 SHA-256 해시값
 * @property {string} firstSeen - 최초 등록 일시 (ISO)
 * @property {string} lastSeen - 마지막 접속 일시 (ISO)
 * @property {string} lastIp - 마지막 접속 IP
 * @property {'active' | 'blocked'} status - 기기 접근 상태
 */

/**
 * @typedef {Object} ApiKeyRecord
 * @property {string} folderName - 할당된 고유 폴더명 (예: user_a7b8c9d0)
 * @property {string} memo - 관리자가 입력한 사용자 식별 메모/이름
 * @property {string} keyHash - API 키의 SHA-256 해시값 (64자리 hex)
 * @property {'admin' | 'user'} role - 사용자 권한
 * @property {'PENDING' | 'ACTIVE' | 'EXPIRED' | 'REVOKED'} status - 현재 키 상태
 * @property {number} storageQuotaBytes - 최대 허용 저장 용량 (Byte)
 * @property {number} [maxDevices=6] - 최대 등록 허용 기기 수
 * @property {Record<string, DeviceRecord>} [devices={}] - 등록된 기기 목록
 * @property {boolean} [isReissued=false] - 기존 서재에서 재발급된 키 여부
 * @property {string} createdAt - 발급 시각 (ISO)
 * @property {string|null} activatedAt - 최초 접속 활성화 시각 (ISO)
 * @property {string|null} expiresAt - 24시간 활성화 마감 시각 (ISO)
 * @property {string|null} lastAccessedAt - 마지막 API 호출 시각 (ISO)
 */

/**
 * @typedef {Object} ApiKeyAuthResult
 * @property {boolean} authenticated - 인증 성공 여부
 * @property {string} [reason] - 실패 사유 (API_KEY_EMPTY, NOT_FOUND, EXPIRED, REVOKED 등)
 * @property {Object} [user] - 인증 성공 시 사용자 컨텍스트 정보
 * @property {string} user.folderName - 사용자 전용 폴더명
 * @property {string} user.memo - 사용자 식별 메모
 * @property {string} user.role - 사용자 역할
 * @property {number} user.storageQuotaBytes - 할당 용량 (Byte)
 * @property {string} user.userRootPath - 사용자 물리 디렉터리 절대 경로
 * @property {number} user.maxDevices - 최대 허용 기기 수
 */

/**
 * 디렉터리가 없을 경우 자동 생성 보장
 * @param {string} dirPath 
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o755 });
  }
}

/**
 * SHA-256 단방향 해싱 헬퍼
 * @param {string} rawKey 
 * @returns {string} 64자리 16진수 해시 문자열
 */
export function hashApiKey(rawKey = '') {
  if (!rawKey || typeof rawKey !== 'string') return '';
  return crypto.createHash('sha256').update(rawKey.trim()).digest('hex');
}

/**
 * 상수 시간(Constant-Time) 해시 문자열 대조 헬퍼
 * @param {string} hexA 
 * @param {string} hexB 
 * @returns {boolean}
 */
function safeEqualHex(hexA = '', hexB = '') {
  if (!hexA || !hexB || typeof hexA !== 'string' || typeof hexB !== 'string') return false;
  if (hexA.length !== hexB.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(hexA, 'utf8'), Buffer.from(hexB, 'utf8'));
  } catch (_) {
    return false;
  }
}

/**
 * 기기 고유 식별자(deviceId) 정규화 및 프로토타입 오염 방지 검증 헬퍼
 * @param {string} rawDeviceId 
 * @returns {string|null} 안전하게 정제된 deviceId (유효하지 않으면 null)
 */
function sanitizeDeviceId(rawDeviceId = '') {
  if (!rawDeviceId || typeof rawDeviceId !== 'string') return null;
  const trimmed = rawDeviceId.trim();
  if (!trimmed || trimmed.length > 64) return null;
  if (FORBIDDEN_OBJECT_KEYS.has(trimmed)) return null;
  if (/[\s/\\<>"'`\x00-\x1f]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * 기기 전용 랜덤 비밀 토큰 생성 (192-bit)
 * @returns {string}
 */
function generateDeviceToken() {
  return `dt_${crypto.randomBytes(24).toString('hex')}`;
}

/**
 * JSON 파일 원자적 쓰기 헬퍼 (파일 손상 및 프로세스 강제 종료 원천 방어)
 * @param {string} filePath 
 * @param {any} data 
 */
function writeJsonAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const jsonStr = JSON.stringify(data, null, 2);
  fs.writeFileSync(tempPath, jsonStr, 'utf-8');
  fs.renameSync(tempPath, filePath);

  if (filePath === API_KEYS_FILE) {
    cachedApiKeysList = Array.isArray(data) ? data : [];
    isApiKeysDirty = false;
    lastApiKeysDiskFlushAt = Date.now();
    try {
      cachedFileMtimeMs = fs.statSync(API_KEYS_FILE).mtimeMs;
    } catch (e) {}
  }
}

/**
 * 스로틀링된 접속 이력(dirty 상태)을 조건 충족 시 디스크에 일괄 반영합니다.
 * @param {boolean} [force=false] - 경과 시간 무시 강제 저장 여부
 */
function flushDirtyApiKeys(force = false) {
  if (!isApiKeysDirty || !cachedApiKeysList) return;
  const now = Date.now();
  if (!force && (now - lastApiKeysDiskFlushAt) < TOUCH_FLUSH_INTERVAL_MS) {
    return;
  }

  try {
    writeJsonAtomic(API_KEYS_FILE, cachedApiKeysList);
  } catch (err) {
    console.warn('⚠️ [ApiKeyManager] 지연 접속 이력 디스크 저장 실패 (다음 주기에 재시도):', err.message);
  }
}

/**
 * JSON 파일 안전 읽기 헬퍼 (인메모리 캐시 우선, 외부 변경 시 자동 리로드)
 * @returns {Array<ApiKeyRecord>}
 */
function readApiKeysData() {
  if (!fs.existsSync(API_KEYS_FILE)) {
    cachedApiKeysList = [];
    cachedFileMtimeMs = 0;
    isApiKeysDirty = false;
    return cachedApiKeysList;
  }

  try {
    const stat = fs.statSync(API_KEYS_FILE);
    if (cachedApiKeysList !== null && (isApiKeysDirty || stat.mtimeMs === cachedFileMtimeMs)) {
      return cachedApiKeysList;
    }

    const content = fs.readFileSync(API_KEYS_FILE, 'utf-8');
    if (!content || !content.trim()) {
      cachedApiKeysList = [];
    } else {
      const parsed = JSON.parse(content);
      cachedApiKeysList = Array.isArray(parsed) ? parsed : [];
    }
    cachedFileMtimeMs = stat.mtimeMs;
    isApiKeysDirty = false;
    return cachedApiKeysList;
  } catch (err) {
    console.error('⚠️ [ApiKeyManager] api-keys.json 파싱 실패:', err.message);
    return cachedApiKeysList || [];
  }
}

/**
 * 특정 디렉터리의 실측 용량(Byte) 재귀 계산
 * @param {string} dirPath 
 * @returns {number}
 */
function getDirectorySize(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let totalBytes = 0;
  try {
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const f of files) {
      const fullPath = path.join(dirPath, f.name);
      if (f.isDirectory()) {
        totalBytes += getDirectorySize(fullPath);
      } else if (f.isFile()) {
        try {
          totalBytes += fs.statSync(fullPath).size;
        } catch (e) {}
      }
    }
  } catch (e) {}
  return totalBytes;
}

/**
 * 중복 없는 임의 폴더명(user_xxxx) 자동 채번
 * @returns {string}
 */
function generateUniqueFolderName() {
  ensureDir(USERS_DIR);
  let folderName = '';
  let exists = true;
  let attempts = 0;

  while (exists && attempts < 100) {
    const randomHex = crypto.randomBytes(4).toString('hex'); // 8자리 hex
    folderName = `user_${randomHex}`;
    const targetPath = path.join(USERS_DIR, folderName);
    exists = fs.existsSync(targetPath);
    attempts++;
  }

  return folderName;
}

export const apiKeyManager = {
  /**
   * 🎲 [신규 API 키 발급 및 서재 폴더 골격 즉시 생성]
   * @param {Object} options
   * @param {string} [options.memo="새 사용자"] - 사용자 식별 메모/이름
   * @param {number} [options.quotaMb=1024] - 할당 도서 저장 용량 (MB 단위, 기본 1GB)
   * @param {number} [options.maxDevices=6] - 최대 등록 허용 기기 수 (기본 6대)
   * @param {string} [options.role="user"] - 역할 ("admin" | "user")
   * @returns {{ apiKey: string, folderName: string, memo: string, expiresAt: string, quotaMb: number, maxDevices: number }}
   */
  issueApiKey({ memo = '새 사용자', quotaMb = 1024, maxDevices = DEFAULT_MAX_DEVICES, role = 'user' } = {}) {
    ensureDir(USERS_DIR);
    ensureDir(path.dirname(API_KEYS_FILE));

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
    writeJsonAtomic(API_KEYS_FILE, list);

    console.log(`🔑 [ApiKeyManager:Issued] 새 API 키 발급 완료: 폴더='${folderName}', 메모='${record.memo}', 마감='${expiresAt}', 기기한도=${record.maxDevices}대`);

    return {
      apiKey,
      folderName,
      memo: record.memo,
      expiresAt: record.expiresAt,
      quotaMb: Math.round(record.storageQuotaBytes / 1024 / 1024),
      maxDevices: record.maxDevices
    };
  },

  /**
   * 🛡️ [API 키 인증 및 24시간 활성화 상태 전이]
   * @param {string} rawKey - 클라이언트가 전달한 원문 API 키
   * @param {{ activatePending?: boolean }} [options={}] - PENDING 키의 즉시 ACTIVE 전이 여부
   * @returns {ApiKeyAuthResult}
   */
  authenticateApiKey(rawKey = '', { activatePending = true } = {}) {
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
        writeJsonAtomic(API_KEYS_FILE, list);
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
      isApiKeysDirty = true;

      if (mustFlushImmediately || (now - lastApiKeysDiskFlushAt) >= TOUCH_FLUSH_INTERVAL_MS) {
        writeJsonAtomic(API_KEYS_FILE, list);
      }
    }

    const safeCheck = validateSafePath(USERS_DIR, user.folderName);
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
  },

  /* ========================================================================= */
  /* 🔢 3분 유효 6자리 일회용 연결 번호 (OTP) 엔진                               */
  /* ========================================================================= */

  issueDeviceOtp(folderName, rawApiKey) {
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
  },

  /**
   * 🔢 [Guest 기기] 6자리 연결 번호 검증, 기기 정식 등록, 기기 비밀 토큰(deviceToken) 발급 및 API 키 교환 (1회성 파쇄)
   * @param {string} inputCode - 6자리 숫자 코드
   * @param {Object} [deviceInfo] - 게스트 기기 식별 정보
   * @param {string} [deviceInfo.deviceId]
   * @param {string} [deviceInfo.deviceName]
   * @param {string} [deviceInfo.clientIp]
   * @returns {{ success: boolean, folderName?: string, apiKey?: string, deviceToken?: string|null, error?: string }}
   */
  verifyAndExchangeDeviceOtp(inputCode, { deviceId = '', deviceName = '', clientIp = '' } = {}) {
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
        writeJsonAtomic(API_KEYS_FILE, list);
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

      writeJsonAtomic(API_KEYS_FILE, list);
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
  },

  /* ========================================================================= */
  /* 📱 기기 화이트리스트 + deviceToken 바인딩 검증 & 마스터 등록                */
  /* ========================================================================= */

  /**
   * 🔑 [POST /api/auth/device/register 전용]
   * - 등록 기기가 0대인 최초 상태: 1번째 마스터 기기로 등록하고 새 `deviceToken`을 발급합니다.
   * - 이미 기기가 1대 이상 등록된 상태: 동일 `deviceId` + 유효한 `deviceToken`을 가진 기기만 통과시키며, 미등록·토큰불일치·차단 기기는 모두 거부합니다.
   * @param {string} folderName 
   * @param {Object} [params={}] 
   * @returns {{ allowed: boolean, newlyRegistered?: boolean, deviceToken?: string|null, reason?: string, message?: string, device?: DeviceRecord|null }}
   */
  registerOrVerifyDevice(folderName, { deviceId, deviceName = '', deviceToken = '', clientIp = '' } = {}) {
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

    // 1. 이미 등록된 기기인 경우: 반드시 기존 tokenHash와 일치하는 X-Device-Token이 있어야 통과
    if (existingDevice) {
      if (existingDevice.status === 'blocked') {
        return { allowed: false, reason: 'DEVICE_BLOCKED', device: existingDevice };
      }
      if (!existingDevice.tokenHash || !deviceToken || typeof deviceToken !== 'string' || !deviceToken.trim()) {
        return {
          allowed: false,
          reason: 'DEVICE_TOKEN_REQUIRED',
          message: '보안 기기 토큰이 필요합니다. 6자리 연결 번호로 로그인하거나 관리자 페이지에서 기존 기기 슬롯을 삭제한 뒤 다시 연결해 주세요.'
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
      writeJsonAtomic(API_KEYS_FILE, list);
      return { allowed: true, newlyRegistered: false, deviceToken: null, device: existingDevice };
    }

    const currentDeviceCount = Object.keys(user.devices).length;

    // 2. 최초 0대 상태일 때만 1호기(Master) 등록 및 비밀 토큰 발급 허용
    if (currentDeviceCount === 0) {
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
      writeJsonAtomic(API_KEYS_FILE, list);
      console.log(`📱 [ApiKeyManager:MasterRegistered] 1번째 마스터 기기 등록 & 토큰 발급 완료: '${cleanDeviceName}' (${cleanDeviceId}) ➔ '${user.memo}' (1/${maxLimit}대)`);
      return { allowed: true, newlyRegistered: true, deviceToken: issuedDeviceToken, device: newDevice };
    }

    // 3. 이미 1대 이상 등록된 상태에서 미등록 기기는 자동 등록 불가
    return {
      allowed: false,
      reason: 'DEVICE_UNREGISTERED',
      message: '등록되지 않았거나 삭제된 기기입니다. 6자리 번호로 다시 로그인해 주세요.'
    };
  },

  /**
   * 접속 기기의 유효성과 기기별 비밀 토큰(X-Device-Token) 일치 여부를 엄격 검증합니다.
   * - `deviceId` 누락/위조 키: `DEVICE_ID_REQUIRED`
   * - 등록 기기 0대 상태: `MASTER_DEVICE_REGISTRATION_REQUIRED` (GET 요청에서 비밀 토큰 자동 발급 차단)
   * - 등록 기기 `tokenHash` 부재 또는 `X-Device-Token` 누락: `DEVICE_TOKEN_REQUIRED`
   * - `X-Device-Token` 해시 불일치: `DEVICE_TOKEN_INVALID`
   * - 미등록 기기(1대 이상 존재): `DEVICE_UNREGISTERED`
   * @param {string} folderName 
   * @param {Object} [params={}] 
   * @param {string} [params.deviceId]
   * @param {string} [params.deviceName]
   * @param {string} [params.deviceToken]
   * @param {string} [params.clientIp]
   * @returns {{ allowed: boolean, reason?: string, message?: string, device?: DeviceRecord|null }}
   */
  verifyAndTouchDevice(folderName, { deviceId, deviceName = '', deviceToken = '', clientIp = '' } = {}) {
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
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();

    const device = Object.hasOwn(user.devices, cleanDeviceId) ? user.devices[cleanDeviceId] : null;

    // 1. 이미 정식 등록된 기기인 경우
    if (device) {
      if (device.status === 'blocked') {
        const isIpChanged = device.lastIp !== cleanIp;
        device.lastSeen = now;
        device.lastIp = cleanIp;
        isApiKeysDirty = true;
        if (isIpChanged || (nowMs - lastApiKeysDiskFlushAt) >= TOUCH_FLUSH_INTERVAL_MS) {
          writeJsonAtomic(API_KEYS_FILE, list);
        }
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
      isApiKeysDirty = true;

      if (isNameChanged || isIpChanged || (nowMs - lastApiKeysDiskFlushAt) >= TOUCH_FLUSH_INTERVAL_MS) {
        writeJsonAtomic(API_KEYS_FILE, list);
      }
      return { allowed: true, device };
    }

    const currentDeviceCount = Object.keys(user.devices).length;

    // 2. 등록 기기가 0대인 최초 상태: 명시적 POST /api/auth/device/register를 통해 마스터 등록 유도
    if (currentDeviceCount === 0) {
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
  },

  getUserDevices(folderName = '') {
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
  },

  blockDevice(folderName, deviceId) {
    const cleanId = sanitizeDeviceId(deviceId);
    if (!folderName || !cleanId) return { success: false, error: '인자가 유효하지 않습니다.' };

    const list = readApiKeysData();
    const user = list.find(item => item.folderName === folderName);
    if (!user || !user.devices || !Object.hasOwn(user.devices, cleanId)) {
      return { success: false, error: '해당 기기를 찾을 수 없습니다.' };
    }

    user.devices[cleanId].status = 'blocked';
    writeJsonAtomic(API_KEYS_FILE, list);
    console.log(`⛔ [ApiKeyManager:DeviceBlocked] 기기 차단됨: '${cleanId}' ➔ 사용자: '${user.memo}'`);

    return { success: true, device: user.devices[cleanId] };
  },

  unblockDevice(folderName, deviceId) {
    const cleanId = sanitizeDeviceId(deviceId);
    if (!folderName || !cleanId) return { success: false, error: '인자가 유효하지 않습니다.' };

    const list = readApiKeysData();
    const user = list.find(item => item.folderName === folderName);
    if (!user || !user.devices || !Object.hasOwn(user.devices, cleanId)) {
      return { success: false, error: '해당 기기를 찾을 수 없습니다.' };
    }

    user.devices[cleanId].status = 'active';
    writeJsonAtomic(API_KEYS_FILE, list);
    console.log(`🟢 [ApiKeyManager:DeviceUnblocked] 기기 차단 해제됨: '${cleanId}' ➔ 사용자: '${user.memo}'`);

    return { success: true, device: user.devices[cleanId] };
  },

  deleteDevice(folderName, deviceId) {
    const cleanId = sanitizeDeviceId(deviceId);
    if (!folderName || !cleanId) return { success: false, error: '인자가 유효하지 않습니다.' };

    const list = readApiKeysData();
    const user = list.find(item => item.folderName === folderName);
    if (!user || !user.devices || !Object.hasOwn(user.devices, cleanId)) {
      return { success: false, error: '해당 기기를 찾을 수 없습니다.' };
    }

    delete user.devices[cleanId];
    writeJsonAtomic(API_KEYS_FILE, list);
    console.log(`🗑️ [ApiKeyManager:DeviceDeleted] 기기 삭제 및 슬롯 반환: '${cleanId}' ➔ 사용자: '${user.memo}'`);

    return { success: true };
  },

  updateUserMaxDevices(folderName = '', maxDevices = DEFAULT_MAX_DEVICES) {
    if (!folderName) return { success: false, error: '폴더명이 지정되지 않았습니다.' };

    const list = readApiKeysData();
    const index = list.findIndex(item => item.folderName === folderName);
    if (index === -1) {
      return { success: false, error: '해당 사용자를 찾을 수 없습니다.' };
    }

    const validLimit = Math.max(1, Math.min(50, parseInt(maxDevices, 10) || DEFAULT_MAX_DEVICES));
    list[index].maxDevices = validLimit;

    writeJsonAtomic(API_KEYS_FILE, list);
    console.log(`⚙️ [ApiKeyManager:MaxDevicesUpdated] 사용자('${folderName}') 최대 기기 한도 변경: ${validLimit} 대`);

    return { success: true, folderName, maxDevices: validLimit, memo: list[index].memo };
  },

  reissueApiKey(folderName = '') {
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

    writeJsonAtomic(API_KEYS_FILE, list);
    console.log(`🔄 [ApiKeyManager:Reissued] API 키 재발급 완료 (폴더 보존): '${folderName}' ➔ 새 만료기한: ${expiresAt}`);

    return {
      success: true,
      newApiKey,
      folderName,
      memo: list[index].memo,
      expiresAt
    };
  },

  updateUserQuota(folderName = '', quotaMb = 1024) {
    if (!folderName) return { success: false, error: '폴더명이 지정되지 않았습니다.' };

    const list = readApiKeysData();
    const index = list.findIndex(item => item.folderName === folderName);
    if (index === -1) {
      return { success: false, error: '해당 사용자를 찾을 수 없습니다.' };
    }

    const validMb = Math.max(50, Math.min(1024000, parseInt(quotaMb, 10) || 1024));
    list[index].storageQuotaBytes = validMb * 1024 * 1024;

    writeJsonAtomic(API_KEYS_FILE, list);
    console.log(`⚙️ [ApiKeyManager:QuotaUpdated] 사용자('${folderName}') 저장 용량 변경 완료: ${validMb} MB`);

    return {
      success: true,
      folderName,
      quotaMb: validMb,
      memo: list[index].memo
    };
  },

  revokeApiKey(folderName = '', deleteFolder = false) {
    if (!folderName) return { success: false, error: '폴더명이 지정되지 않았습니다.' };

    const list = readApiKeysData();
    const index = list.findIndex(item => item.folderName === folderName);
    if (index === -1) {
      return { success: false, error: '해당 사용자를 찾을 수 없습니다.' };
    }

    list.splice(index, 1);
    writeJsonAtomic(API_KEYS_FILE, list);

    if (deleteFolder) {
      const userRoot = path.join(USERS_DIR, folderName);
      const safeCheck = validateSafePath(USERS_DIR, folderName);
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
  },

  /**
   * 🧹 24시간 활성화 기한이 지난 PENDING 계정을 정리합니다.
   * - 최초 발급 후 1번도 사용하지 않은 빈 고아 폴더만 삭제 회수합니다.
   * - 재발급(isReissued) 계정, 기존 등록 기기 또는 저장 파일이 존재하는 서재는 폴더를 삭제하지 않고 EXPIRED 상태로 전환해 데이터를 보존합니다.
   */
  cleanupExpiredPendingKeys() {
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
            const safeCheck = validateSafePath(USERS_DIR, item.folderName);
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
      writeJsonAtomic(API_KEYS_FILE, list);
    }
  },

  getUserListForAdmin() {
    this.cleanupExpiredPendingKeys();
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
};