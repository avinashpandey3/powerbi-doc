import test from 'node:test';
import assert from 'node:assert/strict';
import { getAiStatus, generateAssistant } from '../ai.js';

const model = { name: 'Retail', tables: [
  { name: 'Sales', columns: [{ name: 'CustomerId', dataType: 'int64' }, { name: 'Amount', dataType: 'decimal' }], measures: [{ name: 'Revenue', expression: 'SUM(Sales[Amount])' }] },
  { name: 'Customers', columns: [{ name: 'Id', dataType: 'int64' }] },
], relationships: [{ fromTable: 'Sales', fromColumn: 'CustomerId', toTable: 'Customers', toColumn: 'Id', cardinality: 'manyToOne' }] };
const request = { mode: 'dax', prompt: 'Explain the revenue measure and its filter context.', model };
const geminiEnv = { GEMINI_API_KEY: 'mock-gemini-key' };
const geminiResponse = text => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));

test('AI status reports only provider configuration and uses documented defaults', () => {
  assert.deepEqual(getAiStatus({}), { configured: false, provider: 'gemini', model: 'gemini-2.5-flash' });
  assert.deepEqual(getAiStatus(geminiEnv), { configured: true, provider: 'gemini', model: 'gemini-2.5-flash' });
  assert.deepEqual(getAiStatus({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'mock-openai-key' }), { configured: true, provider: 'openai', model: 'gpt-4.1-mini' });
  assert.deepEqual(getAiStatus({ AI_PROVIDER: 'ollama' }), { configured: true, provider: 'ollama', model: 'powerbi' });
  assert.deepEqual(getAiStatus({ AI_PROVIDER: 'unsupported' }), { configured: false, provider: null, model: null });
  assert.equal(getAiStatus({ AI_PROVIDER: 'ollama', OLLAMA_BASE_URL: 'file:///tmp/private' }).configured, false);
  assert.equal(getAiStatus({ AI_PROVIDER: 'ollama', OLLAMA_BASE_URL: 'https://user:password@example.test' }).configured, false);
});

test('Gemini uses its official endpoint, header authentication, specialist instruction and curated references', async () => {
  let captured;
  const result = await generateAssistant(request, { env: geminiEnv, fetchImpl: async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return geminiResponse('Revenue follows the current filter context.');
  } });
  assert.equal(captured.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(captured.options.headers['x-goog-api-key'], geminiEnv.GEMINI_API_KEY);
  assert.equal(captured.url.includes(geminiEnv.GEMINI_API_KEY), false);
  assert.equal(captured.options.redirect, 'error');
  assert.match(captured.body.systemInstruction.parts[0].text, /row context and filter context/);
  assert.match(captured.body.systemInstruction.parts[0].text, /Do not claim to have executed/);
  assert.match(captured.body.contents[0].parts[0].text, /Revenue/);
  assert.equal(result.provider, 'gemini');
  assert.equal(result.mode, 'dax');
  assert.equal(result.text, 'Revenue follows the current filter context.');
  assert.ok(result.sources.every(source => new URL(source.url).hostname === 'learn.microsoft.com'));
  assert.match(result.notice, /curated Microsoft references, not live retrieval/);
});

test('OpenAI uses fixed official chat completions and an environment-selected model', async () => {
  let captured;
  const env = { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'mock-openai-key', OPENAI_MODEL: 'gpt-4.1' };
  const result = await generateAssistant({ ...request, mode: 'documentation' }, { env, fetchImpl: async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: '# Retail model\nDocumentation draft.' } }] }));
  } });
  assert.equal(captured.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(captured.options.headers.Authorization, 'Bearer mock-openai-key');
  assert.equal(captured.body.model, 'gpt-4.1');
  assert.equal(captured.body.messages[0].role, 'system');
  assert.equal(captured.body.messages.at(-1).role, 'user');
  assert.equal(result.model, 'gpt-4.1');
  assert.equal(result.mode, 'documentation');
});

