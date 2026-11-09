/**
 * @file src/views/adminSettingsTab.js
 * @description 관리자 제어 센터 [탭 2: ⚙️ 시스템 설정] HTML 렌더러 모듈
 * - 🔑 [스토리지 API 보안 키 & 실시간 연동 기기 관제] STORAGE_API_KEY 생성/복사, 엄격 모드 토글 및 최근 사용 기기 실시간 표출
 * - 📋 [주요 접속 정보 복사] GitHub 저장소, 서버 주소, OAuth 리디렉션 URI 원클릭 복사 카드
 * - 🔑 [Google OAuth 연동] 토큰 보유 상태 표출 및 로그인 링크
 * - 📁 [스토리지 모드 토글] 개인 서버 자체 저장소 모드 On/Off 스위치
 * - 📚 [공유 라이브러리 지정] 공유 도서 폴더 경로 입력 및 실측 권한 배지
 * - 🛠️ [시스템 상세 설정 폼] PORT, HOST, CORS, 구글 인증키, 관리자 비밀번호 변경 등 14대 환경변수 폼
 */

import { auditLogger } from '../auditLogger.js';

// 공식 깃허브 저장소 주소
const GITHUB_REPO_URL = 'https://github.com/ustaric/refresh-server';

/**
 * HTML 특수문자 이스케이프 헬퍼 (XSS 방어)
 * @param {string} str 
 * @returns {string}
 */
