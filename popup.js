// HD Clearance Scanner Extension - Popup
// SKU checking runs in the background service worker; this popup is a thin UI
// over chrome.storage + runtime messages. Do not write popup-only state to the
// `scanState` storage key — that key belongs to background.js's resume data.

const API_URL = "https://apionline.homedepot.com/federation-gateway/graphql";

// Known yellow-tag item at store #2580 (Westminster MD). Used to self-verify
// the penny-detection rule: the conjunction
//   anchorStoreStatusType==='CLEARANCE' && pricing.clearance!=null &&
//   clearance.value<pricing.value && pickupFulfillable===false
// should evaluate to true for this SKU whenever the tag is still live at the store.
const YELLOW_TAG_CANARY = '206005261';

const PRODUCT_QUERY = `
query productClientOnlyProduct($itemId: String!, $storeId: String!) {
  product(itemId: $itemId) {
    itemId
    identifiers {
      productLabel
      brandName
      canonicalUrl
      modelNumber
      storeSkuNumber
    }
    details {
      descriptiveAttributes {
        name
        value
      }
    }
    pricing(storeId: $storeId) {
      value
      original
      clearance { value dollarOff percentageOff }
    }
    fulfillment(storeId: $storeId) {
      fulfillmentOptions {
        type
        fulfillable
        services {
          type
          locations {
            inventory { quantity isInStock }
            storeName
            locationId
          }
        }
      }
    }
  }
}`;

let scanning = false;
let clearanceItems = [];
let stats = { checked: 0, found: 0, errors: 0 };
let activeTabId = null;
let currentScanType = null;

const $ = (id) => document.getElementById(id);

// All API/DB strings that end up in innerHTML go through this.
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function emptyStateHtml(iconPath, text, hint) {
  return `<div class="empty-state">
    <div class="empty-state-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${iconPath}</svg>
    </div>
    <div class="empty-state-text">${text}</div>
    <div class="empty-state-hint">${hint}</div>
  </div>`;
}

const ICON_TAG = '<path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.58 3.24H5a2 2 0 0 0-2 2v4.58c0 .53.21 1.04.59 1.42l9.58 9.58a2 2 0 0 0 2.83 0l4.59-4.58a2 2 0 0 0 0-2.83z"/><circle cx="7.5" cy="7.5" r="1.5" fill="currentColor" stroke="none"/>';
const ICON_COIN = '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5a2.5 2 0 0 1 5 0c0 2-2.5 2-2.5 4"/>';
const ICON_BOX = '<path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4"/>';
const ICON_CLOCK = '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>';

// Friendly names for scan types coming from background.js
function scanTypeLabel(scanType) {
  if (scanType && scanType.includes('penny')) return 'Penny scan';
  if (scanType === 'skuCheckOnly') return 'Quick recheck';
  return 'Clearance scan';
}

function formatCacheAge(lastUpdated) {
  if (!lastUpdated) return '';
  const hours = Math.round((Date.now() - lastUpdated) / 3600000);
  if (hours < 1) return ' (list from under an hour ago)';
  if (hours < 48) return ` (list from ${hours}h ago)`;
  return ` (list from ${Math.round(hours / 24)} days ago)`;
}

// One place to flip the whole popup between "idle" and "scanning" so buttons
// never get stranded in the wrong state.
function setScanningUI(isScanning) {
  scanning = isScanning;
  $('sitemapScanBtn').style.display = isScanning ? 'none' : '';
  $('pennyScanBtn').style.display = isScanning ? 'none' : '';
  $('checkSkusOnlyBtn').style.display = isScanning ? 'none' : '';
  $('scanHint').style.display = isScanning ? 'none' : '';
  $('stopBtn').style.display = isScanning ? 'flex' : 'none';
  $('progress').style.display = isScanning ? 'block' : 'none';
  if (isScanning) $('resumeBanner').style.display = 'none';
}

function setOverflowStatus(text) {
  const el = $('overflowStatus');
  if (!el) return;
  el.textContent = text;
  el.style.display = text ? 'block' : 'none';
}

// Listen for progress updates from content script AND background worker
chrome.runtime.onMessage.addListener((message) => {
  // The progress bar is PER-STEP (0-100% of the current step), so it always
  // matches the "X of Y" in the status line. The step label carries the
  // overall position (1 of 3 → 2 of 3 → 3 of 3).
  if (message.type === 'skuProgress') {
    const phase = message.phase || (message.category?.startsWith('Overflow') ? 'overflow' : 'collecting');
    if (phase === 'overflow') {
      // Overflow re-check runs behind the main scan — show it on the secondary line
      setOverflowStatus(`Also re-checking overstuffed departments… ${message.skuCount.toLocaleString()} products total`);
    } else {
      if (!scanning) setScanningUI(true);
      const pct = message.total ? (message.current / message.total * 100) : 0;
      setProgress(pct);
      if (phase === 'mapping') {
        // Early one-off events report 0 of 1 — skip the numbers until the
        // department walk actually starts. Note: total grows as new
        // departments are discovered, so this count climbs while it runs.
        const counts = message.total > 1 ? `: ${message.current.toLocaleString()} of ${message.total.toLocaleString()} found so far` : '…';
        setStatus(`Step 1 of 3 — mapping your store's departments${counts}`);
      } else {
        // The product list starts pre-loaded with the cache from previous scans
        // of this store — spell that out so the big number isn't confusing.
        const dept = `department ${message.current.toLocaleString()} of ${message.total.toLocaleString()}`;
        const cached = message.cachedCount || 0;
        const newFound = Math.max(0, message.skuCount - cached);
        if (cached > 0) {
          setStatus(`Step 2 of 3 — refreshing your product list: ${message.skuCount.toLocaleString()} total (${cached.toLocaleString()} from your last scan + ${newFound.toLocaleString()} new) · ${dept}`);
        } else {
          setStatus(`Step 2 of 3 — collecting products: ${message.skuCount.toLocaleString()} found so far · ${dept}`);
        }
      }
    }
  }

  // Background scan progress
  if (message.type === 'scanProgress') {
    if (message.scanType) currentScanType = message.scanType;
    setScanningUI(true);
    const pct = Math.round((message.checked / message.total) * 100);
    setProgress(pct);

    const isPenny = currentScanType && currentScanType.includes('penny');
    const phase = currentScanType === 'sitemap' ? 'Step 3 of 3 — checking prices' :
      isPenny ? 'Penny scan' : 'Checking prices';
    const found = `${message.found} ${isPenny ? 'pennies' : 'deals'} found`;
    const diag = message.clearanceSeen > 0 ? ` · ${message.clearanceSeen} seen / ${message.filteredOut} filtered` : '';
    const counts = `${message.checked.toLocaleString()} of ${message.total.toLocaleString()}`;

    let statusText = `${phase}: ${counts} · ${found}${diag}`;
    if (message.needsTab) {
      statusText = 'Open homedepot.com in any tab — the scan will pick back up automatically.';
    } else if (message.rateLimitLevel === 'heavy') {
      statusText = `Server is rate-limiting requests — pausing ${message.cooldownSec}s, then continuing (${counts} done)`;
    } else if (message.rateLimitLevel === 'moderate') {
      statusText = `Slowing down ${message.cooldownSec}s to avoid overloading the server (${counts} done)`;
    } else if (message.rateLimitLevel === 'light') {
      statusText = `Quick ${message.cooldownSec}s pause — pacing our requests (${counts} done)`;
    }
    setStatus(statusText);

    stats = { checked: message.checked, found: message.found, errors: message.errors };
    updateStats();
    setScanPanelScanning(true, message.scanType);

    // Load and render clearance items as they're found
    if (message.found > clearanceItems.length) {
      loadClearanceFromStorage();
    }
  }

  // Background scan complete
  if (message.type === 'scanComplete') {
    setScanningUI(false);
    setProgress(100);
    setOverflowStatus('');
    if (message.scanType) currentScanType = message.scanType;
    const isPenny = currentScanType && currentScanType.includes('penny');
    const label = isPenny ? 'penny item' : 'clearance deal';
    setStatus(`Scan complete — ${message.found} ${label}${message.found === 1 ? '' : 's'} found.`);
    setScanPanelScanning(false, currentScanType);
    loadClearanceFromStorage();
  }

  // Sitemap main pass done — background scan is started by content script directly.
  // This handler only updates popup UI if the popup is open.
  if (message.type === 'sitemapMainPassDone') {
    setStatus(`Found ${message.skuCount.toLocaleString()} products across ${message.categoriesWithProducts} departments. Step 3 of 3 — checking prices…`);
    setProgress(0); // bar restarts for the price-check step
  }

  // Sitemap overflow done — update overflow status
  if (message.type === 'sitemapOverflowDone') {
    if (message.newSkus > 0) {
      setOverflowStatus(`Overflow check done: ${message.newSkus.toLocaleString()} more products (${message.totalSkus.toLocaleString()} total)`);
      setTimeout(() => setOverflowStatus(''), 10000);
    } else {
      setOverflowStatus('');
    }
  }
});

