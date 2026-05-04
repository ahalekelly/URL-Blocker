# iOS Safari MV3 Website Blocker Spec

This document is a recommendation, not a set of hard rules. Any choice here can be changed as needed during implementation if testing or product judgment shows a better path.

This spec describes a simple iOS Safari website blocker. The app blocks user-entered URL patterns, including whole domains, page URLs, URL subtrees, and validated regular expressions.

The core requirement is SPA-safe blocking: if a user starts on an allowed page and the site changes the address bar with client-side routing, the app must still block the new URL when it matches the blocklist.

# Short Answer

Build the full iOS app with a packaged Safari Web Extension.

- Use Manifest V3 and `declarativeNetRequest` dynamic rules for normal top-level navigations.
- Use a content script to catch single-page-app route changes after a page is already loaded.
- Use a simple extension options page for the blocklist editor.
- Make the native containing app the only user-facing entry point for opening the blocklist editor.
- Do not expose a blocklist editor item or popup from Safari's Extensions menu.
- Do not use a Safari Content Blocker as the main architecture, because it cannot reliably catch URL-only client-side route changes.

# Goals

- Block direct navigation to a blocked URL.
- Block SPA route changes to a blocked URL.
- Allow other URLs on the same host when the rule is path-specific.
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

- Fragments are visible to the content script.
- Fragments are not sent in HTTP requests, so DNR cannot enforce fragment-specific rules before the page loads.
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
- The background service worker validates saves and updates DNR dynamic rules.
- A content script observes current page URLs and catches SPA route changes.
- An options page edits the blocklist and is opened from the native app.
- A blocked page gives the user a clear destination when a block occurs.

## Extension Files

The extension should contain these files:

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest, permissions, content script, options page, blocked page resources |
| `background.js` | validation, storage writes, DNR dynamic rule updates, tab redirection |
| `content.js` | URL monitor for initial loads and SPA route changes |
| `options.html` / `options.js` | blocklist editor |
| `blocked.html` / `blocked.js` | blocked-page UI |
| icons | app and extension icon assets |

# Manifest Requirements

Target iOS/iPadOS 16.4 or newer for Safari Web Extension reliability. Safari 15.4 added MV3 service workers and DNR dynamic/session rules, while Safari 16.4 fixed several DNR and service-worker issues.

Required permissions:

- `storage`
- `tabs`
- `declarativeNetRequestWithHostAccess`

Required host access:

- `http://*/*`
- `https://*/*`

Required extension surfaces:

- MV3 service worker background.
- Static content script on `http://*/*` and `https://*/*`.
- Content script runs at `document_start`.
- Options page for editing.
- No extension action, popup, or Safari Extensions menu item for editing the blocklist.
- `blocked.html` listed as a web-accessible extension resource if DNR redirects to it.

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
6. Grant website access.

The app should recommend "All Websites" for reliable blocking. Per-site grants are allowed, but the app must show that blocking only works on sites where Safari has granted extension access.

The extension must behave gracefully when access is missing:

- DNR rules may not redirect as expected without site permission.
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

There is no disabled state in v1. A row exists or it does not. This keeps matching and rule generation easy to reason about.

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
- Must be accepted by `declarativeNetRequest.isRegexSupported`.
- Must match against the normalized DNR-visible URL string, which has no fragment.
- Must be case-insensitive in both DNR and content-script matching.
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

Matching strings:

- DNR URL matching string: normalized URL without fragment. Generated DNR regexes still allow any query suffix because DNR sees query strings.
- Content-script URL matching string: normalized URL with query, fragment, and trailing slashes stripped.

This keeps URL-based rules path-based even when the live page URL has tracking parameters or a hash route.

# Matching Semantics

Every matcher must have a JavaScript predicate and, when possible, a DNR rule.

URL predicates:

- Match `http` and `https` regardless of which scheme the user entered.
- Match the stored host and any subdomain of the stored host.
- Ignore query strings.
- Ignore fragments.
- Ignore trailing slashes.

URL blocking:

- Match the stored path with or without trailing slashes.
- Do not match descendant paths.

Generated URL blocking regex shape for a URL with no query, fragment, or trailing slash:

