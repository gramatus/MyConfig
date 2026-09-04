# Skip dotfiles for specific repos
if [ "$GITHUB_REPOSITORY" = "gramatus/claude-reproductions" ]; then
    echo "Skipping dotfiles installation for this repository"
    exit 0
fi

# Disable colors for cleaner log output
export NO_COLOR=1
export FORCE_COLOR=0
export DEBIAN_FRONTEND=noninteractive

# Refresh apt lists up front: the base image ships with them pruned, so the
# first apt-get install (zsh, fd-find, ...) can otherwise fail with "Unable to
# locate package" depending on container state. One update here covers every
# foreground apt install below.
echo "############### Refreshing apt package lists ###############"
sudo apt-get update -qq

echo "############### Installing zsh and oh-my-zsh if not present ###############"
sudo apt-get install -y -qq zsh 2>&1 | grep -Ev "^(debconf:|dpkg-preconfigure:|Selecting|Preparing|Unpacking|Setting|Processing|\(Reading database)" || true
if [ ! -d "$HOME/.oh-my-zsh" ]; then
    sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
else
    echo "oh-my-zsh already installed, skipping"
fi
sudo chsh -s /bin/zsh

echo "############### Symlinking files and folders to HOME ###############"
# -srfn so reruns overwrite cleanly: -f replaces an existing file/link, and -n
# (no-dereference) replaces a symlink-to-directory *in place* rather than
# creating the new link inside it (which on a second run would nest, e.g.
# ~/scripts/scripts or ~/.config/nvim/nvim.kickstart). -f also subsumes the
# old `rm ~/.zshrc` for the real .zshrc oh-my-zsh writes on first install.
ln -srfn scripts ~/scripts
if [ ! -d "$HOME/.config" ]; then
    mkdir "$HOME/.config"
fi
ln -srfn .config/nvim.kickstart ~/.config/nvim # Need to symlink every folder in .config
ln -srfn docs/KEYMAPS.md ~/nvim-keymaps.md
ln -srfn docs/motions.md ~/nvim-motions.md
ln -srfn .zshrc ~/.zshrc
ln -srfn .tmux.conf ~/.tmux.conf
ln -srfn .bash_profile ~/.bash_profile

echo "############### Seeding personal branchlist.md (if missing) ###############"
# branchlist.md is personal scratch (gitignored) consumed by
# scripts/generate-branchcommands.sh. Seed a basic version for the codespace's
# checked-out repo so it exists before first use. The script self-seeds in any
# repo, so we just invoke it here — it writes the template and exits when the
# file is absent, and is a no-op for us otherwise. ~/scripts was linked above.
if [ -n "${GITHUB_REPOSITORY:-}" ]; then
    SEED_REPO="/workspaces/$(basename "$GITHUB_REPOSITORY")"
    SEED_FILE="$SEED_REPO/.agent-context/active-work-context/branchlist.md"
    if [ -d "$SEED_REPO/.git" ] && [ ! -f "$SEED_FILE" ]; then
        ( cd "$SEED_REPO" && bash ~/scripts/generate-branchcommands.sh ) || true
    fi
fi

# Codespaces only: $HOME is reset on every container *rebuild* (only
# /workspaces survives a rebuild — stop/start keeps everything), so
# ~/.claude (sessions, memory, todos, login) and ~/.claude.json vanish.
# Locally (e.g. WSL) $HOME already persists, so this is skipped there.
if [ "$CODESPACES" = "true" ]; then
    echo "############### Persisting Claude Code state across rebuilds ###############"
    # Park ~/.claude + ~/.claude.json under /workspaces and symlink back into
    # $HOME. The store is a sibling of the repo dir, so it is never
    # git-tracked. NOTE: this also persists credentials/login across rebuilds
    # — drop the claude.json line below if you would rather re-auth each time.
    CLAUDE_PERSIST="/workspaces/.claude-persist"
    mkdir -p "$CLAUDE_PERSIST/dot-claude"

    # ~/.claude -> persistent dir (migrate a pre-existing real dir on first run)
    if [ -e "$HOME/.claude" ] && [ ! -L "$HOME/.claude" ]; then
        cp -an "$HOME/.claude/." "$CLAUDE_PERSIST/dot-claude/" 2>/dev/null || true
        rm -rf "$HOME/.claude"
    fi
    ln -sfn "$CLAUDE_PERSIST/dot-claude" "$HOME/.claude"

    # ~/.claude.json -> persistent file (project history + login state)
    if [ -e "$HOME/.claude.json" ] && [ ! -L "$HOME/.claude.json" ]; then
        mv -n "$HOME/.claude.json" "$CLAUDE_PERSIST/claude.json"
    fi
    [ -e "$CLAUDE_PERSIST/claude.json" ] || touch "$CLAUDE_PERSIST/claude.json"
    ln -sf "$CLAUDE_PERSIST/claude.json" "$HOME/.claude.json"
