# Suggested UI Improvements

1. Make the top of the options page a compact dashboard.
   Show the current schedule, reset mode, enabled block groups, and sync state in one scan-friendly header so users know what URL Blocker is doing before editing details.

2. Move screen time into a dedicated statistics view.
   Keep the options page focused on configuration, then use a separate page for totals, trends, over-limit domains, device sync freshness, and reset-window explanations.

3. Collapse large default block groups.
   Start each group collapsed to its title, enabled state, and limit, with a disclosure for individual URLs. This would make the blocklist easier to skim as defaults grow.

4. Add search and filters for block rules.
   Let users quickly find a domain, show only disabled entries, show only custom entries, or show only groups over their time limit.

5. Make schedule and limit reset settings explain their effect.
   Add a short generated summary such as "Blocking every day from 11:00 PM to 7:00 PM" or "Usage resets on a rolling 16-hour window" near those controls.

6. Improve custom row creation.
   Replace the blank row with a focused add flow that asks for matcher type, value, and limit together, then inserts a validated row when the entry is complete.

7. Add a blocked-page preview.
   Put a preview next to the HTML editor or behind a Preview button, plus a Restore Default action, so users can safely edit the blocked-page message.

8. Clarify sync states.
   Once signed in, hide sign-in buttons and show account status, last sync time, pending local changes, Sync Now, and Sign Out in a compact row.

9. Make website access repair more actionable.
   When access is missing, list the exact domains that need permission and keep the primary action focused on granting those permissions.

10. Tighten mobile ergonomics.
    Keep group titles, enabled toggles, limit fields, and the floating Save button reachable without horizontal scanning, especially on narrow iPhone Safari views.
