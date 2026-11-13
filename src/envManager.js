/**
 * @file src/envManager.js
 * @description .env 환경 설정 파일 파싱, 저장 및 로컬 스토리지 필수 디렉터리(books, settings, archive, crash-reports, logs, users, api) 생성 전담 모듈
 * - 🐳 [Docker 볼륨 영속성 지원] ENV_FILE_PATH 지정 또는 루트 .env 미존재 시 ./data/.env 자동 사용으로 컨테이너 업데이트 시 설정 보존
 * - 🛡️ [환경변수 무누락 보존] DISCORD_ALERT_TYPES, DISCORD_DAILY_DIGEST 포함 전 17대 환경변수 영구 보존
 * - 🔔 [Discord 알림 필터 영구 기록] 알림 유형 선택값 및 로그 유무 조건부 정기보고 설정 .env 각인
 * - 👥 [다중 사용자 저장소 준비] ./data/users 및 ./data/api 디렉터리 자동 권한 세팅 지원
 * - 🔑 [스토리지 API 보안 키 지원] 서버 전용 비밀키 및 엄격 검증 모드 플래그 영구 동기화
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
  'ENFORCE_STORAGE_API_KEY',
  'DISCORD_WEBHOOK_URL',
  'DISCORD_ALERT_TYPES',
  'DISCORD_DAILY_DIGEST'
];

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
 * 📁 .env 파일 안전 덮어쓰기 헬퍼 (디스코드 알림 상세 필터 포함 전 17대 항목 무손실 영구 보존)
 * @param {Record<string, string>} newValues 
 */
export function writeEnvFile(newValues) {
  const current = readEnvFile();
  const merged = { ...current, ...newValues };

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
    `ENFORCE_STORAGE_API_KEY=${merged.ENFORCE_STORAGE_API_KEY === 'true' ? 'true' : 'false'}`,
    `DISCORD_WEBHOOK_URL=${merged.DISCORD_WEBHOOK_URL || ''}`,
    `DISCORD_ALERT_TYPES=${merged.DISCORD_ALERT_TYPES || '500,RESOURCE'}`, // 기본값: 500 오류 및 자원 80%
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