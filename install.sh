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

# Copy files and folders to HOME
ln -sr scripts ~/scripts
ln -sr .config ~/.config
ln -sr .zshrc ~/.zshrc
ln -sr .tmux.conf ~/.tmux.conf
ln -sr .bash_profile ~/.bash_profile

# Install zsh autosuggestions
git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions

# Prerun packer
nvim --headless -c 'autocmd User PackerComplete quitall' -c 'PackerSync' # See https://github.com/wbthomason/packer.nvim/issues/502
# Install PrettierDaemon
npm install -g @fsouza/prettierd

# Install TMUX (and dependencies)
sudo apt-get install -y libevent-dev ncurses-dev build-essential bison pkg-config
curl -LO https://github.com/tmux/tmux/releases/download/3.3a/tmux-3.3a.tar.gz
tar -zxf tmux-*.tar.gz # Extracts into subfolder with same name as archive
cd tmux-*/
./configure --prefix=/usr
make && sudo make install
cd ..

# Install Neovim nightly build as DVIM
curl -Lo dvim.appimage https://github.com/neovim/neovim/releases/download/nightly/nvim.appimage
chmod u+x dvim.appimage
./dvim.appimage --appimage-extract
sudo mv squashfs-root /dvim/
sudo ln -s /dvim/AppRun /usr/bin/dvim