// Load clearance items from storage (set by background worker)
async function loadClearanceFromStorage() {
  const data = await chrome.storage.local.get(['clearanceItems', 'scanStats']);
  if (data.clearanceItems) {
    clearanceItems = data.clearanceItems;
    renderResults();

    // Save to IndexedDB for Saved/Compare/History tabs
    const storeId = $('storeId').value;
    if (storeId && clearanceItems.length > 0) {
      await saveToDatabase(clearanceItems, storeId, data.scanStats);
    }
  }
}

// Save scan results to IndexedDB
async function saveToDatabase(items, storeId, scanStats) {
  try {
    const saveResponse = await sendToContentScript({
      action: 'db_saveItems',
      items: items,
      storeId: storeId
    });

    if (saveResponse?.success) {
      console.log(`[Popup] Saved ${saveResponse.savedCount} items to database`);
    }

    const recordResponse = await sendToContentScript({
      action: 'db_recordScan',
      storeId: storeId,
      stats: {
        skusChecked: scanStats?.checked || stats.checked || 0,
        clearanceFound: items.length,
        errors: scanStats?.errors || stats.errors || 0
      }
    });

    if (recordResponse?.success) {
      console.log(`[Popup] Recorded scan to database`);
    }

    await loadDbStats();

  } catch (e) {
    console.error('[Popup] Failed to save to database:', e);
  }
}

function showConnectionResult(className, html) {
  const result = $('connectionResult');
  result.className = className;
  result.innerHTML = html;
  result.style.display = 'block';
}

// Test API connection / rate limit status
async function testApiConnection() {
  const btn = $('testConnectionBtn');
  btn.disabled = true;
  btn.textContent = 'Testing…';
  showConnectionResult('banner info', 'Contacting Home Depot’s API…');

  const storeId = $('storeId').value;
  // Use a common SKU (a basic item that should always exist)
  const testSku = '100375745';
  const start = Date.now();

  try {
    const url = `${API_URL}?opname=productClientOnlyProduct`;
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-experience-name': 'general-merchandise'
      },
      body: JSON.stringify({
        operationName: 'productClientOnlyProduct',
        variables: { itemId: testSku, storeId: storeId },
        query: PRODUCT_QUERY
      })
    });

    const elapsed = Date.now() - start;
    const meta = `<span style="font-size:11px;">${elapsed}ms &middot; Store #${escapeHtml(storeId)}</span>`;

    if (response.status === 403) {
      showConnectionResult('banner warn', `<strong>&#9888; Rate limited (403)</strong><br>Home Depot is blocking requests. Wait a few minutes before scanning again.<br>${meta}`);
    } else if (response.status === 429) {
      showConnectionResult('banner warn', `<strong>&#9888; Too many requests (429)</strong><br>You've hit the request limit. Wait 5-10 minutes.<br>${meta}`);
    } else if (response.ok) {
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const data = await response.json();
        if (data?.data?.product) {
          showConnectionResult('banner ok', `<strong>&#10003; API is working</strong><br>Got a valid response. You're good to scan.<br>${meta}`);
        } else if (data?.errors) {
          showConnectionResult('banner warn', `<strong>&#9888; API returned errors</strong><br>${escapeHtml(data.errors[0]?.message || 'Unknown error')}<br>${meta}`);
        } else {
          showConnectionResult('banner ok', `<strong>&#10003; API responding</strong><br>Got HTTP 200 but no product data. API is reachable.<br>${meta}`);
        }
      } else {
        showConnectionResult('banner warn', `<strong>&#9888; Non-JSON response</strong><br>Got HTTP ${response.status} but the response isn't JSON. Possible CAPTCHA or redirect.<br>${meta}`);
      }
    } else {
      showConnectionResult('banner error', `<strong>&#10007; HTTP ${response.status}</strong><br>Unexpected status code. The API may be down or blocking you.<br>${meta}`);
    }
  } catch (e) {
    showConnectionResult('banner error', `<strong>&#10007; Connection failed</strong><br>${escapeHtml(e.message)}<br><span style="font-size:11px;">Make sure a homedepot.com tab is open.</span>`);
  }

  btn.disabled = false;
  btn.textContent = 'Test API Connection';
}

