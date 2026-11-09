/**
 * @file src/views/adminDashboardTab.js
 * @description 관리자 제어 센터 [탭 1: 📊 관제 대시보드] HTML 렌더러 모듈
 * - 💾 [디스크 및 도서 메트릭] 활성/보관 도서 권수 및 실측 디스크 용량 현황 카드
 * - 🛡️ [서버 보안 방어선 상태] 심볼릭 링크 격리, 확장자 화이트리스트, 요청 제한, 로그 소독 실시간 현황
 * - 📋 [실시간 활동 로그] 최근 30건 FIFO 링 버퍼 활동 내역 및 상태 코드 표출
 * - 🔬 [크래시 리포트 센터] 뷰어 조판 결함 진단 리포트 목록 및 다운로드/일괄 정리
 */

/**
 * 📊 [탭 1] 관제 대시보드 HTML 템플릿 렌더러
 * @param {Object} metrics - auditLogger 저장소 메트릭 객체
 * @param {Array} recentLogs - auditLogger 최근 활동 로그 배열
 * @param {Array} crashReports - storageService 크래시 리포트 목록
 * @param {Object} env - readEnvFile() 환경변수 객체
 * @returns {string} 탭 1 본문 HTML 문자열
 */
export function renderDashboardTab(metrics = {}, recentLogs = [], crashReports = [], env = {}) {
  const allowedOrigin = env.ALLOWED_ORIGIN || '*';
  const isOriginStrict = allowedOrigin !== '*';

  // 1. 최근 30건 활동 로그 테이블 마크업
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

  // 2. 크래시 리포트 테이블 마크업
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

    <!-- 2. 🛡️ [신규] 서버 보안 거버넌스 및 방어선 상태 카드 -->
    <div class="card">
      <div class="section-title">
        <span>🛡️ 서버 보안 거버넌스 및 방어선 상태</span>
        <span class="badge badge-success">실시간 보호 중</span>
      </div>
      <div class="stat-grid" style="grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 12px;">
        <div class="stat-card" style="text-align: left; padding: 10px 14px;">
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <span style="font-size: 12.5px; font-weight: 600;">심볼릭 링크 격리</span>
            <span class="badge badge-success" style="font-size: 10.5px;">realpath 실측</span>
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
            <span style="font-size: 12.5px; font-weight: 600;">요청 폭주 제한</span>
            <span class="badge badge-info" style="font-size: 10.5px;">120회 / 분</span>
          </div>
          <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 4px;">IP 기반 Rate Limit 방어선</div>
        </div>

        <div class="stat-card" style="text-align: left; padding: 10px 14px;">
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <span style="font-size: 12.5px; font-weight: 600;">로그 민감정보 마스킹</span>
            <span class="badge badge-success" style="font-size: 10.5px;">실시간 소독</span>
          </div>
          <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 4px;">토큰/비밀번호 로그 유출 차단</div>
        </div>
      </div>

      <div style="display: flex; align-items: center; justify-content: space-between; background: #0f172a; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border); font-size: 12px;">
        <span style="color: var(--text-muted);">웹 뷰어 출처(CORS) 방어 상태:</span>
        <span class="badge ${isOriginStrict ? 'badge-success' : 'badge-warning'}">
          ${isOriginStrict ? '지정 도메인 한정 허용' : '전체 허용 (*) - 주의'}
        </span>
      </div>
    </div>

    <!-- 3. 최근 30건 실시간 기기/IP 활동 로그 위젯 -->
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

    <!-- 4. 조판 결함 및 크래시 리포트 다운로드 센터 -->
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