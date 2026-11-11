/**
 * @file src/services/storage/bookStorageEngine.js
 * @description 도서 메타데이터, EPUB 바이너리, WebP 표지 I/O, 원자적 보관/복원 이동, 도서 완전 삭제 및 올인원 통합 스냅샷/고아 표지 자가소독 엔진
 * - ⚡ [올인원 통합 스냅샷 단일 쿼리] getUnifiedSnapshot으로 도서, 보관함, 설정, 통계, 업적, 묘비 일괄 취합
 * - 🧹 [고아 표지 서버 메타데이터 자동 자가 소독] 디스크에 실물 파일이 없는 낡은 cloudCoverFileName을 실측 검증하여 영구 소독
 * - 📁 [원자적 도서 보관/복원 동기화] saveBookMetadata 실행 시 메타 JSON, .epub 원본, 모든 표지(.cover_) 파일을 books/ ⇄ archive/ 간 원자적 동시 이동
 * - 🎯 [6대 지능형 교차 탐색 ➔ 404 원천 박멸] getBookEpubPath, getCoverImagePath에 NFC/NFD 유니코드 및 구버전 파일명 폴백 탑재
 * - 🛡️ [securityGuard 결속] validateSafePath 기반 심볼릭 링크 탈출 차단 및 실측 검증
 * - 🖼️ [단일 표지 안전 삭제 & 완전 삭제] deleteCoverImage 및 deleteBookAll로 디스크 잔존 파일 영구 파쇄
 */

import fs from 'fs';
import path from 'path';
import { validateSafePath } from '../../securityGuard.js';
import {
  sanitizeFileName,
  generateFilenameCandidates,
  ensureDir,
  readJsonSafely,
  writeJsonSafely,
  resolveStorageContext
} from './storageContext.js';

// =========================================================================
// ⚡ 1. 올인원 통합 스냅샷 수집 및 고아 표지 자가 소독 엔진
// =========================================================================

/**
 * 도서 메타데이터, 보관 도서, 전역 설정, 통계, 업적, 묘비를 단일 객체로 취합하여 반환
 * @param {string|null} [userFolder=null] 
 * @returns {Promise<Object>}
 */
export async function getUnifiedSnapshot(userFolder = null) {
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
          const coverCheck = getCoverImagePath(bookMeta.cloudCoverFileName, userFolder);
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
          const coverCheck = getCoverImagePath(archivedMeta.cloudCoverFileName, userFolder);
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
}

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
export function saveBookMetadata(bookId, bookData, userFolder = null) {
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
}

/**
 * 🔍 특정 도서 메타데이터 조회 (3단계 지능형 교차 탐색)
 * @param {string} bookId 
 * @param {string|null} [userFolder=null]
 * @returns {Object|null}
 */
export function getBookMetadata(bookId, userFolder = null) {
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
}

/**
 * EPUB 원본 파일 바이너리 저장 (보관 도서 스마트 라우팅 지원)
 * @param {string} bookId 
 * @param {Buffer} buffer 
 * @param {string|null} [userFolder=null]
 * @returns {boolean}
 */
export function saveBookEpub(bookId, buffer, userFolder = null) {
  const safeId = sanitizeFileName(bookId);
  if (!safeId) throw new Error('유효하지 않은 bookId 입니다.');

  const ctx = resolveStorageContext(userFolder);
  ensureDir(ctx.booksDir);
  ensureDir(ctx.archiveDir);

  const isArchived = fs.existsSync(path.join(ctx.archiveDir, `${safeId}.json`));
  const targetDir = isArchived ? ctx.archiveDir : ctx.booksDir;
  const targetFile = path.join(targetDir, `${safeId}.epub`);

  const pathCheck = validateSafePath(targetDir, `${safeId}.epub`);
  if (!pathCheck.safe) {
    throw new Error(`안전하지 않은 EPUB 저장 경로: ${pathCheck.reason}`);
  }

  fs.writeFileSync(targetFile, buffer);
  console.log(`📦 [StorageService] EPUB 바이너리 저장 완료: '${safeId}.epub' ➔ ${isArchived ? 'archive/' : 'books/'} (${(buffer.length / 1024 / 1024).toFixed(2)} MB, 폴더: ${userFolder || 'root'})`);
  return true;
}

