// 語音功能：TTS 朗讀、STT 辨識、逐字比對
// 免費模式用瀏覽器內建語音；AI 模式的朗讀改走 Worker → Azure 神經語音（失敗自動退回內建）

import { WORKER_URL } from './config.js';
import { getMode } from './storage.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export const sttSupported = !!SR;
export const ttsSupported = 'speechSynthesis' in window;

let cachedVoice = null;

function pickVoice() {
  if (cachedVoice) return cachedVoice;
  const voices = speechSynthesis.getVoices();
  const enUS = voices.filter((v) => v.lang.replace('_', '-').startsWith('en-US'));
  // 優先挑品質較好的常見語音
  const preferred = ['Samantha', 'Google US English', 'Microsoft Aria'];
  for (const name of preferred) {
    const hit = enUS.find((v) => v.name.includes(name));
    if (hit) { cachedVoice = hit; return hit; }
  }
  cachedVoice = enUS[0] || voices.find((v) => v.lang.startsWith('en')) || null;
  return cachedVoice;
}

if (ttsSupported) {
  // 有些瀏覽器語音清單是非同步載入的
  speechSynthesis.onvoiceschanged = () => { cachedVoice = null; pickVoice(); };
}

// 朗讀文字（rate < 1 = 放慢，適合小朋友跟讀）
export function speak(text, { rate = 0.85 } = {}) {
  if (getMode() === 'ai' && WORKER_URL) {
    speakViaWorker(text, rate).catch(() => speakLocal(text, rate));
  } else {
    speakLocal(text, rate);
  }
}

function speakLocal(text, rate) {
  if (!ttsSupported) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = rate;
  const voice = pickVoice();
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

let currentAudio = null;

// 停掉所有播放中的聲音（錄音前必呼叫：iOS 音訊通道還在播放模式時開麥克風會收不到音）
export function stopSpeaking() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (ttsSupported) speechSynthesis.cancel();
}

// Azure 神經語音（經 Worker），回傳 mp3 播放
async function speakViaWorker(text, rate) {
  const res = await fetch(`${WORKER_URL}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, rate }),
  });
  if (!res.ok) throw new Error(`tts ${res.status}`);
  const blob = await res.blob();
  if (currentAudio) currentAudio.pause();
  speechSynthesis.cancel();
  const url = URL.createObjectURL(blob);
  currentAudio = new Audio(url);
  currentAudio.onended = () => URL.revokeObjectURL(url);
  await currentAudio.play();
}

// 聽一次使用者說話，回傳候選文字陣列（依信心度排序）
// 回傳的 controller 有 stop() 可手動結束
export function listen({ onResult, onError, onEnd }) {
  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = false;
  rec.maxAlternatives = 5;
  rec.continuous = false;

  rec.onresult = (event) => {
    const alts = [];
    const result = event.results[0];
    for (let i = 0; i < result.length; i++) alts.push(result[i].transcript);
    onResult(alts);
  };
  rec.onerror = (event) => onError(event.error);
  rec.onend = () => onEnd();

  // Safari 的語音辨識要求 start() 必須在使用者手勢當下「同步」呼叫，
  // 中間不能有任何 await／非同步延遲，否則常常靜靜失敗（收不到任何結果）。
  rec.start();

  return { stop: () => rec.stop() };
}

// ===== 逐字比對 =====

const NUM_WORDS = {
  0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five',
  6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten',
  11: 'eleven', 12: 'twelve', 20: 'twenty', 100: 'hundred',
};

const CONTRACTIONS = {
  "don't": 'do not', "doesn't": 'does not', "didn't": 'did not',
  "can't": 'can not', "cannot": 'can not', "won't": 'will not',
  "isn't": 'is not', "aren't": 'are not', "wasn't": 'was not',
  "i'm": 'i am', "it's": 'it is', "that's": 'that is',
  "he's": 'he is', "she's": 'she is', "there's": 'there is',
  "i've": 'i have', "we've": 'we have', "they've": 'they have',
  "i'll": 'i will', "we'll": 'we will', "you're": 'you are',
  "we're": 'we are', "they're": 'they are', "let's": 'let us',
};

// 正規化成單字陣列：小寫、去標點、展開縮寫、數字轉英文
function normalize(text) {
  let t = text.toLowerCase();
  for (const [c, full] of Object.entries(CONTRACTIONS)) {
    t = t.split(c).join(full);
  }
  const tokens = t.match(/[a-z0-9']+/g) || [];
  return tokens.map((tok) => NUM_WORDS[tok] || tok.replace(/'/g, ''));
}

// 用 LCS（最長共同子序列）比對目標句與辨識結果，標出每個目標字有沒有唸對
function matchAgainst(targetNorm, saidNorm) {
  const n = targetNorm.length;
  const m = saidNorm.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = targetNorm[i] === saidNorm[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matched = new Array(n).fill(false);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (targetNorm[i] === saidNorm[j]) { matched[i] = true; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return matched;
}

// 比較目標句子和多個辨識候選，回傳最好的一組結果
// 回傳 { words: [{ text, ok }], score }，words 對應目標句的原始單字
export function comparePronunciation(targetSentence, saidAlternatives) {
  const targetWords = targetSentence.match(/[A-Za-z0-9']+/g) || [];
  // 每個原始字各自正規化（可能展開成多個字，如 don't → do not）
  const expanded = [];   // 正規化後的字
  const owner = [];      // 每個正規化字屬於哪個原始字
  targetWords.forEach((w, idx) => {
    normalize(w).forEach((nw) => { expanded.push(nw); owner.push(idx); });
  });

  let best = null;
  for (const alt of saidAlternatives) {
    const saidNorm = normalize(alt);
    const matched = matchAgainst(expanded, saidNorm);
    const okCount = matched.filter(Boolean).length;
    if (!best || okCount > best.okCount) best = { matched, okCount };
  }
  if (!best) best = { matched: new Array(expanded.length).fill(false), okCount: 0 };

  // 原始字只要有任一對應的正規化字沒唸到，就算沒過
  const wordOk = new Array(targetWords.length).fill(true);
  best.matched.forEach((ok, k) => { if (!ok) wordOk[owner[k]] = false; });

  const okWords = wordOk.filter(Boolean).length;
  return {
    words: targetWords.map((text, idx) => ({ text, ok: wordOk[idx] })),
    score: targetWords.length ? okWords / targetWords.length : 0,
  };
}
