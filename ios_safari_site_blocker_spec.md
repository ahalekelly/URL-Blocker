# iOS Safari MV3 Website Blocker Spec

This document is a recommendation, not a set of hard rules. Any choice here can be changed as needed during implementation if testing or product judgment shows a better path.

This spec describes a simple iOS Safari website blocker. The app blocks user-entered URL patterns, including whole domains, page URLs, URL subtrees, and validated regular expressions.

The core requirement is SPA-safe blocking: if a user starts on an allowed page and the site changes the address bar with client-side routing, the app must still block the new URL when it matches the blocklist.

# Short Answer

Build the full iOS app with a packaged Safari Web Extension.

- Use Manifest V3 with a background service worker that owns all block decisions.
- Use a content script to report initial page URLs and single-page-app route changes.
- Use a simple extension options page for the blocklist editor.
- Make the native containing app the only user-facing entry point for opening the blocklist editor.
- Do not expose a blocklist editor item or popup from Safari's Extensions menu.
- Do not use a Safari Content Blocker as the main architecture, because it cannot reliably catch URL-only client-side route changes.

# Goals

- Block direct navigation to a blocked URL.
- Block SPA route changes to a blocked URL.
- Allow other URLs on the same host when the rule is path-specific.
- Allow blocking to navigate the tab to the extension blocked page.
- Make invalid input fail before saving.
- Keep the app small, understandable, and privacy-preserving.
- Avoid desktop-only Safari extension APIs.

# Non-Goals

- Password protection.
- Schedules.
- Pause/resume.
- Import/export.
- Managed storage.
- Context menus.
- Notifications.
- Cross-browser packaging.
- Enterprise MDM filtering.
- A native Swift blocklist editor.
- A Safari Extensions menu editor entry point.

# Product Behavior

The user manages a single ordered blocklist. Each blocklist row has exactly one matcher type.

| Matcher type | User intent | Example | Blocks | Allows |
|---|---|---|---|---|
| Full domain blocking | Block a site | `example.com` | `https://example.com/anything`, `https://www.example.com/anything` | `https://not-example.com/` |
| URL blocking | Block one path across the site | `https://reddit.com/popular` | `https://reddit.com/popular`, `https://www.reddit.com/popular/`, `https://old.reddit.com/popular?foo=bar`, `https://reddit.com/popular/?foo=bar`, `https://reddit.com/popular#feed` | `https://reddit.com/popular/foo` |
| URL blocking including subpaths | Block one path and descendants across the site | `https://reddit.com/popular` | `https://reddit.com/popular`, `https://reddit.com/popular/`, `https://reddit.com/popular?foo=bar`, `https://reddit.com/popular/foo#comments` | `https://reddit.com/popularity` |
| Custom regex | Block advanced path patterns | `^https://x\.com/(home|explore)/?$` | matching URLs | non-matching URLs |

URL-based entries are path rules. If the user enters a query string, fragment, or trailing slash, the editor strips it from the stored value and updates the input field to show the stripped URL. URL matching ignores query strings, fragments, and trailing slashes on the page URL.

Query behavior:

- Query strings entered in URL-based entries are stripped before storage.
- The options page updates the URL input field to show the stripped URL.
- Page URL query strings are ignored when matching URL-based entries.
- URL blocking entries match the entered path with or without trailing slashes.
- URL blocking entries do not match descendant paths.
- URL blocking including subpaths entries match the entered path, trailing slashes, and descendant paths.

Trailing slash behavior:

- Trailing slashes entered in URL-based entries are stripped before storage.
- The options page updates the URL input field to show the stripped URL.
- Page URL trailing slashes are ignored when matching URL-based entries.
- `https://example.com/` is stored and displayed as `https://example.com`.

Fragment behavior:

- Fragments are visible to the content script and service worker.
- Fragments entered in URL-based entries are stripped before storage.
- The options page updates the URL input field to show the stripped URL.
- Page URL fragments are ignored when matching URL-based entries.
- Blocking one hash route while allowing another hash route on the same path is not supported in v1.

# Architecture

