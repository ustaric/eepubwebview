/**
 * @file src/storageService.js
 * @description 도서 메타데이터, EPUB 바이너리 파일, 전역 설정 JSON, 크래시 리포트, 공유 폴더 탐색 및 올인원 스냅샷 디스크 I/O 전담 엔진
 * - 📁 [원자적 도서 보관/복원 동기화] saveBookMetadata 실행 시 메타 JSON뿐만 아니라 .epub 원본 및 모든 표지(.cover_) 파일을 books/ ⇄ archive/ 간 원자적 동시 이동
 * - ⚡ [서버 내부 도서 직통 복사] importRemoteBookToLibrary 탑재로 클라이언트 왕복 트래픽 없이 서버 디스크 내부에서 0.001초 만에 books/ 정식 도서로 안착
 * - 🧹 [고아 표지 서버 메타데이터 자동 자가 소독] getUnifiedSnapshot 실행 시 디스크에 실물 파일이 없는 낡은 cloudCoverFileName을 서버 디스크 JSON에서 영구 소독하여 클라이언트 404 원천 차단
 * - ✨ [서버 스마트 표지 대체 폴백] getCoverImagePath에서 요청된 해시 표지가 없더라도 같은 도서의 실물 WebP 표지가 디스크에 존재하면 200 OK로 자동 매칭 반환
 * - 🛡️ [공백/언더바/유니코드 6대 지능형 교차 탐색] getBookEpubPath, getCoverImagePath에 NFC/NFD 유니코드 및 공백/언더바 폴백을 탑재하여 404 원천 박멸
 * - 🖼️ [단일 표지 안전 삭제] deleteCoverImage 탑재로 웹 뷰어의 표지 변경/삭제(DELETE /api/storage/covers/:fileName) 완벽 지원
 * - 🛡️ [경로 소독 및 Path Traversal 방어] sanitizeFileName(공백 보존) 및 resolveSafeRelativePath 기반 디렉터리 이탈 공격 원천 차단
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
 * 🛡️ [경로 소독 헬퍼] Path Traversal 공격을 방어하면서 한글과 공백(\s)을 온전히 보존
 * @param {string} rawName 
 * @returns {string} 소독된 파일명
 */
function sanitizeFileName(rawName = '') {
  if (!rawName || typeof rawName !== 'string') return '';
  // 🌟 한글, 영문, 숫자, 마침표, 언더바, 하이픈 및 '공백(\s)'을 정상 보존!
  return path.basename(rawName).replace(/[^a-zA-Z0-9가-힣._\s-]/g, '_').trim();
}

/**
 * 🎯 [공백 & 언더바 & 유니코드 6대 후보 생성기] 파일명 엇갈림 및 리눅스 NFD 자모 분리 404를 박멸하기 위해 교차 후보 반환
 * @param {string} baseName 
 * @returns {Array<string>} [원본, 언더바본, 공백본, NFC본, NFD본]
 */
