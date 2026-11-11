/**
 * @file src/services/storage/storageContext.js
 * @description 스토리지 엔진 기반 컨텍스트, 경로 소독, 사용자 샌드박스 격리 및 공통 디스크 I/O 헬퍼 모듈
 * - 🛡️ [경로 소독 & 웹뷰 규격 일치] sanitizeFileName으로 대소괄호 보존 및 공백의 언더바(_) 치환
 * - 🎯 [6대 지능형 다중 후보군] generateFilenameCandidates로 NFC/NFD 유니코드 및 구버전 하위 호환 탐색 지원
 * - 👥 [다중 사용자 샌드박스 스코핑] resolveStorageContext로 data/users/{userFolder} 완전 격리
 * - 📊 [사용자 용량 한도 실측] checkUserStorageQuota로 디스크 실측 기반 할당량 통제
 * - 🔒 [보안 경로 검증] resolveSafeRelativePath로 심볼릭 링크 및 Path Traversal 실측 차단
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateSafePath } from '../../securityGuard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// src/services/storage/ -> src/services/ -> src/ -> 프로젝트 루트
export const ROOT_DIR = path.resolve(__dirname, '../../..');

// 기본 최상위 디렉터리 (루트 관리자 및 Fallback용)
export const BASE_BOOKS_DIR = path.resolve(ROOT_DIR, 'data/books');
export const BASE_SETTINGS_DIR = path.resolve(ROOT_DIR, 'data/settings');
export const BASE_ARCHIVE_DIR = path.resolve(ROOT_DIR, 'data/archive');
export const CRASH_REPORTS_DIR = path.resolve(ROOT_DIR, 'data/crash-reports');
export const USERS_DIR = path.resolve(ROOT_DIR, 'data/users');

/**
 * 🛡️ [경로 소독 및 언더바(_) 웹뷰 규격 일치화 헬퍼]
 * OS 파일시스템 금지 문자(< > : " / \ | ? *) 및 Path Traversal을 방어하면서,
 * 대괄호([]) 및 소괄호(())를 보존하고 공백(\s+)만 언더바(_)로 치환하여 웹뷰 규격과 100% 일치시킵니다.
 * @param {string} rawName 
 * @returns {string} 소독 및 언더바 처리된 표준 파일명
 */
export function sanitizeFileName(rawName = '') {
  if (!rawName || typeof rawName !== 'string') return '';
  return path.basename(rawName)
    .replace(/\s+/g, '_')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim();
}

/**
 * 🎯 [지능형 다중 후보 생성기]
 * 1. 신규 웹뷰 표준 규격 (대괄호 유지 + 공백만 언더바)
 * 2. 원본 공백 규격
 * 3. 과거 서버 구버전 규격 (대괄호가 _ 로 치환되어 남아있던 찌꺼기 파일 하위 호환)
 * 4. Linux NFD / NFC 자모 분리 방어 후보
 * @param {string} baseName 
 * @returns {Array<string>} 교차 탐색용 파일명 후보군
 */
export function generateFilenameCandidates(baseName = '') {
  if (!baseName) return [];
  const rawBase = baseName.trim();
  const sanitized = sanitizeFileName(rawBase);
  const withSpaces = sanitized.replace(/_+/g, ' ');

  // 🌟 과거 서버가 대괄호/특수문자를 전부 언더바로 치환했던 구버전 실물 파일 하위 호환 탐색 후보
  const legacySanitized = path.basename(rawBase)
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9가-힣._-]/g, '_')
    .trim();

  const set = new Set([
    sanitized,
    rawBase,
    withSpaces,
    legacySanitized,
    sanitized.normalize('NFC'),
    sanitized.normalize('NFD'),
    rawBase.normalize('NFC'),
    rawBase.normalize('NFD'),
    withSpaces.normalize('NFC'),
    withSpaces.normalize('NFD'),
    legacySanitized.normalize('NFC'),
    legacySanitized.normalize('NFD')
  ]);
  return Array.from(set).filter(Boolean);
}

/**
 * 🛡️ [상대 경로 안전 검증 헬퍼 - securityGuard 연동 실측]
 * 공유 폴더 내부 상대 경로가 심볼릭 링크나 상위 탐색을 통해 루트를 벗어나지 못하도록 실물 realpath 검증
 * @param {string} baseDir 
 * @param {string} relativePath 
 * @returns {string|null} 유효한 절대 실물 경로 또는 null
 */