// Verify that the yellow-tag conjunction still evaluates true for the canary SKU.
// If this returns FAIL, either HD removed the canary's clearance or the detection
// rule has drifted — investigate before trusting scan results.
async function verifyPennyDetection() {
  const btn = $('verifyDetectionBtn');
  btn.disabled = true;
  btn.textContent = 'Checking canary…';
  showConnectionResult('banner info', 'Checking the canary SKU…');

  const storeId = $('storeId').value;
  const query = `
    query productClientOnlyProduct($itemId: String!, $storeId: String!) {
      product(itemId: $itemId) {
        itemId
        pricing(storeId: $storeId) { value clearance { value percentageOff } }
        fulfillment(storeId: $storeId) {
          anchorStoreStatusType
          fulfillmentOptions { type fulfillable services { type } }
        }
      }
    }`;

  try {
    const url = `${API_URL}?opname=productClientOnlyProduct`;
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'x-experience-name': 'general-merchandise' },
      body: JSON.stringify({
        operationName: 'productClientOnlyProduct',
        variables: { itemId: YELLOW_TAG_CANARY, storeId },
        query
      })
    });

    if (!response.ok) {
      showConnectionResult('banner error', `<strong>&#10007; Canary request failed</strong><br>HTTP ${response.status} hitting API for ${YELLOW_TAG_CANARY}`);
      return;
    }

    const data = await response.json();
    const p = data?.data?.product;
    if (!p) {
      showConnectionResult('banner error', `<strong>&#10007; Canary ${YELLOW_TAG_CANARY} returned no product</strong><br>${escapeHtml(JSON.stringify(data?.errors || {}).slice(0, 200))}`);
      return;
    }

    const onlinePrice = p.pricing?.value ?? null;
    const clearancePrice = p.pricing?.clearance?.value ?? null;
    const anchor = p.fulfillment?.anchorStoreStatusType;
    const pickupOpt = (p.fulfillment?.fulfillmentOptions || []).find(o => o.type === 'pickup');
    const pickupFulfillable = pickupOpt ? !!pickupOpt.fulfillable : null;

    const yellowTag = anchor === 'CLEARANCE'
                   && clearancePrice != null
                   && onlinePrice != null
                   && clearancePrice < onlinePrice
                   && pickupFulfillable === false;

    const checks = [
      { label: `anchorStoreStatusType === "CLEARANCE"`, got: anchor, pass: anchor === 'CLEARANCE' },
      { label: `pricing.clearance.value != null`, got: clearancePrice, pass: clearancePrice != null },
      { label: `clearance.value < pricing.value`, got: `${clearancePrice} < ${onlinePrice}`, pass: clearancePrice != null && onlinePrice != null && clearancePrice < onlinePrice },
      { label: `pickupFulfillable === false`, got: pickupFulfillable, pass: pickupFulfillable === false }
    ];

    const rows = checks.map(c => `<div style="font-size:11px;">${c.pass ? '&#10003;' : '&#10007;'} ${escapeHtml(c.label)} — got <code>${escapeHtml(c.got)}</code></div>`).join('');
    if (yellowTag) {
      showConnectionResult('banner ok', `<strong>&#10003; Canary ${YELLOW_TAG_CANARY} detected as yellow tag</strong>${rows}`);
    } else {
      showConnectionResult('banner warn', `<strong>&#9888; Canary ${YELLOW_TAG_CANARY} NOT detected</strong><br><span style="font-size:11px;">Either HD removed the tag or the rule drifted.</span>${rows}`);
    }
  } catch (e) {
    showConnectionResult('banner error', `<strong>&#10007; Canary check failed</strong><br>${escapeHtml(e.message)}`);
  }

  btn.disabled = false;
  btn.textContent = 'Verify Penny Detection';
}

async function probeB2B() {
  const btn = $('probeB2BBtn');
  const result = $('b2bResult');
  btn.disabled = true;
  btn.textContent = 'Probing B2B API…';
  result.style.display = 'block';
  result.className = 'banner info';
  result.textContent = 'Sending probes to B2B backend…';

  const storeId = $('storeId').value;
  // Use the known penny item SKU from the third-party app screenshot
  const testSku = '1010230613';

  try {
    // Route through background service worker to bypass CORS
    const response = await chrome.runtime.sendMessage({
      action: 'probeB2B',
      storeId: storeId,
      sku: testSku
    });

    if (!response?.results) {
      result.className = 'banner error';
      result.textContent = 'No response from background worker';
      btn.disabled = false;
      btn.textContent = 'Probe B2B Inventory API';
      return;
    }

    let html = `<strong>B2B Probe Results</strong> (store=${escapeHtml(storeId)}, sku=${testSku})\n\n`;
    for (const r of response.results) {
      const icon = r.status === 200 ? '&#10003;' : r.status === 403 ? '&#128274;' : '&#10007;';
      html += `${icon} <strong>${r.status}</strong> ${escapeHtml(r.path)}\n`;
      if (r.body && typeof r.body === 'object') {
        html += `   ${escapeHtml(JSON.stringify(r.body, null, 1).slice(0, 500))}\n`;
      } else if (r.body && r.status !== 403) {
        html += `   ${escapeHtml(String(r.body).slice(0, 300))}\n`;
      }
    }

    const has200 = response.results.some(r => r.status === 200);
    const has403 = response.results.some(r => r.status === 403);
    result.className = has200 ? 'banner ok' : has403 ? 'banner warn' : 'banner error';
    result.innerHTML = html;

    if (has200) {
      result.innerHTML += '\n<strong>WE HAVE ACCESS — Pro Xtra session is working!</strong>';
    } else if (has403) {
      result.innerHTML += '\n<strong>403 = endpoint exists but Pro Xtra session alone is not enough.</strong>';
    }
  } catch (e) {
    result.className = 'banner error';
    result.textContent = `Probe failed: ${e.message}`;
  }

  btn.disabled = false;
  btn.textContent = 'Probe B2B Inventory API';
}

// Check if background scan is running when popup opens
async function checkBackgroundScan() {
  try {
    const state = await chrome.runtime.sendMessage({ action: 'getScanState' });
    if (state && state.running) {
      if (state.scanType) currentScanType = state.scanType;
      clearanceItems = state.clearanceItems || [];
      stats = { checked: state.checked, found: state.found, errors: state.errors };
      updateStats();
      renderResults();
      setScanningUI(true);
      setScanPanelScanning(true, currentScanType);

      const pct = Math.round((state.checked / state.total) * 100);
      setProgress(pct);
      const isPenny = currentScanType && currentScanType.includes('penny');
      setStatus(`${scanTypeLabel(currentScanType)} running: ${state.checked.toLocaleString()} of ${state.total.toLocaleString()} · ${state.found} ${isPenny ? 'pennies' : 'deals'} found`);
      return true;
    } else if (state && state.clearanceItems?.length > 0 && !state.running) {
      // Scan finished while popup was closed — show results
      if (state.scanType) currentScanType = state.scanType;
      clearanceItems = state.clearanceItems;
      stats = { checked: state.checked, found: state.found, errors: state.errors };
      updateStats();
      renderResults();

      const storeId = $('storeId').value;
      if (storeId && clearanceItems.length > 0) {
        saveToDatabase(clearanceItems, storeId, stats);
      }
    }
  } catch (e) {
    console.log('No background scan running');
  }
  return false;
}

// Dynamic store name mapping — populated from searches and scan history
let STORE_NAMES = {};

// Load saved stores from storage
async function loadSavedStores() {
  const data = await chrome.storage.local.get(['savedStores', 'selectedStore']);
  if (data.savedStores) {
    STORE_NAMES = data.savedStores;
  }
  if (data.selectedStore) {
    $('storeId').value = data.selectedStore.storeId;
    showSelectedStore(data.selectedStore);
  }
  populateFilterStores();
}

function populateFilterStores() {
  const filterEl = $('filterStore');
  if (!filterEl) return;
  // Keep "All Stores" option, clear the rest
  filterEl.innerHTML = '<option value="">All Stores</option>';
  for (const [id, name] of Object.entries(STORE_NAMES)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = `${name} (#${id})`;
    filterEl.appendChild(opt);
  }
}

// GraphQL query to find stores — exact query from HD's store locator
const STORE_SEARCH_QUERY = `
query storeSearch($lat: String, $lng: String, $storeSearchInput: String, $pagesize: String, $storeFeaturesFilter: StoreFeaturesFilter) {
  storeSearch(
    lat: $lat
    lng: $lng
    storeSearchInput: $storeSearchInput
    pagesize: $pagesize
    storeFeaturesFilter: $storeFeaturesFilter
  ) {
    stores {
      storeId
      name
      address {
        street
        city
        state
        postalCode
        country
      }
      coordinates {
        lat
        lng
      }
      distance
      phone
      storeDetailsPageLink
      storeType
    }
  }
}`;