```regex
^https?://(?:[^./?#]+\.)*<escaped-host><escaped-path>/*(?:\?[^#]*)?$
```

The URL blocking content-script predicate strips query, fragment, and trailing slashes before matching, then uses this shape:

```regex
^https?://(?:[^./?#]+\.)*<escaped-host><escaped-path>$
```

URL blocking including subpaths:

- Match the stored path with or without trailing slashes.
- Match descendant paths.
- Do not match sibling paths that only share the same text prefix.

Generated URL blocking including subpaths regex shape for a URL with no query, fragment, or trailing slash:

```regex
^https?://(?:[^./?#]+\.)*<escaped-host><escaped-path>(?:/[^?#]*)?(?:\?[^#]*)?$
```

The URL blocking including subpaths content-script predicate strips query, fragment, and trailing slashes before matching, then uses this shape:

```regex
^https?://(?:[^./?#]+\.)*<escaped-host><escaped-path>(?:/[^?#]*)?$
```

- DNR regexes allow any query suffix because queries are present in request URLs.
- The content script strips query, fragment, and trailing slashes first so SPA and hash-route changes use the same URL behavior.
- If the user enters a query, fragment, or trailing slash in a URL-based entry, normalization removes it and the options page updates the input field to the stripped URL.
- When the stored path is empty, use an empty `<escaped-path>` so the root URL still matches with or without trailing slashes.

Domain predicate:

- Match exact host.
- Match any subdomain.
- Match all paths, queries, and fragments on matching hosts.

Regex predicate:

- Match the normalized DNR-visible URL string, which has no fragment.
- Use case-insensitive matching.
- Reject regexes that behave differently in JavaScript and DNR.

# Rule Generation

The background service worker is the only component that writes DNR dynamic rules.

Save flow:

1. Options page sends the complete proposed blocklist to the service worker.
2. Service worker validates all entries.
3. Service worker converts entries to DNR rules where possible.
4. Service worker asks Safari whether generated regex rules are supported.
5. Service worker removes existing app-owned dynamic rule IDs.
6. Service worker adds the new dynamic rules.
7. Service worker writes the validated state to storage.
8. Service worker returns the validated normalized state to the options page.
9. Service worker broadcasts a blocklist-changed message to open tabs.

The save must be transactional from the user's perspective. If DNR update fails, keep the old storage state and show the error.

Rule IDs:

- Reserve IDs `1...1000` for blocklist DNR rules.
- Assign IDs by array index plus one.
- Rebuild all app-owned DNR rules on every save.
- Do not preserve DNR rule IDs as stable user-facing identifiers.

DNR actions:

- Prefer `redirect` to `/blocked.html` for top-level navigation.
- If redirect is not reliable on a tested iOS Safari version, use `block` as the fallback action and keep the SPA blocked page for content-script redirects.
- Do not use `modifyHeaders`.
- Do not use `regexSubstitution` in v1; it creates extra compatibility risk and is not needed for simple blocking.

DNR conditions:

- Limit rules to `main_frame`.
- Set case sensitivity explicitly instead of relying on browser defaults.
- Use generated regex filters for Full domain blocking, URL blocking, and URL blocking including subpaths entries so the DNR rule matches the JavaScript predicate as closely as Safari permits.
- URL-based entries always generate DNR rules because query strings, fragments, and trailing slashes are stripped before storage.

# SPA Route Blocking

DNR only sees requests that reach Safari's network/request layer. A single-page app can change the visible URL without a top-level document request. The content script exists to close that gap.

The content script must:

- Run on `http` and `https` pages at `document_start`.
- Load the current blocklist snapshot.
- Check `location.href` on startup.
- Re-check when the visible URL changes.
- Redirect blocked URLs quickly without waiting for a full page refresh.

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

When the content script finds a match:

1. It sends the normalized current URL and matched entry ID to the service worker.
2. The service worker checks the URL against the current saved state again.
3. If still blocked, the service worker updates the tab to the extension blocked page.
4. The blocked page receives the blocked URL in the fragment for display.

Never trust the content script as the final authority. The service worker re-check prevents stale content scripts from blocking after a user removes a rule.

# Blocked Page

The blocked page should be minimal:

- Title: `Blocked`
- Show the blocked host or full URL when available.
- Button: `Close`

