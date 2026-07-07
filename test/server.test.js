'use strict';
/*
 * Unit + integration tests for the viewer server. Pure `node --test`, no deps.
 * Boots the server on an ephemeral port, exercises the HTTP + SSE surface,
 * and checks normalization edge cases.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

process.env.PORT = '0'; // ask for ephemeral; we read the real port back
const mod = require('../viewer/server.js');
const { normalizeHook, server, start } = mod;

let base;
before(async () => {
  await start();
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
});
after(() => server.close());

function post(path, body) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// ---------- normalization ----------
test('normalizeHook: main session has no agent_id => agent "main"', () => {
  const e = normalizeHook({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(e.agent, 'main');
  assert.equal(e.agentType, 'main');
  assert.equal(e.tool, 'Bash');
});

test('normalizeHook: agent_id present => subagent', () => {
  const e = normalizeHook({ hook_event_name: 'PreToolUse', session_id: 's1', agent_id: 'ag-9', agent_type: 'Explore', tool_name: 'Grep', tool_input: { pattern: 'x' } });
  assert.equal(e.agent, 'ag-9');
  assert.equal(e.agentType, 'Explore');
});

test('normalizeHook: null/empty agent_id treated as main (not "=== null")', () => {
  assert.equal(normalizeHook({ agent_id: null, session_id: 's' }).agent, 'main');
  assert.equal(normalizeHook({ agent_id: '', session_id: 's' }).agent, 'main');
});

test('normalizeHook: reads tool_output OR tool_response OR tool_result', () => {
  assert.deepEqual(normalizeHook({ tool_output: { a: 1 } }).output, { a: 1 });
  assert.deepEqual(normalizeHook({ tool_response: { b: 2 } }).output, { b: 2 });
  assert.deepEqual(normalizeHook({ tool_result: { c: 3 } }).output, { c: 3 });
});

test('normalizeHook: garbage payload never throws', () => {
  assert.doesNotThrow(() => normalizeHook(null));
  assert.doesNotThrow(() => normalizeHook('nope'));
  assert.doesNotThrow(() => normalizeHook(42));
});

// ---------- HTTP surface ----------
test('POST /event returns 200 fast and buffers the event', async () => {
  await post('/reset');
  const r = await post('/event', { hook_event_name: 'PreToolUse', session_id: 's2', tool_name: 'Read', tool_input: { file_path: '/x' } });
  assert.equal(r.status, 200);
  const h = await (await fetch(base + '/health')).json();
  assert.equal(h.ok, true);
  assert.ok(h.events >= 1);
});

test('POST /event with invalid JSON still 200s (never fail a hook)', async () => {
  const r = await post('/event', '{ not json');
  assert.equal(r.status, 200);
});

test('OTLP /v1/metrics parses a cost metric', async () => {
  await post('/reset');
  const otlp = {
    resourceMetrics: [{
      scopeMetrics: [{
        metrics: [{
          name: 'claude_code.cost.usage',
          sum: { dataPoints: [{ asDouble: 0.0123, attributes: [{ key: 'session.id', value: { stringValue: 's3' } }, { key: 'query.source', value: { stringValue: 'main' } }] }] },
        }],
      }],
    }],
  };
  const r = await post('/v1/metrics', otlp);
  assert.equal(r.status, 200);
  const h = await (await fetch(base + '/health')).json();
  assert.ok(h.events >= 1, 'cost metric should be buffered as an event');
});

// ---------- SSE ----------
test('GET /stream replays backlog then streams a live event', async () => {
  await post('/reset');
  await post('/event', { hook_event_name: 'SessionStart', session_id: 's4', cwd: '/proj' });

  const seen = await new Promise((resolve, reject) => {
    const req = http.get(base + '/stream', (res) => {
      let buf = '';
      const t = setTimeout(() => { req.destroy(); reject(new Error('timeout')); }, 3000);
      res.on('data', (c) => {
        buf += c;
        if (buf.includes('s4') && buf.includes('s5')) { clearTimeout(t); req.destroy(); resolve(buf); }
      });
    });
    req.on('error', () => {}); // destroy() surfaces as error; ignore
    // fire a live event shortly after connecting
    setTimeout(() => post('/event', { hook_event_name: 'Stop', session_id: 's5' }), 150);
  });

  assert.ok(seen.includes('event: activity'));
  assert.ok(seen.includes('"session":"s4"'), 'backlog replayed');
  assert.ok(seen.includes('"session":"s5"'), 'live event streamed');
});

// ---------- static ----------
test('GET / serves the UI', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('Activity Tracker'));
});