async function searchStores(query) {
  const searchBtn = $('searchStoreBtn');
  const resultsEl = $('storeResults');
  searchBtn.disabled = true;
  searchBtn.textContent = '…';
  resultsEl.innerHTML = '';
  resultsEl.style.display = 'none';

  try {
    const response = await fetch(`${API_URL}?opname=storeSearch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-experience-name': 'general-merchandise'
      },
      body: JSON.stringify({
        operationName: 'storeSearch',
        variables: {
          lat: '',
          lng: '',
          pagesize: '20',
          storeSearchInput: query.trim(),
          storeFeaturesFilter: {
            applianceShowroom: false,
            expandedFlooringShowroom: false,
            wiFi: false,
            keyCutting: false,
            loadNGo: false,
            penske: false,
            propane: false,
            toolRental: false
          }
        },
        query: STORE_SEARCH_QUERY
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const stores = data?.data?.storeSearch?.stores;

    if (!stores || stores.length === 0) {
      resultsEl.innerHTML = '<div style="padding: 12px; color: var(--ink-3); font-size: 12px; text-align: center;">No stores found. Try a different ZIP code.</div>';
      resultsEl.style.display = 'block';
      return;
    }

    // Render store results (already sorted by distance from API)
    resultsEl.innerHTML = stores.map(store => {
      const addr = store.address || {};
      const cityState = [addr.city, addr.state].filter(Boolean).join(', ');
      const distText = store.distance ? `${store.distance} mi` : '';
      // Normalize: API returns "name", we store as "storeName" internally
      const storeNormalized = { ...store, storeName: store.name || store.storeName };
      return `
        <div class="store-result-item" data-store="${escapeHtml(JSON.stringify(storeNormalized))}">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div class="store-result-name">${escapeHtml(store.name || 'Store')} #${escapeHtml(store.storeId)}</div>
            ${distText ? `<div class="store-result-distance">${escapeHtml(distText)}</div>` : ''}
          </div>
          <div class="store-result-detail">${escapeHtml(addr.street ? addr.street + ', ' : '')}${escapeHtml(cityState)} ${escapeHtml(addr.postalCode || '')}</div>
        </div>
      `;
    }).join('');

    resultsEl.style.display = 'block';

    resultsEl.querySelectorAll('.store-result-item').forEach(el => {
      el.addEventListener('click', () => {
        const store = JSON.parse(el.dataset.store);
        selectStore(store);
      });
    });

  } catch (e) {
    console.error('[Store Search] Error:', e);
    resultsEl.innerHTML = `<div style="padding: 12px; color: var(--red); font-size: 12px; text-align: center;">Search failed: ${escapeHtml(e.message)}. Open a homedepot.com tab and try again.</div>`;
    resultsEl.style.display = 'block';
  } finally {
    searchBtn.disabled = false;
    searchBtn.textContent = 'Find';
  }
}

function selectStore(store) {
  $('storeId').value = store.storeId;

  STORE_NAMES[store.storeId] = store.storeName || store.name || `Store #${store.storeId}`;

  // Persist selection and known stores
  chrome.storage.local.set({
    storeId: store.storeId,
    selectedStore: store,
    savedStores: STORE_NAMES
  });

  showSelectedStore(store);
  $('storeResults').style.display = 'none';
  populateFilterStores();
}

function showSelectedStore(store) {
  const addr = store.address || {};
  const cityState = [addr.city, addr.state].filter(Boolean).join(', ');

  $('selectedStoreName').textContent = `${store.storeName || store.name || 'Store'} #${store.storeId}`;
  $('selectedStoreDetail').textContent = [addr.street, cityState, addr.postalCode].filter(Boolean).join(', ');
  $('selectedStoreDisplay').style.display = 'block';

  // Hide the search row if a store is selected (keep it accessible via "Change store")
  $('zipInput').value = '';
  $('storeResults').style.display = 'none';
}

function clearSelectedStore() {
  $('selectedStoreDisplay').style.display = 'none';
  $('storeId').value = '';
  $('zipInput').focus();
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  $('sitemapScanBtn').addEventListener('click', startSitemapScan);
  $('stopBtn').addEventListener('click', stopScan);
  $('checkSkusOnlyBtn').addEventListener('click', startCheckSkusOnly);
  $('pennyScanBtn').addEventListener('click', showPennyDisclaimer);
  $('pennyDisclaimerConfirm').addEventListener('click', () => {
    hidePennyDisclaimer();
    startPennyScan();
  });
  $('pennyDisclaimerCancel').addEventListener('click', hidePennyDisclaimer);
  $('pennyDisclaimerModal').addEventListener('click', (e) => {
    if (e.target.id === 'pennyDisclaimerModal') hidePennyDisclaimer();
  });
  $('testConnectionBtn').addEventListener('click', testApiConnection);
  $('downloadFulfillmentLogBtn').addEventListener('click', downloadFulfillmentLog);
  $('verifyDetectionBtn').addEventListener('click', verifyPennyDetection);
  $('probeB2BBtn').addEventListener('click', probeB2B);

  // Store search
  $('searchStoreBtn').addEventListener('click', () => {
    const query = $('zipInput').value.trim();
    if (query) searchStores(query);
  });
  $('zipInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const query = $('zipInput').value.trim();
      if (query) searchStores(query);
    }
  });
  $('changeStoreBtn').addEventListener('click', clearSelectedStore);

  await loadSavedStores();

  // Resume/Discard buttons
  $('resumeBtn').addEventListener('click', async () => {
    $('resumeBanner').style.display = 'none';
    setScanningUI(true);

    try {
      const response = await chrome.runtime.sendMessage({ action: 'resumeScan' });
      if (response?.resumed) {
        setStatus(`Resuming scan from ${response.from.toLocaleString()}…`);
      } else {
        setStatus('Nothing to resume' + (response?.reason ? `: ${response.reason}` : '.'));
        setScanningUI(false);
      }
    } catch (e) {
      setStatus('Could not resume: ' + e.message);
      setScanningUI(false);
    }
  });

  $('discardBtn').addEventListener('click', () => {
    // scanState/scanSkus are background.js's resume data — removing them here
    // is the one legitimate popup write to those keys.
    chrome.storage.local.remove(['scanState', 'scanSkus']);
    $('resumeBanner').style.display = 'none';
    setStatus('Saved scan discarded. Ready when you are.');
  });

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Database buttons
  $('exportDbBtn').addEventListener('click', exportDatabase);
  $('clearDbBtn').addEventListener('click', clearDatabase);

  // Filter changes
  $('filterStore').addEventListener('change', loadAllItems);
  $('filterSort').addEventListener('change', loadAllItems);

  // Telegram connect flow
  $('tgConnectBtn').addEventListener('click', tgConnect);
  $('tgTokenInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') tgConnect();
  });
  $('tgCancelBtn').addEventListener('click', () => tgCancelConnect());
  $('tgTestBtn').addEventListener('click', tgSendTest);
  $('tgDisconnectBtn').addEventListener('click', tgDisconnect);
  $('tgChannelSaveBtn').addEventListener('click', tgSaveChannel);
  $('tgChannelInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') tgSaveChannel();
  });
  $('tgChannelRemoveBtn').addEventListener('click', tgRemoveChannel);
  // Remember the card's collapsed/expanded state across popup opens
  $('telegramCard').addEventListener('toggle', () => {
    if (!tgCardInitialized) return; // ignore the programmatic initial set
    chrome.storage.local.set({ tgCardOpen: $('telegramCard').open });
  });
  tgRefreshStatus();

  // Check connection FIRST (injects content script)
  await checkConnection();

  // Restore last scan's results
  await loadSavedState();

  // Check if background scan is already running
  const bgRunning = await checkBackgroundScan();

  // If no running scan, check for interrupted scan that can be resumed
  if (!bgRunning) {
    await checkForInterruptedScan();
  }

  await loadDbStats();
});

