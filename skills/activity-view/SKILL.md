---
name: activity-view
description: Open the Activity Tracker live viewer (KORTEX) that animates what Claude is doing right now — a flow graph of prompts, tools, and the parallel subagent tree, plus tokens/cost and context usage. Use when the user wants to watch, monitor, or visualize Claude Code activity.
---

# Activity View (KORTEX)

The Activity Tracker plugin streams every tool call, file edit, command, and subagent
event from Claude Code to a local viewer that animates it in real time.

## Start the viewer

Usually you don't need to — the plugin autostarts the viewer on `SessionStart`
(`scripts/ensure-viewer.sh`). If it isn't running, start it manually:

```bash
node "${CLAUDE_PLUGIN_ROOT}/viewer/server.js"
# custom port must match the plugin's `endpoint` userConfig:
node "${CLAUDE_PLUGIN_ROOT}/viewer/server.js" --port=39000
```

Then open:

- **http://127.0.0.1:39000/flow.html** — the **KORTEX flow graph** (primary view).
- **http://127.0.0.1:39000/** — the lane recorder (alternate view). The two are cross-linked.

Events flow through command hooks (`scripts/emit.sh`) to the viewer's `/event`; to use a
different port, set the `endpoint` userConfig (the autostart and toggle derive the port from it).

## What you see (flow graph)

- **PRIMARY core** — the session reactor, ringed by a **context-window gauge** (fills
  cyan → amber → red as the prompt fills the model's window).
- **Thread nodes** — one per prompt; the newest is biggest and reaches farthest out, older
  ones shrink and pull in. Each turn's tools branch off its thread.
- **Tool nodes** — Read/Edit/Bash/… beads; slower steps are bigger, failures turn red.
- **Subagents** — the parallel subagent tree, each a violet branch with its own tools.
- **Left SYSTEM panel** — sessions switcher, alerts, token usage (input/output/cache),
  context %, cost drivers, and an event log. **Right INSPECTOR** — click any node for its
  per-node token/cost breakdown.
- **SAID popup** — the text Claude wrote on the current turn, beside the active thread.

## Tokens & cost — zero config

Cost, tokens, model, and context % are read automatically from the session **transcript**
(no setup). OpenTelemetry is optional — a fallback for cost/tokens when a transcript isn't
available, plus HTTP-level signal the transcript lacks (API errors, 429/529, retries):

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:39000
```

## Turn it off / on

`/activity-tracker off` (or `on`, `status`), or click the **⏻** power switch in the viewer's
top-left. The choice persists across sessions.
