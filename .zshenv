# Read by every zsh, including the `zsh -lic` VS Code uses to capture PATH, which .zshrc returns early from.
typeset -U path
path=($HOME/.local/bin $HOME/.npm-global/bin $path $HOME/scripts)
export PATH