The Close button closes the current tab by calling `browser.tabs.getCurrent()` from `blocked.js`, then `browser.tabs.remove(tab.id)`.

For DNR redirects, the blocked page may not know the original URL in v1. In that case it shows a generic blocked message.

For content-script SPA redirects, pass the blocked URL in the fragment, not the query string. Fragments are not sent as HTTP requests.

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
| `getState` | options/content/blocked page | service worker | Read the current saved blocklist |
| `saveState` | options page | service worker | Validate, update DNR, save state |
| `urlMatched` | content script | service worker | Ask worker to block the current SPA route |
| `openOptions` | native app | service worker | Open the editor |

Unknown message types must raise an error. Do not silently ignore them.

# Failure Modes

Invalid blocklist:

- Do not update DNR.
- Do not update storage.
- Show validation errors.

DNR update failure:

- Keep old rules and old storage.
- Show the DNR error.
- Ask the user to reduce rule count if the error is quota-related.

Missing Safari website access:

- The options page remains usable.
- Blocking may not occur on denied sites.
- Show setup guidance.

Service worker suspended:

- DNR rules still handle direct navigations.
- Content scripts reload state from storage and can wake the worker with messages.

Stale content script:

- Service worker re-checks the URL before redirecting.

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
| Root only | Block `https://reddit.com` | Root is blocked; `/r/safari` is allowed |
| Domain | Block `example.com` | `example.com` and subdomains are blocked |
| Regex valid | Add an anchored regex for two paths | Matching paths block; non-matching paths allow |
| Regex invalid | Add unsupported regex | Save fails and old rules remain active |
| URL input with query | Add `https://x.com/home?foo=bar` | Input updates to `https://x.com/home`; save blocks `/home` with any query |
| URL input with fragment | Add `https://x.com/home#feed` | Input updates to `https://x.com/home`; save blocks `/home` with any fragment |
| URL input with trailing slash | Add `https://x.com/home/` | Input updates to `https://x.com/home`; save blocks `/home` and `/home/` |
| Root URL input | Add `https://x.com/` | Input updates to `https://x.com`; save blocks `https://x.com` and `https://x.com/` |
| Hash route on blocked path | Block `https://x.com/home` | `/home#feed` is blocked |
| Permission denied | Deny website access for a test site | Editor works; site is not reliably blocked; warning is visible |
| Safari restart | Save rules, force quit Safari, reopen blocked URL | Direct navigation is still blocked |
| Rule removal | Remove a rule and save | Previously blocked URL is allowed after refresh/new navigation |
| Stale tab | Remove a rule while old tab is open | Content script does not keep blocking after service worker re-check |

# Automated Test Suite Plan

Automated tests should prove the blocker contract before device testing. Keep most tests close to pure code, then use Safari/iOS automation only for behavior that depends on Safari itself.

## Automated Test Targets

| Target | Suggested tool | Runs | Verifies |
|---|---|---|---|
| Shared extension unit tests | JavaScript test runner | Every commit | normalization, validation, matching, DNR rule generation |
| Background worker tests | JavaScript tests with explicit browser API fakes | Every commit | message handling, transactional saves, DNR/storage updates, SPA re-checks |
| Content script tests | DOM-capable JavaScript tests | Every commit | startup checks, route-change detection, stale blocklist behavior |
| Options page tests | DOM-capable JavaScript tests | Every commit | row editing, validation errors, save flow, normalized field updates |
| Native iOS tests | XCTest | Native app changes | onboarding screen, settings button, blocklist editor launch button |
| Safari integration tests | Xcode UI tests on simulator | Before merge when blocker behavior changes | extension wiring, direct navigation blocking, SPA blocking, persistence |
| Device smoke tests | iPhone and iPad release checklist | Before release | real Safari permission behavior and extension reliability |

Use one shared fixture table for normalization, matching, DNR generation, and integration tests. Each fixture should include:

- entry kind
- raw user input
- normalized stored entry
- URLs that must block
- URLs that must allow
- expected DNR regex shape when a rule is generated

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
- Regex rules match the normalized DNR-visible URL string with no fragment.

DNR generation tests:

