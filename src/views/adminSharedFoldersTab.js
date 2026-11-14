/**
 * @file src/views/adminSharedFoldersTab.js
 * @description 관리자 제어 센터 - 공유 서재 관리 탭 전담 뷰 컴포넌트
 * - 📁 다중 공유 서재 폴더 목록 렌더링 및 권한 상태 표시
 * - 👥 apiKeyManager.getUserListForAdmin() 직통 연동으로 사용자 메모 및 기기 최근 접속(lastSeen) 100% 정확 표출
 * - 📱 기기별 폴더 칩(Tag) 인터랙티브 토글 UI 및 HTML 이스케이프 방어 적용
 * - 🌐 전체 기기 허용/지정 기기 전용 원클릭 권한 제어 및 이중 등록 방지 락 탑재
 */

import fs from 'fs';
import { storageService } from '../storageService.js';
import { apiKeyManager } from '../apiKeyManager.js';

const SHARED_FOLDERS_CONFIG_FILE = './data/shared_folders.json';

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
 * 📂 다중 공유 폴더 설정 안전 조회 헬퍼
 * @param {Object} env 
 * @returns {{ enabled: boolean, folders: Array<{ id: string, name: string, path: string, enabled: boolean, allowedDevices: string[] }> }}
 */
export function getSharedFoldersConfig(env) {
  let cfg = { enabled: true, folders: [] };
  if (fs.existsSync(SHARED_FOLDERS_CONFIG_FILE)) {
    try {
      cfg = JSON.parse(fs.readFileSync(SHARED_FOLDERS_CONFIG_FILE, 'utf-8'));
    } catch (e) {}
  }
  const legacyDir = env.SHARED_BOOKS_DIR;
  if (cfg.folders.length === 0 && legacyDir && fs.existsSync(legacyDir)) {
    cfg.folders.push({
      id: 'default',
      name: '기본 공유 서재',
      path: legacyDir,
      enabled: true,
      allowedDevices: ['*']
    });
  }
  return cfg;
}

/**
 * 👥 등록된 모든 사용자 및 기기 목록 정밀 조회 헬퍼
 * @returns {Array<{ folderName: string, memo: string, devices: Array<any> }>}
 */
export function resolveAllUsersAndDevices() {
  const usersList = typeof apiKeyManager.getUserListForAdmin === 'function'
    ? apiKeyManager.getUserListForAdmin()
    : [];

  const result = [];
  const processedFolders = new Set();

  // 1차: apiKeyManager 공식 사용자 장부(api-keys.json) 기준 취합
  if (Array.isArray(usersList)) {
    usersList.forEach(u => {
      if (!u || !u.folderName) return;
      processedFolders.add(u.folderName);
      const devices = Array.isArray(u.devices)
        ? u.devices
        : (typeof apiKeyManager.getUserDevices === 'function' ? apiKeyManager.getUserDevices(u.folderName) : []);
      result.push({
        folderName: u.folderName,
        memo: u.memo || u.folderName,
        devices: devices || []
      });
    });
  }

  // 2차: data/users 디렉터리 내 미등록 레거시 물리 폴더 보조 스캔
  if (fs.existsSync('./data/users')) {
    try {
      const dirs = fs.readdirSync('./data/users');
      dirs.forEach(dirName => {
        if (!processedFolders.has(dirName) && !dirName.startsWith('.')) {
          const devices = typeof apiKeyManager.getUserDevices === 'function' ? apiKeyManager.getUserDevices(dirName) : [];
          result.push({
            folderName: dirName,
            memo: dirName,
            devices: devices || []
          });
        }
      });
    } catch (e) {}
  }

  return result;
}

/**
 * 📁 공유 서재 다중 폴더 및 기기별 폴더 칩(Tag) 권한 관리 탭 HTML 렌더러
 * @param {Object} env 
 * @returns {string}
 */
