#!/bin/bash

# Target layout:
#   ┌──────────────┬──────────────┐
#   │  top-left    │  top-right   │
#   │  (nvim)      │  (auxiliary) │
#   ├──────────────┴──────────────┤
#   │         bottom              │
#   │        (terminal)           │
#   └─────────────────────────────┘

# Number of lines the bottom pane should have to start
bottom_target_height=${1:-25}

if [[ -z "$TMUX" ]]; then
    # Launch tmux and run this script again ($0 is the path to the currently running script, so it re-runs itself inside the new session)
    tmux new-session "$0 $bottom_target_height"
else
    # sort syntax: -tSEP -kSTART[,END][flags]
    # i.e. separate by space (actually default, so not really needed) and sort by the given keys (by using -k multiple times we can do secondary sort, etc.)
    topleft=$(tmux list-panes -F "#{pane_id} #{pane_top} #{pane_left}" | sort -t" " -k2,2n -k3,3n | head -1 | cut -d" " -f1);

    has_bottom=$(tmux list-panes -F '#{pane_top} #{pane_left}' | awk '$1 > 0')

    if [[ -z "$has_bottom" ]]; then
        # Add bottom pane by doing a Vertical split, using Full width even if we have multiple panes in the horizontal direction
        tmux split-window -fv -d
    fi
    bottomleft=$(tmux list-panes -F "#{pane_id} #{pane_top} #{pane_left}" | sort -t" " -k2,2nr -k3,3n | head -1 | cut -d" " -f1);

    has_topright=$(tmux list-panes -F '#{pane_top} #{pane_left}' | awk '$1 == 0 && $2 > 0')
    if [[ -z "$has_topright" ]]; then
        tmux select-pane -t $topleft
        tmux split-window -h -d
    fi
    topright=$(tmux list-panes -F "#{pane_id} #{pane_top} #{pane_left}" | sort -t" " -k2,2n -k3,3nr | head -1 | cut -d" " -f1);

    # Ensure bottom pane has correct size
    tmux resize-pane -t $bottomleft -y $bottom_target_height
    # tmux display-message -p -t $topleft '#{pane_current_command}'
    if [[ "$(tmux display-message -p -t $topleft '#{pane_current_command}')" == "zsh" || "$(tmux display-message -p -t $topleft '#{pane_current_command}')" == "bash" ]]; then
        tmux send-keys -t $topleft 'nvim .' Enter
        # Alternative, if I want to open nvim with a listening socket (can be used if I want to open buffers from outside, e.g. for my Claude transcript hooks)
        # tmux send-keys -t $topleft 'nvim --listen /tmp/nvim.sock .' Enter
    fi
fi
