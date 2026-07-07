#!/usr/bin/env bash
# Idempotently make sure the KORTEX viewer is running on its port.
# Wired as a SessionStart *command* hook so installing the plugin is enough —
# no manual `node server.js`. Fire-and-forget: never blocks Claude, always 0.
set -euo pipefail

# Single source of truth for the port: the `endpoint` plugin option (a full URL).
endpoint="${CLAUDE_PLUGIN_OPTION_endpoint:-http://127.0.0.1:39000/event}"
port="${endpoint##*:}"; port="${port%%/*}"; port="${port:-39000}"

# Off-switch: if tracking is disabled, don't autostart the viewer this session.
flag="${TRACKER_FLAG:-${HOME}/.claude/activity-tracker.off}"
[ -f "$flag" ] && exit 0

# Already listening? nothing to do.
if command -v lsof >/dev/null 2>&1; then
  if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then exit 0; fi
elif command -v curl >/dev/null 2>&1; then
  if curl -s -m 1 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then exit 0; fi
fi

# Launch detached so it outlives this hook and the Claude session shell.
if command -v node >/dev/null 2>&1; then
  ( PORT="$port" nohup node "${CLAUDE_PLUGIN_ROOT}/viewer/server.js" >/dev/null 2>&1 & ) >/dev/null 2>&1 || true
fi
exit 0
