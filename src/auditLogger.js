/**
 * @file src/auditLogger.js
 * @description 개인 서버 활동 링 버퍼(Ring Buffer) 로깅 및 디스크/도서 현황 실시간 집계 전담 모듈
 * - 🚦 [30건 메모리 링 버퍼] IP, 브라우저/기기 식별자, 작업 유형, 상태 코드를 최대 30건 FIFO 안전 보관
 * - 🧹 [민감정보 마스킹 탑재] securityGuard.maskSensitiveLog 연동으로 토큰/비밀번호 로그 RAM 노출 원천 차단
 * - 💾 [디스크/도서 메트릭 집계] books/ 및 archive/ 권수, 크래시 리포트 수, 실측 디스크 용량(MB) 60초 캐싱 연산
 * - 📱 [지능형 User-Agent 정규화] 복잡한 UA 문자열을 "Windows Chrome", "Galaxy Samsung Internet", "iPhone Safari" 등으로 깔끔하게 변환
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { maskSensitiveLog } from './securityGuard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const DATA_DIR = path.resolve(ROOT_DIR, 'data');
const BOOKS_DIR = path.resolve(ROOT_DIR, 'data/books');
const ARCHIVE_DIR = path.resolve(ROOT_DIR, 'data/archive');
const CRASH_REPORTS_DIR = path.resolve(ROOT_DIR, 'data/crash-reports');

// 최대 보관 로그 건수 (메모리 고정 한도)
const MAX_LOGS_LIMIT = 30;

/**
 * @typedef {Object} AccessLogEntry
 * @property {string} id - 고유 로그 ID
 * @property {string} timestamp - 발생 시각 (HH:mm:ss)
 * @property {string} date - 발생 일자 (YYYY-MM-DD)
 * @property {string} ip - 접속 IP
 * @property {string} device - 정규화된 기기/브라우저 명칭
 * @property {string} action - 동작 유형 (스냅샷, EPUB 다운로드, 표지, 저장, 삭제 등)
 * @property {string} target - 대상 파일명 또는 도서 ID (마스킹 적용)
 * @property {number} status - HTTP 응답 코드 (200, 403, 404, 429 등)
 */

/**
 * 링 버퍼 메모리 로그 저장소
 * @type {Array<AccessLogEntry>}
 */
const accessLogBuffer = [];

// 디스크 용량 캐시 홀더 (60초 TTL)
let cachedStorageMetrics = null;
let lastMetricsCalculatedAt = 0;
const METRICS_CACHE_TTL_MS = 60 * 1000;

/**
 * User-Agent 헤더를 분석하여 한눈에 알아보기 쉬운 기기/브라우저 명칭으로 압축 정규화
 * @param {string} [ua=""] 
 * @returns {string} 예: "Windows (Chrome)", "Galaxy (Samsung Internet)", "iPhone (Safari)"
 */
export function parseDeviceLabel(ua = "") {
  if (!ua || typeof ua !== 'string') return "Direct API / curl";

  const lower = ua.toLowerCase();

  // 1. OS 감지
  let os = "Device";
  if (lower.includes("win")) os = "Windows";
  else if (lower.includes("android")) os = "Android";
  else if (lower.includes("iphone")) os = "iPhone";
  else if (lower.includes("ipad")) os = "iPad";
  else if (lower.includes("mac")) os = "Mac";
  else if (lower.includes("linux")) os = "Linux";

  // 2. 브라우저 감지
  let browser = "Web";
  if (lower.includes("samsungbrowser")) browser = "Samsung Internet";
  else if (lower.includes("whale")) browser = "Naver Whale";
  else if (lower.includes("edg")) browser = "Edge";
  else if (lower.includes("chrome") && !lower.includes("chromium")) browser = "Chrome";
  else if (lower.includes("safari") && !lower.includes("chrome")) browser = "Safari";
  else if (lower.includes("firefox")) browser = "Firefox";
  else if (lower.includes("curl")) return "Terminal (curl)";

  return `${os} (${browser})`;
}

/**
 * 특정 디렉터리의 실측 용량(Byte)을 재귀적으로 계산
 * @param {string} dirPath 
 * @returns {number} 총 바이트 수
 */
