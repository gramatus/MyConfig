# ~/.bash_profile - Runs for login shells (including Codespaces startup)

# ============================================================================
# Helper: Log message once per day
# ============================================================================
# Logs to console only on first trigger each day (per message ID).
# Usage: _log_once "unique-id" "Message to display"
_log_once() {
    local id="$1"
    local msg="$2"
    local marker_dir="${HOME}/.cache/bash_profile_logs"
    local today=$(date +%Y-%m-%d)
    local marker_file="${marker_dir}/${id}-${today}"

    mkdir -p "$marker_dir"
    if [[ ! -f "$marker_file" ]]; then
        echo "[.bash_profile] $msg"
        touch "$marker_file"
        # Clean up old markers (older than today)
        find "$marker_dir" -name "${id}-*" ! -name "${id}-${today}" -delete 2>/dev/null
    fi
}

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
        _log_once "docker-start" "Started Docker service in WSL"
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
    _log_once "gnistportal" "Set DisableErrorHandlerMiddleware=true for GnistPortal"

    # Declare zsh as preferred shell. Programs that spawn subshells or
    # open new terminals may check $SHELL to decide which shell to use.
    export SHELL=/bin/zsh
    # Replace bash with zsh. This is what makes Codespaces run zsh instead.
    # Must be last - 'exec' replaces the shell process, so nothing after runs.
    _log_once "zsh-switch" "Switching from bash to zsh"
    exec /bin/zsh -l
fi
