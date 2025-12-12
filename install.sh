# Skip dotfiles for specific repos
if [ "$GITHUB_REPOSITORY" = "gramatus/claude-reproductions" ]; then
    echo "Skipping dotfiles installation for this repository"
    exit 0
fi

# Disable colors for cleaner log output
export NO_COLOR=1
export FORCE_COLOR=0
export DEBIAN_FRONTEND=noninteractive

echo "############### Installing zsh and oh-my-zsh if not present ###############"
sudo apt-get install -y -qq zsh 2>&1 | grep -Ev "^(debconf:|dpkg-preconfigure:|Selecting|Preparing|Unpacking|Setting|Processing|\(Reading database)" || true
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
sudo chsh -s /bin/zsh

echo "############### Symlinking files and folders to HOME ###############"
ln -sr scripts ~/scripts
if [ ! -d "~/.config" ]; then
    mkdir ~/.config;
fi
ln -sr .config/nvim.kickstart ~/.config/nvim # Need to symlink every folder in .config
rm ~/.zshrc
ln -sr .zshrc ~/.zshrc
ln -sr .tmux.conf ~/.tmux.conf
ln -sr .bash_profile ~/.bash_profile

echo "############### Installing Neovim ###############"
NVIM_URL="https://github.com/neovim/neovim/releases/latest/download/nvim-linux-x86_64.appimage"
if curl -fsSLO "$NVIM_URL"; then
    chmod u+x nvim-linux-x86_64.appimage
    ./nvim-linux-x86_64.appimage --appimage-extract > /dev/null
    sudo mv squashfs-root /
    sudo ln -s /squashfs-root/AppRun /usr/bin/nvim
    rm nvim-linux-x86_64.appimage
else
    exit 1
fi
sudo apt-get install -y -qq unzip # stylua needs unzip to install
echo "############### Installing Ripgrep ###############"
curl -fsSLO https://github.com/BurntSushi/ripgrep/releases/download/13.0.0/ripgrep_13.0.0_amd64.deb
sudo dpkg -i ripgrep_13.0.0_amd64.deb 2>&1 | grep -Ev "^(Selecting|Preparing|Unpacking|Setting|Processing|\(Reading database)" || true

echo "############### Installing xclip ###############"
sudo apt-get update -qq
sudo apt-get install -y -qq xclip 2>&1 | grep -Ev "^(debconf:|dpkg-preconfigure:|Selecting|Preparing|Unpacking|Setting|Processing|\(Reading database)" || true

echo "############### Installing zsh autosuggestions  ###############"
git clone --quiet https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
echo "############### Installing theme (in case of running outside devcontainers) ###############"
wget -q https://raw.githubusercontent.com/devcontainers/features/main/src/common-utils/scripts/devcontainers.zsh-theme -O ~/.oh-my-zsh/custom/themes/devcontainers.zsh-theme

echo "############### Installing TMUX (and dependencies) ###############"
sudo apt-get install -y -qq libevent-dev ncurses-dev build-essential bison pkg-config 2>&1 | grep -Ev "^(debconf:|dpkg-preconfigure:|Selecting|Preparing|Unpacking|Setting|Processing|\(Reading database)" || true
TMUX_VERSION="3.5a"
TMUX_URL="https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz"
if curl -fsSLO "$TMUX_URL"; then
    tar -zxf tmux-${TMUX_VERSION}.tar.gz
    cd tmux-${TMUX_VERSION}/
    ./configure --prefix=/usr > /dev/null 2>&1
    make -s > /dev/null 2>&1 && sudo make -s install > /dev/null 2>&1
    cd ..
    rm -rf tmux-${TMUX_VERSION} tmux-${TMUX_VERSION}.tar.gz
else
    echo "WARNING: Failed to download TMUX source"
fi

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

if ! which node; then
    echo "############### Installing node ###############"
    NODE_MAJOR=20
    curl -fsSL https://deb.nodesource.com/setup_$NODE_MAJOR.x | sudo bash - > /dev/null
    sudo apt-get install -y -qq nodejs
fi

echo "############### Installing GitHub CLI ###############"
(type -p wget >/dev/null || (sudo apt-get update -qq && sudo apt-get install -y -qq wget)) \
  && sudo mkdir -p -m 755 /etc/apt/keyrings \
        && out=$(mktemp) && wget -q -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        && cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && sudo apt-get update -qq \
  && sudo apt-get install -y -qq gh 2>&1 | grep -Ev "^(debconf:|dpkg-preconfigure:|Selecting|Preparing|Unpacking|Setting|Processing|\(Reading database)" || true

echo "############### TODO: Download public signing key ###############"
# TODO: figure out auth in this scenario
# mkdir -p ~/.ssh
# gh api /users/torgst/ssh_signing_keys | jq '.[] | select(.title=="Commit signing") | .key' -r > ~/.ssh/id_ed25519.pub

if which code > /dev/null 2>&1; then
  echo "############### Ensuring vs code extensions are installed (or at least try to ensure it) ###############"
  code --install-extension "donjayamanne.githistory"
  code --install-extension "github.copilot"
  code --install-extension "dotjoshjohnson.xml"
  code --install-extension "ckolkman.vscode-postgres"
  code --install-extension "usernamehw.errorlens"
  code --install-extension "esbenp.prettier-vscode"
  code --install-extension "asvetliakov.vscode-neovim"
  code --install-extension "heaths.vscode-guid"
  code --install-extension "dbaeumer.vscode-eslint"
  code --install-extension "ms-vsliveshare.vsliveshare"
  code --install-extension "eamodio.gitlens"
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

echo "############### Prerunning lazy.nvim plugin sync ###############"
# Run lazy.nvim sync headlessly - the ! makes it non-interactive
# Silence all plugin operations but keep warnings/errors
nvim --headless "+Lazy! sync" +qa 2>&1 | grep -Ev "^\[.*\] (clone|checkout|docs|fetch|status|build) \||Cloning into|Finished task|Running task|Updating files:|Submodule|Downloading tree-sitter|Creating temporary|Extracting tree-sitter|Compiling\.\.\.|Treesitter parser for .* has been installed|git submodule|make\[|/usr/bin/cc|shared jsregexp|cp "|rm -f" || true

echo "############### finished install.sh ###############"