async function checkConnection() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url || !tab.url.includes('homedepot.com')) {
      showError('Please navigate to homedepot.com first, then open this extension.');
      return false;
    }

    activeTabId = tab.id;

    // Try to ping content script
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
      if (response?.status === 'ok') {
        if (!scanning) {
          setStatus('Connected — ready to scan.');
        }
        return true;
      }
    } catch (pingError) {
      console.log('Ping failed, trying to inject content script...', pingError);

      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['db.js', 'content.js']
        });

        await new Promise(r => setTimeout(r, 500));

        const retryResponse = await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
        if (retryResponse?.status === 'ok') {
          if (!scanning) {
            setStatus('Connected — ready to scan.');
          }
          return true;
        }
      } catch (injectError) {
        console.error('Failed to inject content script:', injectError);
      }

      throw pingError;
    }
  } catch (e) {
    console.error('Connection error:', e);
    showError(`Connection failed: ${e.message}. Try refreshing the Home Depot page.`);
    return false;
  }
  return false;
}

// Restore the last scan's results into the Latest tab.
// NOTE: `scanState` in storage belongs to background.js (resume data) — the
// popup only reads it in checkForInterruptedScan and never writes it.
async function loadSavedState() {
  const data = await chrome.storage.local.get(['storeId', 'clearanceItems', 'scanStats']);
  if (data.storeId) {
    $('storeId').value = data.storeId;
  }
  if (data.clearanceItems && data.clearanceItems.length > 0) {
    clearanceItems = data.clearanceItems;
    renderResults();

    const storeId = data.storeId || $('storeId').value;
    if (storeId) {
      await saveToDatabase(clearanceItems, storeId, data.scanStats || stats);
    }
  }
}

// Check for an interrupted scan that can be resumed.
// scanState holds the cursor; the SKU list lives under scanSkus (legacy
// states embedded skus inside scanState — handle both).
async function checkForInterruptedScan() {
  try {
    const data = await chrome.storage.local.get(['scanState', 'scanSkus', 'clearanceItems']);
    const state = data.scanState;
    if (!state) return;
    const total = state.total ?? state.skus?.length ?? data.scanSkus?.length ?? 0;
    if (total > 0 && typeof state.currentIndex === 'number' && state.currentIndex < total) {
      const remaining = total - state.currentIndex;
      const found = state.clearanceItems?.length ?? data.clearanceItems?.length ?? 0;
      const storeName = STORE_NAMES[state.storeId] || (state.storeId ? `store #${state.storeId}` : 'your store');
      $('resumeInfo').textContent =
        `${scanTypeLabel(state.scanType)} at ${storeName}: ${state.currentIndex.toLocaleString()} of ${total.toLocaleString()} checked · ${found} found · ${remaining.toLocaleString()} to go`;
      $('resumeBanner').style.display = 'block';
    }
  } catch (e) {
    console.log('No interrupted scan found:', e);
  }
}

function setScanPanelScanning(isScanning, scanType) {
  const title = $('scanPanelTitle');
  if (!title) return;
  const isPenny = scanType && scanType.includes('penny');
  if (isScanning) {
    title.innerHTML = isPenny
      ? '<span class="scanning-dot"></span>Penny Scan…'
      : '<span class="scanning-dot"></span>Scanning…';
  } else {
    title.textContent = isPenny ? 'Penny Items Found' : 'Clearance Found';
  }
}

function setStatus(msg) {
  $('status').textContent = msg;
}

function setProgress(pct) {
  $('progressBar').style.width = pct + '%';
}

function showError(msg) {
  // Route "navigate to homedepot.com" messages to the friendly connection banner
  if (msg && msg.toLowerCase().includes('navigate to homedepot.com')) {
    $('connectionBanner').style.display = 'block';
    return;
  }
  const el = $('error');
  el.textContent = msg;
  el.style.display = 'block';
}

function hideError() {
  $('error').style.display = 'none';
  $('connectionBanner').style.display = 'none';
}

function updateStats() {
  $('skuCount').textContent = stats.checked.toLocaleString();
  $('errorCount').textContent = stats.errors;
  setItemCountBadge(stats.found);
  // Show error count only when there are errors
  $('errorDisplay').style.display = stats.errors > 0 ? '' : 'none';
}

function setItemCountBadge(count) {
  $('itemCountBadge').innerHTML = `<span id="itemCount">${count}</span> item${count === 1 ? '' : 's'}`;
}

