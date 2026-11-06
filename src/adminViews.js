/**
 * @file src/adminViews.js
 * @description 관리자 제어 센터 순수 HTML/CSS/JS 화면 템플릿 전담 뷰 렌더러 모듈 (View)
 * - 🎨 [MVC 패턴 완전 분리] adminController.js로부터 600줄에 달하는 거대 HTML 마크업을 독립 분리
 * - 📑 [상단 2단 탭 UI 탑재] '📊 관제 대시보드'와 '⚙️ 시스템 설정' 화면 템플릿 및 localStorage 상태 복원 스크립트 전담
 * - 💾 [실시간 현황 & 최근 로그 표출] auditLogger 연동 실시간 저장소 그리드 및 최근 30건 활동 로그 테이블 마크업
 * - 🛠️ [전 11대 환경변수 폼 렌더링] PORT, HOST, READER_URL, TOKEN_FILE 포함 1:1 완벽 배치
 */

import { config } from '../config.js';
import { hasRefreshToken } from '../tokenStore.js';
import { readEnvFile } from './envManager.js';
import { storageService } from './storageService.js';
import { auditLogger } from './auditLogger.js';

// 공식 깃허브 저장소 주소
const GITHUB_REPO_URL = 'https://github.com/ustaric/refresh-server';

/**
 * 🔑 관리자 로그인 화면 HTML 렌더러
 * @param {string|null} [errorMessage=null] 
 * @param {boolean} [isInitialSetup=false] 
 * @returns {string} HTML 문자열
 */
