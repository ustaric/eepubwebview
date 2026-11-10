/**
 * @file src/apiKeyManager.js
 * @description 다중 사용자 API 키 발급, SHA-256 해싱, 24시간 수명 주기 및 사용자 디렉터리 생명주기 관리 엔진
 * - ⚙️ [저장 용량 사후 조절] updateUserQuota 탑재로 관리자가 사용자별 도서 할당 용량(MB) 실시간 변경 지원
 * - 👥 [보관 도서 합산 집계] getUserListForAdmin에서 books/ 및 archive/ 도서 권수 동시 실측
 * - 🔑 [SHA-256 단방향 해싱] 서버 디스크에는 해시값만 저장하여 비밀 키 원문 유출 원천 차단
 * - ⏳ [24시간 활성화 윈도우] 발급 후 24시간 내 미접속 시 EXPIRED 자동 만료 및 고아 폴더 회수
 * - 🟢 [원터치 활성화] 발급 후 24시간 내 최초 1회 인증 성공 시 ACTIVE 상태로 자동 영구 활성화
 * - 📁 [사용자 샌드박스 골격 자동 생성] user_xxxx 채번 시 books/, settings/, archive/ 디렉터리 즉시 준비
 * - 🔄 [무손실 재발급] 키 분실 시 기존 도서/설정 100% 보존 상태로 새 API 키만 교체 발급
 * - 🛡️ [원자적 메타데이터 저장] .tmp 쓰기 후 renameSync 교체로 프로세스 강제 종료 시 JSON 깨짐 원천 방어
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

/**
 * @typedef {Object} ApiKeyRecord
 * @property {string} folderName - 할당된 고유 폴더명 (예: user_a7b8c9d0)
 * @property {string} memo - 관리자가 입력한 사용자 식별 메모/이름
 * @property {string} keyHash - API 키의 SHA-256 해시값 (64자리 hex)
 * @property {'admin' | 'user'} role - 사용자 권한
 * @property {'PENDING' | 'ACTIVE' | 'EXPIRED' | 'REVOKED'} status - 현재 키 상태
 * @property {number} storageQuotaBytes - 최대 허용 저장 용량 (Byte)
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
}

/**
 * JSON 파일 안전 읽기 헬퍼
 * @returns {Array<ApiKeyRecord>}
 */
