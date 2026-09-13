#!/usr/bin/env bash
#
# User-level PreToolUse block on question dialogs — personal preference,
# applies to every project on every machine these dotfiles install to.
#
# Self-contained on purpose: user-level hooks run in any repo, so this
# must NOT depend on a project's hook library or $CLAUDE_PROJECT_DIR.
#
# It must ALSO not depend on the settings.json matcher, which it used to.
# Copilot in VS Code ignores matchers outright — measured, a "Bash" matcher
# fired on read_file and apply_patch — so with chat.useClaudeHooks enabled
# this hook's unconditional deny applied to EVERY tool call and left the
# agent unable to do anything at all, before it could run a single command.
# A matcher is an optimisation; it is never a guarantee. The body therefore
# checks tool_name itself and stands down when the call is something else.
#
# The tool has a different NAME per harness, not merely a different key
# spelling: Claude calls it AskUserQuestion, Copilot vscode_askQuestions
# (measured 2026-09-05 in GitHub Copilot Chat Hooks.log). Both key
# spellings are matched as well, the payload shape being undocumented.
# Substring matching on raw JSON keeps this dependency-free — no jq, no node.
#
# Uses the JSON permissionDecision form (exit 0): permissionDecisionReason
# is the channel Claude Code feeds back to the model on a deny, so that's
# where the "ask in prose instead" steering lives. Do not also exit 2 —
# the two contracts are mutually exclusive and exit 2 makes the JSON moot.
#
# Because PreToolUse hooks run before the permission-mode check, this
# holds even under bypassPermissions / --dangerously-skip-permissions.
payload=$(cat)

case "$payload" in
  *'"tool_name":"AskUserQuestion"'* | *'"tool_name": "AskUserQuestion"'* | \
  *'"toolName":"AskUserQuestion"'*  | *'"toolName": "AskUserQuestion"'* | \
  *'"tool_name":"vscode_askQuestions"'* | *'"tool_name": "vscode_askQuestions"'* | \
  *'"toolName":"vscode_askQuestions"'*  | *'"toolName": "vscode_askQuestions"'*) ;;
  *)
    # Not our tool, or a payload shape we do not recognise. Stand down
    # rather than guess: a false deny here disables the agent entirely,
    # while a missed deny only means one dialog this hook meant to stop.
    exit 0
    ;;
esac

cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Question dialogs are disabled on this machine (personal preference) — ask in prose instead, and prefer doing that up front rather than reaching for the tool. If nobody can answer, because you are a headless or scheduled run, do not stop: say which option you are assuming and carry on, since a question handed back as a result is one nobody reads. Otherwise: the text you already wrote above this tool call is visible to the user — do NOT repeat your analysis, diagnosis, or context. Just take the question and options from this blocked call and render them as a short numbered list (one line each), then stop and wait for the answer. No preamble, no restating what the user has already seen."
  }
}
JSON
exit 0
