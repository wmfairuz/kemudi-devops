# Kemudi shell integration. zsh reads this because Kemudi points ZDOTDIR here.
# Load the user's own .zshenv from their real ZDOTDIR first, then keep
# ZDOTDIR on this directory so zsh reads our .zprofile/.zshrc/.zlogin next.
__kemudi_dir=$ZDOTDIR
ZDOTDIR=${KEMUDI_USER_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/.zshenv ]] && source $ZDOTDIR/.zshenv
KEMUDI_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$__kemudi_dir
