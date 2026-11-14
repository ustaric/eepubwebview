/**
 * @file src/views/adminDashboardTab.js
 * @description 관리자 제어 센터 [탭 1: 📊 관제 대시보드] HTML 렌더러 모듈
 * - 🇰🇷 [한국 표준시(KST) 통일] 크래시 리포트 발생 시각을 Asia/Seoul 기준으로 정확히 변환 표출
 * - 👁️ [JSON 바로 보기 모달] 감사 로그·크래시 리포트 파일명 클릭 또는 👁️ 아이콘 클릭 시 즉시 프리뷰/복사 모달 오픈
 * - 🖥️ [상단 실시간 가로 1줄 게이지 바] CPU(1분 평균), RAM, DISK 점유율 가로 1줄 콤팩트 실시간 표출 (80% 이상 경고 점멸)
 * - 👥 [사용자 칼럼 표출] 활동 로그 테이블에 사용자 메모/서재 칼럼 완벽 표출
 * - ↔️ [가로/세로 2D 스크롤 박스] max-height: 400px (10행 기준) + overflow: auto 로 오른쪽 끝 잘림 방지
 * - 📌 [스티키 헤더 탑재] 스크롤을 내려도 thead th가 상단에 고정되어 가독성 극대화
 * - 💾 [디스크 및 도서 메트릭] 활성/보관 도서 권수 및 실측 디스크 용량 현황 카드
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

  // 1. 최근 30건 활동 로그 테이블
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
      if (l.status === 401) statusBadge = '<span class="status-pill status-403">401 미인증</span>';
      else if (l.status === 403) statusBadge = '<span class="status-pill status-403">403 차단</span>';
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
          <td style="font-family: monospace; font-size: 11.5px; color: var(--text-muted); white-space: nowrap;">${escapeHtml(l.timestamp)}</td>
          <td style="font-family: monospace; font-size: 11.5px; color: #a78bfa; white-space: nowrap;">${escapeHtml(l.ip)}</td>
          <td style="white-space: nowrap;">${userBadge}</td>
          <td style="font-size: 11.5px; color: #e2e8f0; white-space: nowrap;">${escapeHtml(l.device)}</td>
          <td style="font-size: 12px; font-weight: 600; white-space: nowrap;">${escapeHtml(l.action)}</td>
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
              <th style="background: #1e293b;">시각 (KST)</th>
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

  // 2. 일자별 감사 로그 아카이브 목록 (파일명 클릭 바로 보기 + 1-이모지 버튼)
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
      const safeDate = escapeHtml(f.date);
      const safeRelPath = escapeHtml(f.relativePath);
      const previewUrl = `/admin/logs/download?file=${encodedRelPath}&preview=1`;
      const previewTitle = `📁 감사 로그 (${safeDate})`;

      return `
        <tr>
          <td style="font-family: monospace; font-size: 12.5px; font-weight: 600; color: #38bdf8; white-space: nowrap; cursor: pointer;"
              data-json-preview-url="${previewUrl}" data-json-title="${previewTitle}" title="클릭하여 JSON 바로 보기">
            📅 ${safeDate}
          </td>
          <td style="font-family: monospace; font-size: 11.5px; color: #93c5fd; white-space: nowrap; cursor: pointer; text-decoration: underline dotted;"
              data-json-preview-url="${previewUrl}" data-json-title="${previewTitle}" title="클릭하여 JSON 바로 보기">
            ${safeRelPath}
          </td>
          <td style="text-align: center; white-space: nowrap;">
            <span style="background: rgba(59,130,246,0.15); color: #60a5fa; border: 1px solid rgba(59,130,246,0.3); font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 4px;">
              ${f.linesCount}건 기록
            </span>
          </td>
          <td style="font-size: 11.5px; color: var(--text-muted); text-align: right; white-space: nowrap;">${escapeHtml(f.sizeKb)}</td>
          <td style="text-align: right; white-space: nowrap;">
            <button type="button" class="btn-action btn-download" style="margin-right: 4px; border: none; cursor: pointer;"
                    data-json-preview-url="${previewUrl}" data-json-title="${previewTitle}" title="JSON 바로 보기">👁️</button>
            <a href="/admin/logs/download?file=${encodedRelPath}" class="btn-action btn-download" style="margin-right: 4px;" title="JSON 다운로드">📥</a>
            <a href="/admin/logs/delete?file=${encodedRelPath}" class="btn-action btn-delete" title="삭제" onclick="return confirm('${safeDate} 일자의 로그 파일을 완전히 삭제하시겠습니까?');">🗑️</a>
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
              <th style="background: #1e293b;">저장 경로 (클릭 바로보기)</th>
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

  // 3. 크래시 리포트 테이블 (KST 변환 + 파일명 클릭 바로 보기 + 1-이모지 버튼)
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
        timeZone: 'Asia/Seoul',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
      });
      const encodedName = encodeURIComponent(r.fileName);
      const safeName = escapeHtml(r.fileName);
      const previewUrl = `/admin/crash-reports/download/${encodedName}?preview=1`;
      const previewTitle = `🔬 조판 리포트 (${safeName})`;

      return `
        <tr>
          <td style="font-family: monospace; font-size: 11.5px; color: #38bdf8; white-space: nowrap; cursor: pointer; text-decoration: underline dotted;"
              data-json-preview-url="${previewUrl}" data-json-title="${previewTitle}" title="클릭하여 JSON 바로 보기">
            ${safeName}
          </td>
          <td style="font-size: 12px; color: var(--text-muted); white-space: nowrap;">${escapeHtml(dateStr)}</td>
          <td style="text-align: center; white-space: nowrap;">
            <span style="background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid rgba(239,68,68,0.3); font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 4px;">
              ${r.totalAnomalies}건
            </span>
          </td>
          <td style="font-size: 11.5px; color: var(--text-muted); text-align: right; white-space: nowrap;">${escapeHtml(r.sizeKb)}</td>
          <td style="text-align: right; white-space: nowrap;">
            <button type="button" class="btn-action btn-download" style="margin-right: 4px; border: none; cursor: pointer;"
                    data-json-preview-url="${previewUrl}" data-json-title="${previewTitle}" title="JSON 바로 보기">👁️</button>
            <a href="/admin/crash-reports/download/${encodedName}" class="btn-action btn-download" style="margin-right: 4px;" title="JSON 다운로드">📥</a>
            <a href="/admin/crash-reports/delete/${encodedName}" class="btn-action btn-delete" title="삭제" onclick="return confirm('이 리포트를 삭제하시겠습니까?');">🗑️</a>
          </td>
        </tr>
      `;
    }).join('');

    crashReportsHtml = `
      <div style="max-height: 380px; overflow: auto; margin-top: 8px; border: 1px solid var(--border); border-radius: 8px; background: #0f172a;">
        <table class="data-table" style="min-width: 580px; border-collapse: separate; border-spacing: 0;">
          <thead style="position: sticky; top: 0; background: #1e293b; z-index: 2;">
            <tr>
              <th style="background: #1e293b;">파일명 (클릭 바로보기)</th>
              <th style="background: #1e293b;">발생 시각 (KST)</th>
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
    <!-- 상단 가로 1줄 실시간 시스템 자원 게이지 바 -->
    <div class="card" style="padding: 14px 18px; margin-bottom: 16px; background: #0f172a; border: 1px solid var(--border);">
      <div class="system-gauge-container">
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
        <span id="gauge-sync-time">산출(KST): ${initialStats.lastCheckedAt}</span>
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
        최근 산출 시각(KST): ${metrics.lastCalculatedAt || '-'}
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
              ${count429 > 0 ? `${count429}건 초과 락` : '600회 / 분'}
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

    <!-- 3. 일자별 보안 감사 로그 다운로드 센터 -->
    <div class="card">
      <div class="section-title">
        <span>📁 일자별 보안 감사 로그 다운로드 센터 (${logFiles.length}일분 보관 중)</span>
      </div>
      <p style="font-size: 12.5px; color: var(--text-muted); margin: 0 0 10px 0;">
        파일명 또는 <strong>👁️</strong> 버튼을 클릭하면 브라우저에서 JSON 내용을 바로 볼 수 있습니다.
      </p>
      ${logFilesHtml}
    </div>

    <!-- 4. 최근 30건 실시간 기기/IP 활동 로그 위젯 -->
    <div class="card">
      <div class="section-title">
        <span>📋 최근 실시간 활동 로그 (최근 30건 FIFO 링 버퍼)</span>
        <span class="badge badge-success">실시간 관제 중 (KST)</span>
      </div>
      <p style="font-size: 12.5px; color: var(--text-muted); margin: 0 0 10px 0;">
        사용자별 도서 동기화, 다운로드 및 접근 이력이 한국 표준시(KST) 기준으로 표출됩니다.
      </p>
      ${activityLogsHtml}
    </div>

    <!-- 5. 조판 결함 및 크래시 리포트 다운로드 센터 -->
    <div class="card">
      <div class="section-title">
        <span>🔬 조판 결함 및 크래시 리포트 (${crashReports ? crashReports.length : 0}건)</span>
        ${crashReports && crashReports.length > 0 ? `<a href="/admin/crash-reports/clear" class="btn-clear-all" onclick="return confirm('수집된 모든 크래시 리포트를 일괄 삭제하시겠습니까?');">🧹 전체 비우기</a>` : ''}
      </div>
      <p style="font-size: 12.5px; color: var(--text-muted); margin: 0 0 10px 0;">
        파일명 또는 <strong>👁️</strong> 버튼을 클릭하면 진단 JSON 내용을 바로 확인할 수 있습니다.
      </p>
      ${crashReportsHtml}
    </div>

    <!-- 🔍 JSON 바로 보기 모달 -->
    <div class="modal-overlay" id="modal-json-preview">
      <div class="modal-box" style="max-width: 780px; width: 100%;">
        <div class="modal-header">
          <h3 id="json-preview-title" style="color: #38bdf8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">📄 JSON 바로 보기</h3>
          <button type="button" class="modal-close-btn" onclick="closeJsonPreviewModal()">&times;</button>
        </div>
        <div class="modal-body" style="padding: 14px 16px;">
          <pre id="json-preview-content" style="margin: 0; padding: 14px; background: #090d16; border: 1px solid var(--border); border-radius: 8px; color: #e2e8f0; font-family: monospace; font-size: 12px; line-height: 1.5; max-height: 60vh; overflow: auto; white-space: pre-wrap; word-break: break-word;"></pre>
        </div>
        <div class="modal-footer" style="justify-content: space-between;">
          <button type="button" class="btn-modal-cancel" id="btn-copy-json-preview" onclick="copyJsonPreviewContent()">📋 내용 복사</button>
          <button type="button" class="btn-modal-select" onclick="closeJsonPreviewModal()">닫기</button>
        </div>
      </div>
    </div>

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
        var statsIntervalId = null;

        async function fetchSystemStats() {
          try {
            const res = await fetch('/api/admin/system-stats');
            if (res.status === 401) {
              if (statsIntervalId !== null) {
                clearInterval(statsIntervalId);
                statsIntervalId = null;
              }
              const timeEl = document.getElementById('gauge-sync-time');
              if (timeEl) {
                timeEl.textContent = '🔒 세션 만료 - 새로고침 후 재인증 필요';
                timeEl.style.color = '#f87171';
              }
              return;
            }
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
            if (timeEl) timeEl.textContent = '산출(KST): ' + lastCheckedAt;
          } catch (e) {}
        }

        statsIntervalId = setInterval(fetchSystemStats, 10000);

        window.closeJsonPreviewModal = function() {
          var modal = document.getElementById('modal-json-preview');
          if (modal) modal.classList.remove('active');
        };

        window.copyJsonPreviewContent = function() {
          var pre = document.getElementById('json-preview-content');
          var btn = document.getElementById('btn-copy-json-preview');
          if (!pre) return;
          if (typeof copyToClipboard === 'function' && btn) {
            copyToClipboard(pre.textContent || '', btn);
          } else if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(pre.textContent || '');
          }
        };

        document.addEventListener('click', async function(e) {
          var target = e.target.closest('[data-json-preview-url]');
          if (target) {
            var url = target.getAttribute('data-json-preview-url');
            var title = target.getAttribute('data-json-title') || '📄 JSON 바로 보기';
            var modal = document.getElementById('modal-json-preview');
            var titleEl = document.getElementById('json-preview-title');
            var preEl = document.getElementById('json-preview-content');
            if (!modal || !preEl) return;

            if (titleEl) titleEl.textContent = title;
            preEl.textContent = '⏳ JSON 내용을 불러오는 중...';
            modal.classList.add('active');

            try {
              var res = await fetch(url);
              var rawText = await res.text();
              if (!res.ok) {
                preEl.textContent = '❌ 불러오기 실패 (HTTP ' + res.status + ')\\n' + rawText;
                return;
              }
              try {
                var parsed = JSON.parse(rawText);
                preEl.textContent = JSON.stringify(parsed, null, 2);
              } catch (_) {
                preEl.textContent = rawText;
              }
            } catch (err) {
              preEl.textContent = '❌ 통신 오류: ' + err.message;
            }
            return;
          }

          var previewModal = document.getElementById('modal-json-preview');
          if (previewModal && e.target === previewModal) {
            window.closeJsonPreviewModal();
          }
        });
      })();
    </script>
  `;
}