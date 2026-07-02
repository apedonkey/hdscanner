# Clearance Scanner (Home Depot)

A Chrome extension that finds **in-store clearance markdowns** at a specific Home Depot store — the yellow-tag and penny deals that don't show up on the website. It checks your store's inventory through your own logged-in browser session and shows you what's actually marked down right now.

> Not affiliated with, endorsed by, or connected to The Home Depot, Inc. All trademarks belong to their respective owners. Use it responsibly and at your own risk.

---

## What it does

- **Scan for Clearance** — walks your store's full catalog and surfaces advertised (yellow-tag) clearance that's in stock and marked down.
- **Penny Scan** — hunts for items dropped to $0.01 (deleted from inventory but often still on the shelf), with the store SKU to scan at self-checkout and the aisle/bay location.
- **Quick Recheck** — re-checks prices using the product list from your last full scan, so it skips the slow discovery step.
- **Saved / Compare / History** — keeps every find in a local database, compares the same item across stores, and logs your past scans.
- **Telegram alerts (optional)** — get a message the moment a deal is found, and control scans from your phone.

Everything runs locally in your browser. Nothing you scan is sent anywhere except (optionally) to *your own* Telegram bot.

---

## Requirements

- Google Chrome (or a Chromium browser that supports Manifest V3 extensions).
- A **homedepot.com tab open** while scanning — the extension routes its lookups through your real session, so keep one open. Being signed in to your Home Depot account helps accuracy.

---

## Install

Because this isn't on the Chrome Web Store, you load it in developer mode. Takes about a minute.

1. **Download the code.**
   - Easiest: on the GitHub page click **Code ▸ Download ZIP**, then unzip it somewhere permanent (don't delete the folder afterward — Chrome loads it from where it sits).
   - Or, with git: `git clone https://github.com/apedonkey/hdscanner.git`
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the folder you just unzipped/cloned (the one containing `manifest.json`).
5. The **Clearance Scanner** icon (orange price tag) appears in your toolbar. Pin it for easy access.

To update later: download the newer version over the same folder, then hit the refresh icon on the extension's card at `chrome://extensions`.

---

## How to use it

1. Open a **homedepot.com** tab and leave it open.
2. Click the extension icon.
3. Under **Your Store**, type a ZIP code, hit **Find**, and pick your store.
4. Click **Scan for Clearance**. The scan runs in three steps:
   - **Step 1 — mapping departments:** builds the list of departments your store carries.
   - **Step 2 — collecting products:** gathers every product ID (this list is cached for next time).
   - **Step 3 — checking prices:** the actual hunt for markdowns.
5. The scan runs in the **background** — you can close the popup and it keeps going. Results fill in as they're found.

After a full scan, **Quick Recheck** and **Penny Scan** reuse the cached product list and are much faster.

**A note on speed:** Home Depot rate-limits aggressive requests. The scanner paces itself on purpose. If you see it slow down or pause with a "cooling down" message, that's it staying under the radar — let it run. Hammering the API just gets you temporarily blocked (403 errors); if that happens, wait a while before scanning again. There's a **Test API Connection** button under *Advanced tools* to check whether you're clear.

---

## Telegram alerts (optional)

Get deals pushed to Telegram and control scans remotely. Each person uses their **own** bot — nothing is shared.

1. In the popup, expand **Telegram Alerts**.
2. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and follow the prompts. Copy the **token** it gives you.
3. Paste the token into the extension and click **Connect**.
4. Open Telegram and send **/start** to your new bot. The extension auto-detects your chat and connects.
5. (Optional) To broadcast finds to a **channel** instead of your private chat: add your bot as an **admin** of the channel, then enter the channel's `@name` in the "Deals post to" field. Remote controls always stay in your private chat.

Once connected, send `/menu` to your bot for buttons to start scans, run a penny scan, check status, or stop a scan — all from your phone. (The scan still runs on the computer with the extension and an open Home Depot tab.)

---

## Privacy

- Scan results, your store selection, and saved deals live in **your browser** (Chrome storage + IndexedDB on your machine).
- Home Depot lookups go directly from your browser to Home Depot, using your own session.
- If you connect Telegram, deal alerts go **only** to the bot/channel you set up. Your bot token is stored locally and never leaves your browser except to talk to Telegram's API.
- No analytics, no external server, nothing phoned home to the developer.

---

## Troubleshooting

- **"Open homedepot.com first"** — you need a homedepot.com tab open in the same window. Open one and reopen the popup.
- **Lots of 403s / "rate limited"** — Home Depot is throttling you. Stop, wait a while (15 min to a few hours), and try again. Check your computer's clock is set correctly, too — a wrong clock can cause API errors.
- **Scan seems stuck at "waiting for tab"** — make sure a homedepot.com tab is still open; the background scanner needs it to make requests.
- **Nothing found** — clearance changes daily and varies by store. Try again later or scan a different store.

---

## How it works (short version)

The extension calls Home Depot's own product/pricing API from within your browser tab, so requests carry your normal session — that's why a homedepot.com tab has to be open. A background service worker drives long scans in waves so they survive you closing the popup, and paces requests to avoid tripping bot detection. Clearance detection keys on Home Depot's advertised-clearance ("yellow tag") signal; penny detection uses a fingerprint of price + fulfillment state.
