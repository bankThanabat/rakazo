#!/usr/bin/env bash
# Install two simulator builds over the same local session, without uninstalling.
# Start the disposable native-review server first, then pass its synthetic login.
set -euo pipefail
cd "$(dirname "$0")/.."
old_app="${1:?Pass the previous simulator .app path}"
new_app="${2:?Pass the new simulator .app path}"
shift 2
report="$PWD/test-report/deskazo-v1/product-name-upgrade"
mkdir -p "$report"
: > "$report/builds.sha256"
for app_path in "$old_app" "$new_app"; do
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app_path/Info.plist")" == 'com.rakazo.app' ]]
  executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app_path/Info.plist")"
  shasum -a 256 "$app_path/$executable" "$app_path/main.jsbundle" >> "$report/builds.sha256"
done
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$new_app/Info.plist")" == 'Deskazo' ]]
device="$(xcrun simctl create "Deskazo upgrade verification $(uuidgen)" \
  com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro \
  com.apple.CoreSimulator.SimRuntime.iOS-26-4)"
cleanup() {
  xcrun simctl shutdown "$device" >/dev/null 2>&1 || true
  xcrun simctl delete "$device"
}
trap cleanup EXIT
printf '%s\n' "$device" > "$report/simulator-id.txt"
xcrun simctl boot "$device"
xcrun simctl bootstatus "$device" -b
for phase in before after; do
  app_path="$old_app"
  [[ "$phase" == before ]] || app_path="$new_app"
  xcrun simctl install "$device" "$app_path"
  installed="$(xcrun simctl get_app_container "$device" com.rakazo.app app)"
  executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app_path/Info.plist")"
  cmp "$app_path/$executable" "$installed/$executable"
  cmp "$app_path/main.jsbundle" "$installed/main.jsbundle"
  MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true \
    "${MAESTRO_BIN:-maestro}" --device "$device" test --no-ansi \
    --debug-output "$report/$phase/debug" --test-output-dir "$report/$phase" \
    --format JUNIT --output "$report/$phase/results.xml" "$@" \
    "apps/mobile/.maestro/product-upgrade-$phase.yaml"
done