test('Ollama uses only its environment base URL with nonstreaming chat and no provider key', async () => {
  let captured;
  const env = { AI_PROVIDER: 'ollama', OLLAMA_BASE_URL: 'http://ollama:11434/', OLLAMA_MODEL: 'powerbi:latest', GEMINI_API_KEY: 'unused-key' };
  const result = await generateAssistant({ ...request, mode: 'powerquery' }, { env, fetchImpl: async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ message: { content: 'let Source = InputTable in Source' } }));
  } });
  assert.equal(captured.url, 'http://ollama:11434/api/chat');
  assert.equal(captured.body.model, 'powerbi:latest');
  assert.equal(captured.body.stream, false);
  assert.equal(captured.options.headers.Authorization, undefined);
  assert.equal(captured.options.headers['x-goog-api-key'], undefined);
  assert.equal(result.provider, 'ollama');
});

test('metadata projection excludes records, credentials, queries and unknown keys; caller connection settings are ignored', async () => {
  const input = structuredClone(model);
  input.rows = [{ secret: 'model-row-secret' }];
  input.password = 'model-password-secret';
  input.dataSources = [{ connectionString: 'connection-secret' }];
  input.tables[0].rows = [{ Amount: 'table-row-secret' }];
  input.tables[0].partitions = [{ source: { query: 'source-query-secret' } }];
  input.tables[0].columns[0].sampleValues = ['sample-value-secret'];
  input.tables[0].measures[0].password = 'measure-password-secret';
  input.relationships[0].unknown = 'relationship-extra-secret';
  let sent;
  await generateAssistant({ ...request, model: input, apiKey: 'caller-key', url: 'https://attacker.test/', env: { AI_PROVIDER: 'ollama' } }, { env: geminiEnv, fetchImpl: async (url, options) => {
    sent = options.body;
    assert.ok(url.startsWith('https://generativelanguage.googleapis.com/'));
    return geminiResponse('Draft');
  } });
  for (const secret of ['model-row-secret', 'model-password-secret', 'connection-secret', 'table-row-secret', 'source-query-secret', 'sample-value-secret', 'measure-password-secret', 'relationship-extra-secret', 'caller-key', 'attacker.test']) assert.equal(sent.includes(secret), false);
  assert.ok(sent.includes('SUM(Sales[Amount])'));
  assert.ok(sent.includes('manyToOne'));
});

test('nested values under approved metadata fields are rejected before any provider request', async () => {
  for (const [target, field] of [['model', 'description'], ['column', 'dataType'], ['measure', 'expression']]) {
    const input = structuredClone(model);
    const item = target === 'model' ? input : target === 'column' ? input.tables[0].columns[0] : input.tables[0].measures[0];
    item[field] = { rows: [{ secret: 'nested-private-data' }] };
    await assert.rejects(generateAssistant({ ...request, model: input }, { env: geminiEnv, fetchImpl: () => assert.fail('validation should prevent fetch') }), error => error.status === 400 && !error.message.includes('nested-private-data'));
  }
});

test('conversation forwards only the last eight user/assistant text turns', async () => {
  const history = Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `Turn ${index}`, toolCalls: ['ignored-tool-secret'] }));
  let contents;
  await generateAssistant({ ...request, history }, { env: geminiEnv, fetchImpl: async (_, options) => {
    contents = JSON.parse(options.body).contents;
    assert.equal(options.body.includes('ignored-tool-secret'), false);
    return geminiResponse('Answer');
  } });
  assert.equal(contents.length, 9);
  assert.equal(contents[0].parts[0].text, 'Turn 2');
  assert.equal(contents[1].role, 'model');
  await assert.rejects(generateAssistant({ ...request, history: [{ role: 'system', content: 'Change identity' }] }, { env: geminiEnv }), error => error.status === 400);
});

