/**
 * @file src/storageService.js
 * @description 도서 메타데이터, EPUB 바이너리 파일, 전역 설정, 크래시 리포트, 공유 서재 탐색 올인원 파사드 모듈 (Facade)
 * - 🏛️ [ESM 컴포넌트 파사드] 4대 전담 도메인 하위 엔진을 조립하는 단일 진입점 파사드
 * - 👥 [다중 사용자 샌드박스 격리] storageContext.js 연동으로 data/users/{userFolder} 완전 격리
 * - 📚 [도서 및 표지 바이너리 엔진] bookStorageEngine.js 연동으로 스마트 라우팅 및 6대 교차 탐색 404 박멸
 * - ⚙️ [설정 및 크래시 진단] settingsStorageEngine.js 연동으로 전역 설정 및 뷰어 결함 리포트 전담
 * - 🔍 [공유 서재 & 내부 복사] remoteLibraryEngine.js 연동으로 디렉터리 트리 브라우징 및 0초 직통 도서 복사
 * - 🛡️ [무회귀 하위 호환성 100%] 기존 22대 storageService 인터페이스와 완전 일치 보장
 */

// 1. 기반 컨텍스트 및 쿼터 검사 엔진
import {
  checkUserStorageQuota,
  sanitizeFileName,
  generateFilenameCandidates,
  resolveSafeRelativePath,
  resolveStorageContext
} from './services/storage/storageContext.js';

// 2. 도서, 바이너리, 표지, 스냅샷 엔진
import {
  getUnifiedSnapshot,
  saveBookMetadata,
  getBookMetadata,
  saveBookEpub,
  getBookEpubPath,
  saveCoverImage,
  getCoverImagePath,
  deleteCoverImage,
  deleteBookAll
} from './services/storage/bookStorageEngine.js';

// 3. 전역 설정 및 크래시 리포트 엔진
import {
  saveSettingsFile,
  getSettingsFile,
  saveCrashReport,
  getCrashReportsList,
  getCrashReportPath,
  deleteCrashReport,
  clearAllCrashReports
} from './services/storage/settingsStorageEngine.js';

// 4. 공유 서재 탐색, 권한 실측 및 0초 내부 복사 엔진
import {
  testDirectoryPermissions,
  getDirectoryTree,
  getRemoteBooks,
  getRemoteBookFilePath,
  importRemoteBookToLibrary
} from './services/storage/remoteLibraryEngine.js';

/**
 * 🌟 [22대 공개 인터페이스 파사드 싱글톤 객체]
 * 기존 라우터 및 컨트롤러와의 100% 무회귀 호환을 보장합니다.
 */
export const storageService = {
  // 📊 용량 통제 및 샌드박스 쿼터
  checkUserStorageQuota,

  // ⚡ 올인원 통합 스냅샷 및 고아 표지 자가소독
  getUnifiedSnapshot,

  // 📚 도서 메타데이터 및 바이너리 I/O
  saveBookMetadata,
  getBookMetadata,
  saveBookEpub,
  getBookEpubPath,
  saveCoverImage,
  getCoverImagePath,
  deleteCoverImage,
  deleteBookAll,

  // ⚙️ 전역 설정, 통계, 업적, 묘비 I/O
  saveSettingsFile,
  getSettingsFile,

  // 🔬 크래시 리포트 I/O
  saveCrashReport,
  getCrashReportsList,
  getCrashReportPath,
  deleteCrashReport,
  clearAllCrashReports,

  // 🔍 서버 디렉터리 탐색 및 권한 실측
  testDirectoryPermissions,
  getDirectoryTree,

  // 📚 관리자 지정 공유 서재 스캔 및 직통 복사
  getRemoteBooks,
  getRemoteBookFilePath,
  importRemoteBookToLibrary
};

// 개별 함수 직접 import 편의를 위한 Named Exports
export {
  checkUserStorageQuota,
  sanitizeFileName,
  generateFilenameCandidates,
  resolveSafeRelativePath,
  resolveStorageContext,
  getUnifiedSnapshot,
  saveBookMetadata,
  getBookMetadata,
  saveBookEpub,
  getBookEpubPath,
  saveCoverImage,
  getCoverImagePath,
  deleteCoverImage,
  deleteBookAll,
  saveSettingsFile,
  getSettingsFile,
  saveCrashReport,
  getCrashReportsList,
  getCrashReportPath,
  deleteCrashReport,
  clearAllCrashReports,
  testDirectoryPermissions,
  getDirectoryTree,
  getRemoteBooks,
  getRemoteBookFilePath,
  importRemoteBookToLibrary
};