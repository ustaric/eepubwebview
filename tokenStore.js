/**
 * @file tokenStore.js
 * @description Refresh Token 암호화(AES-256-GCM) 영구 저장 및 복호화 관리 모듈
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM 권장 IV 길이 (96-bit)
const AUTH_TAG_LENGTH = 16;

/**
 * 설정된 비밀키 문자열로부터 32바이트 AES 키 유도
 * @param {string} secretKey
 * @returns {Buffer} 32바이트 버퍼
 */
function deriveEncryptionKey(secretKey) {
  return crypto.createHash('sha256').update(secretKey).digest();
}

/**
 * 저장 디렉터리가 없을 경우 자동 생성
 * @param {string} filePath
 */
function ensureDirectoryExistence(filePath) {
  const dirname = path.dirname(filePath);
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true });
  }
}

/**
 * 평문 Refresh Token을 AES-256-GCM으로 암호화하여 파일에 저장
 * @param {string} refreshToken - 저장할 Refresh Token 문자열
 * @returns {boolean} 저장 성공 여부
 */
export function saveRefreshToken(refreshToken) {
  if (!refreshToken || typeof refreshToken !== 'string') {
    throw new Error('유효하지 않은 Refresh Token 형식입니다.');
  }

  try {
    ensureDirectoryExistence(config.security.tokenFilePath);

    const key = deriveEncryptionKey(config.security.encryptionKey);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

    let ciphertext = cipher.update(refreshToken, 'utf8', 'base64');
    ciphertext += cipher.final('base64');

    const authTag = cipher.getAuthTag().toString('base64');

    const payload = {
      version: 1,
      createdAt: new Date().toISOString(),
      iv: iv.toString('base64'),
      authTag,
      ciphertext
    };

    fs.writeFileSync(config.security.tokenFilePath, JSON.stringify(payload, null, 2), 'utf8');
    console.log('[TokenStore] Refresh Token이 안전하게 암호화되어 저장되었습니다.');
    return true;
  } catch (err) {
    console.error('[TokenStore Error] Refresh Token 암호화 저장 중 오류 발생:', err.message);
    throw new Error('토큰 암호화 저장에 실패했습니다.');
  }
}

/**
 * 저장된 암호화 파일로부터 Refresh Token을 읽어 복호화
 * @returns {string|null} 복호화된 Refresh Token 문자열 (파일이 없으면 null)
 */
export function getRefreshToken() {
  if (!fs.existsSync(config.security.tokenFilePath)) {
    return null;
  }

  try {
    const rawData = fs.readFileSync(config.security.tokenFilePath, 'utf8');
    const parsed = JSON.parse(rawData);

    if (!parsed.iv || !parsed.authTag || !parsed.ciphertext) {
      throw new Error('암호화 데이터 형식이 올바르지 않습니다.');
    }

    const key = deriveEncryptionKey(config.security.encryptionKey);
    const iv = Buffer.from(parsed.iv, 'base64');
    const authTag = Buffer.from(parsed.authTag, 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(parsed.ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (err) {
    console.error('[TokenStore Error] Refresh Token 복호화 실패 (키 불일치 또는 데이터 손상):', err.message);
    return null;
  }
}

/**
 * 저장된 Refresh Token 존재 여부 확인
 * @returns {boolean}
 */
export function hasRefreshToken() {
  return fs.existsSync(config.security.tokenFilePath);
}

/**
 * 저장된 Refresh Token 파일 삭제
 * @returns {boolean}
 */
export function deleteRefreshToken() {
  try {
    if (fs.existsSync(config.security.tokenFilePath)) {
      fs.unlinkSync(config.security.tokenFilePath);
      console.log('[TokenStore] 저장된 Refresh Token 파일이 삭제되었습니다.');
    }
    return true;
  } catch (err) {
    console.error('[TokenStore Error] 토큰 파일 삭제 중 오류 발생:', err.message);
    return false;
  }
}