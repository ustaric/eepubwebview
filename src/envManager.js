/**
 * @file src/envManager.js
 * @description .env 환경 설정 파일 파싱, 저장, 민감정보 마스킹/덮어쓰기 방어 및 로컬 스토리지 필수 디렉터리 생성 전담 모듈
 * - 🐳 [Docker 볼륨 영속성 지원] ENV_FILE_PATH 지정 또는 루트 .env 미존재 시 ./data/.env 자동 사용으로 컨테이너 업데이트 시 설정 보존
 * - 🛡️ [환경변수 무누락 보존] ENABLE_ROOT_API_KEY, DISCORD_ALERT_TYPES, DISCORD_DAILY_DIGEST 포함 전 18대 환경변수 영구 보존
 * - 🔒 [민감정보 마스킹 및 덮어쓰기 방어] maskSecretValue / isMaskedSecretValue 제공 및 writeEnvFile 내 마스킹/빈값 덮어쓰기 원천 차단
 * - 🔔 [Discord 알림 필터 영구 기록] 전체 해제 시 'NONE' 보존 및 로그 유무 조건부 정기보고 설정 .env 각인
 * - 👥 [다중 사용자 저장소 준비] ./data/users 및 ./data/api 디렉터리 자동 권한 세팅 지원
 * - 🔑 [루트 API 키 스위치 및 보안 키 지원] ENABLE_ROOT_API_KEY(기본 false)로 루트 마스터 키 인증 On/Off 제어
 * - 📁 [공유 도서 라이브러리 지원] SHARED_BOOKS_DIR 경로를 .env에 무손실 저장
 * - 📁 [저장소 디렉터리 세팅] 0o755 권한으로 디렉터리 안전 자동 생성
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 루트 디렉터리 기준 경로 고정 (src/ 상위)
const ROOT_DIR = path.resolve(__dirname, '..');
const ROOT_ENV_PATH = path.resolve(ROOT_DIR, '.env');
const DATA_ENV_PATH = path.resolve(ROOT_DIR, 'data/.env');

const DISCORD_WEBHOOK_PREFIX = 'https://discord.com/api/webhooks/';

const KNOWN_ENV_KEYS = [
  'PORT',
  'HOST',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'TOKEN_ENCRYPTION_KEY',
  'TOKEN_FILE',
  'ALLOWED_ORIGIN',
  'STORAGE_MODE',
  'SHARED_BOOKS_DIR',
  'ADMIN_PASSWORD',
  'READER_URL',
  'STORAGE_API_KEY',
  'ENABLE_ROOT_API_KEY',
  'ENFORCE_STORAGE_API_KEY',
  'DISCORD_WEBHOOK_URL',
  'DISCORD_ALERT_TYPES',
  'DISCORD_DAILY_DIGEST'
];

// 마스킹 문자열로 덮어쓰기를 차단할 민감 환경변수 목록
const PROTECTED_SECRET_KEYS = new Set([
  'ADMIN_PASSWORD',
  'GOOGLE_CLIENT_SECRET',
  'TOKEN_ENCRYPTION_KEY',
  'STORAGE_API_KEY',
  'DISCORD_WEBHOOK_URL'
]);

// 명시적 초기화 옵션 없이는 빈 문자열('')로 덮어쓰기를 허용하지 않을 비밀키 목록
const NON_EMPTY_SECRET_KEYS = new Set([
  'ADMIN_PASSWORD',
  'GOOGLE_CLIENT_SECRET',
  'TOKEN_ENCRYPTION_KEY',
  'STORAGE_API_KEY'
]);

/**
 * 🐳 실행 환경에 맞는 .env 파일 경로를 결정합니다.
 * - ENV_FILE_PATH 환경변수 지정 시 최우선
 * - 기존 루트 .env가 파일로 존재하면 하위 호환을 위해 유지
 * - 그 외(신규 Docker 컨테이너 등)는 볼륨 마운트 대상인 ./data/.env 사용
 * @returns {string}
 */
