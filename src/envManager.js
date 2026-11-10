/**
 * @file src/envManager.js
 * @description .env 환경 설정 파일 파싱, 저장 및 로컬 스토리지 필수 디렉터리(books, settings, archive, crash-reports, logs, users, api) 생성 전담 모듈
 * - 🛡️ [환경변수 무누락 보존] DISCORD_WEBHOOK_URL, STORAGE_API_KEY를 포함한 전 15대 환경변수 영구 보존
 * - 🔔 [Discord 웹훅 영구 기록] DISCORD_WEBHOOK_URL을 .env 파일에 무손실 저장하여 관제 알림 설정 영구 보존
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
export const ENV_PATH = path.resolve(ROOT_DIR, '.env');

/**
 * 📁 .env 파일 읽기 헬퍼
 * @returns {Record<string, string>}
 */
export function readEnvFile() {
  const envData = {};
  if (!fs.existsSync(ENV_PATH)) return envData;

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
  return envData;
}

/**
 * 📁 .env 파일 안전 덮어쓰기 헬퍼 (DISCORD_WEBHOOK_URL 포함 전 15대 항목 무손실 영구 보존)
 * @param {Record<string, string>} newValues 
 */
export function writeEnvFile(newValues) {
  const current = readEnvFile();
  const merged = { ...current, ...newValues };

  const lines = [
    `PORT=${merged.PORT || '3001'}`,
    `HOST=${merged.HOST || '127.0.0.1'}`,
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
    `DISCORD_WEBHOOK_URL=${merged.DISCORD_WEBHOOK_URL || ''}` // 🌟 [핵심 해결] 디스코드 웹훅 영구 기록 필드 탑재!
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