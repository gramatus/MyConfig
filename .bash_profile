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
# Only run for interactive sessions (terminals you type in).
# WARNING: Without this guard, non-interactive shells spawned by tools like
# Claude Code, VS Code tasks, or scripts will break.
if [[ $- == *i* ]]; then
    # GnistPortal: Disable .NET error handler middleware for cleaner dev output
    # Reference: https://docs.github.com/en/codespaces/developing-in-codespaces/persisting-environment-variables-and-temporary-files#for-all-codespaces-that-you-create
    export DisableErrorHandlerMiddleware=true

    # Declare zsh as preferred shell. Programs that spawn subshells or
    # open new terminals may check $SHELL to decide which shell to use.
    export SHELL=/bin/zsh
    # Replace bash with zsh. This is what makes Codespaces run zsh instead.
    # Must be last - 'exec' replaces the shell process, so nothing after runs.
    exec /bin/zsh -l
fi
