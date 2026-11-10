/**
 * @file src/adminViews.js
 * @description 관리자 제어 센터 메인 뷰 오케스트레이터 및 파사드 모듈 (Facade)
 * - 🎨 [슬림 다크 스크롤바] 전역 6px 커스텀 스크롤바 CSS 적용으로 세로/가로 스크롤 디자인 일체화
 * - 👥 [4단 탭 네비게이션] STORAGE_MODE=true 시 [📊 관제 대시보드] | [👥 사용자 관리] | [📁 공유 서재 관리] | [⚙️ 시스템 설정] 4단 탭 완비
 * - 📂 [다중 공유 서재 & 기기별 폴더 칩 토글 UI] On/Off 스위치, 다중 폴더 추가/삭제, 기기별 폴더 칩 클릭 즉시 권한 부여/회수 완벽 지원
 * - 🛡️ [3중 사용자/기기 자동 감지] apiKeyManager 다중 메서드 + 디스크 3중 탐색으로 단 1대의 기기라도 100% 감지하여 칩 렌더링
 * - ⚡ [폴더 선택기 100% 매칭] openFolderPicker('new-folder-path') 직통 바인딩 및 openFolderModal 호환 별칭 탑재
 */

import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { hasRefreshToken } from '../tokenStore.js';
import { readEnvFile } from './envManager.js';
import { storageService } from './storageService.js';
import { auditLogger } from './auditLogger.js';
import { apiKeyManager } from './apiKeyManager.js';

// 🌟 분리된 전담 뷰 컴포넌트 import
import { renderAuthGateHtml, renderLoginPageHtml } from './views/adminAuthViews.js';
import { renderDashboardTab } from './views/adminDashboardTab.js';
import { renderUsersTab } from './views/adminUsersTab.js';
import { renderSettingsTab } from './views/adminSettingsTab.js';
import { renderFolderModalAndScript } from './views/adminFolderModal.js';

export { renderAuthGateHtml, renderLoginPageHtml };

const SHARED_FOLDERS_CONFIG_FILE = './data/shared_folders.json';

/**
 * 📂 다중 공유 폴더 설정 안전 조회 헬퍼
 * @param {Object} env 
 * @returns {{ enabled: boolean, folders: Array<{ id: string, name: string, path: string, enabled: boolean, allowedDevices: string[] }> }}
 */
function getSharedFoldersConfig(env) {
  let cfg = { enabled: true, folders: [] };
  if (fs.existsSync(SHARED_FOLDERS_CONFIG_FILE)) {
    try {
      cfg = JSON.parse(fs.readFileSync(SHARED_FOLDERS_CONFIG_FILE, 'utf-8'));
    } catch (e) {}
  }
  const legacyDir = env.SHARED_BOOKS_DIR;
  if (cfg.folders.length === 0 && legacyDir && fs.existsSync(legacyDir)) {
    cfg.folders.push({
      id: 'default',
      name: '기본 공유 서재',
      path: legacyDir,
      enabled: true,
      allowedDevices: ['*']
    });
  }
  return cfg;
}

/**
 * 👥 등록된 모든 사용자 및 기기 목록 3중 안전 조회 헬퍼
 * @returns {Array<{ folderName: string, memo: string, devices: Array<any> }>}
 */
function resolveAllUsersAndDevices() {
  let usersList = [];

  // 1차: apiKeyManager 내장 메서드 체인 탐색
  if (typeof apiKeyManager.getUsers === 'function') {
    usersList = apiKeyManager.getUsers();
  } else if (typeof apiKeyManager.getAllUsers === 'function') {
    usersList = apiKeyManager.getAllUsers();
  } else if (typeof apiKeyManager.listUsers === 'function') {
    usersList = apiKeyManager.listUsers();
  } else if (Array.isArray(apiKeyManager.users)) {
    usersList = apiKeyManager.users;
  }

  // 2차: 디스크 ./data/api/keys.json 직접 안전 읽기 백업
  if ((!usersList || usersList.length === 0) && fs.existsSync('./data/api/keys.json')) {
    try {
      const keysData = JSON.parse(fs.readFileSync('./data/api/keys.json', 'utf-8'));
      usersList = Object.values(keysData || {});
    } catch (e) {}
  }

  const result = [];
  const processedFolders = new Set();

  // 사용자별 기기 목록 취합
  if (Array.isArray(usersList)) {
    usersList.forEach(u => {
      if (!u || !u.folderName) return;
      processedFolders.add(u.folderName);
      const devices = typeof apiKeyManager.getUserDevices === 'function' ? apiKeyManager.getUserDevices(u.folderName) : [];
      result.push({
        folderName: u.folderName,
        memo: u.memo || u.folderName,
        devices: devices || []
      });
    });
  }

  // 3차: data/users 디렉터리 내 물리 폴더 직접 스캔 백업
  if (fs.existsSync('./data/users')) {
    try {
      const dirs = fs.readdirSync('./data/users');
      dirs.forEach(dirName => {
        if (!processedFolders.has(dirName) && !dirName.startsWith('.')) {
          const devices = typeof apiKeyManager.getUserDevices === 'function' ? apiKeyManager.getUserDevices(dirName) : [];
          result.push({
            folderName: dirName,
            memo: dirName,
            devices: devices || []
          });
        }
      });
    } catch (e) {}
  }

  return result;
}

