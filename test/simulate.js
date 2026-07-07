#!/usr/bin/env node
'use strict';
/*
 * Replays a realistic Claude Code session into the viewer so you can watch the
 * animation without a live session. Includes a main thread + two parallel
 * subagents, edits (with diffs), bash commands, a failure, and OTel cost.
 *
 * Usage:  node test/simulate.js [--endpoint=http://127.0.0.1:39000] [--fast]
 */
const ENDPOINT = (process.argv.find(a => a.startsWith('--endpoint=')) || '').split('=')[1] || 'http://127.0.0.1:39000';
const FAST = process.argv.includes('--fast');
const SID = 'sim-' + Math.random().toString(36).slice(2, 8);

const wait = (ms) => new Promise(r => setTimeout(r, FAST ? Math.min(ms, 5) : ms));
async function event(body) {
  try { await fetch(ENDPOINT + '/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (e) { console.error('POST /event failed — is the viewer running?', e.message); process.exit(1); }
}
async function metric(name, value, attrs) {
  const attributes = Object.entries(attrs).map(([k, v]) => ({ key: k, value: { [typeof v === 'number' ? 'asDouble' : 'stringValue']: v } }));
  await fetch(ENDPOINT + '/v1/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name, sum: { dataPoints: [{ asDouble: value, attributes }] } }] }] }] }) }).catch(() => {});
}

// main-thread helpers
const pre = (tool, input, agent) => event({ hook_event_name: 'PreToolUse', session_id: SID, tool_name: tool, tool_input: input, ...(agent ? { agent_id: agent.id, agent_type: agent.type } : {}) });
const post = (tool, output, agent, failed) => event({ hook_event_name: failed ? 'PostToolUseFailure' : 'PostToolUse', session_id: SID, tool_name: tool, tool_output: output, ...(agent ? { agent_id: agent.id, agent_type: agent.type } : {}) });
async function call(tool, input, output, ms, agent, failed) { await pre(tool, input, agent); await wait(ms); await post(tool, output, agent, failed); }

(async () => {
  console.log(`Simulating session ${SID} -> ${ENDPOINT}`);
  await event({ hook_event_name: 'SessionStart', session_id: SID, cwd: '/Users/cong/proj/webapp' });
  await event({ hook_event_name: 'UserPromptSubmit', session_id: SID, prompt: 'Add a health endpoint and speed up the build' });
  await wait(300);

  await call('Read', { file_path: 'src/server.ts' }, { message: 'ok' }, 400);
  await call('Grep', { pattern: 'app.listen', path: 'src' }, { message: '1 match' }, 300);
  await call('Bash', { command: 'npm run build' }, { stdout: 'build ok in 8.2s', exitCode: 0 }, 900);

  await call('Edit', {
    file_path: 'src/server.ts',
    edits: [{ old_string: "app.listen(PORT)", new_string: "app.get('/health', (_, r) => r.json({ ok: true }))\napp.listen(PORT)" }],
  }, { succeeded: true, message: 'File edited successfully' }, 600);
  await metric('claude_code.cost.usage', 0.0142, { 'session.id': SID, 'query.source': 'main' });
  await metric('claude_code.token.usage', 5210, { 'session.id': SID, 'query.source': 'main' });

  // spawn two parallel subagents
  const ex = { id: 'agent-explore-1', type: 'Explore' };
  const pl = { id: 'agent-plan-2', type: 'Plan' };
  await event({ hook_event_name: 'SubagentStart', session_id: SID, agent_id: ex.id, agent_type: ex.type });
  await event({ hook_event_name: 'SubagentStart', session_id: SID, agent_id: pl.id, agent_type: pl.type });

  await Promise.all([
    (async () => {
      await call('Glob', { pattern: '**/*.config.*' }, { message: '4 files' }, 500, ex);
      await call('Read', { file_path: 'vite.config.ts' }, { message: 'ok' }, 400, ex);
      await call('Bash', { command: 'npx depcheck' }, { stdout: 'unused: lodash', exitCode: 0 }, 700, ex);
      await metric('claude_code.cost.usage', 0.0031, { 'session.id': SID, 'query.source': 'subagent' });
      await event({ hook_event_name: 'SubagentStop', session_id: SID, agent_id: ex.id, agent_type: ex.type });
    })(),
    (async () => {
      await call('Read', { file_path: 'package.json' }, { message: 'ok' }, 350, pl);
      await call('Bash', { command: 'npm run typecheck' }, { stdout: 'error TS2345', exitCode: 1 }, 800, pl, true);
      await call('Write', { file_path: 'BUILD_PLAN.md', content: '# Build speedup plan\n1. drop lodash\n2. enable swc\n3. cache node_modules' }, { succeeded: true }, 500, pl);
      await metric('claude_code.cost.usage', 0.0027, { 'session.id': SID, 'query.source': 'subagent' });
      await event({ hook_event_name: 'SubagentStop', session_id: SID, agent_id: pl.id, agent_type: pl.type });
    })(),
  ]);

  await call('Bash', { command: 'npm test' }, { stdout: '12 passing', exitCode: 0 }, 600);
  await metric('claude_code.cost.usage', 0.0089, { 'session.id': SID, 'query.source': 'main' });
  await event({ hook_event_name: 'Stop', session_id: SID });
  await event({ hook_event_name: 'SessionEnd', session_id: SID });
  console.log('Simulation complete.');
})();