function renderResults() {
  const container = $('results');
  const isPenny = currentScanType && currentScanType.includes('penny');

  // Penny scan: show all results. Normal scan: only advertised (yellow-tag)
  // clearance with stock — this filter is intentional, do not remove.
  const verifiedItems = isPenny
    ? clearanceItems
    : clearanceItems.filter(item => item.isAdvertised && item.quantity > 0);
  setItemCountBadge(verifiedItems.length);

  if (verifiedItems.length === 0 && stats.checked === 0) {
    container.innerHTML = emptyStateHtml(
      isPenny ? ICON_COIN : ICON_TAG,
      'No scan results yet',
      isPenny ? 'Hit Penny Scan to hunt for $0.01 items at your store' : 'Pick your store above and hit Scan for Clearance'
    );
    return;
  }

  if (verifiedItems.length === 0 && stats.checked > 0) {
    container.innerHTML = emptyStateHtml(
      ICON_TAG,
      isPenny ? 'No penny items this time' : 'No clearance found this time',
      `Checked ${stats.checked.toLocaleString()} products — markdowns change daily, try again soon or scan another store`
    );
    return;
  }

  // Sort: penny scan by price asc, normal scan by percent off
  const sorted = isPenny
    ? [...verifiedItems].sort((a, b) => (a.onlinePrice || 0) - (b.onlinePrice || 0))
    : [...verifiedItems].sort((a, b) => b.percentOff - a.percentOff);

  container.innerHTML = sorted.slice(0, 50).map(item => {
    const isPennyItem = item.pennyConfidence === 'confirmed';
    const name = escapeHtml(item.name || '');
    const shortName = name.length > 60 ? name.substring(0, 60) + '…' : name;
    const variantInfo = item.variant ? `<div class="item-variant">${escapeHtml(item.variant)}</div>` : '';
    const skuInfo = item.storeSkuNumber ? `<div class="item-meta">SKU ${escapeHtml(item.storeSkuNumber)} &middot; Item ${escapeHtml(item.itemId)}</div>` : '';

    const pennyBadge = isPennyItem ? '<span class="penny-badge">PENNY</span>' : '';
    const tagBadge = !isPennyItem && isPenny && item.isAdvertised ? '<span class="tag-badge">YELLOW TAG</span>' : '';
    const locationInfo = item.location ? ` &middot; <span class="item-location">Aisle ${escapeHtml(item.location)}</span>` : '';
    const stockInfo = isPennyItem
      ? (item.storeQuantity != null
          ? `<span style="color: var(--red); font-weight: 700;">${escapeHtml(item.storeQuantity)}+ in stock</span>`
          : '<span style="color: var(--red); font-weight: 700;">Stock unknown</span>')
      : `${escapeHtml(item.quantity)} in stock`;

    const clearancePrice = isPennyItem ? 0.01 : (item.clearancePrice ?? 0);
    const onlinePrice = item.onlinePrice ?? 0;
    const dollarOff = item.dollarOff ?? Math.max(0, onlinePrice - clearancePrice);

    return `
    <div class="${isPennyItem ? 'item item-penny' : 'item'}">
      <div class="item-name">${escapeHtml(item.brand || '')} ${shortName}${pennyBadge}${tagBadge}</div>
      ${variantInfo}
      <div class="item-price">
        $${clearancePrice.toFixed(2)}
        <span>$${onlinePrice.toFixed(2)}</span>
      </div>
      <div class="item-savings">${item.percentOff ?? 0}% off &middot; Save $${dollarOff.toFixed(2)} &middot; ${stockInfo}${locationInfo}</div>
      ${skuInfo}
      <a class="item-link" href="${escapeHtml(item.url || '#')}" target="_blank">View on homedepot.com &rarr;</a>
    </div>
  `;
  }).join('');

  if (sorted.length > 50) {
    container.innerHTML += `<div style="padding: 14px; text-align: center; color: var(--ink-3); font-size: 12px;">…and ${sorted.length - 50} more. Export from the History tab to see everything.</div>`;
  }
}

async function sendToContentScript(message, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(activeTabId, message, response => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(response);
          }
        });
      });
      return response;
    } catch (error) {
      console.log(`[Popup] Message failed (attempt ${attempt}/${retries}):`, error.message);

      if (attempt < retries) {
        // Wait for content script to reload after page change
        await new Promise(r => setTimeout(r, 1500));

        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab && tab.url?.includes('homedepot.com')) {
            activeTabId = tab.id;
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['db.js', 'content.js']
            });
            await new Promise(r => setTimeout(r, 500));
          }
        } catch (injectError) {
          console.log('[Popup] Could not inject script:', injectError.message);
        }
      } else {
        throw error;
      }
    }
  }
}

// ==================== FULL SCAN (discovery + price check) ====================

async function startSitemapScan() {
  const storeId = $('storeId').value.trim();
  if (!storeId) {
    showError('Pick your store first — search by ZIP code above.');
    return;
  }

  const connected = await checkConnection();
  if (!connected) return;

  chrome.storage.local.set({ storeId });

  currentScanType = null;
  clearanceItems = [];
  stats = { checked: 0, found: 0, errors: 0 };

  setScanningUI(true);
  hideError();
  setOverflowStatus('');
  setStatus('Step 1 of 3 — mapping your store\'s departments… (takes a few minutes)');
  setProgress(2);

  // Fire and forget — sitemapMainPassDone message handles starting the background scan
  sendToContentScript({
    action: 'getStoreSkusSitemap',
    storeId: storeId
  }).catch(e => {
    console.log('[Popup] Sitemap scan channel closed:', e.message);
  });
}

// ==================== QUICK RECHECK (skip discovery) ====================

async function startCheckSkusOnly() {
  const storeId = $('storeId').value.trim();
  if (!storeId) {
    showError('Pick your store first — search by ZIP code above.');
    return;
  }

  const connected = await checkConnection();
  if (!connected) return;

  setStatus('Loading your saved product list…');
  const stored = await chrome.storage.local.get(['skuInventoryMultiStore']);
  const storeData = stored.skuInventoryMultiStore?.[storeId];

  if (!storeData || !storeData.skus || storeData.skus.length === 0) {
    setStatus('');
    showError('No product list saved for this store yet. Run "Scan for Clearance" once first — after that, Quick Recheck is much faster.');
    return;
  }

  const skus = storeData.skus;
  const ageLabel = formatCacheAge(storeData.lastUpdated);

  currentScanType = null;
  clearanceItems = [];
  stats = { checked: 0, found: 0, errors: 0 };

  setScanningUI(true);
  hideError();
  setStatus(`Rechecking ${skus.length.toLocaleString()} products${ageLabel}…`);
  setProgress(5);

  try {
    await chrome.runtime.sendMessage({
      action: 'startBackgroundScan',
      skus: skus,
      storeId: storeId,
      scanType: 'skuCheckOnly'
    });

    setStatus('Recheck running in the background — you can close this popup.');
  } catch (e) {
    console.error('[Popup] Failed to start SKU check:', e);
    showError('Could not start the recheck. Try again in a moment.');
    setScanningUI(false);
  }
}

// ==================== PENNY SCAN ====================

function showPennyDisclaimer() {
  $('pennyDisclaimerModal').classList.add('open');
}

function hidePennyDisclaimer() {
  $('pennyDisclaimerModal').classList.remove('open');
}

async function startPennyScan() {
  const storeId = $('storeId').value.trim();
  if (!storeId) {
    showError('Pick your store first — search by ZIP code above.');
    return;
  }

  const connected = await checkConnection();
  if (!connected) return;

  setStatus('Loading your saved product list…');
  const stored = await chrome.storage.local.get(['skuInventoryMultiStore']);
  const storeData = stored.skuInventoryMultiStore?.[storeId];

  if (!storeData || !storeData.skus || storeData.skus.length === 0) {
    setStatus('');
    showError('No product list saved for this store yet. Run "Scan for Clearance" once first — after that, Penny Scan can run any time.');
    return;
  }

  const skus = storeData.skus;
  const ageLabel = formatCacheAge(storeData.lastUpdated);

  currentScanType = 'penny';
  clearanceItems = [];
  stats = { checked: 0, found: 0, errors: 0 };

  setScanningUI(true);
  hideError();
  setStatus(`Penny scan: ${skus.length.toLocaleString()} products${ageLabel}…`);
  setProgress(5);

  try {
    await chrome.runtime.sendMessage({
      action: 'startBackgroundScan',
      skus: skus,
      storeId: storeId,
      scanType: 'penny'
    });

    setStatus('Penny scan running in the background — you can close this popup.');
  } catch (e) {
    console.error('[Popup] Failed to start penny scan:', e);
    showError('Could not start the penny scan. Try again in a moment.');
    setScanningUI(false);
  }
}

