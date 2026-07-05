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
