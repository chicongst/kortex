#!/usr/bin/env node
'use strict';
/*
 * Activity Tracker viewer server.
 *
 * Pure Node.js (zero dependencies). Responsibilities:
 *   POST /event        <- Claude Code hook payloads (forwarded by scripts/emit.sh)
 *   POST /v1/metrics   <- best-effort OTLP/HTTP JSON metrics (tokens / cost)
 *   POST /v1/logs      <- best-effort OTLP/HTTP JSON logs
 *   GET  /stream       -> Server-Sent Events: replays backlog, then streams live
 *   GET  /             -> the single-file UI
 *   GET  /health       -> { ok, events, clients, off } for tests / monitoring
 *   GET  /state        -> { off } — is tracking disabled? (HUD switch reads this)
 *   POST /toggle       -> flip the on/off sentinel file (HUD switch / command)
 *
 * Design notes:
 *  - The /event handler must return fast so it never blocks Claude. We parse,
 *    normalize, buffer, broadcast, and 200 immediately. Any error still 200s
 *    (a tracker must never fail a hook).
 *  - We read BOTH `tool_output` and `tool_response` because the exact
 *    PostToolUse output field name is not pinned in the public docs.
 *  - Main session vs subagent is detected by the PRESENCE of `agent_id`
 *    (absent => main), never by `=== null`.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PUBLIC_DIR = path.join(__dirname, 'public');
const RING_MAX = Number(process.env.TRACKER_RING || 5000);

// ---- on/off flag -----------------------------------------------------------
// A single sentinel file is the source of truth for "tracking is off". The hook
// transport (emit.sh) and the autostart (ensure-viewer.sh) both check it, so the
// viewer can be toggled from the HUD or the /activity-tracker command and the
// choice sticks across sessions. Presence = OFF.
const FLAG_FILE = process.env.TRACKER_FLAG || path.join(os.homedir(), '.claude', 'activity-tracker.off');
function isOff() { try { return fs.existsSync(FLAG_FILE); } catch { return false; } }
function setOff(off) {
  try {
    if (off) { fs.mkdirSync(path.dirname(FLAG_FILE), { recursive: true }); fs.writeFileSync(FLAG_FILE, 'off\n'); }
    else { fs.rmSync(FLAG_FILE, { force: true }); }
    return true;
  } catch { return false; }
}

// ---- port resolution -------------------------------------------------------
function resolvePort() {
  // accept only a valid TCP port (0 = OS-assigned ephemeral is allowed); anything
  // else falls through to the default so a typo like --port=abc can't silently bind
  // a random port.
  const pick = (v) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isInteger(n) && n >= 0 && n < 65536 ? n : null; };
  const fromArg = process.argv.find((a) => a.startsWith('--port='));
  if (fromArg) { const n = pick(fromArg.split('=')[1]); if (n !== null) return n; }
  if (process.env.PORT != null) { const n = pick(process.env.PORT); if (n !== null) return n; }
  // Derive from the plugin endpoint option if present, e.g. .../:39000/event
  const ep = process.env.CLAUDE_PLUGIN_OPTION_endpoint;
  if (ep) { try { const n = pick(new URL(ep).port); if (n !== null) return n; } catch { /* ignore */ } }
  return 39000;
}
const PORT = resolvePort();
const HOST = process.env.HOST || '127.0.0.1'; // local only, by design

// ---- in-memory state -------------------------------------------------------
let seq = 0;
// A per-process boot token: sent to each client on connect so the browser can
// tell a RECONNECT (same boot → dedup replayed events, don't re-add to totals)
// from a server RESTART (new boot → seq reset, so the client must drop its stale
// graph instead of colliding old node ids with fresh ones).
const BOOT = require('crypto').randomBytes(6).toString('hex');
const ring = [];          // normalized events (bounded)
const clients = new Set(); // active SSE responses

function pushRing(evt) {
  ring.push(evt);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
}

