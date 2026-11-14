/**
 * @file src/services/storage/adminLibraryInspector.js
 * @description 관리자용 사용자 서재(user_xxxx) 디스크 실측, 이상 파일 탐지, 개별/전체 삭제, CFI 초기화 및 묘비 관리 ESM 서비스
 * - 🔒 [엄격 사용자 샌드박스] user_xxxx 폴더만 허용하고 validateSafePath 실측 검증을 거쳐 Root 영역 접근 원천 차단
 * - 🔍 [디스크 실측 그룹핑] books/ 및 archive/ 실물 파일(.json/.epub/.cover_*.webp/찌꺼기) 전수 스캔 및 7대 이상 징후 탐지
 * - 🎯 [동기화 규칙 완벽 호응] 표지 삭제·CFI 초기화 시 lastModified를 현재 시각으로 갱신하여 웹뷰어 역덮어쓰기(Push) 차단
 * - 🪦 [묘비 정밀 제어] 전체 삭제 시 선택적 deleted-books.json 등록 및 특정 bookId 묘비 핀포인트 해제 지원
 */

import fs from 'fs';
import path from 'path';
import { validateSafePath } from '../../securityGuard.js';
import {
  USERS_DIR,
  resolveStorageContext,
  readJsonSafely,
  writeJsonSafely
} from './storageContext.js';
import { deleteBookAll, deleteCoverImage } from './bookStorageEngine.js';

/**
 * 🔒 관리자 도서 조회/삭제 대상이 유효한 일반 사용자 서재(user_xxxx)인지 검증합니다.
 * @param {string} userFolder - 대상 사용자 폴더명
 * @returns {string} 검증 및 정규화된 사용자 폴더명
 */
function assertValidUserFolder(userFolder) {
  if (!userFolder || typeof userFolder !== 'string') {
    throw new Error('INVALID_USER_FOLDER: 사용자 폴더명이 비어 있습니다.');
  }
  const cleanFolder = path.basename(userFolder.trim());
  if (!cleanFolder.startsWith('user_')) {
    throw new Error('INVALID_USER_FOLDER: 일반 사용자 서재(user_*)만 관리할 수 있습니다.');
  }
  const check = validateSafePath(USERS_DIR, cleanFolder);
  if (!check.safe) {
    throw new Error(`INVALID_USER_FOLDER: 안전하지 않은 경로입니다 (${check.reason}).`);
  }
  return cleanFolder;
}

/**
 * 📄 디스크 파일명으로부터 파일 역할과 도서 식별 스템(bookId)을 분리합니다.
 * @param {string} fileName - 디스크 실물 파일명
 * @returns {{ type: 'json'|'epub'|'cover'|'other', bookId: string|null }}
 */
function parseDiskAssetFile(fileName) {
  if (!fileName || fileName.includes('.tmp_')) {
    return { type: 'other', bookId: null };
  }
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.json')) {
    return { type: 'json', bookId: fileName.slice(0, -5) };
  }
  if (lower.endsWith('.epub')) {
    return { type: 'epub', bookId: fileName.slice(0, -5) };
  }
  const coverMatch = fileName.match(/^(.*?)\.cover_[^.]+\.webp$/i);
  if (coverMatch && coverMatch[1]) {
    return { type: 'cover', bookId: coverMatch[1] };
  }
  return { type: 'other', bookId: null };
}

/**
 * 🔍 특정 사용자의 books/, archive/, settings/deleted-books.json 상태를 전수 실측 진단합니다.
 * @param {string} userFolder - 사용자 폴더명 (예: user_a1b2c3d4)
 * @returns {{
 *   userFolder: string,
 *   summary: { totalBooks: number, activeCount: number, archivedCount: number, anomalyCount: number, orphanFileCount: number, tombstoneCount: number },
 *   books: Array<Object>,
 *   orphanFiles: Array<Object>,
 *   tombstones: Array<Object>
 * }}
 */