The app has two targets. Both targets are in scope for v1 and should be built together:

1. Native iOS containing app.
2. Safari Web Extension.

The native app is deliberately boring. It shows onboarding instructions, a button that opens the iOS Safari extension settings screen, and a button that opens the blocklist editor. It does not own the blocklist in v1.

The Web Extension owns all blocker state:

- `browser.storage.local` stores the blocklist.
- The background service worker validates saves, syncs content-script registration, and redirects blocked tabs.
- A content script reports current page URLs and catches SPA route changes.
- An options page edits the blocklist and is opened from the native app.
- A blocked page gives the user a clear destination when a block occurs.

## Extension Files

The extension should contain these files:

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest, permissions, content script, options page, blocked page resources |
| `background.js` | validation, storage writes, content-script registration, tab redirection |
| `content.js` | URL monitor for initial loads and SPA route changes |
| `options.html` / `options.js` | blocklist editor |
| `blocked.html` / `blocked.js` | blocked-page UI |
| icons | app and extension icon assets |

# Manifest Requirements

Target iOS/iPadOS 16.4 or newer for Safari Web Extension reliability. Safari 15.4 added MV3 service workers, while Safari 16.4 fixed several extension reliability issues.

Required permissions:

- `nativeMessaging`
- `scripting`
- `storage`
- `tabs`

Required optional host access:

- None.

Required extension surfaces:

- MV3 service worker background.
- Dynamically registered content script on the normalized hosts in the blocklist.
- Content script runs at `document_start`.
- Options page for editing.
- No extension action, popup, or Safari Extensions menu item for editing the blocklist.
- `blocked.html` listed as a web-accessible extension resource so the worker can redirect to it.

Do not request these in v1:

- `contextMenus`, because iOS Safari does not support extension context menus.
- `notifications`, because the app does not need them.
- `idle`, because route blocking cannot depend on device idle state.
- `windows`, because iOS Safari does not support extension-created popup windows in the desktop sense.
- `webRequestBlocking`, because blocking webRequest is not available on iOS Safari.

# Permission UX

iOS Safari requires users to enable the extension and grant website access. The native app onboarding must explain this plainly:

1. Install and open the app once.
2. Open Settings.
3. Go to Safari.
4. Go to Extensions.
5. Enable the blocker.
6. Save blocklist entries and grant access to those websites.

The app should request website access only for normalized hosts in the blocklist. URL entries request the whole host so same-site SPA route changes can still be blocked. Custom regex entries must start with one literal host, and request only that host.

The extension must behave gracefully when access is missing:

- Content scripts will not run on sites where access is denied.
- The blocked list editor should show a visible warning that Safari permissions control whether blocking can happen.

# Data Model

Store a single object in `browser.storage.local`.

Use an explicit schema version. Unknown schema versions are fatal and should make the settings page show a repair/reset prompt.

```ts
type BlockerState = {
  schemaVersion: 1;
  entries: BlockEntry[];
};

type BlockEntry =
  | { id: string; kind: "domain"; value: string }
  | { id: string; kind: "url"; value: string }
  | { id: string; kind: "urlWithSubpaths"; value: string }
  | { id: string; kind: "regex"; value: string };
```

`id` is a UUID generated when the entry is created. It stays stable until the entry is deleted.

There is no disabled state in v1. A row exists or it does not. This keeps matching easy to reason about.

# Validation

All validation happens before saving.

Shared validation rules:

- `kind` must be one of the four known matcher kinds.
- `id` must be a valid UUID.
- `value` must be non-empty after trimming.
- Any parsed URL must use `http` or `https`.
- Duplicate entries are rejected after normalization.
- The blocklist is capped at 1000 entries in v1.
- Unknown object keys are rejected instead of ignored.

URL Blocking and URL Blocking Including Subpaths:

- Must parse as an absolute `http` or `https` URL.
- Host is lowercased.
- Leading `www.` is removed before storage.
- Default ports are removed.
- Trailing slashes are stripped before storage.
- Query strings are stripped before storage.
- Fragments are stripped before storage.
- Username and password are rejected.
- Non-default ports are rejected in v1.
- The URL is matched with generated URL regex semantics, not raw string prefix semantics.

