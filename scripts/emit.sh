#!/usr/bin/env bash
# Event transport for every hook in hooks.json. Reads the hook JSON payload on
# stdin and fire-and-forgets it to the viewer via curl. Wired as a `command`
# hook (not the built-in `http` type) so this script can gate on the off-switch
# below before any traffic leaves. It must never block Claude: it backgrounds the
# curl and always exits 0.
set -euo pipefail

# Quick off-switch: if the sentinel file exists, tracking is disabled — drop the
# event and exit immediately (no POST, no viewer traffic). Toggle it with the
# /activity-tracker command or the ON/OFF switch in the viewer HUD.
flag="${TRACKER_FLAG:-${HOME}/.claude/activity-tracker.off}"
[ -f "$flag" ] && exit 0

payload="$(cat)"
url="${CLAUDE_PLUGIN_OPTION_endpoint:-http://127.0.0.1:39000/event}"

(
  curl -s -m 3 -X POST \
    -H 'Content-Type: application/json' \
    -d "$payload" \
    "$url" >/dev/null 2>&1 || true
) &

exit 0
