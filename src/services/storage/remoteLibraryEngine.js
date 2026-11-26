/**
 * @file src/services/storage/remoteLibraryEngine.js
 * @description 관리자 디렉터리 트리 탐색, 권한 실측, 외부 공유 서재 스캔 및 서버 내부 0초 도서 직통 복사(Import) 엔진
 * - 🔍 [디렉터리 트리 & 권한 실측] testDirectoryPermissions 및 getDirectoryTree로 관리자 탐색기 제어
 * - 🛡️ [O(1) 권한 판정 SSOT] checkRemoteLibraryAccessible로 도서 재귀 스캔 없이 기기별 공유 도서함 접근 가능 여부 판정
 * - 📚 [공유 폴더 도서 재귀 스캔] getRemoteBooks로 외부 라이브러리 내 .epub/.txt 도서 실시간 수집
 * - ⚡ [서버 내부 0초 직통 복사 & 용량 통제] importRemoteBookToLibrary로 quotaBytes 실측 검증 후 books/ 안착 및 기존 기록 보존
 * - 🛡️ [확장자 & 심볼릭 링크 보안] isAllowedBookFile 및 resolveSafeRelativePath로 탈출 시도 실측 차단
 */

import fs from 'fs';
import path from 'path';
import { validateSafePath, isAllowedBookFile } from '../../securityGuard.js';
import {
  sanitizeFileName,
  resolveSafeRelativePath,
  resolveStorageContext,
  checkUserStorageQuota,
  ensureDir
} from './storageContext.js';
import { getBookMetadata, saveBookMetadata } from './bookStorageEngine.js';

// 📁 다중 공유 폴더 설정 저장 파일 경로
const SHARED_FOLDERS_CONFIG_FILE = './data/shared_folders.json';

/**
 * 💾 다중 공유 폴더 설정 안전 저장 헬퍼
 * @param {Object} config - 저장할 공유 폴더 설정 객체
 * @returns {void}
 */