export function renderSharedFoldersTab(env) {
  const cfg = getSharedFoldersConfig(env);
  const usersWithDevices = resolveAllUsersAndDevices();

  // 1. 등록된 공유 폴더 카드 목록 HTML
  const foldersListHtml = cfg.folders.map((f) => {
    const perm = storageService.testDirectoryPermissions(f.path);
    const badgeHtml = perm.readable
      ? '<span class="badge badge-success">정상 (읽기 가능)</span>'
      : `<span class="badge badge-error">접근 오류 (${escapeHtml(perm.error || '권한 부족')})</span>`;

    const isGlobal = Array.isArray(f.allowedDevices) && f.allowedDevices.includes('*');
    const safeId = escapeHtml(f.id);
    const safeName = escapeHtml(f.name);
    const safePath = escapeHtml(f.path);

    return `
      <div style="background: #0f172a; border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; gap: 12px;">
        <div style="flex: 1; min-width: 0;">
          <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 4px;">
            <strong style="font-size: 14.5px; color: #38bdf8;">📁 ${safeName}</strong>
            ${badgeHtml}
            <button type="button" class="folder-chip ${isGlobal ? 'active' : ''}" 
                    style="padding: 2px 10px; font-size: 11px;"
                    onclick="toggleFolderGlobalAccess('${safeId}', this)"
                    title="클릭하여 전체 기기 접근 허용/차단 토글">
              <span>${isGlobal ? '🌐 전체 허용 중' : '🔒 지정 기기만'}</span>
            </button>
          </div>
          <div style="font-size: 12px; color: var(--text-muted); font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            ${safePath}
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
          <label class="switch" title="이 폴더 활성화/비활성화">
            <input type="checkbox" ${f.enabled ? 'checked' : ''} onchange="toggleFolderEnabled('${safeId}', this.checked)">
            <span class="slider"></span>
          </label>
          <button type="button" class="btn-action btn-delete" style="padding: 6px 10px;" onclick="deleteSharedFolder('${safeId}')" title="폴더 삭제">삭제</button>
        </div>
      </div>
    `;
  }).join('') || '<div style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 20px;">등록된 공유 폴더가 없습니다. 아래 폼에서 폴더를 추가해 주세요.</div>';

  // 2. 기기별 폴더 칩(Tag) 권한 매핑 섹션 HTML
  let totalDeviceCount = 0;
  usersWithDevices.forEach(u => { totalDeviceCount += (u.devices?.length || 0); });

  let deviceChipsSectionHtml = '';

  if (usersWithDevices.length === 0 && totalDeviceCount === 0) {
    deviceChipsSectionHtml = `
      <div style="background: #090d16; border: 1px dashed var(--border); border-radius: 8px; padding: 18px; text-align: center;">
        <span style="font-size: 24px; display: block; margin-bottom: 6px;">📱</span>
        <div style="color: #f8fafc; font-size: 13.5px; font-weight: 600; margin-bottom: 4px;">아직 연결된 기기가 없습니다</div>
        <div style="color: var(--text-muted); font-size: 12px; line-height: 1.5;">
          현재 모든 폴더는 상단의 <strong style="color:#38bdf8;">[🌐 전체 허용 중]</strong> 상태로 웹 뷰어에서 바로 이용하실 수 있습니다.<br>
          스마트폰이나 태블릿에서 <strong>[🔢 연결 번호로 로그인]</strong>을 진행하시면 여기에 기기별 맞춤 권한 칩이 자동으로 표출됩니다.
        </div>
      </div>
    `;
  } else {
    deviceChipsSectionHtml = usersWithDevices.map(u => {
      const devices = u.devices || [];
      const safeUserMemo = escapeHtml(u.memo);
      const safeUserFolder = escapeHtml(u.folderName);

      const devicesHtml = devices.length === 0
        ? '<div style="font-size: 12px; color: var(--text-muted); padding: 6px 0;">(연결된 기기 대기 중 - 6자리 번호 로그인 시 자동 감지)</div>'
        : devices.map(d => {
            const safeDevId = escapeHtml(d.deviceId);
            const safeDevName = escapeHtml(d.deviceName || d.deviceId);
            const seenAt = d.lastSeen || d.lastActiveAt || null;

            const chipsHtml = cfg.folders.map(f => {
              const allowedList = Array.isArray(f.allowedDevices) ? f.allowedDevices : [];
              const isAllowed = allowedList.includes('*') || allowedList.includes(d.deviceId);
              const chipClass = isAllowed ? 'folder-chip active' : 'folder-chip';
              const safeFolderId = escapeHtml(f.id);
              const safeFolderName = escapeHtml(f.name);
              return `
                <button type="button" class="${chipClass}" 
                        data-folder-id="${safeFolderId}"
                        data-device-id="${safeDevId}"
                        onclick="toggleDeviceFolderAccess('${safeFolderId}', '${safeDevId}', this)"
                        title="클릭하여 '${safeDevName}' 기기에 '${safeFolderName}' 접근 권한 토글">
                  <span>${isAllowed ? '✔' : '+'}</span>
                  <span>📁 ${safeFolderName}</span>
                </button>
              `;
            }).join('');

            return `
              <div style="background: #090d16; border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; padding: 10px 12px; margin-top: 8px;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                  <span style="font-size: 13px; font-weight: 600; color: #f8fafc;">📱 ${safeDevName}</span>
                  <span style="font-size: 11px; color: var(--text-muted);">최근: ${seenAt ? new Date(seenAt).toLocaleString('ko-KR') : '기록 없음'}</span>
                </div>
                <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                  ${chipsHtml || '<span style="font-size: 11.5px; color: var(--text-muted);">부여할 수 있는 공유 폴더가 없습니다.</span>'}
                </div>
              </div>
            `;
          }).join('');

      return `
        <div style="background: #0f172a; border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin-bottom: 14px;">
          <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 8px;">
            <strong style="font-size: 14px; color: #38bdf8;">👤 ${safeUserMemo}</strong>
            <span style="font-size: 12px; color: var(--text-muted); font-family: monospace;">(${safeUserFolder})</span>
          </div>
          ${devicesHtml}
        </div>
      `;
    }).join('');
  }

  return `
    <!-- 1. 전체 기능 On/Off 스위치 카드 -->
    <div class="card">
      <div class="toggle-row" style="margin-bottom: 0;">
        <div class="toggle-info">
          <h4 style="color: #38bdf8; font-size: 15px;">📚 공유 도서 라이브러리 전체 기능 활성화</h4>
          <p>비활성화 시 모든 사용자의 웹 뷰어에서 [공유 서재] 버튼이 숨겨지고 외부 도서 접근이 즉각 차단됩니다.</p>
        </div>
        <label class="switch">
          <input type="checkbox" id="toggle-shared-lib-master" ${cfg.enabled ? 'checked' : ''} onchange="toggleMasterSharedLibrary(this.checked)">
          <span class="slider"></span>
        </label>
      </div>
    </div>

    <!-- 2. 등록된 공유 폴더 목록 카드 -->
    <div class="card">
      <div class="section-title">
        <span>📁 등록된 공유 도서 폴더 (${cfg.folders.length}개)</span>
        <span style="font-size: 12px; color: var(--text-muted);">서버 디스크의 실제 폴더를 연결합니다</span>
      </div>
      ${foldersListHtml}

      <!-- 새 폴더 추가 폼 -->
      <div style="background: #090d16; border: 1px dashed var(--border); border-radius: 10px; padding: 16px; margin-top: 14px;">
        <h4 style="margin: 0 0 12px 0; font-size: 13.5px; color: #38bdf8;">➕ 새 공유 도서 폴더 등록</h4>
        <div class="form-row" style="margin-bottom: 10px;">
          <div class="form-group" style="flex: 1;">
            <label>폴더 표시 이름</label>
            <input type="text" id="new-folder-name" placeholder="예: 판타지 소설 (2024년)" autocomplete="off">
          </div>
          <div class="form-group" style="flex: 2;">
            <label>서버 실제 절대 경로 (우분투 /home/ubuntu/...)</label>
            <div class="input-btn-group">
              <input type="text" id="new-folder-path" placeholder="/home/ubuntu/userbook" autocomplete="off">
              <button type="button" class="btn-browse" onclick="openFolderPicker('new-folder-path')">찾아보기</button>
            </div>
          </div>
        </div>
        <button type="button" id="btn-add-shared-folder" class="btn-submit" style="background: #0d9488; height: 42px; font-size: 14px; padding: 0 16px;" onclick="addNewSharedFolder()">
          ➕ 공유 폴더 등록
        </button>
      </div>
    </div>

    <!-- 3. 기기별 폴더 칩(Tag) 권한 매핑 카드 -->
    <div class="card">
      <div class="section-title">
        <span>📱 기기별 폴더 칩(Tag) 접근 권한 설정</span>
        <span style="font-size: 12px; color: #a78bfa;">은닉화(Stealth): 권한 없는 폴더는 클라이언트에 아예 안 뜸</span>
      </div>
      <p style="font-size: 12.5px; color: var(--text-muted); margin: 0 0 14px 0; line-height: 1.5;">
        각 기기 카드에 표출된 <strong>폴더 칩을 클릭</strong>하면 권한이 즉시 부여/회수됩니다.<br>
        <span style="color:#38bdf8; font-weight:600;">[✔ 칩 활성]</span> 상태인 폴더만 해당 기기의 웹 뷰어에서 깔끔하게 노출됩니다.
      </p>
      ${deviceChipsSectionHtml}
    </div>

    <script>
      // -----------------------------------------------------------------------
      // 📁 [공유 서재 관리 REST API 비동기 제어 스크립트]
      // -----------------------------------------------------------------------
      async function fetchSharedFoldersConfig() {
        var res = await fetch('/api/storage/admin/shared-folders');
        var data = await res.json();
        return data.config || { enabled: true, folders: [] };
      }

      async function saveSharedFoldersConfig(newConfig) {
        var res = await fetch('/api/storage/admin/shared-folders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newConfig)
        });
        return res.ok;
      }

      async function toggleMasterSharedLibrary(isEnabled) {
        try {
          var cfg = await fetchSharedFoldersConfig();
          cfg.enabled = isEnabled;
          var ok = await saveSharedFoldersConfig(cfg);
          if (ok) {
            showFloatingToast(isEnabled ? '공유 라이브러리가 활성화되었습니다.' : '공유 라이브러리가 비활성화되었습니다.');
          }
        } catch (e) {
          alert('설정 저장 실패: ' + e.message);
        }
      }

      async function toggleFolderEnabled(folderId, isEnabled) {
        try {
          var cfg = await fetchSharedFoldersConfig();
          var f = cfg.folders.find(function(x) { return x.id === folderId; });
          if (f) {
            f.enabled = isEnabled;
            await saveSharedFoldersConfig(cfg);
            showFloatingToast("'" + f.name + "' 상태가 변경되었습니다.");
          }
        } catch (e) {
          alert('폴더 상태 변경 실패: ' + e.message);
        }
      }

      // 🌟 [개선] 블로킹 alert() 제거 및 즉시 새로고침 연계 (이중 제출 방지 락 탑재)
      async function addNewSharedFolder() {
        var nameInput = document.getElementById('new-folder-name');
        var pathInput = document.getElementById('new-folder-path');
        var addBtn = document.getElementById('btn-add-shared-folder');
        var name = nameInput ? nameInput.value.trim() : '';
        var folderPath = pathInput ? pathInput.value.trim() : '';

        if (!name || !folderPath) {
          alert('폴더 표시 이름과 서버 실제 경로를 모두 입력해 주세요.');
          return;
        }

        if (addBtn) {
          addBtn.disabled = true;
          addBtn.textContent = '⏳ 등록 중...';
        }

        try {
          var cfg = await fetchSharedFoldersConfig();
          var newId = 'folder_' + Date.now().toString(36);
          cfg.folders.push({
            id: newId,
            name: name,
            path: folderPath,
            enabled: true,
            allowedDevices: ['*']
          });

          var ok = await saveSharedFoldersConfig(cfg);
          if (ok) {
            window.location.reload();
          } else {
            alert('폴더 등록 요청이 실패했습니다.');
            if (addBtn) {
              addBtn.disabled = false;
              addBtn.textContent = '➕ 공유 폴더 등록';
            }
          }
        } catch (e) {
          alert('폴더 추가 실패: ' + e.message);
          if (addBtn) {
            addBtn.disabled = false;
            addBtn.textContent = '➕ 공유 폴더 등록';
          }
        }
      }

      async function deleteSharedFolder(folderId) {
        if (!confirm('이 공유 폴더를 목록에서 삭제하시겠습니까?\\n(실제 디스크 파일은 삭제되지 않습니다)')) return;
        try {
          var cfg = await fetchSharedFoldersConfig();
          cfg.folders = cfg.folders.filter(function(x) { return x.id !== folderId; });
          var ok = await saveSharedFoldersConfig(cfg);
          if (ok) {
            window.location.reload();
          }
        } catch (e) {
          alert('폴더 삭제 실패: ' + e.message);
        }
      }

      async function toggleFolderGlobalAccess(folderId, btnEl) {
        try {
          var cfg = await fetchSharedFoldersConfig();
          var folder = cfg.folders.find(function(x) { return x.id === folderId; });
          if (!folder) return;

          var isCurrentlyGlobal = folder.allowedDevices.includes('*');
          if (isCurrentlyGlobal) {
            folder.allowedDevices = [];
          } else {
            folder.allowedDevices = ['*'];
          }

          var ok = await saveSharedFoldersConfig(cfg);
          if (ok) {
            var willBeGlobal = !isCurrentlyGlobal;
            if (willBeGlobal) btnEl.classList.add('active');
            else btnEl.classList.remove('active');
            var textSpan = btnEl.querySelector('span');
            if (textSpan) textSpan.textContent = willBeGlobal ? '🌐 전체 허용 중' : '🔒 지정 기기만';
            showFloatingToast(willBeGlobal ? ("'" + folder.name + "' 전체 기기 접근이 허용되었습니다.") : ("'" + folder.name + "' 지정 기기 전용으로 변경되었습니다."));
            setTimeout(function() { window.location.reload(); }, 600);
          }
        } catch (e) {
          alert('설정 변경 실패: ' + e.message);
        }
      }

      async function toggleDeviceFolderAccess(folderId, deviceId, chipEl) {
        try {
          var cfg = await fetchSharedFoldersConfig();
          var folder = cfg.folders.find(function(x) { return x.id === folderId; });
          if (!folder) return;

          if (folder.allowedDevices.includes('*')) {
            folder.allowedDevices = [];
            var allChips = document.querySelectorAll('.folder-chip[data-device-id]');
            for (var i = 0; i < allChips.length; i++) {
              var devId = allChips[i].getAttribute('data-device-id');
              if (devId && !folder.allowedDevices.includes(devId)) {
                folder.allowedDevices.push(devId);
              }
            }
          }

          var idx = folder.allowedDevices.indexOf(deviceId);
          var willAllow = idx === -1;

          if (willAllow) {
            folder.allowedDevices.push(deviceId);
          } else {
            folder.allowedDevices.splice(idx, 1);
          }

          var ok = await saveSharedFoldersConfig(cfg);
          if (ok) {
            if (willAllow) {
              chipEl.classList.add('active');
            } else {
              chipEl.classList.remove('active');
            }
            var iconSpan = chipEl.querySelector('span:first-child');
            if (iconSpan) iconSpan.textContent = willAllow ? '✔' : '+';
            showFloatingToast(willAllow ? ("'" + folder.name + "' 접근 권한이 부여되었습니다.") : ("'" + folder.name + "' 접근 권한이 회수되었습니다."));
          }
        } catch (e) {
          alert('권한 변경 실패: ' + e.message);
        }
      }
    </script>
  `;
}