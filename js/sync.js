// 跨裝置同步：把本地資料送到 Worker /sync 合併，再用合併結果覆蓋本地

import { WORKER_URL } from './config.js';
import { getSyncCode, exportSyncData, applySyncData } from './storage.js';

export function syncAvailable() {
  return Boolean(WORKER_URL);
}

// 產生好輸入的同步碼（8 碼，排除易混淆的 0/O/1/I）
export function generateSyncCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const rand = new Uint32Array(8);
  crypto.getRandomValues(rand);
  for (const n of rand) code += chars[n % chars.length];
  return code;
}

// 立即同步一次。回傳 { ok, syncedAt } 或 { ok: false, error }
export async function syncNow() {
  const code = getSyncCode();
  if (!code || !syncAvailable()) return { ok: false, error: 'no-code' };
  try {
    const res = await fetch(`${WORKER_URL}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, data: exportSyncData() }),
    });
    if (!res.ok) return { ok: false, error: `http-${res.status}` };
    const { data, syncedAt } = await res.json();
    applySyncData(data, syncedAt);
    return { ok: true, syncedAt };
  } catch {
    return { ok: false, error: 'network' };
  }
}

// 資料變動後的背景同步（3 秒防抖，失敗安靜略過，下次再試）
let timer = null;

export function scheduleSync(onDone) {
  if (!getSyncCode() || !syncAvailable()) return;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const result = await syncNow();
    if (result.ok && onDone) onDone();
  }, 3000);
}
