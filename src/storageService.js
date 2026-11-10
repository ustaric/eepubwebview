/**
 * @file src/storageService.js
 * @description 도서 메타데이터, EPUB 바이너리 파일, 전역 설정 JSON, 크래시 리포트, 공유 폴더 탐색 및 올인원 스냅샷 디스크 I/O 전담 엔진
 * - 👥 [다중 사용자 샌드박스 스코핑] userFolder 매개변수 지원으로 data/users/{userFolder}/books, settings, archive 완전 격리
 * - 📁 [보관 도서 스마트 라우팅] saveBookEpub, saveCoverImage가 isArchived 상태를 감지하여 archive/ 폴더로 실물 파일 정확히 저장
 * - 🛡️ [securityGuard 결속] fs.realpathSync 기반 심볼릭 링크 탈출 차단 및 확장자 화이트리스트 실측 검증
 * - 📁 [원자적 도서 보관/복원 동기화] saveBookMetadata 실행 시 메타 JSON뿐만 아니라 .epub 원본 및 모든 표지(.cover_) 파일을 books/ ⇄ archive/ 간 원자적 동시 이동
 * - ⚡ [서버 내부 도서 직통 복사] importRemoteBookToLibrary 탑재로 클라이언트 왕복 트래픽 없이 서버 디스크 내부에서 0.001초 만에 books/ 정식 도서로 안착
 * - 🔤 [웹뷰 규격 100% 일치 파일명 표준화] sanitizeFileName에서 대괄호/소괄호를 안전 보존하고 공백(\s+)을 언더바(_)로 치환하여 웹뷰와 1:1 완벽 일치
 * - 🧹 [고아 표지 서버 메타데이터 자동 자가 소독] getUnifiedSnapshot 실행 시 디스크에 실물 파일이 없는 낡은 cloudCoverFileName을 서버 디스크 JSON에서 영구 소독하여 클라이언트 404 원천 차단
 * - ✨ [서버 스마트 표지 대체 폴백 & covers/ 접두사 박멸] getCoverImagePath에서 가짜 covers/ 경로를 소독하고 books/ 내 실물 WebP 표지를 100% 자동 매칭 반환
 * - 🛡️ [공백/언더바/유니코드/구버전 6대 지능형 교차 탐색] getBookEpubPath, getCoverImagePath에 NFC/NFD 유니코드 및 구버전 파일명 폴백을 탑재하여 404 원천 박멸
 * - 🖼️ [단일 표지 안전 삭제] deleteCoverImage 탑재로 웹 뷰어의 표지 변경/삭제(DELETE /api/storage/covers/:fileName) 완벽 지원
 * - 🔍 [서버 디렉터리 탐색 및 권한 실측] getDirectoryTree & testDirectoryPermissions 탑재로 관리자 간이 탐색기 완벽 지원
 * - 📚 [공유 폴더 도서 스캔] getRemoteBooks 탑재로 외부 라이브러리 내 .epub/.txt 도서 실시간 수집 및 스트리밍 경로 반환
 * - ⚡ [올인원 통합 스냅샷 단일 쿼리] fetchUnifiedSnapshot 규격 100% 호환 데이터 수집 엔진
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateSafePath, isAllowedBookFile } from './securityGuard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// 기본 최상위 디렉터리 (루트 관리자 및 Fallback용)
const BASE_BOOKS_DIR = path.resolve(ROOT_DIR, 'data/books');
const BASE_SETTINGS_DIR = path.resolve(ROOT_DIR, 'data/settings');
const BASE_ARCHIVE_DIR = path.resolve(ROOT_DIR, 'data/archive');
const CRASH_REPORTS_DIR = path.resolve(ROOT_DIR, 'data/crash-reports');
const USERS_DIR = path.resolve(ROOT_DIR, 'data/users');

/**
 * 🛡️ [경로 소독 및 언더바(_) 웹뷰 규격 일치화 헬퍼]
 * OS 파일시스템 금지 문자(< > : " / \ | ? *) 및 Path Traversal을 방어하면서,
 * 대괄호([]) 및 소괄호(())를 보존하고 공백(\s+)만 언더바(_)로 치환하여 웹뷰 규격과 100% 일치시킵니다.
 * @param {string} rawName 
 * @returns {string} 소독 및 언더바 처리된 표준 파일명
 */
