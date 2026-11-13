# 🔬 클라우드 & 개인서버 & 동기화 관련 전수 함수 목록 보고서

> **검사 파일**: 22개 | **발견된 관련 파일**: 21개 | **추출된 핵심 함수**: 95개

---

### 📄 `src/adminController.js` (총 4개 함수)

| 라인 | 함수/메서드 시그니처 | 코드 스니펫 |
| :---: | :--- | :--- |
| L122 | `isAuthenticated(req)` | `export function isAuthenticated(req) {` |
| L135 | `createAdminSession()` | `export function createAdminSession() {` |
| L141 | `destroyAdminSession(token)` | `export function destroyAdminSession(token) {` |
| L150 | `handleAdminRoute(req, res, pathname, clientIp, userAgent)` | `export async function handleAdminRoute(req, res, pathname, clientIp, userAgent) {` |

### 📄 `src/adminViews.js` (총 2개 함수)

| 라인 | 함수/메서드 시그니처 | 코드 스니펫 |
| :---: | :--- | :--- |
| L34 | `renderAdminSettingsHtml(req, successMessage = null, errorMessage = null, newIssuedKeyInfo = null)` | `export function renderAdminSettingsHtml(req, successMessage = null, errorMessage = null, newIssuedKeyInfo = null) {` |
| L111 | `closeKeyAlertModal()` | `function closeKeyAlertModal() {` |

### 📄 `src/apiKeyManager.js` (총 10개 함수)

| 라인 | 함수/메서드 시그니처 | 코드 스니펫 |
| :---: | :--- | :--- |
| L100 | `ensureDir(dirPath)` | `function ensureDir(dirPath) {` |
| L111 | `hashApiKey(rawKey = '')` | `export function hashApiKey(rawKey = '') {` |
| L121 | `writeJsonAtomic(filePath, data)` | `function writeJsonAtomic(filePath, data) {` |
| L133 | `readApiKeysData()` | `function readApiKeysData() {` |
| L151 | `getDirectorySize(dirPath)` | `function getDirectorySize(dirPath) {` |
| L174 | `generateUniqueFolderName()` | `function generateUniqueFolderName() {` |
| L254 | `authenticateApiKey(rawKey = '')` | `authenticateApiKey(rawKey = '') {` |
| L640 | `revokeApiKey(folderName = '', deleteFolder = false)` | `revokeApiKey(folderName = '', deleteFolder = false) {` |
| L670 | `cleanupExpiredPendingKeys()` | `cleanupExpiredPendingKeys() {` |
| L699 | `getUserListForAdmin()` | `getUserListForAdmin() {` |

### 📄 `src/auditLogger.js` (총 9개 함수)

| 라인 | 함수/메서드 시그니처 | 코드 스니펫 |
| :---: | :--- | :--- |
| L113 | `getDirectorySize(dirPath)` | `function getDirectorySize(dirPath) {` |
| L140 | `countFilesWithExt(dirPath, ext)` | `function countFilesWithExt(dirPath, ext) {` |
| L154 | `appendLogToDailyFile(entry)` | `function appendLogToDailyFile(entry) {` |
| L293 | `getRecentLogs()` | `getRecentLogs() {` |
| L301 | `getLogFilesList()` | `getLogFilesList() {` |
| L306 | `scanDirRecursively(currentDir)` | `function scanDirRecursively(currentDir) {` |
| L348 | `getFormattedLogContent(relativePath)` | `getFormattedLogContent(relativePath) {` |
| L378 | `deleteLogFile(relativePath)` | `deleteLogFile(relativePath) {` |
| L399 | `getStorageMetrics(forceRefresh = false)` | `getStorageMetrics(forceRefresh = false) {` |

### 📄 `src/envManager.js` (총 3개 함수)

| 라인 | 함수/메서드 시그니처 | 코드 스니펫 |
| :---: | :--- | :--- |
| L27 | `readEnvFile()` | `export function readEnvFile() {` |
| L48 | `writeEnvFile(newValues)` | `export function writeEnvFile(newValues) {` |
| L78 | `ensureStorageDirectories()` | `export function ensureStorageDirectories() {` |