/**
 * 📁 [신규 탭] 공유 서재 다중 폴더 및 기기별 폴더 칩(Tag) 권한 관리 탭 HTML 렌더러
 * @param {Object} env 
 * @returns {string}
 */
function renderSharedFoldersTab(env) {
  const cfg = getSharedFoldersConfig(env);
  const usersWithDevices = resolveAllUsersAndDevices();

  // 1. 등록된 공유 폴더 카드 목록 HTML
  const foldersListHtml = cfg.folders.map((f, idx) => {
    const perm = storageService.testDirectoryPermissions(f.path);
    const badgeHtml = perm.readable
      ? '<span class="badge badge-success">정상 (읽기 가능)</span>'
      : `<span class="badge badge-error" style="background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.3);">접근 오류 (${perm.error || '권한 부족'})</span>`;

    const isGlobal = f.allowedDevices.includes('*');

    return `
      <div style="background: #0f172a; border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; gap: 12px;">
        <div style="flex: 1; min-width: 0;">
          <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 4px;">
            <strong style="font-size: 14.5px; color: #38bdf8;">📁 ${f.name}</strong>
            ${badgeHtml}
            <!-- 🌟 [원클릭 전체 허용 칩] 사용자를 안 만들었어도 즉시 토글 가능! -->
            <button type="button" class="folder-chip ${isGlobal ? 'active' : ''}" 
                    style="padding: 2px 10px; font-size: 11px;"
                    onclick="toggleFolderGlobalAccess('${f.id}', this)"
                    title="클릭하여 전체 기기 접근 허용/차단 토글">
              <span>${isGlobal ? '🌐 전체 허용 중' : '🔒 지정 기기만'}</span>
            </button>
          </div>
          <div style="font-size: 12px; color: var(--text-muted); font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            ${f.path}
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
          <label class="switch" title="이 폴더 활성화/비활성화">
            <input type="checkbox" ${f.enabled ? 'checked' : ''} onchange="toggleFolderEnabled('${f.id}', this.checked)">
            <span class="slider"></span>
          </label>
          <button type="button" class="btn-action btn-delete" style="padding: 6px 10px;" onclick="deleteSharedFolder('${f.id}')" title="폴더 삭제">삭제</button>
        </div>
      </div>
    `;
  }).join('') || '<div style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 20px;">등록된 공유 폴더가 없습니다. 아래 폼에서 폴더를 추가해 주세요.</div>';

  // 2. 기기별 폴더 칩(Tag) 권한 매핑 섹션 HTML
  let totalDeviceCount = 0;
  usersWithDevices.forEach(u => { totalDeviceCount += (u.devices?.length || 0); });

  let deviceChipsSectionHtml = '';

  if (usersWithDevices.length === 0 && totalDeviceCount === 0) {
    deviceChipsSectionHtml = `
      <div style="background: #090d16; border: 1px dashed var(--border); border-radius: 8px; padding: 18px; text-align: center;">
        <span style="font-size: 24px; display: block; margin-bottom: 6px;">📱</span>
        <div style="color: #f8fafc; font-size: 13.5px; font-weight: 600; margin-bottom: 4px;">아직 연결된 기기가 없습니다</div>
        <div style="color: var(--text-muted); font-size: 12px; line-height: 1.5;">
          현재 모든 폴더는 상단의 <strong style="color:#38bdf8;">[🌐 전체 허용 중]</strong> 상태로 웹 뷰어에서 바로 이용하실 수 있습니다.<br>
          스마트폰이나 태블릿에서 <strong>[🔢 연결 번호로 로그인]</strong>을 진행하시면 여기에 기기별 맞춤 권한 칩이 자동으로 표출됩니다.
        </div>
      </div>
    `;
  } else {
    deviceChipsSectionHtml = usersWithDevices.map(u => {
      const devices = u.devices || [];
      const devicesHtml = devices.length === 0
        ? '<div style="font-size: 12px; color: var(--text-muted); padding: 6px 0;">(연결된 기기 대기 중 - 6자리 번호 로그인 시 자동 감지)</div>'
        : devices.map(d => {
            const chipsHtml = cfg.folders.map(f => {
              const isAllowed = f.allowedDevices.includes('*') || f.allowedDevices.includes(d.deviceId);
              const chipClass = isAllowed ? 'folder-chip active' : 'folder-chip';
              return `
                <button type="button" class="${chipClass}" 
                        data-folder-id="${f.id}"
                        data-device-id="${d.deviceId}"
                        onclick="toggleDeviceFolderAccess('${f.id}', '${d.deviceId}', this)"
                        title="클릭하여 '${d.deviceName || d.deviceId}' 기기에 '${f.name}' 접근 권한 토글">
                  <span>${isAllowed ? '✔' : '+'}</span>
                  <span>📁 ${f.name}</span>
                </button>
              `;
            }).join('');

            return `
              <div style="background: #090d16; border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; padding: 10px 12px; margin-top: 8px;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                  <span style="font-size: 13px; font-weight: 600; color: #f8fafc;">📱 ${d.deviceName || d.deviceId}</span>
                  <span style="font-size: 11px; color: var(--text-muted);">최근: ${d.lastActiveAt ? new Date(d.lastActiveAt).toLocaleString('ko-KR') : '기록 없음'}</span>
                </div>
                <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                  ${chipsHtml || '<span style="font-size: 11.5px; color: var(--text-muted);">부여할 수 있는 공유 폴더가 없습니다.</span>'}
                </div>
              </div>
            `;
          }).join('');

      return `
        <div style="background: #0f172a; border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px;">
          <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 8px;">
            <strong style="font-size: 14px; color: #38bdf8;">👤 ${u.memo}</strong>
            <span style="font-size: 12px; color: var(--text-muted); font-family: monospace;">(${u.folderName})</span>
          </div>
          ${devicesHtml}
        </div>
      `;
    }).join('');
  }

  return `
    <!-- 1. 전체 기능 On/Off 스위치 카드 -->
    <div class="card">
      <div class="toggle-row" style="margin-bottom: 0;">
        <div class="toggle-info">
          <h4 style="color: #38bdf8; font-size: 15px;">📚 공유 도서 라이브러리 전체 기능 활성화</h4>
          <p>비활성화 시 모든 사용자의 웹 뷰어에서 [공유 서재] 버튼이 숨겨지고 외부 도서 접근이 즉각 차단됩니다.</p>
        </div>
        <label class="switch">
          <input type="checkbox" id="toggle-shared-lib-master" ${cfg.enabled ? 'checked' : ''} onchange="toggleMasterSharedLibrary(this.checked)">
          <span class="slider"></span>
        </label>
      </div>
    </div>

    <!-- 2. 등록된 공유 폴더 목록 카드 -->
    <div class="card">
      <div class="section-title">
        <span>📁 등록된 공유 도서 폴더 (${cfg.folders.length}개)</span>
        <span style="font-size: 12px; color: var(--text-muted);">서버 디스크의 실제 폴더를 연결합니다</span>
      </div>
      ${foldersListHtml}

      <!-- 새 폴더 추가 폼 -->
      <div style="background: #090d16; border: 1px dashed var(--border); border-radius: 10px; padding: 16px; margin-top: 14px;">
        <h4 style="margin: 0 0 12px 0; font-size: 13.5px; color: #38bdf8;">➕ 새 공유 도서 폴더 등록</h4>
        <div class="form-row" style="margin-bottom: 10px;">
          <div class="form-group" style="flex: 1;">
            <label>폴더 표시 이름</label>
            <input type="text" id="new-folder-name" placeholder="예: 판타지 소설 (2024년)" autocomplete="off">
          </div>
          <div class="form-group" style="flex: 2;">
            <label>서버 실제 절대 경로 (우분투 /home/ubuntu/...)</label>
            <div class="input-btn-group">
              <input type="text" id="new-folder-path" placeholder="/home/ubuntu/userbook" autocomplete="off">
              <button type="button" class="btn-browse" onclick="openFolderPicker('new-folder-path')">찾아보기</button>
            </div>
          </div>
        </div>
        <button type="button" class="btn-submit" style="background: #0d9488; height: 42px; font-size: 14px; padding: 0 16px;" onclick="addNewSharedFolder()">
          ➕ 공유 폴더 등록
        </button>
      </div>
    </div>

    <!-- 3. 기기별 폴더 칩(Tag) 권한 매핑 카드 -->
    <div class="card">
      <div class="section-title">
        <span>📱 기기별 폴더 칩(Tag) 접근 권한 설정</span>
        <span style="font-size: 12px; color: #a78bfa;">은닉화(Stealth): 권한 없는 폴더는 클라이언트에 아예 안 뜸</span>
      </div>
      <p style="font-size: 12.5px; color: var(--text-muted); margin: 0 0 14px 0; line-height: 1.5;">
        각 기기 카드에 표출된 <strong>폴더 칩을 클릭</strong>하면 권한이 즉시 부여/회수됩니다.<br>
        <span style="color:#38bdf8; font-weight:600;">[✔ 칩 활성]</span> 상태인 폴더만 해당 기기의 웹 뷰어에서 깔끔하게 노출됩니다.
      </p>
      ${deviceChipsSectionHtml}
    </div>
  `;
}