Full Domain Blocking:

- Must be a hostname, not a full URL.
- Must be lowercase ASCII or punycode after normalization.
- Leading `www.` is removed before storage.
- No path, query, fragment, port, username, or password is allowed.
- IP addresses are rejected in v1. Add a separate `ipAddress` matcher later if needed.

Custom Regex:

- Must compile as a JavaScript regular expression.
- Must match against the normalized page URL string, which has no fragment.
- Must be case-insensitive.
- Must not contain `#`; fragment-specific regex rules are not supported in v1.
- Must not use lookbehind, backreferences, or unsupported flags.
- Must not be an unanchored `.*` style catch-all unless the user explicitly confirms a "block everything" warning.

Any invalid entry prevents the entire save. The settings page should show row-level errors and leave the previous active blocklist untouched.

# URL Normalization

Use one URL normalization function everywhere.

Input normalization:

- Trim whitespace.
- Parse with the platform URL parser.
- Require `http:` or `https:`.
- Lowercase scheme and host.
- Remove leading `www.` from URL-based entry hosts before storage.
- Remove default port `:80` for HTTP and `:443` for HTTPS.
- Reject non-default ports for URL-based entries in v1.
- Strip query strings, fragments, and trailing slashes from URL-based entries before storage.
- Use no stored path for a root URL.
- Preserve path case.
- Ignore page URL query strings, fragments, and trailing slashes when matching URL-based entries.

The worker normalizes page URLs before matching. URL-based entries ignore query strings, fragments, and trailing slashes. Regex entries match the normalized page URL without a fragment.

# Matching Semantics

Every matcher has one JavaScript predicate in the shared blocker core.

URL predicates:

- Match `http` and `https` regardless of which scheme the user entered.
- Match the stored host and any subdomain of the stored host.
- Ignore query strings.
- Ignore fragments.
- Ignore trailing slashes.

URL blocking:

- Match the stored path with or without trailing slashes.
- Do not match descendant paths.

URL blocking predicate shape after page URL normalization:

```regex
^https?://(?:[^./?#]+\.)*<escaped-host><escaped-path>$
```

URL blocking including subpaths:

- Match the stored path with or without trailing slashes.
- Match descendant paths.
- Do not match sibling paths that only share the same text prefix.

URL blocking including subpaths predicate shape after page URL normalization:

```regex
^https?://(?:[^./?#]+\.)*<escaped-host><escaped-path>(?:/[^?#]*)?$
```

- If the user enters a query, fragment, or trailing slash in a URL-based entry, normalization removes it and the options page updates the input field to the stripped URL.
- When the stored path is empty, use an empty `<escaped-path>` so the root URL still matches with or without trailing slashes.

Domain predicate:

- Match exact host.
- Match any subdomain.
- Match all paths, queries, and fragments on matching hosts.

Regex predicate:

- Match the normalized page URL string, which has no fragment.
- Use case-insensitive matching.

# Save Flow

The background service worker is the only component that decides whether a URL is blocked.

Save flow:

1. Options page sends the complete proposed blocklist to the service worker.
2. Service worker validates all entries.
3. Service worker confirms Safari has the requested website access.
4. Service worker updates the dynamic content-script registration for the required hosts.
5. Service worker writes the validated state to storage.
6. Service worker returns the validated normalized state to the options page.
7. Service worker redirects any already-open tabs that match the new state.

The save must be transactional from the user's perspective. If validation, website access, content-script registration, or storage fails, leave the old saved blocklist active and show the error.

# URL Change Blocking

A single-page app can change the visible URL without a top-level document request. The content script exists to report those changes to the service worker.

The content script must:

- Run on `http` and `https` pages at `document_start`.
- Check `location.href` on startup.
- Re-check when the visible URL changes.
- Send changed URLs to the service worker quickly without waiting for a full page refresh.

Use a simple URL monitor instead of relying only on `tabs.onUpdated`.

