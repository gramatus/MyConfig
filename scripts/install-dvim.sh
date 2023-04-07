cd ~/dotfiles/
curl -Lo dvim.appimage https://github.com/neovim/neovim/releases/download/nightly/nvim.appimage
chmod u+x dvim.appimage
./dvim.appimage --appimage-extract
sudo mv squashfs-root /dvim/
sudo ln -s /dvim/AppRun /usr/bin/dvim
