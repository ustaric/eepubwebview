/**
 * @file src/securityGuard.js
 * @description 개인 서버 보안 전담 가드 모듈
 * - 🛡️ [심볼릭 링크 및 Path Traversal 원천 차단] fs.realpathSync 기반 실물 물리 경로 검증
 * - 🔒 [도서 확장자 및 파일명 엄격 화이트리스트] .epub, .txt, .webp, .json 외의 임의 시스템 파일 접근 차단
 * - 🚦 [HTTP 보안 응답 헤더 주입] nosniff, SAMEORIGIN, Referrer-Policy 자동 주입
 * - 🧹 [로그 민감정보 실시간 마스킹] 비밀번호, Access Token, Secret 등의 감사 로그 노출 원천 봉쇄
 */

import fs from 'fs';
import path from 'path';

// 허용된 파일 확장자 화이트리스트
const ALLOWED_EXTENSIONS = new Set(['.epub', '.txt', '.webp', '.json']);

/**
 * 🛡️ [심볼릭 링크 & Path Traversal 안전 검증]
 * 대상 경로가 기본 디렉터리(baseDir)의 실제 물리적 범위 내에 위치하는지 실측 검증
 * - 심볼릭 링크(Soft Link)를 통한 루트(/) 또는 /etc 등의 디렉터리 탈출 공격 원천 방어
 * 
 * @param {string} baseDir - 허용된 기본 루트 디렉터리
 * @param {string} targetPath - 검증 대상 경로 (상대 또는 절대)
 * @returns {{ safe: boolean, realPath: string|null, reason?: string }}
 */
export function validateSafePath(baseDir, targetPath) {
  if (!baseDir || !targetPath) {
    return { safe: false, realPath: null, reason: '경로 인자가 비어 있습니다.' };
  }

  try {
    const resolvedBase = path.resolve(baseDir);
    if (!fs.existsSync(resolvedBase)) {
      return { safe: false, realPath: null, reason: '기본 디렉터리가 존재하지 않습니다.' };
    }

    const realBase = fs.realpathSync(resolvedBase);
    const resolvedTarget = path.resolve(realBase, targetPath);

    // 대상 파일 또는 디렉터리가 이미 존재하는 경우: 실물 realpath 직접 대조
    if (fs.existsSync(resolvedTarget)) {
      const realTarget = fs.realpathSync(resolvedTarget);
      const isInside = realTarget === realBase || realTarget.startsWith(realBase + path.sep);
      if (!isInside) {
        return { safe: false, realPath: null, reason: '심볼릭 링크 또는 경로 이탈이 감지되었습니다.' };
      }
      return { safe: true, realPath: realTarget };
    }

    // 신규 생성 예정 파일인 경우: 부모 디렉터리의 실물 realpath 검증
    const parentDir = path.dirname(resolvedTarget);
    if (fs.existsSync(parentDir)) {
      const realParent = fs.realpathSync(parentDir);
      const isParentInside = realParent === realBase || realParent.startsWith(realBase + path.sep);
      if (!isParentInside) {
        return { safe: false, realPath: null, reason: '상위 디렉터리가 허용된 범위를 벗어납니다.' };
      }
      return { safe: true, realPath: resolvedTarget };
    }

    return { safe: false, realPath: null, reason: '대상 디렉터리 경로를 확인할 수 없습니다.' };
  } catch (err) {
    return { safe: false, realPath: null, reason: `경로 검증 중 예외 발생: ${err.message}` };
  }
}

/**
 * 🔒 [도서 확장자 화이트리스트 검사]
 * @param {string} fileName 
 * @returns {boolean} 허용 여부
 */
export function isAllowedBookFile(fileName) {
  if (!fileName || typeof fileName !== 'string') return false;
  const ext = path.extname(fileName).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

/**
 * 🚦 [기본 HTTP 보안 응답 헤더 주입]
 * 브라우저 기반의 MIME 스니핑, 클릭재킹 방어 및 Referrer 정책 강제
 * @param {import('http').ServerResponse} res 
 */
export function injectSecurityHeaders(res) {
  if (!res || res.headersSent) return;

  // MIME 타입 스니핑 방지 (보안 취약점 방어)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // 클릭재킹 방어 (동일 오리진 외 iframe 삽입 방지)
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // 크로스사이트 XSS 필터링 활성화
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // 안전한 Referrer 전달 정책
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

/**
 * 🧹 [로그 민감정보 마스킹]
 * 로그 링 버퍼나 콘솔 출력에 노출될 수 있는 토큰, 비밀번호를 안전하게 비식별화
 * @param {string} rawText 
 * @returns {string} 마스킹된 텍스트
 */
export function maskSensitiveLog(rawText = '') {
  if (!rawText || typeof rawText !== 'string') return '';

  return rawText
    // 비밀번호 필드 마스킹
    .replace(/(password|pass|currentPass|newPass)=([^& \t\r\n]+)/gi, '$1=********')
    // 토큰 파라미터 마스킹
    .replace(/(access_token|refresh_token|token|session|auth|code)=([^& \t\r\n]+)/gi, (match, key, val) => {
      const masked = val.length > 8 ? `${val.substring(0, 4)}...${val.substring(val.length - 4)}` : '****';
      return `${key}=${masked}`;
    })
    // 구글 클라이언트 시크릿 패턴 마스킹
    .replace(/GOCSPX-[a-zA-Z0-9_-]+/g, 'GOCSPX-********')
    // Bearer 헤더 값 마스킹
    .replace(/Bearer\s+([a-zA-Z0-9._-]+)/gi, 'Bearer ********');
}