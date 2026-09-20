#!/usr/bin/env bash
# Run a Maestro flow in one disposable simulator against an already built app.
set -euo pipefail
cd "$(dirname "$0")/.."
flow="${1:?Pass a Maestro flow path}"
shift
report_dir="$PWD/test-report/deskazo-v1/${IOS_FLOW_REPORT:-native-interaction}"
app_path="$PWD/test-report/deskazo-v1/mobile-ios-build/Build/Products/Release-iphonesimulator/Deskazo.app"
maestro_bin="${MAESTRO_BIN:-maestro}"
[[ -d "$app_path" ]] || { printf '%s\n' 'Build the iOS simulator app first.' >&2; exit 1; }
mkdir -p "$report_dir"
shasum -a 256 "$app_path/Deskazo" "$app_path/main.jsbundle" > "$report_dir/app.sha256"
device_id="$(xcrun simctl create "Deskazo flow verification $(uuidgen)" \
  com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro \
  com.apple.CoreSimulator.SimRuntime.iOS-26-4)"
cleanup() {
  xcrun simctl shutdown "$device_id" >/dev/null 2>&1 || true
  xcrun simctl delete "$device_id"
}
trap cleanup EXIT
printf '%s\n' "$device_id" > "$report_dir/simulator-id.txt"
xcrun simctl boot "$device_id"
xcrun simctl bootstatus "$device_id" -b
xcrun simctl install "$device_id" "$app_path"
installed_app_path="$(xcrun simctl get_app_container "$device_id" com.rakazo.app app)"
shasum -a 256 "$installed_app_path/Deskazo" "$installed_app_path/main.jsbundle" > "$report_dir/installed-app.sha256"
cmp "$app_path/Deskazo" "$installed_app_path/Deskazo"
cmp "$app_path/main.jsbundle" "$installed_app_path/main.jsbundle"
MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true \
  "$maestro_bin" --device "$device_id" test --no-ansi \
  --debug-output "$report_dir/debug" --test-output-dir "$report_dir" \
  --format JUNIT --output "$report_dir/results.xml" "$@" "$flow"