function getDirectorySize(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let totalBytes = 0;

  try {
    const files = fs.readdirSync(dirPath);
    for (const f of files) {
      const fullPath = path.join(dirPath, f);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          totalBytes += getDirectorySize(fullPath);
        } else {
          totalBytes += stat.size;
        }
      } catch (e) {}
    }
  } catch (e) {}

  return totalBytes;
}

/**
 * 특정 디렉터리 내의 특정 확장자 파일 개수 카운트
 * @param {string} dirPath 
 * @param {string} ext 
 * @returns {number}
 */
function countFilesWithExt(dirPath, ext) {
  if (!fs.existsSync(dirPath)) return 0;
  try {
    const files = fs.readdirSync(dirPath);
    return files.filter(f => f.endsWith(ext)).length;
  } catch (e) {
    return 0;
  }
}

export const auditLogger = {
  /**
   * 새로운 서버 접근 및 동기화 활동 1건을 링 버퍼에 기록 (민감정보 마스킹 자동 적용)
   * @param {Object} params
   * @param {string} params.ip - 접속 IP
   * @param {string} [params.userAgent=""] - 요청 User-Agent
   * @param {string} params.action - 동작 설명 (예: "스냅샷 조회", "도서 보관")
   * @param {string} [params.target="-"] - 파일명 또는 도서 식별자
   * @param {number} [params.status=200] - 응답 상태 코드
   */
  recordAccessLog({ ip, userAgent = "", action, target = "-", status = 200 }) {
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0]; // HH:mm:ss
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD

    // 🛡️ [로그 소독] action 및 target에 섞인 비밀번호나 토큰 실시간 마스킹
    const sanitizedAction = maskSensitiveLog(action || '요청');
    const sanitizedTarget = maskSensitiveLog(target || '-');

    const entry = {
      id: 'log_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      timestamp: timeStr,
      date: dateStr,
      ip: ip || '127.0.0.1',
      device: parseDeviceLabel(userAgent),
      action: sanitizedAction,
      target: sanitizedTarget,
      status: Number(status) || 200
    };

    // FIFO: 최대 한도 초과 시 가장 오래된 1건 밀어내기
    if (accessLogBuffer.length >= MAX_LOGS_LIMIT) {
      accessLogBuffer.shift();
    }
    accessLogBuffer.push(entry);
  },

  /**
   * 최근 보관된 로그 목록 반환 (최신순 역순 정렬)
   * @returns {Array<AccessLogEntry>}
   */
  getRecentLogs() {
    return [...accessLogBuffer].reverse();
  },

  /**
   * 💾 서버 저장소 실시간 현황 집계 (60초 캐싱 지원)
   * @param {boolean} [forceRefresh=false]
   * @returns {{
   *   activeBooksCount: number,
   *   archivedBooksCount: number,
   *   crashReportsCount: number,
   *   totalDataSizeMb: string,
   *   totalDataSizeBytes: number,
   *   lastCalculatedAt: string
   * }}
   */
  getStorageMetrics(forceRefresh = false) {
    const now = Date.now();

    if (!forceRefresh && cachedStorageMetrics && (now - lastMetricsCalculatedAt < METRICS_CACHE_TTL_MS)) {
      return cachedStorageMetrics;
    }

    const activeBooks = countFilesWithExt(BOOKS_DIR, '.json');
    const archivedBooks = countFilesWithExt(ARCHIVE_DIR, '.json');
    const crashReports = countFilesWithExt(CRASH_REPORTS_DIR, '.json');
    const totalBytes = getDirectorySize(DATA_DIR);
    const sizeMb = (totalBytes / (1024 * 1024)).toFixed(1);

    cachedStorageMetrics = {
      activeBooksCount: activeBooks,
      archivedBooksCount: archivedBooks,
      crashReportsCount: crashReports,
      totalDataSizeMb: `${sizeMb} MB`,
      totalDataSizeBytes: totalBytes,
      lastCalculatedAt: new Date(now).toTimeString().split(' ')[0]
    };
    lastMetricsCalculatedAt = now;

    return cachedStorageMetrics;
  }
};