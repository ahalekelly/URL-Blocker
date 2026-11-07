# State Machines

URL Blocker's behavior comes from a handful of state machines, some explicit (a `type` field) and some implicit (flags and timestamps that together form a state). This document lists each one's states, the invariants that must hold, and its transitions. `docs/block-decision-flowchart.html` covers the per-page block decision itself.

Code references are to `URLBlockerWebExtension/` unless noted. Android runs the same `blocker.js` and `supabase-sync.js` through `URLBlockerAndroid/app/src/main/assets/engine.js`.

## Concurrency model

The extension worker handles many events at once: page checks from every tab, navigation events, screen time logs every 5 seconds, options page messages, and timers. Each handler awaits storage and network calls, so handlers interleave. Two queues in `background.js` keep read-modify-writes whole:

| Queue | Runs | May wait on the network |
| --- | --- | --- |
| Settings queue | `saveState`, settings syncs (`syncSavedSettings`), sign-out, and the screen time sync's write of `lastSuccessfulSyncMs` | Yes |
| Local queue | Screen time usage updates, page pass saves, content script registration | No |

A task in either queue must not wait on a task in the same queue, or it deadlocks. Page checks never enter the settings queue, so a slow sync never delays blocking. Supabase requests time out after 30 seconds, so a stalled one cannot hold up saves for long.

The Android engine keeps all state in memory in one WebView thread and writes files after each change, so it needs no queues. Its one async job, `syncAccount`, rechecks `account` after each request.

## Settings activation

Stored as `settingsActivation`; `blocker.js` `pendingSettingsActivation` and `settleSettingsActivation`.

| State | Shape |
| --- | --- |
| Active | `{ activeState: A, pending: { type: "none" } }` |
| Pending | `{ activeState: A, pending: { type: "pending", state: P, effectiveAtMs } }` |

Invariants:

- The saved state (`blockerState`) is `P` while pending and `A` otherwise. The options page edits the saved state; blocking uses `A`.
- `effectiveAtMs` is the save time plus `A.settingsDelay`, so a shorter delay in `P` cannot shorten its own wait.
- The `blockedPageHtml` cache holds `A.blockedPageHtml`.
- The registered content script matches `contentScriptOriginsForState(A)`.

| From | Event | To | Side effects |
| --- | --- | --- | --- |
| none stored | first load | Active(saved or default state) | write cache |
| Active(A) or Pending(A, *) | save or newer synced settings S | Pending(A, S) | an earlier pending state is dropped and the delay restarts |
| Pending(A, P) | any load at or after `effectiveAtMs` | Active(P) | write cache, register content script, redirect open tabs, drop unused website access |
| any | stored state has an old unsupported version | Active(defaults) | immediate; sync metadata reset to never synced, so the account's settings replace the defaults |

Activation is lazy: a timer fires at `effectiveAtMs`, but browsers stop idle workers and their timers, so activation often happens on the next page check instead. Pages poll every 5 seconds while visible, so the delay is short in practice.

On Android, `step` settles the activation on every accessibility event and every 15-second tick.

## Settings sync metadata

Stored as `settingsSync`; transitions in `supabase-sync.js` and `background.js` `syncSettingsIfPossible`.

| State | Fields |
| --- | --- |
| Never synced | `updatedAtMs: 0`, `dirty: false` |
| Clean | `updatedAtMs` and `revisionId` copied from a remote row, `dirty: false` |
| Dirty | a local `revisionId`, `updatedAtMs` set at save time, `dirty: true` |

The server keeps whichever row has the larger `(updated_at_ms, revision_id)` (`supabase/001_url_blocker_sync.sql`). "Remote is newer" compares the same pair.

Invariants:

- Clean with revision R means the saved state is R's state.
- Dirty means the saved state has not reached the server.
- Every read-then-write of this metadata runs in the settings queue, so a save cannot land between a sync's read and its write.

| From | Event | To |
| --- | --- | --- |
| any | save | Dirty |
| Dirty | upload returns this revision | Clean |
| Dirty | upload returns a newer remote row | apply it, Clean |
| Never synced or Clean | load finds a newer remote row | apply it, Clean |
| Never synced or Clean | load finds no row or an older one | Clean (copies the row) |
| any | request or validation fails | unchanged, error shown |
| Never synced or Clean | sign out | Never synced |
| Dirty | sign out | unchanged, so the edits upload on the next sign-in |

"Apply" validates the remote state and makes it pending. A remote state from a newer schema version fails validation with an "update URL Blocker" error and changes nothing, locally or remotely.

The extension syncs settings when the options page opens, after each save, and on Sync Now. Android pulls settings on every sync (at most once a minute while the screen is on) and never uploads them.

## Account

| Platform | States | Storage |
| --- | --- | --- |
| Extension | signed out, signed in (session) | `supabaseSession`; native storage on iOS, and for the session on macOS Safari |
| Android | `{ type: "signedOut" }`, `{ type: "signedIn", session, email }` | `supabase-session.json` |

A session within a minute of expiry refreshes before the next request. Sign-out clears the session, the cached screen time of other devices, and clean settings sync metadata.

## Screen time usage

Stored as `screenTimeUsage`; `supabase-sync.js`.

- `localBuckets[domain][hour] = { totalMs, syncedMs }` with `0 <= syncedMs <= totalMs`.
- `dirtySinceMs` is `null` exactly when every bucket has `syncedMs === totalMs`.
- `remoteBuckets[deviceId][domain][hour]` holds other devices' totals and never this device's.

