# Activity Tracker — KORTEX

**Watch what Claude Code is doing, live.** An installable Claude Code plugin that streams
every prompt, tool call, edit, command, and subagent to a local viewer — **KORTEX** — that
animates your session as a living flow graph. Zero dependencies, zero manual setup, local-only.

![KORTEX flow view](docs/kortex.png)

### What you get

- **Flow graph** — each prompt spawns a **thread** that branches into its tools and the
  **parallel subagent tree**; the newest prompt is biggest, older ones shrink and pull in.
- **Context-window gauge** — a ring around the core fills cyan → amber → red as the prompt
  fills the model's window, so you *see* context bloat before it bites.
- **Zero-config cost & tokens** — input/output/cache split, per-node cost, and cost drivers,
  read straight from the session transcript. No env vars, no OTel required.
- **Sessions switcher, event log, and an inspector** — click any node for its token/cost
  breakdown; switch between concurrent Claude sessions.
- **On/off switch** — `/activity-tracker off` or the HUD power button; persists across sessions.
- **Autostarts** on `SessionStart` — installing the plugin is enough.

Built on three data sources, in priority order:

| Source | Role |
|---|---|
| **Hooks** (live, stable) | the event backbone — every tool call, subagent start/stop, session lifecycle |
| **Transcript JSONL** (zero-config) | tokens, cost, model, context % — tailed from the `transcript_path` in each hook payload; no setup |
| **OpenTelemetry** (optional) | fallback cost/tokens when a transcript isn't available, plus HTTP-level signal the transcript lacks: API errors, 429/529, retries |

## How it works

```
Claude Code ──command hook──▶ scripts/emit.sh ──HTTP POST──▶ viewer/server.js ──SSE──▶ browser
             (per event)                          (/event → ring buffer)         (flow.html · index.html)
```

- The plugin registers **command hooks** (`hooks/hooks.json`) that run `scripts/emit.sh`,
  which POSTs each event to the viewer. The command transport lets the script honor the
  on/off switch and the configurable endpoint before any traffic leaves.
- `viewer/server.js` is **pure Node.js, zero dependencies**: `POST /event` → in-memory
  ring buffer → **Server-Sent Events** broadcast. It also tails the session transcript
  for tokens/cost/model. No `npm install`, no build step.
- Two self-contained UIs (vanilla JS): **`flow.html` (KORTEX)** — the default, an animated
  flow-graph of the live session with a context gauge and per-node cost/token inspector; and
  **`index.html`** — a per-agent lane recorder with animated diffs and a detail drawer.

## Install

**Local dev (no marketplace):**

```bash
claude --plugin-dir /path/to/kortex
```

**Via this marketplace repo:**

```
/plugin marketplace add chicongst/kortex
/plugin install activity-tracker
```

Events flow through the **command transport** (`scripts/emit.sh`), which POSTs to the
`userConfig.endpoint` (default `http://127.0.0.1:39000/event`) via
`$CLAUDE_PLUGIN_OPTION_endpoint`. To use a different port, set the `endpoint` option — the
viewer autostart (`scripts/ensure-viewer.sh`) and the toggle both derive the port from it,
so there's a single knob.

## Run the viewer

```bash
node viewer/server.js            # listens on 127.0.0.1:39000
# or
node viewer/server.js --port=39000
```

Open **http://127.0.0.1:39000/flow.html** for the KORTEX flow graph (the main view), or
**http://127.0.0.1:39000/** for the lane recorder. The two are cross-linked. In Claude
Code, run the skill `/activity-tracker:activity-view` for the same instructions.

## Turning it on / off

Tracking has a quick switch — no uninstall needed:

- **Command:** `/activity-tracker off` (or `on`, `status`). Toggles instantly and
  the choice sticks across sessions.
- **HUD:** click the **⏻** power button (top-left of the viewer); its label toggles LIVE ↔ OFF.

Both write a single sentinel file (`~/.claude/activity-tracker.off`). While it's
present, the hooks send nothing and the viewer won't autostart on the next
session — zero overhead until you flip it back on.

## Tokens & cost (optional OTel)

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:39000
```

The viewer accepts OTLP/HTTP JSON on `/v1/metrics` (best-effort) and overlays cost/tokens.

## Develop & test

```bash
# unit + integration tests (pure node --test, no deps)
node --test test/*.test.js

# watch the animation without a live session:
node viewer/server.js &        # terminal 1
node test/simulate.js          # terminal 2  (open the browser first)

# validate the plugin manifest
claude plugin validate activity-tracker --strict
```

## Design notes / gotchas

- **Never blocks Claude.** `/event` normalizes → buffers → 200s immediately; a bad payload
  still returns 200 (a tracker must never fail a hook). The command hooks run `emit.sh` with
  `async: true`, so they never block either.
- **Main vs subagent** is detected by the *presence* of `agent_id` (absent ⇒ main), never
  by `=== null`.
- **PostToolUse output field** is read defensively as `tool_output` ?? `tool_response` ??
  `tool_result` — the exact name is not pinned in the public docs.
- **Match-all matcher** uses `""` (also accepts `"*"`).
- Local only: the server binds `127.0.0.1`. Payloads contain code, paths, and commands.

## Layout

```
kortex/                          # repo root = the plugin
├── .claude-plugin/
│   ├── plugin.json              # plugin manifest (+ userConfig.endpoint)
│   └── marketplace.json         # marketplace entry (source: "./")
├── hooks/hooks.json             # command hooks → emit.sh → viewer
├── commands/activity-tracker.md # /activity-tracker on|off|status
├── scripts/
│   ├── emit.sh                  # event transport (POST + off-switch gate)
│   ├── ensure-viewer.sh         # autostart the viewer on SessionStart
│   └── toggle.sh                # flip the on/off sentinel
├── skills/activity-view/SKILL.md
├── viewer/
│   ├── server.js                # pure-Node http + SSE + ring buffer + transcript + OTLP
│   └── public/
│       ├── flow.html            # KORTEX flow graph (primary view)
│       └── index.html           # lane recorder (alternate view)
├── bin/activity-tracker-viewer  # launcher
├── test/{server.test.js,simulate.js}
└── README.md
```