### 📄 `src/httpUtils.js` (총 4개 함수)

| 라인 | 함수/메서드 시그니처 | 코드 스니펫 |
| :---: | :--- | :--- |
| L127 | `clearOtpFailure(ip)` | `export function clearOtpFailure(ip) {` |
| L137 | `extractApiKey(req, reqUrl)` | `export function extractApiKey(req, reqUrl) {` |
| L244 | `sendJsonResponse(req, res, statusCode, payload)` | `export function sendJsonResponse(req, res, statusCode, payload) {` |
| L259 | `sendHtmlResponse(req, res, statusCode, title, message, isSuccess = true)` | `export function sendHtmlResponse(req, res, statusCode, title, message, isSuccess = true) {` |

### 📄 `src/routes/authRoutes.js` (총 1개 함수)

| 라인 | 함수/메서드 시그니처 | 코드 스니펫 |
| :---: | :--- | :--- |
| L39 | `handleAuthRoute(req, res, pathname, reqUrl, clientIp, userAgent, protocol, host)` | `export async function handleAuthRoute(req, res, pathname, reqUrl, clientIp, userAgent, protocol, host) {` |

### 📄 `src/routes/storageRoutes.js` (총 3개 함수)

| 라인 | 함수/메서드 시그니처 | 코드 스니펫 |
| :---: | :--- | :--- |
| L39 | `getSharedFoldersConfig(env)` | `function getSharedFoldersConfig(env) {` |
| L71 | `saveSharedFoldersConfig(config)` | `function saveSharedFoldersConfig(config) {` |
| L81 | `handleStorageRoute(req, res, pathname, reqUrl, clientIp, userAgent)` | `export async function handleStorageRoute(req, res, pathname, reqUrl, clientIp, userAgent) {` |

### 📄 `src/routes/systemRoutes.js` (총 1개 함수)

| 라인 | 함수/메서드 시그니처 | 코드 스니펫 |
| :---: | :--- | :--- |
| L32 | `handleSystemRoute(req, res, pathname, reqUrl, clientIp, userAgent)` | `export async function handleSystemRoute(req, res, pathname, reqUrl, clientIp, userAgent) {` |

### 📄 `src/securityGuard.js` (총 3개 함수)

| 라인 | 함수/메서드 시그니처 | 코드 스니펫 |
| :---: | :--- | :--- |
| L25 | `validateSafePath(baseDir, targetPath)` | `export function validateSafePath(baseDir, targetPath) {` |
| L71 | `isAllowedBookFile(fileName)` | `export function isAllowedBookFile(fileName) {` |
| L101 | `maskSensitiveLog(rawText = '')` | `export function maskSensitiveLog(rawText = '') {` |

### 📄 `src/services/storage/bookStorageEngine.js` (총 8개 함수)

| 라인 | 함수/메서드 시그니처 | 코드 스니펫 |
| :---: | :--- | :--- |
| L33 | `getUnifiedSnapshot(userFolder = null)` | `export async function getUnifiedSnapshot(userFolder = null) {` |
| L211 | `getBookMetadata(bookId, userFolder = null)` | `export function getBookMetadata(bookId, userFolder = null) {` |
| L234 | `saveBookEpub(bookId, buffer, userFolder = null)` | `export function saveBookEpub(bookId, buffer, userFolder = null) {` |
| L262 | `getBookEpubPath(bookId, userFolder = null)` | `export function getBookEpubPath(bookId, userFolder = null) {` |
| L302 | `saveCoverImage(fileName, buffer, userFolder = null)` | `export function saveCoverImage(fileName, buffer, userFolder = null) {` |
| L334 | `getCoverImagePath(fileName, userFolder = null)` | `export function getCoverImagePath(fileName, userFolder = null) {` |
| L400 | `deleteCoverImage(fileName, userFolder = null)` | `export function deleteCoverImage(fileName, userFolder = null) {` |
| L433 | `deleteBookAll(bookId, userFolder = null)` | `export function deleteBookAll(bookId, userFolder = null) {` |

