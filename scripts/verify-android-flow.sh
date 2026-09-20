#!/usr/bin/env bash
# Run a native flow in a new, headless emulator; leave existing devices untouched.
# Requires an installed SDK/system image, review APK, Maestro, and native-review server.
set -euo pipefail
cd "$(dirname "$0")/.."
flow="${1:?Pass a Maestro flow path}"
shift
sdk="${ANDROID_HOME:?Set ANDROID_HOME to the installed SDK}"
adb="$sdk/platform-tools/adb"
manager="$sdk/cmdline-tools/latest/bin/avdmanager"
reset_bars="${ANDROID_SYSTEM_BAR_RESET:-1}"
[[ "$reset_bars" == 0 || "$reset_bars" == 1 ]] || { printf '%s\n' 'ANDROID_SYSTEM_BAR_RESET must be 0 or 1.' >&2; exit 1; }
report_name="${ANDROID_FLOW_REPORT:-android-native-flow}"
[[ "$report_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || { printf '%s\n' 'Use a report directory name, not a path.' >&2; exit 1; }
report="$PWD/test-report/deskazo-v1/$report_name"
apk="$PWD/apps/mobile/android/app/build/outputs/apk/release/app-release.apk"
[[ -f "$apk" ]] || { printf '%s\n' 'Build the review APK first.' >&2; exit 1; }
# A new attempt gets a new name so old screenshots cannot validate a retry.
mkdir "$report"
name="deskazo-review-$(uuidgen | tr '[:upper:]' '[:lower:]')"
port="$(python3 - <<'PY'
import socket
for port in range(5580, 5682, 2):
    with socket.socket() as console, socket.socket() as adb:
        try:
            console.bind(('127.0.0.1', port))
            adb.bind(('127.0.0.1', port + 1))
        except OSError:
            continue
        print(port)
        break
else:
    raise SystemExit('No free emulator port pair')
PY
)"
serial="emulator-$port"
system_image="${ANDROID_REVIEW_IMAGE:-system-images;android-36;google_apis_playstore;arm64-v8a}"
emulator_pid=""
cleanup() {
  local flow_exit=$?
  if [[ -n "$emulator_pid" ]]; then
    kill "$emulator_pid" 2>/dev/null || true
    wait "$emulator_pid" 2>/dev/null || true
  fi
  "$manager" delete avd --name "$name" >> "$report/cleanup.log" 2>&1 || true
  return "$flow_exit"
}
trap cleanup EXIT
printf '%s\n' "$name" > "$report/avd-name.txt"
printf '%s\n' "$serial" > "$report/serial.txt"
printf '%s\n' "$system_image" > "$report/system-image.txt"
printf '%s\n' "$reset_bars" > "$report/system-bar-reset.txt"
"$adb" version > "$report/platform-tools.txt"
"$sdk/emulator/emulator" -version > "$report/emulator-version.txt" 2>&1
java -version > "$report/java-version.txt" 2>&1
MAESTRO_CLI_NO_ANALYTICS=1 "${MAESTRO_BIN:-maestro}" --version > "$report/maestro-version.txt" 2>&1
shasum -a 256 "$apk" > "$report/app.sha256"
printf 'no\n' | "$manager" create avd --name "$name" --path "$report/avd" \
  --package "$system_image" \
  --device pixel_6 > "$report/avd-create.log" 2>&1
"$sdk/emulator/emulator" -avd "$name" -port "$port" -no-window -no-audio \
  -no-snapshot -no-boot-anim -gpu swiftshader_indirect -memory 4096 \
  -camera-back none -camera-front none > "$report/emulator.log" 2>&1 &
emulator_pid=$!
booted=false
for ((attempt=0; attempt<180; attempt++)); do
  kill -0 "$emulator_pid" 2>/dev/null || { tail -n 20 "$report/emulator.log"; exit 1; }
  if [[ "$("$adb" -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; then
    booted=true
    break
  fi
  sleep 1
done
[[ "$booted" == true ]] || { printf '%s\n' 'Emulator did not boot in time.' >&2; exit 1; }
# Refuse to install into another device if the selected port was taken during boot.
[[ "$("$adb" -s "$serial" emu avd name | head -n 1 | tr -d '\r')" == "$name" ]]
"$adb" -s "$serial" shell settings put global window_animation_scale 0
"$adb" -s "$serial" shell settings put global transition_animation_scale 0
"$adb" -s "$serial" shell settings put global animator_duration_scale 0
"$adb" -s "$serial" install "$apk"
installed_apk="$("$adb" -s "$serial" shell pm path com.rakazo.app | sed -n 's/^package://p' | tr -d '\r')"
[[ "$installed_apk" == /data/app/*/base.apk && "$installed_apk" != *$'\n'* ]]
"$adb" -s "$serial" shell sha256sum "$installed_apk" > "$report/installed-app.sha256"
[[ "$(awk '{print $1}' "$report/app.sha256")" == "$(awk '{print $1}' "$report/installed-app.sha256")" ]]
"$adb" -s "$serial" reverse tcp:3213 tcp:3213
"$adb" -s "$serial" shell dumpsys package com.rakazo.app > "$report/package.txt"
# Refresh a fresh emulator's stale status-bar size before judging app rendering.
# Keep the cutout enabled. The opt-out exists only to reproduce the emulator bug.
if [[ "$reset_bars" == 1 ]]; then
  mkdir "$report/preflight"
  MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true \
    "${MAESTRO_BIN:-maestro}" --device "$serial" test --no-ansi \
    --debug-output "$report/preflight/debug" --test-output-dir "$report/preflight" \
    --format JUNIT --output "$report/preflight/results.xml" \
    apps/mobile/.maestro/android-emulator-ready.yaml
  "$adb" -s "$serial" shell dumpsys window > "$report/preflight/window.txt"
  "$adb" -s "$serial" shell dumpsys display > "$report/preflight/display.txt"
  python3 scripts/verify-android-system-bars.py "$report/preflight"
fi
set +e
MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true \
  "${MAESTRO_BIN:-maestro}" --device "$serial" test --no-ansi \
  --debug-output "$report/debug" --test-output-dir "$report" \
  --format JUNIT --output "$report/results.xml" "$@" "$flow"
result=$?
set -e
"$adb" -s "$serial" logcat -d > "$report/android.log" 2>&1 || true
"$adb" -s "$serial" shell dumpsys window > "$report/window.txt" 2>&1 || true
"$adb" -s "$serial" shell dumpsys display > "$report/display.txt" 2>&1 || true
"$adb" -s "$serial" exec-out screencap -p > "$report/adb-screen.png" || true
exit "$result"
