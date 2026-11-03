/**
 * @file src/envManager.js
 * @description .env 환경 설정 파일 파싱, 저장 및 로컬 스토리지 필수 디렉터리 생성 전담 모듈
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
 * 📁 .env 파일 안전 덮어쓰기 헬퍼 (ADMIN_PASSWORD 보존)
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
    `ADMIN_PASSWORD=${merged.ADMIN_PASSWORD || ''}`
  ];

  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf-8');
}

/**
 * 📦 저장소 모드 필수 디렉터리 자동 생성 및 권한 세팅
 */
export function ensureStorageDirectories() {
  const dirs = [
    path.resolve(ROOT_DIR, 'data'),
    path.resolve(ROOT_DIR, 'data/books'),
    path.resolve(ROOT_DIR, 'data/settings'),
    path.resolve(ROOT_DIR, 'data/archive')
  ];

  dirs.forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    }
  });
  console.log('📁 [StorageMode] 필수 저장소 디렉터리 검증 및 권한 세팅 완료 (./data/books, ./data/settings, ./data/archive)');
}