The monitor should call `checkCurrentUrl()` from:

- initial content script startup
- `pageshow`
- `popstate`
- `hashchange`
- `visibilitychange`
- `focus`
- capture-phase `click`
- capture-phase `submit`
- capture-phase keyboard events likely to activate links
- a visible-page interval, initially 750 ms

The interval is intentionally boring. It avoids depending on fragile history monkey-patching across isolated content-script worlds. Later, if Safari supports reliable main-world content script injection for this use case, the interval can be replaced or supplemented with a page-world history hook.

When the content script sees a changed URL:

1. It sends the current URL to the service worker.
2. The service worker checks the URL against the current saved state.
3. If still blocked, the service worker updates the tab to the extension blocked page.
4. The blocked page receives the blocked URL in the fragment for display.

The content script does not load or interpret blocklist state. The service worker is the only component that decides whether a URL is blocked.

# Blocked Page

The blocked page should be minimal:

- Title: `Blocked`
- Show the blocked host or full URL when available.
- Button: `Close`

Blocking may change the address bar to the extension blocked page. The blocked page shows the original URL when it was passed by the worker.

The Close button closes the current tab by calling `browser.tabs.getCurrent()` from `blocked.js`, then `browser.tabs.remove(tab.id)`.

Pass the blocked URL to `blocked.html` in the fragment, not the query string. Fragments are not sent as HTTP requests.

The blocked page must not open the blocklist editor. Users edit the blocklist by opening the native app.

# Options Page UX

The options page is the blocklist editor. It is opened only from the native iOS app, not from Safari's Extensions menu and not from the blocked page.

Required controls:

- Add row.
- Matcher type segmented control: Full domain blocking, URL blocking, URL blocking including subpaths, Custom regex.
- Text input for the matcher value.
- Delete row.
- Save button.
- Error summary.
- Row-level validation messages.

Behavior:

- Save replaces the whole blocklist.
- Delete removes the row immediately from the draft, but blocking changes only after Save.
- URL rows are normalized when the user leaves the input field and before Save using the same normalization function as the service worker.
- When URL normalization strips a query string, fragment, or trailing slash, the input field is replaced with the stripped URL.
- After a successful Save, the draft is replaced with the normalized state returned by the service worker.
- Invalid rows prevent Save.
- Successful Save shows a short confirmation.
- The page warns when Safari website access may be missing.

Keep the UI text short. Do not include a tutorial inside the editor.

# Native iOS App UX

The containing app has one screen.

It should include:

- App name.
- One sentence describing that Safari must enable the extension.
- Steps to enable the extension in iOS Settings.
- Button to open the app's Settings page.
- Button to open the blocklist editor.

The native app should not duplicate the blocklist editor in v1. It is only the launch surface for the extension options page. A native editor would require native-to-extension state synchronization and is unnecessary for the first implementation.

The user should not need to open Safari's Extensions menu to manage the blocklist. Do not add an extension action popup or menu entry for editing.

# Message Protocol

All extension messages use a discriminated union with `type`.

Supported messages:

| Message | Sender | Receiver | Purpose |
|---|---|---|---|
| `getState` | options/blocked page | service worker | Read the current saved blocklist |
| `saveState` | options page | service worker | Validate, sync content scripts, save state |
| `urlChanged` | content script | service worker | Ask worker to check the current page URL |
| `openOptions` | native app | service worker | Open the editor |

Unknown message types must raise an error. Do not silently ignore them.

# Failure Modes

Invalid blocklist:

- Do not update content-script registration.
- Do not update storage.
- Show validation errors.

Content-script registration failure:

- Keep old storage.
- Show the registration error.
- Ask the user to reduce entry count if the error is quota-related.

Missing Safari website access:

- The options page remains usable.
- Blocking may not occur on denied sites.
- Show setup guidance.

Service worker suspended:

- Content scripts can wake the worker with `urlChanged` messages.

Content script route report:

- Service worker checks current saved state before redirecting.

URL input containing query, fragment, or trailing slash:

- URL normalization strips the query string, fragment, or trailing slash.
- The options page updates the input field to show the stripped URL.
- Save continues with the stripped URL.

# Testing Matrix

Run these tests on iPhone and iPad. Simulators are useful but not sufficient for final acceptance.

| Scenario | Setup | Expected result |
|---|---|---|
| Direct URL | Block `https://x.com/home` | Opening that URL is blocked |
| Same-domain allowed page | Block `https://x.com/home` | Opening a specific allowed URL on `x.com` is allowed |
| SPA route change | Start on an allowed `x.com` page, click a control that routes to `/home` | The route is blocked without manual refresh |
| URL trailing slash, query, and fragment | Block `https://reddit.com/popular` | `/popular`, `/popular/`, `/popular?foo=bar`, `/popular/?foo=bar`, and `/popular#feed` are blocked |
| URL subdomain | Block `https://reddit.com/popular` | `www.reddit.com/popular` and `old.reddit.com/popular` are blocked |
| URL descendant path | Block `https://reddit.com/popular` | `/popular/foo` is allowed |
| URL including subpaths | Block `https://reddit.com/popular` with URL blocking including subpaths | `/popular`, `/popular/`, `/popular?foo=bar`, `/popular/foo`, and `/popular/foo?bar=baz` are blocked |
| URL including subpaths text prefix | Block `https://reddit.com/popular` with URL blocking including subpaths | `/popularity` is allowed |
| Root Reddit URL | Block `https://reddit.com` | Root Reddit URLs are blocked; subreddit feed and comment pages are allowed |
| Subreddit feeds | Block `https://reddit.com/r/*` | Subreddit feed pages like `/r/safari` and `/r/safari/new` are blocked; subreddit comment pages are allowed |
| Domain | Block `example.com` | `example.com` and subdomains are blocked |
| Regex valid | Add an anchored regex for two paths | Matching paths block; non-matching paths allow |
| Regex invalid | Add unsupported regex | Save fails and old blocklist remains active |
| URL input with query | Add `https://x.com/home?foo=bar` | Input updates to `https://x.com/home`; save blocks `/home` with any query |
| URL input with fragment | Add `https://x.com/home#feed` | Input updates to `https://x.com/home`; save blocks `/home` with any fragment |
| URL input with trailing slash | Add `https://x.com/home/` | Input updates to `https://x.com/home`; save blocks `/home` and `/home/` |
| Root URL input | Add `https://x.com/` | Input updates to `https://x.com`; save blocks `https://x.com` and `https://x.com/` |
| Twitter URL alias | Block `https://x.com` | `https://twitter.com` and `https://twitter.com/home` are blocked as X aliases |
| Hash route on blocked path | Block `https://x.com/home` | `/home#feed` is blocked |
| Permission denied | Deny website access for a test site | Editor works; site is not reliably blocked; warning is visible |
| Safari restart | Save blocklist, force quit Safari, reopen blocked URL | Direct navigation is still blocked |
| Entry removal | Remove an entry and save | Previously blocked URL is allowed after refresh/new navigation |
| Stale tab | Remove a rule while old tab is open | Content script does not keep blocking after service worker re-check |

# Automated Test Suite Plan

Automated tests should prove the blocker contract before device testing. Keep most tests close to pure code, then use Safari/iOS automation only for behavior that depends on Safari itself.

## Automated Test Targets

| Target | Suggested tool | Runs | Verifies |
|---|---|---|---|
| Shared extension unit tests | JavaScript test runner | Every commit | normalization, validation, matching, permission origins |
| Background worker tests | JavaScript tests with explicit browser API fakes | Every commit | message handling, transactional saves, storage updates, redirects |
| Content script tests | DOM-capable JavaScript tests | Every commit | startup checks, route-change detection, duplicate suppression |
| Options page tests | DOM-capable JavaScript tests | Every commit | row editing, validation errors, save flow, normalized field updates |
| Native iOS tests | XCTest | Native app changes | onboarding screen, settings button, blocklist editor launch button |
| Safari integration tests | Xcode UI tests on simulator | Before merge when blocker behavior changes | extension wiring, direct navigation blocking, SPA blocking, persistence |
| Device smoke tests | iPhone and iPad release checklist | Before release | real Safari permission behavior and extension reliability |

