/**
 * @file config.js
 * @description 환경변수 검증 및 전역 설정 관리 모듈
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// .env 파일 로드
dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * 필수 환경변수 목록 검증
 */
const REQUIRED_ENV_VARS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'TOKEN_ENCRYPTION_KEY'
];

const missingVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key] || process.env[key].trim() === '');

if (missingVars.length > 0) {
  console.error('[Config Error] 필수 환경변수가 누락되었습니다:');
  missingVars.forEach((v) => console.error(`  - ${v}`));
  console.error('[Config Error] .env.example 파일을 복사하여 .env 파일을 설정한 뒤 다시 시작해 주세요.');
  process.exit(1);
}

/**
 * 검증된 전역 설정 객체
 */
export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  host: process.env.HOST || '127.0.0.1',
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID.trim(),
    clientSecret: process.env.GOOGLE_CLIENT_SECRET.trim(),
    redirectUri: process.env.GOOGLE_REDIRECT_URI.trim(),
    scopes: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.appdata'
    ]
  },
  security: {
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY.trim(),
    tokenFilePath: path.resolve(__dirname, process.env.TOKEN_FILE || './data/token.enc'),
    allowedOrigin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.trim() : '*',
    // 서재로 돌아가기 버튼 클릭 시 이동할 웹 뷰어 주소 (기본값: Vercel 또는 '/')
    readerUrl: (process.env.READER_URL || process.env.ALLOWED_ORIGIN || '/').trim()
  }
};