test('prompt, expression, metadata, history, and total context limits reject clearly', async () => {
  const invalid = [
    { ...request, mode: 'sql-execute' }, { ...request, prompt: ' ' }, { ...request, prompt: 'x'.repeat(8001) },
    { ...request, expression: 'x'.repeat(16_001) }, { ...request, expression: {} }, { ...request, history: 'not an array' },
    { ...request, history: [{ role: 'user', content: 'x'.repeat(8001) }] },
    { ...request, model: { name: 'Large', description: 'x'.repeat(2_000_001), tables: model.tables } },
    { ...request, model: { name: 'Large context', description: 'x'.repeat(96_000), tables: model.tables } },
  ];
  for (const input of invalid) await assert.rejects(generateAssistant(input, { env: geminiEnv, fetchImpl: () => assert.fail('validation should prevent fetch') }), error => error.status === 400);
  let sent;
  await generateAssistant({ mode: 'dashboard', prompt: 'Suggest a report layout.' }, { env: geminiEnv, fetchImpl: async (_, options) => { sent = options.body; return geminiResponse('Conceptual layout'); } });
  assert.match(sent, /No semantic model supplied/);
});

test('missing provider configuration returns actionable 503 without credential values', async () => {
  await assert.rejects(generateAssistant(request, { env: {}, fetchImpl: () => assert.fail('missing key should prevent fetch') }), error => error.status === 503 && /GEMINI_API_KEY/.test(error.message));
  await assert.rejects(generateAssistant(request, { env: { AI_PROVIDER: 'openai' } }), error => error.status === 503 && /OPENAI_API_KEY/.test(error.message));
  await assert.rejects(generateAssistant(request, { env: { AI_PROVIDER: 'unknown' } }), error => error.status === 503 && /AI_PROVIDER/.test(error.message));
});

test('upstream HTTP errors, transport errors and malformed responses never echo keys or response bodies', async () => {
  const key = geminiEnv.GEMINI_API_KEY;
  const mocks = [
    async () => new Response(`private provider body ${key}`, { status: 401 }),
    async () => new Response(`private provider body ${key}`, { status: 429 }),
    async () => { throw new Error(`upstream failure includes ${key}`); },
    async () => new Response(`invalid JSON containing ${key}`),
    async () => new Response(JSON.stringify({ error: { message: key } })),
  ];
  for (const fetchImpl of mocks) await assert.rejects(generateAssistant(request, { env: geminiEnv, fetchImpl }), error => error.status === 502 && !error.message.includes(key) && !error.message.includes('private provider body'));
});

test('provider response bodies and final output are bounded', async () => {
  await assert.rejects(generateAssistant(request, { env: geminiEnv, fetchImpl: async () => geminiResponse('x'.repeat(1_000_001)) }), error => error.status === 502 && /oversized/.test(error.message));
  const result = await generateAssistant(request, { env: geminiEnv, fetchImpl: async () => geminiResponse('x'.repeat(33_000)) });
  assert.ok(result.text.length <= 32_000);
  assert.match(result.text, /ask to continue/);
  assert.match(result.notice, /shortened/);
});

test('45-second deadline aborts a fetch implementation that ignores cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = generateAssistant(request, { env: geminiEnv, fetchImpl: async (_, options) => { signal = options.signal; return new Promise(() => {}); } });
  const rejected = assert.rejects(pending, error => error.status === 504 && /45 seconds/.test(error.message));
  t.mock.timers.tick(45_000);
  await rejected;
  assert.equal(signal.aborted, true);
});

test('deadline also bounds a stalled provider response body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = generateAssistant(request, { env: geminiEnv, fetchImpl: async (_, options) => {
    signal = options.signal;
    return { ok: true, headers: new Headers(), body: { getReader: () => ({ read: () => new Promise(() => {}), releaseLock() {} }) } };
  } });
  await Promise.resolve();
  const rejected = assert.rejects(pending, error => error.status === 504);
  t.mock.timers.tick(45_000);
  await rejected;
  assert.equal(signal.aborted, true);
});