### 📄 `src/services/storage/remoteLibraryEngine.js` (총 6개 함수)

| 라인 | 함수/메서드 시그니처 | 코드 스니펫 |
| :---: | :--- | :--- |
| L30 | `testDirectoryPermissions(dirPath)` | `export function testDirectoryPermissions(dirPath) {` |
| L62 | `getDirectoryTree(targetPath = '/')` | `export function getDirectoryTree(targetPath = '/') {` |
| L112 | `getRemoteBooks(sharedDir)` | `export function getRemoteBooks(sharedDir) {` |
| L120 | `scanRecursively(currentDir, currentDepth = 0)` | `function scanRecursively(currentDir, currentDepth = 0) {` |
| L171 | `getRemoteBookFilePath(sharedDir, relativeFilePath)` | `export function getRemoteBookFilePath(sharedDir, relativeFilePath) {` |
| L205 | `importRemoteBookToLibrary(sharedDir, relativeFilePath, userFolder = null)` | `export function importRemoteBookToLibrary(sharedDir, relativeFilePath, userFolder = null) {` |

### 📄 `src/services/storage/settingsStorageEngine.js` (총 4개 함수)

| 라인 | 함수/메서드 시그니처 | 코드 스니펫 |
| :---: | :--- | :--- |
| L99 | `getCrashReportsList()` | `export function getCrashReportsList() {` |
| L131 | `getCrashReportPath(fileName)` | `export function getCrashReportPath(fileName) {` |
| L151 | `deleteCrashReport(fileName)` | `export function deleteCrashReport(fileName) {` |
| L174 | `clearAllCrashReports()` | `export function clearAllCrashReports() {` |

### 📄 `src/services/storage/storageContext.js` (총 6개 함수)

| 라인 | 함수/메서드 시그니처 | 코드 스니펫 |
| :---: | :--- | :--- |
| L88 | `resolveSafeRelativePath(baseDir, relativePath = '')` | `export function resolveSafeRelativePath(baseDir, relativePath = '') {` |
| L102 | `ensureDir(dirPath)` | `export function ensureDir(dirPath) {` |
| L113 | `readJsonSafely(filePath)` | `export function readJsonSafely(filePath) {` |
| L130 | `writeJsonSafely(filePath, data)` | `export function writeJsonSafely(filePath, data) {` |
| L143 | `calculateDirSizeBytes(dirPath)` | `export function calculateDirSizeBytes(dirPath) {` |
| L169 | `resolveStorageContext(userFolder = null)` | `export function resolveStorageContext(userFolder = null) {` |

### 📄 `src/systemMonitor.js` (총 6개 함수)

| 라인 | 함수/메서드 시그니처 | 코드 스니펫 |
| :---: | :--- | :--- |
| L91 | `getDiskMetrics()` | `function getDiskMetrics() {` |
| L136 | `postToDiscord(webhookUrl, embedPayload, fileContent = null, fileName = 'error_log.json')` | `async function postToDiscord(webhookUrl, embedPayload, fileContent = null, fileName = 'error_log.json') {` |
| L236 | `checkAndTriggerResourceAlert()` | `async checkAndTriggerResourceAlert() {` |
| L294 | `sendSecurityAlert({ path = "-", error = "Security Event", user = "-", status = 500, ip = "127.0.0.1", detailData = null })` | `async sendSecurityAlert({ path = "-", error = "Security Event", user = "-", status = 500, ip = "127.0.0.1", detailData =` |
| L389 | `checkAndSendDailyDigest()` | `async checkAndSendDailyDigest() {` |
| L453 | `testDiscordWebhook(webhookUrl, { alertTypes = '500,RESOURCE', dailyDigest = false } = {})` | `async testDiscordWebhook(webhookUrl, { alertTypes = '500,RESOURCE', dailyDigest = false } = {}) {` |

