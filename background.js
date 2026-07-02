// Background service worker - runs independently of popup/page
// Handles long-running scans that persist across tab switches.
//
// Storage keys owned by this file:
//   scanState  — resume data for the current/last scan (NO skus, see scanSkus)
//   scanSkus   — the SKU list for the current/last scan, written once per scan
//   clearanceItems — found items, updated per wave (popup reads this)
//   telegramConfig — per-user Telegram connection
//     {botToken, chatId, chatLabel, botUsername, dealsChannel}
//     chatId = private control chat (menus/status/progress);
//     dealsChannel = optional channel (@name or -100... id) that receives the
//     actual deal alerts — the bot must be an admin there. When unset, deals
//     go to the control chat.
//   telegramLastUpdateId — getUpdates cursor
// The popup must never write scanState/scanSkus except to delete them (Discard).

// ============================================================
// ==================== STORE NAMES ===========================
// ============================================================

// Dynamic store name mapping — loaded from storage, populated by store search
let STORE_NAMES = {};

async function loadStoreNames() {
  try {
    const data = await chrome.storage.local.get(['savedStores']);
    if (data.savedStores) {
      STORE_NAMES = data.savedStores;
    }
  } catch (e) {
    console.warn('[Background] Failed to load store names:', e);
  }
}
loadStoreNames();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.savedStores) {
    STORE_NAMES = changes.savedStores.newValue || {};
  }
  // Keep the in-memory Telegram config in sync if another context edits it
  if (changes.telegramConfig) {
    telegramConfig = changes.telegramConfig.newValue || null;
    if (telegramEnabled()) telegramPollLoop();
  }
});

// ============================================================
// ==================== TELEGRAM CONFIG =======================
// ============================================================
// Each user connects their OWN bot (via @BotFather) from the popup.
// Nothing is hardcoded; without a config all Telegram features are inert.

let telegramConfig = null;
let telegramLastError = null;

const telegramConfigReady = chrome.storage.local.get(['telegramConfig']).then((data) => {
  telegramConfig = data.telegramConfig || null;
});

function telegramEnabled() {
  return !!(telegramConfig && telegramConfig.botToken && telegramConfig.chatId);
}

// Telegram messages use parse_mode HTML — any dynamic text (product names,
// store names, user queries) must be escaped or Telegram rejects the message.
function escapeTg(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function telegramApiWithToken(token, method, body) {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    try {
      return await resp.json();
    } catch (e) {
      return { ok: false, error_code: resp.status, description: 'parse_error' };
    }
  } catch (e) {
    return { ok: false, description: e.message || 'fetch_failed' };
  }
}

async function telegramApi(method, body) {
  if (!telegramEnabled()) return { ok: false, description: 'not_configured' };
  return telegramApiWithToken(telegramConfig.botToken, method, body);
}

// Send a message to a specific chat/channel
async function sendTelegramMessage(chatId, message) {
  if (!telegramEnabled()) {
    return { success: false, error: 'Telegram not connected' };
  }
  const result = await telegramApi('sendMessage', {
    chat_id: chatId,
    text: message,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
  if (!result.ok) {
    console.error('[Telegram] Send error:', result.description, result.error_code);
    return { success: false, error: result.description };
  }
  return { success: true };
}

// Send to the private control chat (menus, status, operational messages)
async function sendToTelegram(message) {
  if (!telegramEnabled()) return { success: false, error: 'Telegram not connected' };
  return sendTelegramMessage(telegramConfig.chatId, message);
}

// Send to the deals channel — falls back to the control chat when no channel
// is configured. Used for the actual finds + scan start/complete summaries.
async function sendToDealsChannel(message) {
  if (!telegramEnabled()) return { success: false, error: 'Telegram not connected' };
  return sendTelegramMessage(telegramConfig.dealsChannel || telegramConfig.chatId, message);
}

// Normalize user input for a channel: accepts "@name", "name", "t.me/name",
// "https://t.me/name", or a raw numeric id like -1001234567890.
function normalizeChannelInput(input) {
  let v = String(input || '').trim();
  v = v.replace(/^https?:\/\//i, '').replace(/^t\.me\//i, '');
  if (/^-?\d+$/.test(v)) return v;
  v = v.replace(/^@/, '');
  return v ? `@${v}` : null;
}

// ============================================================
// ==================== TELEGRAM FORMATTERS ===================
// ============================================================

function formatClearanceItem(item, storeId) {
  const storeName = escapeTg(STORE_NAMES[storeId] || storeId);
  const percentOff = Math.round(item.percentOff || 0);
  const locationLine = item.location ? `\n📍 ${escapeTg(item.location)}` : '';

  return `🏷️ <b>${escapeTg(item.name)}</b>
💰 $${(item.clearancePrice || 0).toFixed(2)} (${percentOff}% off)
🏪 <b>${storeName}</b> (#${escapeTg(storeId)})${locationLine}
📦 Qty: ${escapeTg(item.quantity)} | SKU: ${escapeTg(item.itemId)}
🔗 <a href="${escapeTg(item.url)}">View Product</a>`;
}

function formatPennyItem(item, storeId) {
  const storeName = escapeTg(STORE_NAMES[storeId] || storeId);
  const percentOff = Math.round(item.percentOff || 0);
  const tier = (item.pennyConfidence || '').toUpperCase();
  const header = tier === 'CONFIRMED' ? '🪙 <b>CONFIRMED PENNY</b>'
              : tier === 'HIGH'      ? '🪙 <b>HIGH-CONFIDENCE PENNY</b>'
              : '🪙 <b>POSSIBLE PENNY</b>';
  const priceStr = `$${(item.clearancePrice || item.onlinePrice || 0).toFixed(2)}`;
  const retailStr = item.onlinePrice && item.onlinePrice > 0.01
    ? ` — was $${item.onlinePrice.toFixed(2)}`
    : '';
  const scanLine = item.storeSkuNumber
    ? `🔢 Store SKU: <code>${escapeTg(item.storeSkuNumber)}</code> (scan this at self-checkout)`
    : `🔢 Item ID: <code>${escapeTg(item.itemId)}</code>`;
  const locationLine = item.location ? `\n📍 ${escapeTg(item.location)}` : '';
  // HD returns sellable quantity (reserved/damaged subtracted), so the number
  // is a lower bound — actual on-hand is often higher. The "+" reflects that.
  const qtyLine = item.storeQuantity != null
    ? `📦 ${escapeTg(item.storeQuantity)}+ in stock`
    : `📦 Stock unknown — check in store`;

  return `${header}
🏷️ ${escapeTg(item.name)}
💰 ${priceStr}${retailStr}${percentOff ? ` (${percentOff}% off)` : ''}
${qtyLine}
${scanLine}
🏪 <b>${storeName}</b> (#${escapeTg(storeId)})${locationLine}
🔗 <a href="${escapeTg(item.url)}">View Product</a>`;
}

// ============================================================
// ==================== NOTIFICATION QUEUE ====================
// ============================================================
// Found-item notifications are queued and sent concurrently with the scan
// instead of blocking the wave loop (each send costs ~0.5-1s).

const telegramQueue = [];
let telegramDrainPromise = null;

function queueTelegramItem(item, storeId, penny) {
  if (!telegramEnabled()) return;
  telegramQueue.push({ item, storeId, penny });
  if (!telegramDrainPromise) {
    telegramDrainPromise = drainTelegramQueue().finally(() => {
      telegramDrainPromise = null;
    });
  }
}

async function drainTelegramQueue() {
  while (telegramQueue.length > 0) {
    const { item, storeId, penny } = telegramQueue.shift();
    const message = penny ? formatPennyItem(item, storeId) : formatClearanceItem(item, storeId);
    const result = await sendToDealsChannel(message);
    if (!result.success) {
      console.error(`[Telegram] Failed to send item ${item.itemId}: ${result.error}`);
    }
    // Stay well under Telegram's per-chat rate limit
    await new Promise(r => setTimeout(r, 500));
  }
}

// Wait for all queued notifications to go out (used before completion messages)
async function flushTelegramQueue() {
  while (telegramDrainPromise) {
    await telegramDrainPromise;
  }
}

// ============================================================
// ==================== SCAN STATE ============================
// ============================================================

// Only items above this discount qualify for the normal scan's results
// (penny scans bypass it). The isAdvertised (yellow-tag) requirement is
// intentional and load-bearing — do not remove.
const MIN_PERCENT_OFF = 50;

let scanState = {
  running: false,
  storeId: null,
  total: 0,
  currentIndex: 0,
  clearanceItems: [],
  checked: 0,
  errors: 0,
  startTime: null,
  scanType: null,
  userStopped: false,
  totalClearanceSeen: 0,
  totalFilteredOut: 0
};

let scanLoopActive = false;
// Monotonic loop ID. A new runScanLoop invocation increments this; any older
// loop that resumes from an await will see its captured myLoopId no longer
// matches currentLoopId and exit without touching storage or messaging.
let currentLoopId = 0;

// scanState minus the (potentially large) in-memory item list
function persistableState(state) {
  const { clearanceItems, ...rest } = state;
  return rest;
}

// Begin a brand-new scan. The SKU list is persisted ONCE here — the per-wave
// persist only writes the small progress cursor + found items.
function startScan(storeId, skus, scanType) {
  scanState = {
    running: true,
    storeId,
    total: skus.length,
    currentIndex: 0,
    clearanceItems: [],
    checked: 0,
    errors: 0,
    startTime: Date.now(),
    scanType: scanType || 'unknown',
    userStopped: false,
    totalClearanceSeen: 0,
    totalFilteredOut: 0
  };
  chrome.storage.local.set({
    scanSkus: skus,
    scanState: persistableState(scanState),
    clearanceItems: []
  });
  runScanLoop(scanState, skus);
}

// Load resume data from storage. Returns null when there is nothing to resume.
// Handles the legacy shape where skus were embedded inside scanState.
async function loadResumeData() {
  const data = await chrome.storage.local.get(['scanState', 'scanSkus', 'clearanceItems']);
  const st = data.scanState;
  if (!st) return null;
  const skus = (Array.isArray(data.scanSkus) && data.scanSkus.length > 0)
    ? data.scanSkus
    : (Array.isArray(st.skus) ? st.skus : []);
  if (skus.length === 0) return null;
  if (typeof st.currentIndex !== 'number' || st.currentIndex >= skus.length) return null;
  return { st, skus, items: Array.isArray(data.clearanceItems) ? data.clearanceItems : [] };
}

function beginScanFromResume({ st, skus, items }) {
  scanState = {
    running: true,
    storeId: st.storeId,
    total: skus.length,
    currentIndex: st.currentIndex,
    clearanceItems: items,
    checked: st.checked || 0,
    errors: st.errors || 0,
    startTime: st.startTime || Date.now(),
    scanType: st.scanType || 'unknown',
    userStopped: false,
    totalClearanceSeen: st.totalClearanceSeen || 0,
    totalFilteredOut: st.totalFilteredOut || 0
  };
  // Migrate legacy embedded-skus state to the split shape
  chrome.storage.local.set({ scanSkus: skus, scanState: persistableState(scanState) });
  runScanLoop(scanState, skus);
}

// ============================================================
// ==================== KEEP-ALIVE / ALARMS ===================
// ============================================================
// chrome.alarms persist across service worker restarts; setInterval does not.

function startKeepAlive() {
  chrome.alarms.create('scanKeepAlive', { periodInMinutes: 0.5 });
  console.log('[Background] Keep-alive alarm started');
}

function stopKeepAlive() {
  chrome.alarms.clear('scanKeepAlive');
  console.log('[Background] Keep-alive alarm cleared');
}

// Safety net for the Telegram long-poll — restarts it if the worker died.
chrome.alarms.create('telegramPollCheck', { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'telegramPollCheck') {
    await telegramConfigReady;
    if (telegramEnabled() && !telegramPollActive) {
      console.log('[Telegram] Alarm: restarting poll loop');
      telegramPollLoop();
    }
    return;
  }

  if (alarm.name !== 'scanKeepAlive') return;

  // Touch storage to show activity and extend worker lifetime
  chrome.storage.local.set({ keepAlive: Date.now() });

  if (scanLoopActive) return;

  // Scan loop is NOT active — check storage for a scan that needs resuming
  const resume = await loadResumeData();
  if (resume && !resume.st.userStopped) {
    console.log('[Background] Alarm: scan loop died, resuming from index', resume.st.currentIndex);
    beginScanFromResume(resume);
  } else {
    console.log('[Background] Alarm: no scan to resume, clearing alarm');
    stopKeepAlive();
  }
});

// ============================================================
// ==================== TAB PLUMBING ==========================
// ============================================================
// Service worker can't use HD session cookies directly — all HD API calls are
// routed through a content script on an open homedepot.com tab (intentional:
// requests must carry the user's real session/fingerprint).

async function findHdTab() {
  // URL match-pattern filter in chrome.tabs.query silently misses tabs in
  // some states (discarded tabs, pending navigations, host-permission quirks
  // after reload). Query all tabs and substring-match instead.
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    console.warn('[Background] findHdTab: tabs.query failed:', e && e.message);
    return null;
  }
  const isHd = (t) => {
    const u = t.url || t.pendingUrl || '';
    return /^https?:\/\/([^/]+\.)?homedepot\.com(\/|$|\?|#)/i.test(u);
  };
  const active = tabs.find(t => isHd(t) && t.active);
  if (active) return active.id;
  const any = tabs.find(isHd);
  if (!any) {
    // Most common cause: the tab was opened before the extension was reloaded,
    // so Chrome hasn't granted host permission for its URL to the new worker.
    const urlSample = tabs.slice(0, 20).map(t => ({
      id: t.id,
      url: t.url || t.pendingUrl || '(no url visible to extension)',
      active: !!t.active,
      windowId: t.windowId
    }));
    console.log('[Background] findHdTab: no HD tab among', tabs.length, 'tabs. Sample:', JSON.stringify(urlSample, null, 2));
  }
  return any ? any.id : null;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
  } catch (e) {
    console.log('[Background] Injecting content script into tab', tabId);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['db.js', 'content.js']
    });
    await new Promise(r => setTimeout(r, 500));
  }
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// Penny batch check — products() batch endpoint with penny fingerprint
function checkPennyBatchViaTab(tabId, skus, storeId) {
  return sendToTab(tabId, { action: 'checkPennyBatch', skus, storeId });
}