- Rule IDs are array index plus one.
- Only app-owned rule IDs `1...1000` are removed or replaced.
- Rules are limited to `main_frame`.
- Rule actions redirect to `blocked.html` by default.
- Case sensitivity is set explicitly.
- Domain, URL, and URL-with-subpaths rules generate regex filters.
- URL regex filters allow query suffixes.
- URL regex filters do not allow descendant paths for plain URL rules.
- URL-with-subpaths regex filters allow descendants without matching text prefixes.
- Generated regexes are checked with `declarativeNetRequest.isRegexSupported`.
- Generated DNR regex behavior matches the JavaScript predicate for every shared fixture, except that DNR cannot see fragments.

## Background Worker Tests

Message protocol tests:

- `getState` returns the saved state.
- `saveState` accepts only a complete replacement state.
- `urlMatched` re-checks the URL against current saved state before redirecting.
- `openOptions` opens the options page.
- Unknown message types raise an error.
- Invalid message shapes raise an error.

Save flow tests:

- Successful save validates entries, checks DNR regex support, updates dynamic rules, writes storage, returns normalized state, and broadcasts `blocklist-changed`.
- Failed validation does not update DNR or storage.
- Failed DNR support check does not update DNR or storage.
- Failed dynamic rule update does not write storage.
- Failed dynamic rule update leaves the previous active rules intact or restores them.
- Failed storage write reports an error and does not report success to the options page.
- Removing a rule and saving rebuilds the app-owned dynamic rules from the new list.

SPA blocking tests:

- A matching `urlMatched` message redirects the tab to the extension blocked page.
- A non-matching `urlMatched` message does nothing.
- A stale content script cannot block a URL after the matching entry was removed.
- The blocked URL is passed to the blocked page in the fragment.

## Content Script Tests

Startup and state tests:

- The script loads the current state from storage on startup.
- The script checks `location.href` on startup.
- The script reloads state after a `blocklist-changed` message.
- Invalid stored state raises an error instead of silently allowing unknown shapes.

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

Blocking tests:

- Matching URLs send `urlMatched` to the service worker.
- Non-matching URLs do not send `urlMatched`.
- Query strings, fragments, and trailing slashes are stripped before matching URL-based entries.
- Multiple rapid URL changes send only the latest blocked URL when practical.

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
- rule removal followed by a fresh navigation
- Safari relaunch after saving rules

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

- Directly opening a blocked URL is blocked by DNR.
- Navigating from an allowed page to a blocked SPA route is blocked by the content script path.
- URL blocking entries block the entered path across subdomains, with or without trailing slashes, and with any query or fragment.
- URL blocking including subpaths entries also block descendant paths.
- Allowed URLs on the same domain remain allowed when the rule is path-specific.
- Descendant paths remain allowed for URL blocking entries.
- Invalid regex entries fail before rules are saved.
- The old blocklist remains active when a save fails.
- The implementation has no dependency on any third-party extension code.

# Implementation Notes

Keep the code small.

- One validation module.
- One matching module shared by options, content, and worker code if the build setup permits it.
- One DNR rule generation module.
- No framework unless the default Xcode template already includes one.
- No clever parsing. Use the URL parser, then fail loudly on unsupported input.
- No optional fields in stored entries.
- No hidden disabled state.

The most important invariant is parity between DNR matching and content-script matching. If an entry cannot be represented safely in DNR, mark it as content-script-only and warn the user.

# Sources

- Apple, [Safari web extensions](https://developer.apple.com/documentation/safariservices/safari-web-extensions)
- Apple, [Managing Safari web extension permissions](https://developer.apple.com/documentation/safariservices/managing-safari-web-extension-permissions)
- Apple, [Blocking content with your Safari web extension](https://developer.apple.com/documentation/safariservices/blocking-content-with-your-safari-web-extension)
- Apple, [Packaging a web extension for Safari](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari)
- Apple, [Running your Safari web extension](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension)
- Apple, [Safari 16.4 Release Notes](https://developer.apple.com/documentation/safari-release-notes/safari-16_4-release-notes)
- WebKit, [New WebKit Features in Safari 15.4](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/)
- WebKit, [WebKit Features in Safari 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)
- MDN, [declarativeNetRequest](https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest)
- MDN, [declarativeNetRequest Redirect](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest/Redirect)
