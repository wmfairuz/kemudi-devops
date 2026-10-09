# Kemudi shell integration: load the user's .zshrc, then mark prompts,
# commands and their output with OSC 133 so Kemudi can show command blocks
# (copy command / copy output) and place the cursor on click. Prints nothing
# during startup.
__kemudi_dir=$ZDOTDIR
ZDOTDIR=$KEMUDI_USER_ZDOTDIR
# macOS /etc/zshrc set HISTFILE from our ZDOTDIR; use the user's history.
[[ $HISTFILE == $__kemudi_dir/.zsh_history ]] && HISTFILE=$ZDOTDIR/.zsh_history
[[ -r $ZDOTDIR/.zshrc ]] && source $ZDOTDIR/.zshrc
ZDOTDIR=$__kemudi_dir

if [[ -z $__kemudi_hooked ]]; then
  __kemudi_hooked=1
  __kemudi_ran=0
  __kemudi_precmd() {
    local ec=$?
    # After a command: close its block, then a blank row (the divider sits
    # in it, giving the output some room, like Warp).
    (( __kemudi_ran )) && printf '\e]133;D;%s\a\n' $ec
    __kemudi_ran=0
    printf '\e]133;A\a'
  }
  __kemudi_preexec() {
    __kemudi_ran=1
    local c=${1//\\/\\\\}
    c=${c//;/\\x3b}; c=${c//$'\n'/\\x0a}; c=${c//$'\e'/}; c=${c//$'\a'/}
    printf '\e]633;E;%s\a\e]133;C\a' "$c"
  }
  # First in line so it sees the command's exit status.
  precmd_functions=(__kemudi_precmd $precmd_functions)
  preexec_functions+=(__kemudi_preexec)
  # Where the command line starts (OSC 133;B), for click-to-move-cursor:
  # sent when the line editor starts, after any theme has drawn its prompt.
  __kemudi_line_init() { printf '\e]133;B\a' }
  autoload -Uz add-zle-hook-widget && add-zle-hook-widget line-init __kemudi_line_init
fi

# Not a login shell: no .zlogin follows, hand ZDOTDIR back to the user.
[[ -o login ]] || { ZDOTDIR=$KEMUDI_USER_ZDOTDIR; unset __kemudi_dir; }
