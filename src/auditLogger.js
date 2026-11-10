/**
 * @file src/auditLogger.js
 * @description 개인 서버 활동 링 버퍼(RAM) 및 다중 사용자 저장소 실측 집계 엔진
 * - 👥 [다중 사용자 실측 집계] data/users 하위 모든 서재의 도서 권수 및 실측 용량 60초 캐싱 집계
 * - 🔑 [스토리지 API 키 사용 추적] recordApiKeyUsage 탑재로 사용자 메모/서재별 실시간 연동 기기 관제
 * - 🚦 [30건 메모리 링 버퍼] 대시보드 실시간 표출용 30건 FIFO 안전 보관 (정상+차단 전체 관제)
 * - 📁 [보안 위협/실패 디스크 저장] status >= 400 (401, 403, 404, 405, 429, 500)만 선별 영구 저장
 * - 🧹 [민감정보 마스킹] securityGuard.maskSensitiveLog 연동으로 토큰/비밀번호 디스크/RAM 평문 노출 차단
 * - 📥 [로그 아카이브 관리 API] getLogFilesList, getFormattedLogContent, deleteLogFile 완비
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { maskSensitiveLog } from './securityGuard.js';
import { readEnvFile } from './envManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const DATA_DIR = path.resolve(ROOT_DIR, 'data');
const BOOKS_DIR = path.resolve(ROOT_DIR, 'data/books');
const ARCHIVE_DIR = path.resolve(ROOT_DIR, 'data/archive');
const CRASH_REPORTS_DIR = path.resolve(ROOT_DIR, 'data/crash-reports');
const LOGS_DIR = path.resolve(ROOT_DIR, 'data/logs');
const USERS_DIR = path.resolve(ROOT_DIR, 'data/users');

// 최대 보관 메모리 로그 건수 (대시보드 실시간용)
const MAX_LOGS_LIMIT = 30;

/**
 * 링 버퍼 메모리 로그 저장소
 */
const accessLogBuffer = [];

// 🔑 최근 스토리지 API 키 사용 현황 메모리 홀더
let lastApiKeyUsage = null;

// 디스크 용량 캐시 홀더 (60초 TTL)
let cachedStorageMetrics = null;
let lastMetricsCalculatedAt = 0;
const METRICS_CACHE_TTL_MS = 60 * 1000;

/**
 * User-Agent 헤더를 분석하여 한눈에 알아보기 쉬운 기기/브라우저 명칭으로 압축 정규화
 * @param {string} [ua=""] 
 * @returns {string}
 */
export function parseDeviceLabel(ua = "") {
  if (!ua || typeof ua !== 'string') return "Direct API / curl";

  const lower = ua.toLowerCase();

  let os = "Device";
  if (lower.includes("win")) os = "Windows";
  else if (lower.includes("android")) os = "Android";
  else if (lower.includes("iphone")) os = "iPhone";
  else if (lower.includes("ipad")) os = "iPad";
  else if (lower.includes("mac")) os = "Mac";
  else if (lower.includes("linux")) os = "Linux";

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
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const f of files) {
      const fullPath = path.join(dirPath, f.name);
      try {
        if (f.isDirectory()) {
          totalBytes += getDirectorySize(fullPath);
        } else if (f.isFile()) {
          totalBytes += fs.statSync(fullPath).size;
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

/**
 * 📁 [디스크 실시간 쓰기 헬퍼] 년/월/일 계층형 폴더 자동 생성 및 1줄 안전 추가
 * @param {Object} entry 
 */
function appendLogToDailyFile(entry) {
  try {
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');

    const targetDir = path.join(LOGS_DIR, year, month, day);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true, mode: 0o755 });
    }

    const logFileName = `audit-${entry.date}.jsonl`;
    const targetFile = path.join(targetDir, logFileName);

    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(targetFile, line, 'utf-8');
  } catch (err) {
    console.warn('⚠️ [AuditLogger:DiskWriteWarn] 일자별 로그 파일 저장 실패:', err.message);
  }
}