function sanitizeFileName(rawName = '') {
  if (!rawName || typeof rawName !== 'string') return '';
  return path.basename(rawName)
    .replace(/\s+/g, '_')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim();
}

/**
 * 🎯 [지능형 다중 후보 생성기]
 * 1. 신규 웹뷰 표준 규격 (대괄호 유지 + 공백만 언더바)
 * 2. 원본 공백 규격
 * 3. 과거 서버 구버전 규격 (대괄호가 _ 로 치환되어 남아있던 찌꺼기 파일 하위 호환)
 * 4. Linux NFD / NFC 자모 분리 방어 후보
 * @param {string} baseName 
 * @returns {Array<string>} 교차 탐색용 파일명 후보군
 */
function generateFilenameCandidates(baseName = '') {
  if (!baseName) return [];
  const rawBase = baseName.trim();
  const sanitized = sanitizeFileName(rawBase);
  const withSpaces = sanitized.replace(/_+/g, ' ');

  // 🌟 과거 서버가 대괄호/특수문자를 전부 언더바로 치환했던 구버전 실물 파일 하위 호환 탐색 후보
  const legacySanitized = path.basename(rawBase)
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9가-힣._-]/g, '_')
    .trim();

  const set = new Set([
    sanitized,
    rawBase,
    withSpaces,
    legacySanitized,
    sanitized.normalize('NFC'),
    sanitized.normalize('NFD'),
    rawBase.normalize('NFC'),
    rawBase.normalize('NFD'),
    withSpaces.normalize('NFC'),
    withSpaces.normalize('NFD'),
    legacySanitized.normalize('NFC'),
    legacySanitized.normalize('NFD')
  ]);
  return Array.from(set).filter(Boolean);
}

/**
 * 🛡️ [상대 경로 안전 검증 헬퍼 - securityGuard 연동 실측]
 * 공유 폴더 내부 상대 경로가 심볼릭 링크나 상위 탐색을 통해 루트를 벗어나지 못하도록 실물 realpath 검증
 * @param {string} baseDir 
 * @param {string} relativePath 
 * @returns {string|null} 유효한 절대 실물 경로 또는 null
 */
function resolveSafeRelativePath(baseDir, relativePath = '') {
  if (!baseDir || !relativePath) return null;
  const guardResult = validateSafePath(baseDir, relativePath);
  if (!guardResult.safe) {
    console.warn(`⛔ [SecurityGuard Blocked] 경로 이탈 또는 심볼릭 링크 탈출 차단: '${relativePath}' (사유: ${guardResult.reason})`);
    return null;
  }
  return guardResult.realPath;
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

/**
 * 특정 디렉터리의 실측 용량(Byte) 계산
 * @param {string} dirPath 
 * @returns {number}
 */
function calculateDirSizeBytes(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let totalBytes = 0;
  try {
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const f of files) {
      const fullPath = path.join(dirPath, f.name);
      if (f.isDirectory()) {
        totalBytes += calculateDirSizeBytes(fullPath);
      } else if (f.isFile()) {
        try {
          totalBytes += fs.statSync(fullPath).size;
        } catch (e) {}
      }
    }
  } catch (e) {}
  return totalBytes;
}

/**
 * 👥 [사용자 전용 디렉터리 경로 동적 해석 헬퍼]
 * userFolder가 지정되면 data/users/{userFolder}/books, settings, archive 반환
 * userFolder가 없으면 기존 최상위 data/books, settings, archive 반환 (100% 하위 호환)
 * @param {string|null} [userFolder=null] 
 * @returns {{ booksDir: string, settingsDir: string, archiveDir: string, userRoot: string }}
 */
function resolveStorageContext(userFolder = null) {
  if (!userFolder || typeof userFolder !== 'string') {
    return {
      booksDir: BASE_BOOKS_DIR,
      settingsDir: BASE_SETTINGS_DIR,
      archiveDir: BASE_ARCHIVE_DIR,
      userRoot: ROOT_DIR
    };
  }

  const cleanFolder = path.basename(userFolder.trim());
  const safeCheck = validateSafePath(USERS_DIR, cleanFolder);
  if (!safeCheck.safe) {
    console.warn(`⛔ [SecurityGuard Blocked] 유효하지 않은 사용자 폴더 접근: '${userFolder}'`);
    throw new Error('UNAUTHORIZED_USER_STORAGE_PATH');
  }

  const userRoot = safeCheck.realPath;
  const booksDir = path.join(userRoot, 'books');
  const settingsDir = path.join(userRoot, 'settings');
  const archiveDir = path.join(userRoot, 'archive');

  ensureDir(booksDir);
  ensureDir(settingsDir);
  ensureDir(archiveDir);

  return { booksDir, settingsDir, archiveDir, userRoot };
}

