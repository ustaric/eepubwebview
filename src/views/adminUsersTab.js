/**
 * @file src/views/adminUsersTab.js
 * @description 관리자 제어 센터 [탭 2: 👥 사용자 & API 저장소 관리] HTML 렌더러 모듈
 * - 🇰🇷 [한국 표준시(KST) 통일] 사용자 최근 접속 및 기기 최근 접속 시각을 Asia/Seoul 기준으로 정확히 표출
 * - 📚 [1-Click 도서·묘비 모달 직통 연결] 테이블의 도서 수 배지 클릭 및 상단 [📚 도서 관리] 버튼으로 도서/오류파일/묘비 모달 즉시 오픈
 * - 📱 [1-Click 기기 모달 직통 연결] 테이블의 '2/6대' 배지 클릭 즉시 해당 사용자의 등록 기기 관제 팝업 오픈
 * - 📱 [기기 관리 모달 탑재] #modal-user-devices 지원으로 사용자별 등록 기기 목록(기기명, IP, 최근 접속) 및 개별 차단/해제/삭제
 * - 🔄 [테이블 실시간 동기화] 기기·도서 모달 변경 사항을 뒤쪽 사용자 목록 테이블 배지에 즉시 반영
 * - 🛡️ [XSS 및 속성 위임 안전] data-* 속성 클릭 위임과 HTML 이스케이프로 특수문자 기기명·메모 안전 처리
 */