export const auditLogger = {
  /**
   * 🔑 [스토리지 API 키 사용 기록]
   * @param {Object} params
   * @param {string} params.ip - 접속 IP
   * @param {string} [params.userAgent=""] - 요청 User-Agent
   * @param {string} [params.path=""] - 요청 URL 경로
   * @param {string} [params.method="GET"] - HTTP 메서드
   * @param {string} [params.userMemo=""] - 사용자 식별 메모/이름
   */
  recordApiKeyUsage({ ip, userAgent = "", path = "", method = "GET", userMemo = "" }) {
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0];
    const dateStr = now.toISOString().split('T')[0];

    lastApiKeyUsage = {
      timestamp: timeStr,
      date: dateStr,
      fullTime: `${dateStr} ${timeStr}`,
      ip: ip || '127.0.0.1',
      device: parseDeviceLabel(userAgent),
      path: path || '/api/storage/...',
      method: method || 'GET',
      userMemo: userMemo || '일반 사용자'
    };
  },

  /**
   * 🔑 가장 최근에 API 키를 사용해 접속한 기기 정보 반환
   */
  getLastApiKeyUsage() {
    return lastApiKeyUsage;
  },

  /**
   * 새로운 서버 접근 및 동기화 활동 1건을 기록
   * @param {Object} params
   * @param {string} params.ip - 접속 IP
   * @param {string} [params.userAgent=""] - 요청 User-Agent
   * @param {string} params.action - 동작 설명
   * @param {string} [params.target="-"] - 파일명 또는 도서 식별자
   * @param {number} [params.status=200] - 응답 상태 코드
   */
  recordAccessLog({ ip, userAgent = "", action, target = "-", status = 200 }) {
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0];
    const dateStr = now.toISOString().split('T')[0];

    const sanitizedAction = maskSensitiveLog(action || '요청');
    const sanitizedTarget = maskSensitiveLog(target || '-');
    const statusCode = Number(status) || 200;

    const entry = {
      id: 'log_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      timestamp: timeStr,
      date: dateStr,
      ip: ip || '127.0.0.1',
      device: parseDeviceLabel(userAgent),
      action: sanitizedAction,
      target: sanitizedTarget,
      status: statusCode
    };

    if (accessLogBuffer.length >= MAX_LOGS_LIMIT) {
      accessLogBuffer.shift();
    }
    accessLogBuffer.push(entry);

    const isSecurityIncidentOrFailure = statusCode >= 400;
    if (isSecurityIncidentOrFailure) {
      appendLogToDailyFile(entry);
    }
  },

  getRecentLogs() {
    return [...accessLogBuffer].reverse();
  },

  getLogFilesList() {
    if (!fs.existsSync(LOGS_DIR)) return [];
    const results = [];

    function scanDirRecursively(currentDir) {
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            scanDirRecursively(fullPath);
          } else if (entry.isFile() && entry.name.startsWith('audit-') && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.json'))) {
            try {
              const stat = fs.statSync(fullPath);
              const relPath = path.relative(LOGS_DIR, fullPath).replace(/\\/g, '/');
              const dateMatch = entry.name.match(/audit-(\d{4}-\d{2}-\d{2})/);
              const dateStr = dateMatch ? dateMatch[1] : entry.name;

              const content = fs.readFileSync(fullPath, 'utf-8');
              const linesCount = content.trim().split('\n').filter(Boolean).length;

              results.push({
                date: dateStr,
                fileName: entry.name,
                relativePath: relPath,
                sizeBytes: stat.size,
                sizeKb: (stat.size / 1024).toFixed(1) + ' KB',
                linesCount
              });
            } catch (e) {}
          }
        }
      } catch (err) {}
    }

    scanDirRecursively(LOGS_DIR);
    results.sort((a, b) => b.date.localeCompare(a.date));
    return results;
  },

  getFormattedLogContent(relativePath) {
    if (!relativePath || !fs.existsSync(LOGS_DIR)) return null;

    const fullPath = path.resolve(LOGS_DIR, relativePath);
    if (!fullPath.startsWith(LOGS_DIR) || !fs.existsSync(fullPath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const parsedArray = lines.map(line => {
        try {
          return JSON.parse(line);
        } catch (e) {
          return { raw: line };
        }
      });
      return JSON.stringify(parsedArray, null, 2);
    } catch (err) {
      console.warn(`⚠️ [AuditLogger] 로그 내용 파싱 실패:`, err.message);
      return null;
    }
  },

  deleteLogFile(relativePath) {
    if (!relativePath || !fs.existsSync(LOGS_DIR)) return false;

    const fullPath = path.resolve(LOGS_DIR, relativePath);
    if (!fullPath.startsWith(LOGS_DIR) || !fs.existsSync(fullPath)) {
      return false;
    }

    try {
      fs.unlinkSync(fullPath);
      console.log(`🗑️ [AuditLogger] 일자별 로그 파일 삭제 완료: '${relativePath}'`);
      return true;
    } catch (err) {
      return false;
    }
  },

  /**
   * 💾 서버 저장소 실시간 현황 집계 (다중 사용자 폴더 data/users 합산 실측, 60초 캐싱 지원)
   * @param {boolean} [forceRefresh=false]
   */
  getStorageMetrics(forceRefresh = false) {
    const now = Date.now();

    if (!forceRefresh && cachedStorageMetrics && (now - lastMetricsCalculatedAt < METRICS_CACHE_TTL_MS)) {
      return cachedStorageMetrics;
    }

    const env = readEnvFile();
    const isStorageMode = env.STORAGE_MODE === 'true';

    // 1. 루트 서재 카운트
    let activeBooks = countFilesWithExt(BOOKS_DIR, '.json');
    let archivedBooks = countFilesWithExt(ARCHIVE_DIR, '.json');
    const crashReports = countFilesWithExt(CRASH_REPORTS_DIR, '.json');

    // 2. 👥 다중 사용자 서재(data/users/*) 도서 합산 집계
    if (isStorageMode && fs.existsSync(USERS_DIR)) {
      try {
        const userDirs = fs.readdirSync(USERS_DIR, { withFileTypes: true });
        for (const u of userDirs) {
          if (u.isDirectory()) {
            const userBooksDir = path.join(USERS_DIR, u.name, 'books');
            const userArchiveDir = path.join(USERS_DIR, u.name, 'archive');
            activeBooks += countFilesWithExt(userBooksDir, '.json');
            archivedBooks += countFilesWithExt(userArchiveDir, '.json');
          }
        }
      } catch (e) {}
    }

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