// Pass 1: pricing + fulfillment only, 80 SKUs per wave (5 parallel × 16)
function checkSkuBatchLightViaTab(tabId, skus, storeId) {
  return sendToTab(tabId, { action: 'checkSkuBatchLight', skus, storeId });
}

// Pass 2: names/brands/URLs for clearance hits (Telegram notifications)
function getProductDetailsViaTab(tabId, skus, storeId) {
  return sendToTab(tabId, { action: 'getProductDetailsBatch', skus, storeId });
}

function lookupAisleBayViaTab(tabId, storeId, storeSkuIds) {
  return sendToTab(tabId, { action: 'lookupAisleBay', storeId, storeSkuIds });
}

async function clearFulfillmentLogViaTab(tabId) {
  try {
    return (await sendToTab(tabId, { action: 'db_clearFulfillmentLog' })) || { success: false };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function getFulfillmentLogViaTab(tabId, scanId = null) {
  try {
    return (await sendToTab(tabId, { action: 'db_getFulfillmentLog', scanId })) || { success: false, records: [] };
  } catch (e) {
    return { success: false, error: e.message, records: [] };
  }
}

// Attach aisle/bay/location info to items that have a storeSkuNumber.
// Shared by the penny and normal scan paths.
async function enrichWithAisleBay(tabId, storeId, items) {
  const skuIds = items.map(it => it.storeSkuNumber).filter(Boolean);
  if (skuIds.length === 0) return;
  try {
    const abResp = await lookupAisleBayViaTab(tabId, storeId, skuIds);
    const abMap = abResp?.results || {};
    for (const item of items) {
      const ab = abMap[item.storeSkuNumber];
      if (ab) {
        item.aisle = ab.aisle;
        item.bay = ab.bay;
        item.location = ab.location;
      }
    }
  } catch (e) {
    console.log('[Background] Aisle/bay lookup failed:', e.message);
  }
}

// ============================================================
// ==================== SCAN LOOP =============================
// ============================================================
// TWO-PASS approach for normal scans:
//   Pass 1: Light batch check (products() endpoint, 80 SKUs/wave) → identify clearance
//   Pass 2: Full details only for clearance hits → names/URLs for Telegram
// Penny scans are single-pass with the penny fingerprint filter.
//
// `state` is THIS loop's own object. A newer scan reassigns the module-level
// scanState to a fresh object, so a pre-empted loop can never corrupt the new
// scan's data — and the stale() checks stop it from touching storage/messaging.

async function runScanLoop(state, skus) {
  const myLoopId = ++currentLoopId;
  const stale = () => myLoopId !== currentLoopId;
  if (scanLoopActive) {
    console.log('[Background] Pre-empting prior scan loop (new loopId', myLoopId + ')');
  }
  scanLoopActive = true;
  const isPennyScan = (state.scanType || '').includes('penny');

  const WAVE_SIZE = 80;  // 5 parallel requests of 16 — proven safe, do not ramp
  let consecutiveErrors = 0;
  let cachedTabId = null;
  let wavesSinceBreather = 0;
  // Clear the fulfillment log on a fresh penny scan (currentIndex === 0 means
  // this isn't a resume). Delayed until we have a tab, since IDB access is
  // routed through the content script.
  let needLogClear = isPennyScan && state.currentIndex === 0;
  // Items already recorded/notified (survives resume via clearanceItems) —
  // prevents duplicate Telegram notifications when a wave is replayed.
  const seenIds = new Set(state.clearanceItems.map(it => String(it.itemId)));

  startKeepAlive();

  try {

  while (!stale() && state.running && state.currentIndex < skus.length) {
    const wave = skus.slice(state.currentIndex, state.currentIndex + WAVE_SIZE);
    const waveStartMs = Date.now();
    console.log(`[Background] Wave start: ${state.currentIndex + 1}-${state.currentIndex + wave.length} of ${skus.length} (${isPennyScan ? 'penny' : 'normal'})`);

    if (!cachedTabId) {
      cachedTabId = await findHdTab();
      if (stale()) return;
    }

    if (!cachedTabId) {
      console.log('[Background] No homedepot.com tab open — waiting 10s...');
      chrome.runtime.sendMessage({
        type: 'scanProgress',
        checked: state.checked,
        total: skus.length,
        found: state.clearanceItems.length,
        errors: state.errors,
        needsTab: true,
        scanType: state.scanType || null
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 10000));
      if (stale()) return;
      cachedTabId = await findHdTab();
      if (stale()) return;
      if (!cachedTabId) continue;
    }

    try {
      await ensureContentScript(cachedTabId);
    } catch (e) {
      console.log('[Background] Failed to ensure content script:', e.message);
      cachedTabId = null;
      consecutiveErrors++;
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }
    if (stale()) return;

    if (needLogClear) {
      try {
        await clearFulfillmentLogViaTab(cachedTabId);
        console.log('[Background] Cleared prior fulfillment log for fresh penny scan');
      } catch (e) {
        console.warn('[Background] Failed to clear fulfillment log:', e.message);
      }
      if (stale()) return;
      needLogClear = false;
    }

    let waveErrors = 0;

    if (isPennyScan) {
      // ===== PENNY SCAN: Fast batch using products() endpoint =====
      try {
        const batchResponse = await checkPennyBatchViaTab(cachedTabId, wave, state.storeId);
        if (stale()) return;
        // Key results by itemId — never trust array position to line up with
        // the request wave (short/partial responses would mislabel SKUs).
        const resultsById = new Map();
        for (const r of (batchResponse?.results || [])) {
          if (r && r.itemId != null) resultsById.set(String(r.itemId), r);
        }
        const waveItems = [];

        for (const sku of wave) {
          const result = resultsById.get(String(sku));
          state.checked++;

          if (!result || result.error) {
            state.errors++;
            waveErrors++;
            continue;
          }

          if (result.pennySignal) {
            const pricingValue = result.onlinePrice || 0;
            const qty = result.storeQuantity;
            waveItems.push({
              itemId: sku,
              storeSkuNumber: result.storeSkuNumber || '',
              name: result.name || `SKU ${sku}`,
              brand: result.brand || 'Unknown',
              url: result.url
                ? `${result.url}?storeId=${state.storeId}`
                : `https://www.homedepot.com/p/${sku}?storeId=${state.storeId}`,
              onlinePrice: pricingValue,
              clearancePrice: 0.01,
              dollarOff: pricingValue > 0 ? pricingValue - 0.01 : 0,
              percentOff: pricingValue > 0 ? Math.round((1 - 0.01 / pricingValue) * 100) : 0,
              quantity: qty != null ? qty : 0,
              storeQuantity: qty,
              storeQuantityVia: result.storeQuantityVia || null,
              isInStock: qty != null && qty > 0,
              pennyConfidence: 'confirmed',
              discontinued: result.discontinued || false,
              availType: result.availType || null,
              category: 'Penny Scan'
            });
          }
        }

        if (waveItems.length > 0) {
          await enrichWithAisleBay(cachedTabId, state.storeId, waveItems);
          if (stale()) return;

          // Only surface pennies with a known aisle/bay — anything without a
          // location isn't actionable as a walk-in and gets dropped here.
          const actionableItems = waveItems.filter(it => it.location);
          const droppedNoLoc = waveItems.length - actionableItems.length;
          if (droppedNoLoc > 0) {
            console.log(`[Background] 🚫 Dropped ${droppedNoLoc} penny item(s) without aisle/bay`);
            for (const skipped of waveItems) {
              if (!skipped.location) {
                console.log(`[Background]    skipped: ${skipped.itemId} — ${skipped.name || 'Unknown'}`);
              }
            }
          }

          for (const item of actionableItems) {
            if (seenIds.has(String(item.itemId))) continue; // replayed wave — already recorded
            seenIds.add(String(item.itemId));
            state.clearanceItems.push(item);
            queueTelegramItem(item, state.storeId, true);
            console.log(`[Background] 🪙 PENNY FOUND: ${item.itemId} — ${item.name || 'Unknown'}, online=$${item.onlinePrice} @ ${item.location}`);
          }
        }
      } catch (e) {
        console.log('[Background] Penny scan wave failed:', e.message);
        if (stale()) return;
        cachedTabId = null;
        state.checked += wave.length;
        state.errors += wave.length;
        waveErrors = wave.length;
      }
    } else {
      // ===== NORMAL SCAN: Two-pass approach =====
      // Pass 1: Light batch check (pricing + fulfillment only)
      let lightById = new Map();
      try {
        const response = await checkSkuBatchLightViaTab(cachedTabId, wave, state.storeId);
        for (const r of (response?.results || [])) {
          if (r && r.itemId != null) lightById.set(String(r.itemId), r);
        }
      } catch (e) {
        console.log('[Background] Tab communication failed:', e.message);
        cachedTabId = null;
      }
      if (stale()) return;

      const clearanceHits = [];
      const lightClearanceData = {};
      let waveClearanceSeen = 0;
      let waveFilteredOut = 0;

      for (const sku of wave) {
        const result = lightById.get(String(sku));
        state.checked++;
        if (!result || result.error) {
          state.errors++;
          waveErrors++;
        } else if (result.clearance) {
          waveClearanceSeen++;
          const passesFilter = result.clearance.percentOff > MIN_PERCENT_OFF
            && result.clearance.quantity > 0
            && result.clearance.isAdvertised; // yellow-tag filter — intentional
          if (passesFilter) {
            clearanceHits.push(result.clearance.itemId);
            lightClearanceData[result.clearance.itemId] = result.clearance;
          } else {
            waveFilteredOut++;
            console.log(`[Background] Clearance filtered: ${result.clearance.itemId} - ${result.clearance.percentOff}% off, qty=${result.clearance.quantity}, advertised=${result.clearance.isAdvertised}, price=$${result.clearance.clearancePrice}`);
          }
        }
      }

      state.totalClearanceSeen += waveClearanceSeen;
      state.totalFilteredOut += waveFilteredOut;

      if (waveClearanceSeen > 0) {
        console.log(`[Background] Wave: ${wave.length} checked, ${waveClearanceSeen} clearance, ${clearanceHits.length} passed filter, ${waveFilteredOut} filtered, ${waveErrors} errors`);
      }

      // Pass 2: Full details for clearance hits only
      if (clearanceHits.length > 0 && state.running) {
        console.log(`[Background] Pass 2: fetching full details for ${clearanceHits.length} clearance items`);
        const waveItems = [];

        try {
          const detailResponse = await getProductDetailsViaTab(cachedTabId, clearanceHits, state.storeId);
          if (stale()) return;
          const detailResults = detailResponse?.results || [];

          for (let i = 0; i < detailResults.length; i++) {
            const result = detailResults[i];
            // Details results carry itemId inside clearance (success) or at the
            // top level (error); fall back to request order as a last resort.
            const sku = result?.clearance?.itemId ?? result?.itemId ?? clearanceHits[i];
            const lightData = lightClearanceData[sku];

            if (result.clearance) {
              waveItems.push({ ...result.clearance, category: 'Background Scan' });
            } else if (lightData) {
              const ids = result.identifiers || {};
              waveItems.push({
                ...lightData,
                name: ids.name || `SKU ${sku}`,
                brand: ids.brand || 'Unknown',
                url: ids.url ? `${ids.url}?storeId=${state.storeId}` : `https://www.homedepot.com/p/${sku}?storeId=${state.storeId}`,
                category: 'Background Scan'
              });
            }
          }
        } catch (e) {
          console.log('[Background] Pass 2 failed:', e.message);
          if (stale()) return;
          for (const sku of clearanceHits) {
            const lightData = lightClearanceData[sku];
            if (lightData) {
              waveItems.push({
                ...lightData,
                name: `SKU ${sku}`,
                brand: 'Unknown',
                url: `https://www.homedepot.com/p/${sku}?storeId=${state.storeId}`,
                category: 'Background Scan (light)'
              });
            }
          }
        }

        if (waveItems.length > 0) {
          await enrichWithAisleBay(cachedTabId, state.storeId, waveItems);
          if (stale()) return;
          const enriched = waveItems.filter(it => it.location).length;
          if (enriched > 0) console.log(`[Background] Aisle/bay: enriched ${enriched}/${waveItems.length} items`);

          for (const item of waveItems) {
            if (seenIds.has(String(item.itemId))) continue; // replayed wave — already recorded
            seenIds.add(String(item.itemId));
            state.clearanceItems.push(item);
            queueTelegramItem(item, state.storeId, false);
          }
        }
      }
    }

    state.currentIndex += wave.length;

    const waveElapsed = Math.round((Date.now() - waveStartMs) / 1000);
    console.log(`[Background] Wave done: ${wave.length} SKUs in ${waveElapsed}s, ${waveErrors} errors, checked=${state.checked}/${skus.length}, found=${state.clearanceItems.length}`);

    if (waveErrors === wave.length) {
      consecutiveErrors++;
    } else {
      consecutiveErrors = 0;
    }

    // Save progress for resume. The SKU list was persisted once at scan start
    // (scanSkus) — this only writes the cursor + found items, not 100k SKUs.
    if (stale()) return;
    await chrome.storage.local.set({
      scanState: persistableState(state),
      clearanceItems: state.clearanceItems
    });

    // Adaptive delay
    wavesSinceBreather++;
    let baseDelay, maxJitter;
    let rateLimitLevel = 'ok';
    let cooldownSec = 0;

    if (consecutiveErrors >= 5) {
      console.log('[Background] Heavy rate limiting, backing off 3-5 min...');
      baseDelay = 180000; maxJitter = 120000;
      rateLimitLevel = 'heavy';
      consecutiveErrors = 0;
      cachedTabId = null;
    } else if (consecutiveErrors >= 3) {
      console.log('[Background] Rate limited, backing off 45-90s...');
      baseDelay = 45000; maxJitter = 45000;
      rateLimitLevel = 'moderate';
      consecutiveErrors = 0;
      cachedTabId = null;
    } else if (consecutiveErrors > 0) {
      baseDelay = 8000; maxJitter = 7000;
      rateLimitLevel = 'light';
    } else {
      baseDelay = 1000; maxJitter = 2000; // 1-3s between waves
    }

    // Every ~10 waves, take a breather
    if (wavesSinceBreather >= 10 && consecutiveErrors === 0) {
      const breather = 8000 + Math.floor(Math.random() * 12000); // 8-20s pause
      console.log(`[Background] Breather pause: ${Math.round(breather/1000)}s`);
      wavesSinceBreather = 0;
      await new Promise(r => setTimeout(r, breather));
      if (stale()) return;
    }

    const delay = baseDelay + Math.floor(Math.random() * maxJitter);
    cooldownSec = Math.round(delay / 1000);

    // Broadcast progress
    chrome.runtime.sendMessage({
      type: 'scanProgress',
      checked: state.checked,
      total: skus.length,
      found: state.clearanceItems.length,
      errors: state.errors,
      rateLimitLevel: rateLimitLevel,
      cooldownSec: cooldownSec,
      clearanceSeen: state.totalClearanceSeen || 0,
      filteredOut: state.totalFilteredOut || 0,
      scanType: state.scanType || null
    }).catch(() => {});

    // Telegram progress hook — debounced inside the function, no-op if scan
    // wasn't triggered from Telegram.
    telegramUpdateScanProgress().catch(() => {});

    await new Promise(r => setTimeout(r, delay));
  }

  // Scan finished — only run completion handling if we're still the active loop.
  if (myLoopId === currentLoopId) {
    const wasUserStopped = state.userStopped;
    state.running = false;
    stopKeepAlive();
    console.log('[Background] Keep-alive stopped');

    if (!wasUserStopped) {
      await chrome.storage.local.set({
        scanState: persistableState(state),
        clearanceItems: state.clearanceItems
      });

      chrome.runtime.sendMessage({
        type: 'scanComplete',
        found: state.clearanceItems.length,
        checked: state.checked,
        scanType: state.scanType || null
      }).catch(() => {});

      console.log(`[Background] Scan complete: ${state.clearanceItems.length} clearance items found`);

      // Let queued per-item notifications land before the summary
      await flushTelegramQueue();

      if (state.clearanceItems.length > 0) {
        const storeName = escapeTg(STORE_NAMES[state.storeId] || state.storeId);
        if (isPennyScan) {
          await sendToDealsChannel(`🪙 <b>PENNY SCAN COMPLETE</b>\n📍 Store: ${storeName}\n📊 Found ${state.clearanceItems.length} possible penny items\n🔍 Checked ${state.checked.toLocaleString()} products`);
        } else {
          await sendToDealsChannel(`✅ <b>SCAN COMPLETE</b>\n📍 Store: ${storeName}\n📊 Found ${state.clearanceItems.length} clearance items\n🔍 Checked ${state.checked.toLocaleString()} products`);
        }
      }
    } else {
      console.log('[Background] Scan stopped by user');
      await flushTelegramQueue();
      await chrome.storage.local.set({
        clearanceItems: state.clearanceItems
      });
    }
  } else {
    console.log('[Background] Pre-empted loop exiting quietly (myLoopId', myLoopId, '!==', currentLoopId + ')');
  }

  } finally {
    // Only clear the active flag if we're still the current loop. A pre-empted
    // loop must not flip this off — the newer loop is using it.
    if (myLoopId === currentLoopId) {
      scanLoopActive = false;
      // Telegram finalize hook — no-op if scan wasn't triggered from Telegram.
      telegramFinalizeScan().catch(() => {});
    }
  }
}

// ============================================================
// ==================== MESSAGE HANDLER =======================
// ============================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // SKU discovery progress — pipe to Telegram if a Telegram scan is in progress
  if (request.type === 'skuProgress' && telegramProgressCtx && telegramProgressCtx.messageId) {
    const now = Date.now();
    if (now - telegramProgressCtx.lastEditMs >= telegramProgressEditMinMs) {
      telegramProgressCtx.lastEditMs = now;
      const skuCount = (request.skuCount || 0).toLocaleString();
      const current = request.current || 0;
      const total = request.total || '?';
      const cat = request.category || '';
      const text =
        `🔎 <b>DISCOVERING SKUs</b>\n` +
        `📍 ${escapeTg(telegramProgressCtx.storeName)} (#${escapeTg(telegramProgressCtx.storeId)})\n` +
        `📊 ${skuCount} SKUs found so far\n` +
        `📂 ${current}/${total} categories\n` +
        (cat ? `📑 ${escapeTg(cat)}` : '');
      telegramEditProgressMessage(text, null);
    }
    return false;
  }

  if (request.action === 'startBackgroundScan') {
    const isPenny = (request.scanType || '').includes('penny');
    console.log(`[Background] Starting ${isPenny ? 'penny ' : ''}scan with`, request.skus.length, 'SKUs');

    const storeName = escapeTg(STORE_NAMES[request.storeId] || request.storeId);
    const startLabel = isPenny ? '🪙 <b>PENNY SCAN STARTED</b>' : '🔍 <b>SCAN STARTED</b>';
    sendToDealsChannel(`${startLabel}\n📍 Store: ${storeName} (#${escapeTg(request.storeId)})\n📊 Checking ${request.skus.length.toLocaleString()} SKUs...`)
      .then(r => console.log('[Background] Telegram start notification:', r.success ? 'sent' : r.error));

    startScan(request.storeId, request.skus, request.scanType);
    sendResponse({ started: true });
    return true;
  }

  if (request.action === 'stopBackgroundScan') {
    console.log('[Background] Stopping scan');
    scanState.running = false;
    scanState.userStopped = true;
    stopKeepAlive();
    // Save progress so the scan can be resumed later.
    chrome.storage.local.set({
      scanState: persistableState(scanState),
      clearanceItems: scanState.clearanceItems
    });
    sendResponse({ stopped: true });
    return true;
  }

  if (request.action === 'downloadFulfillmentLog') {
    (async () => {
      const tabId = await findHdTab();
      if (!tabId) {
        sendResponse({ log: [], error: 'No homedepot.com tab open — open one to read the IDB log.' });
        return;
      }
      try {
        await ensureContentScript(tabId);
      } catch (e) {
        sendResponse({ log: [], error: `Content script unreachable: ${e.message}` });
        return;
      }
      const resp = await getFulfillmentLogViaTab(tabId, request.scanId || null);
      sendResponse({ log: resp.records || [], error: resp.error || null });
    })();
    return true;
  }

  if (request.action === 'probeB2B') {
    const { storeId, sku } = request;
    (async () => {
      const B2B_BASE = 'https://apionline.homedepot.com/b2b/ws/backendapp';
      const paths = [
        `/store/v2/${storeId}/sku/${sku}`,
        `/store/v1/${storeId}/sku/${sku}`,
        `/inventory/v2/store/${storeId}/sku/${sku}`,
        `/inventory/store/${storeId}/product/${sku}`,
      ];
      const results = [];
      for (const path of paths) {
        const url = B2B_BASE + path;
        try {
          const resp = await fetch(url, {
            method: 'GET',
            credentials: 'include',
            headers: { 'Accept': 'application/json' }
          });
          const status = resp.status;
          let body = null;
          try {
            const text = await resp.text();
            body = text.slice(0, 2000);
            try { body = JSON.parse(body); } catch(_) {}
          } catch(_) {}
          results.push({ path, status, body });
          console.log(`[B2B Probe] ${path} → ${status}`, body);
        } catch (e) {
          results.push({ path, status: 'error', body: e.message });
          console.log(`[B2B Probe] ${path} → ERROR: ${e.message}`);
        }
      }
      sendResponse({ results });
    })();
    return true;
  }

  if (request.action === 'getScanState') {
    sendResponse({
      running: scanState.running,
      checked: scanState.checked,
      total: scanState.total || 0,
      found: scanState.clearanceItems.length,
      errors: scanState.errors,
      clearanceItems: scanState.clearanceItems,
      scanType: scanState.scanType || null
    });
    return true;
  }

  // Resume interrupted scan
  if (request.action === 'resumeScan') {
    (async () => {
      const resume = await loadResumeData();
      if (resume) {
        console.log('[Background] Resuming scan from index', resume.st.currentIndex);
        beginScanFromResume(resume);
        sendResponse({ resumed: true, from: resume.st.currentIndex });
      } else {
        sendResponse({ resumed: false, reason: 'No scan to resume' });
      }
    })();
    return true;
  }

  // ---------- Telegram connect flow (popup settings UI) ----------

  // Step 1: validate a pasted bot token
  if (request.action === 'telegramConnect') {
    (async () => {
      const token = (request.botToken || '').trim();
      if (!/^\d+:[\w-]{20,}$/.test(token)) {
        sendResponse({ ok: false, error: 'That doesn\'t look like a bot token. It should look like 123456789:AbCdEf...' });
        return;
      }
      const me = await telegramApiWithToken(token, 'getMe', {});
      if (!me?.ok) {
        sendResponse({ ok: false, error: me?.description || 'Telegram rejected that token.' });
        return;
      }
      sendResponse({ ok: true, botUsername: me.result.username });
    })();
    return true;
  }

  // Step 2: poll for the user's /start message to auto-detect their chat id
  if (request.action === 'telegramDetectChat') {
    (async () => {
      const token = (request.botToken || '').trim();
      const resp = await telegramApiWithToken(token, 'getUpdates', {
        timeout: 0,
        allowed_updates: ['message']
      });
      if (!resp?.ok) {
        // 409 = another poller is still draining (e.g. old loop) — just wait
        if (resp?.error_code === 409) {
          sendResponse({ ok: true, waiting: true });
        } else {
          sendResponse({ ok: false, error: resp?.description || 'Could not reach Telegram.' });
        }
        return;
      }
      let found = null;
      let maxId = 0;
      for (const u of (resp.result || [])) {
        if (typeof u.update_id === 'number' && u.update_id > maxId) maxId = u.update_id;
        const m = u.message;
        if (m && m.chat) found = m.chat; // take the latest message's chat
      }
      if (!found) {
        sendResponse({ ok: true, waiting: true });
        return;
      }
      const label = found.title
        || [found.first_name, found.last_name].filter(Boolean).join(' ')
        || found.username
        || String(found.id);
      sendResponse({ ok: true, chat: { id: found.id, label }, lastUpdateId: maxId });
    })();
    return true;
  }

  // Step 3: persist the connection and start the control-plane poll
  if (request.action === 'telegramSaveConfig') {
    (async () => {
      const cfg = {
        botToken: (request.botToken || '').trim(),
        chatId: Number(request.chatId),
        chatLabel: request.chatLabel || '',
        botUsername: request.botUsername || '',
        // Keep the deals channel across reconnects (same install, new token)
        dealsChannel: telegramConfig?.dealsChannel || null
      };
      if (!cfg.botToken || !cfg.chatId) {
        sendResponse({ ok: false, error: 'Missing token or chat id' });
        return;
      }
      telegramConfig = cfg;
      telegramLastError = null;
      // Skip past the /start message so the control plane doesn't replay it
      if (typeof request.lastUpdateId === 'number' && request.lastUpdateId > telegramLastUpdateId) {
        telegramLastUpdateId = request.lastUpdateId;
      }
      await chrome.storage.local.set({ telegramConfig: cfg, telegramLastUpdateId });
      telegramPollLoop();
      await sendToTelegram('✅ <b>Connected!</b>\nThis chat now gets clearance & penny alerts from your scanner.\nSend /menu any time for remote controls.');
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (request.action === 'telegramDisconnect') {
    (async () => {
      telegramConfig = null;
      telegramLastError = null;
      await chrome.storage.local.remove(['telegramConfig']);
      // Poll loop notices the missing config and exits on its next iteration
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (request.action === 'telegramGetStatus') {
    sendResponse({
      configured: telegramEnabled(),
      botUsername: telegramConfig?.botUsername || null,
      chatLabel: telegramConfig?.chatLabel || null,
      dealsChannel: telegramConfig?.dealsChannel || null,
      lastError: telegramLastError
    });
    return true;
  }

  // Set the deals channel: verify the bot can actually post there, then save.
  if (request.action === 'telegramSetChannel') {
    (async () => {
      if (!telegramEnabled()) {
        sendResponse({ ok: false, error: 'Connect Telegram first.' });
        return;
      }
      const channel = normalizeChannelInput(request.channel);
      if (!channel) {
        sendResponse({ ok: false, error: 'Enter the channel like @yourdealschannel.' });
        return;
      }
      const test = await telegramApi('sendMessage', {
        chat_id: channel,
        text: '✅ <b>Deal alerts will be posted here.</b>',
        parse_mode: 'HTML'
      });
      if (!test.ok) {
        const desc = test.description || '';
        let friendly = `Telegram says: ${desc || 'unknown error'}`;
        if (/chat not found/i.test(desc)) {
          friendly = 'Channel not found — check the @name (public channels only; for a private channel use its -100… id).';
        } else if (/not enough rights|forbidden|CHAT_WRITE_FORBIDDEN|kicked|not a member/i.test(desc)) {
          friendly = `The bot can't post there yet. Open the channel → Administrators → add @${telegramConfig.botUsername || 'your bot'} as an admin, then try again.`;
        }
        sendResponse({ ok: false, error: friendly });
        return;
      }
      telegramConfig = { ...telegramConfig, dealsChannel: channel };
      await chrome.storage.local.set({ telegramConfig });
      sendResponse({ ok: true, dealsChannel: channel });
    })();
    return true;
  }

  if (request.action === 'telegramClearChannel') {
    (async () => {
      if (telegramConfig) {
        telegramConfig = { ...telegramConfig, dealsChannel: null };
        await chrome.storage.local.set({ telegramConfig });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (request.action === 'testTelegram') {
    sendToTelegram('🧪 <b>Test message</b>\nYour HD Clearance Scanner is connected!')
      .then(result => sendResponse(result));
    return true;
  }

  return false;
});

// On startup, check if there's an interrupted scan to resume
(async () => {
  const resume = await loadResumeData();
  if (resume && resume.st.running) {
    console.log('[Background] Found interrupted scan, auto-resuming from index', resume.st.currentIndex);
    beginScanFromResume(resume);
  }
})();

// ============================================================
// ==================== TELEGRAM BOT CONTROL ==================
// Long-polls Telegram getUpdates to receive commands and control
// scans. The in-flight fetch keeps the MV3 service worker alive
// as active work; a 1-minute chrome.alarms safety net restarts
// the poll if the worker dies for any other reason.
// Only runs when a user has connected their bot via the popup.
// ============================================================

// Long-poll timeout (seconds). Telegram holds the HTTP request open
// up to this long waiting for new updates. Keep under 30 to stay
// below their limit and well under service worker idle thresholds.
const TELEGRAM_POLL_TIMEOUT = 25;

// Minimum interval between scan progress message edits (ms).
// Official Telegram limit is 1 msg/sec per chat, but editing the same message
// hundreds of times over 20+ min can trigger stricter throttling.
// Starts at 8s; dynamically backs off if we get 429 retry_after responses.
let telegramProgressEditMinMs = 8000;

// Runtime state
let telegramPollActive = false;
let telegramLastUpdateId = 0;
// Context for editing the running scan's progress message.
// Set when a scan is launched from Telegram, cleared on finalize.
// Shape: { chatId, messageId, lastEditMs, storeId, storeName }
let telegramProgressCtx = null;
// Store search results held in memory until the user picks one — we do NOT
// persist all search results into savedStores (that polluted the store list).
let telegramPendingStores = {};

// Restore the last-seen update ID so we don't replay history on restart
chrome.storage.local.get(['telegramLastUpdateId'], (data) => {
  if (typeof data.telegramLastUpdateId === 'number') {
    telegramLastUpdateId = data.telegramLastUpdateId;
  }
});

// Only the connected chat may control the scanner.
function isChatAuthorized(chatId) {
  return telegramEnabled() && Number(chatId) === Number(telegramConfig.chatId);
}

// Edit the armed progress message, with shared 429 backoff handling.
function telegramEditProgressMessage(text, replyMarkup) {
  if (!telegramProgressCtx || !telegramProgressCtx.messageId) return Promise.resolve();
  const body = {
    chat_id: telegramProgressCtx.chatId,
    message_id: telegramProgressCtx.messageId,
    text,
    parse_mode: 'HTML'
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return telegramApi('editMessageText', body).then(r => {
    if (r && !r.ok) {
      console.warn('[Telegram] Progress edit failed:', r.description || r.error_code);
      if (r.error_code === 429 && r.parameters && r.parameters.retry_after) {
        // Back off by the amount Telegram asks + 2s buffer
        telegramProgressEditMinMs = Math.max(telegramProgressEditMinMs, r.parameters.retry_after * 1000 + 2000);
        console.warn('[Telegram] Rate limited, backing off to', telegramProgressEditMinMs, 'ms');
      }
    }
  }).catch(() => {});
}

function telegramMainMenu() {
  return {
    inline_keyboard: [
      [
        { text: '🔍 Scan Now', callback_data: 'menu:scan' },
        { text: '🪙 Penny Scan', callback_data: 'menu:penny' }
      ],
      [
        { text: '📍 By Zip', callback_data: 'menu:zip' },
        { text: '📊 Status', callback_data: 'menu:status' }
      ],
      [
        { text: '💾 Cached', callback_data: 'menu:cached' },
        { text: '⛔ Stop Scan', callback_data: 'menu:stop' }
      ]
    ]
  };
}

async function buildStoreButtonsFromSaved(callbackPrefix) {
  const data = await chrome.storage.local.get(['savedStores']);
  const saved = data.savedStores || {};
  const ids = Object.keys(saved);
  if (ids.length === 0) {
    return {
      inline_keyboard: [[
        { text: '🔎 Search by Zip', callback_data: 'menu:zip' },
        { text: '« Menu', callback_data: 'menu:main' }
      ]]
    };
  }
  const rows = ids.map(id => {
    const name = saved[id] || id;
    return [{ text: `🏪 ${name} (#${id})`, callback_data: `${callbackPrefix}:${id}` }];
  });
  rows.push([{ text: '« Menu', callback_data: 'menu:main' }]);
  return { inline_keyboard: rows };
}

function formatDurationMs(ms) {
  if (!ms || ms < 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatAgeMs(ms) {
  if (!ms || ms < 0) return 'unknown';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

// Send a new message, or edit an existing one when editMessageId is provided.
// Falls back to sending a new message if the edit fails.
async function telegramSendOrEdit(chatId, editMessageId, text, replyMarkup) {
  if (editMessageId) {
    const edit = await telegramApi('editMessageText', {
      chat_id: chatId,
      message_id: editMessageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: replyMarkup
    });
    if (edit && edit.ok) return edit.result;
  }
  const send = await telegramApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: replyMarkup
  });
  return send && send.result;
}

async function telegramHandleStart(chatId) {
  await telegramSendOrEdit(
    chatId,
    null,
    '👋 <b>HD Clearance Bot</b>\nControl the scanner from Telegram.\nPick an action:',
    telegramMainMenu()
  );
}

async function telegramShowMainMenu(chatId, editMessageId) {
  await telegramSendOrEdit(
    chatId,
    editMessageId,
    '📋 <b>HD Clearance Bot — Menu</b>',
    telegramMainMenu()
  );
}

async function telegramShowStorePicker(chatId, editMessageId, callbackPrefix, headerText) {
  const markup = await buildStoreButtonsFromSaved(callbackPrefix);
  await telegramSendOrEdit(chatId, editMessageId, headerText, markup);
}

async function telegramHandleStatus(chatId, editMessageId) {
  let text;
  if (scanState.running) {
    const total = scanState.total || 0;
    const pct = total ? Math.round((scanState.checked / total) * 100) : 0;
    const storeName = escapeTg(STORE_NAMES[scanState.storeId] || scanState.storeId);
    const elapsedMs = scanState.startTime ? Date.now() - scanState.startTime : 0;
    text =
      `📊 <b>SCAN RUNNING</b>\n` +
      `📍 ${storeName} (#${escapeTg(scanState.storeId)})\n` +
      `🔍 ${scanState.checked.toLocaleString()}/${total.toLocaleString()} (${pct}%)\n` +
      `🏷️ Found: ${scanState.clearanceItems.length}\n` +
      `⚠️ Errors: ${scanState.errors}\n` +
      `⏱️ Elapsed: ${formatDurationMs(elapsedMs)}`;
  } else {
    const data = await chrome.storage.local.get(['clearanceItems', 'scanState', 'scanSkus']);
    const lastItems = (data.clearanceItems || []).length;
    const lastState = data.scanState;
    if (lastState) {
      const total = lastState.total || (data.scanSkus ? data.scanSkus.length : 0) || (lastState.skus ? lastState.skus.length : 0);
      const storeName = escapeTg(STORE_NAMES[lastState.storeId] || lastState.storeId);
      const ageMs = lastState.startTime ? Date.now() - lastState.startTime : 0;
      text =
        `💤 <b>NO SCAN RUNNING</b>\n` +
        `Last scan: ${storeName} (#${escapeTg(lastState.storeId)})\n` +
        `🔍 ${(lastState.checked || 0).toLocaleString()}/${total.toLocaleString()}\n` +
        `🏷️ Found: ${lastItems}\n` +
        `📅 Started: ${formatAgeMs(ageMs)}`;
    } else {
      text = '💤 <b>NO SCAN RUNNING</b>\nNo previous scan recorded.';
    }
  }
  const markup = {
    inline_keyboard: [[
      { text: '🔄 Refresh', callback_data: 'menu:status' },
      { text: '« Menu', callback_data: 'menu:main' }
    ]]
  };
  await telegramSendOrEdit(chatId, editMessageId, text, markup);
}

async function telegramHandleCached(chatId, editMessageId) {
  const data = await chrome.storage.local.get(['skuInventoryMultiStore', 'savedStores']);
  const inv = data.skuInventoryMultiStore || {};
  const saved = data.savedStores || {};
  const storeIds = Object.keys(inv);
  if (storeIds.length === 0) {
    const markup = { inline_keyboard: [[{ text: '« Menu', callback_data: 'menu:main' }]] };
    await telegramSendOrEdit(
      chatId,
      editMessageId,
      '💾 <b>No cached SKUs yet</b>\nRun a full scan first to build a cache.',
      markup
    );
    return;
  }
  const lines = ['💾 <b>CACHED SKU INVENTORY</b>', ''];
  for (const id of storeIds) {
    const entry = inv[id] || {};
    const skus = Array.isArray(entry.skus) ? entry.skus : [];
    const name = escapeTg(saved[id] || id);
    const age = entry.lastUpdated ? formatAgeMs(Date.now() - entry.lastUpdated) : 'unknown';
    lines.push(`🏪 <b>${name}</b> (#${escapeTg(id)})`);
    lines.push(`   ${skus.length.toLocaleString()} SKUs — updated ${age}`);
  }
  lines.push('');
  lines.push('Tap a store to scan <b>from cache</b> (skips discovery):');
  const rows = storeIds.map(id => {
    const name = saved[id] || id;
    const count = (inv[id] && inv[id].skus && inv[id].skus.length) || 0;
    return [{ text: `🏪 ${name} — ${count.toLocaleString()}`, callback_data: `cachedscan:${id}` }];
  });
  rows.push([{ text: '« Menu', callback_data: 'menu:main' }]);
  await telegramSendOrEdit(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
}

async function telegramHandleZipSearch(chatId, query) {
  const tabId = await findHdTab();
  if (!tabId) {
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text: '⚠️ <b>No homedepot.com tab open</b>\nOpen a Home Depot tab in Chrome, then try again.',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '« Menu', callback_data: 'menu:main' }]] }
    });
    return;
  }
  try {
    await ensureContentScript(tabId);
  } catch (e) {
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text: `⚠️ Could not reach content script: ${escapeTg((e && e.message) || 'unknown')}`,
      parse_mode: 'HTML'
    });
    return;
  }
  console.log('[Telegram] Sending searchStores to tab', tabId, 'query:', query);
  const response = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'searchStores', query }, (resp) => {
      if (chrome.runtime.lastError) {
        console.log('[Telegram] searchStores error:', chrome.runtime.lastError.message);
        resolve({ ok: false, error: chrome.runtime.lastError.message, stores: [] });
      } else {
        resolve(resp || { ok: false, error: 'no response', stores: [] });
      }
    });
  });
  const stores = (response && response.stores) || [];
  if (stores.length === 0) {
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text: `🔎 No stores found for "${escapeTg(query)}".`,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '« Menu', callback_data: 'menu:main' }]] }
    });
    return;
  }
  // Hold results in memory until a store is actually picked — persisting all
  // ten polluted savedStores with stores the user merely searched.
  const top = stores.slice(0, 10);
  const rows = top.map(s => {
    const city = (s.address && s.address.city) || '';
    const state = (s.address && s.address.state) || '';
    const label = `🏪 ${s.name} — ${city}, ${state}`.trim();
    telegramPendingStores[s.storeId] = s;
    return [{ text: label, callback_data: `pickstore:${s.storeId}` }];
  });
  rows.push([{ text: '« Menu', callback_data: 'menu:main' }]);
  await telegramApi('sendMessage', {
    chat_id: chatId,
    text: `📍 <b>Stores near "${escapeTg(query)}"</b>\nPick a store to select it:`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows }
  });
}

