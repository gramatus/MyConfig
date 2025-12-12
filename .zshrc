# If you come from bash you might have to change your $PATH.
# export PATH=$HOME/bin:/usr/local/bin:$PATH

# Skip ALL shell config for non-interactive shells
[[ ! -o interactive ]] && return

# ============================================================================
# Daily Logging Helper
# ============================================================================
# Logs to console only on first trigger each day (per message ID).
_zshrc_log_once() {
    local id="$1"
    local msg="$2"
    local marker_dir="${HOME}/.cache/zshrc_logs"
    local today=$(date +%Y-%m-%d)
    local marker_file="${marker_dir}/${id}-${today}"

    mkdir -p "$marker_dir"
    if [[ ! -f "$marker_file" ]]; then
        echo "[.zshrc] $msg"
        touch "$marker_file"
        find "$marker_dir" -name "${id}-*" ! -name "${id}-${today}" -delete 2>/dev/null
    fi
}

_zshrc_log_once "startup" "Loading zsh config (interactive=$([[ -o interactive ]] && echo yes || echo no), login=$([[ -o login ]] && echo yes || echo no))"

# ============================================================================
# Oh-My-Zsh Configuration
# ============================================================================
# Path to your oh-my-zsh installation.
export ZSH=$HOME/.oh-my-zsh

# Set name of the theme to load --- if set to "random", it will
# load a random theme each time oh-my-zsh is loaded, in which case,
# to know which specific one was loaded, run: echo $RANDOM_THEME
# See https://github.com/ohmyzsh/ohmyzsh/wiki/Themes
ZSH_THEME="devcontainers"

# Set list of themes to pick from when loading at random
# Setting this variable when ZSH_THEME="devcontainers"
# a theme from this variable instead of looking in $ZSH/themes/
# If set to an empty array, this variable will have no effect.
# ZSH_THEME_RANDOM_CANDIDATES=( "robbyrussell" "agnoster" )

# Uncomment the following line to use case-sensitive completion.
# CASE_SENSITIVE="true"

# Uncomment the following line to use hyphen-insensitive completion.
# Case-sensitive completion must be off. _ and - will be interchangeable.
# HYPHEN_INSENSITIVE="true"

# Uncomment one of the following lines to change the auto-update behavior
# zstyle ':omz:update' mode disabled  # disable automatic updates
# zstyle ':omz:update' mode auto      # update automatically without asking
# zstyle ':omz:update' mode reminder  # just remind me to update when it's time

# Uncomment the following line to change how often to auto-update (in days).
# zstyle ':omz:update' frequency 13

# Uncomment the following line if pasting URLs and other text is messed up.
# DISABLE_MAGIC_FUNCTIONS="true"

# Uncomment the following line to disable colors in ls.
# DISABLE_LS_COLORS="true"

# Uncomment the following line to disable auto-setting terminal title.
# DISABLE_AUTO_TITLE="true"

# Uncomment the following line to enable command auto-correction.
# ENABLE_CORRECTION="true"

# Uncomment the following line to display red dots whilst waiting for completion.
# You can also set it to another string to have that shown instead of the default red dots.
# e.g. COMPLETION_WAITING_DOTS="%F{yellow}waiting...%f"
# Caution: this setting can cause issues with multiline prompts in zsh < 5.7.1 (see #5765)
# COMPLETION_WAITING_DOTS="true"

# Uncomment the following line if you want to disable marking untracked files
# under VCS as dirty. This makes repository status check for large repositories
# much, much faster.
# DISABLE_UNTRACKED_FILES_DIRTY="true"

# Uncomment the following line if you want to change the command execution time
# stamp shown in the history command output.
# You can set one of the optional three formats:
# "mm/dd/yyyy"|"dd.mm.yyyy"|"yyyy-mm-dd"
# or set a custom format using the strftime function format specifications,
# see 'man strftime' for details.
# HIST_STAMPS="mm/dd/yyyy"

# Would you like to use another custom folder than $ZSH/custom?
# ZSH_CUSTOM=/path/to/new-custom-folder

# Which plugins would you like to load?
# Standard plugins can be found in $ZSH/plugins/
# Custom plugins may be added to $ZSH_CUSTOM/plugins/
# Example format: plugins=(rails git textmate ruby lighthouse)
# Add wisely, as too many plugins slow down shell startup.
plugins=(
    git
    zsh-autosuggestions
)

