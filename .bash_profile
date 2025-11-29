# ~/.bash_profile - Runs for login shells (including Codespaces startup)

# ============================================================================
# WSL Docker Auto-Start
# ============================================================================
# In WSL, Docker doesn't start automatically on boot like native Linux.
# This detects WSL and starts the Docker service if it's not running.
# Runs for ALL shells (interactive and non-interactive) so Docker is
# always available for scripts and tools.
if grep -q "microsoft" /proc/version > /dev/null 2>&1; then
    if service docker status 2>&1 | grep -q "is not running"; then
        wsl.exe --distribution "${WSL_DISTRO_NAME}" --user root \
            --exec /usr/sbin/service docker start > /dev/null 2>&1
    fi
fi

# ============================================================================
# Interactive Shell Setup
# ============================================================================
# Only configure these for interactive sessions (terminals you type in).
# Non-interactive shells (spawned by tools like Claude Code, scripts, etc.)
# skip this block to avoid breaking automated command execution.
#
# Reference for Codespaces environment variables:
# https://docs.github.com/en/codespaces/developing-in-codespaces/persisting-environment-variables-and-temporary-files#for-all-codespaces-that-you-create
if [[ $- == *i* ]]; then
    # GnistPortal: Disable .NET error handler middleware for cleaner dev output
    export DisableErrorHandlerMiddleware=true

fi

# ============================================================================
# Switch to Zsh
# ============================================================================
# Replace bash with zsh for interactive sessions.
# This is what makes Codespaces (which default to bash) run zsh instead.
#
# WARNING: Without the interactive guard, this breaks tools that spawn
# non-interactive bash shells (e.g., Claude Code, VS Code tasks, scripts).
if [[ $- == *i* ]]; then
    # Tell programs that zsh is our preferred shell
    export SHELL=/bin/zsh
    # 'exec' replaces bash with zsh - must be last since nothing after runs
    exec /bin/zsh -l
fi
