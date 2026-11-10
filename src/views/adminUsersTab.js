/**
 * @file src/views/adminUsersTab.js
 * @description 관리자 제어 센터 [탭 3: 👥 사용자 & API 저장소 관리] HTML 렌더러 모듈
 * - 👥 [다중 사용자 관제 테이블] 서재 폴더명, 식별 메모, 상태(대기/활성), 24시간 만료 시간, 저장 용량 실측 바
 * - 🎲 [신규 키 발급 폼] 서재 메모 및 할당 용량(MB) 지정 후 원클릭 발급
 * - 🔄 [무손실 재발급] 기존 도서 100% 보존 상태로 새 API 키 즉시 교체
 * - 🗑️ [선택적 삭제] API 키만 폐기 vs 도서 폴더까지 완전 삭제 2-Step 확인 지원
 */

import { apiKeyManager } from '../apiKeyManager.js';

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
 * 👥 [탭 3] 사용자 & API 저장소 관리 HTML 렌더러
 * @param {Object} env - readEnvFile() 결과 객체
 * @returns {string} 탭 3 본문 HTML 문자열
 */
export function renderUsersTab(env = {}) {
  const isStorageMode = env.STORAGE_MODE === 'true';

  if (!isStorageMode) {
    return `
      <div class="card" style="text-align: center; padding: 40px 20px;">
        <div style="font-size: 40px; margin-bottom: 12px;">🔒</div>
        <h3 style="margin: 0 0 8px 0; color: #f8fafc;">개인 서버 저장소 모드 비활성</h3>
        <p style="color: var(--text-muted); font-size: 13.5px; margin: 0 0 20px 0;">
          다중 사용자 서재 기능은 [⚙️ 시스템 설정] 탭에서 <strong>개인 서버 저장소 모드(STORAGE_MODE)</strong>를 켰을 때만 작동합니다.
        </p>
        <button type="button" class="btn-submit" style="max-width: 240px; margin: 0 auto;" onclick="switchAdminTab('settings')">
          ⚙️ 시스템 설정으로 이동
        </button>
      </div>
    `;
  }

  const users = apiKeyManager.getUserListForAdmin();

  let userRowsHtml = '';
  if (!users || users.length === 0) {
    userRowsHtml = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 32px 12px; color: var(--text-muted); font-size: 13px;">
          <span style="font-size: 24px; display: block; margin-bottom: 6px;">👥</span>
          아직 등록된 사용자가 없습니다. 아래 <strong>[🎲 새 사용자 키 발급]</strong>을 눌러 가족이나 친구를 초대하세요.
        </td>
      </tr>
    `;
  } else {
    userRowsHtml = users.map(u => {
      let statusBadge = '<span class="status-pill status-200">🟢 활성</span>';
      if (u.status === 'PENDING') {
        statusBadge = `<span class="status-pill status-429" style="background:rgba(245,158,11,0.2);color:#fbbf24;border:1px solid #f59e0b;">⏳ 등록 대기 (${u.remainingHours || 0}h)</span>`;
      } else if (u.status === 'EXPIRED') {
        statusBadge = '<span class="status-pill status-404">⌛ 만료됨</span>';
      } else if (u.status === 'REVOKED') {
        statusBadge = '<span class="status-pill status-403">⛔ 폐기됨</span>';
      }

      const barColor = u.percent >= 90 ? '#ef4444' : (u.percent >= 75 ? '#f59e0b' : '#38bdf8');
      const safeFolder = escapeHtml(u.folderName);
      const safeMemo = escapeHtml(u.memo);

      return `
        <tr>
          <td style="font-family: monospace; font-size: 12.5px; font-weight: 700; color: #38bdf8;">
            📁 ${safeFolder}
          </td>
          <td style="font-size: 13px; font-weight: 600; color: #f8fafc;">
            ${safeMemo}
          </td>
          <td style="text-align: center;">
            ${statusBadge}
          </td>
          <td style="text-align: center; font-size: 12.5px;">
            <strong>${u.bookCount}</strong> <span style="font-size: 11px; color: var(--text-muted);">권</span>
          </td>
          <td style="min-width: 130px;">
            <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">
              <span>${u.usedMb}MB</span>
              <span>${u.quotaMb}MB (${u.percent}%)</span>
            </div>
            <div style="background: #0f172a; height: 6px; border-radius: 999px; overflow: hidden; border: 1px solid var(--border);">
              <div style="background: ${barColor}; width: ${u.percent}%; height: 100%; transition: width 0.3s;"></div>
            </div>
          </td>
          <td style="font-size: 11px; color: var(--text-muted); white-space: nowrap;">
            ${u.lastAccessedAt ? new Date(u.lastAccessedAt).toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '미접속'}
          </td>
          <td style="text-align: right; white-space: nowrap;">
            <form method="POST" action="/admin/users/reissue" style="display: inline;" onsubmit="return confirm('${safeMemo} (${safeFolder}) 사용자의 API 키를 재발급하시겠습니까?\\n기존 책과 설정은 100% 안전하게 유지됩니다.');">
              <input type="hidden" name="folderName" value="${safeFolder}">
              <button type="submit" class="btn-action btn-download" style="margin-right: 4px; cursor: pointer; border: none;">🔄 재발급</button>
            </form>
            <button type="button" class="btn-action btn-delete" style="cursor: pointer;" onclick="openDeleteUserModal('${safeFolder}', '${safeMemo}', ${u.bookCount})">🗑️ 삭제</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  return `
    <!-- 1. 사용자 서재 현황 안내 카드 -->
    <div class="card">
      <div class="section-title">
        <span>👥 다중 사용자 서재 & API 키 관제</span>
        <span class="badge badge-success">샌드박스 격리 중</span>
      </div>
      <p style="font-size: 12.5px; color: var(--text-muted); margin: 0 0 16px 0;">
        사용자별로 독립된 도서 폴더(<code>data/users/{폴더명}/books</code>)와 독서 설정이 배정됩니다.<br>
        발급된 키는 <strong>24시간 이내에 웹 뷰어에서 최초 1회 인증</strong>하면 영구 활성화됩니다.
      </p>

      <div style="overflow-x: auto;">
        <table class="data-table">
          <thead>
            <tr>
              <th>서재 폴더명</th>
              <th>사용자 메모</th>
              <th style="text-align: center;">상태</th>
              <th style="text-align: center;">도서 수</th>
              <th>저장 용량</th>
              <th>최근 접속</th>
              <th style="text-align: right;">작업</th>
            </tr>
          </thead>
          <tbody>
            ${userRowsHtml}
          </tbody>
        </table>
      </div>

      <div style="margin-top: 18px; text-align: right;">
        <button type="button" class="btn-submit" style="width: auto; padding: 10px 20px; font-size: 13.5px;" onclick="openCreateUserModal()">
          🎲 새 사용자 API 키 발급
        </button>
      </div>
    </div>

    <!-- 2. 신규 사용자 발급 모달 -->
    <div class="modal-overlay" id="modal-create-user">
      <div class="modal-box" style="max-width: 440px;">
        <div class="modal-header">
          <h3>🎲 새 사용자 API 키 발급</h3>
          <button type="button" class="modal-close-btn" onclick="closeCreateUserModal()">&times;</button>
        </div>
        <form method="POST" action="/admin/users/create">
          <div class="modal-body">
            <p style="font-size: 12.5px; color: var(--text-muted); margin: 0 0 14px 0;">
              사용자 식별용 메모와 할당할 최대 도서 용량을 설정하세요. 고유 폴더명(user_xxxx)은 서버에서 자동 채번됩니다.
            </p>
            <div class="form-group">
              <label>사용자 메모 / 이름 (예: 철수 태블릿, 동생)</label>
              <input type="text" name="memo" placeholder="예: 홍길동 서재" required autofocus>
            </div>
            <div class="form-group" style="margin-top: 12px;">
              <label>할당 저장 용량 (MB 단위)</label>
              <input type="number" name="quotaMb" value="1024" min="50" max="102400" required>
              <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">기본값: 1024 MB (1 GB)</div>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn-modal-cancel" onclick="closeCreateUserModal()">취소</button>
            <button type="submit" class="btn-modal-select">✔ 키 발급하기</button>
          </div>
        </form>
      </div>
    </div>

    <!-- 3. 사용자 삭제 선택 모달 (키만 폐기 vs 폴더 포함 삭제) -->
    <div class="modal-overlay" id="modal-delete-user">
      <div class="modal-box" style="max-width: 460px;">
        <div class="modal-header">
          <h3 style="color: var(--danger);">🗑️ 사용자 서재 삭제 선택</h3>
          <button type="button" class="modal-close-btn" onclick="closeDeleteUserModal()">&times;</button>
        </div>
        <form method="POST" action="/admin/users/delete">
          <input type="hidden" id="delete-folder-input" name="folderName" value="">
          <div class="modal-body">
            <p style="font-size: 13px; color: #f8fafc; margin: 0 0 8px 0;">
              대상 서재: <strong id="delete-user-label" style="color: #38bdf8;"></strong>
            </p>
            <p style="font-size: 12px; color: var(--text-muted); margin: 0 0 16px 0;">
              현재 저장된 책: <span id="delete-book-count" style="font-weight: 700; color: #f87171;"></span>권
            </p>

            <div style="background: #0f172a; padding: 12px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 12px;">
              <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer; margin: 0;">
                <input type="radio" name="deleteFolder" value="false" checked style="margin-top: 2px;">
                <div>
                  <strong style="font-size: 13px; color: #f8fafc;">API 키만 폐기 (권장)</strong>
                  <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 2px;">
                    접속만 즉시 차단하고, 디스크의 도서 파일은 안전하게 보존합니다. 나중에 재발급 가능합니다.
                  </div>
                </div>
              </label>
            </div>

            <div style="background: #0f172a; padding: 12px; border-radius: 8px; border: 1px solid rgba(239,68,68,0.3);">
              <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer; margin: 0;">
                <input type="radio" name="deleteFolder" value="true" style="margin-top: 2px;">
                <div>
                  <strong style="font-size: 13px; color: #f87171;">도서 및 폴더 영구 완전 파쇄</strong>
                  <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 2px;">
                    이 사용자의 모든 EPUB, 표지, 진도율 데이터를 디스크에서 영구 삭제합니다. (복구 불가)
                  </div>
                </div>
              </label>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn-modal-cancel" onclick="closeDeleteUserModal()">취소</button>
            <button type="submit" class="btn-modal-select" style="background: var(--danger);">삭제 확인</button>
          </div>
        </form>
      </div>
    </div>

    <script>
      function openCreateUserModal() {
        document.getElementById('modal-create-user').classList.add('active');
      }
      function closeCreateUserModal() {
        document.getElementById('modal-create-user').classList.remove('active');
      }
      function openDeleteUserModal(folderName, memo, bookCount) {
        document.getElementById('delete-folder-input').value = folderName;
        document.getElementById('delete-user-label').textContent = memo + ' (' + folderName + ')';
        document.getElementById('delete-book-count').textContent = bookCount;
        document.getElementById('modal-delete-user').classList.add('active');
      }
      function closeDeleteUserModal() {
        document.getElementById('modal-delete-user').classList.remove('active');
      }
    </script>
  `;
}