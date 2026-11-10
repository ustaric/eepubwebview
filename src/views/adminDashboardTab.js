/**
 * @file src/views/adminDashboardTab.js
 * @description 관리자 제어 센터 [탭 1: 📊 관제 대시보드] HTML 렌더러 모듈
 * - 🖥️ [상단 실시간 가로 1줄 게이지 바] CPU(1분 평균), RAM, DISK 점유율 가로 1줄 콤팩트 실시간 표출 (80% 이상 경고 점멸)
 * - 🔔 [최하단 Discord 웹훅 설정 카드] 웹훅 URL 직접 저장 및 원클릭 테스트 발송(Test Alert) UI 완비
 * - 👥 [사용자 칼럼 표출] 활동 로그 테이블에 사용자 메모/서재 칼럼 완벽 표출
 * - ↔️ [가로/세로 2D 스크롤 박스] max-height: 400px (10행 기준) + overflow: auto 로 오른쪽 끝 잘림 방지
 * - 📌 [스티키 헤더 탑재] 스크롤을 내려도 thead th가 상단에 고정되어 가독성 극대화
 * - 💾 [디스크 및 도서 메트릭] 활성/보관 도서 권수 및 실측 디스크 용량 현황 카드
 * - 📁 [일자별 감사 로그 다운로드 센터] 일자별 영구 저장 파일 목록 및 스크롤 박스
 * - 🔬 [크래시 리포트 센터] 뷰어 조판 결함 진단 리포트 스크롤 테이블
 */

import { auditLogger } from '../auditLogger.js';
import { systemMonitor } from '../systemMonitor.js';

/**
 * HTML 특수문자 이스케이프 헬퍼
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
 * 📊 [탭 1] 관제 대시보드 HTML 템플릿 렌더러
 * @param {Object} metrics 
 * @param {Array} recentLogs 
 * @param {Array} crashReports 
 * @param {Object} env 
 * @returns {string}
 */