async function telegramHandlePickStore(chatId, editMessageId, storeId) {
  const data = await chrome.storage.local.get(['savedStores', 'savedStoreDetails']);
  const savedStores = data.savedStores || {};
  const savedStoreDetails = data.savedStoreDetails || {};
  // Prefer the in-memory search result; fall back to previously saved details
  // (the pending map is lost if the worker restarted between search and pick).
  const details = telegramPendingStores[storeId] || savedStoreDetails[storeId];
  const name = (details && details.name) || savedStores[storeId] || storeId;
  const selectedStore = details || { storeId, name };
  // Persist ONLY the picked store
  savedStores[storeId] = name;
  if (details) savedStoreDetails[storeId] = details;
  await chrome.storage.local.set({ storeId, selectedStore, savedStores, savedStoreDetails });
  const markup = {
    inline_keyboard: [
      [
        { text: '🔍 Scan (discover)', callback_data: `scan:${storeId}` },
        { text: '💾 Scan Cached', callback_data: `cachedscan:${storeId}` }
      ],
      [{ text: '« Menu', callback_data: 'menu:main' }]
    ]
  };
  await telegramSendOrEdit(
    chatId,
    editMessageId,
    `✅ Selected <b>${escapeTg(name)}</b> (#${escapeTg(storeId)})\nReady to scan.`,
    markup
  );
}

