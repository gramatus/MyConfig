# Claude Code VS Code extension breaks the extension host in Codespaces

A recurring issue: the Claude Code VS Code extension appears to "break the
extension host" in GitHub Codespaces — UI becomes unresponsive, Claude panel
never settles, things feel like they're constantly disconnecting/reconnecting.

This document captures the root cause (identified 2026-05-30), how to recover,
and how to prevent recurrence.

## Root cause (identified 2026-05-30)

**The Claude Code extension spawns `zsh -lic 'printenv PATH'` on every
webview activation to detect the user's PATH.** This runs `.zshrc` as a
login-interactive shell. The user's `.zshrc` has a Codespaces-specific block
(see lines ~175-194) that retries `code --install-extension` for any
extension missing from `~/.vscode-remote/extensions/` — and at least one
extension (notably `github.copilot-chat`) appears to fail to install or fails
to register, so the retry fires every time.

Each `code --install-extension` recursively calls into VS Code's server-main,
which needs to talk to the extension host that is currently *waiting for
this very shell command to finish*. The chain runs synchronously for 6+
seconds. During that time the extension host can't service its WebSocket
heartbeat, the client disconnects, reconnects, and the cycle locks in at
~21-22 s.

### Why "Reload Window" doesn't fix it permanently

Each reload starts a new extension host alongside the broken orphan (VS Code
keeps orphans alive for 3 hours, `VSCODE_RECONNECTION_GRACE_TIME=10800000ms`).
The new exthost is healthy until you open Claude in it, then re-hits the
same `.zshrc` spawn → same loop. Cleanup (kill orphans, remove lockfiles,
pre-warm binaries) does nothing useful, because the trigger is the `.zshrc`
spawn itself.

## Permanent fix

Guard `.zshrc` so it returns early when invoked via `zsh -c <string>` (or
`-ic`/`-lic`). Zsh sets `$ZSH_EXECUTION_STRING` automatically in that case.

```bash
# Top of .zshrc, replacing the existing interactive-only guard:
[[ ! -o interactive || -n "$ZSH_EXECUTION_STRING" ]] && return
```

The naive `[[ ! -o interactive ]] && return` check does NOT catch the Claude
extension's `zsh -lic ...` invocation, because `-i` makes the shell
explicitly interactive.

Optional follow-up: investigate why `code --install-extension
github.copilot-chat` keeps failing silently. The `2>&1 || echo "..."` in the
.zshrc install loop swallows the error. Even with the guard in place, normal
interactive terminals will still retry the install on every shell open until
the underlying install issue is resolved.

## Symptoms

- Claude Code panel/sidebar opens but never finishes loading.
- VS Code UI feels glitchy — focus jumps, panels reload, status bar flickers.
- Other extensions that *had been working* start misbehaving (the exthost is
  starved, not just Claude).
- Restarting the window seems to help briefly, then it comes back the moment
  you reopen the Claude panel.
- The CLI in a terminal (`claude`) works fine — only the in-IDE webview is
  broken. (The CLI's `claude` shell uses `printenv` directly, not via the
  extension.)

## TL;DR recovery (if you don't yet have the .zshrc fix)

1. **Apply the permanent fix above.** Without it, nothing else holds.
2. **Reload the window** so a fresh extension host picks up the new
   `.zshrc` behavior.
3. **Optionally kill the orphan extension host** (the one matching the
   broken session) to free memory:
   ```sh
   ps -eo pid,etime,rss,cmd --no-headers -C node | grep extensionHost
   kill -9 <orphan-pid>   # SIGTERM is usually ignored; go straight to -9
   ```
   Leave the youngest exthost alive. VS Code does NOT auto-restart these —
   your current window keeps working.

## How to verify the diagnosis on a new codespace

If you suspect the same loop:

1. Find the current extension host PID:
   ```sh
   pgrep -af 'type=extensionHost'
   ```
2. Open the Claude webview. Immediately after, run:
   ```sh
   pgrep -af 'zsh -lic'
   ```
   If you see a `zsh -lic 'printf ...; command printenv PATH; printf ...'`
   process owned by the exthost, the extension is doing the shell-env probe.
