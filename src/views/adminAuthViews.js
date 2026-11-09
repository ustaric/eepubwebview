/**
 * @file src/views/adminAuthViews.js
 * @description 관리자 인증 화면(로그인 및 Google 연동 비밀번호 확인 게이트) 순수 HTML 템플릿 렌더러
 * - 🔒 [Google 로그인 관문] renderAuthGateHtml: 타인의 Google 계정 덮어쓰기를 방지하는 비밀번호 확인 화면
 * - 🔑 [관리자 로그인] renderLoginPageHtml: 최초 설정 및 일상 로그인을 지원하는 비밀번호 관문 화면
 */

/**
 * 🔒 구글 계정 연동 전 관리자 본인 확인 게이트 HTML 렌더러
 * @param {string|null} [errorMessage=null] 
 * @returns {string} 완성된 HTML 문자열
 */
export function renderAuthGateHtml(errorMessage = null) {
  let errorBanner = '';
  if (errorMessage) {
    errorBanner = `<div class="alert alert-error">❌ ${errorMessage}</div>`;
  }

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🔒 Google 연동 본인 확인 - EPUB Server</title>
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
      font-size: 19px;
      color: #38bdf8;
    }
    p {
      color: var(--text-muted);
      font-size: 13px;
      margin: 0 0 18px 0;
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
    .btn-cancel {
      display: inline-block;
      margin-top: 14px;
      color: var(--text-muted);
      font-size: 12.5px;
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🔗</div>
    <h2>Google 계정 연동 본인 확인</h2>
    <p>서버에 저장된 클라우드 토큰을 보호하기 위해<br><strong>관리자 비밀번호</strong>를 입력해 주세요.</p>
    ${errorBanner}
    <form method="POST" action="/auth/google">
      <input type="password" name="password" placeholder="관리자 비밀번호 입력" required autofocus autocomplete="current-password">
      <button type="submit">확인 및 Google 로그인 진행 ➔</button>
      <a href="/admin" class="btn-cancel">취소하고 관리자 홈으로</a>
    </form>
  </div>
</body>
</html>`;
}

/**
 * 🔑 관리자 로그인 화면 HTML 렌더러
 * @param {string|null} [errorMessage=null] 
 * @param {boolean} [isInitialSetup=false] 
 * @returns {string} 완성된 HTML 문자열
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