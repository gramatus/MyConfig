# Symlink files and folders to HOME
ln -sr scripts ~/scripts
ln -sr .config/nvim ~/.config/nvim # Need to symlink every folder in .config
rm ~/.zshrc
ln -sr .zshrc ~/.zshrc
ln -sr .tmux.conf ~/.tmux.conf
ln -sr .bash_profile ~/.bash_profile

# Install Neovim
curl -LO https://github.com/neovim/neovim/releases/latest/download/nvim.appimage
chmod u+x nvim.appimage
./nvim.appimage --appimage-extract
sudo mv squashfs-root /
sudo ln -s /squashfs-root/AppRun /usr/bin/nvim
# Install packer
git clone --depth 1 https://github.com/wbthomason/packer.nvim ~/.local/share/nvim/site/pack/packer/start/packer.nvim
# Install Ripgrep
curl -LO https://github.com/BurntSushi/ripgrep/releases/download/13.0.0/ripgrep_13.0.0_amd64.deb
sudo dpkg -i ripgrep_13.0.0_amd64.deb

# Install xclip and tmux
sudo apt-get update
sudo apt-get install -y xclip

# Install zsh autosuggestions
git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions

# Install TMUX (and dependencies)
sudo apt-get install -y libevent-dev ncurses-dev build-essential bison pkg-config
curl -LO https://github.com/tmux/tmux/releases/download/3.3a/tmux-3.3a.tar.gz
tar -zxf tmux-*.tar.gz # Extracts into subfolder with same name as archive
cd tmux-*/
./configure --prefix=/usr
make && sudo make install
cd ..

# Install Neovim nightly build as DVIM
# curl -Lo dvim.appimage https://github.com/neovim/neovim/releases/download/nightly/nvim.appimage
# chmod u+x dvim.appimage
# ./dvim.appimage --appimage-extract
# sudo mv squashfs-root /dvim/
# sudo ln -s /dvim/AppRun /usr/bin/dvim

# Fix copilot login in codespaces (see https://github.com/orgs/community/discussions/48027)
sed -i 's/"true"===process\.env\.CODESPACES/false/' ~/.vscode-remote/extensions/github.copilot-*/dist/extension.js
sed -i 's/"true"===process\.env\.CODESPACES/false/' ~/.local/share/nvim/site/pack/packer/start/copilot.vim/dist/agent.js

# Install terraform-ls
sudo apt update && sudo apt install gpg
wget -O- https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
gpg --no-default-keyring --keyring /usr/share/keyrings/hashicorp-archive-keyring.gpg --fingerprint
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt update && sudo apt install terraform-ls

# Ensure vs code extensions are installed
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

# Install PrettierDaemon
npm install -g @fsouza/prettierd
# Prerun packer, but do it last, as it sometimes (always?) crashes
nvim --headless -c 'autocmd User PackerComplete quitall' -c 'PackerSync' # See https://github.com/wbthomason/packer.nvim/issues/502
