#!/usr/bin/env bash
#
# User-level ConfigChange(skills) pause — hold Claude Code's skill reload
# while a rebase is rewriting the files it watches.
#
# WHY. Claude Code watches .claude/{skills,commands,agents} for *.md and
# reloads every skill on change (chokidar, polling at 2s active / 30s idle,
# awaitWriteFinish 1000ms, reload debounce 300ms — none of it configurable).
# Rebasing a repo that HOLDS those files therefore makes the agent tooling
# rescan itself once per rewriting commit, in every session watching the
# checkout at once. Measured on 2026-09-04: three full reloads inside two
# seconds across three concurrent `claude` processes during one rebase.
#
# This is a personal hook because it is a personal problem — the rest of the
# team does not rebase, so it does not belong in a shared harness.
#
# THE MECHANISM. The reload path consults a ConfigChange hook BEFORE it
# rescans, and skips the reload when the hook blocks. Blocking is exit 2
# (or {"decision":"block"} on stdout; exit 2 is simpler). A hook that fails
# to run is not a block, so every failure here means the reload proceeds.
#
# A PAUSE IS A DROP, NOT A DEFER. The blocked batch is discarded and the
# watcher's fingerprint is left unchanged, so the skills stay stale until
# something reloads them. Two routes, and only one of them works while the
# rebase is still going:
#
#   - A later *.md change under .claude/ re-runs this hook, which re-finds
#     rebase-merge and blocks AGAIN. So it only recovers once the rebase has
#     finished or been aborted — and `git rebase -i` holds rebase-merge for
#     as long as it sits stopped at a conflict or an `edit`.
#   - The watcher's own idle->active check recovers regardless of rebase
#     state, because its wake batch skips the ConfigChange hook entirely. It
#     needs a session idle 60s and then used again.
#
# So editing a skill mid-rebase in a session you are actively using keeps the
# pre-EDIT copy, not just the pre-rebase one, until the rebase ends. That is
# the price, and it is the cheap direction.
#
# Only a positively identified rebase pauses, or the manual override. The
# rest is open, per line 20: an unrecognised event or source, and a git dir
# that cannot be resolved, all exit 0 and let the reload proceed.
#
# ONE case is not open, and it is the non-obvious one worth knowing when you
# are wondering what paused a reload: a payload carrying no usable file_path
# falls back to $CLAUDE_PROJECT_DIR (see the candidates near the bottom), so
# a rebase in the session's own project pauses even when nothing told this
# hook which file changed.
#
# NOT the settings.json matcher's job. Matchers are an optimisation and
# never a guarantee — Copilot in VS Code ignores them outright — so the
# body re-checks the event and source itself. Substring matching on the raw
# JSON keeps this dependency-free: no jq, no node. Spawn cost is the whole
# reason this is bash and not the repo's TypeScript hook bundle, which would
# have to resolve (and during a rebase, REBUILD) its own build cache first.
payload=$(cat)

case "$payload" in
  *'"hook_event_name":"ConfigChange"'* | *'"hook_event_name": "ConfigChange"'*) ;;
  *) exit 0 ;;
esac

# ConfigChange fires for settings files too. Only the skill/command/agent
# watcher is worth pausing; a settings reload is one event, not a storm.
case "$payload" in
  *'"source":"skills"'* | *'"source": "skills"'*) ;;
  *) exit 0 ;;
esac

# Manual override, for the churn a rebase marker cannot see — a big branch
# switch, a bulk checkout, a script rewriting commands in a loop.
if [ -e "$HOME/.claude/pause-skill-reload" ]; then
  echo "Skill reload paused: $HOME/.claude/pause-skill-reload exists." >&2
  exit 2
fi

