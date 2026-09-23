/**
 * @file googleAuth.js
 * @description Google OAuth2 클라이언트 생성, 로그인 URL 발급, 코드 교환 및 토큰 갱신 전담 모듈
 */

import { OAuth2Client } from 'google-auth-library';
import crypto from 'crypto';
import { config } from './config.js';
import { saveRefreshToken, getRefreshToken, hasRefreshToken } from './tokenStore.js';

/**
 * 전역 싱글톤 Google OAuth2 클라이언트
 */
const oauth2Client = new OAuth2Client(
  config.google.clientId,
  config.google.clientSecret,
  config.google.redirectUri
);

/**
 * CSRF 방지용 state 메모리 저장소 (생성 시각 기록, 10분 유효기간)
 * @type {Map<string, number>}
 */
const stateStore = new Map();
const STATE_TTL_MS = 10 * 60 * 1000; // 10분

/**
 * 만료된 state 정리 함수
 */
function cleanupExpiredStates() {
  const now = Date.now();
  for (const [state, timestamp] of stateStore.entries()) {
    if (now - timestamp > STATE_TTL_MS) {
      stateStore.delete(state);
    }
  }
}

/**
 * Google 로그인용 Authorization URL 및 검증용 State 생성
 * @returns {string} Google OAuth 로그인 URL
 */
export function generateAuthUrl() {
  cleanupExpiredStates();

  const state = crypto.randomBytes(32).toString('hex');
  stateStore.set(state, Date.now());

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // 반드시 refresh_token 발급받기 위함
    prompt: 'consent',      // 동의 창을 항상 강제하여 refresh_token 재발급 보장
    scope: config.google.scopes,
    state
  });

  console.log('[GoogleAuth] 새로운 OAuth 로그인 URL이 생성되었습니다.');
  return authUrl;
}

/**
 * OAuth Callback 시 전달된 State 유효성 검증
 * @param {string} state - 쿼리 스트링으로 전달받은 state 값
 * @returns {boolean} 유효 여부
 */
export function verifyState(state) {
  cleanupExpiredStates();

  if (!state || typeof state !== 'string') {
    return false;
  }

  if (stateStore.has(state)) {
    stateStore.delete(state); // 1회 사용 후 즉시 파기 (Replay Attack 방지)
    return true;
  }

  return false;
}

/**
 * Authorization Code를 전달받아 Google과 토큰 교환 및 Refresh Token 영구 저장
 * @param {string} code - Google로부터 발급받은 인가 코드
 * @returns {Promise<{ success: boolean, message: string }>}
 */
export async function exchangeCodeForTokens(code) {
  if (!code || typeof code !== 'string') {
    throw new Error('유효하지 않은 인가 코드(Code)입니다.');
  }

  try {
    console.log('[GoogleAuth] Google 인가 코드로 토큰 교환을 시도합니다.');
    const { tokens } = await oauth2Client.getToken(code);

    if (tokens.refresh_token) {
      saveRefreshToken(tokens.refresh_token);
      console.log('[GoogleAuth] 신규 Refresh Token이 성공적으로 발급 및 저장되었습니다.');
      return { success: true, message: '새로운 Refresh Token이 안전하게 저장되었습니다.' };
    }

    // Google이 신규 refresh_token을 주지 않은 경우 기존 토큰 확인
    if (hasRefreshToken()) {
      console.warn('[GoogleAuth] 응답에 refresh_token이 없으나, 기존에 저장된 토큰이 유지됩니다.');
      return { success: true, message: '기존에 저장된 Refresh Token을 그대로 유지합니다.' };
    }

    throw new Error('Google 응답에 refresh_token이 포함되지 않았습니다. Google 계정 연동 권한을 재설정해 주세요.');
  } catch (err) {
    console.error('[GoogleAuth Error] 토큰 교환 중 오류 발생:', err.message);
    throw err;
  }
}

/**
 * 저장된 Refresh Token을 사용하여 Google로부터 새로운 Access Token 갱신 발급
 * @returns {Promise<{ access_token: string, expires_in: number, token_type: string }>}
 */
export async function getFreshAccessToken() {
  const refreshToken = getRefreshToken();

  if (!refreshToken) {
    const error = new Error('저장된 Refresh Token이 없습니다. 먼저 /auth/google 을 통해 Google 계정을 연동해 주세요.');
    error.status = 401;
    throw error;
  }

  try {
    // 임시 인스턴스 또는 클라이언트에 저장된 refresh_token 할당
    oauth2Client.setCredentials({
      refresh_token: refreshToken
    });

    console.log('[GoogleAuth] 저장된 Refresh Token을 이용하여 Access Token 갱신을 요청합니다.');
    const response = await oauth2Client.getAccessToken();

    // response.res.data 내부에 access_token 및 만료 정보(expires_in 초 단위)가 반환됨
    const tokenData = response?.res?.data || {};
    const accessToken = tokenData.access_token || response.token;
    const expiresIn = tokenData.expires_in || 3599;
    const tokenType = tokenData.token_type || 'Bearer';

    if (!accessToken) {
      throw new Error('Google로부터 유효한 access_token을 수신하지 못했습니다.');
    }

    console.log('[GoogleAuth] 새 Access Token 발급 완료 (유효 시간:', expiresIn, '초)');

    return {
      access_token: accessToken,
      expires_in: expiresIn,
      token_type: tokenType
    };
  } catch (err) {
    console.error('[GoogleAuth Error] Access Token 갱신 실패:', err.message);
    const error = new Error('Google Access Token 갱신에 실패했습니다: ' + err.message);
    error.status = 502;
    throw error;
  }
}