### 📄 `src/views/adminAuthViews.js` (총 1개 함수)

| 라인 | 함수/메서드 시그니처 | 코드 스니펫 |
| :---: | :--- | :--- |
| L12 | `renderAuthGateHtml()` | `export function renderAuthGateHtml() {` |

### 📄 `src/views/adminDashboardTab.js` (총 1개 함수)

| 라인 | 함수/메서드 시그니처 | 코드 스니펫 |
| :---: | :--- | :--- |
| L460 | `fetchSystemStats()` | `async function fetchSystemStats() {` |

### 📄 `src/views/adminFolderModal.js` (총 6개 함수)

| 라인 | 함수/메서드 시그니처 | 코드 스니펫 |
| :---: | :--- | :--- |
| L152 | `openFolderPicker(targetInputId)` | `function openFolderPicker(targetInputId) {` |
| L161 | `closeFolderPicker()` | `function closeFolderPicker() {` |
| L165 | `loadDirectoryTree(targetPath)` | `async function loadDirectoryTree(targetPath) {` |
| L213 | `handleFolderClick(folderPath, isReadable)` | `function handleFolderClick(folderPath, isReadable) {` |
| L222 | `goUpDirectory()` | `function goUpDirectory() {` |
| L228 | `selectCurrentFolder()` | `async function selectCurrentFolder() {` |

### 📄 `src/views/adminSettingsTab.js` (총 3개 함수)

| 라인 | 함수/메서드 시그니처 | 코드 스니펫 |
| :---: | :--- | :--- |
| L309 | `toggleWebhookVisibility(btn)` | `function toggleWebhookVisibility(btn) {` |
| L321 | `testDiscordWebhook()` | `async function testDiscordWebhook() {` |
| L360 | `saveDiscordSettings()` | `async function saveDiscordSettings() {` |

### 📄 `src/views/adminSharedFoldersTab.js` (총 11개 함수)

| 라인 | 함수/메서드 시그니처 | 코드 스니펫 |
| :---: | :--- | :--- |
| L23 | `getSharedFoldersConfig(env)` | `export function getSharedFoldersConfig(env) {` |
| L47 | `resolveAllUsersAndDevices()` | `export function resolveAllUsersAndDevices() {` |
| L277 | `fetchSharedFoldersConfig()` | `async function fetchSharedFoldersConfig() {` |
| L283 | `saveSharedFoldersConfig(newConfig)` | `async function saveSharedFoldersConfig(newConfig) {` |
| L292 | `toggleMasterSharedLibrary(isEnabled)` | `async function toggleMasterSharedLibrary(isEnabled) {` |
| L305 | `toggleFolderEnabled(folderId, isEnabled)` | `async function toggleFolderEnabled(folderId, isEnabled) {` |
| L320 | `addNewSharedFolder()` | `async function addNewSharedFolder() {` |
| L368 | `deleteSharedFolder(folderId)` | `async function deleteSharedFolder(folderId) {` |
| L382 | `toggleFolderGlobalAccess(folderId, btnEl)` | `async function toggleFolderGlobalAccess(folderId, btnEl) {` |
| L403 | `setTimeout(function()` | `setTimeout(function() { window.location.reload(); }, 600);` |
| L410 | `toggleDeviceFolderAccess(folderId, deviceId, chipEl)` | `async function toggleDeviceFolderAccess(folderId, deviceId, chipEl) {` |

### 📄 `src/views/adminUsersTab.js` (총 3개 함수)

| 라인 | 함수/메서드 시그니처 | 코드 스니펫 |
| :---: | :--- | :--- |
| L468 | `toggleDeviceBlock(deviceId, shouldBlock)` | `async function toggleDeviceBlock(deviceId, shouldBlock) {` |
| L494 | `deleteDeviceItem(deviceId)` | `async function deleteDeviceItem(deviceId) {` |
| L519 | `promptChangeMaxDevices()` | `async function promptChangeMaxDevices() {` |

