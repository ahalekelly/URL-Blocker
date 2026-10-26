# Android Plan

Target device: rooted Pixel 8.

## Phone

- Unlock the bootloader before setup (it wipes the phone), then root with Magisk.
- Claude reaches the phone over adb on Tailscale, with `su` for root. A Magisk module keeps adb listening on TCP across reboots. Notes live in `~/.agents/machines/pixel8.md`.
- AdAway blocks ad domains system-wide.

## Browser

- Vivaldi for Android is the only browser. Other browsers and the YouTube app are disabled with `pm disable-user` (see step 8 for the YouTube app alternative).
- Vivaldi runs URL Blocker unpacked (Developer Mode → Load unpacked) and uBlock Origin Lite for ads, including YouTube.
- Settings are edited in URL Blocker's options page in Vivaldi.

## Short-form video hiding

`content.js` hides short-form video on YouTube, Instagram, Facebook, and LinkedIn on every browser platform, always on, with a toggle per site. Rules are built in and ship with the extension. YouTube Shorts stay in search results. Links to a single short video or reel are allowed on all four sites, but open as a single video with no swipe to the next (for example `/shorts/<id>` → `/watch?v=<id>`). Native apps get whole-app blocking only.

## Android app

`URLBlockerAndroid/`, Kotlin, built with `make android-build` and `make android-install` (included in `make install`).

- Runs `blocker.js` and `supabase-sync.js` in a headless WebView, so blocking decisions and limit math match the extension.
- An accessibility service watches the visible apps, including split screen and picture-in-picture. Apps in a fixed app-to-site table in `blocker.js` (`APP_SITE_DOMAINS`) count as their site's home page, so they are blocked whenever the home page would be. A blocked app is covered with an accessibility overlay that renders the extension's `blocked.html` and `blocked.css`, the user is sent home, and its picture-in-picture window is closed. Apps are never stopped, so notifications still arrive.
- The service re-checks every 15 seconds, so schedules and limits apply while an app stays open.
- Visible apps' time counts toward their site's shared screen time limit while the screen is on and unlocked, stored in the extension's `screenTimeUsage` shape.
- Until sync lands, settings come from a JSON file pushed over adb (see `AGENTS.md`) and apply immediately, without the settings delay.
- Signs in to Supabase with Google through the `urlblocker://` redirect and syncs settings and screen time as its own device.
- Shows status only: sign-in, accessibility, Device Owner, extension check.

### Tamper resistance

- The app is Device Owner (set by temporarily removing accounts, then `dpm set-device-owner`). It blocks its own uninstall, sets `DISALLOW_APPS_CONTROL` and `DISALLOW_SAFE_BOOT`, and keeps other browsers disabled.
- With root, it reads Vivaldi's `Preferences` to confirm URL Blocker and uBlock Origin Lite are installed and enabled, and covers Vivaldi when they are not.
- If Vivaldi honors `ExtensionInstallForcelist` through managed configuration, the app sets it.
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

- Do URL Blocker's APIs (`webNavigation`, `scripting`, service worker) work in Vivaldi Android?
- Does Vivaldi need "Desktop Site" enabled only to install extensions, or permanently?
- Does Vivaldi honor extension policies from managed configuration?
