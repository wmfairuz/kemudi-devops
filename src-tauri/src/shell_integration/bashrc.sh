# Kemudi shell integration for remote bash. The ssh bootstrap writes this to
# a temp file and starts `bash --rcfile <file> -i`; it removes itself.
rm -f -- "$KEMUDI_RC" 2>/dev/null; unset KEMUDI_RC
# What a login shell would read (Ubuntu's ~/.profile sources ~/.bashrc).
[ -r /etc/profile ] && . /etc/profile
if [ -r ~/.bash_profile ]; then . ~/.bash_profile
elif [ -r ~/.bash_login ]; then . ~/.bash_login
elif [ -r ~/.profile ]; then . ~/.profile
fi
if [ -z "$__kemudi_hooked" ]; then
  __kemudi_hooked=1
  __kemudi_ran=0
  __kemudi_prompt() {
    local ec=$?
    printf '\033]133;D;%s\007' "$ec"
    # After a command: a blank row for the divider (room after the output).
    [ "$__kemudi_ran" = 1 ] && printf '\n'
    __kemudi_ran=0
    printf '\033]133;A\007'
    return $ec
  }
  PROMPT_COMMAND="__kemudi_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
  PS1="${PS1}\[\033]133;B\007\]"
  # PS0 (bash 4.4+) is shown just before a command runs. The array subscript
  # is arithmetic, so it sets __kemudi_ran=1 in this shell and prints nothing.
  PS0="${PS0}"'${__kemudi_ps0[__kemudi_ran=1]-}'$'\033]133;C\007'
fi
