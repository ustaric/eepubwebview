/**
 * @file src/views/adminFolderModal.js
 * @description 관리자 제어 센터 간이 파일 탐색기 모달 다이얼로그 마크업 및 브라우저 클라이언트 JS 스크립트 전담 모듈
 * - 📁 [탐색기 모달 마크업] 상위 이동 버튼, 현재 경로 바, 폴더 목록 그리드, 선택/취소 푸터
 * - ⚡ [브라우저 인터랙션 스크립트] 탭 전환(localStorage 기억), 클립보드 복사, fs-tree AJAX 비동기 브라우징, test-folder 권한 실측
 */

/**
 * 간이 파일 탐색기 모달 마크업 및 브라우저 실행 스크립트 HTML 렌더러
 * @returns {string} 완성된 모달 및 <script> 태그 문자열
 */
export function renderFolderModalAndScript() {
  return `
  <!-- =========================================================================
       📁 간이 파일 탐색기 모달 다이얼로그 마크업
       ========================================================================= -->
  <div class="modal-overlay" id="folder-picker-modal">
    <div class="modal-box">
      <div class="modal-header">
        <h3>📁 서버 도서 폴더 선택</h3>
        <button type="button" class="modal-close-btn" onclick="closeFolderPicker()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="explorer-path-bar">
          <button type="button" class="btn-up" id="btn-path-up" onclick="goUpDirectory()">⬆️ 상위</button>
          <span class="explorer-path-text" id="explorer-current-path">/</span>
        </div>
        <div class="folder-list" id="explorer-folder-list">
          <!-- 자바스크립트로 동적 렌더링 -->
        </div>
        <div id="explorer-status-msg" style="margin-top: 10px; font-size: 12px; min-height: 18px;"></div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn-modal-cancel" onclick="closeFolderPicker()">취소</button>
        <button type="button" class="btn-modal-select" onclick="selectCurrentFolder()">✔ 현재 폴더로 지정</button>
      </div>
    </div>
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

    // =========================================================================
    // 📁 간이 파일 탐색기 모달 제어 및 권한 실측 스크립트
    // =========================================================================
    let currentNavPath = '/';
    let currentParentPath = null;

    function openFolderPicker() {
      const inputVal = document.getElementById('input-shared-books-dir').value.trim();
      const startPath = inputVal || '/home';
      document.getElementById('folder-picker-modal').classList.add('active');
      loadDirectoryTree(startPath);
    }

    function closeFolderPicker() {
      document.getElementById('folder-picker-modal').classList.remove('active');
    }

    async function loadDirectoryTree(targetPath) {
      const pathEl = document.getElementById('explorer-current-path');
      const listEl = document.getElementById('explorer-folder-list');
      const upBtn = document.getElementById('btn-path-up');
      const msgEl = document.getElementById('explorer-status-msg');

      pathEl.textContent = '조회 중...';
      listEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">폴더 목록을 불러오는 중...</div>';
      msgEl.textContent = '';

      try {
        const res = await fetch('/admin/fs-tree?path=' + encodeURIComponent(targetPath));
        if (!res.ok) throw new Error('폴더 접근 실패 (HTTP ' + res.status + ')');
        const data = await res.json();

        currentNavPath = data.currentPath || '/';
        currentParentPath = data.parentPath;
        pathEl.textContent = currentNavPath;
        upBtn.style.display = currentParentPath ? 'inline-block' : 'none';

        if (!data.directories || data.directories.length === 0) {
          listEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">하위 폴더가 없습니다.</div>';
          return;
        }

        let html = '';
        data.directories.forEach(d => {
          const accessClass = d.readable ? '' : 'no-access';
          const icon = d.readable ? '📁' : '🔒';
          const badge = d.readable ? '' : '<span style="font-size:10px;color:var(--danger);margin-left:auto;">(권한 없음)</span>';

          html += \`
            <div class="folder-item \${accessClass}" onclick="handleFolderClick('\${d.path.replace(/\\\\/g, '/')}', \${d.readable})">
              <span class="folder-name"><span>\${icon}</span> \${d.name}</span>
              \${badge}
            </div>
          \`;
        });
        listEl.innerHTML = html;

      } catch (err) {
        pathEl.textContent = targetPath;
        listEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--danger);font-size:12px;">폴더를 읽을 수 없습니다: ' + err.message + '</div>';
        if (targetPath !== '/') {
          setTimeout(() => loadDirectoryTree('/'), 1200);
        }
      }
    }

    function handleFolderClick(folderPath, isReadable) {
      if (!isReadable) {
        const msgEl = document.getElementById('explorer-status-msg');
        msgEl.innerHTML = '<span style="color:var(--danger);">⚠️ 이 폴더는 서버(Ubuntu) 읽기 권한이 없습니다.</span>';
        return;
      }
      loadDirectoryTree(folderPath);
    }

    function goUpDirectory() {
      if (currentParentPath) {
        loadDirectoryTree(currentParentPath);
      }
    }

    async function selectCurrentFolder() {
      const msgEl = document.getElementById('explorer-status-msg');
      msgEl.innerHTML = '<span style="color:#38bdf8;">🔄 서버 권한 실측 검증 중...</span>';

      try {
        const res = await fetch('/admin/test-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath: currentNavPath })
        });
        const result = await res.json();

        if (result.readable) {
          document.getElementById('input-shared-books-dir').value = currentNavPath;
          closeFolderPicker();
          alert('✔ 폴더가 선택되었습니다: ' + currentNavPath + '\\n하단의 [💾 설정 저장]을 눌러 영구 반영해 주세요.');
        } else {
          msgEl.innerHTML = '<span style="color:var(--danger);">❌ 지정 불가: ' + (result.error || '읽기 권한이 없습니다.') + '</span>';
        }
      } catch (err) {
        msgEl.innerHTML = '<span style="color:var(--danger);">❌ 검증 오류: ' + err.message + '</span>';
      }
    }
  </script>
  `;
}