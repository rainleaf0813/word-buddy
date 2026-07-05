// 主流程：學單字 → 造句 → 練發音

import { lookupWord, spellingSuggestions, posToZh } from './dictionary.js';
import { checkGrammar, localChecks } from './grammar.js';
import { speak, listen, comparePronunciation, sttSupported, ttsSupported } from './speech.js';
import { getWords, getStars, recordLearned, removeWord } from './storage.js';

const $ = (id) => document.getElementById(id);

const state = {
  word: '',
  phonetic: '',
  audio: '',
  sentence: '',
  passStreak: 0, // 需要連續唸對的次數（目前 1 次即過關）
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
    const result = await lookupWord(input);
    if (result.found) {
      feedback.innerHTML = '';
      showWordCard(result);
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

function showWordCard({ word, phonetic, audio, meanings }) {
  state.word = word;
  state.phonetic = phonetic;
  state.audio = audio;

  const cardEl = $('word-card');
  cardEl.innerHTML = `
    <div class="word-text">${escapeHtml(word)}</div>
    <div class="word-phonetic">${escapeHtml(phonetic || '')}</div>
    <ul class="word-meanings">
      ${meanings.map((m) => `<li><span class="pos-tag">${escapeHtml(posToZh(m.partOfSpeech))}</span>${escapeHtml(m.definition)}</li>`).join('')}
    </ul>
    <div class="word-actions">
      <button id="btn-word-audio" class="btn btn-secondary" type="button">🔊 聽發音</button>
      <button id="btn-word-next" class="btn btn-primary" type="button">就學這個字 →</button>
    </div>`;
  cardEl.classList.remove('hidden');

  $('btn-word-audio').addEventListener('click', () => playWordAudio(word, audio));
  $('btn-word-next').addEventListener('click', () => {
    $('sentence-word').textContent = state.word;
    $('sentence-input').value = '';
    $('sentence-feedback').innerHTML = '';
    showScreen('sentence');
  });
}

function playWordAudio(word, audioUrl) {
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
    const { errors, hints } = await checkGrammar(sentence);

    if (errors.length === 0) {
      state.sentence = sentence;
      const hintHtml = hints.length
        ? card('hint', '小建議（不改也可以）', hints.map((h) => `<p><span class="error-snippet">${escapeHtml(h.bad)}</span> ${escapeHtml(h.zh)}${h.replacements.length ? `　建議：${escapeHtml(h.replacements.join('、'))}` : ''}</p>`).join(''))
        : '';
      feedback.innerHTML =
        card('ok', '句子沒問題，太棒了！🎉', '<p>接下來大聲唸出你的句子吧！</p>') + hintHtml;
      setTimeout(() => enterSpeakStage(), 900);
    } else {
      feedback.innerHTML = errors.map((err) => card(
        'error',
        `「${escapeHtml(err.bad)}」這裡怪怪的`,
        `<p>${escapeHtml(err.zh)}</p>
         ${err.replacements.length ? `<div class="suggestion-chips">${err.replacements.map((r) => `<button class="chip" data-offset="${err.offset}" data-length="${err.length}" data-to="${escapeHtml(r)}" type="button">改成 ${escapeHtml(r)}</button>`).join('')}</div>` : ''}
         <p class="original-msg">${escapeHtml(err.original)}</p>`
      )).join('');

      // 點建議直接套用修改（用檢查時的位置精準取代，避免改到別的字）
      feedback.querySelectorAll('.chip').forEach((chip) => {
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
  speechSynthesis.cancel();
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
        'not-allowed': '需要麥克風權限才能練發音。請在瀏覽器設定允許使用麥克風。',
        'no-speech': '沒有聽到聲音，再靠近麥克風一點、大聲一點試試看。',
        'audio-capture': '找不到麥克風，檢查一下設備。',
        'network': '語音辨識需要網路，檢查一下連線。',
      }[code] || `語音辨識出了點問題（${code}），再試一次。`;
      $('speak-feedback').innerHTML = card('error', '咦？', `<p>${msg}</p>`);
    },
    onEnd: () => {
      recorder = null;
      btn.classList.remove('is-recording');
      btn.textContent = '🎤 換我唸';
      if (!gotResult) {
        $('speak-feedback').innerHTML = card('hint', '沒有聽清楚', '<p>再按一次麥克風，大聲唸出句子試試看。</p>');
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
    $('speak-feedback').innerHTML = card('ok', '完美！這個發音可以了！🌟', bar);
    setTimeout(() => finishLearning(true), 1200);
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
    audio: state.audio,
    sentence: state.sentence,
  });
  refreshStars();

  $('done-title').textContent = withSpeech ? '太棒了！全部過關！' : '完成囉！';
  $('done-message').textContent = withSpeech
    ? `你學會了「${state.word}」：會拼、會造句、發音也標準，拿到一顆星星 ⭐`
    : `你學會了「${state.word}」：會拼也會造句，拿到一顆星星 ⭐ 下次再挑戰發音！`;

  const confetti = document.querySelector('.confetti');
  const emojis = ['🎉', '⭐', '🎈', '✨', '🍭'];
  confetti.innerHTML = Array.from({ length: 18 }, (_, i) =>
    `<span style="left:${(i * 37) % 100}%;animation-delay:${(i % 6) * 0.35}s">${emojis[i % emojis.length]}</span>`
  ).join('');

  showScreen('done');
}

$('btn-again').addEventListener('click', () => {
  $('word-input').value = '';
  $('word-feedback').innerHTML = '';
  $('word-card').classList.add('hidden');
  showScreen('word');
});

// ===== 單字本 =====

$('btn-wordbook').addEventListener('click', () => {
  renderWordbook();
  showScreen('book');
});

$('btn-book-close').addEventListener('click', () => showScreen('word'));

function renderWordbook() {
  const listEl = $('book-list');
  const words = getWords();
  if (!words.length) {
    listEl.innerHTML = '<p class="book-empty">還沒有學過的單字，快去學第一個吧！🌱</p>';
    return;
  }
  listEl.innerHTML = words.map((w) => `
    <div class="book-item" data-word="${escapeHtml(w.word)}">
      <div class="book-main">
        <div class="book-word">${escapeHtml(w.word)} <small>${escapeHtml(w.phonetic || '')}</small></div>
        <div class="book-sentence">${escapeHtml(w.sentence || '')}</div>
      </div>
      <div class="book-actions">
        <button class="icon-btn book-play" title="聽發音" type="button">🔊</button>
        <button class="icon-btn book-delete" title="刪除" type="button">🗑️</button>
      </div>
    </div>`).join('');

  listEl.querySelectorAll('.book-item').forEach((item) => {
    const word = item.dataset.word;
    const record = words.find((w) => w.word === word);
    item.querySelector('.book-play').addEventListener('click', () => playWordAudio(word, record?.audio));
    item.querySelector('.book-delete').addEventListener('click', () => {
      removeWord(word);
      renderWordbook();
    });
  });
}

// ===== 啟動 =====

refreshStars();
showScreen('word');
if (!ttsSupported) {
  $('word-feedback').innerHTML = card('hint', '提醒', '<p>這個瀏覽器不支援語音朗讀，建議用 Chrome 或 Safari 開啟。</p>');
}
