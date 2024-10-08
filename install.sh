echo "############### Installing zsh and oh-my-zsh if not present ###############"
sudo apt install zsh
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
curl -LO https://github.com/neovim/neovim/releases/latest/download/nvim.appimage
chmod u+x nvim.appimage
./nvim.appimage --appimage-extract
sudo mv squashfs-root /
sudo ln -s /squashfs-root/AppRun /usr/bin/nvim
echo "############### Installing packer ###############"
git clone --depth 1 https://github.com/wbthomason/packer.nvim ~/.local/share/nvim/site/pack/packer/start/packer.nvim
echo "############### Installing Ripgrep ###############"
curl -LO https://github.com/BurntSushi/ripgrep/releases/download/13.0.0/ripgrep_13.0.0_amd64.deb
sudo dpkg -i ripgrep_13.0.0_amd64.deb

echo "############### Installing xclip ###############"
sudo apt-get update
sudo apt-get install -y xclip

echo "############### Installing zsh autosuggestions  ###############"
git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
echo "############### Installing theme (in case of running outside devcontainers) ###############"
wget https://raw.githubusercontent.com/devcontainers/features/main/src/common-utils/scripts/devcontainers.zsh-theme -O ~/.oh-my-zsh/custom/themes/devcontainers.zsh-theme

echo "############### Installing TMUX (and dependencies) ###############"
sudo apt-get install -y libevent-dev ncurses-dev build-essential bison pkg-config
curl -LO https://github.com/tmux/tmux/releases/download/3.3a/tmux-3.3a.tar.gz
tar -zxf tmux-*.tar.gz # Extracts into subfolder with same name as archive
cd tmux-*/
./configure --prefix=/usr
make && sudo make install
cd ..

# echo "############### Installing Neovim nightly build as DVIM ###############"
# curl -Lo dvim.appimage https://github.com/neovim/neovim/releases/download/nightly/nvim.appimage
# chmod u+x dvim.appimage
# ./dvim.appimage --appimage-extract
# sudo mv squashfs-root /dvim/
# sudo ln -s /dvim/AppRun /usr/bin/dvim

echo "############### Fixing copilot login in codespaces ###############" # (see https://github.com/orgs/community/discussions/48027)
sed -i 's/"true"===process\.env\.CODESPACES/false/' ~/.vscode-remote/extensions/github.copilot-*/dist/extension.js
sed -i 's/"true"===process\.env\.CODESPACES/false/' ~/.local/share/nvim/site/pack/packer/start/copilot.vim/dist/agent.js

#  (DISABLED - it creates all sorts of issues!)
# echo "############### Installing terraform-ls ###############"
# sudo apt update && sudo apt install gpg
# wget -O- https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
# gpg --no-default-keyring --keyring /usr/share/keyrings/hashicorp-archive-keyring.gpg --fingerprint
# echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
# sudo apt update && sudo apt install terraform-ls

if ! which node; then
    echo "############### Installing node ###############"
    sudo apt-get install -y ca-certificates curl gnupg
    sudo mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    NODE_MAJOR=20
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list
    sudo apt-get update
    sudo apt-get install -y nodejs
fi

if which code; then
  echo "############### Ensuring vs code extensions are installed (or at least try to ensure it) ###############"
  code --install-extension "donjayamanne.githistory"
  code --install-extension "rangav.vscode-thunder-client"
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

if ! npm config get prefix | grep .npm-global > /dev/null;then
    echo "############### Setting npm global install location to be under ~/ ###############"
    mkdir ~/.npm-global
    npm config set prefix '~/.npm-global'
fi
echo "############### Installing PrettierDaemon ###############"
npm install -g @fsouza/prettierd
echo "############### finished install.sh ###############"
# echo "############### Prerunning packer ###############" # doing this last, as it sometimes (always?) crashes
# nvim --headless -c 'autocmd User PackerComplete quitall'
# nvim --headless -c 'PackerSync' # See https://github.com/wbthomason/packer.nvim/issues/502
