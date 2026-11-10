/**
 * @file src/systemMonitor.js
 * @description 서버 시스템 자원(CPU, RAM, DISK) 실측 모니터링 및 Discord 웹훅 알림 전담 모듈
 * - 🖥️ [크로스 플랫폼 CPU 1분 이동평균] Windows(loadavg 미지원) 및 Linux 공용 10초 주기 틱 샘플링 연산 탑재
 * - 🧠 [실측 RAM & DISK 연산] os.totalmem/freemem 및 fs.statfsSync를 통한 실시간 점유율(%) 산출
 * - 🔔 [자원 80% 초과 30분 쿨다운] CPU, RAM, DISK 중 하나라도 80% 초과 시 디스코드 웹훅 발송 (30분 도배 방지 락)
 * - 🚨 [서버 500 오류 텍스트 알림] 서버 내부 예외 발생 시 에러 요약(엔드포인트, 원인, 사용자) 즉시 전송 (동일 에러 5분 쿨다운)
 * - 🛡️ [완전 격리 Fail-Safe] 웹훅 통신 실패나 지연이 발생해도 주 독서 서비스 이벤트 루프 100% 무영향 (3초 타임아웃)
 * - 🧪 [테스트 웹훅 지원] 관리자 대시보드에서 즉시 연동 테스트 전송 지원
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

// ⏱️ 쿨다운 상수 설정
const RESOURCE_ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30분
const ERROR_ALERT_COOLDOWN_MS = 5 * 60 * 1000;      // 동일 에러 5분

// 상태 메모리 홀더
let lastResourceAlertTime = 0;
const errorAlertHistory = new Map(); // key: errorKey, value: timestamp

// CPU 1분 이동 평균 계산용 틱 샘플러 버퍼 (최대 6개 = 60초)
let lastCpuMeasure = null;
const cpuUsageBuffer = [];
let currentCpuPercent = 0;

// 백그라운드 타이머 홀더
let sampleIntervalId = null;
let monitorIntervalId = null;

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
 * Discord Incoming Webhook 비동기 발송 헬퍼 (완전 격리 Fail-Safe 탑재)
 * @param {string} webhookUrl - 디스코드 웹훅 주소
 * @param {Object} embedPayload - 디스코드 임베드 카드 객체
 * @returns {Promise<boolean>}
 */
async function postToDiscord(webhookUrl, embedPayload) {
  if (!webhookUrl || typeof webhookUrl !== 'string' || !webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
    return false;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3500);

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(embedPayload),
      signal: controller.signal
    });
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
   * 백그라운드 틱 수집 및 1분 감시 루프 시작
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

    if (sampleIntervalId.unref) sampleIntervalId.unref();
    if (monitorIntervalId.unref) monitorIntervalId.unref();

    console.log('📊 [SystemMonitor] 시스템 자원 감시 및 1분 이동평균 엔진이 가동되었습니다.');
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
          color: 0xef4444, // 빨간색
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
   * 서버 500 에러 발생 시 요약 텍스트를 디스코드로 발송 (동일 에러 5분 쿨다운)
   * @param {Object} params
   * @param {string} params.path - 엔드포인트 경로
   * @param {string} params.error - 에러 내용
   * @param {string} [params.user="-"] - 사용자 메모/폴더
   * @param {number} [params.status=500] - 상태 코드
   * @param {string} [params.ip="127.0.0.1"] - 요청자 IP
   */
  async sendErrorAlert({ path = "-", error = "Internal Error", user = "-", status = 500, ip = "127.0.0.1" }) {
    const env = readEnvFile();
    const webhookUrl = env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;

    const errorKey = `${path}:${error}`;
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
    const payload = {
      username: 'EPUB Server Guard',
      embeds: [
        {
          title: `🚨 [서버 오류 감지] HTTP ${status} Internal Error`,
          color: 0xdc2626, // 진한 빨강
          fields: [
            { name: '🌐 엔드포인트', value: `\`${path}\``, inline: false },
            { name: '💥 오류 내용', value: `\`\`\`text\n${String(error).substring(0, 500)}\n\`\`\``, inline: false },
            { name: '👤 사용자', value: user || 'Root Admin', inline: true },
            { name: '📡 IP 주소', value: ip || '127.0.0.1', inline: true }
          ],
          footer: { text: `발생 시각: ${timeStr} • 동일 오류는 5분간 중복 발송되지 않습니다.` }
        }
      ]
    };

    await postToDiscord(webhookUrl, payload);
  },

  /**
   * 관리자 설정 페이지에서 디스코드 웹훅 연결 테스트 전송
   * @param {string} webhookUrl - 테스트할 웹훅 URL
   * @returns {Promise<{ ok: boolean, message: string }>}
   */
  async testDiscordWebhook(webhookUrl) {
    if (!webhookUrl || !webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
      return { ok: false, message: '올바른 Discord 웹훅 URL 형식이 아닙니다.' };
    }

    const timeStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const stats = this.getSystemStats();

    const payload = {
      username: 'EPUB Server Guard',
      embeds: [
        {
          title: '✅ [테스트 성공] Discord 웹훅 알림이 정상 연결되었습니다!',
          description: '서버 자원이 80%를 넘거나 500 서버 장애가 발생하면 이 채널로 실시간 알림이 발송됩니다.',
          color: 0x10b981, // 초록색
          fields: [
            { name: '🖥️ 현재 CPU', value: `${stats.cpu}%`, inline: true },
            { name: '🧠 현재 RAM', value: `${stats.ram}%`, inline: true },
            { name: '💾 현재 DISK', value: `${stats.disk}%`, inline: true }
          ],
          footer: { text: `테스트 발송 시각: ${timeStr}` }
        }
      ]
    };

    const success = await postToDiscord(webhookUrl, payload);
    if (success) {
      return { ok: true, message: '디스코드로 테스트 알림 카드가 정상 발송되었습니다!' };
    } else {
      return { ok: false, message: '웹훅 전송에 실패했습니다. URL 주소와 채널 권한을 확인해 주세요.' };
    }
  }
};