export function inspectUserLibrary(userFolder) {
  const cleanFolder = assertValidUserFolder(userFolder);
  const ctx = resolveStorageContext(cleanFolder);

  const booksMap = new Map();
  const orphanFiles = [];

  const ensureEntry = (bookId) => {
    if (!booksMap.has(bookId)) {
      booksMap.set(bookId, {
        bookId,
        title: bookId,
        locations: new Set(),
        jsonFiles: [],
        epubFiles: [],
        coverFiles: [],
        parsedMeta: null,
        jsonCorrupted: false,
        progress: '0.0%',
        lastCfi: '',
        isRecordOnly: false,
        cloudCoverFileName: '',
        lastModified: null,
        anomalies: []
      });
    }
    return booksMap.get(bookId);
  };

  const scanDir = (dirPath, location) => {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fileName = entry.name;
      const fullPath = path.join(dirPath, fileName);
      let sizeBytes = 0;
      let mtimeIso = null;
      try {
        const st = fs.statSync(fullPath);
        sizeBytes = st.size;
        mtimeIso = st.mtime.toISOString();
      } catch (_) {}

      const parsed = parseDiskAssetFile(fileName);
      if (parsed.type === 'other' || !parsed.bookId) {
        orphanFiles.push({
          fileName,
          location,
          sizeBytes,
          mtime: mtimeIso,
          reason: fileName.includes('.tmp_') ? 'TEMP_FILE' : 'UNRECOGNIZED_FILE'
        });
        continue;
      }

      const item = ensureEntry(parsed.bookId);
      item.locations.add(location);

      if (parsed.type === 'json') {
        let metaObj = null;
        let isCorrupted = false;
        try {
          const raw = fs.readFileSync(fullPath, 'utf-8');
          const obj = JSON.parse(raw);
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            metaObj = obj;
          } else {
            isCorrupted = true;
          }
        } catch (_) {
          isCorrupted = true;
        }

        item.jsonFiles.push({ fileName, location, sizeBytes, corrupted: isCorrupted });
        if (isCorrupted) {
          item.jsonCorrupted = true;
        } else if (metaObj) {
          item.parsedMeta = metaObj;
          item.title = metaObj.title || metaObj.fileName || parsed.bookId;
          item.progress = metaObj.progress || '0.0%';
          item.lastCfi = metaObj.lastCfi || '';
          item.isRecordOnly = Boolean(metaObj.isRecordOnly);
          item.cloudCoverFileName = metaObj.cloudCoverFileName || '';
          item.lastModified = metaObj.lastModified || metaObj.lastReadDate || mtimeIso;
        }
      } else if (parsed.type === 'epub') {
        item.epubFiles.push({ fileName, location, sizeBytes });
      } else if (parsed.type === 'cover') {
        item.coverFiles.push({ fileName, location, sizeBytes });
      }
    }
  };

  scanDir(ctx.booksDir, 'books');
  scanDir(ctx.archiveDir, 'archive');

  let activeCount = 0;
  let archivedCount = 0;
  let anomalyCount = 0;

  const books = Array.from(booksMap.values()).map((item) => {
    const locs = Array.from(item.locations);
    const primaryLocation = locs.length > 1 ? 'both' : (locs[0] || 'books');

    if (item.jsonCorrupted) item.anomalies.push('JSON_CORRUPTED');
    if (item.jsonFiles.length === 0 && (item.epubFiles.length > 0 || item.coverFiles.length > 0)) {
      item.anomalies.push('JSON_MISSING');
    }
    if (item.jsonFiles.length > 0 && !item.jsonCorrupted && !item.isRecordOnly && item.epubFiles.length === 0) {
      item.anomalies.push('EPUB_MISSING');
    }
    if (item.epubFiles.some((e) => e.sizeBytes === 0)) {
      item.anomalies.push('ZERO_BYTE_EPUB');
    }
    if (locs.length > 1) {
      item.anomalies.push('DUPLICATE_LOCATION');
    }
    if (
      !item.jsonCorrupted &&
      item.cloudCoverFileName &&
      item.cloudCoverFileName !== '없음' &&
      !item.coverFiles.some((c) => c.fileName === item.cloudCoverFileName)
    ) {
      item.anomalies.push('ORPHAN_COVER_REF');
    }

    if (primaryLocation === 'archive') archivedCount++;
    else activeCount++;
    if (item.anomalies.length > 0) anomalyCount++;

    const totalSizeBytes =
      item.jsonFiles.reduce((s, f) => s + f.sizeBytes, 0) +
      item.epubFiles.reduce((s, f) => s + f.sizeBytes, 0) +
      item.coverFiles.reduce((s, f) => s + f.sizeBytes, 0);

    return {
      bookId: item.bookId,
      title: item.title,
      location: primaryLocation,
      progress: item.progress,
      lastCfi: item.lastCfi,
      isRecordOnly: item.isRecordOnly,
      cloudCoverFileName: item.cloudCoverFileName,
      lastModified: item.lastModified,
      jsonFiles: item.jsonFiles,
      epubFiles: item.epubFiles,
      coverFiles: item.coverFiles,
      totalSizeBytes,
      anomalies: item.anomalies
    };
  });

  books.sort((a, b) => {
    if (a.anomalies.length !== b.anomalies.length) return b.anomalies.length - a.anomalies.length;
    return new Date(b.lastModified || 0) - new Date(a.lastModified || 0);
  });

  const tombstonePath = path.join(ctx.settingsDir, 'deleted-books.json');
  const rawTombstones = readJsonSafely(tombstonePath);
  const tombstones = (Array.isArray(rawTombstones) ? rawTombstones : [])
    .filter((t) => t && t.bookId)
    .sort((a, b) => new Date(b.deletedAt || 0) - new Date(a.deletedAt || 0));

  return {
    userFolder: cleanFolder,
    summary: {
      totalBooks: books.length,
      activeCount,
      archivedCount,
      anomalyCount,
      orphanFileCount: orphanFiles.length,
      tombstoneCount: tombstones.length
    },
    books,
    orphanFiles,
    tombstones
  };
}

