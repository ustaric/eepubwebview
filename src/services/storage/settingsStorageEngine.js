/**
 * @file src/services/storage/settingsStorageEngine.js
 * @description 전역 환경설정, 독서 통계, 업적, 볼트 마스터키, 묘비 및 뷰어 크래시 리포트 전담 I/O 엔진
 * - ⚙️ [전역 설정 I/O] 사용자 샌드박스별 settings/ 폴더 자동 라우팅 및 안전 쓰기
 * - 🔬 [크래시 리포트 I/O] 사용자 샌드박스별 crash-reports/ 격리 저장 및 관리자 통합 조회·다운로드·정리 지원
 * - 🛡️ [경로 보안 실측] validateSafePath 기반 파일명 소독 및 디스크 탈출 차단
 */

import fs from 'fs';
import path from 'path';
import { validateSafePath } from '../../securityGuard.js';
import {
  CRASH_REPORTS_DIR,
  USERS_DIR,
  sanitizeFileName,
  ensureDir,
  readJsonSafely,
  writeJsonSafely,
  resolveStorageContext
} from './storageContext.js';

// =========================================================================
// ⚙️ 1. 전역 설정, 통계, 업적, 묘비 전용 I/O
// =========================================================================

/**
 * 전역 설정 JSON 파일 저장
 * @param {string} fileName 
 * @param {any} data 
 * @param {string|null} [userFolder=null]
 * @returns {boolean}
 */
export function saveSettingsFile(fileName, data, userFolder = null) {
  const safeName = sanitizeFileName(fileName);
  if (!safeName) throw new Error('유효하지 않은 설정 파일명입니다.');

  const ctx = resolveStorageContext(userFolder);
  ensureDir(ctx.settingsDir);
  const targetFile = path.join(ctx.settingsDir, safeName);

  const pathCheck = validateSafePath(ctx.settingsDir, safeName);
  if (!pathCheck.safe) {
    throw new Error(`안전하지 않은 설정 경로: ${pathCheck.reason}`);
  }

  writeJsonSafely(targetFile, data);
  console.log(`⚙️ [StorageService:SettingsSaved] 설정 파일 저장 완료: '${safeName}' (경로: ${ctx.settingsDir})`);
  return true;
}

/**
 * 전역 설정 JSON 파일 읽기
 * @param {string} fileName 
 * @param {string|null} [userFolder=null]
 * @returns {any|null}
 */
export function getSettingsFile(fileName, userFolder = null) {
  const safeName = sanitizeFileName(fileName);
  if (!safeName) return null;

  const ctx = resolveStorageContext(userFolder);
  const pathCheck = validateSafePath(ctx.settingsDir, safeName);
  if (!pathCheck.safe) return null;

  const targetFile = path.join(ctx.settingsDir, safeName);
  return readJsonSafely(targetFile);
}

// =========================================================================
// 🔬 2. 크래시 리포트 전용 I/O (사용자 샌드박스 격리 + 관리자 통합 조회 지원)
// =========================================================================

/**
 * 조회/삭제 대상 크래시 리포트 디렉터리 목록 수집 헬퍼
 * @param {string|null} [userFolder=null] - 특정 사용자 폴더만 지정 시 해당 폴더만 반환, null이면 전체 사용자+루트 통합 탐색
 * @returns {Array<{ dir: string, userFolder: string }>}
 */
function getTargetCrashReportDirs(userFolder = null) {
  if (userFolder && typeof userFolder === 'string') {
    const ctx = resolveStorageContext(userFolder);
    return [{ dir: ctx.crashReportsDir, userFolder: path.basename(userFolder.trim()) }];
  }

  const dirs = [{ dir: CRASH_REPORTS_DIR, userFolder: 'root' }];
  if (fs.existsSync(USERS_DIR)) {
    try {
      const entries = fs.readdirSync(USERS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const safeUserCheck = validateSafePath(USERS_DIR, entry.name);
        if (!safeUserCheck.safe || !safeUserCheck.realPath) continue;
        const userCrashDir = path.join(safeUserCheck.realPath, 'crash-reports');
        if (fs.existsSync(userCrashDir)) {
          dirs.push({ dir: userCrashDir, userFolder: entry.name });
        }
      }
    } catch (_) {}
  }
  return dirs;
}

/**
 * 뷰어 조판 결함 및 크래시 리포트 저장 (사용자별 crash-reports/ 폴더 격리 저장)
 * @param {string} fileName 
 * @param {any} data 
 * @param {string|null} [userFolder=null]
 * @returns {boolean}
 */
