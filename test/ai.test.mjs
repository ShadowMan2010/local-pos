/* The AI provider layer: which host a key belongs to, and the two request shapes.
 *
 * These tests exist because the provider split is the kind of change that only fails against a live
 * service, which is the slowest and most expensive place to find out. The request a Gemini key makes and
 * the request an OpenRouter key makes are both checked here, with no key and no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectProvider, resolveAi, buildRequest, parseResponse, firstJson, supportsAudioInput, describeAi,
  geminiModelCandidates, GEMINI_FALLBACK_MODELS,
  DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_MODEL
} from '../ai.js';

test('a Google key routes to Gemini, whatever the base URL says', () => {
  assert.equal(detectProvider({ apiKey: 'AIzaSyD-abc123' }), 'gemini');
  assert.equal(detectProvider({ apiKey: 'sk-or-v1-xyz' }), 'openrouter');
});

test('a Google base URL routes to Gemini even with a non-Google key', () => {
  assert.equal(detectProvider({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }), 'gemini');
  assert.equal(detectProvider({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta/' }), 'gemini');
});

test('an explicit provider beats every guess', () => {
  // A proxy in front of Gemini hands out its own key shape, so the switch has to win.
  assert.equal(detectProvider({ provider: 'gemini', apiKey: 'sk-or-v1-xyz', baseUrl: 'https://openrouter.ai/api' }), 'gemini');
  assert.equal(detectProvider({ provider: 'openai', apiKey: 'AIzaSyD-abc123' }), 'openai');
});

test('resolveAi fills a model and base URL per provider, and reports configured only on a key', () => {
  const g = resolveAi({ apiKey: 'AIzaSyD-abc123' });
  assert.equal(g.provider, 'gemini');
  assert.equal(g.model, DEFAULT_GEMINI_MODEL);
  assert.equal(g.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(g.configured, true);

  const o = resolveAi({ apiKey: 'sk-or-v1-x' });
  assert.equal(o.provider, 'openrouter');
  assert.equal(o.model, DEFAULT_OPENAI_MODEL);
  assert.equal(o.baseUrl, 'https://openrouter.ai/api');

  assert.equal(resolveAi({}).configured, false);
  assert.equal(resolveAi({ apiKey: '   ' }).configured, false);
});

test('a saved model and base URL are kept, and trailing slashes do not double up', () => {
  const a = resolveAi({ apiKey: 'AIzaX', model: 'gemini-1.5-pro', baseUrl: 'https://example.test/v1/' });
  assert.equal(a.model, 'gemini-1.5-pro');
  assert.equal(a.baseUrl, 'https://example.test/v1');
});

test('the OpenAI request is a chat completion with a bearer token', () => {
  const r = buildRequest({ ai: { apiKey: 'sk-or-v1-x' }, system: 'be brief', user: 'hi', json: true });
  assert.equal(r.provider, 'openrouter');
  assert.equal(r.url, 'https://openrouter.ai/api/chat/completions');
  assert.equal(r.headers.authorization, 'Bearer sk-or-v1-x');
  assert.deepEqual(r.body.messages, [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' }
  ]);
  assert.deepEqual(r.body.response_format, { type: 'json_object' });
});

test('an image rides as a data URL on the OpenAI message, not as a separate field', () => {
  const r = buildRequest({ ai: { apiKey: 'k' }, user: 'what is this', images: [{ mimeType: 'image/png', base64: 'AAA' }] });
  const content = r.body.messages.at(-1).content;
  assert.equal(Array.isArray(content), true);
  assert.deepEqual(content[0], { type: 'text', text: 'what is this' });
  assert.equal(content[1].image_url.url, 'data:image/png;base64,AAA');
});

test('the Gemini request puts the key in the URL, the model in the path, and JSON in generationConfig', () => {
  const r = buildRequest({
    ai: { apiKey: 'AIzaKey', model: 'gemini-2.0-flash' },
    system: 'be brief', user: 'hi', json: true, maxTokens: 512, temperature: 0.1
  });
  assert.equal(r.provider, 'gemini');
  assert.equal(r.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=AIzaKey');
  assert.equal(r.headers.authorization, undefined);
  assert.deepEqual(r.body.systemInstruction, { parts: [{ text: 'be brief' }] });
  assert.deepEqual(r.body.contents[0].parts, [{ text: 'hi' }]);
  assert.equal(r.body.generationConfig.responseMimeType, 'application/json');
  assert.equal(r.body.generationConfig.maxOutputTokens, 512);
});

test('an image rides as inlineData on the Gemini parts', () => {
  const r = buildRequest({ ai: { apiKey: 'AIzaKey' }, user: 'read this', images: [{ mimeType: 'image/jpeg', base64: 'QkJC' }] });
  assert.deepEqual(r.body.contents[0].parts, [
    { text: 'read this' },
    { inlineData: { mimeType: 'image/jpeg', data: 'QkJC' } }
  ]);
});

test('a model name with characters that need escaping still lands safely in the URL', () => {
  const r = buildRequest({ ai: { apiKey: 'AIzaKey', provider: 'gemini', model: 'tuned/models/x' } });
  assert.equal(r.url.includes('tuned%2Fmodels%2Fx'), true);
});

test('parseResponse reads both answer shapes and never throws on a malformed body', () => {
  assert.equal(parseResponse('openrouter', { choices: [{ message: { content: ' hello ' } }] }), 'hello');
  assert.equal(parseResponse('gemini', { candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] }), 'ab');
  assert.equal(parseResponse('gemini', {}), '');
  assert.equal(parseResponse('gemini', null), '');
  assert.equal(parseResponse('openrouter', {}), '');
});

test('firstJson reads a fenced block, a prefixed answer, and braces inside strings', () => {
  assert.deepEqual(firstJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(firstJson('Sure! Here you go: {"a":[1,2]}'), { a: [1, 2] });
  assert.deepEqual(firstJson('[{"a":1}]'), [{ a: 1 }]);
  // A `}` inside a quoted string must not be mistaken for the end of the object.
  assert.deepEqual(firstJson('{"note":"a } brace","n":2}'), { note: 'a } brace', n: 2 });
  assert.equal(firstJson('sorry, I cannot help'), null);
  assert.equal(firstJson('{"a":'), null);
});

test('an empty system prompt adds no message to either provider', () => {
  const o = buildRequest({ ai: { apiKey: 'k' }, user: 'hi' });
  assert.equal(o.body.messages.length, 1);
  const g = buildRequest({ ai: { apiKey: 'AIzaK' }, user: 'hi' });
  assert.equal(g.body.systemInstruction, undefined);
});

test('only a configured Gemini key can be handed audio to transcribe', () => {
  assert.equal(supportsAudioInput({ apiKey: 'AIzaSyD-abc123' }), true);
  assert.equal(supportsAudioInput({ provider: 'gemini', apiKey: 'proxy-key' }), true);
  // An OpenRouter key has no audio part in the chat shape, and no key is not configured at all.
  assert.equal(supportsAudioInput({ apiKey: 'sk-or-v1-xyz' }), false);
  assert.equal(supportsAudioInput({ provider: 'gemini' }), false);
  assert.equal(supportsAudioInput(null), false);
});

test('audio is sent to Gemini as an inlineData part, exactly like a photo', () => {
  const g = buildRequest({ ai: { apiKey: 'AIzaK' }, user: 'Transcribe this.', images: [{ mimeType: 'audio/ogg', base64: 'T2dnUw==' }] });
  const parts = g.body.contents[0].parts;
  const audio = parts.find((p) => p.inlineData);
  assert.equal(audio.inlineData.mimeType, 'audio/ogg');
  assert.equal(audio.inlineData.data, 'T2dnUw==');
});

test('describeAi keeps the declared provider apart from the one detected from the key', () => {
  // Nothing declared: the host is detected as Gemini, but the settings picker must stay on "detect from
  // the key" (blank), or pasting a Gemini key would save an explicit OpenRouter provider.
  assert.deepEqual(describeAi({ apiKey: 'AIzaSyD-abc' }), {
    provider: 'gemini', model: DEFAULT_GEMINI_MODEL, configured: true, declared: ''
  });
  assert.equal(describeAi({ provider: 'openrouter', apiKey: 'AIzaSyD-abc' }).declared, 'openrouter');
  assert.equal(describeAi({}).declared, '');
  // A value that is not a known provider is not echoed back to the picker.
  assert.equal(describeAi({ provider: 'nonsense' }).declared, '');
});

test('a Gemini call tries the chosen model first, then the fallbacks, without repeats', () => {
  // The configured name leads, the known-good fallbacks follow, and a name that is both is not tried twice.
  const c = geminiModelCandidates({ apiKey: 'AIzaK', model: 'gemini-3.6-flash' });
  assert.equal(c[0], 'gemini-3.6-flash');
  assert.equal(c.length, new Set(c).size, 'the candidate list must not repeat a model');
  for (const m of GEMINI_FALLBACK_MODELS) assert.ok(c.includes(m), `${m} missing from candidates`);
  // With no model set, the default leads.
  assert.equal(geminiModelCandidates({ apiKey: 'AIzaK' })[0], DEFAULT_GEMINI_MODEL);
});
