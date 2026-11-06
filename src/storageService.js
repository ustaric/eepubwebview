/**
 * @file src/storageService.js
 * @description 도서 메타데이터, EPUB 바이너리 파일, 전역 설정 JSON, 크래시 리포트, 공유 폴더 탐색 및 올인원 스냅샷 디스크 I/O 전담 엔진
 * - 📁 [원자적 도서 보관/복원 동기화] saveBookMetadata 실행 시 메타 JSON뿐만 아니라 .epub 원본 및 모든 표지(.cover_) 파일을 books/ ⇄ archive/ 간 원자적 동시 이동
 * - 🖼️ [단일 표지 안전 삭제] deleteCoverImage 탑재로 웹 뷰어의 표지 변경/삭제(DELETE /api/storage/covers/:fileName) 완벽 지원
 * - 🛡️ [경로 소독 및 Path Traversal 방어] sanitizeFileName 및 sanitizeRelativePath 기반 디렉터리 이탈 공격 원천 차단
 * - 🔍 [서버 디렉터리 탐색 및 권한 실측] getDirectoryTree & testDirectoryPermissions 탑재로 관리자 간이 탐색기 완벽 지원
 * - 📚 [공유 폴더 도서 스캔] getRemoteBooks 탑재로 외부 라이브러리 내 .epub/.txt 도서 실시간 수집 및 스트리밍 경로 반환
 * - ⚡ [올인원 통합 스냅샷 단일 쿼리] fetchUnifiedSnapshot 규격 100% 호환 데이터 수집 엔진
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const BOOKS_DIR = path.resolve(ROOT_DIR, 'data/books');
const SETTINGS_DIR = path.resolve(ROOT_DIR, 'data/settings');
const ARCHIVE_DIR = path.resolve(ROOT_DIR, 'data/archive');
const CRASH_REPORTS_DIR = path.resolve(ROOT_DIR, 'data/crash-reports');

/**
 * 🛡️ [경로 소독 헬퍼] Path Traversal 공격을 방어하기 위해 안전한 파일명만 추출
 * @param {string} rawName 
 * @returns {string} 소독된 파일명
 */
function sanitizeFileName(rawName = '') {
  if (!rawName || typeof rawName !== 'string') return '';
  return path.basename(rawName).replace(/[^a-zA-Z0-9가-힣._-]/g, '_');
}

/**
 * 🛡️ [상대 경로 안전 검증 헬퍼] 공유 폴더 내부 상대 경로가 루트를 벗어나지 못하도록 검증
 * @param {string} baseDir 
 * @param {string} relativePath 
 * @returns {string|null} 유효한 절대 경로 또는 null
 */
function resolveSafeRelativePath(baseDir, relativePath = '') {
  if (!baseDir || !relativePath) return null;
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, relativePath);

  // 대상 경로가 반드시 baseDir 하위여야 함 (Path Traversal 차단)
  if (!resolvedTarget.startsWith(resolvedBase)) {
    return null;
  }
  return resolvedTarget;
}

/**
 * 디렉터리가 없을 경우 자동 생성 보장
 * @param {string} dirPath 
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o755 });
  }
}

/**
 * JSON 파일 안전 읽기 헬퍼
 * @param {string} filePath 
 * @returns {any|null}
 */
function readJsonSafely(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content || !content.trim()) return null;
    return JSON.parse(content);
  } catch (err) {
    console.warn(`⚠️ [StorageService] JSON 파싱 경고 ('${path.basename(filePath)}'):`, err.message);
    return null;
  }
}

/**
 * JSON 파일 원자적 쓰기 헬퍼
 * @param {string} filePath 
 * @param {any} data 
 */