async function downloadFulfillmentLog() {
  const response = await chrome.runtime.sendMessage({ action: 'downloadFulfillmentLog' });
  if (response?.error) {
    showError(response.error);
    return;
  }
  const log = response?.log || [];
  if (log.length === 0) {
    showError('No fulfillment log yet. Run a penny scan first.');
    return;
  }
  const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `fulfillment_log_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function stopScan() {
  setStatus('Stopping…');

  // Stop any running discovery in the content script
  sendToContentScript({ action: 'stopScan' }).catch(() => {});

  // Stop background scan — state is preserved for resume
  chrome.runtime.sendMessage({ action: 'stopBackgroundScan' })
    .then(() => {
      setScanningUI(false);
      setStatus('Scan paused — resume it any time from the banner above.');
      checkForInterruptedScan();
    })
    .catch(() => {
      setScanningUI(false);
      setStatus('Scan stopped.');
    });
}

// ==================== TELEGRAM CONNECT ====================
// Each user connects their own bot (one getUpdates consumer per token is a
// Telegram limit, so a shared bot can't serve multiple installs).

let tgDetectTimer = null;
let tgPending = null; // { botToken, botUsername } while waiting for /start
let tgCardInitialized = false; // set once the initial open/closed state is applied

function tgShowSection(section) {
  $('tgDisconnected').style.display = section === 'disconnected' ? 'block' : 'none';
  $('tgWaiting').style.display = section === 'waiting' ? 'block' : 'none';
  $('tgConnected').style.display = section === 'connected' ? 'block' : 'none';
  // The connect flow needs to be visible — pop the card open while waiting
  if (section === 'waiting') $('telegramCard').open = true;
}

function tgSetHeaderStatus(status) {
  const el = $('tgHeaderStatus');
  if (tgPending) {
    el.textContent = 'Finishing setup…';
    el.classList.remove('connected');
  } else if (status?.configured) {
    el.textContent = status.botUsername ? `Connected · @${status.botUsername}` : 'Connected';
    el.classList.add('connected');
  } else {
    el.textContent = 'Not connected';
    el.classList.remove('connected');
  }
}

async function tgRefreshStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ action: 'telegramGetStatus' });
    tgSetHeaderStatus(status);
    // First load: restore the user's collapsed/expanded choice; with no saved
    // choice, default to collapsed once connected, expanded during setup.
    if (!tgCardInitialized) {
      const { tgCardOpen } = await chrome.storage.local.get(['tgCardOpen']);
      $('telegramCard').open = typeof tgCardOpen === 'boolean' ? tgCardOpen : !status?.configured;
      tgCardInitialized = true;
    }
    if (status?.configured) {
      tgShowSection('connected');
      const bot = status.botUsername ? `@${status.botUsername}` : 'your bot';
      const chat = status.chatLabel || 'your chat';
      $('tgConnectedDetail').textContent = `${bot} → ${chat}`;
      // Deals channel row
      $('tgChannelCurrent').textContent = status.dealsChannel || 'your private chat';
      $('tgChannelInput').value = status.dealsChannel || '';
      $('tgChannelRemoveBtn').style.display = status.dealsChannel ? '' : 'none';
      $('tgChannelError').style.display = 'none';
      const note = $('tgStatusNote');
      if (status.lastError) {
        note.textContent = status.lastError;
        note.style.display = 'block';
      } else {
        note.style.display = 'none';
      }
    } else if (!tgPending) {
      tgShowSection('disconnected');
    }
  } catch (e) {
    console.log('Could not load Telegram status:', e);
  }
}

async function tgConnect() {
  const btn = $('tgConnectBtn');
  const errEl = $('tgConnectError');
  const token = $('tgTokenInput').value.trim();
  errEl.style.display = 'none';
  if (!token) return;

  btn.disabled = true;
  btn.textContent = '…';
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'telegramConnect', botToken: token });
    if (!resp?.ok) {
      errEl.textContent = resp?.error || 'Could not reach Telegram. Check your connection and try again.';
      errEl.style.display = 'block';
      return;
    }
    tgPending = { botToken: token, botUsername: resp.botUsername };
    const link = $('tgBotLink');
    link.textContent = `@${resp.botUsername}`;
    link.href = `https://t.me/${resp.botUsername}`;
    tgShowSection('waiting');
    tgStartDetectLoop();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
}

function tgStartDetectLoop() {
  tgStopDetectLoop();
  const startedAt = Date.now();
  tgDetectTimer = setInterval(async () => {
    if (!tgPending) { tgStopDetectLoop(); return; }
    // Give up after 3 minutes of waiting
    if (Date.now() - startedAt > 180000) {
      tgCancelConnect('Timed out waiting for your /start message. Try connecting again.');
      return;
    }
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'telegramDetectChat', botToken: tgPending.botToken });
      if (resp?.ok && resp.chat) {
        const pending = tgPending;
        tgStopDetectLoop();
        tgPending = null;
        const save = await chrome.runtime.sendMessage({
          action: 'telegramSaveConfig',
          botToken: pending.botToken,
          chatId: resp.chat.id,
          chatLabel: resp.chat.label,
          botUsername: pending.botUsername,
          lastUpdateId: resp.lastUpdateId
        });
        if (save?.ok) {
          $('tgTokenInput').value = '';
          setStatus('Telegram connected — check your chat for a confirmation.');
        }
        await tgRefreshStatus();
      } else if (resp?.ok === false) {
        tgCancelConnect(resp.error || 'Telegram rejected the connection.');
      }
      // resp.waiting === true → keep polling
    } catch (e) {
      console.log('Telegram detect poll failed:', e);
    }
  }, 2000);
}

function tgStopDetectLoop() {
  if (tgDetectTimer) {
    clearInterval(tgDetectTimer);
    tgDetectTimer = null;
  }
}

function tgCancelConnect(errorMsg) {
  tgStopDetectLoop();
  tgPending = null;
  tgShowSection('disconnected');
  if (errorMsg) {
    const errEl = $('tgConnectError');
    errEl.textContent = errorMsg;
    errEl.style.display = 'block';
  }
}

