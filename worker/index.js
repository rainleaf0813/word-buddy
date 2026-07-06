// Word Buddy API Worker — 保護金鑰的中轉站
// 端點：POST /grammar（Claude 文法檢查）、POST /tts（Azure 神經語音）
// Secrets（用 wrangler secret put 設定）：ANTHROPIC_API_KEY、AZURE_SPEECH_KEY、AZURE_REGION

const ALLOWED_ORIGINS = [
  'https://rainleaf0813.github.io',
  'http://127.0.0.1:8899',
  'http://localhost:8899',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request.headers.get('Origin') || '');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);

    const url = new URL(request.url);
    try {
      if (url.pathname === '/grammar') return await grammar(request, env, cors);
      if (url.pathname === '/tts') return await tts(request, env, ctx, cors);
      if (url.pathname === '/word') return await wordInfo(request, env, ctx, cors);
      if (url.pathname === '/sync') return await sync(request, env, cors);
      return json({ error: 'not found' }, 404, cors);
    } catch (err) {
      return json({ error: String(err) }, 500, cors);
    }
  },
};

// ===== 文法檢查（Claude Haiku，structured outputs 保證回傳合法 JSON）=====

const GRAMMAR_SCHEMA = {
  type: 'object',
  properties: {
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          bad: { type: 'string', description: '句子中有錯誤的原文片段，必須與原句完全一致' },
          zh: { type: 'string', description: '給 11 歲小朋友看的繁體中文解說，親切、簡短、說清楚為什麼錯' },
          suggestions: { type: 'array', items: { type: 'string' }, description: '修正建議，直接可替換 bad 的文字' },
        },
        required: ['bad', 'zh', 'suggestions'],
        additionalProperties: false,
      },
    },
    corrected: { type: 'string', description: '修正後的完整正確句子；原句已正確時填原句' },
  },
  required: ['errors', 'corrected'],
  additionalProperties: false,
};

async function grammar(request, env, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not set' }, 503, cors);
  const { sentence, word } = await request.json();
  if (!sentence || sentence.length > 300) return json({ error: 'bad sentence' }, 400, cors);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system:
        '你是一位溫柔的英文老師，學生是 11 歲、母語為繁體中文的女孩。' +
        '檢查她寫的英文句子，找出文法、用字、拼字錯誤。' +
        '解說必須用繁體中文、口語親切、小學生能懂，不用術語轟炸；' +
        '每個錯誤的 bad 欄位必須是原句中一模一樣的片段。' +
        '標點與大小寫的小問題也要指出。句子正確時 errors 回傳空陣列。',
      messages: [
        {
          role: 'user',
          content: `這是用單字「${word}」造的句子，請檢查：\n${sentence}`,
        },
      ],
      output_config: { format: { type: 'json_schema', schema: GRAMMAR_SCHEMA } },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    return json({ error: `anthropic ${res.status}`, detail: detail.slice(0, 300) }, 502, cors);
  }
  const data = await res.json();
  const text = data.content?.find((b) => b.type === 'text')?.text || '{}';
  return json(JSON.parse(text), 200, cors);
}

// ===== 跨裝置同步（KV 儲存，以同步碼為 key）=====
// 客戶端送上完整本地資料，伺服器與雲端版本合併後存回並回傳合併結果。
// 合併規則：單字取 learnedAt 較新的那筆（times 取大者）；刪除紀錄（tombstone）較新則移除；
// 星星取大值；每日學習數逐日取大值。

function mergeData(a, b) {
  const words = new Map();
  for (const w of [...(a.words || []), ...(b.words || [])]) {
    const prev = words.get(w.word);
    if (!prev) {
      words.set(w.word, { ...w });
    } else {
      const newer = new Date(w.learnedAt || 0) > new Date(prev.learnedAt || 0) ? w : prev;
      words.set(w.word, { ...newer, times: Math.max(prev.times || 1, w.times || 1) });
    }
  }
  // 刪除紀錄：刪除時間比該字最後學習時間新，才真的移除
  const deleted = { ...(a.deleted || {}), ...(b.deleted || {}) };
  for (const [word, delAt] of Object.entries(a.deleted || {})) {
    if (b.deleted?.[word] && new Date(b.deleted[word]) > new Date(delAt)) deleted[word] = b.deleted[word];
  }
  for (const [word, delAt] of Object.entries(deleted)) {
    const rec = words.get(word);
    if (rec && new Date(delAt) > new Date(rec.learnedAt || 0)) words.delete(word);
  }
  const daily = { ...(a.daily || {}) };
  for (const [day, n] of Object.entries(b.daily || {})) {
    daily[day] = Math.max(daily[day] || 0, n);
  }
  return {
    words: [...words.values()].sort((x, y) => new Date(y.learnedAt || 0) - new Date(x.learnedAt || 0)),
    deleted,
    stars: Math.max(a.stars || 0, b.stars || 0),
    daily,
  };
}

