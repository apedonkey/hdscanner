# Chrome Web Store — submission notes

Reference for filling out the Chrome Web Store developer dashboard. None of
this ships in the extension; it's here so the listing fields are consistent
and ready to paste.

## Listing basics

- **Name:** Penny & Clearance Finder
- **Category:** Shopping
- **Summary (132 char max):** Find in-store clearance and penny markdowns at
  your local home-improvement store. Works on homedepot.com (unofficial).

## Single purpose (required field)

> Penny & Clearance Finder has one purpose: to help a shopper find in-store
> clearance and penny markdowns at their chosen Home Depot store by looking up
> product prices and stock through the shopper's own browser session, and
> optionally notifying them via their own Telegram bot.

## Permission justifications (required per permission)

- **storage / unlimitedStorage** — Saves your selected store, scan results,
  cached product lists, scan history, and settings locally in your browser.
  `unlimitedStorage` is used because a full store catalog and its scan history
  can exceed the default storage quota.
- **tabs** — Locates an open homedepot.com tab to route product/price lookups
  through, and detects when no such tab is open so the extension can prompt the
  user. It does not read browsing history or the contents of other tabs.
- **scripting** — Executes the lookup logic in the context of the open
  homedepot.com tab so requests carry the user's normal session.
- **alarms** — Keeps long background scans running in waves so a scan survives
  the popup being closed, without a persistent background page.
- **host permission: `https://*.homedepot.com/*`** — The extension looks up
  clearance prices, stock, and store data from homedepot.com using the user's
  own session. This is the site the extension is built to work with.
- **host permission: `https://api.telegram.org/*`** — Only used if the user
  enables optional Telegram alerts, to operate the user's own Telegram bot for
  deal notifications and remote scan control.

## Data-use disclosures (Privacy practices tab)

- **Does the extension collect user data?** Yes — but stored locally only; none
  is transmitted to the developer.
- Data handled (all stored on-device): store selection, scan results/history,
  and, if the user opts in, a Telegram bot token and chat ID.
- **Not collected:** browsing history, PII, location beyond a user-entered ZIP,
  analytics, or tracking.
- Certify: data is **not** sold or transferred to third parties; **not** used
  for anything unrelated to the single purpose; **not** used for creditworthiness
  or lending.
- **Privacy policy URL:** link to the hosted copy of `PRIVACY.md` (e.g. GitHub
  Pages or the raw file URL). A privacy policy URL is required because the
  extension handles user-provided data (the Telegram token).

## Required listing assets (not in repo — create before submitting)

- [ ] At least one screenshot, 1280×800 or 640×400 (PNG/JPEG). The popup is
      420px wide, so compose it on a padded/branded background at the required
      size rather than a raw 420px capture.
- [ ] 128×128 store icon — `icon128.png` can be reused.
- [ ] Optional: small promo tile 440×280.
- [ ] Detailed description (expand on the summary; state clearly that it is
      unofficial and not affiliated with The Home Depot, Inc.).

## Pre-submission checklist

- [x] Manifest V3, valid icons, action popup, service worker.
- [x] No remote code, `eval`, obfuscation, or hardcoded secrets.
- [x] Name/branding does not use "Home Depot" or "HD" or their brand color.
- [x] Penny Scan shows an accuracy disclaimer before running.
- [x] Privacy policy written (`PRIVACY.md`) — needs to be hosted at a public URL.
- [x] Permission justifications drafted (above).
- [ ] Privacy policy hosted and URL added to the dashboard.
- [ ] Screenshots and detailed description added to the dashboard.
- [ ] Detailed description includes a prominent "not affiliated" disclaimer.

## Remaining approval risk (judgment calls the paperwork can't remove)

- **Trademark:** the extension still functions only on homedepot.com and refers
  to it descriptively. This is nominative use, but a reviewer may still object.
  Keeping the "unofficial / not affiliated" disclaimer prominent reduces risk.
- **Scraping / rate-limit handling:** the extension backs off on 403/429 like a
  well-behaved client. Language framing this as evasion has been removed, but a
  reviewer could still view automated catalog lookups unfavorably.