# The changed file, straight out of the raw payload. Both spacings, because
# the sender's formatting is not a contract. A path containing an escaped
# quote truncates here at the backslash, leaving an ANCESTOR of the real
# path rather than nothing — so the walk can still find an outer repo and
# pause on its rebase. A spurious pause, not a spurious reload, which is the
# cheap direction.
file_path=
case "$payload" in
  *'"file_path":"'*)
    rest=${payload#*\"file_path\":\"}
    file_path=${rest%%\"*}
    ;;
  *'"file_path": "'*)
    rest=${payload#*\"file_path\": \"}
    file_path=${rest%%\"*}
    ;;
esac

# Nearest enclosing git dir, walking up. Sets $git_dir. Handles `.git` as a
# FILE (worktrees, submodules) as well as a directory, so a rebase run from
# a linked worktree is still seen. Pure bash: no `git` spawn, and none of
# git's config reading on a machine already under load.
git_dir=
resolve_git_dir() {
  local dir=$1 line
  git_dir=
  # ABSOLUTE ONLY, and this is load-bearing rather than tidiness: `dir=${dir%/*}`
  # below yields $dir UNCHANGED once $dir has no `/` left, so a relative path
  # never reaches the loop's `!= "/"` exit and spins at ~100% CPU until the hook
  # times out — 600s for a command hook. A hang is not one of the failures line 20
  # says the reload proceeds past. `claude --add-dir <relative>` produces exactly
  # such a path: the CLI stores --add-dir verbatim and the watcher joins rather
  # than resolves it, unlike the projectSettings path beside it.
  case $dir in
    /*) ;;
    *) return 1 ;;
  esac
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ -d "$dir/.git" ]; then
      git_dir=$dir/.git
      return 0
    fi
    if [ -f "$dir/.git" ]; then
      read -r line <"$dir/.git" || return 1
      case "$line" in
        gitdir:*)
          line=${line#gitdir:}
          line=${line# }
          ;;
        *) return 1 ;;
      esac
      case "$line" in
        /*) git_dir=$line ;;
        *) git_dir=$dir/$line ;;
      esac
      return 0
    fi
    dir=${dir%/*}
  done
  return 1
}

# `rebase-merge` is the merge backend and every interactive rebase;
# `rebase-apply` is the am backend and `git am` itself. Merges and
# cherry-picks are deliberately NOT here — they rewrite a handful of files,
# not a branch's worth. Add MERGE_HEAD / CHERRY_PICK_HEAD as -e tests if
# that stops being true.
rebasing() {
  resolve_git_dir "$1" || return 1
  [ -d "$git_dir/rebase-merge" ] || [ -d "$git_dir/rebase-apply" ]
}

# TWO candidates and a fallback, because one is not enough in a nested checkout.
#
# The obvious answer — $CLAUDE_PROJECT_DIR/.git — is right only for a
# session whose project root IS the repo being rebased. It is wrong for the
# common layout here: a consuming repo carries a nested harness clone and
# symlinks .claude/commands and .claude/agents into it, so a session rooted
# at the CONSUMER watches files that live in, and are rewritten by, the
# harness — whose .git the consumer's project dir never reaches.
#
# So: the reported path (right when the watched dir is real) and its symlink
# target (right when it is linked into another checkout — chokidar reports
# the path it was given, not the resolved one).
resolved=
if [ -n "$file_path" ]; then
  resolved=$(readlink -f "$file_path" 2>/dev/null)
fi

watched_dir=${file_path%/*}
link_dir=${resolved%/*}

# `${file_path%/*}` yields its input UNCHANGED when there is no `/`, so a
# relative or bare path arrives here non-empty and is then rejected by
# resolve_git_dir's absolute-only guard — suppressing the fallback below
# without ever having been usable. Blank it, so "no usable path" is what the
# gate actually tests. ($link_dir needs no such guard: readlink -f returns an
# absolute path or nothing.)
case $watched_dir in
  /*) ;;
  *) watched_dir= ;;
esac

# The project dir is a FALLBACK for a payload that carried no usable
# file_path — genuinely possible, since file_path is optional in the
# ConfigChange schema — and NOT a third trigger. Checking it beside a path
# that resolved fine would pause on a rebase in the session's own project
# while the edit that fired the event lives in another checkout entirely,
# which drops a reload nothing was rewriting.
candidates=("$watched_dir" "$link_dir")
if [ -z "$watched_dir" ] && [ -z "$link_dir" ]; then
  candidates=("${CLAUDE_PROJECT_DIR:-}")
fi

for candidate in "${candidates[@]}"; do
  [ -n "$candidate" ] || continue
  if rebasing "$candidate"; then
    echo "Skill reload paused: rebase in progress in $git_dir." >&2
    exit 2
  fi
done

exit 0
