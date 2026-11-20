#!/usr/bin/env node
// Deterministic OpenAI-compatible server for local verification and tests. No network, no cost.
// Endpoints: GET /health, GET /v1/models, POST /v1/chat/completions (stream or not),
//            POST /v1/responses, POST /v1/audio/transcriptions
// Faults (per request header `x-fake-fault` or env FAKE_OPENAI_FAULT): timeout | 500 | 429 | bad-json | slow
// Responses: a fixture in FAKE_OPENAI_FIXTURES (JSON: { "<substring of last user message>": "<reply>" })
// wins; otherwise the reply echoes the last user message so tests can assert on it.
import { readFileSync } from 'node:fs';
import http from 'node:http';

const PORT = Number(process.env.FAKE_OPENAI_PORT ?? 4010);
const fixtures = process.env.FAKE_OPENAI_FIXTURES ? JSON.parse(readFileSync(process.env.FAKE_OPENAI_FIXTURES, 'utf8')) : {};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function lastUserText(body) {
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  const last = [...messages].reverse().find(message => message.role === 'user');
  if (typeof body.input === 'string') return body.input;
  const content = last?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => part.text ?? '').join('');
  return '';
}

function replyFor(text) {
  const match = Object.keys(fixtures).find(key => text.includes(key));
  return match ? fixtures[match] : `fake reply: ${text}`;
}

const usage = (prompt, completion) => ({ prompt_tokens: prompt.length, completion_tokens: completion.length, total_tokens: prompt.length + completion.length });

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if ((req.headers['content-type'] ?? '').includes('application/json') && raw) return JSON.parse(raw);
  return { raw };
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}

export function createFakeOpenAI() {
  return http.createServer(async (req, res) => {
    const fault = req.headers['x-fake-fault'] ?? process.env.FAKE_OPENAI_FAULT ?? '';
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { status: 'ok' });
    if (req.method === 'GET' && req.url === '/v1/models') return json(res, 200, { object: 'list', data: [{ id: 'fake-model', object: 'model' }] });
    if (req.method !== 'POST') return json(res, 404, { error: { message: 'not found' } });

    if (fault === 'timeout') return; // never answers; client timeouts must handle it
    if (fault === '500') return json(res, 500, { error: { message: 'fake upstream error', type: 'server_error' } });
    if (fault === '429') { res.setHeader('retry-after', '1'); return json(res, 429, { error: { message: 'rate limited', type: 'rate_limit_error' } }); }
    if (fault === 'slow') await sleep(3000);
    if (fault === 'bad-json') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"choices": [ not json'); return; }

    const body = await readBody(req).catch(() => null);
    if (!body) return json(res, 400, { error: { message: 'invalid JSON body' } });

    if (req.url === '/v1/audio/transcriptions') return json(res, 200, { text: 'fake transcription' });

    const prompt = lastUserText(body);
    const reply = replyFor(prompt);

    if (req.url === '/v1/responses') {
      return json(res, 200, { id: 'resp_fake', object: 'response', model: body.model ?? 'fake-model', status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] }], output_text: reply,
        usage: { input_tokens: prompt.length, output_tokens: reply.length, total_tokens: prompt.length + reply.length } });
    }

    if (req.url === '/v1/chat/completions') {
      const base = { id: 'chatcmpl-fake', created: 0, model: body.model ?? 'fake-model' };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
        send({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
        for (const piece of reply.match(/.{1,8}/gs) ?? []) {
          send({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
          await sleep(5);
        }
        send({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: usage(prompt, reply) });
        res.end('data: [DONE]\n\n');
        return;
      }
      return json(res, 200, { ...base, object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: usage(prompt, reply) });
    }
    return json(res, 404, { error: { message: 'not found' } });
  });
}

if (process.argv[1]?.endsWith('fake-openai.mjs')) {
  createFakeOpenAI().listen(PORT, '127.0.0.1', () => console.log(`fake-openai listening on http://127.0.0.1:${PORT}/v1`));
}