function resolveEnvPath() {
  if (process.env.ENV_FILE_PATH && process.env.ENV_FILE_PATH.trim()) {
    return path.resolve(ROOT_DIR, process.env.ENV_FILE_PATH.trim());
  }
  try {
    if (fs.existsSync(ROOT_ENV_PATH) && fs.statSync(ROOT_ENV_PATH).isFile()) {
      return ROOT_ENV_PATH;
    }
  } catch (e) {}
  return DATA_ENV_PATH;
}

export const ENV_PATH = resolveEnvPath();

/**
 * 🔒 민감 값(웹훅 URL, API 키, 비밀키)을 화면/API 응답 표시용으로 안전하게 마스킹합니다.
 * @param {string} value - 원본 문자열
 * @returns {string} 마스킹된 문자열 (빈 값이면 '')
 */
export function maskSecretValue(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith(DISCORD_WEBHOOK_PREFIX)) {
    const rest = trimmed.slice(DISCORD_WEBHOOK_PREFIX.length);
    if (rest.length <= 8) {
      return `${DISCORD_WEBHOOK_PREFIX}••••••••`;
    }
    return `${DISCORD_WEBHOOK_PREFIX}••••••••${rest.slice(-4)}`;
  }

  if (trimmed.length <= 8) {
    return '••••••••';
  }
  return `${trimmed.slice(0, 4)}••••••••${trimmed.slice(-4)}`;
}

/**
 * 🛡️ 전달된 문자열이 마스킹된 플레이스홀더인지 판별합니다.
 * @param {string} value - 검사할 문자열
 * @returns {boolean} 마스킹 값 여부
 */
export function isMaskedSecretValue(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;

  if (trimmed.includes('••••')) return true;
  if (/^[•*]{4,}$/.test(trimmed)) return true;

  return false;
}

/**
 * 📁 .env 파일 읽기 헬퍼 (파일 미정의 항목은 Docker/OS process.env fallback 지원)
 * @returns {Record<string, string>}
 */
export function readEnvFile() {
  const envData = {};

  if (fs.existsSync(ENV_PATH)) {
    const content = fs.readFileSync(ENV_PATH, 'utf-8');
    content.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const idx = trimmed.indexOf('=');
        const key = trimmed.substring(0, idx).trim();
        const val = trimmed.substring(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        envData[key] = val;
      }
    });
  }

  for (const key of KNOWN_ENV_KEYS) {
    if (!(key in envData) && process.env[key] !== undefined && process.env[key] !== '') {
      envData[key] = String(process.env[key]).trim();
    }
  }

  return envData;
}

/**
 * 📁 .env 파일 안전 덮어쓰기 헬퍼 (디스코드 알림 상세 필터 및 민감정보 덮어쓰기 방어 포함 전 18대 항목 무손실 영구 보존)
 * @param {Record<string, string>} newValues - 갱신할 환경변수 키-값 맵
 * @param {{ allowClearKeys?: string[] }} [options={}] - 빈 값 덮어쓰기를 명시적으로 허용할 키 목록
 */
