// 文法檢查：免費引擎（LanguageTool + 中文化）與 AI 引擎（Claude，經 Cloudflare Worker）

import { WORKER_URL } from './config.js';

// 常見規則 → 小朋友看得懂的中文解說
const RULE_ZH = {
  MORFOLOGIK_RULE_EN_US: '這個字拼錯了喔，檢查一下字母有沒有寫對。',
  UPPERCASE_SENTENCE_START: '句子的第一個字母要大寫。',
  I_LOWERCASE: '「I」（我）不管在句子哪裡，永遠都要大寫。',
  EN_A_VS_AN: 'a 和 an 的用法：後面的字如果是母音「音」開頭（像 apple、egg），要用 an。',
  HE_VERB_AGR: '主詞是 he、she、it（第三人稱單數）的時候，現在式動詞要加 s 或 es。',
  NON3PRS_VERB: '主詞和動詞不一致：這個主詞不能配這種動詞形式，檢查要不要加 s。',
  BE_VBP_IN: 'be 動詞（am / is / are）要跟主詞配對：I 用 am、he/she/it 用 is、you/we/they 用 are。',
  DID_BASEFORM: 'did、do、does 後面要接「原形動詞」，不用再變化。',
  TO_NON_BASE: 'to 後面要接原形動詞，例如 to go、to eat。',
  MANY_NN: '「many、few」這類字後面要接複數名詞，記得加 s。',
  MUCH_COUNTABLE: 'much 用在不可數名詞；可以數的東西要用 many。',
  A_UNCOUNTABLE: '這是不可數名詞，前面不能加 a / an。',
  DT_DT: '冠詞（a / an / the）重複了，留一個就好。',
  EN_CONTRACTION_SPELLING: '縮寫拼法不對，注意撇號（\'）的位置，例如 don\'t、I\'m。',
  APOS_ARE: '注意縮寫的寫法，例如 you\'re（你是）和 your（你的）不一樣。',
  DOUBLE_PUNCTUATION: '標點符號重複了，一個就夠囉。',
  UNLIKELY_OPENING_PUNCTUATION: '句子開頭不應該有這個標點符號。',
  SENTENCE_WHITESPACE: '句號後面要空一格再開始下一句。',
  COMMA_PARENTHESIS_WHITESPACE: '標點符號旁邊的空格位置不對。',
  EN_UNPAIRED_BRACKETS: '括號或引號沒有成對，少了一半喔。',
  ENGLISH_WORD_REPEAT_RULE: '同一個字連續出現兩次，刪掉一個吧。',
  ENGLISH_WORD_REPEAT_BEGINNING_RULE: '連續好幾句都用同一個字開頭，試著換個開頭。',
  PHRASE_REPETITION: '這段話重複了，檢查一下是不是多打了。',
  TOO_TO: 'too（太、也）和 to（到、去）是不同的字，看看用對了嗎？',
  ITS_IT_S: 'it\'s 是「它是」（it is）的縮寫；its 是「它的」。想想你要表達哪一個？',
  THEIR_IS: 'their（他們的）、there（那裡）、they\'re（他們是）發音一樣但意思不同。',
  CONFUSION_OF_THEN_THAN: 'then（然後）和 than（比較用）是不同的字。',
  A_INFINITIVE: '冠詞 a / an 後面要接名詞，不能直接接動詞。',
  PRP_VBG: '代名詞後面的動詞形式不對，想想需不需要 be 動詞。',
  BEEN_PART_AGREEMENT: 'have / has 後面要用過去分詞（例如 have eaten、has gone）。',
  PLURAL_VERB_AFTER_THIS: 'this / that 後面接單數，these / those 才接複數。',
  THIS_NNS: 'this 配單數名詞，these 才配複數名詞。',
  AI_HYDRA_LEO_MISSING_COMMA: '這裡少了一個逗號。',
  MISSING_GENITIVE: '表示「誰的」東西時，記得加上 \'s。',
};

// 類別 fallback：規則沒有對應時，用錯誤類別給通用中文說明
const CATEGORY_ZH = {
  TYPOS: '拼字問題',
  GRAMMAR: '文法問題',
  PUNCTUATION: '標點符號問題',
  CASING: '大小寫問題',
  TYPOGRAPHY: '格式問題',
  CONFUSED_WORDS: '容易混淆的字',
  REDUNDANCY: '有點囉嗦的用法',
  STYLE: '用字小建議',
  SEMANTICS: '意思怪怪的',
  COLLOCATIONS: '搭配詞用法',
  COMPOUNDING: '複合字寫法',
  NONSTANDARD_PHRASES: '不太標準的說法',
};

// 這些類型只當「小建議」，不擋過關
const HINT_ISSUE_TYPES = new Set(['style', 'locale-violation', 'register']);

function zhExplain(match) {
  const ruleId = match.rule?.id || '';
  const categoryId = match.rule?.category?.id || '';
  if (RULE_ZH[ruleId]) return RULE_ZH[ruleId];
  const cat = CATEGORY_ZH[categoryId] || '這裡可能有問題';
  return `${cat}：看看下面的建議怎麼改。`;
}

