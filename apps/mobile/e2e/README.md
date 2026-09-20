# Mobile emulator smoke test

This opt-in [Maestro](https://maestro.mobile.dev/) flow exercises sign-in, bot creation,
thread messaging, and computer takeover/release on a real Android emulator or iOS simulator. It
expects a running Rakazo stack and deliberately stays out of ordinary pull-request CI.

## Prerequisites

1. Install the Maestro CLI and start an Android emulator or iOS simulator.
2. Start Rakazo's database, API, worker, and sandbox supervisor. The computer portion requires a
   working sandbox provider (the normal local Docker provider is sufficient).
3. Create a disposable test account through the mobile or web sign-up screen. Never use a
   production account or put credentials in this repository.
4. Build/install the native app with an API URL that the emulator can reach. For the standard local
   ports, use `http://10.0.2.2:3100` on the Android emulator and `http://127.0.0.1:3100` on the iOS
   simulator. For example:

   ```sh
   EXPO_PUBLIC_API_URL=http://10.0.2.2:3100 pnpm --filter @rakazo/mobile android
   ```

## Run

Pass all fixture values at invocation time so credentials never land in source control:

```sh
pnpm --filter @rakazo/mobile test:e2e -- \
  -e RAKAZO_E2E_EMAIL=mobile-smoke@example.test \
  -e RAKAZO_E2E_PASSWORD='replace-with-the-disposable-password' \
  -e RAKAZO_E2E_BOT_NAME=MaestroSmoke-001 \
  -e RAKAZO_E2E_MESSAGE=mobile-smoke-message
```

Use a new bot name for each run if the backing database is persistent. `clearState` resets the app's
local session and endpoint data; it does not delete server-side bots.

The shared sign-in flow starts on the fresh-install sign-up screen. Pass
`-e RAKAZO_E2E_SERVER=http://127.0.0.1:3213` to select a test server through the app
before signing in. Omitting it keeps the bundled default endpoint.

## iOS account regression

Build the simulator app with `VERIFY_IOS_BUILD=1 bash scripts/verify-mobile-readiness.sh`.
The native build requires an existing Expo iOS prebuild and Xcode. Install the
[Maestro CLI](https://docs.maestro.dev/maestro-cli/how-to-install-maestro-cli) first,
or point `MAESTRO_BIN` to its executable.

In one terminal, start the disposable review server:

```sh
mkdir -p test-report/deskazo-v1/checks
pnpm exec tsx packages/testkit/src/cli/native-review.ts
```

Wait for its ready message, then run:

```sh
bash scripts/verify-ios-flow.sh apps/mobile/.maestro/account.yaml \
  -e RAKAZO_E2E_SERVER=http://127.0.0.1:3213 \
  -e RAKAZO_E2E_EMAIL=native-review@example.test \
  -e RAKAZO_E2E_PASSWORD=synthetic-review-password \
  -e RAKAZO_E2E_NEW_PASSWORD=synthetic-updated-password
```

This changes the synthetic account's password. Stop and restart the fixture
server before repeating the flow, including after a partially completed run.
Ctrl-C stops the server and removes its disposable database and files. The iOS
runner owns and removes its simulator even when a flow fails. It requires the
iPhone 17 Pro device type and iOS 26.4 runtime. Reports and screenshots go under
`test-report/deskazo-v1/native-interaction`; override `IOS_FLOW_REPORT` to retain
separate attempts. The account flow does not exercise a real provider or a
customer conversation.

## Merchant setup choices

With the disposable review server running, verify the first-run choices with:

```sh
IOS_FLOW_REPORT=merchant-onboarding-native bash scripts/verify-ios-flow.sh \
  apps/mobile/.maestro/onboarding.yaml \
  -e RAKAZO_E2E_SERVER=http://127.0.0.1:3213 \
  -e RAKAZO_E2E_EMAIL=native-review@example.test \
  -e RAKAZO_E2E_PASSWORD=synthetic-review-password
```

The flow creates a staff bot, selects Customer replies, and checks that the
business-context question survives relaunch. It uses the current simulator build;
rebuild after native source changes. This checks the conversation controls, not
model quality or live account setup. Restart the fixture server before repeating.

## Customer conversation regression

Start the same disposable server with its customer fixture:

```sh
pnpm exec tsx packages/testkit/src/cli/native-review.ts --customer
```

After the ready message, run:

```sh
IOS_FLOW_REPORT=native-customer bash scripts/verify-ios-flow.sh \
  apps/mobile/.maestro/customer.yaml \
  -e RAKAZO_E2E_SERVER=http://127.0.0.1:3213 \
  -e RAKAZO_E2E_EMAIL=native-review@example.test \
  -e RAKAZO_E2E_PASSWORD=synthetic-review-password
```

This exercises acknowledgement, assignment, private guidance, one staff reply,
handback, takeover and resolution through the native app. Stop the server after
the flow. In customer mode it verifies the persisted state before cleanup and
exits unsuccessfully if the journey is incomplete. Keep both the Maestro result
and the server exit result. The state report is
`test-report/deskazo-v1/checks/native-customer-state.json`.

Restart the server before another attempt. The web channel and customer are
synthetic, with automatic replies disabled. This does not establish model use of
guidance, prevention of an in-flight external send, or delivery to a real social
account. Those require their separate acceptance journeys.

## Long approval review

Start the disposable review server without `--customer`, then verify its retained
pending card before running the native flow:

```sh
python3 scripts/verify-native-approval.py pending
IOS_FLOW_REPORT=native-approval bash scripts/verify-ios-flow.sh \
  apps/mobile/.maestro/approval.yaml \
  -e RAKAZO_E2E_SERVER=http://127.0.0.1:3213 \
  -e RAKAZO_E2E_EMAIL=native-review@example.test \
  -e RAKAZO_E2E_PASSWORD=synthetic-review-password
python3 scripts/verify-native-approval.py denied
```

The native flow visits the beginning and end of each readable document version,
opens the complete request, visits its end and beginning, and denies it. The
conversation opens at the bottom of the latest message; the flow scrolls its
outer gutter to inspect the title, scope and conditions, and checks the heading's
long-press message menu before reviewing content. Inspect
the screenshots to confirm document endings and the final source field are painted;
a large accessibility text node can be detected while only part of it is visible.
The API verifier checks both document versions and compares the full retained
review hash before and after denial. Stop the fixture server afterward, and use a
fresh server for another attempt. This tests review navigation and denial, not
approval execution or provider writes.

## Disposable Android review

Install an Android SDK, Java 17, Maestro, and the API 36 Google Play arm64 system
image. Set `ANDROID_HOME` to the SDK directory and `JAVA_HOME` to Java 17, then
build from the repository root:

```sh
bash scripts/build-android-review.sh
```

This generates an ignored native project and builds an arm64 APK with embedded
JavaScript. Its generated manifest permits HTTP for the local fixture and disables
OTA updates. It is a review build, not a distribution artifact.

Create `test-report/deskazo-v1/checks` and start the disposable review server
described above. Use `--customer` when running
the customer flow, then run a flow with a fresh report name:

```sh
ANDROID_FLOW_REPORT=android-onboarding bash scripts/verify-android-flow.sh \
  apps/mobile/.maestro/onboarding.yaml \
  -e RAKAZO_E2E_SERVER=http://127.0.0.1:3213 \
  -e RAKAZO_E2E_EMAIL=native-review@example.test \
  -e RAKAZO_E2E_PASSWORD=synthetic-review-password
```

The runner creates and removes its own headless emulator. It verifies the AVD name
before installing, compares the installed APK hash, and forwards port 3213 to the
fixture server. Existing devices are untouched. Each report name must be new so a
retry cannot reuse old screenshots. Reports include Maestro results, screenshots,
APK hashes, tool versions, and Android logs. Set `MAESTRO_BIN` if needed.

Before the app flow, the runner rotates Android Settings and returns to portrait.
Fresh API 36 emulators can initially size the system status bar below their camera
cutout and clip glyphs in every app. The preflight keeps the cutout enabled and
checks the status-bar window height against its top inset. Its results live in
the report's `preflight` directory. The runner also saves final window/display
diagnostics and a direct ADB screenshot.

The offline system-bar comparison needs no fixture server or account:

```sh
ANDROID_FLOW_REPORT=android-system-bars bash scripts/verify-android-flow.sh \
  apps/mobile/.maestro/system-bars.yaml
python3 scripts/verify-android-system-bars.py \
  test-report/deskazo-v1/android-system-bars
```

For diagnosis only, set `ANDROID_SYSTEM_BAR_RESET=0` with a new report name to
compare the unprepared emulator. The geometry verifier should reject a clipped
63-pixel status-bar window with a 128-pixel cutout. It checks geometry, not every
rendered pixel or physical-device behavior. The rotation commands follow
[Maestro's orientation API](https://docs.maestro.dev/reference/commands-available/setorientation).

The account flow changes the fixture password, so run it last and supply
`RAKAZO_E2E_NEW_PASSWORD`. Restart the fixture before repeating a stateful flow.
Stop the server afterward and retain its customer-state assertion result when
using `--customer`. These checks use synthetic data; they do not prove signed
distribution, upgrades, physical-device behavior, or live account delivery.

## Screenshot catalog

Run **Actions → mobile Android screenshots → Run workflow** to build the app, seed an isolated fake
workspace, capture light and dark Android emulator views, upload diagnostics for seven days, and publish a
persistent gallery beside the Playwright reports.

## Display-name upgrade

Keep the previous simulator `.app` before generating the renamed native project.
Build Deskazo with the same bundle ID, then start the disposable review server:

```sh
pnpm exec tsx packages/testkit/src/cli/native-review.ts
```

In another terminal, run the upgrade check with both absolute `.app` paths and
the synthetic review account. The helper creates one simulator, signs in with the
old build, installs the new build over it, and opens the saved conversation without
signing in again. It verifies installed executable/bundle bytes and deletes the
simulator on exit. It never uninstalls the app between builds.

```sh
bash scripts/verify-ios-product-upgrade.sh /path/to/previous.app /path/to/Deskazo.app \
  -e RAKAZO_E2E_SERVER=http://127.0.0.1:3213 \
  -e RAKAZO_E2E_EMAIL=native-review@example.test \
  -e RAKAZO_E2E_PASSWORD=synthetic-review-password
```

Set `MAESTRO_BIN` and `JAVA_HOME` if those tools are not on the default path.
Stop the review server with Ctrl-C after the check to remove its disposable data.
This checks an ad-hoc simulator upgrade, not App Store distribution or physical
keychain behavior. Android and signed desktop upgrades need separate acceptance.
