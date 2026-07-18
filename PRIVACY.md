# Privacy Policy — Penny & Clearance Finder

_Last updated: 2026-07-18_

Penny & Clearance Finder ("the extension") is an unofficial Chrome extension
that helps you find in-store clearance and penny markdowns at your local
Home Depot store. This policy explains what the extension does and does not
do with your data.

**The short version: everything stays on your own computer. The developer
operates no server, receives no data, and runs no analytics.**

---

## What the extension stores

All of the following is stored **locally in your browser** (Chrome storage and
IndexedDB on your machine). None of it is transmitted to the developer or any
third party except as noted under "Telegram" below.

- **Your selected store** — the store ID and ZIP/city you search for.
- **Scan results** — clearance and penny items found, including product names,
  prices, SKUs, stock, and aisle locations.
- **Cached product lists** — the list of product IDs for your store, so repeat
  scans are faster.
- **Scan history and saved deals** — a local log of past scans and finds.
- **Your settings** — including, if you choose to connect it, your Telegram bot
  token and chat/channel ID.

You can clear all of this at any time by removing the extension or clearing its
storage from `chrome://extensions`.

## Data that leaves your browser

The extension makes network requests to only two destinations, both directly
from your browser:

1. **homedepot.com** — to look up products, prices, stock, and store
   information. These requests use your own existing browser session, exactly
   as if you were browsing the site yourself. The extension is not affiliated
   with or endorsed by The Home Depot, Inc.
2. **api.telegram.org** *(only if you enable Telegram alerts)* — to send deal
   notifications and receive scan commands through **your own** Telegram bot.
   Your bot token is stored locally and is sent only to Telegram's API to
   operate your bot. Deal alerts go only to the chat or channel you configure.
   If you never set up Telegram, no requests are made to Telegram.

## What the extension does NOT do

- It does **not** send any data to the developer or to any server operated by
  the developer.
- It does **not** use analytics, tracking, or advertising.
- It does **not** collect personally identifiable information, browsing
  history, or activity on sites other than homedepot.com.
- It does **not** sell or share your data with anyone.

## Permissions

The extension requests only the permissions it needs to function. Each is
explained in `STORE_LISTING.md`. In summary: storage (to save your data
locally), tabs/scripting (to run lookups through an open homedepot.com tab),
alarms (to keep long background scans running), and host access to
homedepot.com and api.telegram.org for the purposes described above.

## Changes

If this policy changes, the "Last updated" date above will change and the new
version will be published in this repository.

## Contact

Questions about this policy can be raised as an issue on the project's GitHub
repository.
