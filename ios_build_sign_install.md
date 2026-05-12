# iOS Build, Sign, and Install Guide

This guide builds a device IPA for the iOS containing app and Safari Web Extension, signs it with a UDID Registrations certificate, and installs it on the registered iPhone.

Do not commit signing files. Keep `.p12`, `.mobileprovision`, temporary keychains, and signed `.ipa` files out of git. This repo already ignores `build/` and `*.ipa`.

The current UDID Registrations account is Silver, not Platinum. Use the local signing flow in this guide. Online signing is not expected to work for this account.

# Prerequisites

- Xcode and the Xcode command line tools.
- A UDID Registrations Silver account with the iPhone UDID registered.
- `Development.p12` from UDID Registrations.
- `Development.mobileprovision` from UDID Registrations.
- The `.p12` password from UDID Registrations. It is usually `123456`.

# Current Signing Values

The UDID Registrations profile used for the latest local signing run contained these values:

```text
TEAM_ID=W9MKY6Q657
APP_ID=app.black7278.turnip7125
EXTENSION_ID=app.black7278.turnip7125.Extension
APP_GROUP=group.d944b664533a4c2f.1
```

If UDID Registrations issues a new profile, inspect it and use the new values:

```sh
openssl smime -inform der -verify -noverify \
  -in Development.mobileprovision \
  -out profile.plist

/usr/libexec/PlistBuddy -c "Print :TeamIdentifier:0" profile.plist
/usr/libexec/PlistBuddy -c "Print :Entitlements:application-identifier" profile.plist
/usr/libexec/PlistBuddy -c "Print :Entitlements:com.apple.security.application-groups" profile.plist
```

# Prepare a Signing Copy

UDID Registrations signs against its generated app id, not the project defaults. Build from a temporary copy so the repo stays clean.

```sh
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

Build an unsigned device app bundle:

```sh
xcodebuild \
  -project URLBlocker.xcodeproj \
  -scheme URLBlockerIOS \
  -configuration Release \
  -sdk iphoneos \
  -destination generic/platform=iOS \
  -derivedDataPath /tmp/urlblocker_signing/build \
  CODE_SIGNING_ALLOWED=NO \
  COMPILATION_CACHE_ENABLE_CACHING=NO \
  build
```

The built app should be here:

```text
/tmp/urlblocker_signing/build/Build/Products/Release-iphoneos/URLBlockerIOS.app
```

# Create Signing Entitlements

Create `/tmp/urlblocker_signing/entitlements.plist` using values from the provisioning profile:

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

Use a temporary keychain instead of importing into the login keychain:

```sh
mkdir -p /tmp/urlblocker_signing

security create-keychain -p urlblocker /tmp/urlblocker_signing/signing.keychain-db
security unlock-keychain -p urlblocker /tmp/urlblocker_signing/signing.keychain-db
security set-keychain-settings -lut 21600 /tmp/urlblocker_signing/signing.keychain-db

security import Development.p12 \
  -k /tmp/urlblocker_signing/signing.keychain-db \
  -P 123456 \
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

# Sign and Package

Set the identity hash:

```sh
IDENTITY_HASH=954D99D17036F84F30F655128FB9B87560F87630
```

Prepare the payload:

```sh
mkdir -p /tmp/urlblocker_signed/Payload
cp -R \
  /tmp/urlblocker_signing/build/Build/Products/Release-iphoneos/URLBlockerIOS.app \
  /tmp/urlblocker_signed/Payload/

cp Development.mobileprovision \
  /tmp/urlblocker_signed/Payload/URLBlockerIOS.app/embedded.mobileprovision
```

Sign the extension first, then the containing app:

```sh
codesign -f \
  -s "$IDENTITY_HASH" \
  --generate-entitlement-der \
  --entitlements /tmp/urlblocker_signing/entitlements.plist \
  /tmp/urlblocker_signed/Payload/URLBlockerIOS.app/PlugIns/URLBlockerIOSExtension.appex

codesign -f \
  -s "$IDENTITY_HASH" \
  --generate-entitlement-der \
  --entitlements /tmp/urlblocker_signing/entitlements.plist \
  /tmp/urlblocker_signed/Payload/URLBlockerIOS.app
```

Verify the signature:

```sh
codesign -v --strict --deep /tmp/urlblocker_signed/Payload/URLBlockerIOS.app
```

Package the IPA:

```sh
mkdir -p build
cd /tmp/urlblocker_signed
zip -qry -X /Users/akelly/Git/URL-Blocker/build/URLBlockerIOS-signed.ipa Payload
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
  COMPILATION_CACHE_ENABLE_CACHING=NO \
  build
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

The UDID Registrations certificate was tested against the macOS app and Safari Web Extension target, but it is not usable for this project on macOS:

- Standard verification outside the temporary signing keychain context reported `CSSMERR_TP_NOT_TRUSTED`.
- Gatekeeper assessment with `spctl` did not accept the app as a normal trusted macOS app.
- PluginKit did not register the temporary signed extension as a usable replacement for the existing installed macOS extension.

Treat the UDID Registrations certificate as iOS-only for this project.

Apple Development signing is for local development and Safari extension registration. Gatekeeper distribution requires a Developer ID Application certificate and notarization. Safari 18.4 and later can load Developer ID-signed and notarized Safari Web Extensions.