/**
 * 🎯 EPUB 원본 파일 경로 반환 (3단계 지능형 교차 탐색 ➔ 404 박멸)
 * @param {string} bookId 
 * @param {string|null} [userFolder=null]
 * @returns {{ filePath: string, size: number } | null}
 */
export function getBookEpubPath(bookId, userFolder = null) {
  if (!bookId) {
    console.warn('⚠️ [StorageService:GetEpub] bookId가 비어 있습니다.');
    return null;
  }

  const candidates = generateFilenameCandidates(bookId);
  const ctx = resolveStorageContext(userFolder);

  for (const dir of [ctx.booksDir, ctx.archiveDir]) {
    if (!fs.existsSync(dir)) continue;

    for (const cand of candidates) {
      const filePath = path.join(dir, `${cand}.epub`);
      const exists = fs.existsSync(filePath);

      if (exists) {
        try {
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
}

/**
 * 표지 이미지 바이너리 저장 (보관 도서 스마트 라우팅 지원)
 * @param {string} fileName 
 * @param {Buffer} buffer 
 * @param {string|null} [userFolder=null]
 * @returns {boolean}
 */
export function saveCoverImage(fileName, buffer, userFolder = null) {
  const cleanRaw = String(fileName || '').replace(/^covers[/\\]/i, '');
  const safeName = sanitizeFileName(cleanRaw);
  if (!safeName) throw new Error('유효하지 않은 표지 파일명입니다.');

  const ctx = resolveStorageContext(userFolder);
  ensureDir(ctx.booksDir);
  ensureDir(ctx.archiveDir);

  const prefixMatch = safeName.match(/^(.*?)\.cover_/);
  const bookPrefix = prefixMatch ? prefixMatch[1] : '';
  const isArchived = bookPrefix && fs.existsSync(path.join(ctx.archiveDir, `${bookPrefix}.json`));

  const targetDir = isArchived ? ctx.archiveDir : ctx.booksDir;
  const targetFile = path.join(targetDir, safeName);

  const pathCheck = validateSafePath(targetDir, safeName);
  if (!pathCheck.safe) {
    throw new Error(`안전하지 않은 표지 저장 경로: ${pathCheck.reason}`);
  }

  fs.writeFileSync(targetFile, buffer);
  console.log(`🖼️ [StorageService] 표지 저장 완료: '${safeName}' ➔ ${isArchived ? 'archive/' : 'books/'} (${(buffer.length / 1024).toFixed(1)} KB, 폴더: ${userFolder || 'root'})`);
  return true;
}

/**
 * 🎯 [표지 이미지 실물 경로 정밀 탐색 엔진]
 * @param {string} fileName 
 * @param {string|null} [userFolder=null]
 * @returns {{ filePath: string, size: number } | null}
 */
export function getCoverImagePath(fileName, userFolder = null) {
  if (!fileName) return null;

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
}

/**
 * 단일 표지 이미지 파일 삭제
 * @param {string} fileName 
 * @param {string|null} [userFolder=null]
 * @returns {boolean}
 */
export function deleteCoverImage(fileName, userFolder = null) {
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
}

/**
 * 🗑️ 도서 완전 삭제 (메타데이터 JSON, EPUB 본문, 모든 WebP 표지 일괄 영구 파쇄)
 * @param {string} bookId 
 * @param {string|null} [userFolder=null]
 * @returns {number} 실제 삭제된 파일 총 개수
 */
export function deleteBookAll(bookId, userFolder = null) {
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
}