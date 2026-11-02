#!/usr/bin/env bash
# Checks the launched app on the emulator: process alive, engine started, no crash.
#
# Fails on a crash (Java exception, native signal, Rust panic) or if the
# process died or never started the engine. An ANR alone is reported as a
# warning: on the CI emulator (cold boot, 2 cores, software GPU) the first
# launch can miss the 5 s input deadline while Android itself is still busy.
# The `tombstoned ... kDebuggerdJavaBacktrace` lines that come with an ANR are
# stack dumps Android collects from many processes, not crashes.
set -u
pkg=app.relayless
pid="$(adb shell pidof "$pkg" 2>/dev/null | tr -d '\r')"
ps_line="$(adb shell ps -A 2>/dev/null | tr -d '\r' | grep -w "$pkg" | head -1)"
log="$(adb logcat -d -v brief 2>/dev/null)"

# The app's pid from the log, so native crash lines (which name the pid, not
# always the package) can be matched to it.
log_pid="$(echo "$log" | grep -oE "Start proc [0-9]+:$pkg/" | tail -1 | grep -oE '[0-9]+')"
crash_re="FATAL EXCEPTION|Fatal signal|Abort message|panicked|Process $pkg .*has died|Killing [0-9]+:$pkg|lowmemorykiller.*$pkg"
crashes="$(echo "$log" | grep -E "$crash_re" | grep -E "$pkg|panicked${log_pid:+|\\( *$log_pid\\)|pid $log_pid}" | head -30)"
anrs="$(echo "$log" | grep -E "ANR in $pkg|Reason: " | grep -A1 "ANR in $pkg" | head -6)"

echo "---- process ----"; echo "pidof=$pid"; echo "ps=$ps_line"
echo "---- crash / death lines ----"; echo "${crashes:-none}"
echo "---- ANR ----"; echo "${anrs:-none}"
echo "---- relevant logcat ----"
echo "$log" | grep -E "Bifrost|AndroidRuntime|$pkg|panicked|tauri|DEBUG" | tail -150

started=no; echo "$log" | grep -q "Bifrost engine started" && started=yes
alive=no; { [ -n "$pid" ] || [ -n "$ps_line" ]; } && alive=yes
crashed=no; [ -n "$crashes" ] && crashed=yes
anr=no; [ -n "$anrs" ] && anr=yes
mem="$(adb shell dumpsys meminfo "$pkg" 2>/dev/null | tr -d '\r' | grep -m1 'TOTAL PSS' | awk '{print $3}')"
summary="alive=$alive started=$started crashed=$crashed anr=$anr pss=${mem:-?}KB"
echo "$summary"

enc() { sed 's/%/%25/g; s/\r//g' | awk '{printf "%s%%0A", $0}'; }
if [ "$anr" = yes ]; then
  echo "::warning title=Android smoke test: ANR on first launch::$(echo "$anrs" | enc)"
fi
if [ "$alive" = yes ] && [ "$started" = yes ] && [ "$crashed" = no ]; then
  echo "::notice title=Android smoke test passed::$summary"
  exit 0
fi
echo "::error title=Android smoke test failed ($summary)::$( { echo "CRASHES:"; echo "$crashes"; echo "ANR:"; echo "$anrs"; echo "PS: $ps_line"; echo "TAIL:"; echo "$log" | grep -E "$pkg|AndroidRuntime|DEBUG|Bifrost" | tail -25; } | enc)"
exit 1
