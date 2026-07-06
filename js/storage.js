// 學習紀錄（localStorage）

const KEY = 'wordbuddy.v1';

function load() {
  let data;
  try {
    data = JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    data = {};
  }
  // 舊版資料相容：缺欄位補預設值
  return { words: [], stars: 0, daily: {}, deleted: {}, ...data };
}

// 臺北時間的今天（YYYY-MM-DD）
function todayKey(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

function save(data) {
  localStorage.setItem(KEY, JSON.stringify(data));
}

export function getWords() {
  return load().words;
}

export function getStars() {
  return load().stars;
}

// 完成一次學習：記錄單字與句子，加一顆星，累計今日學習數
export function recordLearned({ word, phonetic, respelling, audio, sentence }) {
  const data = load();
  const existing = data.words.find((w) => w.word === word);
  if (existing) {
    existing.sentence = sentence;
    existing.times += 1;
    existing.learnedAt = new Date().toISOString();
    if (respelling) existing.respelling = respelling;
  } else {
    data.words.unshift({
      word, phonetic, respelling: respelling || '', audio, sentence,
      times: 1,
      learnedAt: new Date().toISOString(),
    });
  }
  data.stars += 1;
  data.daily[todayKey()] = (data.daily[todayKey()] || 0) + 1;
  save(data);
  return data.stars;
}

// 測驗答對：只加星星，不算每日新學單字
export function addStar() {
  const data = load();
  data.stars += 1;
  save(data);
  return data.stars;
}

export const DAILY_GOAL = 5;

export function getDailyProgress() {
  return { count: load().daily[todayKey()] || 0, goal: DAILY_GOAL };
}

// 連續學習天數：今天有學從今天起算，今天還沒學就從昨天起算
export function getStreak() {
  const daily = load().daily;
  let streak = 0;
  let offset = daily[todayKey()] ? 0 : -1;
  while (daily[todayKey(offset)]) {
    streak += 1;
    offset -= 1;
  }
  return streak;
}

// 引擎模式：'free'（免費）或 'ai'（Claude API + Azure 語音）
export function getMode() {
  return load().mode === 'ai' ? 'ai' : 'free';
}

export function setMode(mode) {
  const data = load();
  data.mode = mode === 'ai' ? 'ai' : 'free';
  save(data);
}

export function removeWord(word) {
  const data = load();
  data.words = data.words.filter((w) => w.word !== word);
  data.deleted[word] = new Date().toISOString(); // 同步用的刪除紀錄，避免被別台裝置救回來
  save(data);
}

// 模式是否被明確設定過（新裝置預設進 AI 模式用）
export function hasMode() {
  return load().mode === 'ai' || load().mode === 'free';
}

// ===== 跨裝置同步 =====

export function getSyncCode() {
  return load().syncCode || '';
}

export function setSyncCode(code) {
  const data = load();
  data.syncCode = code;
  save(data);
}

export function getLastSyncedAt() {
  return load().syncedAt || '';
}

// 匯出要同步的資料（不含裝置本地設定：模式、同步碼）
export function exportSyncData() {
  const { words, stars, daily, deleted } = load();
  return { words, stars, daily, deleted };
}

// 用伺服器合併後的結果覆蓋本地（保留本地的模式與同步碼）
export function applySyncData(merged, syncedAt) {
  const data = load();
  data.words = merged.words || [];
  data.stars = merged.stars || 0;
  data.daily = merged.daily || {};
  data.deleted = merged.deleted || {};
  data.syncedAt = syncedAt || new Date().toISOString();
  save(data);
}