export function resolveSafeRelativePath(baseDir, relativePath = '') {
  if (!baseDir || !relativePath) return null;
  const guardResult = validateSafePath(baseDir, relativePath);
  if (!guardResult.safe) {
    console.warn(`⛔ [SecurityGuard Blocked] 경로 이탈 또는 심볼릭 링크 탈출 차단: '${relativePath}' (사유: ${guardResult.reason})`);
    return null;
  }
  return guardResult.realPath;
}

/**
 * 디렉터리가 없을 경우 자동 생성 보장
 * @param {string} dirPath 
 */
export function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o755 });
  }
}

/**
 * JSON 파일 안전 읽기 헬퍼
 * @param {string} filePath 
 * @returns {any|null}
 */
export function readJsonSafely(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content || !content.trim()) return null;
    return JSON.parse(content);
  } catch (err) {
    console.warn(`⚠️ [StorageService] JSON 파싱 경고 ('${path.basename(filePath)}'):`, err.message);
    return null;
  }
}

/**
 * JSON 파일 원자적 쓰기 헬퍼
 * @param {string} filePath 
 * @param {any} data 
 */
export function writeJsonSafely(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp_${Date.now()}`;
  const jsonStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  fs.writeFileSync(tempPath, jsonStr, 'utf-8');
  fs.renameSync(tempPath, filePath);
}

/**
 * 특정 디렉터리의 실측 용량(Byte) 계산
 * @param {string} dirPath 
 * @returns {number}
 */
export function calculateDirSizeBytes(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let totalBytes = 0;
  try {
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const f of files) {
      const fullPath = path.join(dirPath, f.name);
      if (f.isDirectory()) {
        totalBytes += calculateDirSizeBytes(fullPath);
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
 * 👥 [사용자 전용 디렉터리 경로 동적 해석 헬퍼]
 * userFolder가 지정되면 data/users/{userFolder}/books, settings, archive 반환
 * userFolder가 없으면 기존 최상위 data/books, settings, archive 반환 (100% 하위 호환)
 * @param {string|null} [userFolder=null] 
 * @returns {{ booksDir: string, settingsDir: string, archiveDir: string, userRoot: string }}
 */
export function resolveStorageContext(userFolder = null) {
  if (!userFolder || typeof userFolder !== 'string') {
    return {
      booksDir: BASE_BOOKS_DIR,
      settingsDir: BASE_SETTINGS_DIR,
      archiveDir: BASE_ARCHIVE_DIR,
      userRoot: ROOT_DIR
    };
  }

  const cleanFolder = path.basename(userFolder.trim());
  const safeCheck = validateSafePath(USERS_DIR, cleanFolder);
  if (!safeCheck.safe) {
    console.warn(`⛔ [SecurityGuard Blocked] 유효하지 않은 사용자 폴더 접근: '${userFolder}'`);
    throw new Error('UNAUTHORIZED_USER_STORAGE_PATH');
  }

  const userRoot = safeCheck.realPath;
  const booksDir = path.join(userRoot, 'books');
  const settingsDir = path.join(userRoot, 'settings');
  const archiveDir = path.join(userRoot, 'archive');

  ensureDir(booksDir);
  ensureDir(settingsDir);
  ensureDir(archiveDir);

  return { booksDir, settingsDir, archiveDir, userRoot };
}

/**
 * 📊 [사용자 저장 용량 한도 실측 검사]
 * @param {string} userFolder 
 * @param {number} incomingBytes - 저장하려는 파일 바이트 수
 * @param {number} quotaBytes - 사용자 할당 용량 바이트 수
 * @returns {{ allowed: boolean, currentBytes: number, quotaBytes: number, remainingBytes: number }}
 */
export function checkUserStorageQuota(userFolder, incomingBytes = 0, quotaBytes = 1073741824) {
  if (!userFolder) return { allowed: true, currentBytes: 0, quotaBytes, remainingBytes: quotaBytes };

  const ctx = resolveStorageContext(userFolder);
  const currentBytes = calculateDirSizeBytes(ctx.userRoot);
  const willUseBytes = currentBytes + Number(incomingBytes || 0);

  return {
    allowed: willUseBytes <= quotaBytes,
    currentBytes,
    quotaBytes,
    remainingBytes: Math.max(0, quotaBytes - currentBytes)
  };
}