#!/usr/bin/env bash
# Capture a built app in a disposable simulator. Inspect the PNG to verify the UI.
set -euo pipefail
cd "$(dirname "$0")/.."
report_dir="$PWD/test-report/deskazo-v1"
app_path="$report_dir/mobile-ios-build/Build/Products/Release-iphonesimulator/Deskazo.app"
[[ -d "$app_path" ]] || { printf '%s\n' 'Run VERIFY_IOS_BUILD=1 bash scripts/verify-mobile-readiness.sh first.' >&2; exit 1; }
mkdir -p "$report_dir/checks"
device_id="$(xcrun simctl create "Deskazo verification $(uuidgen)" \
  com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro \
  com.apple.CoreSimulator.SimRuntime.iOS-26-4)"
cleanup() {
  xcrun simctl shutdown "$device_id" >/dev/null 2>&1 || true
  xcrun simctl delete "$device_id"
}
trap cleanup EXIT
xcrun simctl boot "$device_id"
xcrun simctl bootstatus "$device_id" -b
xcrun simctl install "$device_id" "$app_path"
xcrun simctl launch "$device_id" com.rakazo.app
sleep 5
xcrun simctl spawn "$device_id" launchctl list > "$report_dir/checks/mobile-readiness-processes.log"
awk '$3 ~ /^UIKitApplication:com\.rakazo\.app/ && $1 ~ /^[0-9]+$/ { found=1 } END { exit !found }' \
  "$report_dir/checks/mobile-readiness-processes.log"
xcrun simctl io "$device_id" screenshot "$report_dir/checks/mobile-readiness-launch.png"
printf '%s\n' 'App is running. Inspect test-report/deskazo-v1/checks/mobile-readiness-launch.png.'