export function writeEnvFile(newValues = {}, options = {}) {
  const current = readEnvFile();
  const sanitizedUpdates = {};
  const allowClearKeys = new Set(Array.isArray(options.allowClearKeys) ? options.allowClearKeys : []);

  for (const [key, rawVal] of Object.entries(newValues || {})) {
    if (rawVal === undefined || rawVal === null) continue;
    const val = typeof rawVal === 'string' ? rawVal.trim() : String(rawVal);

    if (PROTECTED_SECRET_KEYS.has(key)) {
      if (isMaskedSecretValue(val)) {
        console.warn(`🛡️ [EnvGuard] 마스킹된 문자열로 '${key}' 덮어쓰기 시도가 차단되어 기존 값을 유지합니다.`);
        continue;
      }
      if (NON_EMPTY_SECRET_KEYS.has(key) && val === '' && current[key] && !allowClearKeys.has(key)) {
        console.warn(`🛡️ [EnvGuard] 빈 값으로 '${key}' 덮어쓰기 시도가 차단되어 기존 값을 유지합니다.`);
        continue;
      }
    }

    sanitizedUpdates[key] = val;
  }

  const merged = { ...current, ...sanitizedUpdates };
  const resolvedAlertTypes = sanitizedUpdates.DISCORD_ALERT_TYPES === ''
    ? 'NONE'
    : (merged.DISCORD_ALERT_TYPES || '500,RESOURCE');

  const envDir = path.dirname(ENV_PATH);
  if (!fs.existsSync(envDir)) {
    fs.mkdirSync(envDir, { recursive: true, mode: 0o755 });
  }

  const lines = [
    `PORT=${merged.PORT || process.env.PORT || '3001'}`,
    `HOST=${merged.HOST || process.env.HOST || '127.0.0.1'}`,
    `GOOGLE_CLIENT_ID=${merged.GOOGLE_CLIENT_ID || ''}`,
    `GOOGLE_CLIENT_SECRET=${merged.GOOGLE_CLIENT_SECRET || ''}`,
    `GOOGLE_REDIRECT_URI=${merged.GOOGLE_REDIRECT_URI || ''}`,
    `TOKEN_ENCRYPTION_KEY=${merged.TOKEN_ENCRYPTION_KEY || ''}`,
    `TOKEN_FILE=${merged.TOKEN_FILE || './data/token.enc'}`,
    `ALLOWED_ORIGIN=${merged.ALLOWED_ORIGIN || '*'}`,
    `STORAGE_MODE=${merged.STORAGE_MODE === 'true' ? 'true' : 'false'}`,
    `SHARED_BOOKS_DIR=${merged.SHARED_BOOKS_DIR || ''}`,
    `ADMIN_PASSWORD=${merged.ADMIN_PASSWORD || ''}`,
    `READER_URL=${merged.READER_URL || 'https://epubwebview.vercel.app'}`,
    `STORAGE_API_KEY=${merged.STORAGE_API_KEY || ''}`,
    `ENABLE_ROOT_API_KEY=${merged.ENABLE_ROOT_API_KEY === 'true' ? 'true' : 'false'}`, // 기본값 false: 개별 사용자 X-API-KEY 전용
    `ENFORCE_STORAGE_API_KEY=${merged.ENFORCE_STORAGE_API_KEY === 'true' ? 'true' : 'false'}`,
    `DISCORD_WEBHOOK_URL=${merged.DISCORD_WEBHOOK_URL || ''}`,
    `DISCORD_ALERT_TYPES=${resolvedAlertTypes}`, // 기본값: 500 오류 및 자원 80%, 전체 해제 시 NONE
    `DISCORD_DAILY_DIGEST=${merged.DISCORD_DAILY_DIGEST === 'true' ? 'true' : 'false'}` // 로그 있을 때만 일일 정기보고 발송 플래그
  ];

  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf-8');
}

/**
 * 📦 저장소 모드 필수 디렉터리 자동 생성 및 권한 세팅 (다중 사용자 폴더 data/users, data/api 포함)
 */
export function ensureStorageDirectories() {
  const dirs = [
    path.resolve(ROOT_DIR, 'data'),
    path.resolve(ROOT_DIR, 'data/books'),
    path.resolve(ROOT_DIR, 'data/settings'),
    path.resolve(ROOT_DIR, 'data/archive'),
    path.resolve(ROOT_DIR, 'data/crash-reports'),
    path.resolve(ROOT_DIR, 'data/logs'),
    path.resolve(ROOT_DIR, 'data/users'),
    path.resolve(ROOT_DIR, 'data/api')
  ];

  dirs.forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    }
  });
  console.log('📁 [StorageMode] 필수 저장소 디렉터리 검증 및 권한 세팅 완료 (books, settings, archive, crash-reports, logs, users, api)');
}