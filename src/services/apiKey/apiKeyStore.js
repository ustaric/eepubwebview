/**
 * @file src/services/apiKey/apiKeyStore.js
 * @description API 키·기기 장부(api-keys.json) 단일 진실 공급원(SSOT) 스토어, 인메모리 캐시, 60초 쓰기 스로틀링 및 해시/경로 보안 유틸리티
 * - 🛡️ [원자적 쓰기 & 캐시 동기화] .tmp 쓰기 후 renameSync 교체 + mtime 기반 외부 변경 감지
 * - ⏱️ [60초 쓰기 스로틀링 SSOT] touchApiKeysData / flushDirtyApiKeys / 60초 타이머 / process.on('exit') 일체 관리
 * - 🔑 [SHA-256 해싱 & 상수 시간 비교] hashApiKey 및 safeEqualHex 제공
 * - 🧬 [프로토타입 오염 방어] sanitizeDeviceId를 통해 예약어·특수문자 차단
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { validateSafePath } from '../../securityGuard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../../..');

export const USERS_DIR = path.resolve(ROOT_DIR, 'data/users');
export const API_KEYS_FILE = path.resolve(ROOT_DIR, 'data/api/api-keys.json');

// 기본 24시간 활성화 윈도우 (밀리초 단위: 24시간)
export const ACTIVATION_WINDOW_MS = 24 * 60 * 60 * 1000;

// 기본 계정당 최대 허용 기기 수
export const DEFAULT_MAX_DEVICES = 6;

// ⚡ 단순 접속 시각(lastAccessedAt / lastSeen) 디스크 쓰기 스로틀링 주기 (60초)
export const TOUCH_FLUSH_INTERVAL_MS = 60 * 1000;

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

/** @type {Array<Object>|null} */
let cachedApiKeysList = null;
let cachedFileMtimeMs = 0;
let isApiKeysDirty = false;
let lastApiKeysDiskFlushAt = 0;

// 1분마다 지연된 접속 이력 디스크 반영
setInterval(() => {
  flushDirtyApiKeys(false);
}, TOUCH_FLUSH_INTERVAL_MS);

// 프로세스 정상 종료 시 미반영 접속 이력 동기 저장
process.on('exit', () => {
  flushDirtyApiKeys(true);
});

/**
 * 디렉터리가 없을 경우 자동 생성 보장
 * @param {string} dirPath
 * @returns {void}
 */
export function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o755 });
  }
}

/**
 * SHA-256 단방향 해싱 헬퍼
 * @param {string} [rawKey='']
 * @returns {string} 64자리 16진수 해시 문자열
 */
export function hashApiKey(rawKey = '') {
  if (!rawKey || typeof rawKey !== 'string') return '';
  return crypto.createHash('sha256').update(rawKey.trim()).digest('hex');
}

/**
 * 상수 시간(Constant-Time) 해시 문자열 대조 헬퍼
 * @param {string} [hexA='']
 * @param {string} [hexB='']
 * @returns {boolean}
 */
export function safeEqualHex(hexA = '', hexB = '') {
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
 * @param {string} [rawDeviceId='']
 * @returns {string|null} 안전하게 정제된 deviceId (유효하지 않으면 null)
 */
export function sanitizeDeviceId(rawDeviceId = '') {
  if (!rawDeviceId || typeof rawDeviceId !== 'string') return null;
  const trimmed = rawDeviceId.trim();
  if (!trimmed || trimmed.length > 64) return null;
  if (FORBIDDEN_OBJECT_KEYS.has(trimmed)) return null;
  if (/[\s/\\<>"'`\x00-\x1f]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * 특정 디렉터리의 실측 용량(Byte) 재귀 계산
 * @param {string} dirPath
 * @returns {number}
 */
export function getDirectorySize(dirPath) {
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
export function generateUniqueFolderName() {
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

/**
 * 사용자 폴더명 경로 안전성 검증 래퍼
 * @param {string} folderName
 * @returns {{ safe: boolean, realPath?: string, reason?: string }}
 */
export function validateUserDirectory(folderName) {
  return validateSafePath(USERS_DIR, folderName);
}

/**
 * API 키 장부(api-keys.json) 안전 읽기 헬퍼 (인메모리 캐시 우선, 외부 변경 시 자동 리로드)
 * @returns {Array<Object>}
 */
export function readApiKeysData() {
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
 * API 키 장부(api-keys.json) 원자적 쓰기 헬퍼 (.tmp 작성 후 renameSync 교체)
 * @param {Array<Object>} data
 * @returns {void}
 */
export function writeApiKeysData(data) {
  ensureDir(path.dirname(API_KEYS_FILE));
  const tempPath = `${API_KEYS_FILE}.tmp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const jsonStr = JSON.stringify(data, null, 2);
  fs.writeFileSync(tempPath, jsonStr, 'utf-8');
  fs.renameSync(tempPath, API_KEYS_FILE);

  cachedApiKeysList = Array.isArray(data) ? data : [];
  isApiKeysDirty = false;
  lastApiKeysDiskFlushAt = Date.now();
  try {
    cachedFileMtimeMs = fs.statSync(API_KEYS_FILE).mtimeMs;
  } catch (e) {}
}

/**
 * 단순 접속 시각/IP 변경 등을 60초 쓰기 스로틀링 규칙에 맞춰 캐시에 표시하거나 즉시 디스크에 기록합니다.
 * @param {Array<Object>} list - 갱신된 API 키 목록 배열
 * @param {{ immediate?: boolean }} [options={}] - 즉시 디스크 커밋 여부
 * @returns {void}
 */
export function touchApiKeysData(list, { immediate = false } = {}) {
  cachedApiKeysList = Array.isArray(list) ? list : [];
  isApiKeysDirty = true;

  const now = Date.now();
  if (immediate || (now - lastApiKeysDiskFlushAt) >= TOUCH_FLUSH_INTERVAL_MS) {
    writeApiKeysData(cachedApiKeysList);
  }
}

/**
 * 스로틀링된 접속 이력(dirty 상태)을 조건 충족 시 디스크에 일괄 반영합니다.
 * @param {boolean} [force=false] - 경과 시간 무시 강제 저장 여부
 * @returns {void}
 */
export function flushDirtyApiKeys(force = false) {
  if (!isApiKeysDirty || !cachedApiKeysList) return;
  const now = Date.now();
  if (!force && (now - lastApiKeysDiskFlushAt) < TOUCH_FLUSH_INTERVAL_MS) {
    return;
  }

  try {
    writeApiKeysData(cachedApiKeysList);
  } catch (err) {
    console.warn('⚠️ [ApiKeyManager] 지연 접속 이력 디스크 저장 실패 (다음 주기에 재시도):', err.message);
  }
}