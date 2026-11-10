/**
 * @file src/views/adminUsersTab.js
 * @description 관리자 제어 센터 [탭 2: 👥 사용자 & API 저장소 관리] HTML 렌더러 모듈
 * - 🎛️ [상단 일괄 액션 툴바] 새 발급, 용량 변경, 키 재발급, 삭제를 상단 툴바로 일원화
 * - 🔘 [좌측 단일 선택 라디오] 행 내부 버튼 제거로 가로폭 140px 확보 ➔ 테이블 깨짐 원천 박멸
 * - 👥 [다중 사용자 관제 테이블] 서재 폴더명, 식별 메모, 상태(대기/활성), 24시간 만료 시간, 저장 용량 실측 바
 */

import { apiKeyManager } from '../apiKeyManager.js';

function escapeHtml(str = '') {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
        <td colspan="6" style="text-align: center; padding: 32px 12px; color: var(--text-muted); font-size: 13px;">
          <span style="font-size: 24px; display: block; margin-bottom: 6px;">👥</span>
          아직 등록된 사용자가 없습니다. 상단 <strong>[🎲 새 사용자 발급]</strong>을 눌러 가족이나 친구를 초대하세요.
        </td>
      </tr>
    `;
  } else {
    userRowsHtml = users.map((u, idx) => {
      let statusBadge = '<span class="status-pill status-200">🟢 활성</span>';
      if (u.status === 'PENDING') {
        statusBadge = `<span class="status-pill status-429" style="background:rgba(245,158,11,0.2);color:#fbbf24;border:1px solid #f59e0b;">⏳ 대기 (${u.remainingHours || 0}h)</span>`;
      } else if (u.status === 'EXPIRED') {
        statusBadge = '<span class="status-pill status-404">⌛ 만료됨</span>';
      } else if (u.status === 'REVOKED') {
        statusBadge = '<span class="status-pill status-403">⛔ 폐기됨</span>';
      }

      const barColor = u.percent >= 90 ? '#ef4444' : (u.percent >= 75 ? '#f59e0b' : '#38bdf8');
      const safeFolder = escapeHtml(u.folderName);
      const safeMemo = escapeHtml(u.memo);

      return `
        <tr id="row-user-${safeFolder}" style="cursor: pointer;" onclick="selectUserRadio('${safeFolder}', '${safeMemo}', ${u.quotaMb}, ${u.bookCount})">
          <td style="text-align: center; width: 36px;" onclick="event.stopPropagation();">
            <input type="radio" name="selectedUserRadio" id="radio-${safeFolder}" value="${safeFolder}" 
                   onchange="handleUserRadioChange('${safeFolder}', '${safeMemo}', ${u.quotaMb}, ${u.bookCount})" 
                   style="cursor: pointer; width: 16px; height: 16px; accent-color: #38bdf8;">
          </td>
          <td style="font-family: monospace; font-size: 12.5px; font-weight: 700; color: #38bdf8; white-space: nowrap;">
            📁 ${safeFolder}
          </td>
          <td style="font-size: 13px; font-weight: 600; color: #f8fafc; white-space: nowrap;">
            ${safeMemo}
          </td>
          <td style="text-align: center; white-space: nowrap;">
            ${statusBadge}
          </td>
          <td style="text-align: center; font-size: 12.5px; white-space: nowrap;">
            <strong>${u.bookCount}</strong> <span style="font-size: 11px; color: var(--text-muted);">권</span>
          </td>
          <td style="min-width: 140px;">
            <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">
              <span>${u.usedMb}MB</span>
              <span>${u.quotaMb}MB (${u.percent}%)</span>
            </div>
            <div style="background: #0f172a; height: 6px; border-radius: 999px; overflow: hidden; border: 1px solid var(--border);">
              <div style="background: ${barColor}; width: ${u.percent}%; height: 100%;"></div>
            </div>
          </td>
          <td style="font-size: 11px; color: var(--text-muted); white-space: nowrap; text-align: right;">
            ${u.lastAccessedAt ? new Date(u.lastAccessedAt).toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '미접속'}
          </td>
        </tr>
      `;
    }).join('');
  }

  return `
    <div class="card">
      <div class="section-title">
        <span>👥 다중 사용자 서재 & API 키 관제</span>
        <span class="badge badge-success">샌드박스 격리 중</span>
      </div>

      <!-- 🌟 [핵심 개선] 상단 일괄 액션 제어 툴바 (좌우 깨짐 원천 차단) -->
      <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; background: #0f172a; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 14px;">
        <div style="font-size: 12.5px; color: var(--text-muted); display: flex; align-items: center; gap: 6px;">
          <span>선택:</span>
          <strong id="toolbar-selected-label" style="color: #f8fafc;">목록에서 사용자를 선택하세요</strong>
        </div>

        <div style="display: flex; gap: 6px; align-items: center;">
          <button type="button" class="btn-action btn-download" style="padding: 6px 10px; font-size: 12px; border: none; cursor: pointer;" onclick="openCreateUserModal()">
            🎲 새 사용자 발급
          </button>
          <button type="button" id="btn-toolbar-quota" class="btn-action" style="background: #334155; color: #38bdf8; padding: 6px 10px; font-size: 12px; border: none; cursor: not-allowed; opacity: 0.4;" onclick="triggerToolbarQuota()" disabled>
            ⚙️ 용량 변경
          </button>
          <button type="button" id="btn-toolbar-reissue" class="btn-action" style="background: #0369a1; color: white; padding: 6px 10px; font-size: 12px; border: none; cursor: not-allowed; opacity: 0.4;" onclick="triggerToolbarReissue()" disabled>
            🔄 키 재발급
          </button>
          <button type="button" id="btn-toolbar-delete" class="btn-action btn-delete" style="padding: 6px 10px; font-size: 12px; cursor: not-allowed; opacity: 0.4;" onclick="triggerToolbarDelete()" disabled>
            🗑️ 서재 삭제
          </button>
        </div>
      </div>

      <!-- 행 내부 버튼 제거로 가로폭 100% 확보된 깔끔한 관제 테이블 -->
      <div style="overflow-x: auto; border: 1px solid var(--border); border-radius: 8px;">
        <table class="data-table" style="margin: 0; min-width: 620px;">
          <thead>
            <tr>
              <th style="width: 36px; text-align: center;">선택</th>
              <th>서재 폴더명</th>
              <th>사용자 메모</th>
              <th style="text-align: center;">상태</th>
              <th style="text-align: center;">도서 수</th>
              <th>저장 용량</th>
              <th style="text-align: right;">최근 접속</th>
            </tr>
          </thead>
          <tbody>
            ${userRowsHtml}
          </tbody>
        </table>
      </div>
    </div>

    <!-- 숨겨진 재발급 제출 전용 폼 -->
    <form id="form-reissue-hidden" method="POST" action="/admin/users/reissue" style="display: none;">
      <input type="hidden" id="hidden-reissue-folder" name="folderName" value="">
    </form>

    <!-- 1. 신규 사용자 발급 모달 -->
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

    <!-- 2. 사용자 저장 용량 변경 모달 -->
    <div class="modal-overlay" id="modal-update-quota">
      <div class="modal-box" style="max-width: 420px;">
        <div class="modal-header">
          <h3 style="color: #38bdf8;">⚙️ 서재 저장 용량 변경</h3>
          <button type="button" class="modal-close-btn" onclick="closeUpdateQuotaModal()">&times;</button>
        </div>
        <form method="POST" action="/admin/users/update-quota">
          <input type="hidden" id="quota-folder-input" name="folderName" value="">
          <div class="modal-body">
            <p style="font-size: 13px; color: #f8fafc; margin: 0 0 12px 0;">
              대상 서재: <strong id="quota-user-label" style="color: #38bdf8;"></strong>
            </p>
            <div class="form-group">
              <label>새 할당 용량 (MB 단위)</label>
              <input type="number" id="quota-mb-input" name="quotaMb" min="50" max="1024000" required>
              <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 6px;">
                • 1 GB = 1024 MB | 2 GB = 2048 MB | 5 GB = 5120 MB
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn-modal-cancel" onclick="closeUpdateQuotaModal()">취소</button>
            <button type="submit" class="btn-modal-select">변경 저장</button>
          </div>
        </form>
      </div>
    </div>

    <!-- 3. 사용자 삭제 선택 모달 -->
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
      let activeSelectedUser = null;

      function selectUserRadio(folderName, memo, quotaMb, bookCount) {
        const radio = document.getElementById('radio-' + folderName);
        if (radio) {
          radio.checked = true;
          handleUserRadioChange(folderName, memo, quotaMb, bookCount);
        }
      }

      function handleUserRadioChange(folderName, memo, quotaMb, bookCount) {
        activeSelectedUser = { folderName, memo, quotaMb, bookCount };
        
        document.querySelectorAll('tr[id^="row-user-"]').forEach(tr => tr.style.background = 'transparent');
        const activeRow = document.getElementById('row-user-' + folderName);
        if (activeRow) activeRow.style.background = 'rgba(56, 189, 248, 0.08)';

        document.getElementById('toolbar-selected-label').innerHTML = 
          '<span style="color:#38bdf8;">' + memo + '</span> (' + folderName + ')';

        ['btn-toolbar-quota', 'btn-toolbar-reissue', 'btn-toolbar-delete'].forEach(btnId => {
          const btn = document.getElementById(btnId);
          if (btn) {
            btn.disabled = false;
            btn.style.cursor = 'pointer';
            btn.style.opacity = '1';
          }
        });
      }

      function triggerToolbarQuota() {
        if (!activeSelectedUser) return;
        document.getElementById('quota-folder-input').value = activeSelectedUser.folderName;
        document.getElementById('quota-user-label').textContent = activeSelectedUser.memo + ' (' + activeSelectedUser.folderName + ')';
        document.getElementById('quota-mb-input').value = activeSelectedUser.quotaMb || 1024;
        document.getElementById('modal-update-quota').classList.add('active');
      }

      function triggerToolbarReissue() {
        if (!activeSelectedUser) return;
        if (confirm(activeSelectedUser.memo + ' (' + activeSelectedUser.folderName + ') 사용자의 API 키를 재발급하시겠습니까?\\n기존 책과 설정은 100% 안전하게 유지됩니다.')) {
          document.getElementById('hidden-reissue-folder').value = activeSelectedUser.folderName;
          document.getElementById('form-reissue-hidden').submit();
        }
      }

      function triggerToolbarDelete() {
        if (!activeSelectedUser) return;
        document.getElementById('delete-folder-input').value = activeSelectedUser.folderName;
        document.getElementById('delete-user-label').textContent = activeSelectedUser.memo + ' (' + activeSelectedUser.folderName + ')';
        document.getElementById('delete-book-count').textContent = activeSelectedUser.bookCount;
        document.getElementById('modal-delete-user').classList.add('active');
      }

      function openCreateUserModal() {
        document.getElementById('modal-create-user').classList.add('active');
      }
      function closeCreateUserModal() {
        document.getElementById('modal-create-user').classList.remove('active');
      }
      function closeUpdateQuotaModal() {
        document.getElementById('modal-update-quota').classList.remove('active');
      }
      function closeDeleteUserModal() {
        document.getElementById('modal-delete-user').classList.remove('active');
      }
    </script>
  `;
}