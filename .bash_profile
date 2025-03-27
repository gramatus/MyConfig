# https://docs.github.com/en/codespaces/developing-in-codespaces/persisting-environment-variables-and-temporary-files#for-all-codespaces-that-you-create
export DisableErrorHandlerMiddleware=true
export SHELL=/bin/zsh
# Make sure ssh-agent is running at each login
if [ -z "$SSH_AUTH_SOCK" ]; then
   # Check for a currently running instance of the agent
   RUNNING_AGENT="`ps -ax | grep 'ssh-agent -s' | grep -v grep | wc -l | tr -d '[:space:]'`"
   if [ "$RUNNING_AGENT" = "0" ]; then
        # Launch a new instance of the agent
        ssh-agent -s &> .ssh/ssh-agent
   fi
   eval `cat .ssh/ssh-agent`
fi
exec /bin/zsh -l