export function saveSharedFoldersConfig(config) {
  try {
    const dir = path.dirname(SHARED_FOLDERS_CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SHARED_FOLDERS_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) {
    console.error('❌ [StorageService] shared_folders.json 저장 실패:', e.message);
  }
}

/**
 * 📂 다중 공유 폴더 설정 안전 조회 헬퍼 (하위 호환성 100% 보장)
 * @param {Object} [env={}] - 환경 변수 객체
 * @returns {{ enabled: boolean, folders: Array<{ id: string, name: string, path: string, enabled: boolean, allowedDevices: string[] }> }}
 */
export function getSharedFoldersConfig(env = {}) {
  let config = { enabled: true, folders: [] };

  if (fs.existsSync(SHARED_FOLDERS_CONFIG_FILE)) {
    try {
      const raw = fs.readFileSync(SHARED_FOLDERS_CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = {
          enabled: parsed.enabled !== false,
          folders: Array.isArray(parsed.folders) ? parsed.folders : []
        };
      }
    } catch (e) {
      console.warn('⚠️ [StorageService] shared_folders.json 파싱 실패 (기본값 복구):', e.message);
    }
  }

  const legacyDir = env?.SHARED_BOOKS_DIR;
  if (config.folders.length === 0 && legacyDir && fs.existsSync(legacyDir)) {
    config.folders.push({
      id: 'default',
      name: '기본 공유 서재',
      path: legacyDir,
      enabled: true,
      allowedDevices: ['*']
    });
    saveSharedFoldersConfig(config);
  }

  return config;
}

/**
 * 🛡️ 도서 재귀 스캔 없이 현재 기기/계정의 공유 도서함 접근 가능 여부를 O(1) 폴더 실측으로 판정합니다.
 * @param {Object} [env={}] - 환경 변수 객체
 * @param {Object} [context={}] - 인증 컨텍스트
 * @param {boolean} [context.isRootAdmin=false] - 루트 관리자/웹 세션 여부
 * @param {string} [context.deviceId=''] - 요청 기기 식별자
 * @returns {boolean} 공유 도서함 접근 가능 여부
 */
export function checkRemoteLibraryAccessible(env = {}, { isRootAdmin = false, deviceId = '' } = {}) {
  if (env?.STORAGE_MODE !== 'true') {
    return false;
  }

  const config = getSharedFoldersConfig(env);
  if (!config.enabled || !Array.isArray(config.folders) || config.folders.length === 0) {
    return false;
  }

  for (const folder of config.folders) {
    if (!folder || !folder.enabled || !folder.path) continue;

    const allowedDevices = Array.isArray(folder.allowedDevices) ? folder.allowedDevices : [];
    const hasDevicePermission = Boolean(isRootAdmin)
      || allowedDevices.includes('*')
      || Boolean(deviceId && allowedDevices.includes(deviceId));

    if (!hasDevicePermission) continue;

    const permCheck = testDirectoryPermissions(folder.path);
    if (permCheck.readable) {
      return true;
    }
  }

  return false;
}

// =========================================================================
// 🔍 1. 서버 디렉터리 탐색 및 권한 실측 엔진
// =========================================================================

/**
 * 특정 디렉터리의 존재 여부, 접근 권한 실측 검사
 * @param {string} dirPath 
 * @returns {{ exists: boolean, readable: boolean, isDirectory: boolean, error?: string }}
 */
export function testDirectoryPermissions(dirPath) {
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
}

/**
 * 관리자 지정 폴더의 하위 디렉터리 목록 트리 반환
 * @param {string} [targetPath='/'] 
 * @returns {{ currentPath: string, parentPath: string|null, directories: Array<Object> }}
 */
export function getDirectoryTree(targetPath = '/') {
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
}

// =========================================================================
// 📚 2. 관리자 지정 공유 폴더 도서 스캔 및 직통 복사 엔진
// =========================================================================

/**
 * 공유 폴더 내 EPUB/TXT 도서 재귀 스캔
 * @param {string} sharedDir 
 * @returns {Array<Object>}
 */
export function getRemoteBooks(sharedDir) {
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
}

/**
 * 공유 폴더 내 특정 도서의 안전 실물 파일 경로 반환
 * @param {string} sharedDir 
 * @param {string} relativeFilePath 
 * @returns {{ filePath: string, size: number, fileName: string } | null}
 */
export function getRemoteBookFilePath(sharedDir, relativeFilePath) {
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
}

/**
 * ⚡ 공유 폴더 도서를 서버 내부 디스크에서 books/ 로 직접 복사(Import)하고 메타데이터를 생성/병합합니다.
 * - 동일한 bookId의 기존 메타데이터(books/ 또는 archive/)가 이미 존재하면 독서 진행률, CFI, 표지 등 기존 기록을 보존합니다.
 * - userFolder와 quotaBytes가 전달되면 복사 직전 사용자 할당 용량을 검증해 초과 시 STORAGE_QUOTA_EXCEEDED 예외를 발생시킵니다.
 * @param {string} sharedDir - 공유 폴더 절대 경로
 * @param {string} relativeFilePath - 공유 폴더 내 파일 상대 경로
 * @param {string|null} [userFolder=null] - 대상 사용자 폴더명
 * @param {number|null} [quotaBytes=null] - 대상 사용자 저장 용량 한도(Byte)
 * @returns {Object|null} 복사 결과 및 도서 메타데이터
 */
export function importRemoteBookToLibrary(sharedDir, relativeFilePath, userFolder = null, quotaBytes = null) {
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

  // 기존 메타데이터 선조회 (재임포트 시 기존 독서 진행률·CFI·표지 무손실 보존용)
  const existingMeta = getBookMetadata(safeBookId, userFolder);

  // 📊 사용자 저장 용량 한도 실측 검사 (기존 동일 EPUB 덮어쓰기 시 순증가분 기준)
  if (userFolder && Number.isFinite(Number(quotaBytes)) && Number(quotaBytes) > 0) {
    const metaOverheadBytes = existingMeta ? 0 : 1024;
    const quotaCheck = checkUserStorageQuota(userFolder, stat.size + metaOverheadBytes, Number(quotaBytes), {
      existingPaths: [
        targetEpubPath,
        path.join(ctx.archiveDir, `${safeBookId}.epub`)
      ]
    });
    if (!quotaCheck.allowed) {
      const err = new Error('STORAGE_QUOTA_EXCEEDED: 저장 용량을 초과했습니다.');
      err.code = 'STORAGE_QUOTA_EXCEEDED';
      err.statusCode = 413;
      throw err;
    }
  }

  fs.copyFileSync(safeSourcePath, targetEpubPath);

  console.log(`⚡ [StorageService:Import] 서버 내부 0초 도서 복사 완료 (언더바 규격):`, {
    originalSource: safeSourcePath,
    targetDestination: targetEpubPath,
    existsOnDisk: fs.existsSync(targetEpubPath),
    savedSizeBytes: stat.size,
    bookId: safeBookId,
    userFolder: userFolder || 'root',
    preservedExistingProgress: Boolean(existingMeta)
  });

  const bookData = existingMeta
    ? {
        ...existingMeta,
        bookId: safeBookId,
        title: existingMeta.title || cleanTitle,
        fileName: existingMeta.fileName || fileName,
        isArchived: false,
        archiveStatus: 'active',
        hasLocalFile: true,
        isRecordOnly: false,
        unarchivedAt: existingMeta.isArchived ? nowIso : (existingMeta.unarchivedAt || null),
        archivedAt: null,
        lastReadDate: nowIso,
        lastModified: nowIso
      }
    : {
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

  saveBookMetadata(safeBookId, bookData, userFolder);
  console.log(
    `📖 [StorageService:Import] 도서 메타데이터 ${existingMeta ? '기존 기록 보존 병합' : '신규 각인'} 완료: '${safeBookId}.json' (진도율: ${bookData.progress || '0.0%'}, 폴더: ${userFolder || 'root'})`
  );

  return {
    ok: true,
    bookId: safeBookId,
    bookData,
    size: stat.size,
    fileName
  };
}