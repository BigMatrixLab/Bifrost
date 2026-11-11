#!/usr/bin/env bash
# Launches the built Mac app and checks that the engine starts, then that a
# second launch hands off to the running instance and exits.
set -u
app="${1:?path to Bifrost.app}"
bin="$app/Contents/MacOS/Bifrost"
log="$HOME/Library/Application Support/app.relayless.desktop/logs/bifrost.log"
stdout="$(mktemp)"

xattr -cr "$app" 2>/dev/null || true
rm -f "$log"

"$bin" --minimized >"$stdout" 2>&1 &
pid=$!

started=no
alive=no
for _ in $(seq 1 30); do
  if [ -f "$log" ] && grep -q "started as" "$log"; then
    started=yes
  fi
  if kill -0 "$pid" 2>/dev/null; then
    alive=yes
  else
    alive=no
  fi
  if [ "$started" = yes ] && [ "$alive" = yes ]; then
    break
  fi
  sleep 1
done

text=""
[ -f "$log" ] && text="$(cat "$log")"
echo "---- app log ----"
echo "$text"
if [ "$alive" != yes ]; then
  echo "---- process output ----"
  cat "$stdout" || true
fi

# A second launch must hand over to the running instance and exit. Allow
# 25 s: the handoff can wait up to 10 s for the running instance to answer,
# and a cold runner is slow to start a process.
"$bin" --minimized >"$stdout.2" 2>&1 &
pid2=$!
second_exited=no
for _ in $(seq 1 25); do
  if ! kill -0 "$pid2" 2>/dev/null; then
    second_exited=yes
    break
  fi
  sleep 1
done
echo "Second instance exited (single-instance handoff): $second_exited"
if [ "$second_exited" != yes ]; then
  echo "---- second instance output ----"
  cat "$stdout.2" || true
fi

kill "$pid" 2>/dev/null || true
sleep 1
kill -9 "$pid" 2>/dev/null || true
pkill -x Bifrost 2>/dev/null || true
wait "$pid" 2>/dev/null || true
wait "$pid2" 2>/dev/null || true

summary="alive=$alive started=$started secondExited=$second_exited"
echo "$summary"

enc() { sed 's/%/%25/g; s/\r//g' | awk '{printf "%s%%0A", $0}'; }
if [ "$started" != yes ] || [ "$alive" != yes ] || [ "$second_exited" != yes ]; then
  echo "::error title=Smoke test failed ($summary)::$(printf '%s' "$text" | enc)"
  exit 1
fi
echo "::notice title=Smoke test passed::$summary"