// 呼叫 LanguageTool 檢查句子，回傳中文化後的結果
export async function checkGrammar(text) {
  const body = new URLSearchParams({
    language: 'en-US',
    text,
    level: 'picky',
  });
  const res = await fetch('https://api.languagetool.org/v2/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`文法檢查服務錯誤（${res.status}）`);

  const data = await res.json();
  const items = (data.matches || []).map((m) => ({
    bad: text.substr(m.offset, m.length),
    offset: m.offset,
    length: m.length,
    zh: zhExplain(m),
    original: m.message || '',
    replacements: (m.replacements || []).slice(0, 3).map((r) => r.value),
    isHint: HINT_ISSUE_TYPES.has(m.rule?.issueType),
  }));

  return {
    errors: items.filter((i) => !i.isHint),
    hints: items.filter((i) => i.isHint),
  };
}

// ===== 本地文法規則：不規則複數 + 第三人稱單數動詞 =====
// LanguageTool 對句首大寫的 People/Children 會誤判成專有名詞而漏抓（如 People likes），
// 所以用清單比對自己攔。動詞用「清單」而非 -s 字尾規則，避免 always/sometimes 誤報。

const IRREGULAR_PLURALS = new Set([
  'people', 'children', 'men', 'women', 'police',
  'feet', 'teeth', 'mice', 'geese', 'oxen',
]);

const SINGULAR_VERBS = new Set([
  'is', 'was', 'has', 'does', 'goes', 'likes', 'loves', 'eats', 'wants',
  'needs', 'plays', 'runs', 'makes', 'gets', 'says', 'comes', 'lives',
  'works', 'looks', 'gives', 'takes', 'thinks', 'knows', 'feels', 'helps',
  'keeps', 'puts', 'reads', 'sees', 'sleeps', 'speaks', 'swims', 'walks',
  'watches', 'writes', 'studies', 'tries', 'flies', 'carries', 'teaches',
  'catches', 'brushes', 'washes', 'misses', 'dances', 'sings', 'jumps',
  'drinks', 'rides', 'drives', 'opens', 'closes', 'cleans', 'cooks',
  'cries', 'laughs', 'listens', 'learns', 'visits', 'buys', 'sells',
  'sits', 'stands', 'stops', 'starts', 'talks', 'tells', 'turns', 'uses',
  'waits', 'wears', 'wins', 'wishes', 'enjoys', 'hates', 'asks',
  'answers', 'draws', 'smiles', 'stays', 'holds', 'hears', 'finds',
  'brings', 'sends', 'meets', 'calls', 'moves', 'flies', 'grows',
]);

// 單數動詞 → 複數（原形）建議
function pluralVerbForm(verb) {
  const special = { is: 'are', was: 'were', has: 'have', does: 'do', goes: 'go' };
  if (special[verb]) return special[verb];
  if (verb.endsWith('ies')) return `${verb.slice(0, -3)}y`;
  if (/(ches|shes|sses|xes|zes)$/.test(verb)) return verb.slice(0, -2);
  return verb.slice(0, -1);
}

function pluralAgreementCheck(sentence) {
  const problems = [];
  const tokens = sentence.toLowerCase().match(/[a-z']+/g) || [];
  for (let i = 0; i < tokens.length - 1; i++) {
    if (IRREGULAR_PLURALS.has(tokens[i]) && SINGULAR_VERBS.has(tokens[i + 1])) {
      problems.push(
        `「${tokens[i]} ${tokens[i + 1]}」：${tokens[i]} 本身就是複數名詞，` +
        `後面的動詞要用複數形（不加 s），要改成「${tokens[i]} ${pluralVerbForm(tokens[i + 1])}」。`
      );
    }
  }
  return problems;
}

// AI 文法檢查：走 Cloudflare Worker → Claude。回傳格式與 checkGrammar 相同，
// 另附 corrected（AI 給的完整正確句子，供一鍵修正）。
export async function checkGrammarAI(sentence, word) {
  const res = await fetch(`${WORKER_URL}/grammar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sentence, word }),
  });
  if (!res.ok) throw new Error(`AI 文法服務錯誤（${res.status}）`);
  const data = await res.json();

  const errors = (data.errors || []).map((e) => {
    const offset = sentence.indexOf(e.bad);
    return {
      bad: e.bad,
      offset,
      length: e.bad.length,
      zh: e.zh,
      original: '',
      replacements: offset >= 0 ? (e.suggestions || []).slice(0, 3) : [],
    };
  });
  return { errors, hints: [], corrected: data.corrected || '' };
}

// 本地快速檢查（不耗 API）：回傳中文提醒訊息陣列，空陣列 = 通過
export function localChecks(sentence, targetWord) {
  const problems = [];
  const trimmed = sentence.trim();

  if (!trimmed) {
    problems.push('先寫一個句子吧！');
    return problems;
  }
  if (trimmed.split(/\s+/).length < 2) {
    problems.push('句子太短囉，至少要有兩個字以上。');
  }
  if (/^[a-z]/.test(trimmed)) {
    problems.push('句子的第一個字母要大寫喔。');
  }
  if (!/[.!?]$/.test(trimmed)) {
    problems.push('句子的結尾要加上標點符號（. 或 ! 或 ?）。');
  }
  if (!containsWord(trimmed, targetWord)) {
    problems.push(`句子裡要用到今天學的單字「${targetWord}」喔。`);
  }
  problems.push(...pluralAgreementCheck(trimmed));
  return problems;
}

// 檢查句子是否包含目標單字（容許常見的變化形：複數、過去式、進行式）
function containsWord(sentence, word) {
  const w = word.toLowerCase();
  const forms = new Set([w, `${w}s`, `${w}es`, `${w}ed`, `${w}ing`]);
  if (w.endsWith('e')) {
    forms.add(`${w}d`);
    forms.add(`${w.slice(0, -1)}ing`);
  }
  if (/[^aeiou]y$/.test(w)) {
    forms.add(`${w.slice(0, -1)}ies`);
    forms.add(`${w.slice(0, -1)}ied`);
  }
  // 字尾子音重複（run → running）
  if (/[aeiou][^aeiouwxy]$/.test(w)) {
    forms.add(`${w}${w[w.length - 1]}ing`);
    forms.add(`${w}${w[w.length - 1]}ed`);
  }
  const tokens = sentence.toLowerCase().match(/[a-z']+/g) || [];
  return tokens.some((t) => forms.has(t));
}