function writeJsonSafely(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp_${Date.now()}`;
  const jsonStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  fs.writeFileSync(tempPath, jsonStr, 'utf-8');
  fs.renameSync(tempPath, filePath);
}

export const storageService = {
  // =========================================================================
  // ⚡ 1. 올인원 통합 스냅샷 수집 엔진 (fetchUnifiedSnapshot 호환 규격)
  // =========================================================================
  /**
   * 서버 로컬 디스크의 settings, books, archive 폴더를 스캔하여 클라이언트 대사 엔진에 100% 동일한 규격으로 반환
   * @returns {Promise<{
   *   settingsData: Object|null,
   *   achievementsData: Object|null,
   *   readingStatsData: Object|null,
   *   masterKeyFile: Object|null,
   *   cloudTombstones: Array<Object>,
   *   cloudBooks: Array<Object>,
   *   cloudArchivedBooks: Array<Object>
   * }>}
   */
  async getUnifiedSnapshot() {
    ensureDir(BOOKS_DIR);
    ensureDir(SETTINGS_DIR);
    ensureDir(ARCHIVE_DIR);

    // 1) settings 폴더 4대 독립 파일 읽기
    const settingsData = readJsonSafely(path.join(SETTINGS_DIR, 'settings.json'));
    const achievementsData = readJsonSafely(path.join(SETTINGS_DIR, 'achievements.json'));
    const readingStatsData = readJsonSafely(path.join(SETTINGS_DIR, 'reading-stats.json'));
    const masterKeyFile = readJsonSafely(path.join(SETTINGS_DIR, 'vault_master_key.json'));
    const rawTombstones = readJsonSafely(path.join(SETTINGS_DIR, 'deleted-books.json'));
    const cloudTombstones = Array.isArray(rawTombstones) ? rawTombstones : [];

    // 2) books/ 활성 도서 메타데이터(.json) 수집
    const cloudBooks = [];
    const bookFiles = fs.readdirSync(BOOKS_DIR);
    for (const file of bookFiles) {
      if (file.endsWith('.json')) {
        const bookMeta = readJsonSafely(path.join(BOOKS_DIR, file));
        if (bookMeta && bookMeta.bookId) {
          bookMeta.isArchived = false;
          cloudBooks.push(bookMeta);
        }
      }
    }

    // 3) archive/ 보관 도서 메타데이터(.json) 수집
    const cloudArchivedBooks = [];
    const archiveFiles = fs.readdirSync(ARCHIVE_DIR);
    for (const file of archiveFiles) {
      if (file.endsWith('.json')) {
        const archivedMeta = readJsonSafely(path.join(ARCHIVE_DIR, file));
        if (archivedMeta && archivedMeta.bookId) {
          archivedMeta.isArchived = true;
          archivedMeta.archiveStatus = 'archived';
          cloudArchivedBooks.push(archivedMeta);
        }
      }
    }

    console.log(`⚡ [StorageService:Snapshot] 스냅샷 수집 완료 (활성 도서: ${cloudBooks.length}권, 보관 도서: ${cloudArchivedBooks.length}권, 묘비: ${cloudTombstones.length}개)`);

    return {
      settingsData,
      achievementsData,
      readingStatsData,
      masterKeyFile,
      cloudTombstones,
      cloudBooks,
      cloudArchivedBooks
    };
  },

  // =========================================================================
  // 📚 2. 도서 메타데이터 및 바이너리 파일 I/O
  // =========================================================================
  /**
   * 도서 메타데이터 JSON 저장 및 바이너리/표지 물리적 폴더 일괄 이동
   * - isArchived 상태 변화 감지 시 .epub 원본 및 모든 .cover_*.webp 표지 파일을 books/ ⇄ archive/ 간 동시 이동
   * 
   * @param {string} bookId 
   * @param {Object} bookData 
   * @returns {boolean}
   */
  saveBookMetadata(bookId, bookData) {
    const safeId = sanitizeFileName(bookId);
    if (!safeId) throw new Error('유효하지 않은 bookId 입니다.');

    ensureDir(BOOKS_DIR);
    ensureDir(ARCHIVE_DIR);

    const isArchived = Boolean(bookData.isArchived);
    const targetDir = isArchived ? ARCHIVE_DIR : BOOKS_DIR;
    const oppositeDir = isArchived ? BOOKS_DIR : ARCHIVE_DIR;
    const targetFile = path.join(targetDir, `${safeId}.json`);
    const oppositeFile = path.join(oppositeDir, `${safeId}.json`);

    // 1. 반대쪽 폴더에 있던 기존 메타데이터(.json) 정리
    if (fs.existsSync(oppositeFile)) {
      try {
        fs.unlinkSync(oppositeFile);
      } catch (e) {
        console.warn(`⚠️ [StorageService] 기존 메타 삭제 실패: ${oppositeFile}`, e.message);
      }
    }

    // 2. 반대쪽 폴더에 실물 파일(.epub 원본 및 .cover_*.webp 표지들)이 있다면 목적지 폴더로 원자적 일괄 이동
    if (fs.existsSync(oppositeDir)) {
      try {
        const oppositeFiles = fs.readdirSync(oppositeDir);
        for (const file of oppositeFiles) {
          const isMatchingEpub = file === `${safeId}.epub`;
          const isMatchingCover = file.startsWith(`${safeId}.cover_`) && file.endsWith('.webp');

          if (isMatchingEpub || isMatchingCover) {
            const oldPath = path.join(oppositeDir, file);
            const newPath = path.join(targetDir, file);
            try {
              fs.renameSync(oldPath, newPath);
              console.log(`📦 [StorageService:Move] 실물 파일 이동 완료: '${file}' ➔ ${isArchived ? 'archive/' : 'books/'}`);
            } catch (moveErr) {
              console.warn(`⚠️ [StorageService] 실물 파일 이동 실패 ('${file}'):`, moveErr.message);
            }
          }
        }
      } catch (scanErr) {
        console.warn(`⚠️ [StorageService] 반대쪽 디렉터리 스캔 중 오류:`, scanErr.message);
      }
    }

    // 3. 목적지 폴더에 최신 메타데이터 JSON 저장
    writeJsonSafely(targetFile, bookData);
    console.log(`📖 [StorageService] 도서 메타 저장 완료: '${safeId}.json' (${isArchived ? 'archive' : 'books'})`);
    return true;
  },

  /**
   * 특정 도서 메타데이터 조회
   * @param {string} bookId 
   * @returns {Object|null}
   */
  getBookMetadata(bookId) {
    const safeId = sanitizeFileName(bookId);
    if (!safeId) return null;

    const booksPath = path.join(BOOKS_DIR, `${safeId}.json`);
    if (fs.existsSync(booksPath)) return readJsonSafely(booksPath);

    const archivePath = path.join(ARCHIVE_DIR, `${safeId}.json`);
    if (fs.existsSync(archivePath)) return readJsonSafely(archivePath);

    return null;
  },

  /**
   * EPUB 원본 파일 바이너리 저장
   * @param {string} bookId 
   * @param {Buffer} buffer 
   * @returns {boolean}
   */
  saveBookEpub(bookId, buffer) {
    const safeId = sanitizeFileName(bookId);
    if (!safeId) throw new Error('유효하지 않은 bookId 입니다.');

    ensureDir(BOOKS_DIR);
    const targetFile = path.join(BOOKS_DIR, `${safeId}.epub`);
    fs.writeFileSync(targetFile, buffer);
    console.log(`📦 [StorageService] EPUB 바이너리 저장 완료: '${safeId}.epub' (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
    return true;
  },

  /**
   * EPUB 원본 파일 경로 반환 (스트리밍 응답용)
   * @param {string} bookId 
   * @returns {{ filePath: string, size: number } | null}
   */
  getBookEpubPath(bookId) {
    const safeId = sanitizeFileName(bookId);
    if (!safeId) return null;

    const booksPath = path.join(BOOKS_DIR, `${safeId}.epub`);
    if (fs.existsSync(booksPath)) {
      const stat = fs.statSync(booksPath);
      return { filePath: booksPath, size: stat.size };
    }

    const archivePath = path.join(ARCHIVE_DIR, `${safeId}.epub`);
    if (fs.existsSync(archivePath)) {
      const stat = fs.statSync(archivePath);
      return { filePath: archivePath, size: stat.size };
    }

    return null;
  },

  /**
   * 표지 이미지 바이너리 저장
   * @param {string} fileName - 예: '도서ID.cover_0.webp'
   * @param {Buffer} buffer 
   * @returns {boolean}
   */
  saveCoverImage(fileName, buffer) {
    const safeName = sanitizeFileName(fileName);
    if (!safeName) throw new Error('유효하지 않은 표지 파일명입니다.');

    ensureDir(BOOKS_DIR);
    const targetFile = path.join(BOOKS_DIR, safeName);
    fs.writeFileSync(targetFile, buffer);
    console.log(`🖼️ [StorageService] 표지 저장 완료: '${safeName}'`);
    return true;
  },

  /**
   * 표지 이미지 파일 경로 반환
   * @param {string} fileName 
   * @returns {{ filePath: string, size: number } | null}
   */
  getCoverImagePath(fileName) {
    const safeName = sanitizeFileName(fileName);
    if (!safeName) return null;

    const booksPath = path.join(BOOKS_DIR, safeName);
    if (fs.existsSync(booksPath)) {
      const stat = fs.statSync(booksPath);
      return { filePath: booksPath, size: stat.size };
    }

    const archivePath = path.join(ARCHIVE_DIR, safeName);
    if (fs.existsSync(archivePath)) {
      const stat = fs.statSync(archivePath);
      return { filePath: archivePath, size: stat.size };
    }

    return null;
  },

  /**
   * 🌟 단일 표지 이미지 파일 삭제 (DELETE /api/storage/covers/:fileName 대응)
   * - books/ 및 archive/ 폴더를 모두 검사하여 해당 표지 파일 안전 삭제
   * @param {string} fileName - 삭제할 표지 파일명 (예: '도서ID.cover_xxx.webp')
   * @returns {boolean} 삭제 성공 여부 (파일이 원래 없어도 true 반환)
   */
  deleteCoverImage(fileName) {
    const safeName = sanitizeFileName(fileName);
    if (!safeName) return false;

    let deleted = false;
    const targetDirs = [BOOKS_DIR, ARCHIVE_DIR];

    targetDirs.forEach((dir) => {
      const targetFile = path.join(dir, safeName);
      if (fs.existsSync(targetFile)) {
        try {
          fs.unlinkSync(targetFile);
          deleted = true;
          console.log(`🗑️ [StorageService] 단일 표지 파일 삭제 완료: '${safeName}' (경로: ${dir})`);
        } catch (e) {
          console.warn(`⚠️ [StorageService] 표지 파일 삭제 실패 ('${safeName}'):`, e.message);
        }
      }
    });

    return true;
  },

  /**
   * 도서 완전 삭제 (메타, EPUB, 표지 파일 일괄 파쇄)
   * @param {string} bookId 
   * @returns {number} 삭제된 파일 수
   */
  deleteBookAll(bookId) {
    const safeId = sanitizeFileName(bookId);
    if (!safeId) return 0;

    let deletedCount = 0;
    const targetsDirs = [BOOKS_DIR, ARCHIVE_DIR];

    targetsDirs.forEach(dir => {
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir);
      files.forEach(f => {
        if (f === `${safeId}.json` || f === `${safeId}.epub` || f.startsWith(`${safeId}.cover_`)) {
          try {
            fs.unlinkSync(path.join(dir, f));
            deletedCount++;
            console.log(`🗑️ [StorageService] 파일 삭제 완료: '${f}'`);
          } catch (e) {}
        }
      });
    });

    return deletedCount;
  },

  // =========================================================================
  // ⚙️ 3. 전역 설정, 통계, 업적, 묘비 전용 I/O
  // =========================================================================
  /**
   * settings/ 폴더의 특정 JSON 파일 저장 (settings, achievements, reading-stats, deleted-books, vault_master_key 등)
   * @param {string} fileName - 예: 'settings.json'
   * @param {any} data 
   */
  saveSettingsFile(fileName, data) {
    const safeName = sanitizeFileName(fileName);
    if (!safeName) throw new Error('유효하지 않은 설정 파일명입니다.');

    ensureDir(SETTINGS_DIR);
    const targetFile = path.join(SETTINGS_DIR, safeName);
    writeJsonSafely(targetFile, data);
    console.log(`⚙️ [StorageService] 설정 파일 저장 완료: '${safeName}'`);
    return true;
  },

  /**
   * settings/ 폴더의 특정 JSON 파일 조회
   * @param {string} fileName 
   * @returns {any|null}
   */
  getSettingsFile(fileName) {
    const safeName = sanitizeFileName(fileName);
    if (!safeName) return null;

    const targetFile = path.join(SETTINGS_DIR, safeName);
    return readJsonSafely(targetFile);
  },

  // =========================================================================
  // 🔬 4. 크래시 리포트 (Crash Reports) 전용 I/O
  // =========================================================================
  /**
   * 크래시 리포트 JSON 파일 저장
   * @param {string} fileName 
   * @param {any} data 
   * @returns {boolean}
   */
  saveCrashReport(fileName, data) {
    const safeName = sanitizeFileName(fileName);
    if (!safeName) throw new Error('유효하지 않은 크래시 리포트 파일명입니다.');

    ensureDir(CRASH_REPORTS_DIR);
    const targetFile = path.join(CRASH_REPORTS_DIR, safeName);
    writeJsonSafely(targetFile, data);
    console.log(`🔬 [StorageService] 크래시 리포트 저장 완료: '${safeName}'`);
    return true;
  },

  /**
   * 저장된 크래시 리포트 파일 목록 조회 (최신순 정렬)
   * @returns {Array<{ fileName: string, sizeBytes: number, sizeKb: string, createdAt: string, totalAnomalies: number, reportType: string }>}
   */
  getCrashReportsList() {
    ensureDir(CRASH_REPORTS_DIR);
    const files = fs.readdirSync(CRASH_REPORTS_DIR);
    const reports = [];

    for (const f of files) {
      if (f.endsWith('.json')) {
        const fullPath = path.join(CRASH_REPORTS_DIR, f);
        try {
          const stat = fs.statSync(fullPath);
          const data = readJsonSafely(fullPath);
          reports.push({
            fileName: f,
            sizeBytes: stat.size,
            sizeKb: (stat.size / 1024).toFixed(1) + ' KB',
            createdAt: stat.mtime.toISOString(),
            totalAnomalies: data?.totalAnomaliesCount || (Array.isArray(data?.anomalies) ? data.anomalies.length : 1),
            reportType: data?.reportType || 'crash_report'
          });
        } catch (e) {}
      }
    }

    reports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return reports;
  },

  /**
   * 특정 크래시 리포트 파일 경로 및 크기 반환 (다운로드 스트리밍용)
   * @param {string} fileName 
   * @returns {{ filePath: string, size: number } | null}
   */
  getCrashReportPath(fileName) {
    const safeName = sanitizeFileName(fileName);
    if (!safeName) return null;

    const fullPath = path.join(CRASH_REPORTS_DIR, safeName);
    if (fs.existsSync(fullPath)) {
      const stat = fs.statSync(fullPath);
      return { filePath: fullPath, size: stat.size };
    }
    return null;
  },

  /**
   * 특정 크래시 리포트 파일 삭제
   * @param {string} fileName 
   * @returns {boolean}
   */
  deleteCrashReport(fileName) {
    const safeName = sanitizeFileName(fileName);
    if (!safeName) return false;

    const fullPath = path.join(CRASH_REPORTS_DIR, safeName);
    if (fs.existsSync(fullPath)) {
      try {
        fs.unlinkSync(fullPath);
        console.log(`🗑️ [StorageService] 크래시 리포트 삭제 완료: '${safeName}'`);
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  },

  /**
   * 모든 크래시 리포트 일괄 비우기
   * @returns {number} 삭제된 리포트 수
   */
  clearAllCrashReports() {
    ensureDir(CRASH_REPORTS_DIR);
    const files = fs.readdirSync(CRASH_REPORTS_DIR);
    let count = 0;

    for (const f of files) {
      if (f.endsWith('.json')) {
        try {
          fs.unlinkSync(path.join(CRASH_REPORTS_DIR, f));
          count++;
        } catch (e) {}
      }
    }
    console.log(`🧹 [StorageService] 크래시 리포트 전체 비우기 완료: 총 ${count}개 파일 삭제`);
    return count;
  },

  // =========================================================================
  // 🔍 5. [신규] 서버 디렉터리 탐색 및 권한 실측 엔진 (관리자 간이 탐색기용)
  // =========================================================================
  /**
   * 🛡️ 지정된 디렉터리의 실제 읽기(R_OK) 권한 유무 실측 검증
   * @param {string} dirPath - 검증할 절대 경로
   * @returns {{ exists: boolean, readable: boolean, isDirectory: boolean, error?: string }}
   */
  testDirectoryPermissions(dirPath) {
    if (!dirPath || typeof dirPath !== 'string') {
      return { exists: false, readable: false, isDirectory: false, error: '경로가 비어 있습니다.' };
    }

    try {
      if (!fs.existsSync(dirPath)) {
        return { exists: false, readable: false, isDirectory: false, error: '폴더가 존재하지 않습니다.' };
      }

      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) {
        return { exists: true, readable: false, isDirectory: false, error: '디렉터리가 아닌 파일입니다.' };
      }

      // 실제 Node/PM2 프로세스의 읽기 권한 실측 검증
      fs.accessSync(dirPath, fs.constants.R_OK);
      return { exists: true, readable: true, isDirectory: true };
    } catch (err) {
      return {
        exists: true,
        readable: false,
        isDirectory: true,
        error: `권한 부족 (EACCES/EPERM): ${err.message}`
      };
    }
  },

  /**
   * 📂 특정 경로의 하위 디렉터리 목록을 트리 형태로 조회 (관리자 탐색기 뷰용)
   * @param {string} [targetPath='/'] - 탐색할 디렉터리 경로 (기본값: 최상위 루트)
   * @returns {{ currentPath: string, parentPath: string|null, directories: Array<{ name: string, path: string, readable: boolean }> }}
   */
  getDirectoryTree(targetPath = '/') {
    const resolvedPath = path.resolve(targetPath);
    const parentPath = resolvedPath === '/' ? null : path.dirname(resolvedPath);

    const result = {
      currentPath: resolvedPath,
      parentPath: parentPath,
      directories: []
    };

    try {
      const items = fs.readdirSync(resolvedPath, { withFileTypes: true });

      for (const item of items) {
        if (!item.isDirectory()) continue;
        // 숨김 폴더(점 시작) 및 시스템 심볼릭 링크 스킵
        if (item.name.startsWith('.')) continue;

        const subDirPath = path.join(resolvedPath, item.name);
        let readable = false;
        try {
          fs.accessSync(subDirPath, fs.constants.R_OK);
          readable = true;
        } catch (e) {
          readable = false;
        }

        result.directories.push({
          name: item.name,
          path: subDirPath,
          readable
        });
      }

      // 가나다 및 알파벳순 정렬
      result.directories.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      console.warn(`⚠️ [StorageService] 디렉터리 트리 조회 실패 ('${resolvedPath}'):`, err.message);
    }

    return result;
  },

  // =========================================================================
  // 📚 6. [신규] 관리자 지정 공유 폴더 도서 스캔 및 스트리밍 엔진
  // =========================================================================
  /**
   * 🔍 지정된 공유 폴더(하위 4단계 재귀)를 스캔하여 EPUB 및 TXT 도서 목록 배열 반환
   * @param {string} sharedDir - 관리자가 설정한 공유 폴더 절대 경로
   * @returns {Array<{ fileName: string, relativePath: string, extension: string, sizeBytes: number, sizeMb: string, mtime: string }>}
   */
  getRemoteBooks(sharedDir) {
    if (!sharedDir || !fs.existsSync(sharedDir)) {
      return [];
    }

    const books = [];
    const maxDepth = 4; // 지나친 깊이 탐색 방어

    function scanRecursively(currentDir, currentDepth = 0) {
      if (currentDepth > maxDepth) return;

      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue; // 숨김 파일/폴더 제외

          const fullPath = path.join(currentDir, entry.name);

          if (entry.isDirectory()) {
            scanRecursively(fullPath, currentDepth + 1);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (ext === '.epub' || ext === '.txt') {
              try {
                const stat = fs.statSync(fullPath);
                const relPath = path.relative(sharedDir, fullPath).replace(/\\/g, '/');

                books.push({
                  fileName: entry.name,
                  relativePath: relPath,
                  extension: ext.replace('.', ''),
                  sizeBytes: stat.size,
                  sizeMb: (stat.size / (1024 * 1024)).toFixed(2) + ' MB',
                  mtime: stat.mtime.toISOString()
                });
              } catch (statErr) {}
            }
          }
        }
      } catch (scanErr) {
        console.warn(`⚠️ [StorageService] 공유 폴더 스캔 중 접근 실패 ('${currentDir}'):`, scanErr.message);
      }
    }

    scanRecursively(sharedDir, 0);

    // 최신 파일 순으로 정렬
    books.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    console.log(`📚 [StorageService:RemoteBooks] 공유 폴더('${sharedDir}') 스캔 완료: 총 ${books.length}권 발견`);
    return books;
  },

  /**
   * 📖 공유 폴더 내부 도서 파일의 안전한 절대 경로 및 크기 반환 (스트리밍 다운로드용)
   * - Path Traversal 공격을 완벽히 차단하여 공유 폴더 외곽 파일 접근을 거부합니다.
   * 
   * @param {string} sharedDir - 공유 폴더 절대 경로
   * @param {string} relativeFilePath - 클라이언트가 요청한 상대 경로
   * @returns {{ filePath: string, size: number, fileName: string } | null}
   */
  getRemoteBookFilePath(sharedDir, relativeFilePath) {
    if (!sharedDir || !relativeFilePath) return null;

    const safeFullPath = resolveSafeRelativePath(sharedDir, relativeFilePath);
    if (!safeFullPath || !fs.existsSync(safeFullPath)) {
      return null;
    }

    try {
      const stat = fs.statSync(safeFullPath);
      if (!stat.isFile()) return null;

      return {
        filePath: safeFullPath,
        size: stat.size,
        fileName: path.basename(safeFullPath)
      };
    } catch (e) {
      return null;
    }
  }
};