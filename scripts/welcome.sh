#!/usr/bin/env bash
# One-time SessionStart notice. The first session after the plugin is installed
# (and Claude Code reloaded), this emits `additionalContext` so Claude tells the
# user where to open the viewer. A marker file makes it fire exactly once — every
# later session prints nothing, so there's zero per-session overhead or nagging.
# NOT marked async: SessionStart output (additionalContext) is only honored when
# the hook runs synchronously.
set -euo pipefail

marker="${TRACKER_WELCOME:-${HOME}/.claude/activity-tracker.welcomed}"
[ -f "$marker" ] && exit 0

# Don't greet if tracking is switched off.
flag="${TRACKER_FLAG:-${HOME}/.claude/activity-tracker.off}"
[ -f "$flag" ] && exit 0

# Same port source of truth as the autostart: the `endpoint` plugin option.
endpoint="${CLAUDE_PLUGIN_OPTION_endpoint:-http://127.0.0.1:39000/event}"
port="${endpoint##*:}"; port="${port%%/*}"; port="${port:-39000}"
url="http://127.0.0.1:${port}/flow.html"

# Mark as shown BEFORE printing, so a crash mid-print can't loop the greeting.
mkdir -p "$(dirname "$marker")" 2>/dev/null || true
: > "$marker" 2>/dev/null || true

printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The KORTEX activity viewer (activity-tracker plugin) has just started. In one short, friendly sentence, tell the user they can open %s in a browser to watch this Claude Code session live as a flow graph. Then continue with their request as normal."}}\n' "$url"
exit 0