3. Time the same command standalone:
   ```sh
   time zsh -lic "printf X; command printenv PATH; printf X"
   ```
   If this takes >2 s (cold) or >1 s (warm), the `.zshrc` is the bottleneck.
4. Check the reconnect log:
   ```sh
   ls -t ~/.vscode-remote/data/logs/ | head -1 | xargs -I {} \
     grep "client has reconnected" ~/.vscode-remote/data/logs/{}/remoteagent.log | tail
   ```
   Same connection-id repeating every ~21 s on the heels of the webview
   open = confirmed loop.
5. Check the Claude extension log:
   ```sh
   ls -t ~/.vscode-remote/data/logs/*/exthost*/Anthropic.claude-code/Claude\ VSCode.log
   ```
   A broken exthost will show `Received message from webview: ...init` with
   no follow-up `Spawning Claude with SDK query function ...` line.

## Hypotheses we eliminated (2026-05-30)

For future-you debugging a related issue: these all looked plausible and
turned out to be wrong:

- **Cold CLI binary load.** The bundled CLI's `--version` is 108 ms even
  cold; pre-warming the 240 MB binary into page cache (24 ms `cat
  >/dev/null`) doesn't help.
- **Orphan extension hosts.** Killing all orphans before opening the
  webview did not prevent the loop on the new exthost.
- **Stale `~/.claude/ide/*.lock` files.** Removing them did not help.
- **The pile of `node -e '...targetPort = 43135...'` forwarders.** Symptom
  of the reconnect storm, not cause. They self-exit when the exthost they
  belonged to dies.
- **Cold-codespace activity competing for the event loop.** A 21-min idle
  wait did not prevent the loop on first open.
- **Auth state.** Reproduced both with and without "OAuth tokens found in
  secure storage".
- **Outbound network call (api.anthropic.com etc).** `ss -tnap` showed no
  external connections from the exthost during the hang.

The smoking gun was an strace of the new exthost across the webview open
(`strace -p <pid> -f -tt -e trace=network,desc,process,signal`), which
showed the `zsh -lic` clone+execve 15 ms after the init log line, then a
6-second avalanche of subprocesses (nvm bootstrap, omz cache rebuild, `git
config`, `code --install-extension github.copilot-chat`, etc).

## Upstream issues that touch this area

- https://github.com/anthropics/claude-code/issues/34678 — "fails since 2.1.73"
- https://github.com/anthropics/claude-code/issues/59604 — IDE-bridge MCP failures
- https://github.com/anthropics/claude-code/issues/51108 — Codespaces specifically

The root cause we found is local to *this* dotfiles' `.zshrc`, but the
Claude extension's choice to use a login-interactive shell for env
detection is the upstream design that amplifies any slow `.zshrc`. Worth
filing if not already covered.

## Useful one-liners

```sh
# List all extension hosts, oldest first
ps -eo pid,etime,rss,cmd --no-headers -C node | grep extensionHost | sort -k2 -r

# Tail the live agent log (find the latest timestamped dir)
ls -t ~/.vscode-remote/data/logs/ | head -1 | xargs -I {} tail -F ~/.vscode-remote/data/logs/{}/remoteagent.log

# Count reconnect events in the last hour
grep "client has reconnected" ~/.vscode-remote/data/logs/*/remoteagent.log | wc -l

# Snapshot the latest Claude extension log per exthost
for d in ~/.vscode-remote/data/logs/*/exthost*/Anthropic.claude-code; do
  echo "=== $d ==="; tail -5 "$d/Claude VSCode.log"
done

# Watch for zsh -lic spawns owned by an extension host
pgrep -af 'zsh -lic'
```

## Last verified

- 2026-05-30, codespace `crispy-robot-746jx9vvprqfxx59`, extension
  `anthropic.claude-code-2.1.158`, CLI `2.1.149`, VS Code server build
  `8761a5560cfd65fdd19ce7e2bd18dab5c0a4d84e`. Root cause identified via
  strace; fix applied to dotfiles `.zshrc`.
