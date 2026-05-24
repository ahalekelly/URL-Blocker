# iOS Build, Sign, and Install Guide

This guide builds a device IPA for the iOS containing app and Safari Web Extension, signs it with a UDID Registrations certificate, and installs it on the registered iPhone.

Do not commit signing files, order links, transaction ids, passwords, temporary keychains, or signed `.ipa` files. This repo is public. Keep durable signing assets outside the repo and use `/tmp` only for rebuildable scratch files.

The current UDID Registrations account is Silver, not Platinum. Use the local signing flow in this guide. Online signing is not expected to work for this account.

# Prerequisites

- Xcode and the Xcode command line tools.
- A UDID Registrations Silver account with the iPhone UDID registered.
- The reusable iOS `Development.p12` from UDID Registrations.
- The URL Blocker `Development.mobileprovision` from UDID Registrations.
- The `.p12` password from UDID Registrations.

# Download Signing Assets

Download signing assets from the UDID Registrations order page. Do not paste the private order URL or transaction id into committed files.

Save the files here:

```text
$HOME/Documents/UDIDRegistrations/iOSSigning/Development.p12
$HOME/Documents/UDIDRegistrations/iOSSigning/Development.mobileprovision
```

Save the `.p12` password outside the repo so `make ios-install` can read it non-interactively:

```text
$HOME/Documents/UDIDRegistrations/iOSSigning/Development.p12.password
```

Keep that file out of git and restrict it to your user:

```sh
chmod 600 "$HOME/Documents/UDIDRegistrations/iOSSigning/Development.p12.password"
```

For one-off runs, set `P12_PASSWORD` instead. `make ios-build` and `make ios-install` do not prompt for the password.

Run from the repo root, then set local shell variables for the guide commands:

```sh
SIGNING_ASSETS="$HOME/Documents/UDIDRegistrations/iOSSigning"
REPO_ROOT="$(pwd)"
```

The `.p12` certificate is reusable for iOS signing. The `.mobileprovision` and bundle/app-group values below are specific to this URL Blocker app id.

# Fast Path

Use the detailed sections below when troubleshooting. The normal command-line flow is:

```sh
make ios-install
```

That target builds `build/URLBlockerIOS-signed.ipa` with UDID Registrations signing, then installs it on the connected iPhone. To build the signed IPA without installing it:

```sh
make ios-build
```

The target does this:

1. Download `Development.p12` and `Development.mobileprovision` to `$HOME/Documents/UDIDRegistrations/iOSSigning`.
2. Inspect the provisioning profile and confirm the app id, team id, app group, and iPhone UDID.
3. Copy the repo to `/tmp/urlblocker_signing/source/URL-Blocker`.
4. In that temporary copy, replace the iOS bundle ids, team id, and app group with the UDID Registrations values.
5. Build unsigned with `CODE_SIGNING_ALLOWED=NO`.
6. Import the `.p12` into a temporary keychain.
7. Embed the `.mobileprovision`, sign the extension, sign the app, and package `build/URLBlockerIOS-signed.ipa`.
8. Install with Apple Configurator or `devicectl`.
9. Verify the installed bundle id, restore the keychain search list, and delete scratch files.

# Current Signing Values

The UDID Registrations profile used for the latest local signing run contained these URL Blocker values:

```text
TEAM_ID=W9MKY6Q657
APP_ID=app.black7278.turnip7125
EXTENSION_ID=app.black7278.turnip7125.Extension
APP_GROUP=group.d944b664533a4c2f.1
```

If UDID Registrations issues a new profile, inspect it and use the new values:

```sh
openssl smime -inform der -verify -noverify \
  -in "$SIGNING_ASSETS/Development.mobileprovision" \
  -out /tmp/urlblocker_profile.plist

/usr/libexec/PlistBuddy -c "Print :TeamIdentifier:0" /tmp/urlblocker_profile.plist
/usr/libexec/PlistBuddy -c "Print :Entitlements:application-identifier" /tmp/urlblocker_profile.plist
/usr/libexec/PlistBuddy -c "Print :Entitlements:com.apple.security.application-groups" /tmp/urlblocker_profile.plist
/usr/libexec/PlistBuddy -c "Print :ProvisionedDevices" /tmp/urlblocker_profile.plist
```

