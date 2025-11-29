#!/bin/bash

# Push changes to GitHub using token stored in $MYCONFIG_PAT (which should be set in my personal codespace secrets)

if [[ -z "$MYCONFIG_PAT" ]]; then
    echo "ERROR: \$MYCONFIG_PAT is not set."
    echo ""
    echo "  1. Go to your Codespaces secrets at https://github.com/settings/codespaces"
    echo "  2. Edit MYCONFIG_PAT and add $GITHUB_REPOSITORY under 'Repository access'"
    exit 1
fi

sudo sed -i 's/$GITHUB_TOKEN/$MYCONFIG_PAT/' /.codespaces/bin/gitcredential_github.sh
git push
sudo sed -i 's/$MYCONFIG_PAT/$GITHUB_TOKEN/' /.codespaces/bin/gitcredential_github.sh
