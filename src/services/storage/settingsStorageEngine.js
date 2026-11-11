/**
 * @file src/services/storage/settingsStorageEngine.js
 * @description 전역 환경설정, 독서 통계, 업적, 볼트 마스터키, 묘비 및 뷰어 크래시 리포트 전담 I/O 엔진
 * - ⚙️ [전역 설정 I/O] 사용자 샌드박스별 settings/ 폴더 자동 라우팅 및 안전 쓰기
 * - 🔬 [크래시 리포트 I/O] 뷰어 조판 결함 및 오류 리포트 실시간 디스크 저장/목록 조회/정리
 * - 🛡️ [경로 보안 실측] validateSafePath 기반 파일명 소독 및 디스크 탈출 차단
 */

import fs from 'fs';
import path from 'path';
import { validateSafePath } from '../../securityGuard.js';
import {
  CRASH_REPORTS_DIR,
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
// 🔬 2. 크래시 리포트 전용 I/O
// =========================================================================

/**
 * 뷰어 조판 결함 및 크래시 리포트 저장
 * @param {string} fileName 
 * @param {any} data 
 * @returns {boolean}
 */
export function saveCrashReport(fileName, data) {
  const safeName = sanitizeFileName(fileName);
  if (!safeName) throw new Error('유효하지 않은 크래시 리포트 파일명입니다.');

  ensureDir(CRASH_REPORTS_DIR);
  const targetFile = path.join(CRASH_REPORTS_DIR, safeName);

  const pathCheck = validateSafePath(CRASH_REPORTS_DIR, safeName);
  if (!pathCheck.safe) {
    throw new Error(`안전하지 않은 크래시 리포트 경로: ${pathCheck.reason}`);
  }

  writeJsonSafely(targetFile, data);
  console.log(`🔬 [StorageService] 크래시 리포트 저장 완료: '${safeName}'`);
  return true;
}

/**
 * 수집된 크래시 리포트 파일 목록 조회
 * @returns {Array<Object>}
 */
export function getCrashReportsList() {
  ensureDir(CRASH_REPORTS_DIR);
  const files = fs.readdirSync(CRASH_REPORTS_DIR);
  const reports = [];

  for (const f of files) {
    if (f.endsWith('.json')) {
      const fullPath = path.join(CRASH_REPORTS_DIR, f);
      try {
        const stat = fs.statSync(fullPath);
        const data = readJsonSafely(fullPath);
        reports.push({
          fileName: f,
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
 * @returns {{ filePath: string, size: number } | null}
 */
export function getCrashReportPath(fileName) {
  const safeName = sanitizeFileName(fileName);
  if (!safeName) return null;

  const pathCheck = validateSafePath(CRASH_REPORTS_DIR, safeName);
  if (!pathCheck.safe) return null;

  const fullPath = path.join(CRASH_REPORTS_DIR, safeName);
  if (fs.existsSync(fullPath)) {
    const stat = fs.statSync(fullPath);
    return { filePath: fullPath, size: stat.size };
  }
  return null;
}

/**
 * 단일 크래시 리포트 파일 삭제
 * @param {string} fileName 
 * @returns {boolean}
 */
export function deleteCrashReport(fileName) {
  const safeName = sanitizeFileName(fileName);
  if (!safeName) return false;

  const pathCheck = validateSafePath(CRASH_REPORTS_DIR, safeName);
  if (!pathCheck.safe) return false;

  const fullPath = path.join(CRASH_REPORTS_DIR, safeName);
  if (fs.existsSync(fullPath)) {
    try {
      fs.unlinkSync(fullPath);
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
}

/**
 * 수집된 모든 크래시 리포트 파일 일괄 삭제
 * @returns {number} 삭제된 리포트 개수
 */
export function clearAllCrashReports() {
  ensureDir(CRASH_REPORTS_DIR);
  const files = fs.readdirSync(CRASH_REPORTS_DIR);
  let count = 0;

  for (const f of files) {
    if (f.endsWith('.json')) {
      try {
        fs.unlinkSync(path.join(CRASH_REPORTS_DIR, f));
        count++;
      } catch (e) {}
    }
  }
  return count;
}