#!/usr/bin/env bash
#
# User-level PreToolUse(AskUserQuestion) block — personal preference,
# applies to every project on every machine these dotfiles install to.
#
# Self-contained on purpose: user-level hooks run in any repo, so this
# must NOT depend on a project's hook library or $CLAUDE_PROJECT_DIR.
# The settings.json matcher already scopes it to AskUserQuestion, so the
# body emits the deny unconditionally without inspecting stdin.
#
# Uses the JSON permissionDecision form (exit 0): permissionDecisionReason
# is the channel Claude Code feeds back to the model on a deny, so that's
# where the "ask in prose instead" steering lives. Do not also exit 2 —
# the two contracts are mutually exclusive and exit 2 makes the JSON moot.
#
# Because PreToolUse hooks run before the permission-mode check, this
# holds even under bypassPermissions / --dangerously-skip-permissions.
cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "AskUserQuestion is disabled on this machine (personal preference). If you need to clarify something, ask in plain prose in your normal response instead of using the multiple-choice tool."
  }
}
JSON
exit 0
