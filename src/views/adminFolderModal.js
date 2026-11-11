/**
 * @file src/views/adminFolderModal.js
 * @description 관리자 제어 센터 간이 파일 탐색기 모달 다이얼로그 마크업 및 브라우저 클라이언트 JS 스크립트 전담 모듈
 * - 📁 [탐색기 모달 마크업] 상위 이동 버튼, 현재 경로 바, 폴더 목록 그리드, 선택/취소 푸터 (기본 display: none 강제 결속)
 * - 🎯 [범용 인풋 주입 지원] openFolderPicker(targetInputId) 지원으로 시스템 설정 및 공유 서재 등록 폼 어디든 경로 주입 가능
 * - ⚡ [원클릭 즉시 주입] 번거로운 alert() 확인 팝업을 제거하고 대상 인풋에 경로 즉시 주입 및 모달 자동 닫기
 * - 🔍 [fs-tree 비동기 브라우징 & 실측] /admin/fs-tree 및 /admin/test-folder 연동 안전한 디렉터리 탐색
 */

/**
 * 간이 파일 탐색기 모달 마크업 및 브라우저 실행 스크립트 HTML 렌더러
 * @returns {string} 완성된 모달 및 <script> 태그 문자열
 */
export function renderFolderModalAndScript() {
  return `
  <!-- =========================================================================
       📁 간이 파일 탐색기 모달 다이얼로그 마크업 (display: none !important 기본 은닉)
       ========================================================================= -->
  <style>
    #folder-picker-modal {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(4px);
      display: none !important;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      padding: 16px;
      box-sizing: border-box;
    }
    #folder-picker-modal.active {
      display: flex !important;
    }
    .explorer-path-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      background: #090d16;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 12px;
      margin-bottom: 12px;
    }
    .explorer-path-text {
      flex: 1;
      font-family: monospace;
      font-size: 13px;
      color: #38bdf8;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .btn-up {
      background: #334155;
      color: #f8fafc;
      border: none;
      border-radius: 6px;
      padding: 4px 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .folder-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 280px;
      overflow-y: auto;
      background: #090d16;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px;
    }
    .folder-item {
      display: flex;
      align-items: center;
      padding: 8px 10px;
      border-radius: 6px;
      background: #0f172a;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.15s;
    }
    .folder-item:hover {
      background: #1e293b;
      color: #38bdf8;
    }
    .folder-item.no-access {
      opacity: 0.5;
      cursor: not-allowed;
    }
  </style>

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
    function copyToClipboard(text, btnElement) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() {
          showCopiedEffect(btnElement);
        });
      } else {
        var tempInput = document.createElement('input');
        tempInput.value = text;
        document.body.appendChild(tempInput);
        tempInput.select();
        document.execCommand('copy');
        document.body.removeChild(tempInput);
        showCopiedEffect(btnElement);
      }
    }

    function showCopiedEffect(btn) {
      var originalText = btn.textContent;
      btn.textContent = '✔ 복사됨!';
      btn.classList.add('copied');
      setTimeout(function() {
        btn.textContent = originalText;
        btn.classList.remove('copied');
      }, 1800);
    }

    // =========================================================================
    // 📁 간이 파일 탐색기 모달 제어 및 범용 인풋 주입 스크립트
    // =========================================================================
    var currentNavPath = '/';
    var currentParentPath = null;
    var currentTargetInputId = 'input-shared-books-dir'; // 기본값

    function openFolderPicker(targetInputId) {
      currentTargetInputId = targetInputId || 'input-shared-books-dir';
      var targetInput = document.getElementById(currentTargetInputId);
      var inputVal = targetInput ? targetInput.value.trim() : '';
      var startPath = inputVal || '/home';
      document.getElementById('folder-picker-modal').classList.add('active');
      loadDirectoryTree(startPath);
    }

    function closeFolderPicker() {
      document.getElementById('folder-picker-modal').classList.remove('active');
    }

    async function loadDirectoryTree(targetPath) {
      var pathEl = document.getElementById('explorer-current-path');
      var listEl = document.getElementById('explorer-folder-list');
      var upBtn = document.getElementById('btn-path-up');
      var msgEl = document.getElementById('explorer-status-msg');

      pathEl.textContent = '조회 중...';
      listEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">폴더 목록을 불러오는 중...</div>';
      msgEl.textContent = '';

      try {
        var res = await fetch('/admin/fs-tree?path=' + encodeURIComponent(targetPath));
        if (!res.ok) throw new Error('폴더 접근 실패 (HTTP ' + res.status + ')');
        var data = await res.json();

        currentNavPath = data.currentPath || '/';
        currentParentPath = data.parentPath;
        pathEl.textContent = currentNavPath;
        upBtn.style.display = currentParentPath ? 'inline-block' : 'none';

        if (!data.directories || data.directories.length === 0) {
          listEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">하위 폴더가 없습니다.</div>';
          return;
        }

        var html = '';
        data.directories.forEach(function(d) {
          var accessClass = d.readable ? '' : 'no-access';
          var icon = d.readable ? '📁' : '🔒';
          var badge = d.readable ? '' : '<span style="font-size:10px;color:var(--danger);margin-left:auto;">(권한 없음)</span>';
          var safePath = d.path.replace(/\\\\/g, '/');

          html += '<div class="folder-item ' + accessClass + '" onclick="handleFolderClick(\\'' + safePath + '\\', ' + d.readable + ')">' +
                  '<span class="folder-name"><span>' + icon + '</span> ' + d.name + '</span>' +
                  badge +
                  '</div>';
        });
        listEl.innerHTML = html;

      } catch (err) {
        pathEl.textContent = targetPath;
        listEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--danger);font-size:12px;">폴더를 읽을 수 없습니다: ' + err.message + '</div>';
        if (targetPath !== '/') {
          setTimeout(function() { loadDirectoryTree('/'); }, 1200);
        }
      }
    }

    function handleFolderClick(folderPath, isReadable) {
      if (!isReadable) {
        var msgEl = document.getElementById('explorer-status-msg');
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
      var msgEl = document.getElementById('explorer-status-msg');
      msgEl.innerHTML = '<span style="color:#38bdf8;">🔄 서버 권한 실측 검증 중...</span>';

      try {
        var res = await fetch('/admin/test-folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderPath: currentNavPath })
        });
        var result = await res.json();

        if (result.readable) {
          var targetInput = document.getElementById(currentTargetInputId);
          if (targetInput) {
            targetInput.value = currentNavPath;
            // 🌟 [UX 개선] 번거로운 alert() 제거 및 인풋창 시각적 포커스 하이라이트
            targetInput.focus();
            targetInput.style.borderColor = '#38bdf8';
            setTimeout(function() { targetInput.style.borderColor = ''; }, 1500);
          }
          closeFolderPicker();
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