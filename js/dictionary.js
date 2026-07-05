// 單字查詢與拼字建議（Free Dictionary API + Datamuse，皆免費無需 key）

const POS_ZH = {
  noun: '名詞',
  verb: '動詞',
  adjective: '形容詞',
  adverb: '副詞',
  pronoun: '代名詞',
  preposition: '介系詞',
  conjunction: '連接詞',
  interjection: '感嘆詞',
  exclamation: '感嘆詞',
  determiner: '限定詞',
  numeral: '數詞',
};

export function posToZh(pos) {
  return POS_ZH[pos] || pos;
}

// 查單字：查得到回傳單字卡資料，查不到回傳 { found: false }
export async function lookupWord(word) {
  const res = await fetch(
    `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`
  );
  if (res.status === 404) return { found: false };
  if (!res.ok) throw new Error(`字典服務錯誤（${res.status}）`);

  const data = await res.json();
  const entry = data[0];

  // 挑一個可播放的音檔，美式優先
  let audio = '';
  for (const e of data) {
    const list = e.phonetics || [];
    const us = list.find((p) => p.audio && p.audio.includes('-us.'));
    const any = list.find((p) => p.audio);
    if (us) { audio = us.audio; break; }
    if (any && !audio) audio = any.audio;
  }

  const phonetic =
    entry.phonetic ||
    (entry.phonetics || []).map((p) => p.text).find(Boolean) ||
    '';

  // 每種詞性取第一個定義，最多 3 種
  const meanings = (entry.meanings || []).slice(0, 3).map((m) => ({
    partOfSpeech: m.partOfSpeech,
    definition: m.definitions?.[0]?.definition || '',
  }));

  return { found: true, word: entry.word, phonetic, audio, meanings };
}

// 拼字建議：Datamuse 的 sp= 模糊比對，回傳最多 3 個候選字
export async function spellingSuggestions(word) {
  const res = await fetch(
    `https://api.datamuse.com/words?sp=${encodeURIComponent(word)}&max=6`
  );
  if (!res.ok) return [];
  const list = await res.json();
  return list
    .filter((item) => item.word.toLowerCase() !== word.toLowerCase())
    .filter((item) => item.score > 100) // 過濾冷僻字
    .slice(0, 3)
    .map((item) => item.word);
}
