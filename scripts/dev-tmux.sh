H=$(($(tput lines)-1))
W=$(($(tput cols)))

# Open a new session in the background (so we can do stuff before opening it)
tmux new-session -d -x $W -y $H
# Split to create the bottom terminal pane first (full width, height 25 lines)
tmux split-window -v -d
tmux resize-pane -t1 -y 25
# Split top into left (nvim) and right (auxiliary)
tmux select-pane -t0
tmux split-window -h -d
# Start nvim in top-left
tmux send-keys -t0 nvim Space . Enter
# Open the session
tmux -2 attach-session -d
