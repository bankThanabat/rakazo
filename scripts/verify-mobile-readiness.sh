#!/usr/bin/env bash
# Check supported dependencies, native JS bundles, and optionally an ad-hoc iOS simulator build.
set -euo pipefail
cd "$(dirname "$0")/.."
report_dir="$PWD/test-report/deskazo-v1"
mkdir -p "$report_dir/checks"
run_check() {
  local phase="$1"
  shift
  "$@" > "$report_dir/checks/mobile-readiness-${phase}.log" 2>&1
}
run_check check pnpm --filter @rakazo/mobile check
run_check unit pnpm exec vitest run apps/mobile/lib apps/mobile/components
run_check bundle pnpm --filter @rakazo/mobile exec expo export \
  --platform ios --platform android --output-dir "$report_dir/mobile-bundle"
if [[ "${VERIFY_IOS_BUILD:-0}" == "1" ]]; then
  # Uses an existing Expo prebuild; does not regenerate or clean native project files.
  (cd apps/mobile/ios && run_check pods pod install)
  run_check ios xcodebuild \
    -workspace apps/mobile/ios/Deskazo.xcworkspace -scheme Deskazo \
    -configuration Release -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' -jobs 4 \
    -derivedDataPath "$report_dir/mobile-ios-build" CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- build
fi
printf '%s\n' 'Mobile readiness checks passed.'