async function sync(request, env, cors) {
  if (!env.SYNC) return json({ error: 'sync not configured' }, 503, cors);
  const { code, data } = await request.json();
  if (!code || !/^[A-Za-z0-9-]{6,32}$/.test(code)) return json({ error: 'bad code' }, 400, cors);

  const stored = await env.SYNC.get(`sync:${code}`, 'json');
  const merged = mergeData(stored || {}, data || {});
  // 一年沒同步就自動清除；每次同步重新計時
  await env.SYNC.put(`sync:${code}`, JSON.stringify(merged), { expirationTtl: 60 * 60 * 24 * 365 });
  return json({ data: merged, syncedAt: new Date().toISOString() }, 200, cors);
}

// ===== 單字資訊（拼讀式音標 + 兒童例句，Claude Haiku，快取 30 天）=====

const WORD_SCHEMA = {
  type: 'object',
  properties: {
    respelling: {
      type: 'string',
      description:
        '美式兒童字典拼讀式音標（respelling），小寫、音節用連字號分隔，重音節可用長音符號，' +
        '例如 once → wuns、adorable → uh-dor-uh-bul、finally → fī-nuh-lē。不要用 IPA。',
    },
    examples: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          en: {
            type: 'string',
            description:
              '使用該單字的英文例句。嚴格限制：6-10 個英文單字；除目標單字外只能用最常見的基礎單字（CEFR A1-A2）；' +
              '只用「主詞+動詞+受詞」等簡單句型，禁止關係子句、that/because 子句、被動語態、分詞構句。',
          },
          zh: { type: 'string', description: '該例句的繁體中文翻譯' },
        },
        required: ['en', 'zh'],
        additionalProperties: false,
      },
      description: '兩句例句，兩句用不同的簡單句型',
    },
  },
  required: ['respelling', 'examples'],
  additionalProperties: false,
};

async function wordInfo(request, env, ctx, cors) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not set' }, 503, cors);
  const { word } = await request.json();
  if (!word || !/^[A-Za-z][A-Za-z'-]{0,40}$/.test(word)) return json({ error: 'bad word' }, 400, cors);

  const key = word.toLowerCase();
  // v2：2026-07-06 例句難度調整（改版本號讓舊快取全部失效）
  const cacheKey = new Request(`https://word.cache/v2/${encodeURIComponent(key)}`, { method: 'GET' });
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) {
    const cached = new Response(hit.body, hit);
    Object.entries(cors).forEach(([k, v]) => cached.headers.set(k, v));
    return cached;
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      system:
        '你替小學五、六年級（11-12 歲）、母語為繁體中文、英文程度初級的孩子準備英文單字學習資料。' +
        '例句必須簡單到她一眼看懂：短句（6-10 個字）、基礎單字、簡單句型，內容生活化正向（家人、寵物、學校、玩耍）。' +
        '寧可簡單也不要展示複雜文法。',
      messages: [{ role: 'user', content: `單字：${key}` }],
      output_config: { format: { type: 'json_schema', schema: WORD_SCHEMA } },
    }),
  });
  if (!res.ok) return json({ error: `anthropic ${res.status}` }, 502, cors);

  const data = await res.json();
  const text = data.content?.find((b) => b.type === 'text')?.text || '{}';
  const response = new Response(text, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=2592000',
      ...cors,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ===== 朗讀（Azure 神經語音，Worker Cache 快取重複句子）=====

async function tts(request, env, ctx, cors) {
  if (!env.AZURE_SPEECH_KEY || !env.AZURE_REGION) {
    return json({ error: 'Azure speech not configured' }, 503, cors);
  }
  const { text, rate = 0.85 } = await request.json();
  if (!text || text.length > 300) return json({ error: 'bad text' }, 400, cors);

  // 以文字+語速當快取 key，重複的句子不重複扣 Azure 額度
  const cacheKey = new Request(
    `https://tts.cache/${encodeURIComponent(text)}?rate=${rate}`,
    { method: 'GET' }
  );
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) {
    const cached = new Response(hit.body, hit);
    Object.entries(cors).forEach(([k, v]) => cached.headers.set(k, v));
    return cached;
  }

  const prosodyRate = rate <= 0.7 ? '-30%' : '-12%';
  const ssml =
    `<speak version='1.0' xml:lang='en-US'>` +
    `<voice name='en-US-JennyNeural'>` +
    `<prosody rate='${prosodyRate}'>${escapeXml(text)}</prosody>` +
    `</voice></speak>`;

  const res = await fetch(
    `https://${env.AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'word-buddy', // Azure TTS 必填標頭，Worker fetch 預設不送

      },
      body: ssml,
    }
  );
  if (!res.ok) {
    const detail = await res.text();
    return json({ error: `azure ${res.status}`, detail: detail.slice(0, 300) }, 502, cors);
  }

  const audio = await res.arrayBuffer();
  const response = new Response(audio, {
    status: 200,
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'public, max-age=2592000',
      ...cors,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function escapeXml(s) {
  return s.replace(/[&<>'"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;',
  }[c]));
}