The current profile lists multiple app groups. URL Blocker uses `group.d944b664533a4c2f.1` to preserve the existing installed app's shared storage. Do not switch to another listed app group unless you are intentionally migrating storage.

# Prepare a Signing Copy

`make ios-build` handles this section. These commands are the manual fallback.

UDID Registrations signs against its generated app id, not the project defaults. Build from a temporary copy so the repo stays clean.

```sh
rm -rf /tmp/urlblocker_signing
mkdir -p /tmp/urlblocker_signing/source
rsync -a --exclude .git ./ /tmp/urlblocker_signing/source/URL-Blocker/
cd /tmp/urlblocker_signing/source/URL-Blocker
```

In the temporary copy, update these values:

- `URLBlocker.xcodeproj/project.pbxproj`
  - iOS app `DEVELOPMENT_TEAM` to `W9MKY6Q657`
  - iOS extension `DEVELOPMENT_TEAM` to `W9MKY6Q657`
  - iOS app `PRODUCT_BUNDLE_IDENTIFIER` to `app.black7278.turnip7125`
  - iOS extension `PRODUCT_BUNDLE_IDENTIFIER` to `app.black7278.turnip7125.Extension`
- `URLBlockerIOS/ContentView.swift`
  - `Safari.extensionBundleIdentifier` to `app.black7278.turnip7125.Extension`
- `URLBlockerShared/NativeBlocklistStore.swift`
  - `appGroupIdentifier` to `group.d944b664533a4c2f.1`
- `URLBlockerIOS/URLBlockerIOS.entitlements`
  - app group to `group.d944b664533a4c2f.1`
- `URLBlockerIOSExtension/URLBlockerIOSExtension.entitlements`
  - app group to `group.d944b664533a4c2f.1`

# Build the App Bundle

`make ios-build` handles this section. The manual command builds an unsigned device app bundle:

```sh
xcodebuild \
  -project URLBlocker.xcodeproj \
  -scheme URLBlockerIOS \
  -configuration Release \
  -sdk iphoneos \
  -destination generic/platform=iOS \
  -derivedDataPath /tmp/urlblocker_signing_build \
  CODE_SIGNING_ALLOWED=NO \
  COMPILATION_CACHE_ENABLE_CACHING=YES \
  build
```

The built app should be here:

```text
/tmp/urlblocker_signing_build/Build/Products/Release-iphoneos/URLBlockerIOS.app
```

If `actool` or Xcode cannot start because the selected iOS platform is unavailable, install the matching iOS platform runtime:

```sh
xcodebuild -downloadPlatform iOS
```

This can be required even for a physical-device `iphoneos` build because asset catalog compilation uses Xcode's selected iOS platform.

# Create Signing Entitlements

`make ios-build` handles this section. For a manual signing run, create `/tmp/urlblocker_signing/entitlements.plist` using values from the provisioning profile:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>application-identifier</key>
	<string>W9MKY6Q657.app.black7278.turnip7125</string>
	<key>com.apple.developer.team-identifier</key>
	<string>W9MKY6Q657</string>
	<key>com.apple.security.application-groups</key>
	<array>
		<string>group.d944b664533a4c2f.1</string>
	</array>
	<key>get-task-allow</key>
	<true/>
	<key>keychain-access-groups</key>
	<array>
		<string>W9MKY6Q657.*</string>
	</array>
</dict>
</plist>
```

# Import the Certificate

`make ios-build` handles this section and reads the `.p12` password from `P12_PASSWORD` or `Development.p12.password`. For a manual signing run, use a temporary keychain instead of importing into the login keychain:

```sh
mkdir -p /tmp/urlblocker_signing

security create-keychain -p urlblocker /tmp/urlblocker_signing/signing.keychain-db
security unlock-keychain -p urlblocker /tmp/urlblocker_signing/signing.keychain-db
security set-keychain-settings -lut 21600 /tmp/urlblocker_signing/signing.keychain-db

P12_PASSWORD="$(cat "$SIGNING_ASSETS/Development.p12.password")"

