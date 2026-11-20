import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createFakeOpenAI } from '../skills/trust-pyramid/templates/verify/fake-openai.mjs';

let server;
let base;
before(async () => {
  server = createFakeOpenAI();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/v1`;
});
after(() => { server.closeAllConnections(); server.close(); });

const chat = (body, headers = {}) => fetch(`${base}/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('chat completion echoes the last user message deterministically', async () => {
  const response = await chat({ model: 'x', messages: [{ role: 'user', content: 'hello' }] });
  const body = await response.json();
  assert.equal(body.choices[0].message.content, 'fake reply: hello');
  assert.ok(body.usage.total_tokens > 0);
});

test('streaming returns SSE chunks that reassemble the reply and end with [DONE]', async () => {
  const response = await chat({ model: 'x', stream: true, messages: [{ role: 'user', content: 'stream me please' }] });
  const text = await response.text();
  const pieces = text.split('\n\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
    .map(chunk => chunk.choices[0].delta.content ?? '').join('');
  assert.equal(pieces, 'fake reply: stream me please');
  assert.match(text, /data: \[DONE\]/);
});

test('responses API and transcription endpoints answer', async () => {
  const response = await fetch(`${base}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'hi' }) });
  assert.equal((await response.json()).output_text, 'fake reply: hi');
  const audio = await fetch(`${base}/audio/transcriptions`, { method: 'POST', body: 'bytes' });
  assert.equal((await audio.json()).text, 'fake transcription');
});

test('fault injection: 429, 500, bad-json and timeout', async () => {
  assert.equal((await chat({}, { 'x-fake-fault': '429' })).status, 429);
  assert.equal((await chat({}, { 'x-fake-fault': '500' })).status, 500);
  await assert.rejects((await chat({}, { 'x-fake-fault': 'bad-json' })).json());
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'x-fake-fault': 'timeout' }, body: '{}', signal: controller.signal }));
});
