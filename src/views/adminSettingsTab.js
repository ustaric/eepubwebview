/**
 * @file src/views/adminSettingsTab.js
 * @description 관리자 제어 센터 [탭 2: ⚙️ 시스템 설정] HTML 렌더러 모듈
 * - 🔔 [Discord 관제 알림 센터] 웹훅 URL 입력, 실시간 체크 옵션 포함 연결 테스트, 6대 체크박스 필터 및 로그 있을 때만 정기보고 UI 완비
 * - 📦 [1KB 분기 정책 안내] 1KB 이하 본문 codeblock / 1KB 초과 시 .json 첨부 발송 안내 배지 탑재
 * - 🛡️ [스토리지 API 보안 설정 단일화] 번잡한 박스를 제거하고 엄격 검증 모드 토글만 단정하게 유지
 * - 📋 [주요 접속 정보 복사] GitHub 저장소, 서버 주소, OAuth 리디렉션 URI 원클릭 복사 카드
 * - 🔑 [Google OAuth 연동] 토큰 보유 상태 표출 및 로그인 링크
 * - 📁 [스토리지 모드 토글] 개인 서버 자체 저장소 모드 On/Off 스위치
 * - 📚 [공유 라이브러리 지정] 공유 도서 폴더 경로 입력 및 실측 권한 배지
 * - 🛠️ [시스템 상세 설정 폼] PORT, HOST, CORS, 구글 인증키, 관리자 비밀번호 변경 등 14대 환경변수 폼
 */