_zshrc_log_once "omz" "Loading Oh-My-Zsh (theme=$ZSH_THEME, plugins: ${plugins[*]})"
source $ZSH/oh-my-zsh.sh

# ============================================================================
# User Configuration
# ============================================================================
# export MANPATH="/usr/local/man:$MANPATH"

# You may need to manually set your language environment
# export LANG=en_US.UTF-8

# Preferred editor for local and remote sessions
# if [[ -n $SSH_CONNECTION ]]; then
#   export EDITOR='vim'
# else
#   export EDITOR='mvim'
# fi

# Compilation flags
# export ARCHFLAGS="-arch x86_64"

# Set personal aliases, overriding those provided by oh-my-zsh libs,
# plugins, and themes. Aliases can be placed here, though oh-my-zsh
# users are encouraged to define aliases within the ZSH_CUSTOM folder.
# For a full list of active aliases, run `alias`.
#
# Example aliases
# alias zshconfig="mate ~/.zshrc"
# alias ohmyzsh="mate ~/.oh-my-zsh"
DISABLE_AUTO_UPDATE=true
DISABLE_UPDATE_PROMPT=true

# Enable vi mode
bindkey -v
_zshrc_log_once "vi_mode" "Enabled vi mode"

# Save initial folder as WORKSPACE_FOLDER (useful in Codespaces/VSCode/DevContainers)
export WORKSPACE_FOLDER=$PWD
# Setup paths
export PATH=$PATH:~/scripts
_zshrc_log_once "env" "Set WORKSPACE_FOLDER=$WORKSPACE_FOLDER, added ~/scripts to PATH"

# Setup aliases
alias cdw="cd $WORKSPACE_FOLDER" # Return to workspace folder
alias cdnc="cd /workspaces/.codespaces/.persistedshare/dotfiles/.config/nvim" # Go to nvim config folder
alias cddot="cd /workspaces/.codespaces/.persistedshare/dotfiles" # Go to dotfiles config folder
_zshrc_log_once "my_alias" "My custom aliases: cdw, cdnc, cddot"
_zshrc_log_once "omz_alias" "OMZ git aliases: see ~/.oh-my-zsh/plugins/git/README.md or run 'omz plugin info git'"

# Check that display variable is set (not sure if this is smart and/or right)
# if [ "x$DISPLAY" = "x" ] && [ "x$CODESPACES" != "xtrue" ] # Concatenate something to the variable and see if the result is only that something
# then
#    export DISPLAY=:0
# fi
# ============================================================================
# Clipboard Support (is XCLIP working?)
# ============================================================================
echo "test"|xclip 2> /dev/null && export xclip_working=true || export xclip_working=false
_zshrc_log_once "xclip" "Clipboard support: xclip_working=$xclip_working"

# ============================================================================
# Application-Specific Settings
# ============================================================================
# GnistPortal: Disable .NET error handler middleware for cleaner dev output
export DisableErrorHandlerMiddleware=true
_zshrc_log_once "gnist" "Set DisableErrorHandlerMiddleware=true"

# ============================================================================
# For codespaces, installing extensions in dotfiles doesn't work as code is not "connected properly" yet. This is a hack to handle that.
# ============================================================================
if [[ "$CODESPACES" == "true" ]]; then
    install_vscode_extension() {
        local extension_id="$1"

        # Check if extension directory exists and extension is installed
        if [[ ! -d ~/.vscode-remote/extensions ]] || \
           [[ -z $(find ~/.vscode-remote/extensions -maxdepth 1 -name "${extension_id}-*" 2>/dev/null) ]]; then
            code --install-extension "$extension_id" 2>&1 || \
                echo "Note: $extension_id will be installed when VS Code connects"
        fi
    }

    # Read extension list from install.sh to keep them in sync
    local dotfiles_dir="/workspaces/.codespaces/.persistedshare/dotfiles"
    if [[ -f "$dotfiles_dir/install.sh" ]]; then
        while IFS= read -r extension; do
            [[ -n "$extension" ]] && install_vscode_extension "$extension"
        done < <(grep -oP 'code --install-extension "\K[^"]+' "$dotfiles_dir/install.sh" 2>/dev/null)
    fi
fi

# ============================================================================
# Other stuff
# ============================================================================
# Set nvim as default editor
export EDITOR=nvim
export VISUAL=nvim
export GIT_EDITOR=nvim
_zshrc_log_once "editor" "Set EDITOR=nvim"