| Event | Change |
| --- | --- |
| page or app logs time | `totalMs += elapsed`; set `dirtySinceMs` if null |
| upload returns server totals | `syncedMs = max(syncedMs, min(totalMs, server))`; clear `dirtySinceMs` if nothing is dirty |
| download | replace other devices' buckets |
| sign out | clear `remoteBuckets` |

The extension applies each change to freshly loaded usage inside the local queue, so time logged while a sync waits on the network survives. A sync that ends after sign-out, or after signing in to another account, drops its results. A sync runs once usage has been dirty for `screenTimeSyncAgeMs`, and at once when a log puts a site over its limit.

## Tab memory and page visits

Session storage, per tab; `background.js` `checkTabPage`, `contentArrival`, `applyDecision`.

| Key | Value |
| --- | --- |
| `committedNavigation:<tabId>` | URL and transition of the last committed top-frame navigation (Chromium only) |
| `pagePasses:<tabId>` | up to 100 page keys (`pageChangeKey`) the tab was allowed onto |

A tab closing deletes both. A browser restart clears session storage.

Each check classifies the visit, then calls `decidePage`:

| Visit | Meaning | Outside-link pages |
| --- | --- | --- |
| continuing | the tab holds a pass for the page | open |
| arrivalPending | arrival not known yet | open, no pass saved |
| arrival from outside | link from another site or app | open, pass saved |
| arrival from inside | typed, bookmark, Back/Forward, in-site link, block page | blocked |

| Event | Visit |
| --- | --- |
| `webNavigation.onBeforeNavigate` | arrivalPending |
| `onCommitted`, link, start page, form submit, or reload | arrivalPending; the page's referrer decides |
| `onCommitted`, Back/Forward or any other transition | arrival from inside |
| `tabs.onUpdated` with a URL | arrivalPending |
| page check with a referrer | arrival judged by the referrer's site |
| page check without a referrer, Safari | arrival from outside |
| page check without a referrer, Chromium | the committed transition, or arrivalPending if the commit is not recorded yet |
| page check after a Back/Forward load | arrival from inside |
| block page's link | arrival from inside |
| open tabs after activation or a save | continuing |

Invariant: a pass is saved only for an allowed arrival, and the redirect target of a single short video. Pass saves run in the local queue so overlapping checks in one tab keep every pass.

## Content script

Per document; `content.js`.

| Variable | States |
| --- | --- |
| `arrival` | `history` after a Back/Forward load or bfcache restore; `referrer` otherwise, becoming the previous URL after each in-page URL change, except a replace |
| screen time | idle (`screenTimeUrl === ""`) or timing a URL since `screenTimeStartedAt`; hidden pages stop timing |
| `singleVideoLocked` | swallows scroll and arrow keys on a single short video page |
| `stopped` | the extension was updated, reloaded, or removed; the script tears itself down |

On Chromium, an update or reload leaves no live script in open tabs, so the worker injects one into each open tab matching the active state. A response for a URL the page has since left is dropped. Elapsed chunks over 30 seconds are dropped, so a suspended tab never logs its suspension.

## Content script registration

The worker registers one dynamic content script, `url-blocker-content`, whose matches follow the active state. Registration compares, unregisters, and registers in the local queue: two overlapping updates would otherwise both unregister or both register, and the browser rejects the second, failing whatever check triggered it.

## Options page

`options.js`.

| State | Shown |
| --- | --- |
| loading | nothing until `getLocalState` answers |
| editor | the draft, with the pending activation time if any |
| permission | website access request for saved sites lacking it |
| repair | the stored settings error and a reset button |

The draft is unsaved when its snapshot differs from `savedDraft`. Data loaded after the user starts editing (the startup sync, Sync now, a save's follow-up) replaces the draft only when it has no unsaved changes. `isSaving` disables Save while a save is in flight.

## Android service

`BlockerService.kt`.

| Variable | States |
| --- | --- |
| engine | loading, started (`engineReady`) |
| `screenInUse` | screen on and unlocked at the start of the current interval; only those intervals count |
| overlay | none, or showing `shownBlock` (package and reason); a new block reloads it, the close button removes it |
| engine `syncing` | one sync at a time; a forced sync while one runs is skipped until the next tick |

## Open gaps

These are known and not fixed.

- **Activation regression window.** `saveState` settles the activation, writes the saved state, then writes the new pending activation built from the activation it settled. A page check that activates the old pending state in between gets overwritten, briefly returning to the state before it. The window is one storage write, and only when the old pending state comes due inside it.
- **iOS app and Safari extension share storage across processes.** Both run a background controller over the same app group keys. The queues are per process, so simultaneous edits from both can still lose a write.
- **Chromium prerendering.** Prerendered pages may report navigation events with a nonzero frame ID, which the worker ignores, so a prerendered visit may only ever be judged as arrivalPending. Brave does not prerender, and branded Chrome will not load the unpacked extension, so this is untested.
- **Safari updates.** The worker does not inject into open tabs after a Safari update. Whether Safari keeps their scripts alive is untested.
- **Background settings pulls.** The extension pulls synced settings only when the options page opens or saves, unlike Android. Changes made on another device reach a browser after its options page next opens.
- **Overlapping token refreshes.** A settings sync and a screen time sync can refresh an expiring session at the same time with the same refresh token. Supabase's refresh token reuse interval accepts both.
