# Kemudi shell integration: load the user's .zlogin, then hand ZDOTDIR back
# so shells started from this one load the user's files directly.
ZDOTDIR=$KEMUDI_USER_ZDOTDIR
[[ -r $ZDOTDIR/.zlogin ]] && source $ZDOTDIR/.zlogin
unset __kemudi_dir
