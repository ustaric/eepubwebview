/**
 * @file src/apiKeyManager.js
 * @description 다중 사용자 API 키, 기기 토큰 바인딩 및 6자리 OTP 관리 통합 파사드(Facade)
 * - 🏛️ [ESM 파사드 구조] apiKeyStore(SSOT) + apiKeyUserService + apiKeyDeviceService + apiKeyOtpService 조합
 * - 🔄 [100% 하위 호환] 기존 hashApiKey() 및 apiKeyManager 17개 공개 메서드 계약 그대로 보존
 */

import { hashApiKey, flushDirtyApiKeys } from './services/apiKey/apiKeyStore.js';
import {
  issueApiKey,
  authenticateApiKey,
  updateUserMaxDevices,
  reissueApiKey,
  updateUserQuota,
  revokeApiKey,
  cleanupExpiredPendingKeys,
  getUserListForAdmin
} from './services/apiKey/apiKeyUserService.js';
import {
  registerOrVerifyDevice,
  verifyAndTouchDevice,
  getUserDevices,
  blockDevice,
  unblockDevice,
  deleteDevice
} from './services/apiKey/apiKeyDeviceService.js';
import {
  issueDeviceOtp,
  verifyAndExchangeDeviceOtp
} from './services/apiKey/apiKeyOtpService.js';

export { hashApiKey };

export const apiKeyManager = {
  /**
   * 💾 지연 저장 대기 중인 접속 이력(dirty 상태)을 즉시 디스크에 반영합니다.
   * @returns {void}
   */
  flushPendingChanges() {
    flushDirtyApiKeys(true);
  },

  issueApiKey,
  authenticateApiKey,
  issueDeviceOtp,
  verifyAndExchangeDeviceOtp,
  registerOrVerifyDevice,
  verifyAndTouchDevice,
  getUserDevices,
  blockDevice,
  unblockDevice,
  deleteDevice,
  updateUserMaxDevices,
  reissueApiKey,
  updateUserQuota,
  revokeApiKey,
  cleanupExpiredPendingKeys,
  getUserListForAdmin
};