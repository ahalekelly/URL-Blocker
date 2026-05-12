# AGENTS.md

## Start Here

- Product and architecture spec: [ios_safari_site_blocker_spec.md](ios_safari_site_blocker_spec.md)
- iPhone build, signing, and install instructions: [ios_build_sign_install.md](ios_build_sign_install.md)

## Project Shape

- `URLBlockerIOS/`: iOS containing app.
- `URLBlockerIOSExtension/`: Safari Web Extension target and web resources.
- `URLBlockerShared/`: Swift shared state validation and storage.
- `URLBlockerMac/` and `URLBlockerExtensionMac/`: macOS targets.
- `tests/`: Node tests for extension JavaScript behavior.
- `scripts/sync-default-blocked-pages.mjs`: syncs/checks default blocked pages.

## Commands

Run JavaScript tests:

```sh
npm test
```

Sync default blocked pages after editing defaults:

```sh
npm run sync-default-blocked-pages
```

Build the unsigned iOS device app:

```sh
xcodebuild \
  -project URLBlocker.xcodeproj \
  -scheme URLBlockerIOS \
  -configuration Release \
  -sdk iphoneos \
  -destination generic/platform=iOS \
  CODE_SIGNING_ALLOWED=NO \
  COMPILATION_CACHE_ENABLE_CACHING=NO \
  build
```

Use [ios_build_sign_install.md](ios_build_sign_install.md) for the complete signing and iPhone install flow.

## Finish Workflow

- After finishing and testing each change, commit all changes for that completed work.

## Coding Preferences

- Keep code extremely easy to skim.
- Prefer fewer states, fewer arguments, and required values over optional ones.
- Use discriminated unions for multi-shape data.
- Exhaustively handle known types and fail on unknown types.
- Validate loaded data at boundaries and raise clear errors for invalid data.
- Avoid defensive fallback code when types already guarantee the value.
- Prefer early returns.
- Prefer `if: raise` over broad `try`/catch when a value is expected to exist.
- Keep changes narrowly scoped. Remove anything not required for the task.
- Avoid clever abstractions and overly split helper functions.

## Python Scripts

- Use `uv run`.
- Put PEP 723 headers at the top.
- Do not use `pip`.

## Signing Hygiene

- Never commit `.p12`, `.mobileprovision`, keychains, signed `.ipa` files, or private order links.
- The current UDID Registrations account is Silver, not Platinum. Use local signing with the downloaded `.p12` and `.mobileprovision`; do not expect online signing to work.
- Prefer temporary working directories under `/tmp` or `/private/tmp` for signing.
- Restore the normal keychain search list after local signing.
- After building and copying the macOS app to `/Applications`, unregister the temporary build product's Safari extension with `pluginkit -r /tmp/.../URLBlockerMac.app/Contents/PlugIns/URLBlockerMacExtension.appex` and verify `pluginkit -m -A -D -vvv -p com.apple.Safari.web-extension` shows only the `/Applications/URLBlockerMac.app` copy. Otherwise Safari can show duplicate URL Blocker extensions.
- The UDID Registrations certificate is for iOS signing. It can manually stamp the macOS app and Safari extension with `codesign`, but it did not produce a normally trusted macOS signing result in local testing. Use an Apple Development, Mac Development, or Developer ID Application certificate for macOS Safari extension signing.