fi

echo "############### Symlinking reusable Claude Code content ###############"
# -f forces overwrite: Claude Code may have already written a real
# ~/.claude/settings.json (e.g. theme), and we want our canonical copy to
# win — same as the .zshrc handling above. Only these paths are
# linked; the rest of ~/.claude (credentials, history, sessions) is left
# untouched.
mkdir -p ~/.claude/hooks
ln -srf .claude/hooks/block-askuserquestion.sh ~/.claude/hooks/block-askuserquestion.sh
ln -srf .claude/hooks/pause-skill-reload-on-rebase.sh ~/.claude/hooks/pause-skill-reload-on-rebase.sh
ln -srf .claude/settings.json ~/.claude/settings.json
ln -srf .claude/CLAUDE.md ~/.claude/CLAUDE.md

echo "############### Installing Neovim ###############"
NVIM_VERSION="latest"
#NVIM_URL="https://github.com/neovim/neovim/releases/download/${NVIM_VERSION}/nvim-linux-x86_64.appimage"
# latest has a different form for the url
NVIM_URL="https://github.com/neovim/neovim/releases/${NVIM_VERSION}/download//nvim-linux-x86_64.appimage"
if curl -fsSLO "$NVIM_URL"; then
    chmod u+x nvim-linux-x86_64.appimage
    rm -rf squashfs-root                        # drop any stale extract dir before re-extracting
    ./nvim-linux-x86_64.appimage --appimage-extract > /dev/null
    sudo rm -rf /squashfs-root                  # else `mv` nests into /squashfs-root/squashfs-root on rerun
    sudo mv squashfs-root /
    sudo ln -sf /squashfs-root/AppRun /usr/bin/nvim
    rm nvim-linux-x86_64.appimage
else
    exit 1
fi
sudo apt-get install -y -qq unzip # stylua needs unzip to install
echo "############### Installing Ripgrep ###############"
curl -fsSLO https://github.com/BurntSushi/ripgrep/releases/download/13.0.0/ripgrep_13.0.0_amd64.deb
sudo dpkg -i ripgrep_13.0.0_amd64.deb 2>&1 | grep -Ev "^(Selecting|Preparing|Unpacking|Setting|Processing|\(Reading database)" || true
echo "############### Installing fd-find (for telescope) ###############"
sudo apt-get install -y -qq fd-find 2>&1 | grep -Ev "^(debconf:|dpkg-preconfigure:|Selecting|Preparing|Unpacking|Setting|Processing|\(Reading database)" || true

echo "############### Installing xclip ###############"
sudo apt-get install -y -qq xclip 2>&1 | grep -Ev "^(debconf:|dpkg-preconfigure:|Selecting|Preparing|Unpacking|Setting|Processing|\(Reading database)" || true

echo "############### Installing zsh autosuggestions  ###############"
ZSH_AUTOSUGGEST_DIR="${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/plugins/zsh-autosuggestions"
if [ ! -d "$ZSH_AUTOSUGGEST_DIR" ]; then
    git clone --quiet https://github.com/zsh-users/zsh-autosuggestions "$ZSH_AUTOSUGGEST_DIR"
