// Bộ lập lịch đơn giản chạy cùng backend (không cần queue/Redis).
// Mỗi tick xử lý các hạn chót theo clock của server; mỗi mục là một transaction riêng, lỗi một mục không chặn mục khác.
// Giới hạn: khi backend tắt, hạn chót được xử lý bù ở lần chạy kế tiếp (ghi rõ trong docs).
import { config } from './config.js';
import { expireHolds, timeoutDue, startDueSessions, endDueSessions, autoConfirmDue } from './services/bookings.js';
import { expirePendingPayments } from './services/payments.js';

export function runSchedulerOnce() {
  const stats = { holds: 0, timeouts: 0, started: 0, ended: 0, autoConfirmed: 0, payments: 0 };
  // Lặp vài lượt để xử lý chuỗi sự kiện khi đồng hồ demo nhảy xa (ACCEPTED → IN_SESSION → AWAITING_CONFIRMATION → COMPLETED)
  for (let i = 0; i < 4; i++) {
    const s = {
      holds: safe(expireHolds),
      payments: safe(expirePendingPayments),
      timeouts: safe(timeoutDue),
      started: safe(startDueSessions),
      ended: safe(endDueSessions),
      autoConfirmed: safe(autoConfirmDue),
    };
    let changed = 0;
    for (const k of Object.keys(s)) {
      stats[k] += s[k];
      changed += s[k];
    }
    if (!changed) break;
  }
  return stats;
}

function safe(fn) {
  try {
    return fn() || 0;
  } catch (e) {
    console.error(`[scheduler] ${fn.name}:`, e.message);
    return 0;
  }
}

let timer = null;
export function startScheduler() {
  if (timer) return;
  timer = setInterval(runSchedulerOnce, config.SCHEDULER_INTERVAL_MS);
  timer.unref?.();
}
export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
