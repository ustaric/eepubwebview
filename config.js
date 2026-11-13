/**
 * @file config.js
 * @description 환경변수 검증 및 전역 설정 관리 모듈
 * - 🐳 [Docker/NAS 무중단 부팅 지원] Google OAuth 미설정 상태에서도 개인 저장소 모드 및 /admin 초기 설정 진입 허용
 * - 📁 [통합 .env 경로 연동] envManager의 ENV_PATH(./data/.env 또는 루트 .env)와 동일 경로 로드
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { ENV_PATH } from './src/envManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// envManager가 결정한 .env 파일 로드 (컨테이너 환경에서는 ./data/.env 우선)
dotenv.config({ path: ENV_PATH });

/**
 * Google OAuth 및 암호화 환경변수 상태 점검 (미설정 시 종료하지 않고 안내 경고 출력)
 */
const GOOGLE_ENV_VARS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'TOKEN_ENCRYPTION_KEY'
];

const missingVars = GOOGLE_ENV_VARS.filter((key) => !process.env[key] || process.env[key].trim() === '');

if (missingVars.length > 0) {
  console.warn('[Config Notice] 일부 Google OAuth 환경변수가 아직 설정되지 않았습니다 (스토리지 전용 모드 또는 /admin에서 나중에 설정 가능):');
  missingVars.forEach((v) => console.warn(`  - ${v}`));
}

/**
 * 검증된 전역 설정 객체
 */
export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  host: process.env.HOST || '127.0.0.1',
  google: {
    clientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
    clientSecret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
    redirectUri: (process.env.GOOGLE_REDIRECT_URI || '').trim(),
    scopes: [
      'https://www.googleapis.com/auth/drive.file',
    ]
  },
  security: {
    encryptionKey: (process.env.TOKEN_ENCRYPTION_KEY || '').trim(),
    tokenFilePath: path.resolve(__dirname, process.env.TOKEN_FILE || './data/token.enc'),
    allowedOrigin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.trim() : '*',
    // 서재로 돌아가기 버튼 클릭 시 이동할 웹 뷰어 주소 (기본값: Vercel 또는 '/')
    readerUrl: (process.env.READER_URL || process.env.ALLOWED_ORIGIN || '/').trim()
  }
};