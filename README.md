# For å komme i gang i WSL

```powershell
$NewDistributionName = "Debian_gramatus";
$SourceFile = "C:\wsl\2023-10-01 Default Debian.tar"
wsl --import $NewDistributionName "C:\wsl\instances\$NewDistributionName" $SourceFile
wsl -d Debian_gramatus
```

```shell
username="gramatus"
sudo apt install -y openssl
useradd --create-home --user-group --groups  adm,dialout,cdrom,floppy,sudo,audio,dip,video,plugdev,netdev,users --password $(read -sp Password: pw ; echo $pw | openssl passwd -1 -stdin) $username
sudo echo -e "[user]\ndefault=$username" >> /etc/wsl.conf
exit
```

```powershell
wsl -d Debian_gramatus
```

For å kunne koble til GitHub og klone repo:

```shell
github_user=gramatus

sudo apt-get update
sudo apt-get install -y curl wget jq
gcm_download_url=$(curl https://api.github.com/repos/git-ecosystem/git-credential-manager/releases/latest | jq '.assets[] | select((.name|startswith("gcm-linux_amd64")) and (.name|endswith(".deb"))) | .browser_download_url' -r)
gcm_filename=$(curl https://api.github.com/repos/git-ecosystem/git-credential-manager/releases/latest | jq '.assets[] | select((.name|startswith("gcm-linux_amd64")) and (.name|endswith(".deb"))) | .name' -r)
wget $gcm_download_url
sudo dpkg -i $gcm_filename
sudo apt-get install -y pass
# export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 # Might be needed, might not be needed
git-credential-manager configure
userid=$(whoami)
# We don't want a passphrase because we want to use the key in automated scripts, including when starting our shell.
# Since we are only the key inside WSL on computers that should be properly secured, this should be fine.
# If you more security, you can remove `--batch --passphrase ''` to use a passphrase
export GPG_TTY=$(tty) # If using a passphrase, you need to set this to ensure you get the prompt when your key is used
gpg --batch --passphrase '' --quick-gen-key $userid
pass init $userid
git config --global credential.credentialStore gpg
sudo mkdir /repos
cd /repos
sudo chown $userid:$userid .
```

For å kjøre dotfiles:

```shell
cd /repos
git config --global credential.guiPrompt false
git clone https://github.com/torgst/MyConfig.git
cd MyConfig/
./install.sh
```