fi
echo "############### Installing theme (in case of running outside devcontainers) ###############"
wget -q https://raw.githubusercontent.com/devcontainers/features/main/src/common-utils/scripts/devcontainers.zsh-theme -O ~/.oh-my-zsh/custom/themes/devcontainers.zsh-theme

# tmux is built in the deferred background block near the end of this script
# (it was the single biggest cost, ~35s, and isn't needed for first use).

# echo "############### Installing Neovim nightly build as DVIM ###############"
# curl -Lo dvim.appimage https://github.com/neovim/neovim/releases/download/nightly/nvim.appimage
# chmod u+x dvim.appimage
# ./dvim.appimage --appimage-extract
# sudo mv squashfs-root /dvim/
# sudo ln -s /dvim/AppRun /usr/bin/dvim

echo "############### Fixing copilot login in codespaces ###############" # (see https://github.com/orgs/community/discussions/48027)
# These files may not exist yet during initial setup - ignore errors
# sed -i 's/"true"===process\.env\.CODESPACES/false/' ~/.vscode-remote/extensions/github.copilot-*/dist/extension.js 2>/dev/null || true
# sed -i 's/"true"===process\.env\.CODESPACES/false/' ~/.local/share/nvim/site/pack/packer/start/copilot.vim/dist/agent.js 2>/dev/null || true

#  (DISABLED - it creates all sorts of issues!)
# echo "############### Installing terraform-ls ###############"
# sudo apt update && sudo apt install gpg
# wget -O- https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
# gpg --no-default-keyring --keyring /usr/share/keyrings/hashicorp-archive-keyring.gpg --fingerprint
# echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
# sudo apt update && sudo apt install terraform-ls

if ! which node > /dev/null; then
    echo "############### Installing node ###############"
    NODE_MAJOR=24
    curl -fsSL https://deb.nodesource.com/setup_$NODE_MAJOR.x | sudo bash - > /dev/null
    sudo apt-get install -y -qq nodejs
fi

# GitHub CLI is installed in the deferred background block near the end of this
# script (see "Deferring heavy installs to background").

echo "############### Configuring git difftool to use VS Code ###############"
git config --global diff.tool vscode
git config --global difftool.vscode.cmd 'code --wait --diff $LOCAL $REMOTE'
git config --global difftool.prompt false
git config --global rebase.updateRefs true

echo "############### TODO: Download public signing key ###############"
# TODO: figure out auth in this scenario
# mkdir -p ~/.ssh
# gh api /users/torgst/ssh_signing_keys | jq '.[] | select(.title=="Commit signing") | .key' -r > ~/.ssh/id_ed25519.pub

if which code > /dev/null 2>&1; then
  echo "############### Ensuring vs code extensions are installed (or at least try to ensure it) ###############"
    code --install-extension "esbenp.prettier-vscode"
    code --install-extension "redhat.vscode-xml"
    code --install-extension "redhat.vscode-yaml"
    code --install-extension "donjayamanne.githistory"
    code --install-extension "github.copilot-chat"
    code --install-extension "ckolkman.vscode-postgres"
    code --install-extension "usernamehw.errorlens"
    code --install-extension "asvetliakov.vscode-neovim"
    code --install-extension "heaths.vscode-guid"
    code --install-extension "dbaeumer.vscode-eslint"
    code --install-extension "ms-vsliveshare.vsliveshare"
    code --install-extension "eamodio.gitlens"
    code --install-extension "anthropic.claude-code"
fi

# NVM handles global packages automatically. For non-NVM environments, set a user-local prefix to avoid needing sudo.
if ! command -v nvm &> /dev/null; then
    if ! npm config get prefix | grep -q "${HOME}"; then
        echo "############### Setting npm global install location to be under ~/ ###############"
        mkdir -p ~/.npm-global
        npm config set prefix '~/.npm-global'
        # Make sure ~/.npm-global/bin is in PATH (add to .bashrc/.zshrc if needed)
    fi
fi
echo "############### Installing PrettierDaemon ###############"
npm install -g --silent @fsouza/prettierd