Use one shared fixture table for normalization, matching, permission origins, and integration tests. Each fixture should include:

- entry kind
- raw user input
- normalized stored entry
- URLs that must block
- URLs that must allow
- expected host permission origins

## Shared Unit Tests

Normalization tests:

- URL input trims whitespace.
- URL input accepts only `http` and `https`.
- URL input lowercases scheme and host.
- URL input strips leading `www.` from the stored host.
- URL input removes default ports.
- URL input rejects non-default ports.
- URL input rejects username and password.
- URL input strips query strings, fragments, and trailing slashes.
- `https://example.com/` stores as `https://example.com`.
- URL input preserves path case.
- Domain input rejects full URLs, paths, queries, fragments, ports, credentials, and IP addresses.
- Domain input lowercases and strips leading `www.`.
- Regex input compiles before saving.
- Regex input rejects fragments, unsupported flags, lookbehind, backreferences, and unconfirmed catch-all patterns.

Validation tests:

- Every valid matcher kind saves.
- Unknown matcher kind raises an error.
- Unknown object keys raise an error.
- Missing required fields raise an error.
- Invalid UUID raises an error.
- Empty value raises an error after trimming.
- Duplicate entries fail after normalization.
- More than 1000 entries fail.
- Unknown schema version makes the settings page use the repair/reset path.

Matching tests:

- Domain rules match the exact host and all subdomains.
- Domain rules do not match text-similar hosts.
- URL rules match `http` and `https` regardless of the entered scheme.
- URL rules match `www.` and other subdomains after normalization.
- URL rules ignore query strings, fragments, and trailing slashes.
- URL rules do not match descendant paths.
- URL-with-subpaths rules match descendant paths.
- URL-with-subpaths rules do not match sibling text prefixes.
- Root URL rules block only the root path.
- Regex rules are case-insensitive.
- Regex rules match the normalized page URL string with no fragment.

Permission origin tests:

- Domain entries map to host-scoped origins.
- URL and URL-with-subpaths entries map to their normalized host origins.
- Duplicate host origins are removed.
- Origins are sorted for stable saves and tests.
- Regex entries map to their one literal host origin.

## Background Worker Tests

Message protocol tests:

- `getState` returns the saved state.
- `saveState` accepts only a complete replacement state.
- `urlChanged` checks the URL against current saved state before redirecting.
- `openOptions` opens the options page.
- Unknown message types raise an error.
- Invalid message shapes raise an error.

Save flow tests:

- Successful save validates entries, syncs content scripts, writes storage, returns normalized state, and redirects open matching tabs.
- Failed validation does not update content scripts or storage.
- Failed content-script registration does not write storage.
- Failed storage write reports an error and does not report success to the options page.
- Removing a rule and saving updates the registered content-script origins from the new list.

SPA blocking tests:

- A matching `urlChanged` message redirects the tab to the extension blocked page.
- A non-matching `urlChanged` message does nothing.
- The blocked URL is passed to the blocked page in the fragment.

## Content Script Tests

Startup tests:

- The script checks `location.href` on startup.
- The script does not load blocklist state.

Route detection tests:

- `pageshow` triggers a URL check.
- `popstate` triggers a URL check.
- `hashchange` triggers a URL check.
- `visibilitychange` triggers a URL check when the page becomes visible.
- `focus` triggers a URL check.
- Capture-phase link clicks trigger a URL check.
- Capture-phase form submits trigger a URL check.
- Capture-phase keyboard activation events trigger a URL check.
- The visible-page interval triggers a URL check.
- The interval pauses or does not redirect while the page is hidden.

Worker handoff tests:

- Changed URLs send `urlChanged` to the service worker.
- Repeated checks for the same URL do not send duplicate messages.
- Multiple rapid checks for the same URL send one message.

## Options Page Tests

Draft editing tests:

