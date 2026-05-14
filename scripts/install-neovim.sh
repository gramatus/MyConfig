#!/usr/bin/env bash
#
# install-neovim.sh — Install a specific version of Neovim from upstream releases.
# Usage: ./install-neovim.sh v0.11.7
#        ./install-neovim.sh latest
#
# install.sh always pulls "latest". Use this when latest is broken and you
# want to pin a known-good version without changing the default.

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "Usage: $(basename "$0") <version>" >&2
    echo "  e.g. $(basename "$0") v0.11.7" >&2
    echo "       $(basename "$0") latest" >&2
    echo "" >&2
    if command -v gh &>/dev/null; then
        echo "Recent Neovim releases:" >&2
        gh release list -R neovim/neovim --limit 15 >&2 || echo "  (failed to fetch releases)" >&2
    else
        echo "Install 'gh' to see the list of recent releases here." >&2
    fi
    exit 1
fi

NVIM_VERSION="$1"

# Asset name changed during v0.10.x; try the new name first, fall back to the legacy one for older tags.
ASSETS=("nvim-linux-x86_64.appimage" "nvim.appimage")

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
cd "$WORKDIR"

downloaded=""
for asset in "${ASSETS[@]}"; do
    url="https://github.com/neovim/neovim/releases/download/${NVIM_VERSION}/${asset}"
    echo "Trying $url"
    if curl -fsSLO "$url"; then
        downloaded="$asset"
        break
    fi
done

if [[ -z "$downloaded" ]]; then
    echo "Failed to download Neovim $NVIM_VERSION (tried: ${ASSETS[*]})" >&2
    exit 1
fi

chmod u+x "$downloaded"
./"$downloaded" --appimage-extract > /dev/null

# Replace prior install (install.sh layout: /squashfs-root extracted dir + /usr/bin/nvim symlink to its AppRun)
sudo rm -rf /squashfs-root
sudo rm -f /usr/bin/nvim
sudo mv squashfs-root /
sudo ln -s /squashfs-root/AppRun /usr/bin/nvim

echo "Installed: $(nvim --version | head -1)"