export function saveCrashReport(fileName, data, userFolder = null) {
  const safeName = sanitizeFileName(fileName);
  if (!safeName) throw new Error('유효하지 않은 크래시 리포트 파일명입니다.');

  const ctx = resolveStorageContext(userFolder);
  const targetDir = ctx.crashReportsDir;
  ensureDir(targetDir);
  const targetFile = path.join(targetDir, safeName);

  const pathCheck = validateSafePath(targetDir, safeName);
  if (!pathCheck.safe) {
    throw new Error(`안전하지 않은 크래시 리포트 경로: ${pathCheck.reason}`);
  }

  writeJsonSafely(targetFile, data);
  console.log(`🔬 [StorageService] 크래시 리포트 저장 완료: '${safeName}' (폴더: ${userFolder || 'root'})`);
  return true;
}

/**
 * 수집된 크래시 리포트 파일 목록 조회 (userFolder 미지정 시 전체 사용자+루트 통합 수집)
 * @param {string|null} [userFolder=null]
 * @returns {Array<Object>}
 */
export function getCrashReportsList(userFolder = null) {
  const targetDirs = getTargetCrashReportDirs(userFolder);
  const reports = [];

  for (const entry of targetDirs) {
    if (!fs.existsSync(entry.dir)) continue;

    let files = [];
    try {
      files = fs.readdirSync(entry.dir);
    } catch (_) {
      continue;
    }

    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const pathCheck = validateSafePath(entry.dir, f);
      if (!pathCheck.safe || !pathCheck.realPath) continue;

      try {
        const stat = fs.statSync(pathCheck.realPath);
        if (!stat.isFile()) continue;
        const data = readJsonSafely(pathCheck.realPath);
        reports.push({
          fileName: f,
          userFolder: entry.userFolder,
          sizeBytes: stat.size,
          sizeKb: (stat.size / 1024).toFixed(1) + ' KB',
          createdAt: stat.mtime.toISOString(),
          totalAnomalies: data?.totalAnomaliesCount || (Array.isArray(data?.anomalies) ? data.anomalies.length : 1),
          reportType: data?.reportType || 'crash_report'
        });
      } catch (e) {}
    }
  }

  reports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return reports;
}

/**
 * 특정 크래시 리포트 파일 경로 및 크기 반환
 * @param {string} fileName 
 * @param {string|null} [userFolder=null]
 * @returns {{ filePath: string, size: number } | null}
 */
export function getCrashReportPath(fileName, userFolder = null) {
  const safeName = sanitizeFileName(fileName);
  if (!safeName) return null;

  const targetDirs = getTargetCrashReportDirs(userFolder);
  for (const entry of targetDirs) {
    if (!fs.existsSync(entry.dir)) continue;

    const pathCheck = validateSafePath(entry.dir, safeName);
    if (!pathCheck.safe) continue;

    const fullPath = path.join(entry.dir, safeName);
    if (fs.existsSync(fullPath)) {
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        return { filePath: fullPath, size: stat.size };
      }
    }
  }

  return null;
}

/**
 * 단일 크래시 리포트 파일 삭제
 * @param {string} fileName 
 * @param {string|null} [userFolder=null]
 * @returns {boolean}
 */
export function deleteCrashReport(fileName, userFolder = null) {
  const safeName = sanitizeFileName(fileName);
  if (!safeName) return false;

  const targetDirs = getTargetCrashReportDirs(userFolder);
  for (const entry of targetDirs) {
    if (!fs.existsSync(entry.dir)) continue;

    const pathCheck = validateSafePath(entry.dir, safeName);
    if (!pathCheck.safe) continue;

    const fullPath = path.join(entry.dir, safeName);
    if (fs.existsSync(fullPath)) {
      try {
        fs.unlinkSync(fullPath);
        return true;
      } catch (e) {
        return false;
      }
    }
  }

  return false;
}

/**
 * 수집된 모든 크래시 리포트 파일 일괄 삭제
 * @param {string|null} [userFolder=null]
 * @returns {number} 삭제된 리포트 개수
 */
export function clearAllCrashReports(userFolder = null) {
  const targetDirs = getTargetCrashReportDirs(userFolder);
  let count = 0;

  for (const entry of targetDirs) {
    if (!fs.existsSync(entry.dir)) continue;

    let files = [];
    try {
      files = fs.readdirSync(entry.dir);
    } catch (_) {
      continue;
    }

    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const pathCheck = validateSafePath(entry.dir, f);
      if (!pathCheck.safe) continue;

      try {
        fs.unlinkSync(path.join(entry.dir, f));
        count++;
      } catch (e) {}
    }
  }

  return count;
}