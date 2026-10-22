/* The AI provider layer: one place that knows how to talk to each model host.
 *
 * The shop's AI key is set once and used in two shapes that do not look alike. OpenAI and OpenRouter
 * speak `POST {base}/chat/completions` with a `messages` array and answer under
 * `choices[0].message.content`. Gemini speaks `POST {base}/models/{model}:generateContent?key=…` with
 * `contents` and `systemInstruction`, and answers under `candidates[0].content.parts[].text`. Everything
 * in this file exists so that the rest of the server never has to know which one is configured.
 *
 * This file is pure on purpose: it builds request objects and reads response objects, and does no
 * `fetch` of its own. That is what lets a Gemini request be checked without a key, a network, or a
 * bill, which matters because the shape of a provider's request is exactly the thing that breaks when
 * somebody adds a provider and only finds out in production.
 */

export const DEFAULT_OPENAI_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
export const DEFAULT_OPENAI_BASE = 'https://openrouter.ai/api';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
export const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Model names to fall back to when the configured one is gone or overloaded.
 *
 * Google retires model names on its own schedule — `gemini-2.0-flash` answered every call one month and
 * a flat 404 the next — and the newest name is periodically overloaded (a 503). Either one took the
 * whole AI surface down silently, because every feature funnels through one model name. The shop cannot
 * maintain a code change when that happens, so a call walks a short list of names instead of trusting
 * one: the configured (or default) name first, then these, known-good at the time of writing. Keep them
 * ordered newest-reliable first, and expect to refresh the list when Google retires the lot.
 */
export const GEMINI_FALLBACK_MODELS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-flash-lite-latest',
  'gemini-3.1-flash-lite'
];

/** The ordered model names a Gemini call should try: the chosen one first, then the fallbacks, deduped. */
export function geminiModelCandidates(ai) {
  return [...new Set([resolveAi(ai).model, ...GEMINI_FALLBACK_MODELS])].filter(Boolean);
}

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

/**
 * Which host a saved key belongs to.
 *
 * Google keys start with `AIza`, which is a strong enough signal to route on without asking, and the
 * default base URL says the same thing for anybody who pasted a base URL instead of a key. An explicit
 * `provider` always wins, so a proxy or a self-hosted gateway can be pointed at by hand.
 */
export function detectProvider(ai) {
  const declared = String(ai?.provider || '').trim().toLowerCase();
  if (declared === 'gemini' || declared === 'openai' || declared === 'openrouter') return declared;
  const base = String(ai?.baseUrl || '').toLowerCase();
  if (base.includes('generativelanguage.googleapis.com')) return 'gemini';
  const key = String(ai?.apiKey || '').trim();
  if (/^AIza[\w-]+$/.test(key)) return 'gemini';
  return 'openrouter';
}

/**
 * Everything the callers need, in one shape.
 *
 * `configured` is the only thing the API and the screens should branch on: it means there is a key, not
 * that the key works. A key that a provider rejects is indistinguishable from no key from here, and both
 * cases fall back to a person rather than to a broken screen.
 */
export function resolveAi(ai) {
  const provider = detectProvider(ai);
  const key = String(ai?.apiKey || '').trim();
  if (provider === 'gemini') {
    return {
      provider,
      key,
      configured: Boolean(key),
      model: String(ai?.model || '').trim() || DEFAULT_GEMINI_MODEL,
      baseUrl: trimSlash(ai?.baseUrl) || DEFAULT_GEMINI_BASE
    };
  }
  return {
    provider,
    key,
    configured: Boolean(key),
    model: String(ai?.model || '').trim() || DEFAULT_OPENAI_MODEL,
    baseUrl: trimSlash(ai?.baseUrl) || DEFAULT_OPENAI_BASE
  };
}

/**
 * The request to `fetch`, as `{ url, headers, body }`, for either host.
 *
 * `images` are `{ mimeType, base64 }`, already read off disk or off the wire. Gemini carries them as
 * `inlineData` parts; the OpenAI shape carries them as `data:` URLs on the user message. Both are built
 * here so a vision feature only has to collect the bytes.
 */
export function buildRequest({ ai, system = '', user = '', images = [], json = false, maxTokens = 300, temperature = 0.3 }) {
  const a = resolveAi(ai);
  if (a.provider === 'gemini') {
    const parts = [{ text: user }];
    for (const img of images) {
      if (img?.base64) parts.push({ inlineData: { mimeType: img.mimeType || 'image/jpeg', data: img.base64 } });
    }
    return {
      provider: a.provider,
      url: `${a.baseUrl}/models/${encodeURIComponent(a.model)}:generateContent?key=${encodeURIComponent(a.key)}`,
      headers: { 'content-type': 'application/json' },
      body: {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
          ...(json ? { responseMimeType: 'application/json' } : {})
        }
      }
    };
  }

  const content = images.length
    ? [
        { type: 'text', text: user },
        ...images.filter((i) => i?.base64).map((i) => ({
          type: 'image_url',
          image_url: { url: `data:${i.mimeType || 'image/jpeg'};base64,${i.base64}` }
        }))
      ]
    : user;
  return {
    provider: a.provider,
    url: `${a.baseUrl}/chat/completions`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${a.key}` },
    body: {
      model: a.model,
      temperature,
      max_tokens: maxTokens,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content }
      ]
    }
  };
}

/** The assistant's text, whichever host answered. Returns '' rather than throwing on a malformed body. */
export function parseResponse(provider, body) {
  if (provider === 'gemini') {
    const parts = body?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
  }
  return String(body?.choices?.[0]?.message?.content || '').trim();
}

/**
 * The first JSON value in a model's answer.
 *
 * Asked for JSON, a model still sometimes wraps it in ```json fences or writes a sentence first, and
 * both are cheap to tolerate. This walks the text for the first balanced array or object and parses
 * that, rather than failing the whole feature over a stray syllable.
 */
export function firstJson(text) {
  const s = String(text || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1] : s;
  const start = source.search(/[[{]/);
  if (start === -1) return null;
  const open = source[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(source.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** A short line for a screen or a log: which host, which model, nothing that is a secret. */
export function describeAi(ai) {
  const a = resolveAi(ai);
  // `provider` is the host that would actually be used, detected from the key when none was chosen. The
  // settings screen must not write that back into its picker, or "detect from the key" becomes a one-time
  // choice that sticks: a shopkeeper who pastes a Gemini key would save an explicit OpenRouter provider
  // and send a Gemini key to OpenRouter. `declared` is what was actually saved, and is what the picker
  // shows — blank meaning "keep detecting".
  const declared = String(ai?.provider || '').trim().toLowerCase();
  return {
    provider: a.provider,
    model: a.model,
    configured: a.configured,
    declared: ['gemini', 'openai', 'openrouter'].includes(declared) ? declared : ''
  };
}

/**
 * Whether this provider can be handed audio to transcribe.
 *
 * Gemini's `generateContent` is multimodal: an `inlineData` part can carry audio exactly as it carries a
 * photo, so a voice note can be transcribed with the same request the vision features already build — no
 * second transcription service and no local Whisper install needed. The OpenAI-compatible chat shape has
 * no equivalent part, so those hosts cannot, and the caller falls back to a local Whisper server instead.
 */
export function supportsAudioInput(ai) {
  const a = resolveAi(ai);
  return a.configured && a.provider === 'gemini';
}
