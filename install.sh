# Install Neovim
curl -LO https://github.com/neovim/neovim/releases/download/stable/nvim-linux64.deb
sudo apt install ./nvim-linux64.deb
# Install packer
git clone --depth 1 https://github.com/wbthomason/packer.nvim ~/.local/share/nvim/site/pack/packer/start/packer.nvim
# Install Ripgrep
curl -LO https://github.com/BurntSushi/ripgrep/releases/download/13.0.0/ripgrep_13.0.0_amd64.deb
sudo dpkg -i ripgrep_13.0.0_amd64.deb

# Install xclip and tmux
sudo apt-get update
sudo apt-get install -y xclip
sudo apt-get install -y tmux

# Setup paths
export PATH=$PATH:~/scripts

# Copy files and folders to HOME
cp -a scripts/. ~/scripts
cp -a .config/. ~/.config
cp .zshrc ~/.zshrc
cp .tmux.conf ~/.tmux.conf

# Install zsh autosuggestions
git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions

# Prerun packer
nvim --headless -c 'autocmd User PackerComplete quitall' -c 'PackerSync' # See https://github.com/wbthomason/packer.nvim/issues/502
# Install PrettierDaemon
npm install -g @fsouza/prettierd

# Install Neovim nightly build as DVIM
. ~/scripts/install-dvim.sh

# Check that display variable is set (not sure if this is smart and/or right)
if [ "x$DISPLAY" = "x" ] && [ "x$CODESPACES" != "xtrue" ] # Concatenate something to the variable and see if the result is only that something
then
   export DISPLAY=:0
fi
# Check if XCLIP is working
echo "test"|xclip && export xclip_working=true || export xclip_working=false
