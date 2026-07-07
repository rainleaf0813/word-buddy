// 主流程：學單字 → 造句 → 練發音

import { lookupWord, spellingSuggestions, posToZh, templateExamples } from './dictionary.js';
import { checkGrammar, checkGrammarAI, localChecks } from './grammar.js';
import { speak, stopSpeaking, listen, comparePronunciation, sttSupported, ttsSupported } from './speech.js';
import {
  getWords, getStars, recordLearned, removeWord, getMode, setMode, hasMode,
  addStar, getDailyProgress, getStreak,
  getSyncCode, setSyncCode, getLastSyncedAt,
} from './storage.js';
import { syncAvailable, generateSyncCode, syncNow, scheduleSync } from './sync.js';
import { WORKER_URL } from './config.js';

const $ = (id) => document.getElementById(id);

const state = {
  word: '',
  phonetic: '',
  respelling: '',   // 拼讀式音標（AI 模式由 Claude 生成）
  audio: '',
  sentence: '',
  examples: [],     // 例句參考 [{en, zh}]
};

// ===== 畫面切換 =====

const STEP_OF_SCREEN = { word: 'word', sentence: 'sentence', speak: 'speak' };

function showScreen(name) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('is-active'));
  $(`screen-${name}`).classList.add('is-active');

  const order = ['word', 'sentence', 'speak'];
  const current = STEP_OF_SCREEN[name];
  document.querySelectorAll('.step').forEach((el) => {
    el.classList.remove('is-active', 'is-done');
    if (!current) return;
    const idx = order.indexOf(el.dataset.step);
    const cur = order.indexOf(current);
    if (idx < cur) el.classList.add('is-done');
    if (idx === cur) el.classList.add('is-active');
  });
  $('steps').style.visibility = current ? 'visible' : 'hidden';
  window.scrollTo({ top: 0 });
}

function card(kind, title, bodyHtml) {
  return `<div class="card card-${kind}"><p class="card-title">${title}</p>${bodyHtml}</div>`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function refreshStars() {
  $('star-count').textContent = `⭐ ${getStars()}`;
}

// ===== 每日進度與連續打卡 =====

function renderDailyBar() {
  const { count, goal } = getDailyProgress();
  const streak = getStreak();
  const bar = $('daily-bar');
  bar.classList.toggle('is-done', count >= goal);
  bar.innerHTML = `
    <span>${count >= goal ? '🎉 今日目標達成！' : '📚 今天'} ${count}/${goal} 個單字</span>
    ${streak > 0 ? `<span class="daily-streak">連續 ${streak} 天 🔥</span>` : ''}`;
}

// ===== 回首頁 =====

function goHome() {
  $('word-input').value = '';
  $('word-feedback').innerHTML = '';
  $('word-card').classList.add('hidden');
  renderDailyBar();
  showScreen('word');
}

$('btn-home').addEventListener('click', goHome);

// ===== 模式切換（免費 / AI）=====

function aiAvailable() {
  return Boolean(WORKER_URL);
}

function renderMode() {
  const mode = getMode();
  $('mode-free').classList.toggle('is-active', mode === 'free');
  $('mode-ai').classList.toggle('is-active', mode === 'ai');
  $('mode-hint').textContent =
    mode === 'ai'
      ? '✨ AI 模式：Claude 檢查文法、真人感朗讀'
      : '🆓 免費模式：基本檢查，完全免費';
}

document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.mode === 'ai' && !aiAvailable()) {
      $('mode-hint').textContent = 'AI 模式還沒設定完成（需要爸爸先架好金鑰服務），先用免費模式囉！';
      return;
    }
    setMode(btn.dataset.mode);
    renderMode();
  });
});

// ===== 階段 1：學單字 =====

