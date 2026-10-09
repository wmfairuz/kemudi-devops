#!/bin/sh
# Cargo runner for `pnpm tauri dev` (see .cargo/config.toml): signs the dev
# build with your Apple Development identity and a fixed identifier before
# running it. Unsigned dev builds get a new code signature on every rebuild,
# so macOS asks again for Keychain access ("Kemudi Devops cache key") each
# time; signed like this, "Always Allow" sticks.
#
# KEMUDI_SIGN_IDENTITY=… picks another identity; =none skips signing.
bin="$1"
shift
case "$(basename "$bin")" in
kemudi)
  id="${KEMUDI_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Apple Development[^"]*\)".*/\1/p' | head -n 1)}"
  if [ -n "$id" ] && [ "$id" != none ]; then
    codesign --force --sign "$id" --identifier dev.kemudi.app "$bin" >/dev/null 2>&1 ||
      echo "kemudi: couldn't sign the dev build with \"$id\"; macOS will ask for Keychain access after each rebuild" >&2
  fi
  ;;
esac
exec "$bin" "$@"
