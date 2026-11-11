/**
 * @file src/adminViews.js
 * @description 관리자 제어 센터 메인 뷰 오케스트레이터 및 파사드 모듈 (Facade)
 * - 🎨 [슬림 다크 스크롤바] 전역 6px 커스텀 스크롤바 CSS 적용으로 세로/가로 스크롤 디자인 일체화
 * - 👥 [4단 탭 네비게이션] STORAGE_MODE=true 시 [📊 관제 대시보드] | [👥 사용자 관리] | [📁 공유 서재 관리] | [⚙️ 시스템 설정] 4단 탭 완비
 * - 📂 [ESM 컴포넌트 파사드] 공유 서재 탭 분리(adminSharedFoldersTab.js) 완료로 순수 뷰 셸 아키텍처 완성
 * - ⚡ [폴더 선택기 100% 매칭] openFolderPicker 직통 바인딩 및 openFolderModal 호환 별칭 탑재
 */

import { config } from '../config.js';
import { hasRefreshToken } from '../tokenStore.js';
import { readEnvFile } from './envManager.js';
import { storageService } from './storageService.js';
import { auditLogger } from './auditLogger.js';

// 🌟 분리된 전담 뷰 컴포넌트 import (순수 컴포넌트 파사드 구조)
import { renderAuthGateHtml, renderLoginPageHtml } from './views/adminAuthViews.js';
import { renderDashboardTab } from './views/adminDashboardTab.js';
import { renderUsersTab } from './views/adminUsersTab.js';
import { renderSharedFoldersTab } from './views/adminSharedFoldersTab.js';
import { renderSettingsTab } from './views/adminSettingsTab.js';
import { renderFolderModalAndScript } from './views/adminFolderModal.js';

export { renderAuthGateHtml, renderLoginPageHtml };

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