function readApiKeysData() {
  if (!fs.existsSync(API_KEYS_FILE)) return [];
  try {
    const content = fs.readFileSync(API_KEYS_FILE, 'utf-8');
    if (!content || !content.trim()) return [];
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('⚠️ [ApiKeyManager] api-keys.json 파싱 실패:', err.message);
    return [];
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
   * @param {string} [options.role="user"] - 역할 ("admin" | "user")
   * @returns {{ apiKey: string, folderName: string, memo: string, expiresAt: string, quotaMb: number }}
   */
  issueApiKey({ memo = '새 사용자', quotaMb = 1024, role = 'user' } = {}) {
    ensureDir(USERS_DIR);
    ensureDir(path.dirname(API_KEYS_FILE));

    // 1. 임의 고유 폴더명 채번 및 물리 골격(books, settings, archive) 생성
    const folderName = generateUniqueFolderName();
    const userRoot = path.join(USERS_DIR, folderName);
    ensureDir(path.join(userRoot, 'books'));
    ensureDir(path.join(userRoot, 'settings'));
    ensureDir(path.join(userRoot, 'archive'));

    // 2. 무작위 비밀 API 키 생성 (sk_live_...)
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
      status: 'PENDING', // PENDING (24시간 내 활성화 대기) ➔ ACTIVE (인증 성공)
      storageQuotaBytes: Math.max(10, Number(quotaMb) || 1024) * 1024 * 1024,
      createdAt: new Date(now).toISOString(),
      activatedAt: null,
      expiresAt: expiresAt, // 등록 마감 시각 (24시간 후)
      lastAccessedAt: null
    };

    const list = readApiKeysData();
    list.push(record);
    writeJsonAtomic(API_KEYS_FILE, list);

    console.log(`🔑 [ApiKeyManager:Issued] 새 API 키 발급 완료: 폴더='${folderName}', 메모='${record.memo}', 마감='${expiresAt}'`);

    return {
      apiKey,
      folderName,
      memo: record.memo,
      expiresAt: record.expiresAt,
      quotaMb: Math.round(record.storageQuotaBytes / 1024 / 1024)
    };
  },

  /**
   * 🛡️ [API 키 인증 및 24시간 활성화 상태 전이]
   * @param {string} rawKey - 클라이언트가 전달한 원문 API 키
   * @returns {ApiKeyAuthResult}
   */
  authenticateApiKey(rawKey = '') {
    if (!rawKey || typeof rawKey !== 'string') {
      return { authenticated: false, reason: 'API_KEY_EMPTY' };
    }

    const keyHash = hashApiKey(rawKey);
    const list = readApiKeysData();
    const index = list.findIndex(item => item.keyHash === keyHash);

    if (index === -1) {
      return { authenticated: false, reason: 'API_KEY_NOT_FOUND' };
    }

    const user = list[index];
    const now = Date.now();

    // 1. 이미 폐기된 키 거절
    if (user.status === 'REVOKED') {
      return { authenticated: false, reason: 'API_KEY_REVOKED' };
    }

    // 2. 24시간 등록 윈도우 만료 여부 판정 (PENDING 상태 검사)
    if (user.status === 'PENDING') {
      const deadline = new Date(user.expiresAt).getTime();
      if (now > deadline) {
        user.status = 'EXPIRED';
        list[index] = user;
        writeJsonAtomic(API_KEYS_FILE, list);
        console.warn(`⏳ [ApiKeyManager:Expired] 24시간 내 미접속으로 키 만료: 폴더='${user.folderName}'`);
        return { authenticated: false, reason: 'API_KEY_EXPIRED' };
      }

      // 🌟 [핵심] 24시간 내 최초 1회 정상 접근 성공 ➔ ACTIVE 영구 활성화 전이!
      user.status = 'ACTIVE';
      user.activatedAt = new Date(now).toISOString();
      user.expiresAt = null; // 활성화 완료 후 만료 해제 (관리자가 폐기할 때까지 유지)
      console.log(`✨ [ApiKeyManager:Activated] 사용자 서재가 성공적으로 활성화되었습니다: 폴더='${user.folderName}'`);
    } else if (user.status === 'EXPIRED') {
      return { authenticated: false, reason: 'API_KEY_EXPIRED' };
    }

    // 3. 마지막 접근 시각 갱신
    user.lastAccessedAt = new Date(now).toISOString();
    list[index] = user;
    writeJsonAtomic(API_KEYS_FILE, list);

    // 4. 대상 사용자 전용 물리 경로 검증
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
        userRootPath: safeCheck.realPath
      }
    };
  },

  /**
   * 🔄 [무손실 키 재발급] 기존 도서/설정 폴더를 100% 보존하면서 새 API 키로 교체 발급
   * @param {string} folderName - 대상 사용자 폴더명
   * @returns {{ success: boolean, newApiKey?: string, folderName?: string, memo?: string, expiresAt?: string, error?: string }}
   */
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

    // 기존 도서 및 설정 폴더는 그대로 보존하고 키와 24시간 활성화 기한만 갱신
    list[index].keyHash = newHash;
    list[index].status = 'PENDING';
    list[index].expiresAt = expiresAt;
    list[index].activatedAt = null;

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

  /**
   * ⚙️ [사용자별 도서 저장 용량 실시간 변경]
   * @param {string} folderName - 대상 사용자 폴더명
   * @param {number} quotaMb - 변경할 새 할당 용량 (MB 단위)
   * @returns {{ success: boolean, folderName?: string, quotaMb?: number, memo?: string, error?: string }}
   */
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

  /**
   * 🗑️ [API 키 폐기 및 선택적 도서 폴더 영구 삭제]
   * @param {string} folderName - 삭제할 사용자 폴더명
   * @param {boolean} [deleteFolder=false] - 도서/설정 폴더 디스크 물리 삭제 여부
   * @returns {{ success: boolean, error?: string }}
   */
  revokeApiKey(folderName = '', deleteFolder = false) {
    if (!folderName) return { success: false, error: '폴더명이 지정되지 않았습니다.' };

    const list = readApiKeysData();
    const index = list.findIndex(item => item.folderName === folderName);
    if (index === -1) {
      return { success: false, error: '해당 사용자를 찾을 수 없습니다.' };
    }

    // 1. 메타데이터에서 제거
    list.splice(index, 1);
    writeJsonAtomic(API_KEYS_FILE, list);

    // 2. 도서 폴더 디스크 파쇄 (관리자 선택 시)
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
   * 🧹 [24시간 미등록 고아 폴더 자동 정리]
   * 24시간 동안 활성화되지 않고 만료된 PENDING 키 및 빈 폴더 디스크 청소
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
          console.log(`🧹 [ApiKeyManager:Cleanup] 24시간 미사용 고아 폴더 정리: '${item.folderName}'`);
          const userRoot = path.join(USERS_DIR, item.folderName);
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

    if (changed) {
      writeJsonAtomic(API_KEYS_FILE, list);
    }
  },

  /**
   * 📊 [관리자 대시보드 표출용 사용자 목록 및 실측 용량 조회]
   * @returns {Array<Object>}
   */
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
        createdAt: u.createdAt,
        activatedAt: u.activatedAt,
        expiresAt: u.expiresAt,
        remainingHours,
        lastAccessedAt: u.lastAccessedAt
      };
    });
  }
};