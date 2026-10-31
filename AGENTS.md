# AGENTS.md

## Key Instructions
- Try not to duplicate code across multiple platforms, keep functionality in the extension Javascript unless it would make the code far more complicated
- If an issue is reported on one platform, be aware that the issue could affect multiple platforms, make sure to check for this and don't just make a fix for the one platform it was reported on.
- More generally, if you find a bug in one place in the code, look for other places where that same bug could have occured
- If I give you steering instructions mid task, you should still complete the original task unless I said otherwise
- Save any important or useful information to this file, make sure to update it when information changes, you learn new things, or you are given new general instructions.

## Workflow

- After the initial draft of changes, run `make test` and then fix any issues. Then install all platforms with `make install`. Make sure all builds succeed. If the iOS or Android build succeeds but the device install fails, the phone probably isn't connected, so don't bother retrying. Notify the user whether all installs succeeded or which device installs failed.
- If you made functional or UI changes, verify them in a browser: headless Brave (see Commands) for automated checks, or Computer Use in Brave or Safari when you need the user's logged-in sites.
- After finishing and testing the change, commit the changes for that completed work.

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

## Project Shape

- `URLBlockerIOS/`: iOS containing app.
- `URLBlockerIOSExtension/`: iOS Safari Web Extension native wrapper.
- `URLBlockerWebExtension/`: shared Web Extension resources used by Safari, macOS, and Chromium builds.
- `ChromeExtension/`: Chrome-specific manifest and reload helpers. The Chrome build reuses `URLBlockerWebExtension/`.
- `URLBlockerShared/`: Swift shared state validation and storage.
- `URLBlockerMac/` and `URLBlockerExtensionMac/`: macOS targets.
- `URLBlockerAndroid/`: Android app (Kotlin, Gradle). An accessibility service runs `blocker.js` in a headless WebView through `app/src/main/assets/engine.js` and covers apps from `APP_SITE_DOMAINS` in `blocker.js`. The build copies `blocker.js`, `supabase-sync.js`, `supabase-config.json`, `default-blocked-pages.json`, `blocked.html`, and `blocked.css` into the app's assets; the app's own `assets/blocked.js` fills the block page.
- `tests/`: Node tests for extension JavaScript behavior.
- `scripts/build-chrome-extension.mjs`: builds the unpacked Chrome extension in `build/chrome-extension`.
- `scripts/install-chromium-extension.mjs`: updates or reloads the unpacked Chrome extension in a Chromium-based browser profile.
- `scripts/sync-default-blocked-pages.mjs`: syncs/checks default blocked pages.
- `scripts/headless-brave.mjs`: launches muted headless Brave with a throwaway profile and the unpacked extension for automated checks.

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

Build and update Vivaldi with the unpacked extension:

```sh
make vivaldi-install
```

Build and update Brave with the unpacked extension:

```sh
make brave-install
```

Use Brave as the Chromium UI verification target. Do not use Vivaldi for browser UI testing unless explicitly requested.

The Chromium install targets first verify URL Blocker is already installed from `build/chrome-extension`. When the browser is open, they verify and reload the currently running profile, including a temporary `--user-data-dir` profile. When the browser is closed, they verify the `Default` main profile and only update the files without opening the browser. The reload path requires URL Blocker to already be enabled.

The Codex in-app browser does not work for local URL Blocker extension UI checks. It rejects the local extension/options page, so use Brave for browser UI verification instead.

Launch headless Brave for automated checks (outside the sandbox; inside it Brave exits with code 21):

```sh
node scripts/headless-brave.mjs
```

It builds the extension, prints the CDP URL, extension ID, and options URL as JSON, and runs until killed. Always use it rather than launching a browser by hand: headless Chromium plays audio through the speakers unless muted. Drive it over CDP (Node has a global `WebSocket`). The extension's content-script world is the execution context named "URL Blocker". When setting state from the service worker:

- Write both `blockerState` and `settingsActivation.activeState` (with `pending: { type: "none" }`), since the active state comes from the activation.
- The default block schedule may be active at test time; set a window that excludes now. There is no `off` schedule type.
- `youtubeFocus.finishCurrentVideo` keeps an already-open `/watch` page open past its limit; turn it off when testing limit blocking on YouTube.

Build the signed iOS app, signed macOS app, and unpacked Chrome extension:

```sh
make all
```

Build the signed iOS device app:

```sh
make ios-build
```

Build the unsigned iOS device app:

```sh
make ios-build-unsigned
```

List iOS devices available to Xcode:

```sh
make ios-devices
```

Build the signed iOS app and install it on the connected iPhone:

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

Build the Android app (debug-signed, needs JDK 21 at `/opt/homebrew/opt/openjdk@21` and the SDK at `~/Library/Android/sdk`):

```sh
make android-build
```

On akelly-desktop (Linux, no zsh):

```sh
make android-build SHELL=/bin/bash ANDROID_HOME=~/.local/opt/android-sdk ANDROID_JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
```

The Pixel 8 is reachable from both machines with `adb connect pixel-8.troodon-bigeye.ts.net:5555`; see `~/.agents/machines/pixel8.md`.

Build and install the Android app on the connected device or emulator with adb:

```sh
make android-install
```

The Android app gets settings by signing in to Supabase (Google, via the `urlblocker://supabase-auth` redirect) from its status screen; until then it uses the default settings. Synced settings wait out the active settings delay, like in the extension. The engine keeps its session, settings, and screen time in app-private files, readable in debug builds with `adb shell run-as com.akelly.urlblocker ls files`. `adb logcat -s URLBlocker` shows each sync status.

Enable the accessibility service from Settings → Accessibility, or with root (`adb root` works on `google_apis` emulator images):

```sh
adb shell settings put secure enabled_accessibility_services com.akelly.urlblocker/.BlockerService
```

Install iOS, macOS, Vivaldi, and Android in parallel:

```sh
make install
```

Sync default blocked pages after editing defaults:

```sh
npm run sync-default-blocked-pages
```

iOS and macOS builds sign with Adrian's team (`T3TBGN4UX7`). `make ios-build` uses Xcode automatic signing, authenticated with the App Store Connect API key in `~/.appstoreconnect/`, and installs with `xcrun devicectl`. The API key cannot create or assign app groups; register a new app group and attach it to each App ID in the Apple Developer portal before building.

## Supabase Sync

- Supabase project ref: `YOUR_PROJECT_REF`.
- Runtime config is bundled from `URLBlockerWebExtension/supabase-config.json` into every platform, including Android. It must contain the project URL, publishable anon key, `redirectScheme: "urlblocker"`, and `screenTimeSyncAgeMs`.
- The committed `supabase-config.json` must stay as an example with placeholder values. Keep real local values in that same file only with `git update-index --skip-worktree URLBlockerWebExtension/supabase-config.json` set, so local builds include the real config but Git status and commits ignore it. Use `git update-index --no-skip-worktree ...` only when intentionally editing the example config.
- Backend schema lives in `supabase/001_url_blocker_sync.sql`.
- Run Supabase CLI commands outside the Codex sandbox. The CLI writes local metadata under `supabase/.temp/` and `~/.supabase`.
- `supabase/.temp/` is generated local CLI state and must not be committed.
- Confirm linked CLI access with:

```sh
supabase db query --linked "select 1 as ok;"
```

- The schema setup file is written to be safe to rerun. Apply the full schema with:

```sh
supabase db query --linked -f supabase/001_url_blocker_sync.sql
```

- For small SQL fixes, it is still fine to put the exact SQL block in a temp file and run it with `supabase db query --linked -f /private/tmp/file.sql`.
- If the browser reports `Supabase request failed: 400`, check the detailed message now shown in the options UI. A previous RPC bug was `column reference "device_id" is ambiguous`, fixed by using `on conflict on constraint screen_time_buckets_pkey`.
- With Data API auto-expose disabled, keep these grants present:

```sql
grant usage on schema public to authenticated;
grant select, insert, update on public.user_settings to authenticated;
grant select, insert, update on public.screen_time_buckets to authenticated;
grant execute on function public.save_user_settings(jsonb, bigint, text, text) to authenticated;
grant execute on function public.sync_screen_time_buckets(jsonb) to authenticated;
```

- Google sign-in is configured. Apple sign-in is intentionally not configured yet.

## Python Scripts

- Use `uv run`.
- Put PEP 723 headers at the top.
- Do not use `pip`.

## Signing Hygiene

- Never commit `.p12`, `.p8`, `.mobileprovision`, keychains, or signed `.ipa` files.
- After building and copying the macOS app to `/Applications`, unregister the temporary build product's Safari extension with `pluginkit -r /tmp/.../URLBlockerMac.app/Contents/PlugIns/URLBlockerMacExtension.appex` and verify `pluginkit -m -A -D -vvv -p com.apple.Safari.web-extension` shows only the `/Applications/URLBlockerMac.app` copy. Otherwise Safari can show duplicate URL Blocker extensions.