function escapeHtml(str = '') {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * ⚙️ [탭 2] 시스템 설정 HTML 템플릿 렌더러
 * @param {Object} params
 * @param {Object} params.env - readEnvFile() 환경변수
 * @param {Object} params.config - config.js 전역 설정
 * @param {string} params.currentServerUrl - 현재 서버 주소 (http://IP:PORT)
 * @param {string} params.redirectUri - 구글 OAuth 리디렉션 URI
 * @param {boolean} params.hasToken - 구글 Refresh Token 보유 여부
 * @param {string} params.sharedDirBadge - 공유 폴더 권한 실측 배지 HTML
 * @returns {string} 탭 2 본문 HTML 문자열
 */
export function renderSettingsTab({
  env = {},
  config = {},
  currentServerUrl = '',
  redirectUri = '',
  hasToken = false,
  sharedDirBadge = ''
}) {
  const isStorageMode = env.STORAGE_MODE === 'true';
  const sharedBooksDir = env.SHARED_BOOKS_DIR || '';
  const storageApiKey = env.STORAGE_API_KEY || '';
  const isEnforceApiKey = env.ENFORCE_STORAGE_API_KEY === 'true';

  const port = env.PORT || String(config.port || '3001');
  const serverHost = env.HOST || config.host || '127.0.0.1';
  const tokenFile = env.TOKEN_FILE || './data/token.enc';
  const readerUrl = env.READER_URL || config.security?.readerUrl || 'https://epubwebview.vercel.app';
  const clientId = env.GOOGLE_CLIENT_ID || '';
  const allowedOrigin = env.ALLOWED_ORIGIN || '*';
  const hasSecret = Boolean(env.GOOGLE_CLIENT_SECRET);
  const hasKey = Boolean(env.TOKEN_ENCRYPTION_KEY);

  // 🔑 최근 API 키 사용 기기 정보 조회
  const lastApiKeyUsage = auditLogger.getLastApiKeyUsage();

  // API 키 상태 배지
  let apiKeyStatusBadge = '<span class="badge badge-warning">미설정 (출처 검증만 사용)</span>';
  if (storageApiKey && isEnforceApiKey) {
    apiKeyStatusBadge = '<span class="badge badge-success">🛡️ 엄격 키 검증 활성</span>';
  } else if (storageApiKey) {
    apiKeyStatusBadge = '<span class="badge badge-info">🔑 키 등록됨 (호환 모드)</span>';
  }

  // 📱 [실시간 연동 현황 박스 HTML]
  let apiKeyUsageHtml = '';
  if (!storageApiKey) {
    apiKeyUsageHtml = `
      <div style="margin-top: 14px; padding: 12px 14px; background: #0f172a; border: 1px solid var(--border); border-radius: 10px;">
        <div style="font-size: 12px; color: var(--text-muted);">
          ⚪ API 키가 아직 설정되지 않았습니다. [🎲 새 키 생성] 후 하단의 [💾 설정 저장]을 눌러주세요.
        </div>
      </div>
    `;
  } else if (lastApiKeyUsage) {
    apiKeyUsageHtml = `
      <div style="margin-top: 14px; padding: 12px 14px; background: #0f172a; border: 1px solid #1e3a5f; border-radius: 10px;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
          <span style="font-size: 12px; font-weight: 600; color: #38bdf8; display: flex; align-items: center; gap: 6px;">
            <span>📱</span> 최근 API 키 연동 기기
          </span>
          <span style="font-size: 11px; color: #10b981; font-weight: 600;">
            🟢 ${escapeHtml(lastApiKeyUsage.timestamp)} (${escapeHtml(lastApiKeyUsage.date)})
          </span>
        </div>
        <div style="font-size: 13.5px; font-weight: 700; color: #f8fafc; margin-bottom: 4px;">
          ${escapeHtml(lastApiKeyUsage.device)} <span style="font-size: 12px; font-weight: normal; color: var(--text-muted); font-family: monospace;">(${escapeHtml(lastApiKeyUsage.ip)})</span>
        </div>
        <div style="font-size: 11.5px; color: var(--text-muted); font-family: monospace;">
          최근 요청: <span style="color: #a78bfa; font-weight: 600;">${escapeHtml(lastApiKeyUsage.method)}</span> ${escapeHtml(lastApiKeyUsage.path)}
        </div>
      </div>
    `;
  } else {
    apiKeyUsageHtml = `
      <div style="margin-top: 14px; padding: 12px 14px; background: #0f172a; border: 1px solid var(--border); border-radius: 10px;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <span style="font-size: 12px; font-weight: 600; color: var(--text-muted); display: flex; align-items: center; gap: 6px;">
            <span>📱</span> 최근 API 키 연동 기기
          </span>
          <span style="font-size: 11px; color: var(--text-muted);">연동 대기 중</span>
        </div>
        <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">
          ⚪ 아직 이 API 키를 사용해 서버에 접근한 기기 이력이 없습니다. (웹 뷰어에서 동기화 발생 시 자동 갱신)
        </div>
      </div>
    `;
  }

  return `
    <!-- 1. 주요 접속 정보 원클릭 복사 카드 -->
    <div class="card">
      <div class="section-title">
        <span>📋 주요 접속 정보 원클릭 복사</span>
        <span class="badge badge-info">빠른 복사 지원</span>
      </div>

      <div class="form-group">
        <label>🐙 프로젝트 공식 GitHub 저장소</label>
        <div class="copy-box">
          <span class="copy-text" id="text-github">${GITHUB_REPO_URL}</span>
          <button type="button" class="btn-copy" onclick="copyToClipboard('${GITHUB_REPO_URL}', this)">복사</button>
        </div>
      </div>

      <div class="form-group">
        <label>🌐 현재 서버 주소 (웹 뷰어 설정창에 입력할 주소)</label>
        <div class="copy-box">
          <span class="copy-text" id="text-server">${currentServerUrl}</span>
          <button type="button" class="btn-copy" onclick="copyToClipboard('${currentServerUrl}', this)">복사</button>
        </div>
      </div>

      <div class="form-group">
        <label>🔗 구글 콘솔에 등록할 리디렉션 URI (Redirect URI)</label>
        <div class="copy-box">
          <span class="copy-text" id="text-redirect">${redirectUri}</span>
          <button type="button" class="btn-copy" onclick="copyToClipboard('${redirectUri}', this)">복사</button>
        </div>
      </div>
    </div>

    <form method="POST" action="/admin/save">
      <!-- 2. Google OAuth 토큰 상태 및 재인증 -->
      <div class="card">
        <div class="section-title">
          <span>🔑 Google OAuth 토큰 상태</span>
          <span class="badge ${hasToken ? 'badge-success' : 'badge-warning'}">
            ${hasToken ? '토큰 보유 (정상)' : '미인증 (연동 필요)'}
          </span>
        </div>
        <p style="font-size: 13px; color: var(--text-muted); margin: 0 0 12px 0;">
          Google Drive 연동용 Refresh Token이 서버에 암호화되어 안전하게 보관되고 있는지 나타냅니다.
        </p>
        <a href="/auth/google" class="oauth-btn">🔗 Google 계정 로그인 / 재인증 시작</a>
      </div>

      <!-- 3. 개인 서버 저장소 모드 스위치 -->
      <div class="card">
        <div class="section-title">
          <span>📁 개인 서버 저장소 모드 (Self-Hosted Storage)</span>
          <span class="badge ${isStorageMode ? 'badge-success' : 'badge-info'}">
            ${isStorageMode ? '로컬 저장소 활성' : '인증 프록시 모드'}
          </span>
        </div>

        <div class="toggle-row">
          <div class="toggle-info">
            <h4>개인 서버에 책/설정 직접 저장</h4>
            <p>체크 시 Google Drive 대신 이 서버의 디스크(./data/books)에 책과 진도율을 동기화합니다.</p>
          </div>
          <label class="switch">
            <input type="checkbox" name="STORAGE_MODE" value="true" ${isStorageMode ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        </div>
      </div>

      <!-- 4. 🔑 스토리지 전용 API 보안 키 및 엄격 검증 모드 (실시간 연동 기기 관제 탑재) -->
      <div class="card">
        <div class="section-title">
          <span>🔑 스토리지 API 보안 키 (STORAGE_API_KEY)</span>
          ${apiKeyStatusBadge}
        </div>
        <p style="font-size: 12.5px; color: var(--text-muted); margin: 0 0 12px 0;">
          웹 뷰어 또는 외부 스크립트가 스토리지 API(/api/storage/...)에 접근할 때 사용할 비밀 인증키입니다.<br>
          헤더(<code>X-API-KEY: 키값</code>) 또는 쿼리(<code>?apiKey=키값</code>)로 전달 시 출처 검사를 프리패스합니다.
        </p>

        <div class="form-group">
          <label>스토리지 API 보안 키</label>
          <div class="input-btn-group">
            <input type="text" id="input-storage-api-key" name="STORAGE_API_KEY" value="${storageApiKey}" placeholder="sk_live_... 또는 [🎲 새 키 생성] 클릭" autocomplete="off">
            <button type="button" class="btn-browse" onclick="generateRandomApiKey()">🎲 새 키 생성</button>
            <button type="button" class="btn-browse" style="color:var(--text);" onclick="copyApiKey(this)">복사</button>
          </div>
        </div>

        <div class="toggle-row" style="margin-top: 14px;">
          <div class="toggle-info">
            <h4>🛡️ 엄격 API 키 검증 모드 강제 (ENFORCE_STORAGE_API_KEY)</h4>
            <p style="margin-bottom: 4px;">체크 시 올바른 X-API-KEY가 없는 모든 스토리지 요청을 즉시 401로 차단합니다.</p>
            <p style="color: var(--warning); font-size: 11.5px; margin: 0;">
              ※ 주의: 뷰어에 키를 등록하기 전에는 체크를 해제해 두세요. (체크 해제 시 기존 뷰어 100% 정상 작동)
            </p>
          </div>
          <label class="switch">
            <input type="checkbox" name="ENFORCE_STORAGE_API_KEY" value="true" ${isEnforceApiKey ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        </div>

        <!-- 📱 [신규] 최근 API 키 연동 기기 현황 관제 박스 -->
        ${apiKeyUsageHtml}
      </div>

      <!-- 5. 공유 도서 라이브러리 폴더 지정 (간이 탐색기 연동) -->
      <div class="card">
        <div class="section-title">
          <span>📚 공유 도서 라이브러리 폴더 (SHARED_BOOKS_DIR)</span>
          ${sharedDirBadge}
        </div>
        <p style="font-size: 12.5px; color: var(--text-muted); margin: 0 0 12px 0;">
          웹 뷰어 클라이언트가 바로 읽을 수 있는 서버 내의 실제 도서 폴더(.epub, .txt)를 지정합니다.<br>
          [🔍 폴더 찾아보기]를 눌러 서버의 최상위 루트(/)부터 직접 탐색하여 선택할 수 있습니다.
        </p>

        <div class="form-group">
          <label>공유 도서 폴더 절대 경로</label>
          <div class="input-btn-group">
            <input type="text" id="input-shared-books-dir" name="SHARED_BOOKS_DIR" value="${sharedBooksDir}" placeholder="/home/ubuntu/books 또는 /mnt/storage/books">
            <button type="button" class="btn-browse" onclick="openFolderPicker()">🔍 폴더 찾아보기</button>
          </div>
        </div>
      </div>

      <!-- 6. 상세 환경변수 설정 (전 항목 1:1 완비) -->
      <div class="card">
        <div class="section-title">
          <span>🛠️ 시스템 상세 설정 (.env 환경변수)</span>
        </div>

        <!-- 포트 & 호스트 바인딩 -->
        <div class="form-row">
          <div class="form-group">
            <label>포트 (PORT)</label>
            <input type="text" name="PORT" value="${port}" placeholder="3001">
          </div>
          <div class="form-group">
            <label>바인딩 호스트 (HOST)</label>
            <input type="text" name="HOST" value="${serverHost}" placeholder="127.0.0.1">
          </div>
        </div>

        <!-- 리더 URL & 토큰 파일 경로 -->
        <div class="form-group">
          <label>웹 서재 주소 (READER_URL - 서재로 돌아가기 버튼 대상)</label>
          <input type="text" name="READER_URL" value="${readerUrl}" placeholder="https://epubwebview.vercel.app">
        </div>

        <div class="form-group">
          <label>암호화 토큰 파일 경로 (TOKEN_FILE)</label>
          <input type="text" name="TOKEN_FILE" value="${tokenFile}" placeholder="./data/token.enc">
        </div>

        <div class="form-group">
          <label>허용 웹 뷰어 Origin (ALLOWED_ORIGIN - CORS 및 방화벽 화이트리스트)</label>
          <input type="text" name="ALLOWED_ORIGIN" value="${allowedOrigin}" placeholder="https://내뷰어주소.vercel.app,http://localhost:5173">
        </div>

        <div class="form-group">
          <label>Google Client ID</label>
          <input type="text" name="GOOGLE_CLIENT_ID" value="${clientId}" placeholder="your-client-id.apps.googleusercontent.com">
        </div>

        <div class="form-group">
          <label>Google Client Secret ${hasSecret ? '<span style="color:var(--success); font-size:11px;">(현재 등록됨)</span>' : ''}</label>
          <input type="password" name="GOOGLE_CLIENT_SECRET" placeholder="${hasSecret ? '•••••••• (변경 시에만 새로 입력)' : 'GOCSPX-...'}" autocomplete="new-password">
        </div>

        <div class="form-group">
          <label>Google Redirect URI</label>
          <input type="text" name="GOOGLE_REDIRECT_URI" value="${redirectUri}" placeholder="https://내서버도메인/auth/google/callback">
        </div>

        <div class="form-group">
          <label>토큰 암호화 마스터 키 (TOKEN_ENCRYPTION_KEY) ${hasKey ? '<span style="color:var(--success); font-size:11px;">(현재 등록됨)</span>' : ''}</label>
          <input type="password" name="TOKEN_ENCRYPTION_KEY" placeholder="${hasKey ? '•••••••• (변경 시에만 새로 입력)' : '32자 이상의 무작위 비밀키'}" autocomplete="new-password">
        </div>

        <div class="form-group">
          <label>🔒 관리자 페이지 비밀번호 변경 (ADMIN_PASSWORD)</label>
          <input type="password" name="NEW_ADMIN_PASSWORD" placeholder="•••••••• (비밀번호 변경 시에만 새 비밀번호 입력)" autocomplete="new-password">
        </div>
      </div>

      <button type="submit" class="btn-submit">💾 설정 저장 및 환경 적용</button>
    </form>

    <script>
      function generateRandomApiKey() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let key = 'sk_live_';
        for (let i = 0; i < 32; i++) {
          key += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        const el = document.getElementById('input-storage-api-key');
        if (el) {
          el.value = key;
          el.focus();
        }
      }

      function copyApiKey(btn) {
        const el = document.getElementById('input-storage-api-key');
        if (el && el.value) {
          copyToClipboard(el.value, btn);
        } else {
          alert('먼저 [🎲 새 키 생성]을 누르거나 키를 입력해 주세요.');
        }
      }
    </script>
  `;
}