$('word-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('word-input').value.trim();
  const feedback = $('word-feedback');
  const cardEl = $('word-card');
  cardEl.classList.add('hidden');

  if (!/^[A-Za-z][A-Za-z'-]*$/.test(input)) {
    feedback.innerHTML = card('error', '嗯…這看起來不是英文單字', '<p>請輸入一個英文單字（只能有英文字母）。</p>');
    return;
  }

  const btn = $('word-submit');
  btn.disabled = true;
  feedback.innerHTML = card('hint', '查詢中…', '<p>翻字典中，等我一下 📚</p>');

  try {
    // AI 模式同時向 Worker 要拼讀式音標與例句（有快取；失敗不影響流程）
    const [result, aiInfo] = await Promise.all([
      lookupWord(input),
      fetchWordInfoAI(input),
    ]);
    if (result.found) {
      feedback.innerHTML = '';
      showWordCard(result, aiInfo);
    } else {
      const suggestions = await spellingSuggestions(input);
      if (suggestions.length) {
        feedback.innerHTML = card(
          'error',
          `字典裡找不到「${escapeHtml(input)}」`,
          `<p>是不是拼錯了呢？你想拼的是不是：</p>
           <div class="suggestion-chips">
             ${suggestions.map((s) => `<button class="chip" data-word="${escapeHtml(s)}" type="button">${escapeHtml(s)}</button>`).join('')}
           </div>`
        );
        feedback.querySelectorAll('.chip').forEach((chip) => {
          chip.addEventListener('click', () => {
            $('word-input').value = chip.dataset.word;
            $('word-form').requestSubmit();
          });
        });
      } else {
        feedback.innerHTML = card(
          'error',
          `字典裡找不到「${escapeHtml(input)}」`,
          '<p>檢查一下拼字，或換一個單字試試看。</p>'
        );
      }
    }
  } catch (err) {
    feedback.innerHTML = card('error', '連不上字典服務', `<p>檢查一下網路，再按一次「查查看」。</p><p class="original-msg">${escapeHtml(err.message)}</p>`);
  } finally {
    btn.disabled = false;
  }
});

