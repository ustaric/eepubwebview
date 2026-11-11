/**
 * @file src/systemMonitor.js
 * @description 서버 시스템 자원(CPU, RAM, DISK) 실측 모니터링 및 Discord 웹훅 알림 전담 모듈
 * - 🖥️ [크로스 플랫폼 CPU 1분 이동평균] Windows 및 Linux 공용 10초 주기 틱 샘플링 연산 탑재
 * - 🧠 [실측 RAM & DISK 연산] os.totalmem/freemem 및 fs.statfsSync를 통한 실시간 점유율(%) 산출
 * - 🔔 [자원 80% 초과 30분 쿨다운] CPU, RAM, DISK 중 하나라도 80% 초과 시 디스코드 웹훅 발송 (30분 도배 방지 락)
 * - 🚨 [에러 및 위협 알림 1KB 분기 발송] 1KB 이하 본문 Embed codeblock / 1KB 초과 시 error_log.json 파일 첨부 발송
 * - 🛡️ [HTTP 오류별 5분 쿨다운] 동일 엔드포인트/원인에 대해 5분간 중복 발송 방지 캐시 가드 결속
 * - 📅 [조건부 일일 다이제스트] DISCORD_DAILY_DIGEST 활성 시 당일 침입/오류 로그가 1건 이상일 때만 정기 요약 발송 (위협 0건 시 침묵)
 * - 🧪 [고도화된 테스트 웹훅] 테스트 발송 시 현재 체크된 6대 항목 및 정기보고 On/Off 상태를 디스코드 카드에 시각화 표출
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readEnvFile } from './envManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(ROOT_DIR, 'data');
const LOGS_DIR = path.resolve(ROOT_DIR, 'data/logs');

// ⏱️ 쿨다운 상수 설정
const RESOURCE_ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30분
const ERROR_ALERT_COOLDOWN_MS = 5 * 60 * 1000;      // 동일 에러 5분

// 상태 메모리 홀더
let lastResourceAlertTime = 0;
const errorAlertHistory = new Map(); // key: errorKey, value: timestamp
let lastDailyDigestDate = ''; // 하루 1회 중복 발송 방지 홀더

// CPU 1분 이동 평균 계산용 틱 샘플러 버퍼 (최대 6개 = 60초)
let lastCpuMeasure = null;
const cpuUsageBuffer = [];
let currentCpuPercent = 0;

// 백그라운드 타이머 홀더
let sampleIntervalId = null;
let monitorIntervalId = null;
let dailyDigestIntervalId = null;

/**
 * 전체 CPU 코어의 유휴(idle) 시간 및 총(total) 틱 시간 합산
 * @returns {{ idle: number, total: number }}
 */
function getCpuTicks() {
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;

  for (const core of cpus) {
    for (const type in core.times) {
      totalTick += core.times[type];
    }
    totalIdle += core.times.idle;
  }

  return { idle: totalIdle, total: totalTick };
}

/**
 * 10초 주기로 CPU 틱 차이를 계산하여 1분 이동 평균 버퍼 갱신
 */
function sampleCpuTick() {
  const current = getCpuTicks();

  if (lastCpuMeasure) {
    const idleDelta = current.idle - lastCpuMeasure.idle;
    const totalDelta = current.total - lastCpuMeasure.total;

    if (totalDelta > 0) {
      const usage = Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
      cpuUsageBuffer.push(usage);
      if (cpuUsageBuffer.length > 6) {
        cpuUsageBuffer.shift(); // 60초 유지 (10초 * 6개)
      }
      const sum = cpuUsageBuffer.reduce((acc, cur) => acc + cur, 0);
      currentCpuPercent = Math.round(sum / cpuUsageBuffer.length);
    }
  }

  lastCpuMeasure = current;
}

/**
 * 디스크 사용량(%) 산출 (Node.js 18.15+ statfsSync 사용, 미지원 시 0 반환)
 * @returns {{ percent: number, totalGb: string, freeGb: string }}
 */
function getDiskMetrics() {
  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(DATA_DIR);
      const totalBytes = stats.bsize * stats.blocks;
      const freeBytes = stats.bsize * stats.bfree;
      const usedBytes = totalBytes - freeBytes;

      const percent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
      return {
        percent: Math.max(0, Math.min(100, percent)),
        totalGb: (totalBytes / (1024 ** 3)).toFixed(1),
        freeGb: (freeBytes / (1024 ** 3)).toFixed(1)
      };
    }
  } catch (e) {}

  return { percent: 0, totalGb: '0.0', freeGb: '0.0' };
}