// 공식 깃허브 저장소 주소
const GITHUB_REPO_URL = 'https://github.com/ustaric/refresh-server';

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

  // 🔔 Discord 설정 파싱
  const discordWebhookUrl = env.DISCORD_WEBHOOK_URL || '';
  const alertTypes = (env.DISCORD_ALERT_TYPES || '500,RESOURCE').split(',').map(s => s.trim());
  const isDailyDigest = env.DISCORD_DAILY_DIGEST === 'true';

  const port = env.PORT || String(config.port || '3001');
  const serverHost = env.HOST || config.host || '127.0.0.1';
  const tokenFile = env.TOKEN_FILE || './data/token.enc';
  const readerUrl = env.READER_URL || config.security?.readerUrl || 'https://epubwebview.vercel.app';
  const clientId = env.GOOGLE_CLIENT_ID || '';
  const allowedOrigin = env.ALLOWED_ORIGIN || '*';
  const hasSecret = Boolean(env.GOOGLE_CLIENT_SECRET);
  const hasKey = Boolean(env.TOKEN_ENCRYPTION_KEY);

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

    <!-- 2. 🔔 Discord 실시간 관제 및 보안 알림 센터 -->
    <div class="card" id="card-discord-settings">
      <div class="section-title">
        <span>🔔 Discord 실시간 관제 및 보안 알림</span>
        <span class="badge ${discordWebhookUrl ? 'badge-success' : 'badge-warning'}" id="badge-discord-status">
          ${discordWebhookUrl ? '연동 중' : '미연동'}
        </span>
      </div>
      <p style="font-size: 13px; color: var(--text-muted); margin: 0 0 14px 0;">
        서버 내부 장애, 침입 차단 및 자원 과부하 발생 시 디스코드 채널로 실시간 알림 카드를 발송합니다.<br>
        <span style="color: var(--primary); font-size: 12px;">ℹ️ 로그가 1KB 이하인 경우 본문에 즉시 출력되며, 1KB 초과 시 .json 파일로 자동 첨부됩니다.</span>
      </p>

      <div class="form-group">
        <label>Discord 웹훅 URL (Incoming Webhook URL)</label>
        <div class="input-btn-group">
          <input type="password" id="input-discord-webhook" value="${escapeHtml(discordWebhookUrl)}" placeholder="https://discord.com/api/webhooks/..." autocomplete="new-password">
          <button type="button" class="btn-copy" onclick="toggleWebhookVisibility(this)">👁️ 보기</button>
          <button type="button" class="btn-browse" id="btn-test-discord" onclick="testDiscordWebhook()">🧪 연결 테스트</button>
        </div>
      </div>

      <div style="margin-top: 16px; padding: 14px; background: rgba(0,0,0,0.2); border-radius: 8px; border: 1px solid var(--border-color);">
        <label style="font-weight: 600; font-size: 13.5px; display: block; margin-bottom: 10px;">
          🎯 수신할 알림 이벤트 선택 (6대 필터)
        </label>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; font-size: 13px;">
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
            <input type="checkbox" class="discord-filter-cb" value="500" ${alertTypes.includes('500') ? 'checked' : ''}>
            <span>🚨 <strong>HTTP 500</strong> 서버 내부 오류</span>
          </label>
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
            <input type="checkbox" class="discord-filter-cb" value="401" ${alertTypes.includes('401') ? 'checked' : ''}>
            <span>🔒 <strong>HTTP 401</strong> 인증 실패 (키 오류)</span>
          </label>
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
            <input type="checkbox" class="discord-filter-cb" value="403" ${alertTypes.includes('403') ? 'checked' : ''}>
            <span>⛔ <strong>HTTP 403</strong> 접근 권한 거부</span>
          </label>
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
            <input type="checkbox" class="discord-filter-cb" value="429" ${alertTypes.includes('429') ? 'checked' : ''}>
            <span>🚦 <strong>HTTP 429</strong> 요청 제한 초과</span>
          </label>
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
            <input type="checkbox" class="discord-filter-cb" value="ATTACK" ${alertTypes.includes('ATTACK') ? 'checked' : ''}>
            <span>🛡️ 비정상 접근 및 변칙 메서드 차단</span>
          </label>
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
            <input type="checkbox" class="discord-filter-cb" value="RESOURCE" ${alertTypes.includes('RESOURCE') ? 'checked' : ''}>
            <span>⚠️ CPU / RAM / DISK 80% 초과</span>
          </label>
        </div>

        <div style="margin-top: 14px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 10px;">
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
            <input type="checkbox" id="cb-discord-daily-digest" ${isDailyDigest ? 'checked' : ''}>
            <span>📊 <strong>일일 보안 정기 보고</strong> (당일 차단/오류 로그가 1건 이상 있을 때만 발송)</span>
          </label>
          <p style="font-size: 11.5px; color: var(--text-muted); margin: 4px 0 0 24px;">
            ※ 위협이 0건인 날에는 알림을 울리지 않고 침묵합니다.
          </p>
        </div>
      </div>

      <div style="margin-top: 14px; display: flex; justify-content: flex-end;">
        <button type="button" class="btn-submit" id="btn-save-discord" style="margin: 0; width: auto; padding: 8px 18px; font-size: 13px;" onclick="saveDiscordSettings()">
          💾 디스코드 관제 설정 저장
        </button>
      </div>
    </div>

    <form method="POST" action="/admin/save">
      <!-- 🌟 기존 마스터 API 키 환경변수 무손실 보존 히든 필드 -->
      <input type="hidden" name="STORAGE_API_KEY" value="${escapeHtml(storageApiKey)}">

      <!-- 3. Google OAuth 토큰 상태 및 재인증 -->
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

      <!-- 4. 개인 서버 저장소 모드 스위치 -->
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
            <p>체크 시 Google Drive 대신 이 서버의 디스크(./data/books 및 ./data/users)에 책과 진도율을 동기화합니다.</p>
          </div>
          <label class="switch">
            <input type="checkbox" name="STORAGE_MODE" value="true" ${isStorageMode ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        </div>
      </div>

      <!-- 5. 🛡️ 스토리지 전용 엄격 API 키 검증 모드 (단일화) -->
      <div class="card">
        <div class="section-title">
          <span>🛡️ 서버 API 보안 방어선</span>
          <span class="badge ${isEnforceApiKey ? 'badge-success' : 'badge-warning'}">
            ${isEnforceApiKey ? '엄격 키 검증 활성' : '호환 모드'}
          </span>
        </div>
        <p style="font-size: 12.5px; color: var(--text-muted); margin: 0 0 14px 0;">
          ※ 개별 사용자 API 키 발급 및 기기 관리는 상단 <strong>[👥 사용자 관리]</strong> 탭에서 전담합니다.
        </p>

        <div class="toggle-row">
          <div class="toggle-info">
            <h4>엄격 API 키 검증 강제 (ENFORCE_STORAGE_API_KEY)</h4>
            <p style="margin-bottom: 4px;">체크 시 올바른 API 키가 없는 모든 스토리지 요청을 즉시 401로 차단합니다.</p>
            <p style="color: var(--warning); font-size: 11.5px; margin: 0;">
              ※ 주의: 웹 뷰어에 키를 등록하기 전에는 체크를 해제해 두세요. (체크 해제 시 기존 뷰어 100% 정상 작동)
            </p>
          </div>
          <label class="switch">
            <input type="checkbox" name="ENFORCE_STORAGE_API_KEY" value="true" ${isEnforceApiKey ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        </div>
      </div>

      <!-- 6. 공유 도서 라이브러리 폴더 지정 (간이 탐색기 연동) -->
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

      <!-- 7. 상세 환경변수 설정 -->
      <div class="card">
        <div class="section-title">
          <span>🛠️ 시스템 상세 설정 (.env 환경변수)</span>
        </div>

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
      function toggleWebhookVisibility(btn) {
        const input = document.getElementById('input-discord-webhook');
        if (input.type === 'password') {
          input.type = 'text';
          btn.textContent = '🔒 숨기기';
        } else {
          input.type = 'password';
          btn.textContent = '👁️ 보기';
        }
      }

      // 🌟 [고도화] 테스트 전송 시 현재 체크된 6대 항목 및 정기보고 옵션을 실시간 수집하여 함께 전송
      async function testDiscordWebhook() {
        const urlInput = document.getElementById('input-discord-webhook');
        const webhookUrl = urlInput.value.trim();
        const testBtn = document.getElementById('btn-test-discord');

        if (!webhookUrl) {
          alert('웹훅 URL을 먼저 입력해 주세요.');
          urlInput.focus();
          return;
        }

        const checkboxes = document.querySelectorAll('.discord-filter-cb:checked');
        const selectedAlertTypes = Array.from(checkboxes).map(cb => cb.value).join(',');
        const dailyDigest = document.getElementById('cb-discord-daily-digest').checked;

        testBtn.disabled = true;
        testBtn.textContent = '⏳ 전송 중...';

        try {
          const res = await fetch('/api/admin/discord-webhook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'test',
              webhookUrl,
              alertTypes: selectedAlertTypes,
              dailyDigest
            })
          });
          const data = await res.json();
          alert(data.message || (data.ok ? '테스트 알림이 발송되었습니다!' : '발송 실패'));
        } catch (err) {
          alert('테스트 전송 오류: ' + err.message);
        } finally {
          testBtn.disabled = false;
          testBtn.textContent = '🧪 연결 테스트';
        }
      }

      async function saveDiscordSettings() {
        const urlInput = document.getElementById('input-discord-webhook');
        const webhookUrl = urlInput.value.trim();
        const saveBtn = document.getElementById('btn-save-discord');
        const badge = document.getElementById('badge-discord-status');

        const checkboxes = document.querySelectorAll('.discord-filter-cb:checked');
        const selectedAlertTypes = Array.from(checkboxes).map(cb => cb.value).join(',');
        const dailyDigest = document.getElementById('cb-discord-daily-digest').checked;

        saveBtn.disabled = true;
        saveBtn.textContent = '⏳ 저장 중...';

        try {
          const res = await fetch('/api/admin/discord-webhook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'save',
              webhookUrl,
              alertTypes: selectedAlertTypes,
              dailyDigest
            })
          });
          const data = await res.json();

          if (data.ok) {
            alert('✅ Discord 관제 알림 설정이 안전하게 저장되었습니다!');
            if (badge) {
              badge.textContent = webhookUrl ? '연동 중' : '미연동';
              badge.className = webhookUrl ? 'badge badge-success' : 'badge badge-warning';
            }
          } else {
            alert('❌ 설정 저장 실패: ' + (data.error || '알 수 없는 오류'));
          }
        } catch (err) {
          alert('설정 저장 통신 오류: ' + err.message);
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = '💾 디스코드 관제 설정 저장';
        }
      }
    </script>
  `;
}