/**
 * 🎨 웹 설정 대시보드 본문 HTML 렌더러
 * @param {import('http').IncomingMessage} req 
 * @param {string|null} [successMessage=null] 
 * @param {string|null} [errorMessage=null] 
 * @param {Object|null} [newIssuedKeyInfo=null] - 신규 발급 또는 재발급된 API 키 정보
 * @returns {string}
 */
export function renderAdminSettingsHtml(req, successMessage = null, errorMessage = null, newIssuedKeyInfo = null) {
  const env = readEnvFile();
  const hasToken = hasRefreshToken();
  const sharedBooksDir = env.SHARED_BOOKS_DIR || '';
  const isStorageMode = env.STORAGE_MODE === 'true';

  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || `${config.host}:${config.port}`;
  const currentServerUrl = `${protocol}://${host}`;
  const redirectUri = env.GOOGLE_REDIRECT_URI || `${currentServerUrl}/auth/google/callback`;
  const readerUrl = env.READER_URL || config.security?.readerUrl || 'https://epubwebview.vercel.app';

  const metrics = auditLogger.getStorageMetrics();
  const recentLogs = auditLogger.getRecentLogs();
  const crashReports = storageService.getCrashReportsList();

  let sharedDirBadge = '<span class="badge badge-warning">미설정</span>';
  if (sharedBooksDir) {
    const perm = storageService.testDirectoryPermissions(sharedBooksDir);
    if (perm.readable) {
      sharedDirBadge = '<span class="badge badge-success">읽기 가능 (정상)</span>';
    } else {
      sharedDirBadge = `<span class="badge badge-error" style="background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.3);">접근 불가 (${perm.error || '권한 부족'})</span>`;
    }
  }

  let alertBanner = '';
  if (successMessage) {
    alertBanner = `<div class="alert alert-success">✔ ${successMessage}</div>`;
  } else if (errorMessage) {
    alertBanner = `<div class="alert alert-error">❌ ${errorMessage}</div>`;
  }

  const dashboardTabContent = renderDashboardTab(metrics, recentLogs, crashReports, env);
  const usersTabContent = renderUsersTab(env);
  const sharedFoldersTabContent = isStorageMode ? renderSharedFoldersTab(env) : '';
  const settingsTabContent = renderSettingsTab({
    env,
    config,
    currentServerUrl,
    redirectUri,
    hasToken,
    sharedDirBadge
  });
  const modalAndScriptContent = renderFolderModalAndScript();

  let keyModalHtml = '';
  if (newIssuedKeyInfo && newIssuedKeyInfo.apiKey) {
    keyModalHtml = `
      <div class="modal-overlay active" id="modal-new-key-alert">
        <div class="modal-box" style="max-width: 480px; text-align: center;">
          <div class="modal-header">
            <h3 style="color: #10b981;">🎉 새 API 키 발급 완료</h3>
            <button type="button" class="modal-close-btn" onclick="closeKeyAlertModal()">&times;</button>
          </div>
          <div class="modal-body" style="padding: 24px 20px;">
            <p style="font-size: 13.5px; color: #f8fafc; margin: 0 0 10px 0;">
              <strong>${newIssuedKeyInfo.memo}</strong> (${newIssuedKeyInfo.folderName}) 서재에 접근할 API 키입니다.
            </p>
            <p style="font-size: 12px; color: var(--warning); margin: 0 0 16px 0;">
              ⚠️ 보안을 위해 이 창을 닫으면 키 원문을 다시 확인할 수 없습니다.<br>반드시 지금 복사하여 사용자에게 전달하세요!
            </p>
            <div class="copy-box" style="margin-bottom: 16px; background: #0b1120; border-color: #38bdf8;">
              <span class="copy-text" id="text-new-issued-key" style="font-size: 14px; font-weight: 700; color: #38bdf8;">${newIssuedKeyInfo.apiKey}</span>
              <button type="button" class="btn-copy" style="background: #0284c7;" onclick="copyToClipboard('${newIssuedKeyInfo.apiKey}', this)">키 복사</button>
            </div>
            <div style="font-size: 11.5px; color: var(--text-muted); text-align: left; background: #0f172a; padding: 10px; border-radius: 6px; border: 1px solid var(--border);">
              • 서버 주소: <strong>${currentServerUrl}</strong><br>
              • 유효 시간: 24시간 내 웹 뷰어에서 1회 인증 시 영구 활성화
            </div>
          </div>
          <div class="modal-footer" style="justify-content: center;">
            <button type="button" class="btn-modal-select" style="min-width: 120px;" onclick="closeKeyAlertModal()">확인 완료</button>
          </div>
        </div>
      </div>
      <script>
        function closeKeyAlertModal() {
          const el = document.getElementById('modal-new-key-alert');
          if (el) el.classList.remove('active');
        }
      </script>
    `;
  }

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>⚙️ EPUB Server 제어 센터</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }

    * {
      scrollbar-width: thin;
      scrollbar-color: #334155 transparent;
    }
    ::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    ::-webkit-scrollbar-track {
      background: transparent;
    }
    ::-webkit-scrollbar-thumb {
      background: #334155;
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: #475569;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 24px 16px;
      display: flex;
      justify-content: center;
      min-height: 100vh;
      box-sizing: border-box;
    }
    .container {
      max-width: 760px;
      width: 100%;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
    }
    .header h1 {
      font-size: 22px;
      margin: 0 0 4px 0;
      font-weight: 700;
    }
    .header p {
      color: var(--text-muted);
      font-size: 13px;
      margin: 0;
    }
    .btn-logout {
      background: #334155;
      color: #f1f5f9;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 13px;
      text-decoration: none;
      transition: background 0.2s;
    }
    .btn-logout:hover {
      background: var(--danger);
      border-color: var(--danger);
    }

    .tab-nav {
      display: flex;
      gap: 6px;
      background: #090d16;
      padding: 6px;
      border-radius: 12px;
      border: 1px solid var(--border);
      margin-bottom: 20px;
    }
    .tab-btn {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13.5px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .tab-btn:hover {
      color: var(--text);
      background: rgba(255, 255, 255, 0.04);
    }
    .tab-btn.active {
      background: var(--card-bg);
      color: #38bdf8;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      border: 1px solid var(--border);
    }
    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: block;
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 22px;
      margin-bottom: 20px;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
    }
    .section-title {
      font-size: 15.5px;
      font-weight: 600;
      margin: 0 0 14px 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .badge {
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 9999px;
      font-weight: 500;
    }
    .badge-success { background: rgba(16, 185, 129, 0.15); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-warning { background: rgba(245, 158, 11, 0.15); color: var(--warning); border: 1px solid rgba(245, 158, 11, 0.3); }
    .badge-info { background: rgba(59, 130, 246, 0.15); color: var(--primary); border: 1px solid rgba(59, 130, 246, 0.3); }

    .stat-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-bottom: 18px;
    }
    .stat-card {
      background: #0f172a;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 12px;
      text-align: center;
    }
    .stat-label {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    .stat-value {
      font-size: 18px;
      font-weight: 800;
      color: #38bdf8;
    }

    .data-table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }
    .data-table th {
      border-bottom: 1px solid var(--border);
      padding: 10px 8px;
      font-size: 11.5px;
      color: var(--text-muted);
      text-transform: uppercase;
      font-weight: 600;
    }
    .data-table td {
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      padding: 10px 8px;
    }

    /* 🏷️ 인터랙티브 폴더 칩(Tag) 스타일 */
    .folder-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 5px 12px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid var(--border);
      background: #0f172a;
      color: var(--text-muted);
      transition: all 0.2s;
      user-select: none;
      outline: none;
    }
    .folder-chip:hover {
      border-color: #38bdf8;
      color: #f8fafc;
      transform: translateY(-1px);
    }
    .folder-chip.active {
      background: rgba(56, 189, 248, 0.16);
      border-color: #38bdf8;
      color: #38bdf8;
      box-shadow: 0 0 10px rgba(56, 189, 248, 0.25);
    }

    .copy-box {
      display: flex;
      align-items: center;
      background: #0f172a;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px 10px;
      margin-top: 6px;
    }
    .copy-text {
      flex: 1;
      font-family: monospace;
      font-size: 13px;
      color: #38bdf8;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .btn-copy {
      background: #334155;
      color: var(--text);
      border: none;
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      margin-left: 8px;
      transition: background 0.2s;
      flex-shrink: 0;
    }
    .btn-copy:hover {
      background: #475569;
    }

    .form-group {
      margin-bottom: 16px;
    }
    .form-group:last-child {
      margin-bottom: 0;
    }
    .form-row {
      display: flex;
      gap: 12px;
    }
    .form-row .form-group {
      flex: 1;
    }
    label {
      display: block;
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    input[type="text"], input[type="password"], input[type="number"] {
      width: 100%;
      background: #0f172a;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      padding: 10px 12px;
      font-size: 14px;
      box-sizing: border-box;
      outline: none;
      transition: border-color 0.2s;
    }
    input[type="text"]:focus, input[type="password"]:focus, input[type="number"]:focus {
      border-color: var(--primary);
    }

    .input-btn-group {
      display: flex;
      gap: 8px;
    }
    .btn-browse {
      background: #334155;
      color: #38bdf8;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0 16px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.2s;
    }
    .btn-browse:hover {
      background: #475569;
      color: white;
    }

    .toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px;
      background: #0f172a;
      border: 1px solid var(--border);
      border-radius: 10px;
    }
    .toggle-info h4 {
      margin: 0 0 4px 0;
      font-size: 14px;
    }
    .toggle-info p {
      margin: 0;
      font-size: 12px;
      color: var(--text-muted);
    }
    .switch {
      position: relative;
      display: inline-block;
      width: 48px;
      height: 26px;
      flex-shrink: 0;
    }
    .switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .slider {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background-color: #334155;
      transition: .3s;
      border-radius: 34px;
    }
    .slider:before {
      position: absolute;
      content: "";
      height: 18px;
      width: 18px;
      left: 4px;
      bottom: 4px;
      background-color: white;
      transition: .3s;
      border-radius: 50%;
    }
    input:checked + .slider {
      background-color: var(--success);
    }
    input:checked + .slider:before {
      transform: translateX(22px);
    }

    .btn-submit {
      width: 100%;
      background: var(--primary);
      color: white;
      border: none;
      border-radius: 8px;
      padding: 12px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn-submit:hover {
      background: var(--primary-hover);
    }

    .btn-return {
      display: block;
      text-align: center;
      background: transparent;
      color: var(--text-muted);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
      font-size: 14px;
      text-decoration: none;
      margin-top: 14px;
      transition: all 0.2s;
    }
    .btn-return:hover {
      background: rgba(255,255,255,0.05);
      color: var(--text);
    }

    .btn-action {
      display: inline-block;
      text-decoration: none;
      font-size: 11px;
      font-weight: 600;
      padding: 4px 8px;
      border-radius: 5px;
      transition: background 0.2s;
    }
    .btn-delete {
      background: rgba(239,68,68,0.2);
      color: #f87171;
      border: 1px solid rgba(239,68,68,0.3);
      cursor: pointer;
    }
    .btn-delete:hover { background: #ef4444; color: white; }

    .alert {
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 14px;
      margin-bottom: 20px;
    }
    .alert-success {
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .alert-error {
      background: rgba(239, 68, 68, 0.15);
      color: var(--danger);
      border: 1px solid rgba(239, 68, 68, 0.3);
    }

    /* 🛡️ [모달 기본 은닉 및 팝업 활성화 가드] */
    .modal-overlay, #modal-folder-picker, #folder-picker-modal {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(4px);
      display: none !important;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      padding: 16px;
      box-sizing: border-box;
    }
    .modal-overlay.active, #modal-folder-picker.active, #folder-picker-modal.active {
      display: flex !important;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1>⚙️ EPUB Server 제어 센터</h1>
        <p>Google OAuth 프록시 및 다중 사용자 스토리지 통합 관제</p>
      </div>
      <a href="/admin/logout" class="btn-logout">🔒 로그아웃</a>
    </div>

    ${alertBanner}

    <div class="tab-nav">
      <button type="button" class="tab-btn active" id="tab-btn-dashboard" onclick="switchAdminTab('dashboard')">
        <span>📊</span> 관제 대시보드
      </button>
      ${isStorageMode ? `
      <button type="button" class="tab-btn" id="tab-btn-users" onclick="switchAdminTab('users')">
        <span>👥</span> 사용자 관리
      </button>
      <button type="button" class="tab-btn" id="tab-btn-shared-folders" onclick="switchAdminTab('shared-folders')">
        <span>📁</span> 공유 서재 관리
      </button>
      ` : ''}
      <button type="button" class="tab-btn" id="tab-btn-settings" onclick="switchAdminTab('settings')">
        <span>⚙️</span> 시스템 설정
      </button>
    </div>

    <div id="tab-content-dashboard" class="tab-content active">
      ${dashboardTabContent}
    </div>

    ${isStorageMode ? `
    <div id="tab-content-users" class="tab-content">
      ${usersTabContent}
    </div>
    <div id="tab-content-shared-folders" class="tab-content">
      ${sharedFoldersTabContent}
    </div>
    ` : ''}

    <div id="tab-content-settings" class="tab-content">
      ${settingsTabContent}
    </div>

    <a href="${readerUrl}" class="btn-return">📖 EPUB 웹 서재로 돌아가기</a>
  </div>

  ${modalAndScriptContent}
  ${keyModalHtml}

  <script>
    function switchAdminTab(tabName) {
      var tabs = ['dashboard', 'users', 'shared-folders', 'settings'];
      for (var i = 0; i < tabs.length; i++) {
        var t = tabs[i];
        var btn = document.getElementById('tab-btn-' + t);
        var content = document.getElementById('tab-content-' + t);
        if (btn) {
          if (t === tabName) btn.classList.add('active');
          else btn.classList.remove('active');
        }
        if (content) {
          if (t === tabName) content.classList.add('active');
          else content.classList.remove('active');
        }
      }

      try {
        localStorage.setItem('admin_active_tab', tabName);
      } catch (e) {}
    }

    (function initTabState() {
      try {
        var savedTab = localStorage.getItem('admin_active_tab');
        if (savedTab && (savedTab === 'settings' || savedTab === 'users' || savedTab === 'shared-folders')) {
          switchAdminTab(savedTab);
        }
      } catch (e) {}
    })();

    // 🌟 [호환성 안전망] openFolderModal 이 호출되어도 openFolderPicker 로 100% 매칭 실행!
    window.openFolderModal = function(targetId) {
      if (typeof openFolderPicker === 'function') {
        openFolderPicker(targetId);
      }
    };

    // -----------------------------------------------------------------------
    // 📁 [공유 서재 관리 REST API 비동기 제어 스크립트 - 무결점 순수 JS]
    // -----------------------------------------------------------------------
    async function fetchSharedFoldersConfig() {
      var res = await fetch('/api/storage/admin/shared-folders');
      var data = await res.json();
      return data.config || { enabled: true, folders: [] };
    }

    async function saveSharedFoldersConfig(newConfig) {
      var res = await fetch('/api/storage/admin/shared-folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newConfig)
      });
      return res.ok;
    }

    // 1. 전체 On/Off 스위치 토글
    async function toggleMasterSharedLibrary(isEnabled) {
      try {
        var cfg = await fetchSharedFoldersConfig();
        cfg.enabled = isEnabled;
        var ok = await saveSharedFoldersConfig(cfg);
        if (ok) {
          showFloatingToast(isEnabled ? '공유 라이브러리가 활성화되었습니다.' : '공유 라이브러리가 비활성화되었습니다.');
        }
      } catch (e) {
        alert('설정 저장 실패: ' + e.message);
      }
    }

    // 2. 단일 폴더 활성/비활성 스위치
    async function toggleFolderEnabled(folderId, isEnabled) {
      try {
        var cfg = await fetchSharedFoldersConfig();
        var f = cfg.folders.find(function(x) { return x.id === folderId; });
        if (f) {
          f.enabled = isEnabled;
          await saveSharedFoldersConfig(cfg);
          showFloatingToast("'" + f.name + "' 상태가 변경되었습니다.");
        }
      } catch (e) {
        alert('폴더 상태 변경 실패: ' + e.message);
      }
    }

    // 3. 새 폴더 추가
    async function addNewSharedFolder() {
      var nameInput = document.getElementById('new-folder-name');
      var pathInput = document.getElementById('new-folder-path');
      var name = nameInput ? nameInput.value.trim() : '';
      var folderPath = pathInput ? pathInput.value.trim() : '';

      if (!name || !folderPath) {
        alert('폴더 표시 이름과 서버 실제 경로를 모두 입력해 주세요.');
        return;
      }

      try {
        var cfg = await fetchSharedFoldersConfig();
        var newId = 'folder_' + Date.now().toString(36);
        cfg.folders.push({
          id: newId,
          name: name,
          path: folderPath,
          enabled: true,
          allowedDevices: ['*'] // 기본값: 전체 기기 허용
        });

        var ok = await saveSharedFoldersConfig(cfg);
        if (ok) {
          alert("새 공유 폴더('" + name + "')가 성공적으로 등록되었습니다!");
          window.location.reload();
        }
      } catch (e) {
        alert('폴더 추가 실패: ' + e.message);
      }
    }

    // 4. 폴더 삭제
    async function deleteSharedFolder(folderId) {
      if (!confirm('이 공유 폴더를 목록에서 삭제하시겠습니까?\\n(실제 디스크 파일은 삭제되지 않습니다)')) return;
      try {
        var cfg = await fetchSharedFoldersConfig();
        cfg.folders = cfg.folders.filter(function(x) { return x.id !== folderId; });
        var ok = await saveSharedFoldersConfig(cfg);
        if (ok) {
          window.location.reload();
        }
      } catch (e) {
        alert('폴더 삭제 실패: ' + e.message);
      }
    }

    // 5. 🌐 [단일 폴더 전체 기기 허용 토글 칩] (사용자가 없어도 원클릭 제어!)
    async function toggleFolderGlobalAccess(folderId, btnEl) {
      try {
        var cfg = await fetchSharedFoldersConfig();
        var folder = cfg.folders.find(function(x) { return x.id === folderId; });
        if (!folder) return;

        var isCurrentlyGlobal = folder.allowedDevices.includes('*');
        if (isCurrentlyGlobal) {
          // 전체 허용 ➔ 지정 기기만 모드로 전환 (일단 빈 배열)
          folder.allowedDevices = [];
        } else {
          // 지정 기기 ➔ 전체 허용으로 전환
          folder.allowedDevices = ['*'];
        }

        var ok = await saveSharedFoldersConfig(cfg);
        if (ok) {
          var willBeGlobal = !isCurrentlyGlobal;
          if (willBeGlobal) btnEl.classList.add('active');
          else btnEl.classList.remove('active');
          var textSpan = btnEl.querySelector('span');
          if (textSpan) textSpan.textContent = willBeGlobal ? '🌐 전체 허용 중' : '🔒 지정 기기만';
          showFloatingToast(willBeGlobal ? ("'" + folder.name + "' 전체 기기 접근이 허용되었습니다.") : ("'" + folder.name + "' 지정 기기 전용으로 변경되었습니다."));
          setTimeout(function() { window.location.reload(); }, 600);
        }
      } catch (e) {
        alert('설정 변경 실패: ' + e.message);
      }
    }

    // 6. 🏷️ 기기별 폴더 칩(Tag) 토글 권한 부여/회수
    async function toggleDeviceFolderAccess(folderId, deviceId, chipEl) {
      try {
        var cfg = await fetchSharedFoldersConfig();
        var folder = cfg.folders.find(function(x) { return x.id === folderId; });
        if (!folder) return;

        if (folder.allowedDevices.includes('*')) {
          folder.allowedDevices = [];
          var allChips = document.querySelectorAll('.folder-chip');
          for (var i = 0; i < allChips.length; i++) {
            var devId = allChips[i].getAttribute('data-device-id');
            if (devId && !folder.allowedDevices.includes(devId)) {
              folder.allowedDevices.push(devId);
            }
          }
        }

        var idx = folder.allowedDevices.indexOf(deviceId);
        var willAllow = idx === -1;

        if (willAllow) {
          folder.allowedDevices.push(deviceId);
        } else {
          folder.allowedDevices.splice(idx, 1);
        }

        var ok = await saveSharedFoldersConfig(cfg);
        if (ok) {
          if (willAllow) {
            chipEl.classList.add('active');
          } else {
            chipEl.classList.remove('active');
          }
          var iconSpan = chipEl.querySelector('span:first-child');
          if (iconSpan) iconSpan.textContent = willAllow ? '✔' : '+';
          showFloatingToast(willAllow ? ("'" + folder.name + "' 접근 권한이 부여되었습니다.") : ("'" + folder.name + "' 접근 권한이 회수되었습니다."));
        }
      } catch (e) {
        alert('권한 변경 실패: ' + e.message);
      }
    }

    function showFloatingToast(msg) {
      var toast = document.getElementById('admin-floating-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'admin-floating-toast';
        toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#10b981;color:white;padding:10px 20px;border-radius:8px;font-size:13.5px;font-weight:600;box-shadow:0 10px 25px rgba(0,0,0,0.5);z-index:99999;transition:opacity 0.3s;';
        document.body.appendChild(toast);
      }
      toast.textContent = msg;
      toast.style.opacity = '1';
      clearTimeout(window.__adminToastTimer);
      window.__adminToastTimer = setTimeout(function() { toast.style.opacity = '0'; }, 2200);
    }
  </script>
</body>
</html>`;
}