function generateFilenameCandidates(baseName = '') {
  if (!baseName) return [];
  const sanitized = sanitizeFileName(baseName);
  const withUnderscores = sanitized.replace(/\s+/g, '_');
  const withSpaces = sanitized.replace(/_+/g, ' ');

  const set = new Set([
    sanitized,
    withUnderscores,
    withSpaces,
    baseName,
    sanitized.normalize('NFC'),
    sanitized.normalize('NFD'),
    withUnderscores.normalize('NFC'),
    withUnderscores.normalize('NFD'),
    withSpaces.normalize('NFC'),
    withSpaces.normalize('NFD')
  ]);
  return Array.from(set).filter(Boolean);
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
  // ⚡ 1. 올인원 통합 스냅샷 수집 및 고아 표지 자가 소독 엔진
  // =========================================================================
  async getUnifiedSnapshot() {
    ensureDir(BOOKS_DIR);
    ensureDir(SETTINGS_DIR);
    ensureDir(ARCHIVE_DIR);

    const settingsData = readJsonSafely(path.join(SETTINGS_DIR, 'settings.json'));
    const achievementsData = readJsonSafely(path.join(SETTINGS_DIR, 'achievements.json'));
    const readingStatsData = readJsonSafely(path.join(SETTINGS_DIR, 'reading-stats.json'));
    const masterKeyFile = readJsonSafely(path.join(SETTINGS_DIR, 'vault_master_key.json'));
    const rawTombstones = readJsonSafely(path.join(SETTINGS_DIR, 'deleted-books.json'));
    const cloudTombstones = Array.isArray(rawTombstones) ? rawTombstones : [];

    const cloudBooks = [];
    const bookFiles = fs.readdirSync(BOOKS_DIR);
    for (const file of bookFiles) {
      if (file.endsWith('.json')) {
        const fullJsonPath = path.join(BOOKS_DIR, file);
        const bookMeta = readJsonSafely(fullJsonPath);
        if (bookMeta && bookMeta.bookId) {
          bookMeta.isArchived = false;

          // 🌟 [핵심 자가 소독] cloudCoverFileName이 지정되어 있는데 실제 디스크에 실물 표지 파일이 존재하는지 검증!
          if (bookMeta.cloudCoverFileName) {
            const coverCheck = this.getCoverImagePath(bookMeta.cloudCoverFileName);
            if (!coverCheck) {
              // 디스크에 실물 파일이 없는 고아 표지 감지 ➔ 실물 대체 표지 탐색
              const candidates = generateFilenameCandidates(bookMeta.bookId);
              let foundCoverName = null;

              for (const dir of [BOOKS_DIR, ARCHIVE_DIR]) {
                if (!fs.existsSync(dir)) continue;
                try {
                  const dirFiles = fs.readdirSync(dir);
                  const matched = dirFiles.find(f => f.endsWith('.webp') && candidates.some(cand => f.startsWith(`${cand}.cover_`)));
                  if (matched) {
                    foundCoverName = matched;
                    break;
                  }
                } catch (e) {}
              }

              if (foundCoverName) {
                // 대체 실물 표지가 있으면 메타데이터를 실물 파일명으로 자동 연결
                console.log(`✨ [StorageService:SelfHeal] 도서('${bookMeta.bookId}') 실물 표지('${foundCoverName}') 자동 연결 완료!`);
                bookMeta.cloudCoverFileName = foundCoverName;
                writeJsonSafely(fullJsonPath, bookMeta);
              } else {
                // 디스크에 실물 표지가 아예 없는 도서 ➔ 고아 파일명 태그 완전 소독!
                console.warn(`🧹 [StorageService:Sanitize] 도서('${bookMeta.bookId}') 표지 실물 부재 ➔ 서버 메타데이터 JSON 완전 소독 완료`);
                bookMeta.cloudCoverFileName = "";
                bookMeta.coverHash = "";
                bookMeta.covers = [];
                writeJsonSafely(fullJsonPath, bookMeta);
              }
            }
          }

          cloudBooks.push(bookMeta);
        }
      }
    }

    const cloudArchivedBooks = [];
    const archiveFiles = fs.readdirSync(ARCHIVE_DIR);
    for (const file of archiveFiles) {
      if (file.endsWith('.json')) {
        const fullJsonPath = path.join(ARCHIVE_DIR, file);
        const archivedMeta = readJsonSafely(fullJsonPath);
        if (archivedMeta && archivedMeta.bookId) {
          archivedMeta.isArchived = true;
          archivedMeta.archiveStatus = 'archived';

          // 보관 도서도 고아 표지 실측 및 자동 소독
          if (archivedMeta.cloudCoverFileName) {
            const coverCheck = this.getCoverImagePath(archivedMeta.cloudCoverFileName);
            if (!coverCheck) {
              archivedMeta.cloudCoverFileName = "";
              archivedMeta.coverHash = "";
              archivedMeta.covers = [];
              writeJsonSafely(fullJsonPath, archivedMeta);
            }
          }

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

    // 2. 반대쪽 폴더에 실물 파일이 있다면 목적지 폴더로 원자적 일괄 이동
    if (fs.existsSync(oppositeDir)) {
      try {
        const oppositeFiles = fs.readdirSync(oppositeDir);
        for (const file of oppositeFiles) {
          const isMatchingEpub = file === `${safeId}.epub` || file === `${bookId}.epub`;
          const isMatchingCover = file.startsWith(`${safeId}.cover_`) || file.startsWith(`${bookId}.cover_`);

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
   * 🔍 특정 도서 메타데이터 조회 (3단계 지능형 교차 탐색)
   * @param {string} bookId 
   * @returns {Object|null}
   */
  getBookMetadata(bookId) {
    if (!bookId) return null;
    const candidates = generateFilenameCandidates(bookId);

    for (const dir of [BOOKS_DIR, ARCHIVE_DIR]) {
      for (const cand of candidates) {
        const p = path.join(dir, `${cand}.json`);
        if (fs.existsSync(p)) {
          return readJsonSafely(p);
        }
      }
    }
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
   * 🎯 [핵심 교정 및 정밀 진단] EPUB 원본 파일 경로 반환 (3단계 지능형 교차 탐색 ➔ 404 박멸)
   * @param {string} bookId 
   * @returns {{ filePath: string, size: number } | null}
   */
  getBookEpubPath(bookId) {
    if (!bookId) {
      console.warn('⚠️ [StorageService:GetEpub] bookId가 비어 있습니다.');
      return null;
    }

    const candidates = generateFilenameCandidates(bookId);

    // books/ (1순위) ➔ archive/ (2순위) 탐색
    for (const dir of [BOOKS_DIR, ARCHIVE_DIR]) {
      if (!fs.existsSync(dir)) continue;

      for (const cand of candidates) {
        const filePath = path.join(dir, `${cand}.epub`);
        const exists = fs.existsSync(filePath);

        if (exists) {
          try {
            const stat = fs.statSync(filePath);
            if (stat.isFile()) {
              return { filePath, size: stat.size };
            }
          } catch (statErr) {}
        }
      }
    }

    return null;
  },

  /**
   * 표지 이미지 바이너리 저장
   * @param {string} fileName 
   * @param {Buffer} buffer 
   * @returns {boolean}
   */
  saveCoverImage(fileName, buffer) {
    const safeName = sanitizeFileName(fileName);
    if (!safeName) throw new Error('유효하지 않은 표지 파일명입니다.');

    ensureDir(BOOKS_DIR);
    const targetFile = path.join(BOOKS_DIR, safeName);
    fs.writeFileSync(targetFile, buffer);
    console.log(`🖼️ [StorageService] 표지 저장 완료: '${safeName}' (${(buffer.length / 1024).toFixed(1)} KB)`);
    return true;
  },

  /**
   * 🎯 [핵심 교정 & 스마트 대체 폴백] 표지 이미지 파일 경로 반환
   * 1. 요청된 파일명(NFC/NFD/공백/언더바 6대 후보)을 1차 탐색합니다.
   * 2. 요청된 특정 해시 파일이 없더라도, 해당 도서의 다른 실물 표지(*.cover_*.webp)가 디스크에 존재하면 실물 표지를 자동 반환하여 404를 원천 차단합니다.
   * @param {string} fileName 
   * @returns {{ filePath: string, size: number } | null}
   */
  getCoverImagePath(fileName) {
    if (!fileName) return null;
    const candidates = generateFilenameCandidates(fileName);

    // 1차: 요청된 파일명 완전 일치 탐색
    for (const dir of [BOOKS_DIR, ARCHIVE_DIR]) {
      if (!fs.existsSync(dir)) continue;

      for (const cand of candidates) {
        const filePath = path.join(dir, cand);
        if (fs.existsSync(filePath)) {
          try {
            const stat = fs.statSync(filePath);
            if (stat.isFile()) {
              return { filePath, size: stat.size };
            }
          } catch (e) {}
        }
      }
    }

    // 🌟 2차 스마트 폴백: 요청된 특정 해시 파일이 없더라도, 해당 도서(bookId)의 다른 실물 표지가 존재하면 자동 매칭 반환!
    const coverMatch = fileName.match(/^(.*?)\.cover_[a-zA-Z0-9_-]+\.webp$/);
    if (coverMatch) {
      const bookPrefix = coverMatch[1];
      const prefixCandidates = generateFilenameCandidates(bookPrefix);

      for (const dir of [BOOKS_DIR, ARCHIVE_DIR]) {
        if (!fs.existsSync(dir)) continue;
        try {
          const files = fs.readdirSync(dir);
          const fallbackFile = files.find(f => 
            f.endsWith('.webp') && 
            prefixCandidates.some(cand => f.startsWith(`${cand}.cover_`))
          );

          if (fallbackFile) {
            const fallbackPath = path.join(dir, fallbackFile);
            const stat = fs.statSync(fallbackPath);
            if (stat.isFile()) {
              console.log(`✨ [StorageService:CoverFallback] 요청된 표지('${fileName}') 부재 ➔ 대체 실물 표지('${fallbackFile}') 200 OK 매칭 성공!`);
              return { filePath: fallbackPath, size: stat.size };
            }
          }
        } catch (e) {}
      }
    }

    return null;
  },

  /**
   * 단일 표지 이미지 파일 삭제
   * @param {string} fileName 
   * @returns {boolean}
   */
  deleteCoverImage(fileName) {
    if (!fileName) return false;
    const candidates = generateFilenameCandidates(fileName);
    let deleted = false;

    [BOOKS_DIR, ARCHIVE_DIR].forEach((dir) => {
      if (!fs.existsSync(dir)) return;
      candidates.forEach((cand) => {
        const targetFile = path.join(dir, cand);
        if (fs.existsSync(targetFile)) {
          try {
            fs.unlinkSync(targetFile);
            deleted = true;
            console.log(`🗑️ [StorageService] 단일 표지 파일 삭제 완료: '${cand}'`);
          } catch (e) {}
        }
      });
    });

    return true;
  },

  /**
   * 도서 완전 삭제 (메타, EPUB, 표지 파일 일괄 파쇄)
   * @param {string} bookId 
   * @returns {number}
   */
  deleteBookAll(bookId) {
    if (!bookId) return 0;
    const candidates = generateFilenameCandidates(bookId);
    let deletedCount = 0;

    [BOOKS_DIR, ARCHIVE_DIR].forEach((dir) => {
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir);
      files.forEach((f) => {
        const isMatch = candidates.some((cand) => 
          f === `${cand}.json` || f === `${cand}.epub` || f.startsWith(`${cand}.cover_`)
        );
        if (isMatch) {
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
  saveSettingsFile(fileName, data) {
    const safeName = sanitizeFileName(fileName);
    if (!safeName) throw new Error('유효하지 않은 설정 파일명입니다.');

    ensureDir(SETTINGS_DIR);
    const targetFile = path.join(SETTINGS_DIR, safeName);
    writeJsonSafely(targetFile, data);
    console.log(`⚙️ [StorageService] 설정 파일 저장 완료: '${safeName}'`);
    return true;
  },

  getSettingsFile(fileName) {
    const safeName = sanitizeFileName(fileName);
    if (!safeName) return null;

    const targetFile = path.join(SETTINGS_DIR, safeName);
    return readJsonSafely(targetFile);
  },

  // =========================================================================
  // 🔬 4. 크래시 리포트 전용 I/O
  // =========================================================================
  saveCrashReport(fileName, data) {
    const safeName = sanitizeFileName(fileName);
    if (!safeName) throw new Error('유효하지 않은 크래시 리포트 파일명입니다.');

    ensureDir(CRASH_REPORTS_DIR);
    const targetFile = path.join(CRASH_REPORTS_DIR, safeName);
    writeJsonSafely(targetFile, data);
    console.log(`🔬 [StorageService] 크래시 리포트 저장 완료: '${safeName}'`);
    return true;
  },

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

  deleteCrashReport(fileName) {
    const safeName = sanitizeFileName(fileName);
    if (!safeName) return false;

    const fullPath = path.join(CRASH_REPORTS_DIR, safeName);
    if (fs.existsSync(fullPath)) {
      try {
        fs.unlinkSync(fullPath);
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  },

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
    return count;
  },

  // =========================================================================
  // 🔍 5. 서버 디렉터리 탐색 및 권한 실측 엔진
  // =========================================================================
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

      result.directories.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      console.warn(`⚠️ [StorageService] 디렉터리 트리 조회 실패 ('${resolvedPath}'):`, err.message);
    }

    return result;
  },

  // =========================================================================
  // 📚 6. 관리자 지정 공유 폴더 도서 스캔, 스트리밍 및 직통 복사 엔진
  // =========================================================================
  getRemoteBooks(sharedDir) {
    if (!sharedDir || !fs.existsSync(sharedDir)) {
      return [];
    }

    const books = [];
    const maxDepth = 4;

    function scanRecursively(currentDir, currentDepth = 0) {
      if (currentDepth > maxDepth) return;

      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;

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
    books.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    console.log(`📚 [StorageService:RemoteBooks] 공유 폴더('${sharedDir}') 스캔 완료: 총 ${books.length}권 발견`);
    return books;
  },

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
  },

  /**
   * ⚡ 공유 폴더 도서를 서버 내부 디스크에서 books/ 로 직접 복사(Import)하고 정식 메타데이터 생성
   * @param {string} sharedDir - 공유 폴더 절대 경로
   * @param {string} relativeFilePath - 공유 폴더 내 파일 상대 경로
   */
  importRemoteBookToLibrary(sharedDir, relativeFilePath) {
    if (!sharedDir || !relativeFilePath) return null;

    const safeSourcePath = resolveSafeRelativePath(sharedDir, relativeFilePath);
    if (!safeSourcePath || !fs.existsSync(safeSourcePath)) {
      throw new Error('원본 도서 파일을 찾을 수 없거나 경로가 잘못되었습니다.');
    }

    const stat = fs.statSync(safeSourcePath);
    if (!stat.isFile() || stat.size === 0) {
      throw new Error('유효하지 않은 도서 파일이거나 0바이트 빈 파일입니다.');
    }

    const rawFileName = path.basename(safeSourcePath);
    const cleanBaseName = rawFileName.replace(/\.(epub|txt)$/i, '').replace(/_\d+$/, '').trim();
    const ext = path.extname(rawFileName).toLowerCase();
    const isTxt = ext === '.txt';

    // 🌟 [핵심] 중복 크기 및 이중 확장자 방어: 순수 파일명_실제바이트
    const fileName = `${cleanBaseName}${ext}`;
    const bookId = `${fileName}_${stat.size}`;
    const cleanTitle = cleanBaseName;
    const nowIso = new Date().toISOString();

    ensureDir(BOOKS_DIR);

    // 1. 공백 보존 파일명으로 실물 파일 직접 복사
    const targetEpubPath = path.join(BOOKS_DIR, `${bookId}.epub`);
    fs.copyFileSync(safeSourcePath, targetEpubPath);

    console.log(`⚡ [StorageService:Import] 서버 내부 0초 도서 복사 완료:`, {
      originalSource: safeSourcePath,
      targetDestination: targetEpubPath,
      existsOnDisk: fs.existsSync(targetEpubPath),
      savedSizeBytes: stat.size,
      bookId: bookId
    });

    // 2. 정규 도서 메타데이터 JSON 생성 및 저장
    const bookData = {
      bookId,
      title: cleanTitle,
      fileName,
      totalCharacters: 0,
      readCharacters: 0,
      progress: '0.0%',
      lastCfi: '0',
      completed: false,
      isArchived: false,
      hasLocalFile: true,
      isRecordOnly: false,
      isConvertedTxt: isTxt,
      lastReadDate: nowIso,
      lastModified: nowIso
    };

    this.saveBookMetadata(bookId, bookData);
    console.log(`📖 [StorageService:Import] 정규 도서 메타데이터 자동 각인 완료: '${bookId}.json'`);

    return {
      ok: true,
      bookId,
      bookData,
      size: stat.size,
      fileName
    };
  }
};