/**
 * RAM 사용량(%) 산출
 * @returns {{ percent: number, usedMb: string, totalMb: string }}
 */
function getMemoryMetrics() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;

  const percent = total > 0 ? Math.round((used / total) * 100) : 0;
  return {
    percent: Math.max(0, Math.min(100, percent)),
    usedMb: (used / (1024 * 1024)).toFixed(0),
    totalMb: (total / (1024 * 1024)).toFixed(0)
  };
}

/**
 * 📦 Discord Incoming Webhook 비동기 발송 헬퍼 (1KB 분기 파일 첨부 및 Fail-Safe 탑재)
 * @param {string} webhookUrl - 디스코드 웹훅 주소
 * @param {Object} embedPayload - 디스코드 임베드 카드 객체
 * @param {string|null} [fileContent=null] - 1KB 초과 시 첨부할 JSON 텍스트
 * @param {string} [fileName="error_log.json"] - 첨부 파일명
 * @returns {Promise<boolean>}
 */
async function postToDiscord(webhookUrl, embedPayload, fileContent = null, fileName = 'error_log.json') {
  if (!webhookUrl || typeof webhookUrl !== 'string' || !webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
    return false;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    let res;
    if (fileContent && typeof fileContent === 'string') {
      // 🌟 [1KB 초과] multipart/form-data 전송 (Node 18+ 내장 FormData/Blob 활용)
      const form = new FormData();
      form.append('payload_json', JSON.stringify(embedPayload));
      const blob = new Blob([fileContent], { type: 'application/json' });
      form.append('files[0]', blob, fileName);

      res = await fetch(webhookUrl, {
        method: 'POST',
        body: form,
        signal: controller.signal
      });
    } else {
      // 🌟 [1KB 이하] 순수 JSON 전송
      res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(embedPayload),
        signal: controller.signal
      });
    }

    clearTimeout(timeoutId);
    return res.ok;
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn(`⚠️ [SystemMonitor:DiscordWarn] 디스코드 웹훅 전송 실패: ${err.message}`);
    return false;
  }
}

