# Claude Code VS Code extension breaks the extension host in Codespaces

A recurring issue: the Claude Code VS Code extension appears to "break the
extension host" in GitHub Codespaces — UI becomes unresponsive, Claude panel
never settles, things feel like they're constantly disconnecting/reconnecting.

This document captures what's actually happening and how to recover.

## Symptoms

- Claude Code panel/sidebar opens but never finishes loading.
- VS Code UI feels glitchy — focus jumps, panels reload, status bar flickers.
- Other extensions that *had been working* start misbehaving.
- Restarting the window seems to help briefly, then it comes back.
- The CLI in a terminal (`claude`) works fine, only the in-IDE extension is
  broken.

The symptom happens in every codespace you open, regardless of which repo,
because your dotfiles repo (`gramatus/MyConfig`) auto-installs
`anthropic.claude-code` (`install.sh:142`) on every codespace boot.

## TL;DR recovery (when you don't have time to dig)

1. **Find and kill stale extension host processes**:
   ```sh
   ps -eo pid,etime,rss,cmd | grep extensionHost
   ```
   Each line is one extension host. The one matching your *current* window
   reload is the youngest (lowest `etime`). Any older ones are orphans
   keeping the loop alive.
   ```sh
   kill -9 <pid>   # SIGTERM is usually ignored; go straight to -9
   ```
   Leave the youngest one alive. VS Code does NOT auto-restart these — your
   current window keeps working.

2. **If you can't tell which exthost is yours**, use the VS Code command
   palette: "Developer: Restart Extension Host". Less surgical (it restarts
   yours too) but it clears stale state.

3. **Before opening Claude after a fresh codespace boot**, wait ~30-60s for
   dotfiles install / extension install / `npm install` activity to settle.
   Opening Claude *during* that window seems to be what kicks off the loop.

## What's actually happening (mechanism)

Two compounding issues:

### 1. Initial trigger: webview activation under load

When the Claude Code extension's webview first activates, it spawns the
bundled Claude CLI (250 MB binary in the extension), which on startup does
~2 s of work: load 145 bundled CA certs + ~287 system CA certs, NODE_EXTRA_CA_CERTS, MCP configs, skills, plugins, etc.

If the extension host's main event loop is already loaded (codespace doing
dotfiles install, `npm install`, eager extension activations, etc.), the
CLI spawn blocks the event loop long enough that VS Code's WebSocket
heartbeat (~10 s timeout) misses, the client drops the connection, and
auto-reconnects. The extension host stays in a state where it keeps the
cycle going forever — reconnect cadence ~21-22 s.

### 2. Persistence: orphan extension hosts

VS Code keeps old extension host processes alive for **3 hours** after a
client disconnects (`VSCODE_RECONNECTION_GRACE_TIME=10800000ms`). That
means:

- Reloading the window does NOT kill the broken extension host — it just
  starts a *new* one alongside.
- Switching computers (closing one browser, opening the codespace
  elsewhere) leaves the old session's exthost orphaned.
- Each orphan keeps generating the reconnect storm because its webview
  state still thinks it has a live client.

This is why "Reload Window" doesn't fix it. The bad state keeps running in
the background.

## Verify the diagnosis (for an agent picking this up)

Two log files matter, under
`~/.vscode-remote/data/logs/<session-timestamp>/`:

- `remoteagent.log` — top-level. The smoking gun is repeated lines like:
  ```
  [info] [127.0.0.1][<connection-id>][ExtensionHostConnection] The client has reconnected.
  ```
  If these repeat every ~21 s on the **same connection-id**, that exthost
  is in the loop. Multiple connection IDs reconnecting = multiple orphans.
- `exthost<N>/Anthropic.claude-code/Claude VSCode.log` — per-exthost.
  Each exthost has its own. The broken ones will have a
  `Received message from webview: ...init` line that has no follow-up
  activity processing the init, OR they're stuck spawning the CLI.
  Compare with a healthy one — healthy exthosts show the full init flow
  followed by `Spawning Claude with SDK query function ...`.

Also useful:

- `ps -eo pid,ppid,etime,%cpu,rss --no-headers -C node | grep
  extensionHost` — count of exthost processes. Should be 1 in steady
  state.
- `cat ~/.claude/ide/<port>.lock` — IDE bridge metadata, including which
  pid the Claude CLI thinks owns the MCP port.

## What we don't fully know

- Why the trigger is non-deterministic. The same action (opening Claude
  webview after codespace boot) sometimes triggers the loop, sometimes
  doesn't. Best guess: it depends on whatever else is competing for the
  event loop at that exact moment (extension installs, dotfiles
  install, language servers warming up).
- Whether `claudeCode.useTerminal: true` actually avoids it. The setting
  routes new conversations to a terminal pane instead of a webview, which
  should sidestep the CLI-spawn-blocks-event-loop path. Not battle-tested
  yet.
- Whether downgrading the extension helps. Known regressions reported
  upstream:
  - https://github.com/anthropics/claude-code/issues/34678 — "fails since 2.1.73"
  - https://github.com/anthropics/claude-code/issues/59604 — IDE-bridge MCP failures
  - https://github.com/anthropics/claude-code/issues/51108 — Codespaces specifically

## Prevention checklist

- After codespace boot, wait for activity to settle before opening Claude
  (look at the bottom-right status bar — when "Setting up Codespace" is
  gone and notifications have stopped firing, you're probably safe).
- Don't have the same codespace open on two devices simultaneously. If you
  switch machines, explicitly close the old browser tab AND let the
  3-hour grace period elapse, or kill the orphan exthost manually.
- Consider whether `anthropic.claude-code` really needs to be in your
  dotfiles' install.sh auto-install list. The CLI works fine standalone in
  a terminal — you only need the extension if you actively use the
  in-editor UI.
- If the loop is in progress, `kill -9` orphans is faster and more
  reliable than reloading the window.

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
```

## Last verified

2026-05-30, codespace `crispy-robot-746jx9vvprqfxx59`, extension
`anthropic.claude-code-2.1.158`, CLI `2.1.149`, VS Code server build
`8761a5560cfd65fdd19ce7e2bd18dab5c0a4d84e`.
