/**
 * @file src/views/adminDashboardTab.js
 * @description 관리자 제어 센터 [탭 1: 📊 관제 대시보드] HTML 렌더러 모듈
 * - 👥 [사용자 칼럼 신설] 활동 로그 테이블에 사용자 메모/서재 칼럼 표출
 * - ↔️ [가로/세로 2D 스크롤 박스] max-height: 400px (10행 기준) + overflow: auto 로 오른쪽 끝 잘림 방지
 * - 📌 [스티키 헤더 탑재] 스크롤을 내려도 thead th가 상단에 고정되어 가독성 극대화
 * - 💾 [디스크 및 도서 메트릭] 활성/보관 도서 권수 및 실측 디스크 용량 현황 카드
 * - 📁 [일자별 감사 로그 다운로드 센터] 일자별 영구 저장 파일 목록 및 스크롤 박스
 * - 🔬 [크래시 리포트 센터] 뷰어 조판 결함 진단 리포트 스크롤 테이블
 */

import { auditLogger } from '../auditLogger.js';

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

    // 🌟 [핵심 개선] max-height: 400px (10행 기준) 세로 스크롤 + overflow-x: auto (가로 스크롤로 오른쪽 끝 보장) + sticky 헤더
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
  `;
}