export const systemMonitor = {
  /**
   * 백그라운드 틱 수집, 1분 감시 루프 및 조건부 일일 다이제스트 타이머 가동
   */
  startMonitoring() {
    if (sampleIntervalId) return;

    // 초기 틱 측정
    sampleCpuTick();

    // 10초마다 CPU 샘플링
    sampleIntervalId = setInterval(() => {
      sampleCpuTick();
    }, 10 * 1000);

    // 30초마다 80% 임계치 검사
    monitorIntervalId = setInterval(() => {
      this.checkAndTriggerResourceAlert();
    }, 30 * 1000);

    // 1시간마다 일일 다이제스트 조건(로그 1건 이상) 검사
    dailyDigestIntervalId = setInterval(() => {
      this.checkAndSendDailyDigest();
    }, 60 * 60 * 1000);

    if (sampleIntervalId.unref) sampleIntervalId.unref();
    if (monitorIntervalId.unref) monitorIntervalId.unref();
    if (dailyDigestIntervalId.unref) dailyDigestIntervalId.unref();

    console.log('📊 [SystemMonitor] 시스템 자원 감시 및 디스코드 관제 엔진이 가동되었습니다.');
  },

  /**
   * 관리자 대시보드 가로 게이지 바용 실시간 메트릭 반환
   * @returns {{ cpu: number, ram: number, disk: number, lastCheckedAt: string }}
   */
  getSystemStats() {
    const mem = getMemoryMetrics();
    const disk = getDiskMetrics();
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0];

    return {
      cpu: currentCpuPercent,
      ram: mem.percent,
      disk: disk.percent,
      details: {
        memUsedMb: mem.usedMb,
        memTotalMb: mem.totalMb,
        diskTotalGb: disk.totalGb,
        diskFreeGb: disk.freeGb
      },
      lastCheckedAt: timeStr
    };
  },

  /**
   * 자원(CPU, RAM, DISK) 80% 초과 여부 감시 및 30분 쿨다운 알림 발송
   */
  async checkAndTriggerResourceAlert() {
    const env = readEnvFile();
    const webhookUrl = env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;

    // 알림 설정 확인 (RESOURCE 체크 여부)
    const alertTypes = (env.DISCORD_ALERT_TYPES || '500,RESOURCE').split(',').map(s => s.trim());
    if (!alertTypes.includes('RESOURCE')) return;

    const stats = this.getSystemStats();
    const isOverloaded = stats.cpu >= 80 || stats.ram >= 80 || stats.disk >= 80;

    if (!isOverloaded) return;

    const now = Date.now();
    if (now - lastResourceAlertTime < RESOURCE_ALERT_COOLDOWN_MS) {
      return; // 30분 쿨다운 중
    }

    lastResourceAlertTime = now;

    const timeStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const warnings = [];
    if (stats.cpu >= 80) warnings.push(`• **CPU 사용률**: \`${stats.cpu}%\` (임계치 80% 초과)`);
    if (stats.ram >= 80) warnings.push(`• **RAM 점유율**: \`${stats.ram}%\` (${stats.details.memUsedMb}MB / ${stats.details.memTotalMb}MB)`);
    if (stats.disk >= 80) warnings.push(`• **DISK 점유율**: \`${stats.disk}%\` (여유: ${stats.details.diskFreeGb}GB / 총: ${stats.details.diskTotalGb}GB)`);

    const payload = {
      username: 'EPUB Server Guard',
      embeds: [
        {
          title: '⚠️ [서버 자원 경고] 시스템 부하 80% 임계치 도달',
          description: `서버 자원 점유율이 80%를 초과했습니다. 조치가 필요할 수 있습니다.\n\n${warnings.join('\n')}`,
          color: 0xef4444,
          fields: [
            { name: '🖥️ CPU (1분 평균)', value: `${stats.cpu}%`, inline: true },
            { name: '🧠 RAM', value: `${stats.ram}%`, inline: true },
            { name: '💾 DISK', value: `${stats.disk}%`, inline: true }
          ],
          footer: { text: `발생 시각: ${timeStr} • 다음 알림은 30분 후에 발송됩니다.` }
        }
      ]
    };

    await postToDiscord(webhookUrl, payload);
    console.warn(`🚨 [SystemMonitor] 서버 자원 80% 초과 디스코드 알림 발송 완료 (CPU:${stats.cpu}% / RAM:${stats.ram}% / DISK:${stats.disk}%)`);
  },

  /**
   * 서버 보안 위협 및 에러 발생 시 디스코드 발송 (1KB 이하 본문 / 1KB 초과 json 첨부)
   * @param {Object} params
   * @param {string} params.path - 엔드포인트 경로
   * @param {string} params.error - 에러 내용
   * @param {string} [params.user="-"] - 사용자 메모/폴더
   * @param {number} [params.status=500] - 상태 코드
   * @param {string} [params.ip="127.0.0.1"] - 요청자 IP
   * @param {any} [params.detailData=null] - 상세 JSON 데이터
   */
  async sendSecurityAlert({ path = "-", error = "Security Event", user = "-", status = 500, ip = "127.0.0.1", detailData = null }) {
    const env = readEnvFile();
    const webhookUrl = env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;

    const errorKey = `${status}:${path}:${ip}`;
    const now = Date.now();
    const lastSent = errorAlertHistory.get(errorKey) || 0;

    if (now - lastSent < ERROR_ALERT_COOLDOWN_MS) {
      return; // 동일 에러 5분 쿨다운
    }

    errorAlertHistory.set(errorKey, now);

    // 10분 지난 에러 키 메모리 자가 소독
    for (const [key, timestamp] of errorAlertHistory.entries()) {
      if (now - timestamp > 10 * 60 * 1000) {
        errorAlertHistory.delete(key);
      }
    }

    const timeStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const rawErrorString = typeof error === 'object' ? JSON.stringify(error, null, 2) : String(error);
    const errorByteLength = Buffer.byteLength(rawErrorString, 'utf-8');

    // 🎨 상태 코드별 색상 및 제목 지정
    let color = 0xdc2626; // 기본 빨강 (500)
    let title = `🚨 [서버 오류 감지] HTTP ${status}`;

    if (status === 401) {
      color = 0xf59e0b; // 주황
      title = `🔒 [인증 실패 감지] HTTP 401 Unauthorized`;
    } else if (status === 403) {
      color = 0xef4444; // 빨강
      title = `⛔ [접근 권한 거부] HTTP 403 Forbidden`;
    } else if (status === 429) {
      color = 0x8b5cf6; // 보라
      title = `🚦 [요청 제한 초과] HTTP 429 Too Many Requests`;
    } else if (status === 405 || status === 400) {
      color = 0xec4899; // 핑크
      title = `🛡️ [비정상 접근 차단] HTTP ${status}`;
    }

    const payload = {
      username: 'EPUB Server Guard',
      embeds: [
        {
          title,
          color,
          fields: [
            { name: '🌐 대상 경로', value: `\`${path}\``, inline: false },
            { name: '👤 사용자 식별', value: user || 'Unknown', inline: true },
            { name: '📡 접속 IP', value: ip || '127.0.0.1', inline: true }
          ],
          footer: { text: `발생 시각: ${timeStr} • 동일 요청은 5분간 쿨다운됩니다.` }
        }
      ]
    };

    let fileContentToSend = null;
    let fileName = `incident_${Date.now()}.json`;

    if (errorByteLength <= 1024) {
      // 1KB 이하: 본문 Embed codeblock 표출
      payload.embeds[0].fields.push({
        name: '📋 로그 내용 (1KB 이하 본문)',
        value: `\`\`\`json\n${rawErrorString.substring(0, 950)}\n\`\`\``,
        inline: false
      });
    } else {
      // 1KB 초과: 본문에는 요약만 남기고 .json 파일 첨부 준비
      payload.embeds[0].fields.push({
        name: '📁 상세 로그 파일 첨부 (1KB 초과)',
        value: `로그 크기가 \`${(errorByteLength / 1024).toFixed(1)} KB\`로 첨부 파일로 제공됩니다.`,
        inline: false
      });

      const fullLogObject = {
        timestamp: timeStr,
        status,
        path,
        user,
        ip,
        error: detailData || error
      };
      fileContentToSend = JSON.stringify(fullLogObject, null, 2);
    }

    await postToDiscord(webhookUrl, payload, fileContentToSend, fileName);
  },

  /**
   * 📅 [일일 정기 보고] 로그가 1건 이상 존재할 때만 발송 (로그 없으면 침묵)
   */
  async checkAndSendDailyDigest() {
    const env = readEnvFile();
    const webhookUrl = env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl || env.DISCORD_DAILY_DIGEST !== 'true') return;

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD

    // 하루 1회 중복 발송 방지
    if (lastDailyDigestDate === dateStr) return;

    // 당일 로그 파일 실측
    const year = now.getFullYear().toString();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dailyLogPath = path.join(LOGS_DIR, year, month, day, `audit-${dateStr}.jsonl`);

    // 🌟 [핵심 조건] 로그 파일이 없거나 라인 수가 0이면 발송하지 않고 스킵!
    if (!fs.existsSync(dailyLogPath)) return;

    let linesCount = 0;
    try {
      const content = fs.readFileSync(dailyLogPath, 'utf-8');
      linesCount = content.trim().split('\n').filter(Boolean).length;
    } catch (e) {
      return;
    }

    if (linesCount === 0) return; // 위협/오류 0건 시 침묵

    lastDailyDigestDate = dateStr;
    const timeStr = now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const stats = this.getSystemStats();

    const payload = {
      username: 'EPUB Server Guard',
      embeds: [
        {
          title: `📊 [보안 감사 정기 보고] ${dateStr}`,
          description: `당일 발생한 보안 위협 및 오류 로그가 집계되어 보고서를 발송합니다.\n(총 차단/오류 발생: **${linesCount}건**)`,
          color: 0x3b82f6, // 파란색
          fields: [
            { name: '🛡️ 당일 차단 로그', value: `\`${linesCount}건\``, inline: true },
            { name: '🖥️ CPU 평균', value: `${stats.cpu}%`, inline: true },
            { name: '🧠 RAM 점유율', value: `${stats.ram}%`, inline: true },
            { name: '💾 DISK 여유', value: `${stats.details.diskFreeGb}GB 남음`, inline: true }
          ],
          footer: { text: `보고 시각: ${timeStr} • 위협이 없는 날은 발송되지 않습니다.` }
        }
      ]
    };

    await postToDiscord(webhookUrl, payload);
    console.log(`📊 [SystemMonitor] 일일 보안 정기보고 발송 완료 (${linesCount}건 감지)`);
  },

  /**
   * 🧪 [고도화된 테스트 웹훅] 체크된 6대 항목 및 정기보고 On/Off 상태를 포함하여 테스트 전송
   * @param {string} webhookUrl - 테스트할 웹훅 URL
   * @param {Object} [options={}] - 선택된 알림 필터 및 정기보고 옵션
   * @param {string|string[]} [options.alertTypes="500,RESOURCE"] - 선택된 6대 알림 필터
   * @param {boolean} [options.dailyDigest=false] - 조건부 정기보고 활성 여부
   * @returns {Promise<{ ok: boolean, message: string }>}
   */
  async testDiscordWebhook(webhookUrl, { alertTypes = '500,RESOURCE', dailyDigest = false } = {}) {
    if (!webhookUrl || !webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
      return { ok: false, message: '올바른 Discord 웹훅 URL 형식이 아닙니다.' };
    }

    const timeStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const stats = this.getSystemStats();

    // 1. 체크된 알림 필터 파싱
    let typesList = [];
    if (Array.isArray(alertTypes)) {
      typesList = alertTypes.map(s => String(s).trim());
    } else if (typeof alertTypes === 'string') {
      typesList = alertTypes.split(',').map(s => s.trim());
    }

    const rules = [
      { key: '500', label: 'HTTP 500 서버 내부 오류' },
      { key: '401', label: 'HTTP 401 인증 실패 (키 오류)' },
      { key: '403', label: 'HTTP 403 접근 권한 거부' },
      { key: '429', label: 'HTTP 429 요청 제한 초과' },
      { key: 'ATTACK', label: '비정상 접근 및 변칙 메서드 차단' },
      { key: 'RESOURCE', label: 'CPU/RAM/DISK 80% 초과 경고' }
    ];

    const rulesFormatted = rules.map(r => {
      const isEnabled = typesList.includes(r.key);
      return `${isEnabled ? '✅' : '❌'} **${r.label}** ${isEnabled ? '`(수신)`' : '*(제외)*'}`;
    }).join('\n');

    const isDailyDigestActive = dailyDigest === true || dailyDigest === 'true';
    const dailyDigestText = isDailyDigestActive
      ? '✅ **활성화** (당일 위협 1건 이상 감지 시에만 정기 발송)'
      : '❌ **비활성화** (정기 보고 미발송)';

    const payload = {
      username: 'EPUB Server Guard',
      embeds: [
        {
          title: '✅ [테스트 성공] Discord 관제 채널 연동 확인 완료!',
          description: '서버 모니터링 및 보안 알림이 정상 연결되었습니다.\n현재 설정된 관제 규칙 및 알림 수신 상태는 다음과 같습니다.',
          color: 0x10b981, // 초록색
          fields: [
            {
              name: '🎯 실시간 감시 규칙 설정 현황 (6대 필터)',
              value: rulesFormatted,
              inline: false
            },
            {
              name: '📊 일일 보안 정기 보고',
              value: dailyDigestText,
              inline: false
            },
            {
              name: '📦 페이로드 분기 정책',
              value: '• `1KB 이하`: 디스코드 임베드 본문에 즉시 표시\n• `1KB 초과`: `error_log.json` 파일 자동 첨부 발송',
              inline: false
            },
            {
              name: '🖥️ CPU',
              value: `${stats.cpu}%`,
              inline: true
            },
            {
              name: '🧠 RAM',
              value: `${stats.ram}%`,
              inline: true
            },
            {
              name: '💾 DISK',
              value: `${stats.disk}%`,
              inline: true
            }
          ],
          footer: { text: `테스트 발송 시각: ${timeStr} • Personal EPUB Server Guard` }
        }
      ]
    };

    const success = await postToDiscord(webhookUrl, payload);
    if (success) {
      return { ok: true, message: '설정된 관제 규칙이 포함된 테스트 알림 카드가 디스코드로 정상 발송되었습니다!' };
    } else {
      return { ok: false, message: '웹훅 전송에 실패했습니다. URL 주소와 채널 권한을 확인해 주세요.' };
    }
  }
};