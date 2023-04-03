curl -LO https://github.com/neovim/neovim/releases/download/stable/nvim-linux64.deb
sudo apt install ./nvim-linux64.deb
git clone --depth 1 https://github.com/wbthomason/packer.nvim ~/.local/share/nvim/site/pack/packer/start/packer.nvim
curl -LO https://github.com/BurntSushi/ripgrep/releases/download/13.0.0/ripgrep_13.0.0_amd64.deb
sudo dpkg -i ripgrep_13.0.0_amd64.deb
cp -a .config/. ~/.config
nvim --headless -c 'autocmd User PackerComplete quitall' -c 'PackerSync' # See https://github.com/wbthomason/packer.nvim/issues/502
cp .zshrc ~/.zshrc
cp .tmux.conf ~/.tmux.conf
sudo apt-get update
# sudo apt-get install -y tmux
sudo apt-get install -y xclip
