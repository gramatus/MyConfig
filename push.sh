#!/bin/bash

# Push changes to GitHub using token stored in $MYCONFIG_PAT (which should be set in my personal codespace secrets)

sudo sed -i 's/$GITHUB_TOKEN/$MYCONFIG_PAT/' /.codespaces/bin/gitcredential_github.sh
git push
sudo sed -i 's/$MYCONFIG_PAT/$GITHUB_TOKEN/' /.codespaces/bin/gitcredential_github.sh