async function telegramHandleScanTrigger(chatId, storeId, useCached) {
  if (scanState.running) {
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text: '⚠️ A scan is already running. Stop it first or watch its progress.',
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '📊 Status', callback_data: 'menu:status' },
          { text: '⛔ Stop', callback_data: 'menu:stop' }
        ]]
      }
    });
    return;
  }
  const tabId = await findHdTab();
  if (!tabId) {
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text: '⚠️ <b>No homedepot.com tab open</b>\nOpen a Home Depot tab in Chrome, then try again.',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '« Menu', callback_data: 'menu:main' }]] }
    });
    return;
  }
  try {
    await ensureContentScript(tabId);
  } catch (e) {
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text: `⚠️ Could not reach content script: ${escapeTg((e && e.message) || 'unknown')}`,
      parse_mode: 'HTML'
    });
    return;
  }
  const storeName = STORE_NAMES[storeId] || storeId;

  // Reset edit interval for new scan (previous 429 backoff shouldn't carry over)
  telegramProgressEditMinMs = 8000;

  // Send the initial progress message; we'll edit it as the scan runs.
  const startedMsg = await telegramApi('sendMessage', {
    chat_id: chatId,
    text: `⏳ <b>Starting scan</b>\n📍 ${escapeTg(storeName)} (#${escapeTg(storeId)})\n${useCached ? '💾 Using cached SKUs' : '🔎 Discovering SKUs...'}`,
    parse_mode: 'HTML'
  });
  const progressMessageId = (startedMsg && startedMsg.result && startedMsg.result.message_id) || null;

  // Arm progress context NOW (before discovery) so skuProgress messages
  // from the content script can update the Telegram message during discovery.
  telegramProgressCtx = {
    chatId,
    messageId: progressMessageId,
    lastEditMs: 0,
    storeId,
    storeName
  };

  // Discover or load SKUs
  let skus = [];
  let discoveryError = null;
  try {
    if (useCached) {
      const cacheResp = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, { action: 'getCachedSkus', storeId }, (resp) => {
          if (chrome.runtime.lastError) resolve({ skus: [] });
          else resolve(resp || { skus: [] });
        });
      });
      skus = (cacheResp && cacheResp.skus) || [];
    } else {
      const discoverResp = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, {
          action: 'getStoreSkusSitemap',
          storeId,
          skipAutoStart: true  // Telegram manages its own scan start below
        }, (resp) => {
          if (chrome.runtime.lastError) resolve({ skus: [] });
          else resolve(resp || { skus: [] });
        });
      });
      skus = (discoverResp && discoverResp.skus) || [];
    }
  } catch (e) {
    discoveryError = (e && e.message) || 'discovery failed';
  }
  if (discoveryError || skus.length === 0) {
    telegramProgressCtx = null;
    await telegramSendOrEdit(
      chatId,
      progressMessageId,
      `⚠️ <b>No SKUs found for ${escapeTg(storeName)}</b>\n${discoveryError ? 'Error: ' + escapeTg(discoveryError) : 'Cache may be empty — run a full scan first.'}`,
      { inline_keyboard: [[{ text: '« Menu', callback_data: 'menu:main' }]] }
    );
    return;
  }

  // Re-check: a popup-initiated scan may have started during discovery
  if (scanState.running) {
    telegramProgressCtx = null;
    await telegramSendOrEdit(
      chatId,
      progressMessageId,
      '⚠️ Another scan started while discovering — watch its progress with /status.',
      { inline_keyboard: [[{ text: '📊 Status', callback_data: 'menu:status' }]] }
    );
    return;
  }

  startScan(storeId, skus, useCached ? 'telegram_cached' : 'telegram_full');

  // Seed the progress message with the starting state
  await telegramSendOrEdit(
    chatId,
    progressMessageId,
    `🔍 <b>SCAN STARTED</b>\n📍 ${escapeTg(storeName)} (#${escapeTg(storeId)})\n📊 Checking ${skus.length.toLocaleString()} SKUs...`,
    {
      inline_keyboard: [[
        { text: '⛔ Stop', callback_data: 'menu:stop' },
        { text: '📊 Refresh', callback_data: 'menu:status' }
      ]]
    }
  );
}

