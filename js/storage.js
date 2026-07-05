// 學習紀錄（localStorage）

const KEY = 'wordbuddy.v1';

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || { words: [], stars: 0 };
  } catch {
    return { words: [], stars: 0 };
  }
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

// 完成一次學習：記錄單字與句子，加一顆星
export function recordLearned({ word, phonetic, audio, sentence }) {
  const data = load();
  const existing = data.words.find((w) => w.word === word);
  if (existing) {
    existing.sentence = sentence;
    existing.times += 1;
    existing.learnedAt = new Date().toISOString();
  } else {
    data.words.unshift({
      word, phonetic, audio, sentence,
      times: 1,
      learnedAt: new Date().toISOString(),
    });
  }
  data.stars += 1;
  save(data);
  return data.stars;
}

export function removeWord(word) {
  const data = load();
  data.words = data.words.filter((w) => w.word !== word);
  save(data);
}
