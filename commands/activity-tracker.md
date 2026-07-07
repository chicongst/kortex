---
description: Turn the Activity Tracker on or off (quick switch)
argument-hint: "[on|off|status]"
allowed-tools: Bash(*/scripts/toggle.sh:*)
---
!`"${CLAUDE_PLUGIN_ROOT}/scripts/toggle.sh" $ARGUMENTS`

The command above already flipped the Activity Tracker. Relay its one-line output to
the user verbatim (whether it is now ON or OFF), and nothing else. Do not run any
other tools.