async function telegramHandlePennyScanTrigger(chatId, storeId) {
  if (scanState.running) {
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text: '⚠️ A scan is already running. Stop it first.',
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '⛔ Stop', callback_data: 'menu:stop' },
          { text: '📊 Status', callback_data: 'menu:status' }
        ]]
      }
    });
    return;
  }

  // Penny scan always uses cached SKUs
  const data = await chrome.storage.local.get(['skuInventoryMultiStore']);
  const storeData = data.skuInventoryMultiStore?.[storeId];
  const skus = storeData?.skus || [];

  if (skus.length === 0) {
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text: '⚠️ No cached SKUs for this store. Run a full clearance scan first.',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '« Menu', callback_data: 'menu:main' }]] }
    });
    return;
  }

  const storeName = STORE_NAMES[storeId] || storeId;
  telegramProgressEditMinMs = 8000;

  const startedMsg = await telegramApi('sendMessage', {
    chat_id: chatId,
    text: `🪙 <b>PENNY SCAN STARTING</b>\n📍 ${escapeTg(storeName)} (#${escapeTg(storeId)})\n📊 Checking ${skus.length.toLocaleString()} cached SKUs for penny signals...`,
    parse_mode: 'HTML'
  });
  const progressMessageId = startedMsg?.result?.message_id || null;

  telegramProgressCtx = {
    chatId,
    messageId: progressMessageId,
    lastEditMs: 0,
    storeId,
    storeName
  };

  startScan(storeId, skus, 'telegram_penny');
}

