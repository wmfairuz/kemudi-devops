# Kemudi shell integration: load the user's .zprofile.
__kemudi_dir=$ZDOTDIR
ZDOTDIR=$KEMUDI_USER_ZDOTDIR
[[ -r $ZDOTDIR/.zprofile ]] && source $ZDOTDIR/.zprofile
ZDOTDIR=$__kemudi_dir
