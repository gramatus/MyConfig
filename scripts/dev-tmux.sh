H=$(($(tput lines)-1))
W=$(($(tput cols)))

tmux new-session -d -x $W -y $H
tmux send-keys -t0 nvim Space . Enter
tmux split-window -v -d

tmux resize-pane -t1 -y 25

tmux -2 attach-session -d
