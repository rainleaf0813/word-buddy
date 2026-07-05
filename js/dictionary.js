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

// ===== 免費翻譯（Google 端點優先，MyMemory 備援，都失敗回傳空字串）=====

async function googleTranslate(text) {
  const res = await fetch(
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-TW&dt=t&q=${encodeURIComponent(text)}`
  );
  if (!res.ok) throw new Error('google translate failed');
  const data = await res.json();
  return (data[0] || []).map((seg) => seg[0]).join('');
}

async function myMemoryTranslate(text) {
  const res = await fetch(
    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|zh-TW`
  );
  if (!res.ok) throw new Error('mymemory failed');
  const data = await res.json();
  const t = data?.responseData?.translatedText;
  if (!t) throw new Error('mymemory empty');
  return t;
}

export async function translateToZh(text) {
  if (!text) return '';
  try {
    return await googleTranslate(text);
  } catch {
    try {
      return await myMemoryTranslate(text);
    } catch {
      return '';
    }
  }
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

  // 收集字典附的例句（免費模式的例句參考來源），最多 2 句
  const examples = [];
  for (const e of data) {
    for (const m of e.meanings || []) {
      for (const def of m.definitions || []) {
        if (def.example && examples.length < 2) {
          examples.push({ en: def.example, zh: '' });
        }
      }
    }
  }

  // 補上中文：單字本身 + 每條英文定義（並行翻譯，失敗就留空只顯示英文）
  const [wordZh, ...defsZh] = await Promise.all([
    translateToZh(entry.word),
    ...meanings.map((m) => translateToZh(m.definition)),
  ]);
  meanings.forEach((m, i) => { m.zh = defsZh[i] || ''; });

  return { found: true, word: entry.word, phonetic, audio, meanings, wordZh, examples };
}

// 免費模式的例句備援：字典沒附例句時，依詞性給句型模板
export function templateExamples(partOfSpeech, word) {
  const w = word;
  const templates = {
    noun: [`I have a little ${w}.`, `The ${w} is on the table.`],
    verb: [`I ${w} every day.`, `We like to ${w} together.`],
    adjective: [`The dog is very ${w}.`, `It was a ${w} day.`],
    adverb: [`She sings ${w}.`, `He ${w} finished his homework.`],
  };
  const list = templates[partOfSpeech] || [`This is my new word: ${w}.`, `I can use ${w} in a sentence.`];
  return list.map((en) => ({ en, zh: '' }));
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