async function tgSendTest() {
  const btn = $('tgTestBtn');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'testTelegram' });
    setStatus(resp?.success ? 'Test sent — check Telegram.' : `Test failed: ${resp?.error || 'unknown error'}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Test Message';
  }
}

async function tgSaveChannel() {
  const btn = $('tgChannelSaveBtn');
  const errEl = $('tgChannelError');
  const channel = $('tgChannelInput').value.trim();
  errEl.style.display = 'none';
  if (!channel) return;

  btn.disabled = true;
  btn.textContent = '…';
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'telegramSetChannel', channel });
    if (resp?.ok) {
      setStatus(`Deals will now post to ${resp.dealsChannel} — a confirmation was posted there.`);
      await tgRefreshStatus();
    } else {
      errEl.textContent = resp?.error || 'Could not set the channel.';
      errEl.style.display = 'block';
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

async function tgRemoveChannel() {
  await chrome.runtime.sendMessage({ action: 'telegramClearChannel' });
  setStatus('Deals will post to your private chat.');
  await tgRefreshStatus();
}

async function tgDisconnect() {
  if (!confirm('Disconnect Telegram? You\'ll stop getting deal alerts until you reconnect.')) return;
  await chrome.runtime.sendMessage({ action: 'telegramDisconnect' });
  tgShowSection('disconnected');
  setStatus('Telegram disconnected.');
}

// ==================== DATABASE FUNCTIONS ====================

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');

  document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
  $(`${tabName}Tab`).style.display = 'block';

  if (tabName === 'all') loadAllItems();
  if (tabName === 'compare') loadCompareStores();
  if (tabName === 'history') loadScanHistory();
}

async function loadDbStats() {
  try {
    const response = await sendToContentScript({ action: 'db_getStats' });
    if (response?.success) {
      const items = response.stats.totalItems || 0;
      const stores = response.stats.storesTracked || 0;
      const scans = response.stats.totalScans || 0;
      $('dbTotalItems').textContent = items;
      $('dbStores').textContent = stores;
      $('dbScans').textContent = scans;
      // Hide stats section when all values are zero
      $('dbStatsSection').style.display = (items === 0 && stores === 0 && scans === 0) ? 'none' : '';
    }
  } catch (e) {
    console.log('Could not load db stats:', e);
  }
}

async function loadAllItems() {
  const container = $('allResults');
  const filterStore = $('filterStore').value;
  const filterSort = $('filterSort').value;

  container.innerHTML = '<div style="text-align: center; padding: 24px; color: var(--ink-3); font-size: 12px;">Loading…</div>';

  try {
    const action = filterStore ? 'db_getItemsByStore' : 'db_getAllItems';
    const response = await sendToContentScript({
      action,
      storeId: filterStore
    });

    if (!response?.success || !response.items?.length) {
      container.innerHTML = emptyStateHtml(ICON_BOX, 'No saved deals yet', 'Every scan adds its finds here automatically');
      $('allItemCountBadge').innerHTML = '<span id="allItemCount">0</span> items';
      return;
    }

    // Yellow-tag (advertised) deals only — intentional filter, do not remove.
    let items = response.items.filter(i => i.isAdvertised);

    if (filterSort === 'percentOff') {
      items.sort((a, b) => b.percentOff - a.percentOff);
    } else if (filterSort === 'price') {
      items.sort((a, b) => a.clearancePrice - b.clearancePrice);
    } else if (filterSort === 'newest') {
      items.sort((a, b) => b.firstSeen - a.firstSeen);
    }

    $('allItemCountBadge').innerHTML = `<span id="allItemCount">${items.length}</span> item${items.length === 1 ? '' : 's'}`;

    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;

    container.innerHTML = items.slice(0, 100).map(item => {
      const isNew = item.firstSeen > dayAgo;
      const storeName = escapeHtml(STORE_NAMES[item.storeId] || item.storeId);
      const priceDropBadge = item.priceDropped
        ? `<span class="price-drop">&darr; was $${item.previousPrice?.toFixed(2)}</span>`
        : '';
      const newBadge = isNew ? '<span class="new-badge">NEW</span>' : '';
      const name = escapeHtml(item.name || '');

      return `
        <div class="item">
          <div class="item-name">${escapeHtml(item.brand || '')} ${name.substring(0, 50)}${newBadge}</div>
          <div class="item-meta">${storeName}</div>
          <div class="item-price">$${item.clearancePrice?.toFixed(2)} ${priceDropBadge}
            <span>$${item.onlinePrice?.toFixed(2)}</span>
          </div>
          <div class="item-savings">${item.percentOff}% off</div>
          <a class="item-link" href="${escapeHtml(item.url || '#')}" target="_blank">View on homedepot.com &#8594;</a>
        </div>
      `;
    }).join('');

    if (items.length > 100) {
      container.innerHTML += `<div style="padding: 14px; text-align: center; color: var(--ink-3); font-size: 12px;">…and ${items.length - 100} more</div>`;
    }

  } catch (e) {
    container.innerHTML = `<div style="color: var(--red); padding: 14px; font-size: 12px;">Couldn't load saved deals. Refresh the Home Depot tab and try again.</div>`;
  }
}

async function loadCompareStores() {
  const container = $('compareResults');
  container.innerHTML = '<div style="text-align: center; padding: 24px; color: var(--ink-3); font-size: 12px;">Loading…</div>';

  try {
    const response = await sendToContentScript({ action: 'db_compareStores' });

    if (!response?.success || !response.comparison?.length) {
      container.innerHTML = emptyStateHtml(ICON_TAG, 'Nothing to compare yet', 'Scan at least two stores to see price differences');
      return;
    }

    container.innerHTML = response.comparison.slice(0, 50).map(item => {
      const storesList = item.stores.map((s, i) => {
        const name = escapeHtml(STORE_NAMES[s.storeId] || s.storeId);
        return `<span class="store-price ${i === 0 ? 'best' : ''}">${name}: $${s.price.toFixed(2)}</span>`;
      }).join('');

      return `
        <div class="compare-item">
          <div class="item-name">${escapeHtml(item.brand || '')} ${escapeHtml((item.name || '').substring(0, 50))}</div>
          <div class="compare-diff">$${item.priceDiff.toFixed(2)} cheaper at the best store</div>
          <div class="compare-stores">${storesList}</div>
        </div>
      `;
    }).join('');

  } catch (e) {
    container.innerHTML = `<div style="color: var(--red); padding: 14px; font-size: 12px;">Couldn't load comparisons. Refresh the Home Depot tab and try again.</div>`;
  }
}

async function loadScanHistory() {
  const container = $('historyResults');
  container.innerHTML = '<div style="text-align: center; padding: 24px; color: var(--ink-3); font-size: 12px;">Loading…</div>';

  try {
    const response = await sendToContentScript({ action: 'db_getScanHistory', limit: 30 });

    if (!response?.success || !response.history?.length) {
      container.innerHTML = emptyStateHtml(ICON_CLOCK, 'No scans yet', 'Your past scans will show up here');
      return;
    }

    container.innerHTML = response.history.map(scan => {
      const date = new Date(scan.timestamp);
      const dateStr = date.toLocaleDateString();
      const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const storeName = escapeHtml(STORE_NAMES[scan.storeId] || scan.storeId);

      return `
        <div class="item">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div class="history-store">${storeName}</div>
            <div class="history-date">${dateStr} ${timeStr}</div>
          </div>
          <div class="history-meta">
            <span class="history-found">${scan.clearanceFound}</span> deal${scan.clearanceFound === 1 ? '' : 's'} found &middot;
            ${scan.skusChecked?.toLocaleString() || 0} products checked
          </div>
        </div>
      `;
    }).join('');

  } catch (e) {
    container.innerHTML = `<div style="color: var(--red); padding: 14px; font-size: 12px;">Couldn't load history. Refresh the Home Depot tab and try again.</div>`;
  }
}

async function exportDatabase() {
  try {
    const response = await sendToContentScript({ action: 'db_exportAll' });

    if (!response?.success) {
      showError('Export failed: ' + (response?.error || 'unknown error'));
      return;
    }

    const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `hd_clearance_database_${new Date().toISOString().split('T')[0]}.json`;
    a.click();

    URL.revokeObjectURL(url);
    setStatus('Export downloaded.');
  } catch (e) {
    showError('Export failed: ' + e.message);
  }
}

async function clearDatabase() {
  if (!confirm('Delete ALL saved deals, history, and comparisons? This cannot be undone.')) {
    return;
  }

  try {
    const response = await sendToContentScript({ action: 'db_clearAll' });

    if (response?.success) {
      setStatus('All saved data cleared.');
      await loadDbStats();
      loadAllItems();
      loadScanHistory();
    } else {
      showError('Could not clear data: ' + (response?.error || 'unknown error'));
    }
  } catch (e) {
    showError('Could not clear data: ' + e.message);
  }
}