async function telegramHandleStop(chatId) {
  if (!scanState.running) {
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text: '💤 No scan is running.',
      parse_mode: 'HTML'
    });
    return;
  }
  scanState.running = false;
  scanState.userStopped = true;
  stopKeepAlive();
  await chrome.storage.local.set({
    scanState: persistableState(scanState),
    clearanceItems: scanState.clearanceItems
  });
  await telegramApi('sendMessage', {
    chat_id: chatId,
    text: '⛔ <b>Scan stopped</b>',
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '« Menu', callback_data: 'menu:main' }]] }
  });
}

// Called from runScanLoop after each wave. Debounced so we don't spam Telegram.
async function telegramUpdateScanProgress() {
  if (!telegramProgressCtx || !telegramProgressCtx.messageId) return;
  const now = Date.now();
  if (now - telegramProgressCtx.lastEditMs < telegramProgressEditMinMs) return;
  telegramProgressCtx.lastEditMs = now;
  const total = scanState.total || 0;
  const pct = total ? Math.round((scanState.checked / total) * 100) : 0;
  const elapsedMs = scanState.startTime ? Date.now() - scanState.startTime : 0;
  const text =
    `📊 <b>SCAN PROGRESS</b>\n` +
    `📍 ${escapeTg(telegramProgressCtx.storeName)} (#${escapeTg(telegramProgressCtx.storeId)})\n` +
    `🔍 ${scanState.checked.toLocaleString()}/${total.toLocaleString()} (${pct}%)\n` +
    `🏷️ Found: ${scanState.clearanceItems.length}\n` +
    `⚠️ Errors: ${scanState.errors}\n` +
    `⏱️ Elapsed: ${formatDurationMs(elapsedMs)}`;
  await telegramEditProgressMessage(text, {
    inline_keyboard: [[
      { text: '⛔ Stop', callback_data: 'menu:stop' },
      { text: '📊 Refresh', callback_data: 'menu:status' }
    ]]
  });
}