security import "$SIGNING_ASSETS/Development.p12" \
  -k /tmp/urlblocker_signing/signing.keychain-db \
  -P "$P12_PASSWORD" \
  -T /usr/bin/codesign \
  -T /usr/bin/security

security set-key-partition-list \
  -S apple-tool:,apple: \
  -s \
  -k urlblocker \
  /tmp/urlblocker_signing/signing.keychain-db
```

Make the temporary keychain visible to `codesign`:

```sh
security list-keychains -d user -s \
  /tmp/urlblocker_signing/signing.keychain-db \
  ~/Library/Keychains/login.keychain-db

security find-identity -v -p codesigning
```

Use the identity hash printed for `iPhone Developer: Created via API (...)`.

Do not use `-allowProvisioningUpdates` or automatic Apple signing for this flow. UDID Registrations signing must use the downloaded local certificate and provisioning profile.

# Sign and Package

`make ios-build` handles this section. For a manual signing run, set the identity hash:

```sh
IDENTITY_HASH=954D99D17036F84F30F655128FB9B87560F87630
```

Prepare a clean payload:

```sh
SIGNED_DIR=/tmp/urlblocker_signed
rm -rf "$SIGNED_DIR"
mkdir -p "$SIGNED_DIR/Payload"

ditto \
  /tmp/urlblocker_signing/build/Build/Products/Release-iphoneos/URLBlockerIOS.app \
  "$SIGNED_DIR/Payload/URLBlockerIOS.app"

cp "$SIGNING_ASSETS/Development.mobileprovision" \
  "$SIGNED_DIR/Payload/URLBlockerIOS.app/embedded.mobileprovision"
```

Sign the extension first, then the containing app:

```sh
codesign -f \
  -s "$IDENTITY_HASH" \
  --generate-entitlement-der \
  --entitlements /tmp/urlblocker_signing/entitlements.plist \
  "$SIGNED_DIR/Payload/URLBlockerIOS.app/PlugIns/URLBlockerIOSExtension.appex"

codesign -f \
  -s "$IDENTITY_HASH" \
  --generate-entitlement-der \
  --entitlements /tmp/urlblocker_signing/entitlements.plist \
  "$SIGNED_DIR/Payload/URLBlockerIOS.app"
```

Verify the signature:

```sh
codesign -v --strict --deep "$SIGNED_DIR/Payload/URLBlockerIOS.app"
```

Package the IPA:

```sh
mkdir -p "$REPO_ROOT/build"
cd "$SIGNED_DIR"
zip -qry -X "$REPO_ROOT/build/URLBlockerIOS-signed.ipa" Payload
```

Restore the normal keychain search list:

```sh
security list-keychains -d user -s ~/Library/Keychains/login.keychain-db
```

# Install on the iPhone

The most reliable install path is Apple Configurator:

1. Connect the registered iPhone with USB.
2. Open Apple Configurator.
3. Select the iPhone.
4. Choose `Add > Apps > Choose from my Mac`.
5. Select `build/URLBlockerIOS-signed.ipa`.
6. Wait for the install to finish.

After installing:

1. Open `URL Blocker` once.
2. Open iOS Settings.
3. Go to `Safari > Extensions`.
4. Enable `URL Blocker`.
5. Allow website access for the sites you want the blocker to control.

## Command-Line Install

Apple Configurator is not required. `make ios-install` builds the signed IPA and installs it with Xcode's `devicectl`:

```sh
make ios-devices
make ios-install
```

`make ios-install` auto-detects one iPhone from Xcode's device list. If more than one iPhone is available, pass `DEVICE` with the iPhone name, UDID, serial number, or ECID printed by `make ios-devices`:

```sh
make ios-install DEVICE="My iPhone"
```

To rebuild the signed IPA without installing it:

```sh
make ios-build
```

The raw commands are:

```sh
device=$(node scripts/connected-iphone.mjs)
install_dir=$(mktemp -d /tmp/urlblocker_ios_install.XXXXXX)
unzip -q build/URLBlockerIOS-signed.ipa -d "$install_dir"
xcrun devicectl device install app \
  --device "$device" \
  "$install_dir/Payload/URLBlockerIOS.app"
