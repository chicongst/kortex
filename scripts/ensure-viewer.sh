#!/usr/bin/env bash
# Idempotently make sure the KORTEX viewer is running on its port.
# Wired as a SessionStart *command* hook so installing the plugin is enough —
# no manual `node server.js`. Fire-and-forget: never blocks Claude, always 0.
set -euo pipefail

# Diagnosable, not silent: every decision lands in this log so a failed autostart
# can be understood after the fact (hooks run detached, so stderr goes nowhere).
LOG="${TRACKER_LOG:-${HOME}/.claude/activity-tracker-viewer.log}"
log(){ printf '%s ensure-viewer: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >>"$LOG" 2>/dev/null || true; }

# Single source of truth for the port: the `endpoint` plugin option (a full URL).
endpoint="${CLAUDE_PLUGIN_OPTION_endpoint:-http://127.0.0.1:39000/event}"
port="${endpoint##*:}"; port="${port%%/*}"; port="${port:-39000}"

# Off-switch: if tracking is disabled, don't autostart the viewer this session.
flag="${TRACKER_FLAG:-${HOME}/.claude/activity-tracker.off}"
[ -f "$flag" ] && { log "off-switch present ($flag) — not starting"; exit 0; }

# Already listening? nothing to do.
if command -v lsof >/dev/null 2>&1; then
  if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then log "port $port already listening — ok"; exit 0; fi
elif command -v curl >/dev/null 2>&1; then
  if curl -s -m 1 "http://127.0.0.1:${port}/state" >/dev/null 2>&1; then log "viewer already responding on $port — ok"; exit 0; fi
fi

# Resolve node robustly. Hooks run in a NON-interactive shell, so a node installed
# via nvm/fnm/volta/homebrew is often NOT on PATH here even though `node -v` works
# in the user's terminal. Fall back to the common install locations before giving up.
find_node(){
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  local c
  for c in \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.fnm/node-versions/*/installation/bin/node \
    "$HOME"/.volta/bin/node \
    "$HOME"/.asdf/shims/node \
    "$HOME"/.local/bin/node \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node ; do
    [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

NODE="$(find_node || true)"
if [ -z "${NODE:-}" ]; then
  log "node not found (not on PATH and not in nvm/fnm/volta/asdf/homebrew/usr). Install Node.js, or start the viewer manually: node \"${CLAUDE_PLUGIN_ROOT}/viewer/server.js\""
  exit 0
fi

# Launch detached so it outlives this hook and the Claude session shell.
server="${CLAUDE_PLUGIN_ROOT}/viewer/server.js"
if [ ! -f "$server" ]; then log "server.js not found at $server"; exit 0; fi
log "starting viewer: PORT=$port $NODE $server"
( PORT="$port" nohup "$NODE" "$server" >>"$LOG" 2>&1 & ) >/dev/null 2>&1 || log "failed to spawn viewer"
exit 0
