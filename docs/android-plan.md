# Android Plan

Target device: rooted Pixel 8.

## Phone

- Unlock the bootloader before setup (it wipes the phone), then root with Magisk.
- Claude reaches the phone over adb on Tailscale, with `su` for root. A Magisk boot script keeps adb listening on TCP, reachable only over Tailscale. Notes live in `~/.agents/machines/pixel8.md`.
- AdAway blocks ad domains system-wide.

## Browser

- Vivaldi for Android is the only browser. Other browsers and the YouTube app are disabled with `pm disable-user` (see step 8 for the YouTube app alternative).
- Vivaldi runs URL Blocker unpacked (Developer Mode → Load unpacked) and uBlock Origin Lite for ads, including YouTube. URL Blocker's APIs (`webNavigation`, `scripting`, `tabs`, `identity`, the service worker) work there.
- Unpacked files load through Android's folder access, so each `fetch` of a packaged file takes about 300 ms (15 ms for store installs). The navigation path must not fetch packaged files.
- Vivaldi saves a `.crx` opened from a website as a download instead of installing it.
- Load unpacked works without Desktop Site. The Chrome Web Store needs Desktop Site only to install, so it can stay off.
- Settings are edited in URL Blocker's options page in Vivaldi.

## Short-form video hiding

`content.js` hides short-form video on YouTube, Instagram, Facebook, and LinkedIn on every browser platform, always on, with a toggle per site. Rules are built in and ship with the extension. YouTube Shorts stay in search results. Links to a single short video or reel are allowed on all four sites, but open as a single video with no swipe to the next (for example `/shorts/<id>` → `/watch?v=<id>`). Native apps get whole-app blocking only.

## Android app

`URLBlockerAndroid/`, Kotlin, built with `make android-build` and `make android-install` (included in `make install`).

- Runs `blocker.js` and `supabase-sync.js` in a headless WebView, so blocking decisions and limit math match the extension.
- An accessibility service watches the visible apps, including split screen and picture-in-picture. Apps in a fixed app-to-site table in `blocker.js` (`APP_SITE_DOMAINS`) count as their site's home page, so they are blocked whenever the home page would be. A blocked app is covered with an accessibility overlay that renders the extension's `blocked.html` and `blocked.css`, the user is sent home, and its picture-in-picture window is closed. Apps are never stopped, so notifications still arrive.
- The service re-checks every 15 seconds, so schedules and limits apply while an app stays open.
- Visible apps' time counts toward their site's shared screen time limit while the screen is on and unlocked, stored in the extension's `screenTimeUsage` shape.
- Signs in to Supabase with Google in the browser through the `urlblocker://supabase-auth` redirect, then syncs as its own device: it pulls settings, which wait out the active settings delay like in the extension, pushes its screen time, and pulls other devices'. It syncs every `screenTimeSyncAgeMs` while the screen is in use, on unlock, and when a site goes over its limit. Before the first sync it uses the default settings.
- Shows status only: account, last sync and errors, sign-in and sign-out, accessibility, Device Owner, extension check.

### Tamper resistance

- The app is Device Owner (set by temporarily removing accounts, then `dpm set-device-owner`). It blocks its own uninstall, sets `DISALLOW_APPS_CONTROL` and `DISALLOW_SAFE_BOOT`, and keeps other browsers disabled.
- With root, it reads Vivaldi's `Preferences` to confirm URL Blocker and uBlock Origin Lite are installed and enabled, and covers Vivaldi when they are not.
- If Vivaldi honors `ExtensionInstallForcelist` through managed configuration, the app sets it. Vivaldi's managed-config schema lists the extension policies, but Android delivers app restrictions only from a device admin, so testing needs the Device Owner.
- Root can still undo all of this; the goal is friction, not impossibility.

## Order

1. Phone setup.
2. Verify URL Blocker in Vivaldi Android: route changes, schedules, limits, sync. Fix what breaks.
3. Short-form video hiding on all browser platforms.
4. Move `overLimitDomains`, `usageWindow`, and settings-delay resolution from `background.js` into `BlockerCore`.
5. App MVP: accessibility service, app-to-site table, schedules, block page, settings pushed over adb.
6. App Supabase sign-in and sync, including app screen time.
7. Device Owner, extension check, browser disabling.
8. Optional, decided after using YouTube in Vivaldi: a custom ReVanced patch bundle for the YouTube app. The patch reports the current video ID, player type (watch vs Shorts), and navigation tab to the native app as YouTube URLs, so route rules, "finish current video", and per-route screen time apply in the app. Official patches add ad blocking, SponsorBlock, and Shorts hiding. Root-mounted over stock YouTube (same package name), pinned to a ReVanced-supported version. Replaces disabling the YouTube app.

## Open questions

- Does Vivaldi honor extension policies from managed configuration?