```

Keep the iPhone connected by USB, unlocked, and trusted by the Mac. If the install succeeds but the app will not open, enable Developer Mode on the iPhone under `Settings > Privacy & Security > Developer Mode`.

## Device Identifiers

UDID Registrations profiles use the iPhone's hardware UDID, such as `00008140-...`. The profile must include that hardware UDID or the app will not install on the phone.

`devicectl list devices` may show a different CoreDevice identifier, such as `E9E787F0-...`. Use the identifier printed by `devicectl` for `--device` commands when it is available. That identifier does not replace the hardware UDID in the provisioning profile.

After an iOS update, prepare device support before installing:

```sh
xcodebuild -prepareDeviceSupport \
  -platform iOS \
  -osVersion 26.5 \
  -architecture arm64e
```

Check device support services if install hangs or reports a missing developer disk image:

```sh
xcrun devicectl device info ddiServices --device "$device"
```

Wi-Fi pairing can work when the phone is paired, awake, unlocked, and reachable on the same network. USB is more reliable for installs.

If an accidental automatic-signing build was installed, remove that separate bundle after the UDID-signed app is installed:

```sh
xcrun devicectl device uninstall app \
  --device "$device" \
  com.akelly.URLBlockerIOS
```

# Final Verification

Before and after installing, verify the signed bundle:

```sh
/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" \
  "$SIGNED_DIR/Payload/URLBlockerIOS.app/Info.plist"

/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" \
  "$SIGNED_DIR/Payload/URLBlockerIOS.app/PlugIns/URLBlockerIOSExtension.appex/Info.plist"

codesign -v --strict --deep "$SIGNED_DIR/Payload/URLBlockerIOS.app"

codesign -d --entitlements :- \
  "$SIGNED_DIR/Payload/URLBlockerIOS.app" \
  >/tmp/urlblocker_app_entitlements.plist \
  2>/dev/null

codesign -d --entitlements :- \
  "$SIGNED_DIR/Payload/URLBlockerIOS.app/PlugIns/URLBlockerIOSExtension.appex" \
  >/tmp/urlblocker_extension_entitlements.plist \
  2>/dev/null

plutil -p /tmp/urlblocker_app_entitlements.plist
plutil -p /tmp/urlblocker_extension_entitlements.plist
```

Expected values:

- App bundle id: `app.black7278.turnip7125`
- Extension bundle id: `app.black7278.turnip7125.Extension`
- Team id: `W9MKY6Q657`
- App group: `group.d944b664533a4c2f.1`
- Profile devices include the iPhone hardware UDID.
- Installed app check: `xcrun devicectl device info apps --device "$device" --bundle-id app.black7278.turnip7125`
- Wrong auto-signed app check: `xcrun devicectl device info apps --device "$device" --bundle-id com.akelly.URLBlockerIOS` should show no installed apps.

# Cleanup

Keep the reusable signing assets in `$HOME/Documents/UDIDRegistrations/iOSSigning`. Everything else in the signing flow is rebuildable.

```sh
security list-keychains -d user -s ~/Library/Keychains/login.keychain-db
rm -rf /tmp/urlblocker_signing
rm -rf /tmp/urlblocker_signed
rm -rf /tmp/urlblocker_ios_install.*
```

`build/URLBlockerIOS-signed.ipa` is ignored by git. Keep it if you want a local reinstall artifact; delete it if you want a fully clean workspace.

# Online Signing

Do not use online signing for the current account. UDID Registrations online signing requires Platinum; this account is Silver. If an online signer says `No active registration`, that is expected. Use the local certificate/profile flow above.

# macOS Safari Extension Signing

The macOS app and Safari Web Extension are signed with the local Apple Development certificate. The Mac app and extension targets use team `T3TBGN4UX7` in `URLBlocker.xcodeproj/project.pbxproj`.

Build a locally signed macOS app:

```sh
xcodebuild \
  -project URLBlocker.xcodeproj \
  -scheme URLBlockerMac \
  -configuration Release \
  -sdk macosx \
  -destination generic/platform=macOS \
  -derivedDataPath /tmp/urlblocker_macos_build \
  COMPILATION_CACHE_ENABLE_CACHING=YES \
  CODE_SIGN_IDENTITY="Apple Development" \
  build
