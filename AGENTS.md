# AGENTS.md

## Start Here

- Product and architecture spec: [ios_safari_site_blocker_spec.md](ios_safari_site_blocker_spec.md)
- iPhone build, signing, and install instructions: [ios_build_sign_install.md](ios_build_sign_install.md)

## Project Shape

- `URLBlockerIOS/`: iOS containing app.
- `URLBlockerIOSExtension/`: Safari Web Extension target and web resources.
- `ChromeExtension/`: Chrome-specific manifest. The Chrome build reuses the Safari extension web resources.
- `URLBlockerShared/`: Swift shared state validation and storage.
- `URLBlockerMac/` and `URLBlockerExtensionMac/`: macOS targets.
- `tests/`: Node tests for extension JavaScript behavior.
- `scripts/build-chrome-extension.mjs`: builds the unpacked Chrome extension in `build/chrome-extension`.
- `scripts/sync-default-blocked-pages.mjs`: syncs/checks default blocked pages.

## Commands

- Always run `make ...` commands outside the Codex sandbox so Xcode, signing, device install, and compilation cache access use the normal macOS services and keychains.

Show build and install targets:

```sh
make help
```

Run JavaScript tests:

```sh
make test
```

Build the unpacked Chrome extension:

```sh
make chrome-extension
```

Build the signed iOS IPA, signed macOS app, and unpacked Chrome extension:

```sh
make all
```

Build the UDID-signed iOS IPA:

```sh
make ios-build
```

Build the unsigned iOS device app:

```sh
make ios-build-unsigned
```

Build the UDID-signed iOS IPA with the legacy alias:

```sh
make ios-signed-ipa
```

List iOS devices available to Xcode:

```sh
make ios-devices
```

Build the UDID-signed iOS IPA and install it on the connected iPhone:

```sh
make ios-install
```

Install on a specific iPhone:

```sh
make ios-install DEVICE="My iPhone"
```

Build and install the signed macOS app:

```sh
make macos-install
```

Sync default blocked pages after editing defaults:

```sh
npm run sync-default-blocked-pages
```

Use [ios_build_sign_install.md](ios_build_sign_install.md) for the complete signing and iPhone install flow.

## Committing

- After finishing changes and before committing, run `make test` and then install the signed iOS build to the user's iPhone with `make ios-install`. If `make ios-install` fails during the build process then fix the error, but if the build succeeds but the install fails it's probably just that the iPhone isn't connected so don't bother retrying. Notify the user whether the install succeeded or failed.
- After finishing and testing each change, commit all changes for that completed work.
- Save any important or useful information to this file, make sure it update it when information changes, you learn new things, or you are given new general instructions

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