// Called from runScanLoop's finally block at scan end. Idempotent.
async function telegramFinalizeScan() {
  if (!telegramProgressCtx) return;
  const ctx = telegramProgressCtx;
  telegramProgressCtx = null;
  const total = scanState.total || 0;
  const wasStopped = scanState.userStopped;
  const elapsedMs = scanState.startTime ? Date.now() - scanState.startTime : 0;
  const text = wasStopped
    ? `⛔ <b>SCAN STOPPED</b>\n📍 ${escapeTg(ctx.storeName)}\n🔍 ${scanState.checked.toLocaleString()}/${total.toLocaleString()}\n🏷️ Found: ${scanState.clearanceItems.length}\n⏱️ ${formatDurationMs(elapsedMs)}`
    : `✅ <b>SCAN COMPLETE</b>\n📍 ${escapeTg(ctx.storeName)}\n🔍 Checked ${scanState.checked.toLocaleString()}\n🏷️ Found: ${scanState.clearanceItems.length}\n⚠️ Errors: ${scanState.errors}\n⏱️ ${formatDurationMs(elapsedMs)}`;
  try {
    await telegramApi('editMessageText', {
      chat_id: ctx.chatId,
      message_id: ctx.messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '« Menu', callback_data: 'menu:main' }]] }
    });
  } catch (e) {
    // swallow
  }
}