```

If Xcode says `No signing certificate "Mac Development" found`, keep the `CODE_SIGN_IDENTITY="Apple Development"` override. Confirm the local Apple Development identity with:

```sh
security find-identity -v -p codesigning
```

The built app should be here:

```text
/tmp/urlblocker_macos_build/Build/Products/Release/URLBlockerMac.app
```

Install the signed app:

```sh
ditto \
  /tmp/urlblocker_macos_build/Build/Products/Release/URLBlockerMac.app \
  /Applications/URLBlockerMac.app
```

Xcode registers the temporary build product with PluginKit. After copying the app to `/Applications`, remove that temporary registration so Safari resolves the installed app:

```sh
pluginkit -r \
  /tmp/urlblocker_macos_build/Build/Products/Release/URLBlockerMac.app/Contents/PlugIns/URLBlockerMacExtension.appex

/System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister \
  -f \
  -R \
  -trusted \
  /Applications/URLBlockerMac.app
```

Verify the app and embedded extension signatures:

```sh
codesign --verify --strict --deep --verbose=4 \
  /Applications/URLBlockerMac.app

codesign -dv --verbose=4 \
  /Applications/URLBlockerMac.app

codesign -dv --verbose=4 \
  /Applications/URLBlockerMac.app/Contents/PlugIns/URLBlockerMacExtension.appex
```

Expected signature details:

- `Authority=Apple Development: ahalekelly@gmail.com (...)`
- `TeamIdentifier=T3TBGN4UX7`

If `codesign` reports `CSSMERR_TP_NOT_TRUSTED` from a sandboxed shell, rerun the verification outside the sandbox. The sandbox can hide the normal keychain search list from trust evaluation.

Verify PluginKit can see the Safari extension:

```sh
pluginkit -m -A -D -vvv -p com.apple.Safari.web-extension
```

Expected output includes one `com.akelly.URLBlockerMac.Extension` entry whose path is:

```text
/Applications/URLBlockerMac.app/Contents/PlugIns/URLBlockerMacExtension.appex
```

Open Safari, choose `Safari > Settings > Extensions`, and verify that `URL Blocker` appears in the installed extensions list. A correctly Apple Development-signed build does not need Safari's `Allow unsigned extensions` setting. Only use that Safari setting for unsigned or `Sign to Run Locally` builds.

# macOS Safari Extension Smoke Test

After installing the signed macOS app:

1. Open `/Applications/URLBlockerMac.app`.
2. Open Safari.
3. In the macOS app, click `Open Blocklist Settings`. Safari should open the extension's blocklist editor.
4. In the macOS app, click `Open Extension Settings`. If Safari cannot open the settings pane automatically, use `Safari > Settings > Extensions > URL Blocker`.
5. Open the URL Blocker toolbar item in Safari. If website access is missing, the blocklist editor should ask for website access and list the sites that need access.
6. After choosing `Always Allow`, reload the blocklist editor. The editor should be visible, and the website access prompt should be hidden.

After finishing changes and before committing, run `npm test` and the signed iOS build with `make ios-build`. Do not use `make ios-build-unsigned` as the final pre-commit iOS build because it does not exercise the signed install lane. iOS and macOS share the extension JavaScript, CSS, HTML, and native request handler.

The UDID Registrations certificate was tested against the macOS app and Safari Web Extension target, but it is not usable for this project on macOS:

- Standard verification outside the temporary signing keychain context reported `CSSMERR_TP_NOT_TRUSTED`.
- Gatekeeper assessment with `spctl` did not accept the app as a normal trusted macOS app.
- PluginKit did not register the temporary signed extension as a usable replacement for the existing installed macOS extension.

Treat the UDID Registrations certificate as iOS-only for this project.

Apple Development signing is for local development and Safari extension registration. Gatekeeper distribution requires a Developer ID Application certificate and notarization. Safari 18.4 and later can load Developer ID-signed and notarized Safari Web Extensions.
