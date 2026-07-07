#!/usr/bin/env bash
# Quick on/off switch for the Activity Tracker.
#   toggle.sh on       -> enable tracking (and bring the viewer up)
#   toggle.sh off      -> disable tracking (hooks stop sending; no autostart)
#   toggle.sh status   -> print current state
#   toggle.sh          -> flip whatever it is now
# The state is a single sentinel file that emit.sh / ensure-viewer.sh both honour,
# so the choice sticks across every session until you flip it back.
set -euo pipefail

flag="${TRACKER_FLAG:-${HOME}/.claude/activity-tracker.off}"
endpoint="${CLAUDE_PLUGIN_OPTION_endpoint:-http://127.0.0.1:39000/event}"
port="${endpoint##*:}"; port="${port%%/*}"; port="${port:-39000}"
arg="${1:-toggle}"

enable() { rm -f "$flag"; }
disable() { mkdir -p "$(dirname "$flag")"; printf 'off\n' > "$flag"; }

changed=1
case "$arg" in
  on|enable|start|resume)   enable;  state="on" ;;
  off|disable|stop|pause)   disable; state="off" ;;
  toggle|"")                if [ -f "$flag" ]; then enable; state="on"; else disable; state="off"; fi ;;
  status|state)             [ -f "$flag" ] && state="off" || state="on"; changed=0 ;;
  *) echo "activity-tracker: usage: [on|off|status]"; exit 0 ;;
esac

# Read-only status: just report where things stand, touch nothing.
if [ "$changed" = 0 ]; then
  if [ "$state" = "on" ]; then echo "activity-tracker: ON  — tracking live at http://127.0.0.1:${port}/flow.html";
  else echo "activity-tracker: OFF — hooks are not sending; viewer won't autostart next session"; fi
  exit 0
fi

# When turning on, make sure the viewer is actually running so there's something
# to watch. Best-effort; never fail the command.
if [ "$state" = "on" ]; then
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # tell the running viewer (if any) to clear its off-flag view, then autostart
  if command -v curl >/dev/null 2>&1; then
    curl -s -m 1 -X POST -H 'Content-Type: application/json' -d '{"off":false}' \
      "http://127.0.0.1:${port}/toggle" >/dev/null 2>&1 || true
  fi
  [ -x "${here}/ensure-viewer.sh" ] && "${here}/ensure-viewer.sh" >/dev/null 2>&1 || true
  echo "activity-tracker: ON  — tracking live at http://127.0.0.1:${port}/flow.html"
else
  # notify a running viewer so the HUD flips to OFF immediately
  if command -v curl >/dev/null 2>&1; then
    curl -s -m 1 -X POST -H 'Content-Type: application/json' -d '{"off":true}' \
      "http://127.0.0.1:${port}/toggle" >/dev/null 2>&1 || true
  fi
  echo "activity-tracker: OFF — hooks will stop sending; viewer won't autostart next session"
fi