export const storageService = {
  /**
   * 📊 [사용자 저장 용량 한도 실측 검사]
   * @param {string} userFolder 
   * @param {number} incomingBytes - 저장하려는 파일 바이트 수
   * @param {number} quotaBytes - 사용자 할당 용량 바이트 수
   * @returns {{ allowed: boolean, currentBytes: number, quotaBytes: number, remainingBytes: number }}
   */
  checkUserStorageQuota(userFolder, incomingBytes = 0, quotaBytes = 1073741824) {
    if (!userFolder) return { allowed: true, currentBytes: 0, quotaBytes, remainingBytes: quotaBytes };

    const ctx = resolveStorageContext(userFolder);
    const currentBytes = calculateDirSizeBytes(ctx.userRoot);
    const willUseBytes = currentBytes + Number(incomingBytes || 0);

    return {
      allowed: willUseBytes <= quotaBytes,
      currentBytes,
      quotaBytes,
      remainingBytes: Math.max(0, quotaBytes - currentBytes)
    };
  },

  // =========================================================================
  // ⚡ 1. 올인원 통합 스냅샷 수집 및 고아 표지 자가 소독 엔진
  // =========================================================================
  /**
   * 도서 메타데이터, 보관 도서, 전역 설정, 통계, 업적, 묘비를 단일 객체로 취합하여 반환
   * @param {string|null} [userFolder=null] 
   * @returns {Promise<Object>}
   */
  async getUnifiedSnapshot(userFolder = null) {
    const ctx = resolveStorageContext(userFolder);
    ensureDir(ctx.booksDir);
    ensureDir(ctx.settingsDir);
    ensureDir(ctx.archiveDir);

    const settingsData = readJsonSafely(path.join(ctx.settingsDir, 'settings.json'));
    const achievementsData = readJsonSafely(path.join(ctx.settingsDir, 'achievements.json'));
    const readingStatsData = readJsonSafely(path.join(ctx.settingsDir, 'reading-stats.json'));
    const masterKeyFile = readJsonSafely(path.join(ctx.settingsDir, 'vault_master_key.json'));
    const rawTombstones = readJsonSafely(path.join(ctx.settingsDir, 'deleted-books.json'));
    const cloudTombstones = Array.isArray(rawTombstones) ? rawTombstones : [];

    const cloudBooks = [];
    const bookFiles = fs.readdirSync(ctx.booksDir);
    for (const file of bookFiles) {
      if (file.endsWith('.json')) {
        const fullJsonPath = path.join(ctx.booksDir, file);
        const bookMeta = readJsonSafely(fullJsonPath);
        if (bookMeta && bookMeta.bookId) {
          bookMeta.isArchived = false;

          // 🌟 [핵심 자가 소독] cloudCoverFileName이 지정되어 있는데 실제 디스크에 실물 표지 파일이 존재하는지 검증!
          if (bookMeta.cloudCoverFileName) {
            const coverCheck = this.getCoverImagePath(bookMeta.cloudCoverFileName, userFolder);
            if (!coverCheck) {
              // 디스크에 실물 파일이 없는 고아 표지 감지 ➔ 실물 대체 표지 탐색
              const candidates = generateFilenameCandidates(bookMeta.bookId);
              let foundCoverName = null;

              for (const dir of [ctx.booksDir, ctx.archiveDir]) {
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
                console.log(`✨ [StorageService:SelfHeal] 도서('${bookMeta.bookId}') 실물 표지('${foundCoverName}') 자동 연결 완료! (폴더: ${userFolder || 'root'})`);
                bookMeta.cloudCoverFileName = foundCoverName;
                writeJsonSafely(fullJsonPath, bookMeta);
              } else {
                // 디스크에 실물 표지가 아예 없는 도서 ➔ 고아 파일명 태그 완전 소독!
                console.warn(`🧹 [StorageService:Sanitize] 도서('${bookMeta.bookId}') 표지 실물 부재 ➔ 서버 메타데이터 JSON 완전 소독 완료 (폴더: ${userFolder || 'root'})`);
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
    const archiveFiles = fs.readdirSync(ctx.archiveDir);
    for (const file of archiveFiles) {
      if (file.endsWith('.json')) {
        const fullJsonPath = path.join(ctx.archiveDir, file);
        const archivedMeta = readJsonSafely(fullJsonPath);
        if (archivedMeta && archivedMeta.bookId) {
          archivedMeta.isArchived = true;
          archivedMeta.archiveStatus = 'archived';

          // 보관 도서도 고아 표지 실측 및 자동 소독
          if (archivedMeta.cloudCoverFileName) {
            const coverCheck = this.getCoverImagePath(archivedMeta.cloudCoverFileName, userFolder);
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

    console.log(`⚡ [StorageService:Snapshot] 스냅샷 수집 완료 (폴더: ${userFolder || 'root'} / 활성 도서: ${cloudBooks.length}권, 보관 도서: ${cloudArchivedBooks.length}권, 묘비: ${cloudTombstones.length}개)`);

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
   * @param {string|null} [userFolder=null]
   * @returns {boolean}
   */
  saveBookMetadata(bookId, bookData, userFolder = null) {
    const safeId = sanitizeFileName(bookId);
    if (!safeId) throw new Error('유효하지 않은 bookId 입니다.');

    const ctx = resolveStorageContext(userFolder);
    ensureDir(ctx.booksDir);
    ensureDir(ctx.archiveDir);

    const isArchived = Boolean(bookData.isArchived);
    const targetDir = isArchived ? ctx.archiveDir : ctx.booksDir;
    const oppositeDir = isArchived ? ctx.booksDir : ctx.archiveDir;
    const targetFile = path.join(targetDir, `${safeId}.json`);
    const oppositeFile = path.join(oppositeDir, `${safeId}.json`);

    // 🛡️ 쓰기 대상 경로의 안전성 검증
    const pathCheck = validateSafePath(targetDir, `${safeId}.json`);
    if (!pathCheck.safe) {
      throw new Error(`안전하지 않은 메타데이터 경로: ${pathCheck.reason}`);
    }

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
              console.log(`📦 [StorageService:Move] 실물 파일 이동 완료: '${file}' ➔ ${isArchived ? 'archive/' : 'books/'} (폴더: ${userFolder || 'root'})`);
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
    console.log(`📖 [StorageService] 도서 메타 저장 완료: '${safeId}.json' (${isArchived ? 'archive' : 'books'}, 폴더: ${userFolder || 'root'})`);
    return true;
  },

  /**
   * 🔍 특정 도서 메타데이터 조회 (3단계 지능형 교차 탐색)
   * @param {string} bookId 
   * @param {string|null} [userFolder=null]
   * @returns {Object|null}
   */
  getBookMetadata(bookId, userFolder = null) {
    if (!bookId) return null;
    const candidates = generateFilenameCandidates(bookId);
    const ctx = resolveStorageContext(userFolder);

    for (const dir of [ctx.booksDir, ctx.archiveDir]) {
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
   * EPUB 원본 파일 바이너리 저장 (보관 도서 스마트 라우팅 지원)
   * @param {string} bookId 
   * @param {Buffer} buffer 
   * @param {string|null} [userFolder=null]
   * @returns {boolean}
   */
  saveBookEpub(bookId, buffer, userFolder = null) {
    const safeId = sanitizeFileName(bookId);
    if (!safeId) throw new Error('유효하지 않은 bookId 입니다.');

    const ctx = resolveStorageContext(userFolder);
    ensureDir(ctx.booksDir);
    ensureDir(ctx.archiveDir);

    // 🌟 [보관 도서 스마트 감지] archive/ 에 메타데이터가 존재하면 보관 도서로 판정하여 archive/ 에 직접 저장!
    const isArchived = fs.existsSync(path.join(ctx.archiveDir, `${safeId}.json`));
    const targetDir = isArchived ? ctx.archiveDir : ctx.booksDir;
    const targetFile = path.join(targetDir, `${safeId}.epub`);

    // 🛡️ 물리 경로 탈출 방어
    const pathCheck = validateSafePath(targetDir, `${safeId}.epub`);
    if (!pathCheck.safe) {
      throw new Error(`안전하지 않은 EPUB 저장 경로: ${pathCheck.reason}`);
    }

    fs.writeFileSync(targetFile, buffer);
    console.log(`📦 [StorageService] EPUB 바이너리 저장 완료: '${safeId}.epub' ➔ ${isArchived ? 'archive/' : 'books/'} (${(buffer.length / 1024 / 1024).toFixed(2)} MB, 폴더: ${userFolder || 'root'})`);
    return true;
  },

  /**
   * 🎯 EPUB 원본 파일 경로 반환 (3단계 지능형 교차 탐색 ➔ 404 박멸)
   * @param {string} bookId 
   * @param {string|null} [userFolder=null]
   * @returns {{ filePath: string, size: number } | null}
   */
  getBookEpubPath(bookId, userFolder = null) {
    if (!bookId) {
      console.warn('⚠️ [StorageService:GetEpub] bookId가 비어 있습니다.');
      return null;
    }

    const candidates = generateFilenameCandidates(bookId);
    const ctx = resolveStorageContext(userFolder);

    // books/ (1순위) ➔ archive/ (2순위) 탐색
    for (const dir of [ctx.booksDir, ctx.archiveDir]) {
      if (!fs.existsSync(dir)) continue;

      for (const cand of candidates) {
        const filePath = path.join(dir, `${cand}.epub`);
        const exists = fs.existsSync(filePath);

        if (exists) {
          try {
            // 🛡️ 심볼릭 링크 탈출 실측 검증
            const pathCheck = validateSafePath(dir, `${cand}.epub`);
            if (!pathCheck.safe) continue;

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
   * 표지 이미지 바이너리 저장 (보관 도서 스마트 라우팅 지원)
   * @param {string} fileName 
   * @param {Buffer} buffer 
   * @param {string|null} [userFolder=null]
   * @returns {boolean}
   */
  saveCoverImage(fileName, buffer, userFolder = null) {
    // 🌟 혹시 클라이언트에서 'covers/파일명' 형식으로 보내오면 접두사 안전 제거
    const cleanRaw = String(fileName || '').replace(/^covers[/\\]/i, '');
    const safeName = sanitizeFileName(cleanRaw);
    if (!safeName) throw new Error('유효하지 않은 표지 파일명입니다.');

    const ctx = resolveStorageContext(userFolder);
    ensureDir(ctx.booksDir);
    ensureDir(ctx.archiveDir);

    const prefixMatch = safeName.match(/^(.*?)\.cover_/);
    const bookPrefix = prefixMatch ? prefixMatch[1] : '';
    const isArchived = bookPrefix && fs.existsSync(path.join(ctx.archiveDir, `${bookPrefix}.json`));

    // 🌟 [핵심] 표지는 무조건 books/ (또는 보관 도서는 archive/) 실물 도서 폴더로 100% 통합 저장!
    const targetDir = isArchived ? ctx.archiveDir : ctx.booksDir;
    const targetFile = path.join(targetDir, safeName);

    // 🛡️ 물리 경로 탈출 방어
    const pathCheck = validateSafePath(targetDir, safeName);
    if (!pathCheck.safe) {
      throw new Error(`안전하지 않은 표지 저장 경로: ${pathCheck.reason}`);
    }

    fs.writeFileSync(targetFile, buffer);
    console.log(`🖼️ [StorageService] 표지 저장 완료: '${safeName}' ➔ ${isArchived ? 'archive/' : 'books/'} (${(buffer.length / 1024).toFixed(1)} KB, 폴더: ${userFolder || 'root'})`);
    return true;
  },

  /**
   * 🎯 [표지 이미지 실물 경로 정밀 탐색 엔진]
   * 1. 클라이언트가 'covers/이름'으로 요청하든 순수 이름으로 요청하든 접두사를 즉시 소독합니다.
   * 2. books/ 와 archive/ 폴더 내부의 실물 WebP 표지를 100% 교차 탐색하여 매칭합니다.
   * 3. 특정 해시가 일치하지 않더라도 같은 도서의 실물 WebP 표지가 디스크에 있으면 즉시 200 OK로 반환합니다.
   * @param {string} fileName 
   * @param {string|null} [userFolder=null]
   * @returns {{ filePath: string, size: number } | null}
   */
  getCoverImagePath(fileName, userFolder = null) {
    if (!fileName) return null;

    // 🌟 [핵심 소독] 가짜 covers/ 접두사가 포함되어 있으면 즉시 제거
    const cleanFileName = String(fileName).replace(/^covers[/\\]/i, '').trim();
    const candidates = generateFilenameCandidates(cleanFileName);
    const ctx = resolveStorageContext(userFolder);

    // 1차: 요청된 파일명 완전 일치 탐색 (books/ ➔ archive/)
    for (const dir of [ctx.booksDir, ctx.archiveDir]) {
      if (!fs.existsSync(dir)) continue;

      for (const cand of candidates) {
        const filePath = path.join(dir, cand);
        if (fs.existsSync(filePath)) {
          try {
            const pathCheck = validateSafePath(dir, cand);
            if (!pathCheck.safe) continue;

            const stat = fs.statSync(filePath);
            if (stat.isFile()) {
              return { filePath, size: stat.size };
            }
          } catch (e) {}
        }
      }
    }

    // 🌟 2차 스마트 폴백: 해당 도서 접두사를 포함하는 모든 실물 .webp 표지 자동 매칭
    // 예: "내_도서.txt_12345.cover_hash.webp" ➔ "내_도서.txt_12345" 추출
    const coverPrefixMatch = cleanFileName.match(/^(.*?)\.cover_/);
    if (coverPrefixMatch) {
      const bookPrefix = coverPrefixMatch[1];
      const prefixCandidates = generateFilenameCandidates(bookPrefix);

      for (const dir of [ctx.booksDir, ctx.archiveDir]) {
        if (!fs.existsSync(dir)) continue;
        try {
          const files = fs.readdirSync(dir);
          const fallbackFile = files.find(f => 
            f.endsWith('.webp') && 
            prefixCandidates.some(cand => f.startsWith(`${cand}.cover_`))
          );

          if (fallbackFile) {
            const fallbackPath = path.join(dir, fallbackFile);
            const pathCheck = validateSafePath(dir, fallbackFile);
            if (!pathCheck.safe) continue;

            const stat = fs.statSync(fallbackPath);
            if (stat.isFile()) {
              console.log(`✨ [StorageService:CoverMatch] 실물 표지 매칭 성공: '${cleanFileName}' ➔ '${fallbackFile}' (폴더: ${userFolder || 'root'})`);
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
   * @param {string|null} [userFolder=null]
   * @returns {boolean}
   */
  deleteCoverImage(fileName, userFolder = null) {
    if (!fileName) return false;
    const cleanFileName = String(fileName).replace(/^covers[/\\]/i, '').trim();
    const candidates = generateFilenameCandidates(cleanFileName);
    const ctx = resolveStorageContext(userFolder);
    let deleted = false;

    [ctx.booksDir, ctx.archiveDir].forEach((dir) => {
      if (!fs.existsSync(dir)) return;
      candidates.forEach((cand) => {
        const targetFile = path.join(dir, cand);
        if (fs.existsSync(targetFile)) {
          try {
            const pathCheck = validateSafePath(dir, cand);
            if (pathCheck.safe) {
              fs.unlinkSync(targetFile);
              deleted = true;
              console.log(`🗑️ [StorageService] 단일 표지 파일 삭제 완료: '${cand}' (폴더: ${userFolder || 'root'})`);
            }
          } catch (e) {}
        }
      });
    });

    return deleted;
  },

  /**
   * 🗑️ 도서 완전 삭제 (메타데이터 JSON, EPUB 본문, 모든 WebP 표지 일괄 영구 파쇄)
   * @param {string} bookId 
   * @param {string|null} [userFolder=null]
   * @returns {number} 실제 삭제된 파일 총 개수
   */
  deleteBookAll(bookId, userFolder = null) {
    if (!bookId) return 0;
    const cleanId = String(bookId).replace(/\.(json|epub)$/i, '');
    const candidates = generateFilenameCandidates(cleanId);
    const ctx = resolveStorageContext(userFolder);
    let deletedCount = 0;

    [ctx.booksDir, ctx.archiveDir].forEach((dir) => {
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir);
      files.forEach((f) => {
        const isMatch = candidates.some((cand) => 
          f === `${cand}.json` || f === `${cand}.epub` || f.startsWith(`${cand}.cover_`)
        );
        if (isMatch) {
          try {
            const pathCheck = validateSafePath(dir, f);
            if (pathCheck.safe) {
              fs.unlinkSync(path.join(dir, f));
              deletedCount++;
              console.log(`🗑️ [StorageService] 파일 삭제 완료: '${f}' (폴더: ${path.basename(dir)})`);
            }
          } catch (e) {
            console.warn(`⚠️ [StorageService] 파일 삭제 실패 ('${f}'):`, e.message);
          }
        }
      });
    });

    console.log(`🏁 [StorageService:DeleteAll] 도서('${cleanId}') 일괄 삭제 완료: 총 ${deletedCount}개 실물 파일 파쇄 (폴더: ${userFolder || 'root'})`);
    return deletedCount;
  },

  // =========================================================================
  // ⚙️ 3. 전역 설정, 통계, 업적, 묘비 전용 I/O
  // =========================================================================
  /**
   * 전역 설정 JSON 파일 저장
   * @param {string} fileName 
   * @param {any} data 
   * @param {string|null} [userFolder=null]
   * @returns {boolean}
   */
  saveSettingsFile(fileName, data, userFolder = null) {
    const safeName = sanitizeFileName(fileName);
    if (!safeName) throw new Error('유효하지 않은 설정 파일명입니다.');

    const ctx = resolveStorageContext(userFolder);
    ensureDir(ctx.settingsDir);
    const targetFile = path.join(ctx.settingsDir, safeName);

    const pathCheck = validateSafePath(ctx.settingsDir, safeName);
    if (!pathCheck.safe) {
      throw new Error(`안전하지 않은 설정 경로: ${pathCheck.reason}`);
    }

    writeJsonSafely(targetFile, data);
    console.log(`⚙️ [StorageService:SettingsSaved] 설정 파일 저장 완료: '${safeName}' (경로: ${ctx.settingsDir})`);
    return true;
  },

  /**
   * 전역 설정 JSON 파일 읽기
   * @param {string} fileName 
   * @param {string|null} [userFolder=null]
   * @returns {any|null}
   */
  getSettingsFile(fileName, userFolder = null) {
    const safeName = sanitizeFileName(fileName);
    if (!safeName) return null;

    const ctx = resolveStorageContext(userFolder);
    const pathCheck = validateSafePath(ctx.settingsDir, safeName);
    if (!pathCheck.safe) return null;

    const targetFile = path.join(ctx.settingsDir, safeName);
    return readJsonSafely(targetFile);
  },

  // =========================================================================
  // 🔬 4. 크래시 리포트 전용 I/O
  // =========================================================================
  /**
   * 뷰어 조판 결함 및 크래시 리포트 저장
   * @param {string} fileName 
   * @param {any} data 
   * @returns {boolean}
   */
  saveCrashReport(fileName, data) {
    const safeName = sanitizeFileName(fileName);
    if (!safeName) throw new Error('유효하지 않은 크래시 리포트 파일명입니다.');

    ensureDir(CRASH_REPORTS_DIR);
    const targetFile = path.join(CRASH_REPORTS_DIR, safeName);

    const pathCheck = validateSafePath(CRASH_REPORTS_DIR, safeName);
    if (!pathCheck.safe) {
      throw new Error(`안전하지 않은 크래시 리포트 경로: ${pathCheck.reason}`);
    }

    writeJsonSafely(targetFile, data);
    console.log(`🔬 [StorageService] 크래시 리포트 저장 완료: '${safeName}'`);
    return true;
  },

  /**
   * 수집된 크래시 리포트 파일 목록 조회
   * @returns {Array<Object>}
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
   * 특정 크래시 리포트 파일 경로 및 크기 반환
   * @param {string} fileName 
   * @returns {{ filePath: string, size: number } | null}
   */
  getCrashReportPath(fileName) {
    const safeName = sanitizeFileName(fileName);
    if (!safeName) return null;

    const pathCheck = validateSafePath(CRASH_REPORTS_DIR, safeName);
    if (!pathCheck.safe) return null;

    const fullPath = path.join(CRASH_REPORTS_DIR, safeName);
    if (fs.existsSync(fullPath)) {
      const stat = fs.statSync(fullPath);
      return { filePath: fullPath, size: stat.size };
    }
    return null;
  },

  /**
   * 단일 크래시 리포트 파일 삭제
   * @param {string} fileName 
   * @returns {boolean}
   */
  deleteCrashReport(fileName) {
    const safeName = sanitizeFileName(fileName);
    if (!safeName) return false;

    const pathCheck = validateSafePath(CRASH_REPORTS_DIR, safeName);
    if (!pathCheck.safe) return false;

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

  /**
   * 수집된 모든 크래시 리포트 파일 일괄 삭제
   * @returns {number} 삭제된 리포트 개수
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
    return count;
  },

  // =========================================================================
  // 🔍 5. 서버 디렉터리 탐색 및 권한 실측 엔진
  // =========================================================================
  /**
   * 특정 디렉터리의 존재 여부, 접근 권한 실측 검사
   * @param {string} dirPath 
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
   * 관리자 지정 폴더의 하위 디렉터리 목록 트리 반환
   * @param {string} [targetPath='/'] 
   * @returns {{ currentPath: string, parentPath: string|null, directories: Array<Object> }}
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
  // 📚 6. 관리자 지정 공유 폴더 도서 스캔 및 직통 복사 엔진
  // =========================================================================
  /**
   * 공유 폴더 내 EPUB/TXT 도서 재귀 스캔
   * @param {string} sharedDir 
   * @returns {Array<Object>}
   */
  getRemoteBooks(sharedDir) {
    if (!sharedDir || !fs.existsSync(sharedDir)) {
      return [];
    }

    const books = [];
    const maxDepth = 8;

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
            if (isAllowedBookFile(entry.name)) {
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

  /**
   * 공유 폴더 내 특정 도서의 안전 실물 파일 경로 반환
   * @param {string} sharedDir 
   * @param {string} relativeFilePath 
   * @returns {{ filePath: string, size: number, fileName: string } | null}
   */
  getRemoteBookFilePath(sharedDir, relativeFilePath) {
    if (!sharedDir || !relativeFilePath) return null;

    if (!isAllowedBookFile(relativeFilePath)) {
      console.warn(`⛔ [SecurityGuard Blocked] 허용되지 않은 파일 확장자 요청: '${relativeFilePath}'`);
      return null;
    }

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
   * @param {string|null} [userFolder=null] - 대상 사용자 폴더명
   * @returns {Object|null}
   */
  importRemoteBookToLibrary(sharedDir, relativeFilePath, userFolder = null) {
    if (!sharedDir || !relativeFilePath) return null;

    if (!isAllowedBookFile(relativeFilePath)) {
      throw new Error('허용되지 않은 도서 파일 형식입니다 (.epub, .txt 만 가능).');
    }

    const safeSourcePath = resolveSafeRelativePath(sharedDir, relativeFilePath);
    if (!safeSourcePath || !fs.existsSync(safeSourcePath)) {
      throw new Error('원본 도서 파일을 찾을 수 없거나 보안 검증에 실패했습니다.');
    }

    const stat = fs.statSync(safeSourcePath);
    if (!stat.isFile() || stat.size === 0) {
      throw new Error('유효하지 않은 도서 파일이거나 0바이트 빈 파일입니다.');
    }

    const rawFileName = path.basename(safeSourcePath);
    const cleanBaseName = rawFileName.replace(/\.(epub|txt)$/i, '').replace(/_\d+$/, '').trim();
    const ext = path.extname(rawFileName).toLowerCase();
    const isTxt = ext === '.txt';

    const fileName = `${cleanBaseName}${ext}`;
    const safeBookId = sanitizeFileName(`${fileName}_${stat.size}`);
    const cleanTitle = cleanBaseName;
    const nowIso = new Date().toISOString();

    const ctx = resolveStorageContext(userFolder);
    ensureDir(ctx.booksDir);

    const targetEpubPath = path.join(ctx.booksDir, `${safeBookId}.epub`);

    const pathCheck = validateSafePath(ctx.booksDir, `${safeBookId}.epub`);
    if (!pathCheck.safe) {
      throw new Error(`복사 대상 경로 보안 오류: ${pathCheck.reason}`);
    }

    fs.copyFileSync(safeSourcePath, targetEpubPath);

    console.log(`⚡ [StorageService:Import] 서버 내부 0초 도서 복사 완료 (언더바 규격):`, {
      originalSource: safeSourcePath,
      targetDestination: targetEpubPath,
      existsOnDisk: fs.existsSync(targetEpubPath),
      savedSizeBytes: stat.size,
      bookId: safeBookId,
      userFolder: userFolder || 'root'
    });

    const bookData = {
      bookId: safeBookId,
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

    this.saveBookMetadata(safeBookId, bookData, userFolder);
    console.log(`📖 [StorageService:Import] 정규 도서 메타데이터 자동 각인 완료: '${safeBookId}.json' (폴더: ${userFolder || 'root'})`);

    return {
      ok: true,
      bookId: safeBookId,
      bookData,
      size: stat.size,
      fileName
    };
  }
};