/**
 * 🛡️ 지정 디렉터리 내 단일 실물 파일을 안전하게 삭제합니다.
 * @param {string} dirPath - booksDir 또는 archiveDir 절대 경로
 * @param {string} fileName - 삭제할 파일명
 * @returns {boolean} 실제 삭제 여부
 */
function safeUnlinkInDir(dirPath, fileName) {
  if (!dirPath || !fileName || !fs.existsSync(dirPath)) return false;
  const cleanName = path.basename(fileName);
  const check = validateSafePath(dirPath, cleanName);
  if (!check.safe || !fs.existsSync(check.realPath)) return false;
  try {
    const stat = fs.statSync(check.realPath);
    if (!stat.isFile()) return false;
    fs.unlinkSync(check.realPath);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 🖼️ 표지 삭제 시 해당 도서 메타데이터 JSON의 표지 태그를 비우고 lastModified를 현재 시각으로 갱신합니다.
 * (웹뷰어 syncPriorityExecutor가 로컬 구버전 표지를 서버로 재업로드하는 현상 차단)
 * @param {Object} ctx - resolveStorageContext 결과
 * @param {string} bookId - 대상 도서 ID
 * @param {string|null} [onlyIfMatchesFileName=null] - 특정 파일명을 참조할 때만 비울 경우 지정
 * @returns {boolean} JSON 갱신 여부
 */
function clearCoverTagsInBookJson(ctx, bookId, onlyIfMatchesFileName = null) {
  let updatedAny = false;
  const nowIso = new Date().toISOString();

  for (const dir of [ctx.booksDir, ctx.archiveDir]) {
    if (!fs.existsSync(dir)) continue;
    const jsonName = `${path.basename(bookId)}.json`;
    const check = validateSafePath(dir, jsonName);
    if (!check.safe || !fs.existsSync(check.realPath)) continue;

    const meta = readJsonSafely(check.realPath);
    if (!meta || typeof meta !== 'object') continue;

    if (onlyIfMatchesFileName && meta.cloudCoverFileName && meta.cloudCoverFileName !== onlyIfMatchesFileName) {
      meta.lastModified = nowIso;
      writeJsonSafely(check.realPath, meta);
      updatedAny = true;
      continue;
    }

    meta.cloudCoverFileName = '';
    meta.cloudCovers = [];
    meta.coverHash = '';
    meta.coverUrl = '';
    meta.covers = [];
    meta.coverShuffle = false;
    meta.lastModified = nowIso;
    writeJsonSafely(check.realPath, meta);
    updatedAny = true;
  }

  return updatedAny;
}

/**
 * 🗑️ 사용자 서재의 도서 전체, 개별 자산(.json/.epub/표지), CFI 또는 고아 파일을 정밀 삭제/초기화합니다.
 * @param {string} userFolder - 사용자 폴더명
 * @param {Object} options
 * @param {'delete-all'|'reset-cfi'|'delete-json'|'delete-epub'|'delete-covers'|'delete-single-file'} options.action
 * @param {string} [options.bookId] - 대상 도서 ID
 * @param {string} [options.fileName] - delete-single-file 시 대상 파일명
 * @param {'books'|'archive'|'both'} [options.location='both'] - 대상 폴더 범위
 * @param {boolean} [options.addToTombstone=false] - delete-all 시 deleted-books.json 등록 여부
 * @param {string} [options.title=''] - 묘비 등록용 도서 제목
 * @returns {{ ok: boolean, action: string, deletedCount: number, message: string }}
 */
export function deleteUserBookAsset(userFolder, options = {}) {
  const cleanFolder = assertValidUserFolder(userFolder);
  const ctx = resolveStorageContext(cleanFolder);
  const {
    action,
    bookId = '',
    fileName = '',
    location = 'both',
    addToTombstone = false,
    title = ''
  } = options;

  const targetDirs = [];
  if (location === 'books' || location === 'both') targetDirs.push(ctx.booksDir);
  if (location === 'archive' || location === 'both') targetDirs.push(ctx.archiveDir);

  if (action === 'delete-single-file') {
    if (!fileName || (location !== 'books' && location !== 'archive')) {
      throw new Error('INVALID_PARAMS: 단일 파일 삭제에는 location(books/archive)과 fileName이 필요합니다.');
    }
    const targetDir = location === 'archive' ? ctx.archiveDir : ctx.booksDir;
    const removed = safeUnlinkInDir(targetDir, fileName);
    if (!removed) {
      throw new Error('FILE_NOT_FOUND: 삭제할 파일을 찾을 수 없습니다.');
    }

    const coverMatch = path.basename(fileName).match(/^(.*?)\.cover_[^.]+\.webp$/i);
    if (coverMatch && coverMatch[1]) {
      clearCoverTagsInBookJson(ctx, coverMatch[1], path.basename(fileName));
    }

    return { ok: true, action, deletedCount: 1, message: `'${path.basename(fileName)}' 파일이 삭제되었습니다.` };
  }

  if (!bookId || typeof bookId !== 'string') {
    throw new Error('INVALID_BOOK_ID: 도서 ID가 누락되었습니다.');
  }
  const cleanBookId = path.basename(bookId);

  if (action === 'delete-all') {
    let deletedCount = deleteBookAll(cleanBookId, cleanFolder);
    for (const dir of [ctx.booksDir, ctx.archiveDir]) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f === `${cleanBookId}.json` || f === `${cleanBookId}.epub` || f.startsWith(`${cleanBookId}.cover_`)) {
          if (safeUnlinkInDir(dir, f)) deletedCount++;
        }
      }
    }

    if (addToTombstone) {
      const tombstonePath = path.join(ctx.settingsDir, 'deleted-books.json');
      const existing = readJsonSafely(tombstonePath);
      const list = Array.isArray(existing) ? existing.filter((t) => t && t.bookId !== cleanBookId) : [];
      list.unshift({
        bookId: cleanBookId,
        title: title || cleanBookId,
        deletedAt: new Date().toISOString(),
        deviceId: 'admin_console',
        deviceName: 'Admin Console'
      });
      writeJsonSafely(tombstonePath, list.slice(0, 500));
    }

    return {
      ok: true,
      action,
      deletedCount,
      message: `도서 관련 파일 ${deletedCount}개 삭제 완료${addToTombstone ? ' (묘비 등록됨)' : ' (서버만 정리)'}`
    };
  }

  if (action === 'reset-cfi') {
    let resetDone = false;
    const nowIso = new Date().toISOString();

    for (const dir of targetDirs) {
      if (!fs.existsSync(dir)) continue;
      const jsonName = `${cleanBookId}.json`;
      const check = validateSafePath(dir, jsonName);
      if (!check.safe || !fs.existsSync(check.realPath)) continue;

      const meta = readJsonSafely(check.realPath);
      if (!meta || typeof meta !== 'object') {
        throw new Error('JSON 파일이 손상되어 CFI를 초기화할 수 없습니다. 메타(.json)만 삭제를 이용해 주세요.');
      }

      meta.lastCfi = '0';
      meta.progress = '0.0%';
      meta.readCharacters = 0;
      meta.completed = false;
      meta.lastModified = nowIso;
      meta.lastReadDate = nowIso;
      writeJsonSafely(check.realPath, meta);
      resetDone = true;
    }

    if (!resetDone) {
      throw new Error('META_NOT_FOUND: 초기화할 메타(.json) 파일을 찾지 못했습니다.');
    }

    return { ok: true, action, deletedCount: 0, message: 'CFI 및 진도율이 0.0%로 초기화되었습니다.' };
  }

  if (action === 'delete-json') {
    let deletedCount = 0;
    for (const dir of targetDirs) {
      if (safeUnlinkInDir(dir, `${cleanBookId}.json`)) deletedCount++;
    }
    return { ok: true, action, deletedCount, message: `메타데이터(.json) ${deletedCount}개 삭제 완료` };
  }

  if (action === 'delete-epub') {
    let deletedCount = 0;
    for (const dir of targetDirs) {
      if (safeUnlinkInDir(dir, `${cleanBookId}.epub`)) deletedCount++;
    }
    return { ok: true, action, deletedCount, message: `본문 파일(.epub) ${deletedCount}개 삭제 완료` };
  }

  if (action === 'delete-covers') {
    let deletedCount = 0;
    for (const dir of targetDirs) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(`${cleanBookId}.cover_`) && f.toLowerCase().endsWith('.webp')) {
          if (safeUnlinkInDir(dir, f)) deletedCount++;
        }
      }
    }
    const updatedJson = clearCoverTagsInBookJson(ctx, cleanBookId, null);
    if (deletedCount === 0 && updatedJson) {
      deleteCoverImage(`${cleanBookId}.cover_0.webp`, cleanFolder);
    }
    return { ok: true, action, deletedCount, message: `표지 파일 ${deletedCount}개 삭제 및 메타 표지 태그 정리 완료` };
  }

  throw new Error(`UNSUPPORTED_ACTION: 지원하지 않는 작업입니다 (${action}).`);
}

/**
 * 🪦 특정 사용자의 deleted-books.json 묘비 장부에서 지정된 bookId 항목만 핀포인트 제거합니다.
 * @param {string} userFolder - 사용자 폴더명
 * @param {string} bookId - 묘비에서 해제할 도서 ID
 * @returns {{ ok: boolean, removedCount: number, remainingCount: number }}
 */
export function removeUserTombstone(userFolder, bookId) {
  const cleanFolder = assertValidUserFolder(userFolder);
  if (!bookId || typeof bookId !== 'string') {
    throw new Error('INVALID_BOOK_ID: 해제할 도서 ID가 비어 있습니다.');
  }

  const ctx = resolveStorageContext(cleanFolder);
  const tombstonePath = path.join(ctx.settingsDir, 'deleted-books.json');
  const existing = readJsonSafely(tombstonePath);
  const list = Array.isArray(existing) ? existing : [];

  const filtered = list.filter((t) => t && t.bookId !== bookId);
  const removedCount = list.length - filtered.length;

  if (removedCount > 0) {
    writeJsonSafely(tombstonePath, filtered);
  }

  return {
    ok: true,
    removedCount,
    remainingCount: filtered.length
  };
}