echo "############### Deferring heavy installs to background (gh, tmux, lazy.nvim) ###############"
# These three are the slow tail of install.sh (~57s combined) and none are
# needed for the codespace to be usable: GitHub CLI, the tmux source build
# (3.6a isn't packaged for bookworm), and the lazy.nvim plugin/treesitter sync
# (which also auto-runs on first nvim launch). Run them in one detached session
# (setsid) so they survive install.sh exiting — install.sh now returns as soon
# as the essential symlinks + tools above are done, instead of ~57s later.
# All foreground apt work is finished by this point, so the background apt runs
# below own the dpkg lock; Lock::Timeout=-1 is kept as belt-and-suspenders.
# Progress / errors: tail -f /tmp/dotfiles-deferred.log
setsid bash -c '
    export DEBIAN_FRONTEND=noninteractive

    echo "=== Installing GitHub CLI ==="
    (type -p wget >/dev/null || (sudo apt-get update -qq && sudo apt-get install -y -qq wget)) \
      && sudo mkdir -p -m 755 /etc/apt/keyrings \
      && out=$(mktemp) && wget -q -O"$out" https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      && cat "$out" | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
      && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
      && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
      && sudo apt-get update -qq \
      && sudo apt-get install -y -qq -o DPkg::Lock::Timeout=-1 gh

    echo "=== Building tmux from source ==="
    sudo apt-get install -y -qq -o DPkg::Lock::Timeout=-1 libevent-dev ncurses-dev build-essential bison pkg-config
    TMUX_VERSION=$(curl -fsSL https://api.github.com/repos/tmux/tmux/releases/latest | jq -r .tag_name)
    TMUX_VERSION="${TMUX_VERSION:-3.6a}"   # fallback if the API call fails
    workdir=$(mktemp -d)                   # build off the repo tree so nothing is left in git status
    cd "$workdir"
    if curl -fsSLO "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz"; then
        tar -zxf "tmux-${TMUX_VERSION}.tar.gz"
        cd "tmux-${TMUX_VERSION}/"
        ./configure --prefix=/usr > /dev/null 2>&1
        make -s > /dev/null 2>&1 && sudo make -s install > /dev/null 2>&1
        echo "Installed $(tmux -V)"
    else
        echo "WARNING: Failed to download TMUX source"
    fi
    cd /
    rm -rf "$workdir"

    echo "=== Syncing lazy.nvim plugins ==="
    nvim --headless "+Lazy! sync" +qa

    echo "=== Deferred install finished ==="
' < /dev/null > /tmp/dotfiles-deferred.log 2>&1 &
disown 2>/dev/null || true
echo "  -> gh, tmux and lazy.nvim are setting up in the background (log: /tmp/dotfiles-deferred.log)"

echo "############### Checking for Nerd Font ###############"
# Check if a Nerd Font is configured (heuristic: look for common nerd font names in terminal)
# Since we're in WSL, we can't easily detect Windows fonts, so just show a reminder
if [ -z "$NERD_FONT_INSTALLED" ]; then
    echo ""
    echo "=========================================="
    echo "  OPTIONAL: Install a Nerd Font for icons"
    echo "=========================================="
    echo ""
    echo "Nerd Fonts add file icons and symbols to neovim."
    echo "To install:"
    echo ""
    echo "1. Download a font from: https://www.nerdfonts.com/font-downloads"
    echo "   (Recommended: JetBrainsMono Nerd Font or FiraCode Nerd Font)"
    echo ""
    echo "2. Extract and install the .ttf files in Windows"
    echo "   (Right-click -> Install for all users)"
    echo ""
    echo "3. Configure Windows Terminal:"
    echo "   Settings -> Profiles -> Defaults -> Appearance -> Font face"
    echo "   Select your installed Nerd Font"
    echo ""
    echo "4. Update neovim config (set to true):"
    echo "   vim.g.have_nerd_font = true"
    echo "   (in ~/.config/nvim/init.lua, near the top)"
    echo ""
    echo "To skip this message, set NERD_FONT_INSTALLED=1"
    echo ""
fi

echo "############### finished install.sh ###############"