export function renderLoginPageHtml(errorMessage = null, isInitialSetup = false) {
  const title = isInitialSetup ? '🔒 관리자 비밀번호 최초 설정' : '🔑 관리자 로그인';
  const subtitle = isInitialSetup 
    ? '서버를 보호하기 위해 새 관리자 비밀번호를 먼저 등록하세요.' 
    : '서버 제어 센터에 접근하려면 관리자 비밀번호를 입력하세요.';

  let errorBanner = '';
  if (errorMessage) {
    errorBanner = `<div class="alert alert-error">❌ ${errorMessage}</div>`;
  }

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - EPUB Server</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --danger: #ef4444;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 16px;
      box-sizing: border-box;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 32px 24px;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);
      text-align: center;
    }
    .icon {
      font-size: 40px;
      margin-bottom: 12px;
    }
    h2 {
      margin: 0 0 8px 0;
      font-size: 20px;
    }
    p {
      color: var(--text-muted);
      font-size: 13px;
      margin: 0 0 20px 0;
      line-height: 1.5;
    }
    .alert {
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 16px;
      background: rgba(239, 68, 68, 0.15);
      color: var(--danger);
      border: 1px solid rgba(239, 68, 68, 0.3);
      text-align: left;
    }
    input[type="password"] {
      width: 100%;
      background: #0f172a;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      padding: 12px;
      font-size: 15px;
      box-sizing: border-box;
      outline: none;
      margin-bottom: 16px;
      transition: border-color 0.2s;
    }
    input[type="password"]:focus {
      border-color: var(--primary);
    }
    button {
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
    button:hover {
      background: var(--primary-hover);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${isInitialSetup ? '🔒' : '🔑'}</div>
    <h2>${title}</h2>
    <p>${subtitle}</p>
    ${errorBanner}
    <form method="POST" action="/admin/login">
      <input type="password" name="password" placeholder="비밀번호 입력" required autofocus autocomplete="current-password">
      <button type="submit">${isInitialSetup ? '비밀번호 등록 및 대시보드 진입' : '대시보드 잠금 해제'}</button>
    </form>
  </div>
</body>
</html>`;
}

/**
 * 🎨 웹 설정 대시보드 본문 HTML 렌더러 (상단 2단 탭 & 전 11대 환경변수 폼 탑재)
 * @param {import('http').IncomingMessage} req 
 * @param {string|null} [successMessage=null] 
 * @param {string|null} [errorMessage=null] 
 * @returns {string} HTML 문자열
 */
export function renderAdminSettingsHtml(req, successMessage = null, errorMessage = null) {
  const env = readEnvFile();
  const hasToken = hasRefreshToken();
  const isStorageMode = env.STORAGE_MODE === 'true';

  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || `${config.host}:${config.port}`;
  const currentServerUrl = `${protocol}://${host}`;

  // 전 11대 환경변수 값 매핑
  const port = env.PORT || String(config.port || '3001');
  const serverHost = env.HOST || config.host || '127.0.0.1';
  const tokenFile = env.TOKEN_FILE || './data/token.enc';
  const readerUrl = env.READER_URL || config.security.readerUrl || 'https://epubwebview.vercel.app';
  const clientId = env.GOOGLE_CLIENT_ID || '';
  const redirectUri = env.GOOGLE_REDIRECT_URI || `${currentServerUrl}/auth/google/callback`;
  const allowedOrigin = env.ALLOWED_ORIGIN || '*';
  const hasSecret = Boolean(env.GOOGLE_CLIENT_SECRET);
  const hasKey = Boolean(env.TOKEN_ENCRYPTION_KEY);

  // 📊 실시간 스토리지 현황 및 최근 30건 로그 수집
  const metrics = auditLogger.getStorageMetrics();
  const recentLogs = auditLogger.getRecentLogs();
  const crashReports = storageService.getCrashReportsList();

  let alertBanner = '';
  if (successMessage) {
    alertBanner = `<div class="alert alert-success">✔ ${successMessage}</div>`;
  } else if (errorMessage) {
    alertBanner = `<div class="alert alert-error">❌ ${errorMessage}</div>`;
  }

  // 1. 최근 동기화 및 접근 활동 로그 테이블 HTML 생성
  let activityLogsHtml = '';
  if (recentLogs.length === 0) {
    activityLogsHtml = `
      <div style="text-align: center; padding: 24px 12px; color: var(--text-muted); font-size: 13px;">
        <span style="font-size: 20px; display: block; margin-bottom: 4px;">📡</span>
        아직 기록된 서버 활동 로그가 없습니다. (대기 중)
      </div>
    `;
  } else {
    const logRows = recentLogs.map((l) => {
      let statusBadge = '<span class="status-pill status-200">200 OK</span>';
      if (l.status === 403) statusBadge = '<span class="status-pill status-403">403 차단</span>';
      else if (l.status === 429) statusBadge = '<span class="status-pill status-429">429 락</span>';
      else if (l.status === 404) statusBadge = '<span class="status-pill status-404">404 없음</span>';
      else if (l.status >= 500) statusBadge = `<span class="status-pill status-500">${l.status} 에러</span>`;

      return `
        <tr>
          <td style="font-family: monospace; font-size: 11.5px; color: var(--text-muted);">${l.timestamp}</td>
          <td style="font-family: monospace; font-size: 11.5px; color: #38bdf8;">${l.ip}</td>
          <td style="font-size: 12px; color: #e2e8f0;">${l.device}</td>
          <td style="font-size: 12px; font-weight: 600;">${l.action}</td>
          <td style="font-size: 11.5px; color: var(--text-muted); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${l.target}</td>
          <td style="text-align: right;">${statusBadge}</td>
        </tr>
      `;
    }).join('');

    activityLogsHtml = `
      <div style="overflow-x: auto; margin-top: 8px;">
        <table class="data-table">
          <thead>
            <tr>
              <th>시각</th>
              <th>IP</th>
              <th>기기 / 환경</th>
              <th>동작</th>
              <th>대상</th>
              <th style="text-align: right;">상태</th>
            </tr>
          </thead>
          <tbody>
            ${logRows}
          </tbody>
        </table>
      </div>
    `;
  }

  // 2. 크래시 리포트 테이블 HTML 생성
  let crashReportsHtml = '';
  if (crashReports.length === 0) {
    crashReportsHtml = `
      <div style="text-align: center; padding: 24px 12px; color: var(--text-muted); font-size: 13px;">
        <span style="font-size: 20px; display: block; margin-bottom: 4px;">✨</span>
        수집된 조판 결함 리포트가 없습니다. (정상 상태)
      </div>
    `;
  } else {
    const rows = crashReports.map(r => {
      const dateStr = new Date(r.createdAt).toLocaleString('ko-KR', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      const encodedName = encodeURIComponent(r.fileName);

      return `
        <tr>
          <td style="font-family: monospace; font-size: 11.5px; color: #38bdf8;">${r.fileName}</td>
          <td style="font-size: 12px; color: var(--text-muted);">${dateStr}</td>
          <td style="text-align: center;">
            <span style="background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid rgba(239,68,68,0.3); font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 4px;">
              ${r.totalAnomalies}건
            </span>
          </td>
          <td style="font-size: 11.5px; color: var(--text-muted); text-align: right;">${r.sizeKb}</td>
          <td style="text-align: right; white-space: nowrap;">
            <a href="/admin/crash-reports/download/${encodedName}" class="btn-action btn-download" style="margin-right: 4px;">📥 다운로드</a>
            <a href="/admin/crash-reports/delete/${encodedName}" class="btn-action btn-delete" onclick="return confirm('이 리포트를 삭제하시겠습니까?');">🗑️</a>
          </td>
        </tr>
      `;
    }).join('');

    crashReportsHtml = `
      <div style="overflow-x: auto; margin-top: 8px;">
        <table class="data-table">
          <thead>
            <tr>
              <th>파일명</th>
              <th>발생 시각</th>
              <th style="text-align: center;">결함 수</th>
              <th style="text-align: right;">크기</th>
              <th style="text-align: right;">작업</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
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
      max-width: 680px;
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
      font-size: 14px;
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
      padding: 8px;
      font-size: 11.5px;
      color: var(--text-muted);
      text-transform: uppercase;
      font-weight: 600;
    }
    .data-table td {
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      padding: 10px 8px;
    }
    .status-pill {
      display: inline-block;
      font-size: 10.5px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .status-200 { background: rgba(16, 185, 129, 0.15); color: var(--success); border: 1px solid rgba(16, 185, 129, 0.3); }
    .status-403 { background: rgba(239, 68, 68, 0.15); color: var(--danger); border: 1px solid rgba(239, 68, 68, 0.3); }
    .status-429 { background: rgba(245, 158, 11, 0.15); color: var(--warning); border: 1px solid rgba(245, 158, 11, 0.3); }
    .status-404 { background: rgba(148, 163, 184, 0.15); color: var(--text-muted); border: 1px solid rgba(148, 163, 184, 0.3); }
    .status-500 { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); }

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
    .btn-copy.copied {
      background: var(--success);
      color: white;
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
    input[type="text"], input[type="password"] {
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
    input[type="text"]:focus, input[type="password"]:focus {
      border-color: var(--primary);
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
    .btn-download {
      background: #0284c7;
      color: #ffffff;
    }
    .btn-download:hover { background: #0369a1; }
    .btn-delete {
      background: rgba(239,68,68,0.2);
      color: #f87171;
      border: 1px solid rgba(239,68,68,0.3);
    }
    .btn-delete:hover { background: #ef4444; color: white; }
    .btn-clear-all {
      background: rgba(239,68,68,0.15);
      color: #f87171;
      border: 1px solid rgba(239,68,68,0.3);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 11.5px;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.2s;
    }
    .btn-clear-all:hover { background: #ef4444; color: white; }

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
    .oauth-btn {
      display: inline-block;
      background: #475569;
      color: #fff;
      padding: 8px 14px;
      border-radius: 6px;
      text-decoration: none;
      font-size: 13px;
      font-weight: 500;
      margin-top: 10px;
    }
    .oauth-btn:hover { background: #64748b; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1>⚙️ EPUB Server 제어 센터</h1>
        <p>Google OAuth 프록시 및 로컬 동기화 스토리지 통합 관제</p>
      </div>
      <a href="/admin/logout" class="btn-logout">🔒 로그아웃</a>
    </div>

    ${alertBanner}

    <!-- 🌟 상단 2단 네비게이션 탭 바 -->
    <div class="tab-nav">
      <button type="button" class="tab-btn active" id="tab-btn-dashboard" onclick="switchAdminTab('dashboard')">
        <span>📊</span> 관제 대시보드
      </button>
      <button type="button" class="tab-btn" id="tab-btn-settings" onclick="switchAdminTab('settings')">
        <span>⚙️</span> 시스템 설정
      </button>
    </div>

    <!-- ================================================================= -->
    <!-- 📊 [탭 1] 관제 대시보드 (현황 카드 + 실시간 활동 로그 + 크래시 리포트) -->
    <!-- ================================================================= -->
    <div id="tab-content-dashboard" class="tab-content active">
      <!-- 1. 실시간 디스크 & 도서 현황 카드 -->
      <div class="card">
        <div class="section-title">
          <span>💾 실시간 저장소 및 도서 현황</span>
          <span class="badge badge-info">60초 자동 갱신</span>
        </div>
        <div class="stat-grid">
          <div class="stat-card">
            <div class="stat-label">활성 도서 (books)</div>
            <div class="stat-value">${metrics.activeBooksCount} <span style="font-size: 12px; font-weight: normal; color: var(--text-muted);">권</span></div>
          </div>
          <div class="stat-card">
            <div class="stat-label">보관 도서 (archive)</div>
            <div class="stat-value" style="color: #a78bfa;">${metrics.archivedBooksCount} <span style="font-size: 12px; font-weight: normal; color: var(--text-muted);">권</span></div>
          </div>
          <div class="stat-card">
            <div class="stat-label">데이터 총 용량</div>
            <div class="stat-value" style="color: #34d399;">${metrics.totalDataSizeMb}</div>
          </div>
        </div>
        <p style="font-size: 12px; color: var(--text-muted); margin: 0; text-align: right;">
          최근 산출 시각: ${metrics.lastCalculatedAt}
        </p>
      </div>

      <!-- 2. 최근 20건 실시간 기기/IP 활동 로그 위젯 -->
      <div class="card">
        <div class="section-title">
          <span>📋 최근 동기화 및 접근 활동 로그 (최근 30건 FIFO)</span>
          <span class="badge badge-success">실시간 관제 중</span>
        </div>
        <p style="font-size: 12.5px; color: var(--text-muted); margin: 0 0 10px 0;">
          웹 뷰어의 도서 동기화, 다운로드 및 비인가 접근 차단 이력이 서버 RAM 링 버퍼에 기록됩니다.
        </p>
        ${activityLogsHtml}
      </div>

      <!-- 3. 조판 결함 및 크래시 리포트 다운로드 센터 -->
      <div class="card">
        <div class="section-title">
          <span>🔬 조판 결함 및 크래시 리포트 (${crashReports.length}건)</span>
          ${crashReports.length > 0 ? `<a href="/admin/crash-reports/clear" class="btn-clear-all" onclick="return confirm('수집된 모든 크래시 리포트를 일괄 삭제하시겠습니까?');">🧹 전체 비우기</a>` : ''}
        </div>
        <p style="font-size: 12.5px; color: var(--text-muted); margin: 0 0 10px 0;">
          웹 뷰어에서 자동 전송된 줄 잘림, 텍스트 중복, 챕터 마지막 유령 빈 페이지 결함 진단 JSON 목록입니다.
        </p>
        ${crashReportsHtml}
      </div>
    </div>

    <!-- ================================================================= -->
    <!-- ⚙️ [탭 2] 시스템 설정 (접속 정보 + 구글 연동 + 스토리지 토글 + 전 11대 .env 폼) -->
    <!-- ================================================================= -->
    <div id="tab-content-settings" class="tab-content">
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

        <!-- 4. 상세 환경변수 설정 (전 11대 항목 1:1 완비) -->
        <div class="card">
          <div class="section-title">
            <span>🛠️ 시스템 상세 설정 (.env 전 11대 항목)</span>
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
    </div>

    <a href="${readerUrl}" class="btn-return">📖 EPUB 웹 서재로 돌아가기</a>
  </div>

  <script>
    function switchAdminTab(tabName) {
      const isDashboard = tabName === 'dashboard';
      
      document.getElementById('tab-btn-dashboard').classList.toggle('active', isDashboard);
      document.getElementById('tab-btn-settings').classList.toggle('active', !isDashboard);
      
      document.getElementById('tab-content-dashboard').classList.toggle('active', isDashboard);
      document.getElementById('tab-content-settings').classList.toggle('active', !isDashboard);

      try {
        localStorage.setItem('admin_active_tab', tabName);
      } catch (e) {}
    }

    (function initTabState() {
      try {
        const savedTab = localStorage.getItem('admin_active_tab');
        if (savedTab === 'settings') {
          switchAdminTab('settings');
        }
      } catch (e) {}
    })();

    function copyToClipboard(text, btnElement) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          showCopiedEffect(btnElement);
        });
      } else {
        const tempInput = document.createElement('input');
        tempInput.value = text;
        document.body.appendChild(tempInput);
        tempInput.select();
        document.execCommand('copy');
        document.body.removeChild(tempInput);
        showCopiedEffect(btnElement);
      }
    }

    function showCopiedEffect(btn) {
      const originalText = btn.textContent;
      btn.textContent = '✔ 복사됨!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = originalText;
        btn.classList.remove('copied');
      }, 1800);
    }
  </script>
</body>
</html>`;
}