#!/usr/bin/env bash
# Build an embedded-JS APK for a disposable local Android review, never distribution.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm --filter @rakazo/mobile exec expo prebuild --platform android --no-install
# Match the local HTTP fixture used in CI, and prevent published OTA code from
# replacing the exact bundle under review. Only generated ignored files change.
git check-ignore -q apps/mobile/android/app/src/main/AndroidManifest.xml
python3 - <<'PY'
from pathlib import Path
import xml.etree.ElementTree as ET
path = Path('apps/mobile/android/app/src/main/AndroidManifest.xml')
android = 'http://schemas.android.com/apk/res/android'
ET.register_namespace('android', android)
tree = ET.parse(path)
app = tree.getroot().find('application')
assert app is not None
app.set(f'{{{android}}}usesCleartextTraffic', 'true')
updates = [n for n in app.findall('meta-data') if n.get(f'{{{android}}}name') == 'expo.modules.updates.ENABLED']
assert len(updates) == 1
updates[0].set(f'{{{android}}}value', 'false')
tree.write(path, encoding='utf-8', xml_declaration=True)
PY
cd apps/mobile/android
./gradlew app:assembleRelease \
  -PreactNativeArchitectures="${ANDROID_REVIEW_ARCH:-arm64-v8a}" \
  '-Dorg.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1g' \
  --max-workers=4 --no-daemon