function broadcast(evt) {
  const frame = `event: activity\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { /* client gone; cleaned on close */ }
  }
}

// ---- normalization ---------------------------------------------------------
function normalizeHook(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const hasAgent = Object.prototype.hasOwnProperty.call(p, 'agent_id') &&
    p.agent_id !== null && p.agent_id !== undefined && p.agent_id !== '';
  const output = p.tool_output ?? p.tool_response ?? p.tool_result ?? null;
  return {
    kind: 'hook',
    id: ++seq,
    ts: Date.now(),
    event: p.hook_event_name || 'Unknown',
    session: p.session_id || 'unknown-session',
    agent: hasAgent ? p.agent_id : 'main',
    agentType: p.agent_type || (hasAgent ? 'subagent' : 'main'),
    tool: p.tool_name || null,
    toolUseId: p.tool_use_id ?? p.toolUseId ?? null,
    input: p.tool_input ?? null,
    output,
    cwd: p.cwd || null,
    promptId: p.prompt_id || null,
    effort: p.effort || null,
    raw: p,
  };
}

// ---- OTLP/HTTP JSON (best-effort) -----------------------------------------
// We defensively walk the nested OTLP JSON structure and surface any metric
// whose name mentions cost or token, with its numeric value and attributes.
function attrsToObj(attributes) {
  const out = {};
  if (!Array.isArray(attributes)) return out;
  for (const a of attributes) {
    if (!a || !a.key) continue;
    const v = a.value || {};
    out[a.key] =
      v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? null;
  }
  return out;
}

function dataPointValue(dp) {
  if (dp == null) return 0;
  if (dp.asDouble !== undefined) return Number(dp.asDouble);
  if (dp.asInt !== undefined) return Number(dp.asInt);
  if (dp.value !== undefined) return Number(dp.value);
  return 0;
}

// Per-series running total, so we can turn CUMULATIVE counters into per-export
// deltas. Keyed by metric name + attribute fingerprint.
const lastSeries = new Map();

function handleOtlpMetrics(body) {
  let json;
  try { json = JSON.parse(body); } catch { return; }
  const rms = json.resourceMetrics || [];
  for (const rm of rms) {
    for (const sm of rm.scopeMetrics || []) {
      for (const m of sm.metrics || []) {
        const name = String(m.name || '');
        if (!/cost|token/i.test(name)) continue;
        const sum = m.sum;
        // aggregationTemporality: 1 = DELTA (value is already an increment),
        // 2 = CUMULATIVE (value is a running total → we must diff it).
        const temporality = sum && sum.aggregationTemporality;
        const points =
          (sum && sum.dataPoints) ||
          (m.gauge && m.gauge.dataPoints) ||
          m.dataPoints || [];
        for (const dp of points) {
          const attrs = attrsToObj(dp.attributes);
          let value = dataPointValue(dp);
          if (sum && temporality !== 1) {
            const key = name + '|' + JSON.stringify(attrs);
            const prev = lastSeries.get(key) || 0;
            const delta = value - prev;
            lastSeries.set(key, value);
            value = delta >= 0 ? delta : value; // guard counter resets
          }
          if (!value) continue; // skip no-op exports
          const evt = {
            kind: 'otel',
            id: ++seq,
            ts: Date.now(),
            metric: name,
            value,
            session: attrs['session.id'] || attrs['session_id'] || 'unknown-session',
            querySource: attrs['query.source'] || attrs['query_source'] || null,
            agentName: attrs['agent.name'] || attrs['agent_name'] || null,
            model: attrs['model'] || null,
            tokType: attrs['type'] || null,
            attrs,
          };
          pushRing(evt);
          broadcast(evt);
        }
      }
    }
  }
}

// ---- OTLP/HTTP JSON logs (optional; richer api_request / api_error data) ----
function handleOtlpLogs(body) {
  let json;
  try { json = JSON.parse(body); } catch { return; }
  for (const rl of json.resourceLogs || []) {
    for (const sl of rl.scopeLogs || []) {
      for (const lr of sl.logRecords || []) {
        const attrs = attrsToObj(lr.attributes);
        const name = String(attrs['event.name'] || '').replace(/^claude_code\./, '');
        if (!name) continue;
        const evt = {
          kind: 'log', id: ++seq, ts: Date.now(), event: name,
          session: attrs['session.id'] || attrs['session_id'] || 'unknown-session',
          querySource: attrs['query.source'] || attrs['query_source'] || null,
          agentName: attrs['agent.name'] || attrs['agent_name'] || null,
          model: attrs['model'] || null,
          attrs,
        };
        pushRing(evt); broadcast(evt);
      }
    }
  }
}

// ---- zero-config token/cost source: read Claude Code's own transcript -------
// Every hook payload carries `transcript_path`; the transcript JSONL stores the
// exact per-message usage + model + stop_reason. No OTel / env setup required.
const transcripts = new Map(); // path -> { offset, partial, session }

// Public list prices, USD per million tokens. Per model, R = [input, output, cacheRead];
// cache-write is derived (1.25x input for 5-minute TTL, 2x input for 1-hour TTL). Verified
// against Anthropic model pricing (2026-06). ESTIMATE only — ignores batch (0.5x), priority
// tier, and intro discounts; actual invoice may differ.
function estimateCost(model, inp, out, cw5, cw1h, cr) {
  const m = String(model || '').toLowerCase();
  let R; // [input, output, cacheRead] per MTok
  if (m.includes('fable') || m.includes('mythos')) R = [10, 50, 1.0];
  else if (m.includes('opus')) R = [5, 25, 0.5];
  else if (m.includes('haiku')) R = [1, 5, 0.1];
  else R = [3, 15, 0.3]; // sonnet / default
  // cache write: 1.25x input for 5-minute TTL, 2x input for 1-hour TTL
  return (inp * R[0] + out * R[1] + cr * R[2] + cw5 * R[0] * 1.25 + cw1h * R[0] * 2) / 1e6;
}

function handleTranscriptEntry(o, fallbackSession) {
  if (!o || o.type !== 'assistant' || !o.message || !o.message.usage) return;
  const m = o.message, u = m.usage;
  const inp = u.input_tokens || 0, out = u.output_tokens || 0;
  const cr = u.cache_read_input_tokens || 0, cwTotal = u.cache_creation_input_tokens || 0;
  const cc = u.cache_creation || {};
  let cw5 = cc.ephemeral_5m_input_tokens || 0, cw1h = cc.ephemeral_1h_input_tokens || 0;
  if (!cw5 && !cw1h && cwTotal) cw5 = cwTotal; // older transcripts lack the 5m/1h split
  // tool_use ids in this message = the join key back to the graph's tool nodes,
  // so cost can be attributed to a specific action → its agent → its prompt.
  const toolUseIds = Array.isArray(m.content)
    ? m.content.filter((c) => c && c.type === 'tool_use').map((c) => c.id).filter(Boolean)
    : [];
  const evt = {
    kind: 'usage', id: ++seq, ts: Date.now(),
    session: o.sessionId || o.session_id || fallbackSession || 'unknown-session',
    model: m.model || null, isSidechain: !!o.isSidechain, toolUseIds,
    inputTokens: inp, outputTokens: out, cacheReadTokens: cr, cacheCreateTokens: cwTotal, cw5m: cw5, cw1h: cw1h,
    stopReason: m.stop_reason || null, requestId: o.requestId || null,
    cost: estimateCost(m.model, inp, out, cw5, cw1h, cr), tsIso: o.timestamp || null,
  };
  pushRing(evt); broadcast(evt);
  // Visible narration: the assistant's text blocks — what Claude says between steps
  // ("Let me check X", partial answers). The raw reasoning is omitted from the
  // transcript, so this is the closest live signal to "what Claude is doing".
  const say = Array.isArray(m.content)
    ? m.content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text.trim()).filter(Boolean).join('\n')
    : '';
  if (say) {
    const sev = {
      kind: 'say', id: ++seq, ts: Date.now(), tsIso: o.timestamp || null,
      session: evt.session, isSidechain: !!o.isSidechain, toolUseIds, text: say.slice(0, 2000),
    };
    pushRing(sev); broadcast(sev);
  }
}

function readTranscript(pth, session) {
  if (!pth) return;
  let rec = transcripts.get(pth);
  if (!rec) { rec = { offset: 0, partial: '', session }; transcripts.set(pth, rec); }
  if (session) rec.session = session;
  let st;
  try { st = fs.statSync(pth); } catch { return; }
  if (st.size < rec.offset) { rec.offset = 0; rec.partial = ''; } // truncated/rotated
  if (st.size === rec.offset) return;
  let fd;
  try { fd = fs.openSync(pth, 'r'); } catch { return; }
  const len = st.size - rec.offset, buf = Buffer.alloc(len);
  try { fs.readSync(fd, buf, 0, len, rec.offset); } catch { fs.closeSync(fd); return; }
  fs.closeSync(fd);
  rec.offset = st.size;
  const lines = (rec.partial + buf.toString('utf8')).split('\n');
  rec.partial = lines.pop(); // trailing incomplete line
  for (const line of lines) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    try { handleTranscriptEntry(o, rec.session); } catch { /* ignore one bad entry */ }
  }
}

// ---- helpers ---------------------------------------------------------------
function readBody(req, cap = 5 * 1024 * 1024) {
  return new Promise((resolve) => {
    let data = '';
    let over = false;
    req.on('data', (c) => {
      data += c;
      if (data.length > cap) { over = true; req.destroy(); }
    });
    req.on('end', () => resolve(over ? '' : data));
    req.on('error', () => resolve(''));
  });
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---- server ----------------------------------------------------------------
// true if the request carries an Origin from somewhere other than loopback
function crossOrigin(req) {
  const o = req.headers.origin;
  if (!o) return false;
  try { const h = new URL(o).hostname.toLowerCase(); return !(h === '127.0.0.1' || h === 'localhost' || h === '::1'); }
  catch { return true; } // malformed Origin → treat as cross-origin
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // Localhost-only by design. Reject requests whose Host header isn't a loopback
  // name so a remote page can't reach this socket via DNS rebinding and read the
  // transcript/command data it streams. (The server also binds 127.0.0.1.)
  const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (host && !(host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1' || host === HOST.toLowerCase())) {
    res.writeHead(403).end('forbidden');
    return;
  }
  // CSRF guard for state-changing endpoints: a cross-origin browser page must not be
  // able to flip the on/off switch or wipe the buffer. curl (emit.sh, tests) sends no
  // Origin and is unaffected.
  if (req.method === 'POST' && (p === '/toggle' || p === '/reset') && crossOrigin(req)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  // POST /event : the hook payload. Always 200, always fast.
  if (req.method === 'POST' && p === '/event') {
    const body = await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    try {
      const payload = body ? JSON.parse(body) : {};
      const evt = normalizeHook(payload);
      pushRing(evt);
      broadcast(evt);
      // zero-config: tail the session transcript for token/cost/model/stop_reason
      if (payload && payload.transcript_path) readTranscript(payload.transcript_path, payload.session_id);
    } catch { /* never let a hook fail */ }
    return;
  }

  // OTLP/HTTP JSON receivers (best-effort; used when OTel is enabled).
  if (req.method === 'POST' && (p === '/v1/metrics' || p === '/v1/logs')) {
    const body = await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    if (p === '/v1/metrics') { try { handleOtlpMetrics(body); } catch { /* ignore */ } }
    else if (p === '/v1/logs') { try { handleOtlpLogs(body); } catch { /* ignore */ } }
    return;
  }

  // GET /stream : Server-Sent Events. Replay backlog, then live.
  if (req.method === 'GET' && p === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    // Announce the boot token BEFORE the backlog so the client can reset-or-dedup.
    res.write(`event: activity\ndata: ${JSON.stringify({ kind: 'hello', boot: BOOT })}\n\n`);
    // Backlog first so a late-opening browser still sees history.
    for (const evt of ring) {
      res.write(`event: activity\ndata: ${JSON.stringify(evt)}\n\n`);
    }
    clients.add(res);
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
    req.on('close', () => { clearInterval(beat); clients.delete(res); });
    return;
  }

  if (req.method === 'GET' && p === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, events: ring.length, clients: clients.size, seq, off: isOff() }));
    return;
  }

  // GET /state : is tracking currently off? (HUD reads this to draw the switch)
  if (req.method === 'GET' && p === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ off: isOff() }));
    return;
  }

  // POST /toggle : flip, or set explicitly with body {"off":true|false}. Writes
  // the sentinel file so the next hook/session honours it too.
  if (req.method === 'POST' && p === '/toggle') {
    const body = await readBody(req);
    let want;
    try { const b = body && JSON.parse(body); if (b && typeof b.off === 'boolean') want = b.off; } catch { /* flip */ }
    if (want === undefined) want = !isOff();
    setOff(want);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ off: isOff() }));
    return;
  }

  // Test/util: clear state.
  if (req.method === 'POST' && p === '/reset') {
    ring.length = 0; seq = 0;
    res.writeHead(200).end('{"ok":true}');
    return;
  }

  if (req.method === 'GET') { serveStatic(req, res); return; }

  res.writeHead(404).end('not found');
});

function start() {
  return new Promise((resolve) => {
    // If another viewer already owns the port (e.g. a second Claude session
    // auto-started one), exit quietly instead of crashing.
    server.on('error', (e) => {
      if (e && e.code === 'EADDRINUSE') { console.error(`[activity-tracker] :${PORT} already in use — leaving the running viewer alone`); process.exit(0); }
      throw e;
    });
    server.listen(PORT, HOST, () => {
      const addr = server.address();
      // eslint-disable-next-line no-console
      console.log(`[activity-tracker] viewer on http://${HOST}:${addr.port}  (open it in a browser)`);
      resolve(server);
    });
  });
}

module.exports = { server, start, normalizeHook, handleOtlpMetrics, _state: () => ({ ring, clients, seq }) };

if (require.main === module) start();