// Route an incoming Telegram update (message or callback_query) to a handler
async function telegramDispatchUpdate(update) {
  if (update.callback_query) {
    const q = update.callback_query;
    const chatId = q.message && q.message.chat && q.message.chat.id;
    const messageId = q.message && q.message.message_id;
    const data = q.data || '';
    // Always answer so the button stops spinning
    telegramApi('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
    if (!isChatAuthorized(chatId)) {
      await telegramApi('sendMessage', { chat_id: chatId, text: '⛔ This bot is linked to a different device. Connect your own bot from the extension popup.' });
      return;
    }
    if (data === 'menu:main') return telegramShowMainMenu(chatId, messageId);
    if (data === 'menu:status') return telegramHandleStatus(chatId, messageId);
    if (data === 'menu:cached') return telegramHandleCached(chatId, messageId);
    if (data === 'menu:stop') return telegramHandleStop(chatId);
    if (data === 'menu:scan') {
      return telegramShowStorePicker(
        chatId,
        messageId,
        'scan',
        '🔍 <b>Scan Now</b>\nPick a saved store, or use <code>/zip &lt;code&gt;</code> to find more:'
      );
    }
    if (data === 'menu:penny') {
      return telegramShowStorePicker(
        chatId,
        messageId,
        'pennyscan',
        '🪙 <b>Penny Scan</b>\nChecks cached SKUs for penny signals.\nPick a store:'
      );
    }
    if (data === 'menu:zip') {
      await telegramSendOrEdit(
        chatId,
        messageId,
        '📍 <b>Search Stores by Zip</b>\nSend a message:\n<code>/zip 90210</code>',
        { inline_keyboard: [[{ text: '« Menu', callback_data: 'menu:main' }]] }
      );
      return;
    }
    if (data.startsWith('scan:')) {
      return telegramHandleScanTrigger(chatId, data.slice('scan:'.length), false);
    }
    if (data.startsWith('cachedscan:')) {
      return telegramHandleScanTrigger(chatId, data.slice('cachedscan:'.length), true);
    }
    if (data.startsWith('pennyscan:')) {
      return telegramHandlePennyScanTrigger(chatId, data.slice('pennyscan:'.length));
    }
    if (data.startsWith('pickstore:')) {
      return telegramHandlePickStore(chatId, messageId, data.slice('pickstore:'.length));
    }
    return;
  }

  if (update.message && update.message.text) {
    const chatId = update.message.chat.id;
    const text = update.message.text.trim();
    if (!isChatAuthorized(chatId)) {
      await telegramApi('sendMessage', { chat_id: chatId, text: '⛔ This bot is linked to a different device. Connect your own bot from the extension popup.' });
      return;
    }
    if (text === '/start' || text === '/menu') return telegramHandleStart(chatId);
    if (text === '/status') return telegramHandleStatus(chatId, null);
    if (text === '/cached') return telegramHandleCached(chatId, null);
    if (text === '/stop') return telegramHandleStop(chatId);
    if (text === '/scan') {
      return telegramShowStorePicker(
        chatId,
        null,
        'scan',
        '🔍 <b>Scan Now</b>\nPick a saved store, or <code>/zip &lt;code&gt;</code>:'
      );
    }
    if (text === '/penny') {
      return telegramShowStorePicker(
        chatId,
        null,
        'pennyscan',
        '🪙 <b>Penny Scan</b>\nChecks cached SKUs for penny signals.\nPick a store:'
      );
    }
    if (text.startsWith('/zip')) {
      const query = text.replace(/^\/zip\s*/, '').trim();
      if (!query) {
        await telegramApi('sendMessage', {
          chat_id: chatId,
          text: 'Usage: <code>/zip 90210</code> or <code>/zip store-name</code>',
          parse_mode: 'HTML'
        });
        return;
      }
      return telegramHandleZipSearch(chatId, query);
    }
    // Unknown text — show the main menu
    return telegramHandleStart(chatId);
  }
}

// Long-poll getUpdates while a config exists. The in-flight fetch keeps the
// worker alive (it counts as active work in MV3). Exits when disconnected or
// the token turns invalid; the popup can reconnect at any time.
async function telegramPollLoop() {
  if (telegramPollActive) return;
  await telegramConfigReady;
  if (!telegramEnabled()) {
    console.log('[Telegram] Not connected, poll loop not started');
    return;
  }
  telegramPollActive = true;
  console.log('[Telegram] Poll loop started');
  try {
    while (true) {
      // Config can be swapped or removed at any time — re-read each iteration
      if (!telegramEnabled()) {
        console.log('[Telegram] Config removed, poll loop exiting');
        break;
      }
      const token = telegramConfig.botToken;
      try {
        const resp = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            offset: telegramLastUpdateId + 1,
            timeout: TELEGRAM_POLL_TIMEOUT,
            allowed_updates: ['message', 'callback_query']
          })
        });
        if (resp.status === 401 || resp.status === 404) {
          // Token revoked/invalid — stop polling and surface it to the popup
          telegramLastError = 'Bot token is no longer valid — reconnect from the popup.';
          console.warn('[Telegram] Token invalid (HTTP', resp.status + '), poll loop exiting');
          break;
        }
        if (resp.status === 409) {
          // Another getUpdates consumer (second device?) — back off, retry
          console.warn('[Telegram] getUpdates conflict (409) — another poller active');
          await new Promise(r => setTimeout(r, 15000));
          continue;
        }
        if (!resp.ok) {
          console.warn('[Telegram] getUpdates HTTP error:', resp.status);
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        const data = await resp.json();
        if (data && data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            if (typeof update.update_id === 'number' && update.update_id > telegramLastUpdateId) {
              telegramLastUpdateId = update.update_id;
            }
            try {
              await telegramDispatchUpdate(update);
            } catch (e) {
              console.error('[Telegram] Handler error:', e);
            }
          }
          if (data.result.length > 0) {
            chrome.storage.local.set({ telegramLastUpdateId }).catch(() => {});
          }
        }
      } catch (e) {
        console.warn('[Telegram] Poll iteration failed:', (e && e.message) || e);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  } finally {
    telegramPollActive = false;
    console.log('[Telegram] Poll loop exited');
  }
}

// Kick off the poll on service worker startup (no-op when not connected)
telegramConfigReady.then(() => telegramPollLoop());

console.log('[Background] Service worker started');