export function renderDashboardTab(metrics = {}, recentLogs = [], crashReports = [], env = {}) {
  const allowedOrigin = env.ALLOWED_ORIGIN || '*';
  const isOriginStrict = allowedOrigin !== '*';
  const currentWebhookUrl = env.DISCORD_WEBHOOK_URL || '';

  const initialStats = systemMonitor.getSystemStats();

  const count403 = recentLogs.filter(l => l.status === 403 || l.status === 405).length;
  const count429 = recentLogs.filter(l => l.status === 429).length;
  const count500 = recentLogs.filter(l => l.status >= 500).length;
  const totalThreats = count403 + count429;

  let securityBadgeHtml = '<span class="badge badge-success">✔ 실시간 보호 중 (위협 0건)</span>';
  if (totalThreats > 0) {
    securityBadgeHtml = `<span class="badge badge-error" style="background:rgba(239,68,68,0.25);color:#f87171;border:1px solid #ef4444;font-weight:700;">🚨 최근 차단 ${totalThreats}건 감지</span>`;
  } else if (count500 > 0) {
    securityBadgeHtml = `<span class="badge badge-warning">⚠️ 서버 오류 ${count500}건 발생</span>`;
  }

  // 1. 최근 30건 활동 로그 테이블 (사용자 열 추가 및 오른쪽 끝 잘림 방지 스타일)
  let activityLogsHtml = '';
  if (!recentLogs || recentLogs.length === 0) {
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
      else if (l.status === 405) statusBadge = '<span class="status-pill status-403">405 불가</span>';
      else if (l.status === 429) statusBadge = '<span class="status-pill status-429">429 락</span>';
      else if (l.status === 404) statusBadge = '<span class="status-pill status-404">404 없음</span>';
      else if (l.status >= 500) statusBadge = `<span class="status-pill status-500">${l.status} 에러</span>`;

      const safeUser = escapeHtml(l.user || '-');
      const userBadge = safeUser.includes('Root') || safeUser === '-'
        ? `<span style="color:var(--text-muted); font-size:11.5px;">${safeUser}</span>`
        : `<span style="color:#38bdf8; font-weight:600; font-size:12px;">👤 ${safeUser}</span>`;

      return `
        <tr>
          <td style="font-family: monospace; font-size: 11.5px; color: var(--text-muted); white-space: nowrap;">${l.timestamp}</td>
          <td style="font-family: monospace; font-size: 11.5px; color: #a78bfa; white-space: nowrap;">${l.ip}</td>
          <td style="white-space: nowrap;">${userBadge}</td>
          <td style="font-size: 11.5px; color: #e2e8f0; white-space: nowrap;">${l.device}</td>
          <td style="font-size: 12px; font-weight: 600; white-space: nowrap;">${l.action}</td>
          <td style="font-size: 11.5px; color: var(--text-muted); max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(l.target)}">${escapeHtml(l.target)}</td>
          <td style="text-align: right; white-space: nowrap;">${statusBadge}</td>
        </tr>
      `;
    }).join('');

    activityLogsHtml = `
      <div style="max-height: 400px; overflow: auto; margin-top: 8px; border: 1px solid var(--border); border-radius: 8px; background: #0f172a;">
        <table class="data-table" style="min-width: 720px; border-collapse: separate; border-spacing: 0;">
          <thead style="position: sticky; top: 0; background: #1e293b; z-index: 2;">
            <tr>
              <th style="background: #1e293b;">시각</th>
              <th style="background: #1e293b;">IP</th>
              <th style="background: #1e293b;">사용자 (서재)</th>
              <th style="background: #1e293b;">기기 / 환경</th>
              <th style="background: #1e293b;">동작</th>
              <th style="background: #1e293b;">대상</th>
              <th style="background: #1e293b; text-align: right;">상태</th>
            </tr>
          </thead>
          <tbody>
            ${logRows}
          </tbody>
        </table>
      </div>
    `;
  }

  // 2. 일자별 감사 로그 아카이브 목록 (스크롤 컨테이너 적용)
  const logFiles = auditLogger.getLogFilesList();
  let logFilesHtml = '';
  if (!logFiles || logFiles.length === 0) {
    logFilesHtml = `
      <div style="text-align: center; padding: 24px 12px; color: var(--text-muted); font-size: 13px;">
        <span style="font-size: 20px; display: block; margin-bottom: 4px;">📂</span>
        누적된 일자별 로그 파일이 없습니다. (접속 시 자동 생성)
      </div>
    `;
  } else {
    const fileRows = logFiles.map(f => {
      const encodedRelPath = encodeURIComponent(f.relativePath);
      return `
        <tr>
          <td style="font-family: monospace; font-size: 12.5px; font-weight: 600; color: #38bdf8; white-space: nowrap;">
            📅 ${f.date}
          </td>
          <td style="font-family: monospace; font-size: 11.5px; color: var(--text-muted); white-space: nowrap;">
            ${f.relativePath}
          </td>
          <td style="text-align: center; white-space: nowrap;">
            <span style="background: rgba(59,130,246,0.15); color: #60a5fa; border: 1px solid rgba(59,130,246,0.3); font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 4px;">
              ${f.linesCount}건 기록
            </span>
          </td>
          <td style="font-size: 11.5px; color: var(--text-muted); text-align: right; white-space: nowrap;">${f.sizeKb}</td>
          <td style="text-align: right; white-space: nowrap;">
            <a href="/admin/logs/download?file=${encodedRelPath}" class="btn-action btn-download" style="margin-right: 4px;">📥 다운로드</a>
            <a href="/admin/logs/delete?file=${encodedRelPath}" class="btn-action btn-delete" onclick="return confirm('${f.date} 일자의 로그 파일을 완전히 삭제하시겠습니까?');">🗑️</a>
          </td>
        </tr>
      `;
    }).join('');

    logFilesHtml = `
      <div style="max-height: 380px; overflow: auto; margin-top: 8px; border: 1px solid var(--border); border-radius: 8px; background: #0f172a;">
        <table class="data-table" style="min-width: 600px; border-collapse: separate; border-spacing: 0;">
          <thead style="position: sticky; top: 0; background: #1e293b; z-index: 2;">
            <tr>
              <th style="background: #1e293b;">기록 일자</th>
              <th style="background: #1e293b;">저장 경로</th>
              <th style="background: #1e293b; text-align: center;">활동/접근 수</th>
              <th style="background: #1e293b; text-align: right;">용량</th>
              <th style="background: #1e293b; text-align: right;">작업</th>
            </tr>
          </thead>
          <tbody>
            ${fileRows}
          </tbody>
        </table>
      </div>
    `;
  }

  // 3. 크래시 리포트 테이블 (10개 스크롤 컨테이너 적용)
  let crashReportsHtml = '';
  if (!crashReports || crashReports.length === 0) {
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
          <td style="font-family: monospace; font-size: 11.5px; color: #38bdf8; white-space: nowrap;">${r.fileName}</td>
          <td style="font-size: 12px; color: var(--text-muted); white-space: nowrap;">${dateStr}</td>
          <td style="text-align: center; white-space: nowrap;">
            <span style="background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid rgba(239,68,68,0.3); font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 4px;">
              ${r.totalAnomalies}건
            </span>
          </td>
          <td style="font-size: 11.5px; color: var(--text-muted); text-align: right; white-space: nowrap;">${r.sizeKb}</td>
          <td style="text-align: right; white-space: nowrap;">
            <a href="/admin/crash-reports/download/${encodedName}" class="btn-action btn-download" style="margin-right: 4px;">📥 다운로드</a>
            <a href="/admin/crash-reports/delete/${encodedName}" class="btn-action btn-delete" onclick="return confirm('이 리포트를 삭제하시겠습니까?');">🗑️</a>
          </td>
        </tr>
      `;
    }).join('');

    crashReportsHtml = `
      <div style="max-height: 380px; overflow: auto; margin-top: 8px; border: 1px solid var(--border); border-radius: 8px; background: #0f172a;">
        <table class="data-table" style="min-width: 580px; border-collapse: separate; border-spacing: 0;">
          <thead style="position: sticky; top: 0; background: #1e293b; z-index: 2;">
            <tr>
              <th style="background: #1e293b;">파일명</th>
              <th style="background: #1e293b;">발생 시각</th>
              <th style="background: #1e293b; text-align: center;">결함 수</th>
              <th style="background: #1e293b; text-align: right;">크기</th>
              <th style="background: #1e293b; text-align: right;">작업</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    `;
  }

  return `
    <!-- 🌟 [신규] 상단 가로 1줄 실시간 시스템 자원 게이지 바 (설명 텍스트 대체) -->
    <div class="card" style="padding: 14px 18px; margin-bottom: 16px; background: #0f172a; border: 1px solid var(--border);">
      <div class="system-gauge-container">
        <!-- CPU 게이지 -->
        <div class="gauge-item">
          <div class="gauge-label-row">
            <span class="gauge-title">🖥️ CPU (1분 평균)</span>
            <span id="gauge-cpu-val" class="gauge-val ${initialStats.cpu >= 80 ? 'gauge-alert' : ''}">${initialStats.cpu}%</span>
          </div>
          <div class="gauge-track">
            <div id="gauge-cpu-bar" class="gauge-bar ${initialStats.cpu >= 80 ? 'bar-alert' : 'bar-normal'}" style="width: ${initialStats.cpu}%;"></div>
          </div>
        </div>

        <div class="gauge-divider"></div>

        <!-- RAM 게이지 -->
        <div class="gauge-item">
          <div class="gauge-label-row">
            <span class="gauge-title">🧠 RAM 사용량</span>
            <span id="gauge-ram-val" class="gauge-val ${initialStats.ram >= 80 ? 'gauge-alert' : ''}">${initialStats.ram}%</span>
          </div>
          <div class="gauge-track">
            <div id="gauge-ram-bar" class="gauge-bar ${initialStats.ram >= 80 ? 'bar-alert' : 'bar-normal'}" style="width: ${initialStats.ram}%;"></div>
          </div>
        </div>

        <div class="gauge-divider"></div>

        <!-- DISK 게이지 -->
        <div class="gauge-item">
          <div class="gauge-label-row">
            <span class="gauge-title">💾 DISK 스토리지</span>
            <span id="gauge-disk-val" class="gauge-val ${initialStats.disk >= 80 ? 'gauge-alert' : ''}">${initialStats.disk}%</span>
          </div>
          <div class="gauge-track">
            <div id="gauge-disk-bar" class="gauge-bar ${initialStats.disk >= 80 ? 'bar-alert' : 'bar-normal'}" style="width: ${initialStats.disk}%;"></div>
          </div>
        </div>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; font-size:11px; color:var(--text-muted);">
        <span>⚡ 10초 주기 실시간 관제 중 (자원 80% 초과 시 Discord 자동 통지)</span>
        <span id="gauge-sync-time">산출: ${initialStats.lastCheckedAt}</span>
      </div>
    </div>

    <!-- 1. 실시간 디스크 & 도서 현황 카드 -->
    <div class="card">
      <div class="section-title">
        <span>💾 실시간 저장소 및 도서 현황</span>
        <span class="badge badge-info">60초 자동 갱신</span>
      </div>
      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-label">활성 도서 (books)</div>
          <div class="stat-value">${metrics.activeBooksCount || 0} <span style="font-size: 12px; font-weight: normal; color: var(--text-muted);">권</span></div>
        </div>
        <div class="stat-card">
          <div class="stat-label">보관 도서 (archive)</div>
          <div class="stat-value" style="color: #a78bfa;">${metrics.archivedBooksCount || 0} <span style="font-size: 12px; font-weight: normal; color: var(--text-muted);">권</span></div>
        </div>
        <div class="stat-card">
          <div class="stat-label">데이터 총 용량</div>
          <div class="stat-value" style="color: #34d399;">${metrics.totalDataSizeMb || '0.0 MB'}</div>
        </div>
      </div>
      <p style="font-size: 12px; color: var(--text-muted); margin: 0; text-align: right;">
        최근 산출 시각: ${metrics.lastCalculatedAt || '-'}
      </p>
    </div>

    <!-- 2. 서버 보안 거버넌스 및 방어선 상태 카드 -->
    <div class="card">
      <div class="section-title">
        <span>🛡️ 서버 보안 거버넌스 및 방어선 상태</span>
        ${securityBadgeHtml}
      </div>
      <div class="stat-grid" style="grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 12px;">
        <div class="stat-card" style="text-align: left; padding: 10px 14px;">
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <span style="font-size: 12.5px; font-weight: 600;">심볼릭 링크 & 경로 격리</span>
            <span class="badge ${count403 > 0 ? 'badge-error' : 'badge-success'}" style="font-size: 10.5px;">
              ${count403 > 0 ? `${count403}건 차단됨` : 'realpath 실측'}
            </span>
          </div>
          <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 4px;">시스템 루트(/etc) 탈출 차단</div>
        </div>

        <div class="stat-card" style="text-align: left; padding: 10px 14px;">
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <span style="font-size: 12.5px; font-weight: 600;">도서 확장자 보호</span>
            <span class="badge badge-success" style="font-size: 10.5px;">화이트리스트</span>
          </div>
          <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 4px;">.epub, .txt, .webp, .json 만 허용</div>
        </div>

        <div class="stat-card" style="text-align: left; padding: 10px 14px;">
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <span style="font-size: 12.5px; font-weight: 600;">요청 폭주 제한 (Rate Limit)</span>
            <span class="badge ${count429 > 0 ? 'badge-warning' : 'badge-info'}" style="font-size: 10.5px;">
              ${count429 > 0 ? `${count429}건 초과 락` : '120회 / 분'}
            </span>
          </div>
          <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 4px;">IP 기반 비정상 트래픽 방어</div>
        </div>

        <div class="stat-card" style="text-align: left; padding: 10px 14px;">
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <span style="font-size: 12.5px; font-weight: 600;">로그 민감정보 마스킹</span>
            <span class="badge badge-success" style="font-size: 10.5px;">실시간 소독</span>
          </div>
          <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 4px;">토큰/비밀번호 디스크 노출 차단</div>
        </div>
      </div>

      <div style="display: flex; align-items: center; justify-content: space-between; background: #0f172a; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border); font-size: 12px;">
        <span style="color: var(--text-muted);">웹 뷰어 출처(CORS) 방어 상태:</span>
        <span class="badge ${isOriginStrict ? 'badge-success' : 'badge-warning'}">
          ${isOriginStrict ? '지정 도메인 한정 허용' : '전체 허용 (*) - 주의'}
        </span>
      </div>
    </div>

    <!-- 3. 일자별 보안 감사 로그 다운로드 센터 (스크롤 박스 적용) -->
    <div class="card">
      <div class="section-title">
        <span>📁 일자별 보안 감사 로그 다운로드 센터 (${logFiles.length}일분 보관 중)</span>
      </div>
      <p style="font-size: 12.5px; color: var(--text-muted); margin: 0 0 10px 0;">
        서버에 실제 접근 시도(동기화, 다운로드, 침투 차단)가 발생할 때마다 <strong>./data/logs/YYYY/MM/DD/</strong> 에 실시간 누적된 일자별 영구 보관 파일입니다.
      </p>
      ${logFilesHtml}
    </div>

    <!-- 4. 최근 30건 실시간 기기/IP 활동 로그 위젯 (사용자 열 추가 및 10행 세로/가로 스크롤 적용) -->
    <div class="card">
      <div class="section-title">
        <span>📋 최근 실시간 활동 로그 (최근 30건 FIFO 링 버퍼)</span>
        <span class="badge badge-success">실시간 관제 중</span>
      </div>
      <p style="font-size: 12.5px; color: var(--text-muted); margin: 0 0 10px 0;">
        사용자별 도서 동기화, 다운로드 및 접근 이력이 표출됩니다. (10행 이상 시 세로 및 좌우 스크롤 지원)
      </p>
      ${activityLogsHtml}
    </div>

    <!-- 5. 조판 결함 및 크래시 리포트 다운로드 센터 (10행 스크롤 적용) -->
    <div class="card">
      <div class="section-title">
        <span>🔬 조판 결함 및 크래시 리포트 (${crashReports ? crashReports.length : 0}건)</span>
        ${crashReports && crashReports.length > 0 ? `<a href="/admin/crash-reports/clear" class="btn-clear-all" onclick="return confirm('수집된 모든 크래시 리포트를 일괄 삭제하시겠습니까?');">🧹 전체 비우기</a>` : ''}
      </div>
      <p style="font-size: 12.5px; color: var(--text-muted); margin: 0 0 10px 0;">
        웹 뷰어에서 자동 전송된 줄 잘림, 텍스트 중복, 챕터 마지막 유령 빈 페이지 결함 진단 JSON 목록입니다.
      </p>
      ${crashReportsHtml}
    </div>

    <!-- 🌟 [신규 6] 최하단 Discord 웹훅 실시간 관제 및 알림 설정 카드 -->
    <div class="card" style="border: 1px solid #3b82f6;">
      <div class="section-title">
        <span>🔔 Discord 웹훅 실시간 장애 & 자원 관제</span>
        <span class="badge badge-info">${currentWebhookUrl ? '연결됨 ✅' : '미등록 (알림 꺼짐)'}</span>
      </div>
      <p style="font-size: 12.5px; color: var(--text-muted); margin: 0 0 12px 0;">
        CPU, RAM, DISK 점유율이 <strong>80%를 초과</strong>하면 30분 주기로 디스코드에 경보 카드를 전송하며, <strong>서버 500 장애</strong> 발생 시 에러 요약이 즉시 발송됩니다.
      </p>

      <div style="display: flex; gap: 8px; flex-wrap: wrap;">
        <input 
          type="text" 
          id="discord-webhook-input" 
          placeholder="https://discord.com/api/webhooks/..." 
          value="${escapeHtml(currentWebhookUrl)}"
          style="flex: 1; min-width: 280px; padding: 10px 14px; background: #0f172a; border: 1px solid var(--border); border-radius: 6px; color: #f8fafc; font-size: 13px; font-family: monospace;"
        />
        <button type="button" id="btn-save-webhook" class="btn btn-primary" style="padding: 10px 18px; font-size: 13px;">💾 저장</button>
        <button type="button" id="btn-test-webhook" class="btn" style="padding: 10px 18px; font-size: 13px; background: #475569; color: white;">🔔 테스트 전송</button>
      </div>
      <div id="discord-webhook-feedback" style="margin-top: 8px; font-size: 12px; display: none;"></div>
    </div>

    <!-- 🎨 [스타일 & 스크립트] 가로 게이지 바 및 실시간 10초 갱신 클라이언트 루프 -->
    <style>
      .system-gauge-container {
        display: flex;
        align-items: center;
        gap: 16px;
        flex-wrap: wrap;
      }
      .gauge-item {
        flex: 1;
        min-width: 180px;
      }
      .gauge-label-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
      }
      .gauge-title {
        font-size: 12px;
        font-weight: 600;
        color: #e2e8f0;
      }
      .gauge-val {
        font-size: 12.5px;
        font-weight: 700;
        font-family: monospace;
        color: #38bdf8;
      }
      .gauge-track {
        width: 100%;
        height: 8px;
        background: #1e293b;
        border-radius: 9999px;
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.05);
      }
      .gauge-bar {
        height: 100%;
        transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.3s;
        border-radius: 9999px;
      }
      .bar-normal {
        background: linear-gradient(90deg, #10b981, #38bdf8);
      }
      .bar-alert {
        background: #ef4444 !important;
        animation: pulseAlert 1.5s infinite;
      }
      .gauge-alert {
        color: #f87171 !important;
        animation: pulseText 1.5s infinite;
      }
      .gauge-divider {
        width: 1px;
        height: 28px;
        background: var(--border);
      }
      @keyframes pulseAlert {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.45; }
      }
      @keyframes pulseText {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.6; }
      }
      @media (max-width: 768px) {
        .gauge-divider { display: none; }
        .gauge-item { min-width: 100%; }
      }
    </style>

    <script>
      (function() {
        // 1. 실시간 10초 자원 갱신 루프
        async function fetchSystemStats() {
          try {
            const res = await fetch('/api/admin/system-stats');
            if (!res.ok) return;
            const data = await res.json();
            if (!data.ok || !data.stats) return;

            const { cpu, ram, disk, lastCheckedAt } = data.stats;

            function updateBar(barId, valId, percent) {
              const bar = document.getElementById(barId);
              const val = document.getElementById(valId);
              if (!bar || !val) return;

              bar.style.width = percent + '%';
              val.textContent = percent + '%';

              if (percent >= 80) {
                bar.className = 'gauge-bar bar-alert';
                val.className = 'gauge-val gauge-alert';
              } else {
                bar.className = 'gauge-bar bar-normal';
                val.className = 'gauge-val';
              }
            }

            updateBar('gauge-cpu-bar', 'gauge-cpu-val', cpu);
            updateBar('gauge-ram-bar', 'gauge-ram-val', ram);
            updateBar('gauge-disk-bar', 'gauge-disk-val', disk);

            const timeEl = document.getElementById('gauge-sync-time');
            if (timeEl) timeEl.textContent = '산출: ' + lastCheckedAt;
          } catch (e) {}
        }

        setInterval(fetchSystemStats, 10000);

        // 2. 디스코드 웹훅 저장 & 테스트 발송 이벤트 바인딩
        const saveBtn = document.getElementById('btn-save-webhook');
        const testBtn = document.getElementById('btn-test-webhook');
        const inputEl = document.getElementById('discord-webhook-input');
        const feedbackEl = document.getElementById('discord-webhook-feedback');

        function showFeedback(msg, isSuccess) {
          if (!feedbackEl) return;
          feedbackEl.style.display = 'block';
          feedbackEl.style.color = isSuccess ? '#34d399' : '#f87171';
          feedbackEl.textContent = msg;
          setTimeout(() => { feedbackEl.style.display = 'none'; }, 5000);
        }

        if (saveBtn) {
          saveBtn.onclick = async function() {
            const webhookUrl = inputEl ? inputEl.value.trim() : '';
            saveBtn.disabled = true;
            saveBtn.textContent = '저장 중...';

            try {
              const res = await fetch('/api/admin/discord-webhook', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'save', webhookUrl })
              });
              const data = await res.json();
              if (res.ok) {
                showFeedback('✅ ' + (data.message || '저장되었습니다.'), true);
              } else {
                showFeedback('❌ ' + (data.error || '저장 실패'), false);
              }
            } catch (err) {
              showFeedback('❌ 통신 오류: ' + err.message, false);
            } finally {
              saveBtn.disabled = false;
              saveBtn.textContent = '💾 저장';
            }
          };
        }

        if (testBtn) {
          testBtn.onclick = async function() {
            const webhookUrl = inputEl ? inputEl.value.trim() : '';
            if (!webhookUrl) {
              alert('먼저 Discord 웹훅 URL을 입력해 주세요.');
              return;
            }
            testBtn.disabled = true;
            testBtn.textContent = '전송 중...';

            try {
              const res = await fetch('/api/admin/discord-webhook', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'test', webhookUrl })
              });
              const data = await res.json();
              if (res.ok) {
                showFeedback('🎉 ' + data.message, true);
              } else {
                showFeedback('⚠️ ' + data.message, false);
              }
            } catch (err) {
              showFeedback('❌ 통신 오류: ' + err.message, false);
            } finally {
              testBtn.disabled = false;
              testBtn.textContent = '🔔 테스트 전송';
            }
          };
        }
      })();
    </script>
  `;
}