// AI 模式取得拼讀式音標與例句（Worker /word，有 30 天快取）；免費模式或失敗回傳 null
async function fetchWordInfoAI(word) {
  if (getMode() !== 'ai' || !aiAvailable()) return null;
  try {
    const res = await fetch(`${WORKER_URL}/word`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function showWordCard({ word, phonetic, audio, meanings, wordZh }, aiInfo) {
  state.word = word;
  state.phonetic = phonetic;
  state.respelling = aiInfo?.respelling || '';
  state.audio = audio;
  // 例句：AI 模式用 Claude 出的簡單例句；免費模式一律用句型模板
  // （字典附的例句難度不穩定，常超出小學程度，不再使用）
  state.examples = aiInfo?.examples?.length
    ? aiInfo.examples
    : templateExamples(meanings?.[0]?.partOfSpeech, word);

  // 音標：AI 模式顯示拼讀式（跟學校講義一樣），免費模式顯示 IPA
  const phoneticDisplay = state.respelling ? `[ ${state.respelling} ]` : (phonetic || '');

  const cardEl = $('word-card');
  cardEl.innerHTML = `
    <div class="word-text">${escapeHtml(word)}</div>
    <div class="word-phonetic">${escapeHtml(phoneticDisplay)}</div>
    ${wordZh ? `<div class="word-zh">${escapeHtml(wordZh)}</div>` : ''}
    <ul class="word-meanings">
      ${meanings.map((m) => `<li><span class="pos-tag">${escapeHtml(posToZh(m.partOfSpeech))}</span>${escapeHtml(m.definition)}${m.zh ? `<div class="def-zh">${escapeHtml(m.zh)}</div>` : ''}</li>`).join('')}
    </ul>
    <div class="word-actions">
      <button id="btn-word-audio" class="btn btn-secondary" type="button">🔊 聽發音</button>
      <button id="btn-word-next" class="btn btn-primary" type="button">就學這個字 →</button>
    </div>`;
  cardEl.classList.remove('hidden');

  $('btn-word-audio').addEventListener('click', () => playWordAudio(word, audio));
  $('btn-word-next').addEventListener('click', () => enterSentenceStage());
}

// 進入造句階段（學新字與單字本重練共用）；prefill：重練時帶入上次造的句子
function enterSentenceStage(prefill = '') {
  $('sentence-word').textContent = state.word;
  $('sentence-input').value = prefill;
  $('sentence-feedback').innerHTML = '';
  renderExamples();
  showScreen('sentence');
}

// ===== 例句參考 =====

function renderExamples() {
  const box = $('examples-box');
  const list = $('examples-list');
  if (!state.examples.length) {
    box.classList.add('hidden');
    return;
  }
  list.innerHTML = state.examples.slice(0, 2).map((ex, i) =>
    `<li class="ex-item">
       <button class="icon-btn ex-play" data-i="${i}" title="朗讀例句" type="button">🔊</button>
       <div class="ex-text">${escapeHtml(ex.en)}${ex.zh ? `<div class="ex-zh">${escapeHtml(ex.zh)}</div>` : ''}</div>
     </li>`
  ).join('');
  list.querySelectorAll('.ex-play').forEach((btn) => {
    btn.addEventListener('click', () => speak(state.examples[Number(btn.dataset.i)].en, { rate: 0.85 }));
  });
  list.classList.remove('hidden');
  $('btn-toggle-examples').textContent = '隱藏例句';
  box.classList.remove('hidden');
}

$('btn-toggle-examples').addEventListener('click', () => {
  const list = $('examples-list');
  const hidden = list.classList.toggle('hidden');
  $('btn-toggle-examples').textContent = hidden ? '顯示例句' : '隱藏例句';
});

function playWordAudio(word, audioUrl) {
  // AI 模式一律用 Azure 神經語音（字典附的錄音檔是志願者錄的，品質不穩、常常糊糊的）
  if (getMode() === 'ai' && aiAvailable()) {
    speak(word, { rate: 0.8 });
    return;
  }
  if (audioUrl) {
    new Audio(audioUrl).play().catch(() => speak(word));
  } else {
    speak(word);
  }
}

// ===== 階段 2：造句 =====

$('sentence-submit').addEventListener('click', async () => {
  const sentence = $('sentence-input').value.trim();
  const feedback = $('sentence-feedback');
  const btn = $('sentence-submit');

  // 先做免費又即時的本地檢查
  const problems = localChecks(sentence, state.word);
  if (problems.length) {
    feedback.innerHTML = card('error', '先修改一下這些地方：',
      `<ul>${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`);
    return;
  }

  btn.disabled = true;
  feedback.innerHTML = card('hint', '檢查中…', '<p>幫你看看文法 🔍</p>');

  try {
    // 依模式選擇引擎：AI 模式失敗自動退回免費引擎
    let result = null;
    let usedFallback = false;
    if (getMode() === 'ai' && aiAvailable()) {
      try {
        result = await checkGrammarAI(sentence, state.word);
      } catch {
        usedFallback = true;
      }
    }
    if (!result) result = await checkGrammar(sentence);
    const { errors, hints = [], corrected = '' } = result;
    const fallbackNote = usedFallback
      ? card('hint', 'AI 引擎暫時連不上', '<p>這次先用免費引擎幫你檢查。</p>')
      : '';

    if (errors.length === 0) {
      state.sentence = sentence;
      const hintHtml = hints.length
        ? card('hint', '小建議（不改也可以）', hints.map((h) => `<p><span class="error-snippet">${escapeHtml(h.bad)}</span> ${escapeHtml(h.zh)}${h.replacements.length ? `　建議：${escapeHtml(h.replacements.join('、'))}` : ''}</p>`).join(''))
        : '';
      feedback.innerHTML =
        card('ok', '句子沒問題，太棒了！🎉',
          `<p>準備好了就按下面的按鈕，練習大聲唸出你的句子！</p>
           <div class="suggestion-chips">
             <button id="btn-goto-speak" class="btn btn-primary" type="button">下一步：練發音 🎤</button>
           </div>`) + hintHtml + fallbackNote;
      document.getElementById('btn-goto-speak').addEventListener('click', enterSpeakStage);
    } else {
      const correctedHtml = corrected && corrected.trim() !== sentence
        ? `<div class="suggestion-chips"><button id="chip-corrected" class="chip" type="button">🪄 幫我改好整句</button></div>`
        : '';
      feedback.innerHTML = fallbackNote + errors.map((err) => card(
        'error',
        `「${escapeHtml(err.bad)}」這裡怪怪的`,
        `<p>${escapeHtml(err.zh)}</p>
         ${err.replacements.length ? `<div class="suggestion-chips">${err.replacements.map((r) => `<button class="chip" data-offset="${err.offset}" data-length="${err.length}" data-to="${escapeHtml(r)}" type="button">改成 ${escapeHtml(r)}</button>`).join('')}</div>` : ''}
         ${err.original ? `<p class="original-msg">${escapeHtml(err.original)}</p>` : ''}`
      )).join('') + correctedHtml;

      // AI 給的完整正確句子：一鍵套用
      const chipCorrected = document.getElementById('chip-corrected');
      if (chipCorrected) {
        chipCorrected.addEventListener('click', () => {
          $('sentence-input').value = corrected.trim();
          $('sentence-submit').click();
        });
      }

      // 點建議直接套用修改（用檢查時的位置精準取代，避免改到別的字）
      feedback.querySelectorAll('.chip[data-to]').forEach((chip) => {
        chip.addEventListener('click', () => {
          const el = $('sentence-input');
          if (el.value.trim() !== sentence) return; // 句子已被手動改過，不能再用舊位置
          const start = Number(chip.dataset.offset);
          const end = start + Number(chip.dataset.length);
          el.value = sentence.slice(0, start) + chip.dataset.to + sentence.slice(end);
          $('sentence-submit').click();
        });
      });
    }
  } catch (err) {
    feedback.innerHTML = card('error', '連不上文法檢查服務', `<p>檢查一下網路，再試一次。</p><p class="original-msg">${escapeHtml(err.message)}</p>`);
  } finally {
    btn.disabled = false;
  }
});

$('btn-back-word').addEventListener('click', () => showScreen('word'));

// ===== 階段 3：練發音 =====

let recorder = null;

// 是否從桌面圖示開啟（standalone 模式）：麥克風權限每次都要重新允許
const isStandalone =
  window.matchMedia?.('(display-mode: standalone)').matches ||
  window.navigator.standalone === true;

function enterSpeakStage() {
  renderSpeakSentence(null);
  $('speak-feedback').innerHTML = sttSupported
    ? ''
    : card('hint', '這個瀏覽器不支援語音辨識',
        '<p>你還是可以聽標準讀音、自己練習，然後按「跳過發音練習」完成。iPhone 請用 Safari 開啟。</p>');
  $('btn-record').disabled = !sttSupported;
  showScreen('speak');
}

// words: comparePronunciation 的結果；null = 還沒唸過
function renderSpeakSentence(words) {
  const el = $('speak-sentence');
  // 切成「單字」與「其他字元（空格、標點）」兩種片段，原樣保留空格
  const tokens = state.sentence.match(/[A-Za-z0-9']+|[^A-Za-z0-9']+/g) || [];
  let i = 0;
  el.innerHTML = tokens.map((t) => {
    if (!/[A-Za-z0-9']/.test(t[0])) return escapeHtml(t);
    const cls = words ? (words[i++].ok ? 'is-good' : 'is-bad') : '';
    return `<span class="speak-word ${cls}" data-word="${escapeHtml(t)}">${escapeHtml(t)}</span>`;
  }).join('');
  // 點任何字都可以單獨聽發音
  el.querySelectorAll('.speak-word').forEach((span) => {
    span.addEventListener('click', () => speak(span.dataset.word, { rate: 0.7 }));
  });
}

$('btn-play-standard').addEventListener('click', () => speak(state.sentence, { rate: 0.85 }));

$('btn-record').addEventListener('click', () => {
  const btn = $('btn-record');
  if (recorder) { // 正在錄音 → 手動停止
    recorder.stop();
    return;
  }
  stopSpeaking(); // 停掉所有播放中的聲音，iOS 才能順利切到收音模式
  btn.classList.add('is-recording');
  btn.textContent = '🛑 我唸完了';
  $('speak-feedback').innerHTML = card('hint', '我在聽…', '<p>對著麥克風，慢慢唸出你的句子 🎧</p>');

  let gotResult = false;
  recorder = listen({
    onResult: (alternatives) => {
      gotResult = true;
      handlePronunciationResult(alternatives);
    },
    onError: (code) => {
      gotResult = true;
      const msg = {
        'not-allowed': '需要麥克風權限才能練發音。請在跳出的視窗按「允許」。',
        'service-not-allowed': '需要麥克風權限才能練發音。請在跳出的視窗按「允許」。',
        'no-speech': '沒有聽到聲音，再靠近麥克風一點、大聲一點試試看。',
        'audio-capture': '找不到麥克風，檢查一下設備。',
        'network': '語音辨識需要網路，檢查一下連線。',
      }[code] || `語音辨識出了點問題（${code}），再試一次。`;
      // 桌面小 App 模式的麥克風權限不會被記住，失敗時多給一條路
      const standaloneTip = isStandalone
        ? '<p>💡 從桌面圖示開啟時，每次都要重新允許麥克風。如果一直失敗，把 App 往上滑關掉再重開，或改用 Safari 開啟練發音。</p>'
        : '';
      $('speak-feedback').innerHTML = card('error', '咦？', `<p>${msg}</p>${standaloneTip}`);
    },
    onEnd: () => {
      recorder = null;
      btn.classList.remove('is-recording');
      btn.textContent = '🎤 換我唸';
      if (!gotResult) {
        const standaloneTip = isStandalone
          ? '<p>💡 一直聽不到的話，把 App 往上滑關掉再重開，或改用 Safari 開啟練發音。</p>'
          : '';
        $('speak-feedback').innerHTML = card('hint', '沒有聽清楚', `<p>再按一次麥克風，大聲唸出句子試試看。</p>${standaloneTip}`);
      }
    },
  });
});

function handlePronunciationResult(alternatives) {
  const { words, score } = comparePronunciation(state.sentence, alternatives);
  renderSpeakSentence(words);

  const pct = Math.round(score * 100);
  const bar = `<div class="score-bar"><div class="score-fill" style="width:${pct}%"></div></div><p>唸對了 ${pct}% 的字</p>`;

  if (score >= 1) {
    $('speak-feedback').innerHTML = card('ok', '完美！這個發音可以了！🌟',
      `${bar}
       <p>要繼續練習，還是就這樣過關呢？</p>
       <div class="suggestion-chips">
         <button id="btn-speak-more" class="chip" type="button">🔁 繼續練</button>
         <button id="btn-speak-pass" class="btn btn-primary" type="button">✅ 過關！</button>
       </div>`);
    document.getElementById('btn-speak-more').addEventListener('click', () => {
      $('speak-feedback').innerHTML = card('hint', '好，再唸一次！', '<p>按「🎤 換我唸」繼續練習這句話。</p>');
    });
    document.getElementById('btn-speak-pass').addEventListener('click', () => finishLearning(true));
  } else if (score >= 0.7) {
    const badWords = words.filter((w) => !w.ok).map((w) => w.text);
    $('speak-feedback').innerHTML = card('hint', '快成功了！',
      `${bar}<p>紅色的字再加油：<strong>${escapeHtml(badWords.join('、'))}</strong>。點紅色的字聽標準讀音，然後再唸一次整句。</p>`);
  } else {
    $('speak-feedback').innerHTML = card('error', '再試一次，你可以的！💪',
      `${bar}<p>先按「🔊 聽標準讀音」跟著唸幾次，再按麥克風挑戰。</p>`);
  }
}

$('btn-back-sentence').addEventListener('click', () => showScreen('sentence'));
$('btn-skip-speak').addEventListener('click', () => finishLearning(false));

// ===== 完成 =====

function finishLearning(withSpeech) {
  recordLearned({
    word: state.word,
    phonetic: state.phonetic,
    respelling: state.respelling,
    audio: state.audio,
    sentence: state.sentence,
  });
  refreshStars();
  afterDataChange();

  $('done-title').textContent = withSpeech ? '太棒了！全部過關！' : '完成囉！';
  $('done-message').textContent = withSpeech
    ? `你學會了「${state.word}」：會拼、會造句、發音也標準，拿到一顆星星 ⭐`
    : `你學會了「${state.word}」：會拼也會造句，拿到一顆星星 ⭐ 下次再挑戰發音！`;

  const confetti = document.querySelector('.confetti');
  const emojis = ['🤎', '🌷', '⭐', '✨', '☕'];
  confetti.innerHTML = Array.from({ length: 18 }, (_, i) =>
    `<span style="left:${(i * 37) % 100}%;animation-delay:${(i % 6) * 0.35}s">${emojis[i % emojis.length]}</span>`
  ).join('');

  showScreen('done');
}

$('btn-again').addEventListener('click', goHome);

// ===== 單字本 =====

$('btn-wordbook').addEventListener('click', () => {
  $('book-search').value = '';
  renderWordbook();
  renderSyncPanel();
  showScreen('book');
});

// ===== 跨裝置同步面板 =====

function formatSyncTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderSyncPanel(message = '') {
  const panel = $('sync-panel');
  if (!syncAvailable()) { panel.innerHTML = ''; return; }
  const code = getSyncCode();

  if (!code) {
    panel.innerHTML = `
      <div class="sync-title">☁️ 跨裝置同步</div>
      <p class="sync-desc">開啟後，手機和電腦的單字本會自動保持一致。</p>
      <div class="suggestion-chips">
        <button id="btn-sync-create" class="chip" type="button">✨ 建立新同步碼</button>
        <button id="btn-sync-join" class="chip" type="button">🔗 輸入已有的同步碼</button>
      </div>
      <div id="sync-join-form" class="sync-join hidden">
        <input id="sync-code-input" class="input-big sync-code-input" type="text" maxlength="16"
               placeholder="輸入另一台裝置上的同步碼" autocapitalize="characters" autocorrect="off" spellcheck="false">
        <button id="btn-sync-join-go" class="btn btn-primary" type="button">連結</button>
      </div>
      <p class="sync-status">${escapeHtml(message)}</p>`;

    document.getElementById('btn-sync-create').addEventListener('click', async () => {
      setSyncCode(generateSyncCode());
      renderSyncPanel('同步中…');
      const r = await syncNow();
      renderSyncPanel(r.ok ? '' : '⚠️ 連不上同步服務，稍後會自動再試');
    });
    document.getElementById('btn-sync-join').addEventListener('click', () => {
      document.getElementById('sync-join-form').classList.remove('hidden');
      document.getElementById('sync-code-input').focus();
    });
    document.getElementById('btn-sync-join-go')?.addEventListener('click', async () => {
      const input = document.getElementById('sync-code-input').value.trim().toUpperCase();
      if (!/^[A-Z0-9-]{6,32}$/.test(input)) {
        renderSyncPanel('⚠️ 同步碼格式不對，請再檢查一次');
        return;
      }
      setSyncCode(input);
      renderSyncPanel('同步中…');
      const r = await syncNow();
      if (r.ok) {
        refreshStars();
        renderDailyBar();
        renderWordbook($('book-search').value);
        renderSyncPanel('✅ 同步完成！');
      } else {
        renderSyncPanel('⚠️ 連不上同步服務，請確認網路後再試');
      }
    });
  } else {
    const last = getLastSyncedAt();
    panel.innerHTML = `
      <div class="sync-title">☁️ 跨裝置同步（已開啟）</div>
      <p class="sync-desc">同步碼：<strong class="sync-code">${escapeHtml(code)}</strong><br>
      在另一台裝置的單字本點「輸入已有的同步碼」，輸入這組碼即可。</p>
      <div class="suggestion-chips">
        <button id="btn-sync-now" class="chip" type="button">🔄 立即同步</button>
        <button id="btn-sync-off" class="chip" type="button">關閉同步</button>
      </div>
      <p class="sync-status">${escapeHtml(message || (last ? `上次同步：${formatSyncTime(last)}` : ''))}</p>`;

    document.getElementById('btn-sync-now').addEventListener('click', async () => {
      renderSyncPanel('同步中…');
      const r = await syncNow();
      if (r.ok) {
        refreshStars();
        renderDailyBar();
        renderWordbook($('book-search').value);
        renderSyncPanel('✅ 同步完成！');
      } else {
        renderSyncPanel('⚠️ 連不上同步服務，請確認網路後再試');
      }
    });
    document.getElementById('btn-sync-off').addEventListener('click', () => {
      setSyncCode('');
      renderSyncPanel();
    });
  }
}

// 資料變動後在背景排程同步，完成時順手更新畫面數字
function afterDataChange() {
  scheduleSync(() => {
    refreshStars();
    renderDailyBar();
  });
}

$('btn-book-close').addEventListener('click', goHome);
$('book-search').addEventListener('input', () => renderWordbook($('book-search').value));

function formatDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '更早之前' : `${d.getMonth() + 1}月${d.getDate()}日`;
}

function renderWordbook(filter = '') {
  const listEl = $('book-list');
  const q = filter.trim().toLowerCase();
  // 依學習日期新 → 舊排序；有搜尋字時比對單字與句子
  const words = getWords()
    .slice()
    .sort((a, b) => new Date(b.learnedAt || 0) - new Date(a.learnedAt || 0))
    .filter((w) => !q || w.word.toLowerCase().includes(q) || (w.sentence || '').toLowerCase().includes(q));

  if (!words.length) {
    listEl.innerHTML = q
      ? `<p class="book-empty">找不到「${escapeHtml(filter)}」，換個字搜搜看？🔍</p>`
      : '<p class="book-empty">還沒有學過的單字，快去學第一個吧！🌱</p>';
    return;
  }
  // 依日期分組：日期標題在上，底下列出當天學的所有單字
  const groups = [];
  for (const w of words) {
    const label = formatDate(w.learnedAt);
    if (!groups.length || groups[groups.length - 1].label !== label) {
      groups.push({ label, items: [] });
    }
    groups[groups.length - 1].items.push(w);
  }

  const itemHtml = (w) => `
    <div class="book-item" data-word="${escapeHtml(w.word)}">
      <div class="book-main">
        <div class="book-word">${escapeHtml(w.word)} <small>${escapeHtml(w.respelling ? `[${w.respelling}]` : (w.phonetic || ''))}</small></div>
        <div class="book-sentence">${escapeHtml(w.sentence || '')}</div>
        ${w.times > 1 ? `<div class="book-date">練過 ${w.times} 次</div>` : ''}
      </div>
      <div class="book-actions">
        <button class="icon-btn book-play" title="聽發音" type="button">🔊</button>
        <button class="icon-btn book-practice" title="再練一次" type="button">✏️</button>
        <button class="icon-btn book-delete" title="刪除" type="button">🗑️</button>
      </div>
    </div>`;

  listEl.innerHTML = groups.map((g) => `
    <div class="book-group">
      <div class="book-group-date">📅 ${escapeHtml(g.label)}<span class="book-group-count">${g.items.length} 個單字</span></div>
      ${g.items.map(itemHtml).join('')}
    </div>`).join('');

  listEl.querySelectorAll('.book-item').forEach((item) => {
    const word = item.dataset.word;
    const record = words.find((w) => w.word === word);
    item.querySelector('.book-play').addEventListener('click', () => playWordAudio(word, record?.audio));
    item.querySelector('.book-practice').addEventListener('click', () => practiceAgain(record));
    item.querySelector('.book-delete').addEventListener('click', () => {
      removeWord(word);
      afterDataChange();
      renderWordbook($('book-search').value);
    });
  });
}

// 一鍵重練：直接帶著這個字進造句階段
async function practiceAgain(record) {
  state.word = record.word;
  state.phonetic = record.phonetic || '';
  state.respelling = record.respelling || '';
  state.audio = record.audio || '';
  const aiInfo = await fetchWordInfoAI(record.word); // 有快取，AI 模式下幾乎即時
  state.examples = aiInfo?.examples?.length ? aiInfo.examples : templateExamples('', record.word);
  if (aiInfo?.respelling) state.respelling = aiInfo.respelling;
  enterSentenceStage(record.sentence || '');
}

// ===== 複習測驗「考考我」=====

const quiz = { queue: [], index: 0, correct: 0, attempts: 0 };

$('btn-quiz').addEventListener('click', () => {
  const words = getWords();
  if (words.length < 3) {
    $('book-list').insertAdjacentHTML('afterbegin',
      card('hint', '單字還不夠多', '<p>先學滿 3 個單字，再來挑戰「考考我」吧！💪</p>'));
    return;
  }
  // 隨機抽最多 5 題
  quiz.queue = words.slice().sort(() => Math.random() - 0.5).slice(0, 5);
  quiz.index = 0;
  quiz.correct = 0;
  showScreen('quiz');
  nextQuizQuestion();
});

function currentQuizWord() {
  return quiz.queue[quiz.index];
}

function nextQuizQuestion() {
  quiz.attempts = 0;
  $('quiz-progress').textContent = `第 ${quiz.index + 1} / ${quiz.queue.length} 題`;
  $('quiz-input').value = '';
  $('quiz-input').disabled = false;
  $('quiz-feedback').innerHTML = '';
  $('quiz-input').focus();
  const w = currentQuizWord();
  setTimeout(() => playWordAudio(w.word, w.audio), 400);
}

$('btn-quiz-play').addEventListener('click', () => {
  const w = currentQuizWord();
  if (w) playWordAudio(w.word, w.audio);
});

$('quiz-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const w = currentQuizWord();
  if (!w) return;
  const answer = $('quiz-input').value.trim().toLowerCase();
  if (!answer) return;

  if (answer === w.word.toLowerCase()) {
    quiz.correct += 1;
    addStar();
    refreshStars();
    afterDataChange();
    $('quiz-feedback').innerHTML = card('ok', '答對了！+1 ⭐', `<p>${escapeHtml(w.word)}，很棒！</p>`);
    advanceQuiz();
  } else if (quiz.attempts === 0) {
    quiz.attempts = 1;
    $('quiz-feedback').innerHTML = card('hint', '再想想！',
      `<p>提示：這個字有 ${w.word.length} 個字母，開頭是「${escapeHtml(w.word[0])}」。再聽一次試試看！</p>`);
    playWordAudio(w.word, w.audio);
  } else {
    $('quiz-feedback').innerHTML = card('error', '沒關係，看一下正確答案',
      `<p>正確拼法是 <strong>${escapeHtml(w.word)}</strong>，下次一定行！</p>`);
    advanceQuiz();
  }
});

function advanceQuiz() {
  $('quiz-input').disabled = true;
  setTimeout(() => {
    quiz.index += 1;
    if (quiz.index < quiz.queue.length) {
      nextQuizQuestion();
    } else {
      finishQuiz();
    }
  }, 1600);
}

function finishQuiz() {
  $('quiz-progress').textContent = '';
  $('quiz-input').disabled = true;
  const total = quiz.queue.length;
  const praise = quiz.correct === total ? '全對！你太厲害了！🏆'
    : quiz.correct >= total / 2 ? '表現不錯，繼續加油！🌟'
    : '多練幾次就會更熟囉！💪';
  $('quiz-feedback').innerHTML = card('ok', `測驗結束：${quiz.correct} / ${total} 題答對`,
    `<p>${praise}</p>
     <div class="suggestion-chips">
       <button id="btn-quiz-again" class="chip" type="button">🔁 再來一回合</button>
     </div>`);
  document.getElementById('btn-quiz-again').addEventListener('click', () => $('btn-quiz').click());
}

$('btn-quiz-exit').addEventListener('click', () => {
  renderWordbook($('book-search').value);
  showScreen('book');
});

// ===== 啟動 =====

// 新裝置預設進 AI 模式（Worker 已設定時），避免不知情地用到免費模式
if (!hasMode() && aiAvailable()) setMode('ai');

refreshStars();
renderMode();
renderDailyBar();
showScreen('word');

// 開啟 App 時先同步一次，把其他裝置學的字帶進來
if (getSyncCode()) {
  syncNow().then((r) => {
    if (r.ok) {
      refreshStars();
      renderDailyBar();
    }
  });
}
if (!ttsSupported) {
  $('word-feedback').innerHTML = card('hint', '提醒', '<p>這個瀏覽器不支援語音朗讀，建議用 Chrome 或 Safari 開啟。</p>');
}