import { apiKeyManager } from '../apiKeyManager.js';
import { renderUserLibraryModalAndScript } from './adminUserLibraryModal.js';

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
  const userDevicesDataMap = {};

  if (!users || users.length === 0) {
    userRowsHtml = `
      <tr>
        <td colspan="8" style="text-align: center; padding: 32px 12px; color: var(--text-muted); font-size: 13px;">
          <span style="font-size: 24px; display: block; margin-bottom: 6px;">👥</span>
          아직 등록된 사용자가 없습니다. 상단 <strong>[🎲 새 사용자 발급]</strong>을 눌러 가족이나 친구를 초대하세요.
        </td>
      </tr>
    `;
  } else {
    userRowsHtml = users.map((u) => {
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
      const maxDev = u.maxDevices || 6;
      const devCount = u.deviceCount || 0;
      const blockedCount = u.blockedDeviceCount || 0;

      userDevicesDataMap[u.folderName] = {
        folderName: u.folderName,
        memo: u.memo,
        quotaMb: u.quotaMb,
        bookCount: u.bookCount,
        maxDevices: maxDev,
        devices: u.devices || []
      };

      const deviceBadge = `
        <div class="device-click-pill" id="user-device-pill-${safeFolder}" onclick="event.stopPropagation(); openUserDevicesModalDirectly('${safeFolder}')" 
             title="클릭하여 '${safeMemo}' 사용자의 기기 목록 관리" 
             style="cursor: pointer; display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 6px; background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.3); transition: all 0.2s;">
          <span style="font-size: 12px; font-weight: 700; color: #38bdf8;">📱 ${devCount}/${maxDev}대</span>
          ${blockedCount > 0 ? `<span style="font-size: 10px; padding: 1px 4px; border-radius: 4px; background: #ef4444; color: white; font-weight: 700;">${blockedCount}차단</span>` : ''}
        </div>
      `;

      const bookBadge = `
        <div class="device-click-pill" id="user-book-pill-${safeFolder}" onclick="event.stopPropagation(); openUserLibraryModalDirectly('${safeFolder}')"
             title="클릭하여 '${safeMemo}' 서재의 도서·오류파일·묘비 관리"
             style="cursor: pointer; display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 6px; background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.3); transition: all 0.2s;">
          <span style="font-size: 12px; font-weight: 700; color: #34d399;">📚 ${u.bookCount}권</span>
        </div>
      `;

      const lastAccessedText = u.lastAccessedAt
        ? new Date(u.lastAccessedAt).toLocaleString('ko-KR', {
            timeZone: 'Asia/Seoul',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
          })
        : '미접속';

      return `
        <tr id="row-user-${safeFolder}" style="cursor: pointer;" onclick="selectUserRadio('${safeFolder}')">
          <td style="text-align: center; width: 36px;" onclick="event.stopPropagation();">
            <input type="radio" name="selectedUserRadio" id="radio-${safeFolder}" value="${safeFolder}" 
                   onchange="handleUserRadioChange('${safeFolder}')" 
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
          <td style="text-align: center; white-space: nowrap;">
            ${deviceBadge}
          </td>
          <td style="text-align: center; font-size: 12.5px; white-space: nowrap;">
            ${bookBadge}
          </td>
          <td style="min-width: 130px;">
            <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">
              <span>${u.usedMb}MB</span>
              <span>${u.quotaMb}MB (${u.percent}%)</span>
            </div>
            <div style="background: #0f172a; height: 6px; border-radius: 999px; overflow: hidden; border: 1px solid var(--border);">
              <div style="background: ${barColor}; width: ${u.percent}%; height: 100%;"></div>
            </div>
          </td>
          <td style="font-size: 11px; color: var(--text-muted); white-space: nowrap; text-align: right;">
            ${escapeHtml(lastAccessedText)}
          </td>
        </tr>
      `;
    }).join('');
  }

  const clientDataScript = `<script>window.__USER_DEVICES_MAP__ = ${JSON.stringify(userDevicesDataMap)};</script>`;

  return `
    ${clientDataScript}
    <div class="card">
      <div class="section-title">
        <span>👥 다중 사용자 서재 & API 키 관제</span>
        <span class="badge badge-success">샌드박스 격리 중</span>
      </div>

      <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; background: #0f172a; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 14px;">
        <div style="font-size: 12.5px; color: var(--text-muted); display: flex; align-items: center; gap: 6px;">
          <span>선택:</span>
          <strong id="toolbar-selected-label" style="color: #f8fafc;">목록에서 사용자를 선택하세요</strong>
        </div>

        <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
          <button type="button" class="btn-action btn-download" style="padding: 6px 10px; font-size: 12px; border: none; cursor: pointer;" onclick="openCreateUserModal()">
            🎲 새 사용자 발급
          </button>
          <button type="button" id="btn-toolbar-library" class="btn-action" style="background: #059669; color: white; padding: 6px 10px; font-size: 12px; border: none; cursor: not-allowed; opacity: 0.4;" onclick="triggerToolbarLibrary()" disabled>
            📚 도서 관리
          </button>
          <button type="button" id="btn-toolbar-devices" class="btn-action" style="background: #0d9488; color: white; padding: 6px 10px; font-size: 12px; border: none; cursor: not-allowed; opacity: 0.4;" onclick="triggerToolbarDevices()" disabled>
            📱 기기 관리
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

      <div style="overflow-x: auto; border: 1px solid var(--border); border-radius: 8px;">
        <table class="data-table" style="margin: 0; min-width: 680px;">
          <thead>
            <tr>
              <th style="width: 36px; text-align: center;">선택</th>
              <th>서재 폴더명</th>
              <th>사용자 메모</th>
              <th style="text-align: center;">상태</th>
              <th style="text-align: center;">기기 수 (클릭 관리)</th>
              <th style="text-align: center;">도서 수 (클릭 관리)</th>
              <th>저장 용량</th>
              <th style="text-align: right;">최근 접속 (KST)</th>
            </tr>
          </thead>
          <tbody>
            ${userRowsHtml}
          </tbody>
        </table>
      </div>
    </div>

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
              사용자 식별용 메모, 도서 용량 및 허용할 기기 수를 설정하세요.
            </p>
            <div class="form-group">
              <label>사용자 메모 / 이름 (예: 철수 태블릿, 동생)</label>
              <input type="text" name="memo" placeholder="예: 홍길동 서재" required autofocus>
            </div>
            <div class="form-row" style="margin-top: 12px;">
              <div class="form-group">
                <label>할당 저장 용량 (MB 단위)</label>
                <input type="number" name="quotaMb" value="1024" min="50" max="102400" required>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">기본: 1024 MB (1GB)</div>
              </div>
              <div class="form-group">
                <label>최대 허용 기기 수 (대)</label>
                <input type="number" name="maxDevices" value="6" min="1" max="50" required>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">기본: 6대</div>
              </div>
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

    <!-- 4. 📱 등록 기기 관리 및 개별 차단 모달 -->
    <div class="modal-overlay" id="modal-user-devices">
      <div class="modal-box" style="max-width: 620px;">
        <div class="modal-header">
          <h3 style="color: #2dd4bf; display: flex; align-items: center; gap: 6px;">
            <span>📱</span> 등록 기기 관제 & 차단 (Ban)
          </h3>
          <button type="button" class="modal-close-btn" onclick="closeUserDevicesModal()">&times;</button>
        </div>
        <div class="modal-body">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; background: #0f172a; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border);">
            <div>
              <span style="font-size: 13px; color: var(--text-muted);">대상:</span>
              <strong id="devices-user-label" style="color: #38bdf8; font-size: 13.5px; margin-left: 4px;"></strong>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <span id="devices-count-pill" style="font-size: 12px; font-weight: 700; color: #2dd4bf;"></span>
              <button type="button" class="btn-action" style="background: #334155; color: #f8fafc; padding: 3px 8px; font-size: 11px; border: none; cursor: pointer;" onclick="promptChangeMaxDevices()">
                ⚙️ 한도 변경
              </button>
            </div>
          </div>

          <div id="devices-list-container" style="max-height: 320px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px;">
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn-modal-select" onclick="closeUserDevicesModal()">확인 완료</button>
        </div>
      </div>
    </div>

    ${renderUserLibraryModalAndScript()}

    <script>
      let activeSelectedUser = null;

      function escUserHtml(str) {
        return String(str == null ? '' : str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      window.updateAdminUserRowBookCount = function(folderName, summary) {
        if (!folderName || !summary) return;
        const map = window.__USER_DEVICES_MAP__ || {};
        if (map[folderName]) {
          map[folderName].bookCount = summary.totalBooks || 0;
        }
        const pill = document.getElementById('user-book-pill-' + folderName);
        if (pill) {
          pill.innerHTML = '<span style="font-size: 12px; font-weight: 700; color: #34d399;">📚 ' + (summary.totalBooks || 0) + '권</span>';
        }
      };

      function syncAdminUserRowDeviceBadge(userObj) {
        if (!userObj || !userObj.folderName) return;
        const pill = document.getElementById('user-device-pill-' + userObj.folderName);
        if (!pill) return;
        const devList = userObj.devices || [];
        const maxDev = userObj.maxDevices || 6;
        const blockedCnt = devList.filter(function(d) { return d.status === 'blocked'; }).length;
        pill.innerHTML = '<span style="font-size: 12px; font-weight: 700; color: #38bdf8;">📱 ' + devList.length + '/' + maxDev + '대</span>' +
          (blockedCnt > 0 ? '<span style="font-size: 10px; padding: 1px 4px; border-radius: 4px; background: #ef4444; color: white; font-weight: 700;">' + blockedCnt + '차단</span>' : '');
      }

      function openUserLibraryModalDirectly(folderName) {
        selectUserRadio(folderName);
        triggerToolbarLibrary();
      }

      function openUserDevicesModalDirectly(folderName) {
        selectUserRadio(folderName);
        triggerToolbarDevices();
      }

      function selectUserRadio(folderName) {
        const radio = document.getElementById('radio-' + folderName);
        if (radio) {
          radio.checked = true;
          handleUserRadioChange(folderName);
        }
      }

      function handleUserRadioChange(folderName) {
        const map = window.__USER_DEVICES_MAP__ || {};
        const userData = map[folderName];
        if (!userData) return;

        activeSelectedUser = userData;
        
        document.querySelectorAll('tr[id^="row-user-"]').forEach(function(tr) {
          tr.style.background = 'transparent';
        });
        const activeRow = document.getElementById('row-user-' + folderName);
        if (activeRow) activeRow.style.background = 'rgba(56, 189, 248, 0.08)';

        document.getElementById('toolbar-selected-label').innerHTML = 
          '<span style="color:#38bdf8;">' + escUserHtml(userData.memo) + '</span> (' + escUserHtml(folderName) + ')';

        ['btn-toolbar-library', 'btn-toolbar-devices', 'btn-toolbar-quota', 'btn-toolbar-reissue', 'btn-toolbar-delete'].forEach(function(btnId) {
          const btn = document.getElementById(btnId);
          if (btn) {
            btn.disabled = false;
            btn.style.cursor = 'pointer';
            btn.style.opacity = '1';
          }
        });
      }

      function triggerToolbarLibrary() {
        if (!activeSelectedUser) return;
        if (typeof window.openUserLibraryModal === 'function') {
          window.openUserLibraryModal(activeSelectedUser.folderName, activeSelectedUser.memo);
        }
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
        if (confirm(activeSelectedUser.memo + ' (' + activeSelectedUser.folderName + ') 사용자의 API 키를 재발급하시겠습니까?\\n기존 책과 기기는 100% 안전하게 유지됩니다.')) {
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

      function triggerToolbarDevices() {
        if (!activeSelectedUser) return;
        document.getElementById('devices-user-label').textContent = activeSelectedUser.memo + ' (' + activeSelectedUser.folderName + ')';
        renderDevicesTableInModal();
        document.getElementById('modal-user-devices').classList.add('active');
      }

      function renderDevicesTableInModal() {
        if (!activeSelectedUser) return;
        const devices = activeSelectedUser.devices || [];
        const maxDev = activeSelectedUser.maxDevices || 6;
        document.getElementById('devices-count-pill').textContent = '등록 ' + devices.length + '대 / 최대 ' + maxDev + '대';

        const container = document.getElementById('devices-list-container');
        if (devices.length === 0) {
          container.innerHTML = '<div style="padding:24px; text-align:center; color:var(--text-muted); font-size:12.5px;">등록된 기기가 없습니다.<br><span style="font-size:11.5px; opacity:0.8;">웹 뷰어에서 처음 접속할 때 기기가 자동 등록됩니다.</span></div>';
          return;
        }

        let rowsHtml = '';
        for (let i = 0; i < devices.length; i++) {
          const d = devices[i];
          const isBlocked = d.status === 'blocked';
          const statusBadge = isBlocked 
            ? '<span class="status-pill status-403">⛔ 차단됨</span>' 
            : '<span class="status-pill status-200">🟢 정상</span>';

          const safeDevId = escUserHtml(d.deviceId);
          const toggleActionBtn = isBlocked
            ? '<button type="button" class="btn-action btn-download" style="background:#10b981;border:none;cursor:pointer;" data-dev-action="unblock" data-dev-id="' + safeDevId + '">해제</button>'
            : '<button type="button" class="btn-action btn-delete" data-dev-action="block" data-dev-id="' + safeDevId + '">차단</button>';

          const lastSeenDate = d.lastSeen
            ? new Date(d.lastSeen).toLocaleString('ko-KR', {
                timeZone: 'Asia/Seoul',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
              })
            : '-';

          rowsHtml += '<tr id="row-device-' + safeDevId + '">' +
            '<td style="font-weight:600; font-size:12.5px; color:#f8fafc; white-space:nowrap;">' +
              escUserHtml(d.deviceName || '알 수 없는 기기') +
              '<div style="font-size:10px; color:var(--text-muted); font-family:monospace;">' + escUserHtml((d.deviceId || '').substring(0, 16)) + '...</div>' +
            '</td>' +
            '<td style="font-family:monospace; font-size:11.5px; color:#a78bfa; white-space:nowrap;">' + escUserHtml(d.lastIp || '-') + '</td>' +
            '<td style="font-size:11.5px; color:var(--text-muted); white-space:nowrap;">' + escUserHtml(lastSeenDate) + '</td>' +
            '<td style="text-align:center; white-space:nowrap;">' + statusBadge + '</td>' +
            '<td style="text-align:right; white-space:nowrap;">' +
              toggleActionBtn +
              '<button type="button" class="btn-action" style="background:#334155; color:#f87171; border:none; cursor:pointer; margin-left:4px;" data-dev-action="delete" data-dev-id="' + safeDevId + '">🗑️</button>' +
            '</td>' +
          '</tr>';
        }

        container.innerHTML = '<table class="data-table" style="margin:0;">' +
          '<thead>' +
            '<tr>' +
              '<th>기기명 / 식별자</th>' +
              '<th>접속 IP</th>' +
              '<th>최근 접속 (KST)</th>' +
              '<th style="text-align:center;">상태</th>' +
              '<th style="text-align:right;">제어</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>' + rowsHtml + '</tbody>' +
        '</table>';
      }

      document.addEventListener('click', function(e) {
        const devBtn = e.target.closest('[data-dev-action]');
        if (!devBtn) return;
        const action = devBtn.getAttribute('data-dev-action');
        const deviceId = devBtn.getAttribute('data-dev-id');
        if (!deviceId) return;

        if (action === 'block') toggleDeviceBlock(deviceId, true);
        else if (action === 'unblock') toggleDeviceBlock(deviceId, false);
        else if (action === 'delete') deleteDeviceItem(deviceId);
      });

      async function toggleDeviceBlock(deviceId, shouldBlock) {
        if (!activeSelectedUser) return;
        const endpoint = shouldBlock ? '/admin/users/devices/block' : '/admin/users/devices/unblock';
        
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/x-www-form-urlencoded',
              'Accept': 'application/json'
            },
            body: new URLSearchParams({
              folderName: activeSelectedUser.folderName,
              deviceId: deviceId
            })
          });

          if (!res.ok) throw new Error('서버 응답 오류 (HTTP ' + res.status + ')');
          const d = activeSelectedUser.devices.find(function(item) { return item.deviceId === deviceId; });
          if (d) d.status = shouldBlock ? 'blocked' : 'active';
          renderDevicesTableInModal();
          syncAdminUserRowDeviceBadge(activeSelectedUser);
        } catch (err) {
          alert('기기 상태 변경 실패: ' + err.message);
        }
      }

      async function deleteDeviceItem(deviceId) {
        if (!activeSelectedUser) return;
        if (!confirm('이 기기를 등록 목록에서 삭제하시겠습니까?\\n삭제 시 슬롯 1개가 즉시 확보됩니다.')) return;

        try {
          const res = await fetch('/admin/users/devices/delete', {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/x-www-form-urlencoded',
              'Accept': 'application/json'
            },
            body: new URLSearchParams({
              folderName: activeSelectedUser.folderName,
              deviceId: deviceId
            })
          });

          if (!res.ok) throw new Error('서버 응답 오류 (HTTP ' + res.status + ')');
          activeSelectedUser.devices = activeSelectedUser.devices.filter(function(item) { return item.deviceId !== deviceId; });
          renderDevicesTableInModal();
          syncAdminUserRowDeviceBadge(activeSelectedUser);
        } catch (err) {
          alert('기기 삭제 실패: ' + err.message);
        }
      }

      async function promptChangeMaxDevices() {
        if (!activeSelectedUser) return;
        const currentLimit = activeSelectedUser.maxDevices || 6;
        const input = prompt('최대 허용 기기 수를 입력하세요 (1 ~ 50대):', currentLimit);
        if (!input) return;

        const newLimit = parseInt(input.trim(), 10);
        if (isNaN(newLimit) || newLimit < 1 || newLimit > 50) {
          alert('1부터 50 사이의 숫자를 입력해 주세요.');
          return;
        }

        try {
          const res = await fetch('/admin/users/update-max-devices', {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/x-www-form-urlencoded',
              'Accept': 'application/json'
            },
            body: new URLSearchParams({
              folderName: activeSelectedUser.folderName,
              maxDevices: newLimit
            })
          });

          if (!res.ok) throw new Error('서버 응답 오류 (HTTP ' + res.status + ')');
          activeSelectedUser.maxDevices = newLimit;
          renderDevicesTableInModal();
          syncAdminUserRowDeviceBadge(activeSelectedUser);
          alert('✔ 최대 기기 한도가 ' + newLimit + '대로 변경되었습니다.');
        } catch (err) {
          alert('한도 변경 실패: ' + err.message);
        }
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
      function closeUserDevicesModal() {
        document.getElementById('modal-user-devices').classList.remove('active');
      }
    </script>
  `;
}