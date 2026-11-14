/**
 * @file src/views/adminUserLibraryModal.js
 * @description 관리자 제어 센터 - 사용자 서재(도서 목록 · 오류/고아 파일 · 개별/전체 삭제 · CFI 초기화 · 묘비 관리) 모달 컴포넌트
 * - 📚 [파일 실측 시각화] books/ · archive/ 위치, .json/.epub/표지 보유 현황 및 6대 이상 징후 배지 표출
 * - 🗑️ [정밀 삭제 & CFI 초기화] 전체 삭제(선택적 묘비 등록), CFI/진도율 초기화, 메타/EPUB/표지/고아파일 개별 삭제 지원
 * - 🪦 [묘비 핀포인트 해제] deleted-books.json 목록 조회·검색 및 특정 도서 묘비만 선택 해제
 * - 🛡️ [속성 기반 이벤트 위임] data-* 속성 + 컨테이너 클릭 위임으로 특수문자/대괄호/따옴표 포함 도서 ID 100% 안전 처리
 */

/**
 * 사용자 서재(도서/오류파일/묘비) 관리 모달 HTML 및 브라우저 제어 스크립트를 반환합니다.
 * @returns {string} 모달 마크업 및 <script> 문자열
 */
export function renderUserLibraryModalAndScript() {
  return `
    <!-- 📚 사용자 서재 도서 · 오류파일 · 묘비 관리 모달 -->
    <div class="modal-overlay" id="modal-user-library">
      <div class="modal-box" style="max-width: 780px; width: 100%;">
        <div class="modal-header">
          <h3 style="color: #38bdf8; display: flex; align-items: center; gap: 8px;">
            <span>📚</span> 사용자 서재 & 묘비 관리
          </h3>
          <button type="button" class="modal-close-btn" onclick="closeUserLibraryModal()">&times;</button>
        </div>

        <div class="modal-body">
          <!-- 대상 사용자 및 요약 바 -->
          <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 12px; background: #0f172a; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border);">
            <div>
              <span style="font-size: 12.5px; color: var(--text-muted);">대상 서재:</span>
              <strong id="lib-modal-user-label" style="color: #38bdf8; font-size: 13.5px; margin-left: 4px;"></strong>
            </div>
            <div id="lib-modal-summary-pills" style="display: flex; flex-wrap: wrap; gap: 6px; font-size: 11.5px;"></div>
          </div>

          <!-- 모달 내부 탭 전환 -->
          <div style="display: flex; gap: 6px; margin-bottom: 12px;">
            <button type="button" id="lib-tab-btn-books" class="folder-chip active" style="padding: 7px 14px; font-size: 12.5px;" onclick="switchUserLibraryModalTab('books')">
              📚 도서 & 파일 목록
            </button>
            <button type="button" id="lib-tab-btn-tombstones" class="folder-chip" style="padding: 7px 14px; font-size: 12.5px;" onclick="switchUserLibraryModalTab('tombstones')">
              🪦 삭제 묘비 (deleted-books.json)
            </button>
          </div>

          <!-- [탭 1] 도서 & 오류 파일 목록 -->
          <div id="lib-tab-panel-books">
            <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; margin-bottom: 10px;">
              <input type="text" id="lib-search-input" placeholder="도서 제목 또는 bookId 검색..." style="flex: 1; min-width: 200px; padding: 8px 10px; font-size: 12.5px;" oninput="renderUserLibraryBooks()">
              <div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center; font-size: 12px; color: var(--text-muted);">
                <label style="display: inline-flex; align-items: center; gap: 5px; margin: 0; cursor: pointer; color: #fbbf24;">
                  <input type="checkbox" id="lib-only-anomalies-cb" onchange="renderUserLibraryBooks()">
                  <span>⚠️ 오류/고아 파일만 보기</span>
                </label>
                <label style="display: inline-flex; align-items: center; gap: 5px; margin: 0; cursor: pointer; color: #f87171;" title="체크 시 전체 삭제할 때 deleted-books.json 묘비에도 등록하여 연결된 다른 기기에서도 책을 지웁니다.">
                  <input type="checkbox" id="lib-add-tombstone-cb">
                  <span>전체삭제 시 기기 동기화 묘비 등록</span>
                </label>
              </div>
            </div>

            <div id="lib-books-container" style="max-height: 380px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; background: #090d16; padding: 8px;">
              <div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 12.5px;">불러오는 중...</div>
            </div>
          </div>

          <!-- [탭 2] 삭제 묘비 목록 -->
          <div id="lib-tab-panel-tombstones" style="display: none;">
            <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 10px;">
              <input type="text" id="lib-tombstone-search-input" placeholder="묘비 도서 제목 또는 bookId 검색..." style="flex: 1; padding: 8px 10px; font-size: 12.5px;" oninput="renderUserLibraryTombstones()">
            </div>
            <div id="lib-tombstones-container" style="max-height: 380px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; background: #090d16; padding: 8px;">
              <div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 12.5px;">불러오는 중...</div>
            </div>
          </div>
        </div>

        <div class="modal-footer" style="justify-content: space-between;">
          <span style="font-size: 11.5px; color: var(--text-muted);">
            ※ 표지 삭제·CFI 초기화는 서버 수정 시각을 갱신해 재접속 시 반영되며, EPUB 재업로드 유도는 메타(.json) 삭제를 권장합니다.
          </span>
          <button type="button" class="btn-modal-select" onclick="closeUserLibraryModal()">닫기</button>
        </div>
      </div>
    </div>

    <script>
      (function() {
        var libState = {
          folderName: '',
          memo: '',
          data: null,
          activeTab: 'books'
        };

        var ANOMALY_LABELS = {
          JSON_CORRUPTED: '🚨 JSON 파손',
          JSON_MISSING: '⚠️ 메타(.json) 없음',
          EPUB_MISSING: '⚠️ EPUB 누락',
          ZERO_BYTE_EPUB: '🚨 0KB EPUB',
          DUPLICATE_LOCATION: '⚠️ books/archive 중복',
          ORPHAN_COVER_REF: '⚠️ 표지 실물 없음'
        };

        function escHtml(str) {
          return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        }

        function formatBytes(bytes) {
          var n = Number(bytes || 0);
          if (n < 1024) return n + ' B';
          if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
          return (n / (1024 * 1024)).toFixed(2) + ' MB';
        }

        window.openUserLibraryModal = function(folderName, memo) {
          libState.folderName = folderName;
          libState.memo = memo || folderName;
          libState.data = null;

          var labelEl = document.getElementById('lib-modal-user-label');
          if (labelEl) labelEl.textContent = libState.memo + ' (' + libState.folderName + ')';

          var searchEl = document.getElementById('lib-search-input');
          if (searchEl) searchEl.value = '';
          var tombSearchEl = document.getElementById('lib-tombstone-search-input');
          if (tombSearchEl) tombSearchEl.value = '';
          var anomCb = document.getElementById('lib-only-anomalies-cb');
          if (anomCb) anomCb.checked = false;

          window.switchUserLibraryModalTab('books');
          var modalEl = document.getElementById('modal-user-library');
          if (modalEl) modalEl.classList.add('active');

          loadUserLibraryData();
        };

        window.closeUserLibraryModal = function() {
          var modalEl = document.getElementById('modal-user-library');
          if (modalEl) modalEl.classList.remove('active');
        };

        window.switchUserLibraryModalTab = function(tab) {
          libState.activeTab = tab;
          var btnBooks = document.getElementById('lib-tab-btn-books');
          var btnTomb = document.getElementById('lib-tab-btn-tombstones');
          var panelBooks = document.getElementById('lib-tab-panel-books');
          var panelTomb = document.getElementById('lib-tab-panel-tombstones');

          if (btnBooks) btnBooks.classList.toggle('active', tab === 'books');
          if (btnTomb) btnTomb.classList.toggle('active', tab === 'tombstones');
          if (panelBooks) panelBooks.style.display = tab === 'books' ? 'block' : 'none';
          if (panelTomb) panelTomb.style.display = tab === 'tombstones' ? 'block' : 'none';
        };

        async function loadUserLibraryData() {
          var booksBox = document.getElementById('lib-books-container');
          var tombBox = document.getElementById('lib-tombstones-container');
          var pillsEl = document.getElementById('lib-modal-summary-pills');
          if (booksBox) booksBox.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:12.5px;">⏳ 서재 파일 실측 중...</div>';
          if (tombBox) tombBox.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:12.5px;">⏳ 묘비 목록 조회 중...</div>';

          try {
            var res = await fetch('/admin/users/library?folderName=' + encodeURIComponent(libState.folderName));
            var data = await res.json();
            if (!res.ok || !data.ok) {
              throw new Error(data.error || ('HTTP ' + res.status));
            }
            libState.data = data;

            var s = data.summary || {};
            if (pillsEl) {
              pillsEl.innerHTML =
                '<span class="badge badge-info">활성 ' + (s.activeCount || 0) + '권</span>' +
                '<span class="badge badge-warning">보관 ' + (s.archivedCount || 0) + '권</span>' +
                '<span class="badge ' + ((s.anomalyCount || 0) + (s.orphanFileCount || 0) > 0 ? 'badge-error' : 'badge-success') + '">이상 ' + ((s.anomalyCount || 0) + (s.orphanFileCount || 0)) + '건</span>' +
                '<span class="badge" style="background:rgba(148,163,184,0.15);color:#cbd5e1;border:1px solid rgba(148,163,184,0.3);">묘비 ' + (s.tombstoneCount || 0) + '개</span>';
            }

            var btnTomb = document.getElementById('lib-tab-btn-tombstones');
            if (btnTomb) btnTomb.textContent = '🪦 삭제 묘비 (' + (s.tombstoneCount || 0) + ')';

            if (typeof window.updateAdminUserRowBookCount === 'function') {
              window.updateAdminUserRowBookCount(libState.folderName, s);
            }

            window.renderUserLibraryBooks();
            window.renderUserLibraryTombstones();
          } catch (err) {
            if (booksBox) {
              booksBox.innerHTML = '<div style="padding:24px;text-align:center;color:#f87171;font-size:12.5px;">❌ 조회 실패: ' + escHtml(err.message) + '</div>';
            }
            if (tombBox) {
              tombBox.innerHTML = '<div style="padding:24px;text-align:center;color:#f87171;font-size:12.5px;">❌ 조회 실패: ' + escHtml(err.message) + '</div>';
            }
          }
        }

        window.renderUserLibraryBooks = function() {
          var container = document.getElementById('lib-books-container');
          if (!container || !libState.data) return;

          var q = (document.getElementById('lib-search-input')?.value || '').trim().toLowerCase();
          var onlyAnomalies = Boolean(document.getElementById('lib-only-anomalies-cb')?.checked);

          var orphanFiles = libState.data.orphanFiles || [];
          var filteredOrphans = orphanFiles.filter(function(f) {
            return !q || (f.fileName || '').toLowerCase().indexOf(q) !== -1;
          });

          var books = libState.data.books || [];
          var filteredBooks = books.filter(function(b) {
            if (onlyAnomalies && (!b.anomalies || b.anomalies.length === 0)) return false;
            if (!q) return true;
            return (b.title || '').toLowerCase().indexOf(q) !== -1 || (b.bookId || '').toLowerCase().indexOf(q) !== -1;
          });

          var html = '';

          if (filteredOrphans.length > 0) {
            html += '<div style="margin-bottom:10px;padding:8px 10px;border-radius:8px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);">' +
              '<div style="font-size:12px;font-weight:700;color:#f87171;margin-bottom:6px;">🚨 규칙 외 잔여/임시 파일 (' + filteredOrphans.length + '건)</div>';

            filteredOrphans.forEach(function(of) {
              html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;background:#0f172a;border-radius:6px;margin-top:4px;">' +
                '<div style="min-width:0;flex:1;">' +
                  '<div style="font-family:monospace;font-size:12px;color:#f8fafc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml(of.fileName) + '</div>' +
                  '<div style="font-size:11px;color:var(--text-muted);">폴더: ' + escHtml(of.location) + '/ · ' + formatBytes(of.sizeBytes) + ' · ' + escHtml(of.reason) + '</div>' +
                '</div>' +
                '<button type="button" class="btn-action btn-delete" data-lib-action="delete-single-file" data-file-name="' + escHtml(of.fileName) + '" data-location="' + escHtml(of.location) + '">🧹 파일 삭제</button>' +
              '</div>';
            });
            html += '</div>';
          }

          if (filteredBooks.length === 0 && filteredOrphans.length === 0) {
            container.innerHTML = '<div style="padding:28px;text-align:center;color:var(--text-muted);font-size:12.5px;">조건에 맞는 도서 또는 파일이 없습니다.</div>';
            return;
          }

          filteredBooks.forEach(function(b) {
            var locBadge = b.location === 'both'
              ? '<span class="status-pill status-429">⚠️ books+archive 중복</span>'
              : (b.location === 'archive'
                ? '<span class="status-pill" style="background:rgba(167,139,250,0.15);color:#c4b5fd;border:1px solid rgba(167,139,250,0.3);">보관함</span>'
                : '<span class="status-pill status-200">활성서재</span>');

            var anomalyBadges = (b.anomalies || []).map(function(code) {
              return '<span class="status-pill status-403" style="font-size:10.5px;">' + escHtml(ANOMALY_LABELS[code] || code) + '</span>';
            }).join(' ');

            var epubTotalBytes = (b.epubFiles || []).reduce(function(s, f) { return s + f.sizeBytes; }, 0);
            var jsonTag = b.jsonFiles && b.jsonFiles.length > 0
              ? (b.jsonFiles.some(function(j) { return j.corrupted; }) ? '📄 JSON 파손' : '📄 JSON (' + escHtml(b.progress) + ')')
              : '📄 JSON 없음';
            var epubTag = b.epubFiles && b.epubFiles.length > 0
              ? '📦 EPUB (' + formatBytes(epubTotalBytes) + ')'
              : (b.isRecordOnly ? '📦 기록전용' : '📦 EPUB 없음');
            var coverTag = '🖼️ 표지 ' + (b.coverFiles ? b.coverFiles.length : 0) + '개';

            var hasValidJson = b.jsonFiles && b.jsonFiles.length > 0 && (!b.anomalies || b.anomalies.indexOf('JSON_CORRUPTED') === -1);
            var hasAnyJson = b.jsonFiles && b.jsonFiles.length > 0;
            var hasAnyEpub = b.epubFiles && b.epubFiles.length > 0;
            var hasAnyCover = (b.coverFiles && b.coverFiles.length > 0) || Boolean(b.cloudCoverFileName);

            html += '<div style="background:#0f172a;border:1px solid ' + ((b.anomalies && b.anomalies.length > 0) ? 'rgba(239,68,68,0.45)' : 'var(--border)') + ';border-radius:8px;padding:10px 12px;margin-bottom:8px;">' +
              '<div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px;">' +
                '<div style="min-width:0;flex:1;">' +
                  '<div style="font-size:13px;font-weight:700;color:#f8fafc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escHtml(b.title) + '">' + escHtml(b.title) + '</div>' +
                  '<div style="font-family:monospace;font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escHtml(b.bookId) + '">' + escHtml(b.bookId) + '</div>' +
                '</div>' +
                '<div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;">' + locBadge + ' ' + anomalyBadges + '</div>' +
              '</div>' +
              '<div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.05);">' +
                '<div style="display:flex;flex-wrap:wrap;gap:6px;font-size:11px;color:#cbd5e1;">' +
                  '<span style="background:#1e293b;padding:2px 7px;border-radius:4px;">' + jsonTag + '</span>' +
                  '<span style="background:#1e293b;padding:2px 7px;border-radius:4px;">' + epubTag + '</span>' +
                  '<span style="background:#1e293b;padding:2px 7px;border-radius:4px;">' + coverTag + '</span>' +
                '</div>' +
                '<div style="display:flex;flex-wrap:wrap;gap:4px;">' +
                  (hasValidJson ? '<button type="button" class="btn-action" style="background:#334155;color:#38bdf8;border:none;cursor:pointer;" data-lib-action="reset-cfi" data-book-id="' + escHtml(b.bookId) + '" data-title="' + escHtml(b.title) + '">🔄 CFI초기화</button>' : '') +
                  (hasAnyJson ? '<button type="button" class="btn-action" style="background:#334155;color:#fbbf24;border:none;cursor:pointer;" data-lib-action="delete-json" data-book-id="' + escHtml(b.bookId) + '" data-title="' + escHtml(b.title) + '">📄 메타만</button>' : '') +
                  (hasAnyEpub ? '<button type="button" class="btn-action" style="background:#334155;color:#fb923c;border:none;cursor:pointer;" data-lib-action="delete-epub" data-book-id="' + escHtml(b.bookId) + '" data-title="' + escHtml(b.title) + '">📦 EPUB만</button>' : '') +
                  (hasAnyCover ? '<button type="button" class="btn-action" style="background:#334155;color:#c084fc;border:none;cursor:pointer;" data-lib-action="delete-covers" data-book-id="' + escHtml(b.bookId) + '" data-title="' + escHtml(b.title) + '">🖼️ 표지만</button>' : '') +
                  '<button type="button" class="btn-action btn-delete" data-lib-action="delete-all" data-book-id="' + escHtml(b.bookId) + '" data-title="' + escHtml(b.title) + '">💥 전체삭제</button>' +
                '</div>' +
              '</div>' +
            '</div>';
          });

          container.innerHTML = html;
        };

        window.renderUserLibraryTombstones = function() {
          var container = document.getElementById('lib-tombstones-container');
          if (!container || !libState.data) return;

          var q = (document.getElementById('lib-tombstone-search-input')?.value || '').trim().toLowerCase();
          var tombstones = libState.data.tombstones || [];
          var filtered = tombstones.filter(function(t) {
            if (!q) return true;
            return (t.title || '').toLowerCase().indexOf(q) !== -1 || (t.bookId || '').toLowerCase().indexOf(q) !== -1;
          });

          if (filtered.length === 0) {
            container.innerHTML = '<div style="padding:28px;text-align:center;color:var(--text-muted);font-size:12.5px;">등록된 삭제 묘비가 없습니다.</div>';
            return;
          }

          var html = '';
          filtered.forEach(function(t) {
            var dateStr = t.deletedAt ? new Date(t.deletedAt).toLocaleString('ko-KR') : '-';
            html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;background:#0f172a;border:1px solid var(--border);border-radius:8px;padding:9px 12px;margin-bottom:6px;">' +
              '<div style="min-width:0;flex:1;">' +
                '<div style="font-size:13px;font-weight:600;color:#f8fafc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">🪦 ' + escHtml(t.title || t.bookId) + '</div>' +
                '<div style="font-family:monospace;font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml(t.bookId) + ' · ' + escHtml(dateStr) + (t.deviceName ? ' · ' + escHtml(t.deviceName) : '') + '</div>' +
              '</div>' +
              '<button type="button" class="btn-action btn-download" style="border:none;cursor:pointer;" data-tomb-action="remove-tombstone" data-book-id="' + escHtml(t.bookId) + '" data-title="' + escHtml(t.title || t.bookId) + '">🔓 묘비 해제</button>' +
            '</div>';
          });
          container.innerHTML = html;
        };

        document.addEventListener('click', async function(e) {
          var libBtn = e.target.closest('[data-lib-action]');
          if (libBtn) {
            var action = libBtn.getAttribute('data-lib-action');
            var bookId = libBtn.getAttribute('data-book-id') || '';
            var title = libBtn.getAttribute('data-title') || bookId;
            var fileName = libBtn.getAttribute('data-file-name') || '';
            var location = libBtn.getAttribute('data-location') || 'both';
            var addToTombstone = Boolean(document.getElementById('lib-add-tombstone-cb')?.checked);

            var confirmMsg = '';
            if (action === 'delete-all') {
              confirmMsg = '[' + title + '] 도서의 JSON·EPUB·표지 파일을 모두 삭제하시겠습니까?\\n' +
                (addToTombstone
                  ? '※ [묘비 등록]이 켜져 있어 다음 동기화 시 연결된 기기에서도 삭제됩니다.'
                  : '※ [묘비 등록]이 꺼져 있어 서버 파일만 삭제됩니다 (로컬 기기에 책이 있으면 재동기화 시 다시 업로드될 수 있습니다).');
            } else if (action === 'reset-cfi') {
              confirmMsg = '[' + title + '] 도서의 CFI와 진도율을 0.0%로 초기화하시겠습니까?';
            } else if (action === 'delete-json') {
              confirmMsg = '[' + title + '] 도서의 메타데이터(.json)만 삭제하시겠습니까?';
            } else if (action === 'delete-epub') {
              confirmMsg = '[' + title + '] 도서의 본문(.epub)만 삭제하시겠습니까?\\n(참고: 재업로드를 유도하려면 메타(.json)도 함께 삭제하거나 전체삭제를 이용하세요.)';
            } else if (action === 'delete-covers') {
              confirmMsg = '[' + title + '] 도서의 서버 표지 파일을 모두 삭제하시겠습니까?';
            } else if (action === 'delete-single-file') {
              confirmMsg = '파일 [' + fileName + ']을(를) 디스크에서 삭제하시겠습니까?';
            }

            if (confirmMsg && !confirm(confirmMsg)) return;

            libBtn.disabled = true;
            try {
              var res = await fetch('/admin/users/library/delete-asset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  folderName: libState.folderName,
                  action: action,
                  bookId: bookId,
                  fileName: fileName,
                  location: location,
                  addToTombstone: addToTombstone,
                  title: title
                })
              });
              var result = await res.json();
              if (!res.ok || !result.ok) throw new Error(result.error || ('HTTP ' + res.status));
              if (typeof showFloatingToast === 'function') showFloatingToast(result.message || '처리가 완료되었습니다.');
              await loadUserLibraryData();
            } catch (err) {
              alert('처리 실패: ' + err.message);
            } finally {
              libBtn.disabled = false;
            }
            return;
          }

          var tombBtn = e.target.closest('[data-tomb-action="remove-tombstone"]');
          if (tombBtn) {
            var tBookId = tombBtn.getAttribute('data-book-id') || '';
            var tTitle = tombBtn.getAttribute('data-title') || tBookId;
            if (!confirm('[' + tTitle + '] 도서를 삭제 묘비에서 해제하시겠습니까?')) return;

            tombBtn.disabled = true;
            try {
              var tRes = await fetch('/admin/users/tombstones/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  folderName: libState.folderName,
                  bookId: tBookId
                })
              });
              var tData = await tRes.json();
              if (!tRes.ok || !tData.ok) throw new Error(tData.error || ('HTTP ' + tRes.status));
              if (typeof showFloatingToast === 'function') showFloatingToast('묘비에서 해제되었습니다.');
              await loadUserLibraryData();
            } catch (err) {
              alert('묘비 해제 실패: ' + err.message);
            } finally {
              tombBtn.disabled = false;
            }
          }
        });
      })();
    </script>
  `;
}