- Add row creates one required entry draft.
- Delete row removes only the selected draft row.
- Delete does not change active blocking until Save.
- Changing matcher type uses the correct validation path.
- Successful Save replaces the draft with the normalized state returned by the worker.
- Successful Save shows a short confirmation.

Validation UI tests:

- Row-level errors appear for invalid rows.
- Error summary appears when any row is invalid.
- Invalid rows prevent Save.
- The previous active blocklist remains visible as active when Save fails.
- Unknown schema version shows the repair/reset prompt.

Normalization UI tests:

- URL input with query updates to the stripped URL on blur.
- URL input with fragment updates to the stripped URL on blur.
- URL input with trailing slash updates to the stripped URL on blur.
- Root URL input updates from `https://x.com/` to `https://x.com`.
- The same normalization runs again before Save.

Permission UX tests:

- The editor shows the Safari website access warning.
- The warning does not block editing or saving.

## Native iOS Tests

Use XCTest for the containing app:

- The app opens to one onboarding screen.
- The onboarding screen includes the enable-extension steps.
- The Settings button attempts to open the app settings URL.
- The blocklist editor button sends the `openOptions` path into the extension bridge.
- The native app does not show or edit blocklist rows.

## Safari Integration Tests

Use a local fixture website with these pages:

- static allowed page
- static blocked page
- SPA page with client-side route buttons
- hash-route page
- form navigation page
- link navigation page

Simulator tests should cover:

- enabling the extension in the test host setup
- granting website access in the test host setup
- saving a blocklist through the options page
- direct navigation to a blocked URL
- direct navigation to an allowed same-host URL
- SPA route change from allowed to blocked
- hash route on a blocked path
- query string on a blocked path
- subdomain matching when the fixture host setup supports it
- entry removal followed by a fresh navigation
- Safari relaunch after saving the blocklist

Keep simulator tests small and stable. If Safari settings automation is unreliable, set up permissions manually for the simulator image and keep the automated flow focused on extension behavior.

## CI Requirements

Every pull request should run:

- shared extension unit tests
- background worker tests
- content script tests
- options page tests
- native XCTest tests when native files change
- lint or typecheck, if the project adds either tool

Blocking-behavior changes should also run Safari simulator integration tests before merge. Releases require the manual iPhone and iPad testing matrix because simulator behavior is not enough for final acceptance.

# Acceptance Criteria

- Directly opening a blocked URL is redirected to the extension blocked page.
- Navigating from an allowed page to a blocked SPA route is blocked by the content script path.
- URL blocking entries block the entered path across subdomains, with or without trailing slashes, and with any query or fragment.
- URL blocking including subpaths entries also block descendant paths.
- Allowed URLs on the same domain remain allowed when the rule is path-specific.
- Descendant paths remain allowed for URL blocking entries.
- Invalid regex entries fail before the blocklist is saved.
- The old blocklist remains active when a save fails.
- The implementation has no dependency on any third-party extension code.

# Implementation Notes

Keep the code small.

- One validation module.
- One matching module used by options and worker code.
- No framework unless the default Xcode template already includes one.
- No clever parsing. Use the URL parser, then fail loudly on unsupported input.
- No optional fields in stored entries.
- No hidden disabled state.

The most important invariant is that every redirect decision goes through the service worker's current saved state.

# Sources

- Apple, [Safari web extensions](https://developer.apple.com/documentation/safariservices/safari-web-extensions)
- Apple, [Managing Safari web extension permissions](https://developer.apple.com/documentation/safariservices/managing-safari-web-extension-permissions)
- Apple, [Blocking content with your Safari web extension](https://developer.apple.com/documentation/safariservices/blocking-content-with-your-safari-web-extension)
- Apple, [Packaging a web extension for Safari](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)
- Apple, [Running your Safari web extension](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension)
- Apple, [Safari 16.4 Release Notes](https://developer.apple.com/documentation/safari-release-notes/safari-16_4-release-notes)
- WebKit, [New WebKit Features in Safari 15.4](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/)
- WebKit, [WebKit Features in Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)
