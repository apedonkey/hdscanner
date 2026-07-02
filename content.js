// Content script - runs inside homedepot.com page context (no CORS issues)
console.log('[HD Scanner] Content script starting...');

try {

const API_URL = "https://apionline.homedepot.com/federation-gateway/graphql";

// ==================== SKU INVENTORY CACHE ====================
// Cache discovered SKUs per store - each store maintains its own SKU list
const SKU_INVENTORY = {
  stores: {},  // { storeId: { skus: Set, lastUpdated: timestamp } }
  _loading: null,

  load() {
    // Cache the in-flight load so concurrent callers await the same promise and
    // a completed load can never re-run and clobber newer in-memory writes.
    return this._loading || (this._loading = this._doLoad());
  },

  async _doLoad() {
    try {
      const stored = await chrome.storage.local.get(['skuInventoryMultiStore']);
      if (stored.skuInventoryMultiStore) {
        // Load each store's SKUs
        for (const [storeId, data] of Object.entries(stored.skuInventoryMultiStore)) {
          this.stores[storeId] = {
            skus: new Set(data.skus || []),
            lastUpdated: data.lastUpdated
          };
        }
        const totalSkus = Object.values(this.stores).reduce((sum, s) => sum + s.skus.size, 0);
        const storeCount = Object.keys(this.stores).length;
        console.log(`[HD Scanner] Loaded ${totalSkus} cached SKUs across ${storeCount} stores`);
      } else {
        // Migrate from old single-store format if exists
        const oldStored = await chrome.storage.local.get(['skuInventory']);
        if (oldStored.skuInventory && oldStored.skuInventory.storeId) {
          const { skus, storeId, lastUpdated } = oldStored.skuInventory;
          this.stores[storeId] = {
            skus: new Set(skus || []),
            lastUpdated
          };
          console.log(`[HD Scanner] Migrated ${skus?.length || 0} SKUs from old format for store ${storeId}`);
          await this.save(); // Save in new format
          chrome.storage.local.remove(['skuInventory']); // Remove old format
        }
      }
    } catch (e) {
      console.warn('[HD Scanner] Failed to load SKU inventory:', e);
    }
  },

  async save() {
    try {
      // Re-read what's on disk and merge before writing so a concurrent tab's
      // SKUs are never clobbered (union of SKU arrays per store, newest wins).
      let existing = {};
      try {
        const stored = await chrome.storage.local.get(['skuInventoryMultiStore']);
        existing = stored.skuInventoryMultiStore || {};
      } catch (_) { /* fall back to writing our own view */ }

      const toStore = {};
      // Seed from disk (other tabs' data).
      for (const [storeId, data] of Object.entries(existing)) {
        toStore[storeId] = {
          skus: Array.isArray(data.skus) ? [...data.skus] : [],
          lastUpdated: data.lastUpdated || null
        };
      }
      // Merge our in-memory view on top.
      for (const [storeId, data] of Object.entries(this.stores)) {
        const mine = Array.from(data.skus);
        if (!toStore[storeId]) {
          toStore[storeId] = { skus: mine, lastUpdated: data.lastUpdated };
        } else {
          const union = new Set(toStore[storeId].skus);
          mine.forEach(s => union.add(s));
          toStore[storeId] = {
            skus: Array.from(union),
            lastUpdated: Math.max(toStore[storeId].lastUpdated || 0, data.lastUpdated || 0) || data.lastUpdated
          };
        }
      }

      await chrome.storage.local.set({ skuInventoryMultiStore: toStore });
      const totalSkus = Object.values(this.stores).reduce((sum, s) => sum + s.skus.size, 0);
      console.log(`[HD Scanner] Saved ${totalSkus} SKUs across ${Object.keys(this.stores).length} stores`);
    } catch (e) {
      console.warn('[HD Scanner] Failed to save SKU inventory:', e);
    }
  },

  // Add new SKUs for a specific store (merges with existing)
  addSkus(newSkus, storeId) {
    // Initialize store if not exists
    if (!this.stores[storeId]) {
      this.stores[storeId] = { skus: new Set(), lastUpdated: null };
    }

    const store = this.stores[storeId];
    const beforeCount = store.skus.size;
    newSkus.forEach(sku => store.skus.add(sku));
    store.lastUpdated = Date.now();
    const added = store.skus.size - beforeCount;

    if (added > 0) {
      console.log(`[HD Scanner] Store ${storeId}: Added ${added} new SKUs (total: ${store.skus.size})`);
    }
    return added;
  },

  getAll(storeId) {
    const store = this.stores[storeId];
    return store ? Array.from(store.skus) : [];
  },

  getStats(storeId) {
    const store = this.stores[storeId];
    const allStoresTotal = Object.values(this.stores).reduce((sum, s) => sum + s.skus.size, 0);
    return {
      total: store ? store.skus.size : 0,
      storeId: storeId,
      lastUpdated: store?.lastUpdated,
      ageHours: store?.lastUpdated ? Math.round((Date.now() - store.lastUpdated) / 3600000) : null,
      allStoresTotal: allStoresTotal,
      storeCount: Object.keys(this.stores).length
    };
  },

  // Get stats for all stores
  getAllStoreStats() {
    const stats = {};
    for (const [storeId, data] of Object.entries(this.stores)) {
      stats[storeId] = {
        skuCount: data.skus.size,
        lastUpdated: data.lastUpdated,
        ageHours: data.lastUpdated ? Math.round((Date.now() - data.lastUpdated) / 3600000) : null
      };
    }
    return stats;
  },

  // Clear a specific store
  clearStore(storeId) {
    if (this.stores[storeId]) {
      delete this.stores[storeId];
      this.save();
      console.log(`[HD Scanner] Cleared SKU cache for store ${storeId}`);
    }
  },

  // Clear all stores
  clearAll() {
    this.stores = {};
    chrome.storage.local.remove(['skuInventoryMultiStore', 'skuInventory']);
    console.log('[HD Scanner] All SKU inventory cleared');
  }
};

// Cache for clearance items only (for quick display)
const CLEARANCE_CACHE = {
  items: new Map(),  // sku -> clearance data
  storeId: null,
  _loading: null,

  load() {
    // Cache the in-flight load so concurrent callers share one promise.
    return this._loading || (this._loading = this._doLoad());
  },

  async _doLoad() {
    try {
      const stored = await chrome.storage.local.get(['clearanceCache']);
      if (stored.clearanceCache) {
        const loadedStoreId = stored.clearanceCache.storeId;
        const loadedItems = Object.entries(stored.clearanceCache.items || {});
        // Merge stored items *beneath* any writes that landed while this async
        // load was in flight — a completed load must not clobber newer data.
        if (this.storeId == null) this.storeId = loadedStoreId;
        if (this.storeId === loadedStoreId) {
          for (const [sku, data] of loadedItems) {
            if (!this.items.has(sku)) this.items.set(sku, data);
          }
        }
        console.log(`[HD Scanner] Loaded ${this.items.size} cached clearance items`);
      }
    } catch (e) {
      console.warn('[HD Scanner] Failed to load clearance cache:', e);
    }
  },

  async save() {
    try {
      await chrome.storage.local.set({
        clearanceCache: {
          items: Object.fromEntries(this.items),
          storeId: this.storeId
        }
      });
    } catch (e) {
      console.warn('[HD Scanner] Failed to save clearance cache:', e);
    }
  },

  set(sku, storeId, clearanceData) {
    if (this.storeId !== storeId) {
      this.items.clear();
      this.storeId = storeId;
    }
    this.items.set(sku, clearanceData);
  },

  getAll(storeId) {
    if (this.storeId !== storeId) return [];
    return Array.from(this.items.values());
  },

  clear() {
    this.items.clear();
    this.storeId = null;
    chrome.storage.local.remove(['clearanceCache']);
  }
};

// Initialize caches on load
SKU_INVENTORY.load();
CLEARANCE_CACHE.load();

// ==================== SITEMAP FUNCTIONS ====================

const PRODUCT_QUERY = `
query productClientOnlyProduct($itemId: String!, $storeId: String!) {
  product(itemId: $itemId) {
    itemId
    availabilityType { buyable discontinued status type }
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
      backordered
      anchorStoreStatusType
      onlineStoreStatusType
      anchorStoreStatus
      onlineStoreStatus
      fallbackMode
      fulfillmentOptions {
        type
        fulfillable
        services {
          type
          locations {
            inventory { quantity isInStock isOutOfStock isUnavailable isLimitedQuantity maxAllowedBopisQty }
            storeName
            locationId
          }
        }
      }
    }
  }
}`;

const CATEGORY_QUERY = `
query searchModel(
  $storeId: String, $navParam: String, $storefilter: StoreFilter,
  $channel: Channel, $additionalSearchParams: AdditionalParams,
  $isBrandPricingPolicyCompliant: Boolean,
  $orderBy: ProductSort, $ps: Int, $si: Int
) {
  searchModel(
    navParam: $navParam, storeId: $storeId, storefilter: $storefilter,
    channel: $channel, additionalSearchParams: $additionalSearchParams,
    isBrandPricingPolicyCompliant: $isBrandPricingPolicyCompliant
  ) {
    metadata { productCount { inStore } }
    products(pageSize: $ps, startIndex: $si, orderBy: $orderBy) {
      itemId
    }
  }
}`;

// Track rate limiting
let rateLimitHits = 0;

// Shared Akamai/429 cooldown. When any GraphQL request gets flagged, every other
// caller waits out this window instead of hammering the endpoint in parallel.
let sharedCooldownUntil = 0;

// Global scan stop flag
let scanStopped = false;

// Count of categories that recorded 0 products because their API call errored
// (rate-limited / HTTP / timeout) rather than genuinely being empty.
let rateLimitedCategoryCount = 0;

// Low-level GraphQL POST shared by every caller. Adds a hard request timeout,
// unified 403/429 detection with exponential backoff, and a shared cooldown so
// parallel callers stop hammering the endpoint while Akamai has us flagged.
// Returns parsed JSON on success, or an { error, errors } shape on failure.
async function graphqlFetch(operation, variables, query, { timeoutMs = 20000, retryCount = 0, maxRetries = 3 } = {}) {
  // Respect a cooldown set by a sibling request that was just rate-limited.
  const waitFirst = sharedCooldownUntil - Date.now();
  if (waitFirst > 0) {
    await new Promise(r => setTimeout(r, waitFirst));
  }

  const url = `${API_URL}?opname=${operation}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'x-experience-name': 'general-merchandise'
      },
      body: JSON.stringify({ operationName: operation, variables, query }),
      signal: controller.signal
    });
  } catch (e) {
    const msg = e.name === 'AbortError' ? `timed out after ${timeoutMs / 1000}s` : e.message;
    console.error(`[HD Scanner] Fetch failed for ${operation}:`, msg);
    return { error: 'fetch_failed', errors: [{ message: msg }] };
  } finally {
    clearTimeout(timer);
  }

  // Akamai (403) and rate limiting (429): set the shared cooldown and back off.
  if (response.status === 403 || response.status === 429) {
    rateLimitHits++;
    if (retryCount < maxRetries) {
      // Exponential backoff: 10s, 30s, 90s + random jitter
      const waitTime = (10000 * Math.pow(3, retryCount)) + Math.floor(Math.random() * 5000);
      sharedCooldownUntil = Date.now() + waitTime;
      console.warn(`[HD Scanner] Rate limited (${response.status}) - hit #${rateLimitHits}, waiting ${Math.round(waitTime / 1000)}s before retry ${retryCount + 1}/${maxRetries}...`);
      await new Promise(r => setTimeout(r, waitTime));
      return graphqlFetch(operation, variables, query, { timeoutMs, retryCount: retryCount + 1, maxRetries });
    }
    return { error: 'rate_limited', errors: [{ message: 'Rate limited' }] };
  }

  if (!response.ok) {
    console.error(`[HD Scanner] HTTP error: ${response.status}`);
    return { error: 'http_error', status: response.status, errors: [{ message: `HTTP ${response.status}` }] };
  }

  // Check if response is JSON
  const contentType = response.headers.get('content-type');
  if (!contentType || !contentType.includes('application/json')) {
    console.warn(`[HD Scanner] Non-JSON response: ${contentType}`);
    return { error: 'invalid_response', errors: [{ message: 'Non-JSON response' }] };
  }

  try {
    return await response.json();
  } catch (e) {
    console.warn('[HD Scanner] JSON parse failed:', e.message);
    return { error: 'invalid_response', errors: [{ message: 'JSON parse failed' }] };
  }
}

async function apiCall(operation, variables, query) {
  // Only log non-product calls to reduce noise
  if (operation !== 'productClientOnlyProduct') {
    console.log(`[HD Scanner] API Call: ${operation}`, { url: `${API_URL}?opname=${operation}`, variables });
  }

  const data = await graphqlFetch(operation, variables, query);

  // Log genuine GraphQL errors from a successful HTTP response. Transport-error
  // shapes carry their own `error` string and were already logged in graphqlFetch.
  if (!data.error && data.errors) {
    const errorMsg = data.errors[0]?.message || 'Unknown';
    // Don't log expected "not available" type errors - they're just product status
    const ignoredErrors = ['online status is false', 'not found', 'does not exist', 'hide item is true'];
    const isIgnored = ignoredErrors.some(e => errorMsg.toLowerCase().includes(e));

    if (!isIgnored) {
      console.warn(`[HD Scanner] GraphQL error for ${variables.itemId || operation}: ${errorMsg}`);
    }
  }

  return data;
}

// ==================== BATCH GRAPHQL CHECK ====================
// Checks multiple SKUs in a SINGLE HTTP request using GraphQL aliases.
// Instead of 1 request per SKU, we send 1 request for N SKUs → massive speedup.

const PRODUCT_FIELDS = `
  itemId
  availabilityType { buyable discontinued status type }
  identifiers { productLabel brandName canonicalUrl modelNumber storeSkuNumber }
  details { descriptiveAttributes { name value } }
  pricing(storeId: $storeId) { value original clearance { value dollarOff percentageOff } }
  fulfillment(storeId: $storeId) { backordered anchorStoreStatusType onlineStoreStatusType anchorStoreStatus onlineStoreStatus fallbackMode fulfillmentOptions { type fulfillable services { type locations { inventory { quantity isInStock isOutOfStock isUnavailable isLimitedQuantity maxAllowedBopisQty } storeName locationId } } } }
`;

function buildBatchQuery(skus) {
  // Only interpolate purely-numeric itemIds — one malformed SKU would break the
  // whole batch query and poison every alias in the request. Skip invalid ones
  // but keep the alias index tied to the original position (`p${i}`) so the
  // caller's index-based result mapping stays aligned; a skipped SKU simply has
  // no alias and reads back as undefined (→ no data) for that slot.
  const aliases = skus
    .map((sku, i) => ({ sku: String(sku), i }))
    .filter(({ sku }) => /^\d+$/.test(sku))
    .map(({ sku, i }) => `  p${i}: product(itemId: "${sku}") { ${PRODUCT_FIELDS} }`)
    .join('\n');
  return `query batchProducts($storeId: String!) {\n${aliases}\n}`;
}

// Check a single SKU via the product() GraphQL endpoint
async function checkSku(itemId, storeId) {
  const data = await graphqlFetch('productClientOnlyProduct', { itemId, storeId }, PRODUCT_QUERY);
  // If a product payload came back, parse and return it regardless of any benign
  // GraphQL errors returned alongside it (e.g. "online status is false"). Treat
  // the SKU as an error only on transport failures or GraphQL errors with no
  // payload — a clean response with a null product just means the SKU is gone.
  const product = data?.data?.product;
  if (product) return parseProductResult(product, itemId, storeId);
  if (data?.error || data?.errors) return { error: true };
  return { error: false, clearance: null };
}

function parseProductResult(product, itemId, storeId) {
  // Same logic as checkSku but takes a pre-fetched product object
  if (!product) return { error: false, clearance: null };

  const pricing = product.pricing || {};
  const clearance = pricing.clearance;

  // Capture product + fulfillment-level availability signals
  // anchorStoreStatusType === 'CLEARANCE' is HD's authoritative clearance flag
  // fulfillmentOptions[pickup].fulfillable === false with qty > 0 = hidden penny signature
  const availabilityType = product.availabilityType ? {
    discontinued: product.availabilityType.discontinued ?? null,
    type: product.availabilityType.type ?? null,
    status: product.availabilityType.status ?? null,
    buyable: product.availabilityType.buyable ?? null
  } : null;
  const f = product.fulfillment || {};
  const fulfillmentStatus = {
    backordered: f.backordered ?? null,
    anchorStoreStatusType: f.anchorStoreStatusType ?? null,
    onlineStoreStatusType: f.onlineStoreStatusType ?? null,
    anchorStoreStatus: f.anchorStoreStatus ?? null,
    onlineStoreStatus: f.onlineStoreStatus ?? null,
    fallbackMode: f.fallbackMode ?? null
  };

  // Build raw fulfillment snapshot for logging
  const rawFulfillment = (product.fulfillment?.fulfillmentOptions || []).map(opt => ({
    type: opt.type,
    fulfillable: opt.fulfillable,
    services: (opt.services || []).map(svc => ({
      type: svc.type,
      locations: (svc.locations || []).filter(loc => loc.locationId === storeId).map(loc => ({
        locationId: loc.locationId,
        inventory: loc.inventory
      }))
    })).filter(svc => svc.locations.length > 0)
  }));

  // === FULFILLMENT EXTRACTION (runs for ALL items, with or without clearance) ===
  let quantity = 0, storeName = '', isInStock = false, hasBopis = false, pickupFulfillable = true;
  let hasDelivery = false, deliveryFulfillable = false;
  let inventoryIsUnavailable = false;

  rawFulfillment.forEach(opt => {
    if (opt.type === 'pickup') {
      pickupFulfillable = opt.fulfillable;
      opt.services.forEach(svc => {
        if (svc.type === 'bopis') hasBopis = true;
        svc.locations.forEach(loc => {
          const svcQty = loc.inventory?.quantity || 0;
          const svcInStock = loc.inventory?.isInStock || false;
          if (svcQty > quantity) quantity = svcQty;
          if (svcInStock) isInStock = true;
          if (loc.inventory?.isUnavailable === true) inventoryIsUnavailable = true;
        });
      });
    } else if (opt.type === 'delivery') {
      hasDelivery = true;
      deliveryFulfillable = !!opt.fulfillable;
      opt.services.forEach(svc => {
        svc.locations.forEach(loc => {
          if (quantity === 0) {
            quantity = loc.inventory?.quantity || 0;
            isInStock = loc.inventory?.isInStock || false;
          }
        });
      });
    } else {
      opt.services.forEach(svc => {
        svc.locations.forEach(loc => {
          if (quantity === 0) {
            quantity = loc.inventory?.quantity || 0;
            isInStock = loc.inventory?.isInStock || false;
          }
        });
      });
    }
  });
  // Get storeName from raw product data
  (product.fulfillment?.fulfillmentOptions || []).forEach(opt => {
    (opt.services || []).forEach(svc => {
      (svc.locations || []).forEach(loc => {
        if (loc.locationId === storeId && loc.storeName) storeName = loc.storeName;
      });
    });
  });

  if (!clearance || clearance.value == null) {
    // No clearance tag — check for penny signal
    // Penny fingerprint (confirmed from 202256128 at store 4113):
    //   1. anchorStoreStatusType === "CLEARANCE"
    //   2. No pickup option (fulfillmentOptions null or no pickup entry)
    //   3. pricing.clearance === null (HD hides the penny price)
    //   4. "Sign of life" — has delivery option OR has an online price
    //      (dead clearance has NOTHING — no fulfillment, no pricing)
    const anchorStatus = fulfillmentStatus.anchorStoreStatusType;
    const hasPickupOption = rawFulfillment.some(opt => opt.type === 'pickup');
    const deliveryOpt = rawFulfillment.find(opt => opt.type === 'delivery');
    // Renamed to avoid shadowing the outer `deliveryFulfillable` accumulation:
    // the returned object below reports the outer value (false, not undefined).
    const deliveryOptFulfillable = deliveryOpt && deliveryOpt.fulfillable === true;
    const isTruePenny = anchorStatus === 'CLEARANCE'
                     && !hasPickupOption
                     && (!clearance || clearance.value == null)
                     && deliveryOptFulfillable;

    if (isTruePenny) {
      console.log(`[HD Scanner] 🪙 PENNY DETECTED: ${itemId} — anchor=CLEARANCE, no pickup, no clearance price`);
    }

    const identifiers = product.identifiers || {};
    return {
      error: false,
      clearance: null,
      rawFulfillment,
      availabilityType,
      fulfillmentStatus,
      fulfillment: {
        quantity, isInStock, hasBopis, pickupFulfillable,
        hasDelivery, deliveryFulfillable, inventoryIsUnavailable
      },
      pennySignal: isTruePenny,
      pricing: { value: pricing.value || 0 },
      identifiers: {
        name: identifiers.productLabel || null,
        brand: identifiers.brandName || null,
        storeSkuNumber: identifiers.storeSkuNumber || '',
        modelNumber: identifiers.modelNumber || '',
        url: identifiers.canonicalUrl ? `https://www.homedepot.com${identifiers.canonicalUrl}` : null
      }
    };
  }

  const isAdvertised = hasBopis && !pickupFulfillable;

  const anchorStatus = fulfillmentStatus.anchorStoreStatusType;
  const clearanceBelowOnline = clearance.value != null && pricing.value != null && clearance.value < pricing.value;
  const yellowTag = anchorStatus === 'CLEARANCE'
                 && clearance.value != null
                 && clearanceBelowOnline
                 && pickupFulfillable === false;
  // True penny = yellow tag where BOTH fulfillment sides are blocked on the PDP:
  //   "At Your Store: Unavailable"  → no BOPIS or inventory flagged unavailable
  //   "Delivery: Unavailable"       → no delivery option or it's not fulfillable
  const atStoreUnavailable = !hasBopis || inventoryIsUnavailable;
  const deliveryUnavailable = !hasDelivery || !deliveryFulfillable;
  const truePenny = yellowTag && quantity > 0 && atStoreUnavailable && deliveryUnavailable;

  const possiblePenny = yellowTag || (quantity > 0 && !isInStock) || (clearance.value != null && clearance.value < 1);

  const identifiers = product.identifiers || {};
  const details = product.details || {};

  const variantAttrs = {};
  const importantAttrs = ['Color Family', 'Color/Finish', 'Finish Family', 'Color', 'Finish', 'Size', 'Material'];
  (details.descriptiveAttributes || []).forEach(attr => {
    if (importantAttrs.some(a => attr.name?.includes(a))) {
      variantAttrs[attr.name] = attr.value;
    }
  });

  const variantParts = [];
  if (variantAttrs['Color/Finish']) variantParts.push(variantAttrs['Color/Finish']);
  else if (variantAttrs['Color Family']) variantParts.push(variantAttrs['Color Family']);
  else if (variantAttrs['Finish Family']) variantParts.push(variantAttrs['Finish Family']);
  if (variantAttrs['Size']) variantParts.push(variantAttrs['Size']);

  const clearanceData = {
    itemId, storeSkuNumber: identifiers.storeSkuNumber || '',
    modelNumber: identifiers.modelNumber || '',
    name: identifiers.productLabel || 'Unknown',
    brand: identifiers.brandName || 'Unknown',
    variant: variantParts.join(' / ') || null,
    variantDetails: Object.keys(variantAttrs).length > 0 ? variantAttrs : null,
    onlinePrice: pricing.value || 0,
    clearancePrice: clearance.value,
    dollarOff: clearance.dollarOff || 0,
    percentOff: clearance.percentageOff || 0,
    quantity, storeName, isInStock, possiblePenny, isAdvertised,
    hasBopis, pickupFulfillable, hasDelivery, deliveryFulfillable,
    inventoryIsUnavailable, yellowTag, truePenny,
    url: `https://www.homedepot.com${identifiers.canonicalUrl || '/p/' + itemId}?storeId=${storeId}`
  };

  if (clearance.value) {
    console.log(`[HD Scanner] SKU ${itemId} CLEARANCE: $${clearance.value} (${clearance.percentageOff}% off)`);
  }
  if (yellowTag) {
    console.log(`[HD Scanner] 🟡 YELLOW TAG: ${itemId} - $${clearance.value} (online $${pricing.value})`);
  }
  if (truePenny) {
    console.log(`[HD Scanner] 🪙 TRUE PENNY: ${itemId} - $${clearance.value}, qty=${quantity}, no delivery`);
  }

  CLEARANCE_CACHE.set(itemId, storeId, clearanceData);
  return { error: false, clearance: clearanceData, rawFulfillment, availabilityType, fulfillmentStatus };
}

// Fallback path when the batch query fails. Runs single checks SEQUENTIALLY with
// a small delay instead of firing ~16 concurrent requests — which is exactly the
// wrong move when the batch just failed because we're being rate-limited. Bails
// early (returning partial results) if a stop was requested mid-way.
async function checkSkusSequential(skus, storeId) {
  const results = [];
  for (const sku of skus) {
    if (scanStopped) break;
    results.push(await checkSku(sku, storeId));
    await new Promise(r => setTimeout(r, 150));
  }
  return results;
}

async function checkSkuBatchFast(skus, storeId) {
  try {
    const query = buildBatchQuery(skus);
    const data = await apiCall('batchProducts', { storeId }, query);

    if (data.error || !data.data) {
      // Batch query failed — fall back to individual queries
      console.log('[HD Scanner] Batch query failed, falling back to individual checks');
      return await checkSkusSequential(skus, storeId);
    }

    // Parse each aliased result
    return skus.map((sku, i) => {
      try {
        const product = data.data[`p${i}`];
        return parseProductResult(product, sku, storeId);
      } catch (e) {
        return { error: true };
      }
    });
  } catch (e) {
    console.error('[HD Scanner] Batch check error:', e);
    // Fall back to individual
    return await checkSkusSequential(skus, storeId);
  }
}


// ==================== SITEMAP CATEGORY DISCOVERY ====================
// Fetches HD's XML sitemaps to discover ALL category navParams (~5000+)
// This catches categories missing from the hardcoded STORE_SUBCATEGORIES list

// HD's sitemap endpoints occasionally hold the socket open without responding.
// Without a timeout, the scan hangs forever at "discovering sitemap".
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSitemapCategories() {
  const categories = new Map(); // navParam -> { label, depth }
  const visited = new Set();

  // Helper: fetch with retry
  async function fetchRetry(url, timeoutMs = 30000, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const resp = await fetchWithTimeout(url, { credentials: 'include' }, timeoutMs);
        if (resp.ok) return resp;
        if (resp.status === 404) return null; // don't retry 404s
        console.log(`[HD Scanner] Sitemap ${url.split('/').pop()}: HTTP ${resp.status} (attempt ${attempt + 1})`);
      } catch (e) {
        const reason = e.name === 'AbortError' ? `timed out after ${timeoutMs / 1000}s` : e.message;
        console.log(`[HD Scanner] Sitemap fetch failed (attempt ${attempt + 1}/${retries + 1}): ${reason}`);
      }
      if (attempt < retries) await new Promise(r => setTimeout(r, 2000));
    }
    return null;
  }

  // Parse category navParams from <url><loc> entries
  function parseCategories(text) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    const locs = doc.querySelectorAll('url loc');
    let found = 0;
    for (const loc of locs) {
      const href = loc.textContent.replace(/\/$/, '');
      const match = href.match(/\/b\/([^\/]+)\/N-([a-zA-Z0-9]+)/);
      if (match) {
        const navParam = match[2];
        if (/Z1z[a-z]/.test(navParam)) continue;
        const label = match[1].replace(/-/g, ' ');
        const depth = (match[1].match(/-/g) || []).length;
        if (!categories.has(navParam)) {
          categories.set(navParam, { label, depth });
          found++;
        }
      }
    }
    return found;
  }

  // Parse XML — returns child index URLs and whether it has page URLs
  function parseXml(text) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    return {
      children: [...doc.querySelectorAll('sitemap loc')].map(l => l.textContent),
      hasPages: doc.querySelectorAll('url loc').length > 0
    };
  }

  // Fetch a batch of URLs, parse them, return newly discovered child indexes
  async function crawlBatch(urls) {
    const newChildren = [];
    const BATCH = 5;

    for (let i = 0; i < urls.length; i += BATCH) {
      if (scanStopped) break;
      const batch = urls.slice(i, i + BATCH);

      await Promise.all(batch.map(async (url) => {
        if (visited.has(url)) return;
        visited.add(url);
        if (/pdp/i.test(url)) return; // skip product-detail sitemaps

        const resp = await fetchRetry(url, 30000, 1);
        if (!resp) return;

        try {
          const text = await resp.text();
          const { children, hasPages } = parseXml(text);

          if (children.length > 0) {
            const useful = children.filter(u => !/pdp/i.test(u) && !visited.has(u));
            newChildren.push(...useful);
            console.log(`[HD Scanner] Index ${url.split('/').pop()}: ${children.length} children (${useful.length} new)`);
          }
          if (hasPages) {
            const found = parseCategories(text);
            if (found > 0) {
              console.log(`[HD Scanner] ${url.split('/').pop()}: +${found} categories (total: ${categories.size})`);
            }
          }
        } catch (e) {
          console.log(`[HD Scanner] Parse error for ${url.split('/').pop()}:`, e.message);
        }
      }));

      if (i + BATCH < urls.length) await new Promise(r => setTimeout(r, 300));
    }
    return newChildren;
  }

  // ===== TREE CRAWL: master index → sub-indexes → individual sitemaps =====
  console.log('[HD Scanner] Starting sitemap tree crawl...');
  const entryPoints = [
    'https://www.homedepot.com/sitemap.xml',
    'https://www.homedepot.com/sitemap/B/PLPs.xml',
  ];

  const level1 = await crawlBatch(entryPoints);
  console.log(`[HD Scanner] Level 1: discovered ${level1.length} sub-indexes`);

  let level2 = [];
  if (level1.length > 0) {
    level2 = await crawlBatch(level1);
    console.log(`[HD Scanner] Level 2: discovered ${level2.length} sitemaps, ${categories.size} categories so far`);
  }
  if (level2.length > 0) {
    await crawlBatch(level2);
    console.log(`[HD Scanner] Level 3 done, ${categories.size} categories so far`);
  }

  // ===== BRUTE FORCE FALLBACK if tree crawl underperformed =====
  if (categories.size < 500) {
    console.log(`[HD Scanner] Only ${categories.size} categories from tree crawl — running brute force fallback`);
    const fallbackUrls = [];
    // Try a wide range of known HD sitemap patterns
    for (let i = 0; i < 50; i++) {
      fallbackUrls.push(`https://www.homedepot.com/sitemap/B/PLPs/PLP_CORE_TAX/PLP_CORE_TAX-${i}.xml`);
    }
    for (let i = 0; i < 20; i++) {
      fallbackUrls.push(`https://www.homedepot.com/sitemap/Cat/cat-${i}.xml`);
    }
    // Other PLP types that might exist
    for (const type of ['PLP_BRAND', 'PLP_SEARCH', 'PLP_BROWSE', 'PLP_CAT']) {
      for (let i = 0; i < 10; i++) {
        fallbackUrls.push(`https://www.homedepot.com/sitemap/B/PLPs/${type}/${type}-${i}.xml`);
      }
    }
    const newUrls = fallbackUrls.filter(u => !visited.has(u));
    console.log(`[HD Scanner] Brute force: trying ${newUrls.length} URLs`);
    await crawlBatch(newUrls);
  }

  console.log(`[HD Scanner] Sitemap discovery complete: ${categories.size} categories from ${visited.size} URLs crawled`);
  return categories;
}

// ==================== DYNAMIC SUBCATEGORY DISCOVERY ====================
// Uses searchModel dimensions to recursively discover subcategories per store.
// Sitemaps give us seed navParams; this expands each into the full subtree
// by querying the API for the "Category" dimension at each level.

const DISCOVERY_QUERY = `
query searchModel($storeId: String, $navParam: String, $storefilter: StoreFilter, $channel: Channel, $additionalSearchParams: AdditionalParams) {
  searchModel(navParam: $navParam, storeId: $storeId, storefilter: $storefilter, channel: $channel, additionalSearchParams: $additionalSearchParams) {
    metadata { productCount { inStore } }
    dimensions {
      label
      dimensionId
      refinements {
        label
        refinementKey
        recordCount
      }
    }
  }
}`;

// BFS walk of the category tree via searchModel dimensions.
// Seeds come from sitemaps; each seed is expanded by querying its
// "Category" dimension for subcategories with in-store products.
async function discoverCategoriesByStore(seedNavParams, storeId) {
  const allCategories = new Map(); // navParam -> { label, recordCount }
  const explored = new Set();
  const queue = [...seedNavParams];
  const PARALLEL = 3;
  let queries = 0;

  // Add seeds themselves to allCategories so they get scanned even if
  // the API doesn't return them as refinements of something else
  for (const np of seedNavParams) {
    if (!allCategories.has(np)) {
      allCategories.set(np, { label: np, recordCount: 0 });
    }
  }

  while (queue.length > 0 && !scanStopped) {
    const batch = queue.splice(0, PARALLEL);

    const results = await Promise.all(batch.map(async (navParam) => {
      if (explored.has(navParam)) return [];
      explored.add(navParam);
      queries++;

      const data = await apiCall('searchModel', {
        storeId,
        storefilter: 'IN_STORE',
        channel: 'DESKTOP',
        navParam,
        additionalSearchParams: { multiStoreIds: [] }
      }, DISCOVERY_QUERY);

      // A rate-limited / errored discovery call yields no dimensions and is
      // silently treated as an empty category — count it so it can be reported.
      if (data?.error) rateLimitedCategoryCount++;

      const dimensions = data?.data?.searchModel?.dimensions || [];
      const categoryDim = dimensions.find(d => d.label === 'Category' || d.dimensionId === '2');
      if (!categoryDim || !categoryDim.refinements) return [];

      const newNavParams = [];
      for (const ref of categoryDim.refinements) {
        const count = parseInt(ref.recordCount) || 0;
        if (count === 0) continue;

        const subNavParam = `5yc1vZ${ref.refinementKey}`;
        if (!allCategories.has(subNavParam)) {
          allCategories.set(subNavParam, { label: ref.label, recordCount: count });
          if (!explored.has(subNavParam)) {
            newNavParams.push(subNavParam);
          }
        }
      }
      return newNavParams;
    }));

    for (const newCats of results) {
      queue.push(...newCats);
    }

    // Delay between batches
    await new Promise(r => setTimeout(r, 200));

    // Progress update every 10 queries
    if (queries % 10 === 0) {
      console.log(`[HD Scanner] Category discovery: ${explored.size} explored, ${allCategories.size} found, ${queue.length} queued`);
      chrome.runtime.sendMessage({
        type: 'skuProgress', phase: 'mapping', current: explored.size, total: explored.size + queue.length,
        skuCount: 0, category: `Discovering subcategories... (${allCategories.size} found)`
      }).catch(() => {});
    }
  }

  console.log(`[HD Scanner] Category discovery complete: ${allCategories.size} categories from ${queries} API queries`);
  return allCategories;
}

// Sort orders to try for maximum coverage
const SORT_ORDERS = [
  { field: "TOP_SELLERS", order: "ASC" },
  { field: "PRICE", order: "ASC" },
  { field: "PRICE", order: "DESC" },
  { field: "TOP_RATED", order: "DESC" },
  { field: "BEST_MATCH", order: "ASC" }
];

// Get all SKUs from a category (with IN_STORE filter)
// Note: HD API limits pagination to 720 products max per category
async function getStoreSkusByNavParam(navParam, storeId, orderBy = { field: "TOP_SELLERS", order: "ASC" }) {
  const skus = new Set();
  const pageSize = 48;
  const maxPages = 15; // 15 * 48 = 720 (API limit)
  const PARALLEL_BATCH = 2; // Fetch 2 pages in parallel (conservative to avoid rate limits)

  // First, get page 0 to see how many products exist
  const firstPageVars = {
    storeId,
    storefilter: "IN_STORE",
    channel: "DESKTOP",
    navParam,
    isBrandPricingPolicyCompliant: false,
    additionalSearchParams: { multiStoreIds: [] },
    orderBy: orderBy,
    ps: pageSize,
    si: 0
  };

  const firstData = await apiCall("searchModel", firstPageVars, CATEGORY_QUERY);
  // A rate-limited / errored first page reads back as 0 products — count it so
  // the category isn't silently mistaken for genuinely empty.
  if (firstData?.error) rateLimitedCategoryCount++;
  const totalProducts = firstData?.data?.searchModel?.metadata?.productCount?.inStore || 0;
  const firstProducts = firstData?.data?.searchModel?.products || [];

  firstProducts.forEach(p => {
    if (p.itemId) skus.add(p.itemId);
  });

  // If first page has fewer than pageSize or no more products, we're done
  if (firstProducts.length < pageSize || totalProducts <= pageSize) {
    return Array.from(skus);
  }

  // Calculate how many more pages we need (capped at maxPages)
  const pagesNeeded = Math.min(Math.ceil(totalProducts / pageSize), maxPages);

  // Fetch remaining pages in parallel batches
  for (let batchStart = 1; batchStart < pagesNeeded; batchStart += PARALLEL_BATCH) {
    const batchEnd = Math.min(batchStart + PARALLEL_BATCH, pagesNeeded);
    const pagePromises = [];

    for (let page = batchStart; page < batchEnd; page++) {
      const variables = {
        storeId,
        storefilter: "IN_STORE",
        channel: "DESKTOP",
        navParam,
        isBrandPricingPolicyCompliant: false,
        additionalSearchParams: { multiStoreIds: [] },
        orderBy: orderBy,
        ps: pageSize,
        si: page * pageSize
      };
      pagePromises.push(apiCall("searchModel", variables, CATEGORY_QUERY));
    }

    // Wait for batch to complete
    const results = await Promise.all(pagePromises);

    let gotEmptyPage = false;
    results.forEach(data => {
      const products = data?.data?.searchModel?.products || [];
      if (products.length === 0) gotEmptyPage = true;
      products.forEach(p => {
        if (p.itemId) skus.add(p.itemId);
      });
    });

    // Stop if we hit an empty page
    if (gotEmptyPage) break;

    // Delay between batches to avoid rate limiting
    await new Promise(r => setTimeout(r, 150));
  }

  return Array.from(skus);
}

// Listen for messages from popup. Guard against double-registration: the
// manifest auto-injects content.js on page load, and background.js may also
// inject it via scripting.executeScript when ping fails — without this guard,
// both instances would register listeners and every handler would run twice
// (observed as duplicate IDB writes in the fulfillment log).
if (window.__hdContentListenerRegistered) {
  console.log('[HD Scanner] onMessage listener already registered, skipping duplicate');
} else {
  window.__hdContentListenerRegistered = true;
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // SITEMAP SCAN - discovers categories from HD's XML sitemaps (~5000+)
  // then scans each for in-store products. Catches items the hardcoded list misses.
  if (request.action === 'getStoreSkusSitemap') {
    scanStopped = false;
    rateLimitedCategoryCount = 0;
    (async () => {
      const { storeId } = request;
      const allSkus = new Set();
      const scanResults = {};
      const PARALLEL_CATEGORIES = 3;
      let categoriesSinceSave = 0;

      // Load existing cached SKUs
      await SKU_INVENTORY.load();
      const cachedSkus = SKU_INVENTORY.getAll(storeId);
      cachedSkus.forEach(sku => allSkus.add(sku));
      const startingCount = allSkus.size;

      console.log(`[HD Scanner] SITEMAP SCAN: Starting with ${startingCount} cached SKUs`);

      // Step 1: Discover categories from sitemaps
      chrome.runtime.sendMessage({
        type: 'skuProgress', phase: 'mapping', current: 0, total: 1,
        skuCount: allSkus.size, category: 'Discovering categories from sitemaps...'
      }).catch(() => {});

      const sitemapCategories = await fetchSitemapCategories();
      const sitemapCount = sitemapCategories.size;
      console.log(`[HD Scanner] Sitemap seeds: ${sitemapCount} categories`);

      // Step 2: Expand sitemap seeds into full subcategory tree via API
      chrome.runtime.sendMessage({
        type: 'skuProgress', phase: 'mapping', current: 0, total: 1,
        skuCount: allSkus.size, category: `Expanding ${sitemapCount} seed categories via API...`
      }).catch(() => {});

      const seedNavParams = [...sitemapCategories.keys()];
      const allCategories = await discoverCategoriesByStore(seedNavParams, storeId);

      // Merge any sitemap categories that the API didn't return
      for (const [np, info] of sitemapCategories) {
        if (!allCategories.has(np)) {
          allCategories.set(np, info);
        }
      }

      const sitemapOnlyCount = sitemapCount;
      const totalCats = allCategories.size;
      console.log(`[HD Scanner] FULL SCAN: ${totalCats} total categories (${sitemapCount} from sitemap, ${totalCats - sitemapCount} discovered via API)`);

      let categoriesScanned = 0;
      let categoriesWithProducts = 0;
      const categoryEntries = [...allCategories.entries()];

      // Step 2: Scan categories in parallel batches
      for (let i = 0; i < categoryEntries.length; i += PARALLEL_CATEGORIES) {
        if (scanStopped) break;

        const batch = categoryEntries.slice(i, i + PARALLEL_CATEGORIES);
        const batchPromises = batch.map(async ([navParam, info]) => {
          if (scanStopped) return { navParam, label: info.label, skus: [] };
          const skus = await getStoreSkusByNavParam(navParam, storeId);
          return { navParam, label: info.label, skus };
        });

        const results = await Promise.all(batchPromises);

        for (const { navParam, label, skus } of results) {
          categoriesScanned++;
          const newSkus = skus.filter(s => !allSkus.has(s));
          skus.forEach(s => allSkus.add(s));

          if (newSkus.length > 0) categoriesWithProducts++;
          // Record ALL categories with results so overflow can re-scan any that hit the 720 cap.
          // Key by navParam (unique) rather than label — different categories share labels
          // (e.g. "Accessories") and would otherwise overwrite each other, corrupting the
          // breakdown and making the overflow pass miss capped categories.
          if (skus.length > 0) {
            scanResults[navParam] = { label, new: newSkus.length, total: skus.length, navParam };
            if (newSkus.length > 0) {
              console.log(`[HD Scanner] [${categoriesScanned}/${totalCats}] ${label}: +${newSkus.length} (total: ${allSkus.size})`);
            }
          }
        }

        // Progress update every batch
        chrome.runtime.sendMessage({
          type: 'skuProgress',
          phase: 'collecting',
          current: categoriesScanned,
          total: totalCats,
          skuCount: allSkus.size,
          cachedCount: startingCount,
          category: batch.map(b => b[1].label).join(', ')
        }).catch(() => {});

        // Incremental persistence: flush discovered SKUs to inventory + storage
        // roughly every 5 categories so a crash/stop mid-scan doesn't lose the pass.
        // Fire-and-forget — awaiting a storage write across thousands of categories
        // would dominate scan time; the final save() below is awaited for durability.
        categoriesSinceSave += results.length;
        if (categoriesSinceSave >= 5) {
          categoriesSinceSave = 0;
          SKU_INVENTORY.addSkus(Array.from(allSkus), storeId);
          SKU_INVENTORY.save();
        }

        // Delay between batches
        await new Promise(r => setTimeout(r, 200));
      }

      // Persist main-pass SKUs to the pending-resume storage keys. (The in-memory
      // SKU_INVENTORY add + save happens once at the end so it also captures the
      // overflow pass; adding here too would be redundant and miss overflow SKUs.)
      await chrome.storage.local.set({
        sitemapPendingSkus: Array.from(allSkus),
        sitemapPendingStoreId: storeId
      });

      // Start the background clearance scan DIRECTLY via the service worker.
      // The popup is often closed during long sitemap scans; the service worker
      // is always alive and can receive this message even when the popup isn't.
      // Callers that manage their own scan state (e.g. Telegram flow) pass
      // skipAutoStart: true so this handler just returns the SKUs.
      if (!scanStopped && allSkus.size > 0 && !request.skipAutoStart) {
        chrome.runtime.sendMessage({
          action: 'startBackgroundScan',
          skus: Array.from(allSkus),
          storeId: storeId,
          scanType: 'sitemap'
        }).then(r => console.log('[HD Scanner] Background scan started:', r))
          .catch(e => console.warn('[HD Scanner] startBackgroundScan failed:', e.message));

        // Also broadcast a lightweight signal so the popup UI can update if it's open
        chrome.runtime.sendMessage({
          type: 'sitemapMainPassDone',
          storeId: storeId,
          skuCount: allSkus.size,
          categoriesScanned: categoriesScanned,
          categoriesWithProducts: categoriesWithProducts,
          totalCategories: totalCats,
          sitemapOnly: sitemapOnlyCount
        }).catch(() => {});
      }

      // Pass 2: Overflow scan — re-scan capped categories with alternate sort orders
      const cappedCategories = Object.entries(scanResults)
        .filter(([_, r]) => r.total >= 720 && r.navParam);

      let overflowNewCount = 0;
      if (cappedCategories.length > 0 && !scanStopped) {
        console.log(`[HD Scanner] ${cappedCategories.length} categories hit 720 cap, re-scanning with alternate sorts...`);
        chrome.runtime.sendMessage({
          type: 'skuProgress', phase: 'overflow', current: categoriesScanned, total: totalCats,
          skuCount: allSkus.size,
          category: `Overflow scan: re-scanning ${cappedCategories.length} capped categories with alternate sorts...`
        }).catch(() => {});

        let overflowScanned = 0;
        // scanResults is now keyed by navParam; the label lives on the value object.
        for (const [navParam, result] of cappedCategories) {
          if (scanStopped) break;
          overflowScanned++;
          for (const sortOrder of SORT_ORDERS.slice(1)) { // skip TOP_SELLERS (already done)
            if (scanStopped) break;
            const skus = await getStoreSkusByNavParam(result.navParam, storeId, sortOrder);
            const newSkus = skus.filter(s => !allSkus.has(s));
            skus.forEach(s => allSkus.add(s));
            if (newSkus.length > 0) {
              overflowNewCount += newSkus.length;
              console.log(`[HD Scanner] OVERFLOW ${result.label} (${sortOrder.field} ${sortOrder.order}): +${newSkus.length} new SKUs`);
            }
            await new Promise(r => setTimeout(r, 200));
          }
          chrome.runtime.sendMessage({
            type: 'skuProgress', phase: 'overflow', current: categoriesScanned, total: totalCats,
            skuCount: allSkus.size,
            category: `Overflow ${overflowScanned}/${cappedCategories.length}: ${result.label}`
          }).catch(() => {});
        }
        console.log(`[HD Scanner] Overflow pass complete: +${overflowNewCount} additional SKUs from ${cappedCategories.length} capped categories`);

        chrome.runtime.sendMessage({
          type: 'sitemapOverflowDone',
          newSkus: overflowNewCount,
          categoriesProcessed: cappedCategories.length,
          totalSkus: allSkus.size
        }).catch(() => {});
      }

      // Save all discovered SKUs
      const newlyDiscovered = allSkus.size - startingCount;
      SKU_INVENTORY.addSkus(Array.from(allSkus), storeId);
      await SKU_INVENTORY.save();

      const status = scanStopped ? 'STOPPED' : 'COMPLETE';
      console.log(`[HD Scanner] SITEMAP SCAN ${status}: ${allSkus.size} unique SKUs from ${categoriesScanned} categories (${categoriesWithProducts} had products, ${newlyDiscovered} new SKUs, ${rateLimitedCategoryCount} rate-limited/errored)`);

      sendResponse({
        skus: Array.from(allSkus),
        total: allSkus.size,
        newThisScan: newlyDiscovered,
        fromCache: startingCount,
        categoriesScanned: categoriesScanned,
        categoriesWithProducts: categoriesWithProducts,
        totalCategories: totalCats,
        sitemapOnly: sitemapOnlyCount,
        mode: 'sitemap',
        breakdown: scanResults,
        stopped: scanStopped,
        cappedCategories: cappedCategories.length,
        overflowSkus: overflowNewCount,
        rateLimitedCategories: rateLimitedCategoryCount
      });
    })();
    return true;
  }

  // Stop any scan (general stop handler)
  if (request.action === 'stopScan' || request.action === 'stopSitemapScan') {
    scanStopped = true;
    console.log('[HD Scanner] Stop requested - stopping all scans');
    sendResponse({ ok: true });
    return true;
  }

  // Check a single SKU at a specific store (for cross-store comparison)
  // ==================== DATABASE OPERATIONS ====================

  // Get database stats
  if (request.action === 'db_getStats') {
    (async () => {
      try {
        const stats = await window.HDDB.getStats();
        sendResponse({ success: true, stats });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Get items by store
  if (request.action === 'db_getItemsByStore') {
    (async () => {
      try {
        const items = await window.HDDB.getItemsByStore(request.storeId);
        sendResponse({ success: true, items });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Get all items across all stores
  if (request.action === 'db_getAllItems') {
    (async () => {
      try {
        const items = await window.HDDB.getAllItems();
        sendResponse({ success: true, items });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Get item at all stores (for comparison)
  if (request.action === 'db_getItemAllStores') {
    (async () => {
      try {
        const items = await window.HDDB.getItemAllStores(request.itemId);
        sendResponse({ success: true, items });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Compare stores (items at multiple stores)
  if (request.action === 'db_compareStores') {
    (async () => {
      try {
        const comparison = await window.HDDB.compareStores();
        sendResponse({ success: true, comparison });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Get best deals
  if (request.action === 'db_getBestDeals') {
    (async () => {
      try {
        const deals = await window.HDDB.getBestDeals(request.limit || 50);
        sendResponse({ success: true, deals });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Get scan history
  if (request.action === 'db_getScanHistory') {
    (async () => {
      try {
        const history = await window.HDDB.getScanHistory(request.storeId, request.limit || 50);
        sendResponse({ success: true, history });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Get price history for an item
  if (request.action === 'db_getPriceHistory') {
    (async () => {
      try {
        const history = await window.HDDB.getPriceHistory(request.itemId, request.storeId);
        sendResponse({ success: true, history });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Get new items (recently discovered)
  if (request.action === 'db_getNewItems') {
    (async () => {
      try {
        const items = await window.HDDB.getNewItems(request.days || 7, request.storeId);
        sendResponse({ success: true, items });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Get items with price drops
  if (request.action === 'db_getPriceDrops') {
    (async () => {
      try {
        const items = await window.HDDB.getItemsWithPriceDrops(request.storeId);
        sendResponse({ success: true, items });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Watchlist operations
  if (request.action === 'db_getWatchlist') {
    (async () => {
      try {
        const watchlist = await window.HDDB.getWatchlist();
        sendResponse({ success: true, watchlist });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (request.action === 'db_addToWatchlist') {
    (async () => {
      try {
        const result = await window.HDDB.addToWatchlist(
          request.itemId,
          request.storeId || null,
          request.targetPrice || null,
          request.notes || ''
        );
        sendResponse({ success: true, result });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (request.action === 'db_removeFromWatchlist') {
    (async () => {
      try {
        await window.HDDB.removeFromWatchlist(request.id);
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Export all data
  if (request.action === 'db_exportAll') {
    (async () => {
      try {
        const data = await window.HDDB.exportAllData();
        sendResponse({ success: true, data });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Clear database
  if (request.action === 'db_clearAll') {
    (async () => {
      try {
        await window.HDDB.clearAllData();
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Save items to database (called from popup after scan completes)
  if (request.action === 'db_saveItems') {
    (async () => {
      try {
        const results = await window.HDDB.saveItems(request.items, request.storeId);
        console.log(`[HD DB] Saved ${results.length} items to database`);
        sendResponse({ success: true, savedCount: results.length });
      } catch (e) {
        console.error('[HD DB] Save failed:', e);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Record scan to database
  if (request.action === 'db_recordScan') {
    (async () => {
      try {
        const result = await window.HDDB.recordScan(request.storeId, request.stats);
        console.log(`[HD DB] Recorded scan:`, result);
        sendResponse({ success: true, scanId: result.id });
      } catch (e) {
        console.error('[HD DB] Record scan failed:', e);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Append a batch of fulfillment log records (penny scan)
  if (request.action === 'db_saveFulfillmentBatch') {
    (async () => {
      try {
        const count = await window.HDDB.saveFulfillmentBatch(request.records);
        sendResponse({ success: true, savedCount: count });
      } catch (e) {
        console.error('[HD DB] Save fulfillment batch failed:', e);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Read fulfillment log, optionally filtered by scanId
  if (request.action === 'db_getFulfillmentLog') {
    (async () => {
      try {
        const records = await window.HDDB.getFulfillmentLog(request.scanId || null);
        sendResponse({ success: true, records });
      } catch (e) {
        console.error('[HD DB] Get fulfillment log failed:', e);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Clear fulfillment log
  if (request.action === 'db_clearFulfillmentLog') {
    (async () => {
      try {
        await window.HDDB.clearFulfillmentLog();
        sendResponse({ success: true });
      } catch (e) {
        console.error('[HD DB] Clear fulfillment log failed:', e);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Count fulfillment log entries
  if (request.action === 'db_countFulfillmentLog') {
    (async () => {
      try {
        const count = await window.HDDB.countFulfillmentLog(request.scanId || null);
        sendResponse({ success: true, count });
      } catch (e) {
        console.error('[HD DB] Count fulfillment log failed:', e);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // ==================== END DATABASE OPERATIONS ====================

  // Fast batch check — single GraphQL request for multiple SKUs
  if (request.action === 'checkSkuBatchFast') {
    (async () => {
      // Ensure the persisted cache is loaded before we set/save into it, so a
      // late-resolving startup load can't clobber the items written here.
      await CLEARANCE_CACHE.load();
      const results = await checkSkuBatchFast(request.skus, request.storeId);
      await CLEARANCE_CACHE.save();
      sendResponse({ results });
    })();
    return true;
  }

  // ==================== TWO-PASS BATCH CHECK ====================
  // Pass 1: Light check using products() batch endpoint (16 SKUs/request, 5 parallel)
  // Returns only clearance status — no product names/URLs
  if (request.action === 'checkSkuBatchLight') {
    (async () => {
      const { skus, storeId } = request;
      const CHUNK_SIZE = 16;      // HD API max for products()
      const PARALLEL_CHUNKS = 5;  // 5 parallel = 80 SKUs per wave — proven safe
      // Snapshot the global 403 counter — the response reports throttle events
      // that happened during this call (diagnostic only, does not drive pacing).
      const rateLimitHitsAtStart = rateLimitHits;

      const lightQuery = `query mediaPriceInventory($itemIds: [String!]!, $storeId: String!) {
        products(itemIds: $itemIds) {
          itemId
          pricing(storeId: $storeId) { value original clearance { value dollarOff percentageOff } }
          fulfillment(storeId: $storeId) { fulfillmentOptions { type fulfillable services { type locations { inventory { quantity isInStock } locationId } } } }
        }
      }`;

      const allResults = [];

      // Chunk SKUs into groups of 16
      const chunks = [];
      for (let i = 0; i < skus.length; i += CHUNK_SIZE) {
        chunks.push(skus.slice(i, i + CHUNK_SIZE));
      }

      // Process in parallel waves
      for (let i = 0; i < chunks.length; i += PARALLEL_CHUNKS) {
        if (scanStopped) break;  // honor stop between waves; return partial results
        const wave = chunks.slice(i, i + PARALLEL_CHUNKS);
        const waveResults = await Promise.all(wave.map(async (chunk) => {
          try {
            // Routed through graphqlFetch: adds a 20s timeout and, on 403/429,
            // waits out the shared cooldown (with retries) before giving up —
            // instead of immediately erroring the chunk and hammering the next wave.
            const data = await graphqlFetch('mediaPriceInventory', { itemIds: chunk, storeId }, lightQuery);
            if (data.error) {
              return chunk.map(sku => ({ itemId: sku, error: true }));
            }
            const products = data.data?.products || [];

            // Build a map for quick lookup (products may not return in order)
            const productMap = {};
            for (const p of products) {
              if (p && p.itemId) productMap[p.itemId] = p;
            }

            return chunk.map(sku => {
              const p = productMap[sku];
              if (!p) return { itemId: sku, error: false, clearance: null };

              const pricing = p.pricing || {};
              const clearance = pricing.clearance;
              if (!clearance || clearance.value == null) return { itemId: sku, error: false, clearance: null };

              // Extract fulfillment info
              let quantity = 0, isInStock = false, hasBopis = false, pickupFulfillable = true;
              (p.fulfillment?.fulfillmentOptions || []).forEach(opt => {
                if (opt.type === 'pickup') {
                  pickupFulfillable = opt.fulfillable;
                  (opt.services || []).forEach(svc => {
                    if (svc.type === 'bopis') hasBopis = true;
                    (svc.locations || []).forEach(loc => {
                      if (loc.locationId === storeId) {
                        quantity = loc.inventory?.quantity || 0;
                        isInStock = loc.inventory?.isInStock || false;
                      }
                    });
                  });
                } else {
                  (opt.services || []).forEach(svc => {
                    (svc.locations || []).forEach(loc => {
                      if (loc.locationId === storeId && quantity === 0) {
                        quantity = loc.inventory?.quantity || 0;
                        isInStock = loc.inventory?.isInStock || false;
                      }
                    });
                  });
                }
              });

              const isAdvertised = hasBopis && !pickupFulfillable;

              return {
                itemId: sku,
                error: false,
                clearance: {
                  itemId: sku,
                  onlinePrice: pricing.value || 0,
                  clearancePrice: clearance.value,
                  dollarOff: clearance.dollarOff || 0,
                  percentOff: clearance.percentageOff || 0,
                  quantity, isInStock, isAdvertised, pickupFulfillable
                }
              };
            });
          } catch (e) {
            console.error('[HD Scanner] Light batch error:', e.message);
            return chunk.map(sku => ({ itemId: sku, error: true }));
          }
        }));

        allResults.push(...waveResults.flat());

        // Small delay between waves to avoid WAF
        if (i + PARALLEL_CHUNKS < chunks.length) {
          await new Promise(r => setTimeout(r, 500));
        }
      }

      sendResponse({
        results: allResults,
        stopped: scanStopped,
        rateLimitHits: rateLimitHits - rateLimitHitsAtStart
      });
    })();
    return true;
  }

  // Pass 2: Full product details for confirmed clearance items only
  // Gets name, brand, URL, variant info needed for Telegram notifications
  if (request.action === 'getProductDetailsBatch') {
    (async () => {
      const { skus, storeId } = request;
      const results = [];

      // Ensure the persisted cache is loaded before checkSku writes into it.
      await CLEARANCE_CACHE.load();

      // Use existing single-product query for each (small list, ~50-100 max)
      for (const sku of skus) {
        if (scanStopped) break;  // honor stop between lookups; return partial results
        try {
          const result = await checkSku(sku, storeId);
          results.push(result);
        } catch (e) {
          results.push({ error: true, itemId: sku });
        }
        // Small delay between individual lookups
        if (skus.length > 5) {
          await new Promise(r => setTimeout(r, 200));
        }
      }

      await CLEARANCE_CACHE.save();
      sendResponse({ results, stopped: scanStopped });
    })();
    return true;
  }

  // ==================== AISLE/BAY LOOKUP ====================
  // Uses the top-level aislebay GraphQL field (separate from product.fulfillment)
  // Takes storeSkuNumbers (not itemIds) and returns aisle/bay per store.
  if (request.action === 'lookupAisleBay') {
    (async () => {
      const { storeId, storeSkuIds } = request;
      const CHUNK_SIZE = 20; // batch up to 20 SKUs per request

      const aislebayQuery = `query aislebay($storeId: String!, $storeSkuIds: [String!]!) {
        aislebay(storeId: $storeId, storeSkuIds: $storeSkuIds) {
          storeSkus {
            storeNumber
            storeSkuId
            aisleBayInfo { aisle bay invLocDesc invLocDescFriendly }
          }
        }
      }`;

      const allResults = {};

      const chunks = [];
      for (let i = 0; i < storeSkuIds.length; i += CHUNK_SIZE) {
        chunks.push(storeSkuIds.slice(i, i + CHUNK_SIZE));
      }

      for (const chunk of chunks) {
        try {
          // Routed through graphqlFetch for the 20s timeout + shared 403/429 cooldown.
          const data = await graphqlFetch('aislebay', { storeId, storeSkuIds: chunk }, aislebayQuery);
          if (data.error) continue;

          const storeSkus = data?.data?.aislebay?.storeSkus || [];
          for (const s of storeSkus) {
            if (s.storeSkuId && s.aisleBayInfo) {
              allResults[s.storeSkuId] = {
                aisle: s.aisleBayInfo.aisle || null,
                bay: s.aisleBayInfo.bay || null,
                location: s.aisleBayInfo.invLocDescFriendly || s.aisleBayInfo.invLocDesc || null
              };
            }
          }
        } catch (e) {
          console.error('[HD Scanner] Aisle/bay lookup error:', e.message);
        }
      }

      sendResponse({ results: allResults });
    })();
    return true;
  }

  // ==================== PENNY BATCH CHECK ====================
  // Uses products() batch endpoint (like light check) but with anchorStoreStatusType
  // for penny fingerprint detection. 16 SKUs/request, 5 parallel = 80 SKUs/wave.
  if (request.action === 'checkPennyBatch') {
    (async () => {
      const { skus, storeId } = request;
      const CHUNK_SIZE = 16;
      const PARALLEL_CHUNKS = 5;  // proven safe
      const rateLimitHitsAtStart = rateLimitHits;

      const pennyQuery = `query mediaPriceInventory($itemIds: [String!]!, $storeId: String!) {
        products(itemIds: $itemIds) {
          itemId
          identifiers { productLabel brandName canonicalUrl storeSkuNumber }
          pricing(storeId: $storeId) { value original clearance { value dollarOff percentageOff } }
          fulfillment(storeId: $storeId) { anchorStoreStatusType fulfillmentOptions { type fulfillable services { type locations { inventory { quantity isInStock } locationId } } } }
          availabilityType { buyable discontinued type }
        }
      }`;

      const allResults = [];
      const chunks = [];
      for (let i = 0; i < skus.length; i += CHUNK_SIZE) {
        chunks.push(skus.slice(i, i + CHUNK_SIZE));
      }

      for (let i = 0; i < chunks.length; i += PARALLEL_CHUNKS) {
        if (scanStopped) break;  // honor stop between waves; return partial results
        const wave = chunks.slice(i, i + PARALLEL_CHUNKS);
        const waveResults = await Promise.all(wave.map(async (chunk) => {
          try {
            // Routed through graphqlFetch: 20s timeout + shared 403/429 cooldown,
            // so a rate-limited chunk waits out the cooldown before erroring.
            const data = await graphqlFetch('mediaPriceInventory', { itemIds: chunk, storeId }, pennyQuery);
            if (data.error) {
              return chunk.map(sku => ({ itemId: sku, error: true }));
            }
            const products = data.data?.products || [];

            const productMap = {};
            for (const p of products) {
              if (p && p.itemId) productMap[p.itemId] = p;
            }

            return chunk.map(sku => {
              const p = productMap[sku];
              if (!p) return { itemId: sku, error: false, pennySignal: false };

              const pricing = p.pricing || {};
              const clearance = pricing.clearance;
              const anchorStatus = p.fulfillment?.anchorStoreStatusType;
              const opts = p.fulfillment?.fulfillmentOptions || [];
              const hasPickup = opts.some(o => o.type === 'pickup');
              const deliveryOpt = opts.find(o => o.type === 'delivery');
              const deliveryFulfillable = deliveryOpt && deliveryOpt.fulfillable === true;

              // Penny fingerprint:
              //   1. CLEARANCE at store
              //   2. No pickup option (HD removed it)
              //   3. No clearance pricing (HD hid the $0.01)
              //   4. Delivery still fulfillable (stock exists somewhere in HD's system)
              const isPenny = anchorStatus === 'CLEARANCE'
                           && !hasPickup
                           && (!clearance || clearance.value == null)
                           && deliveryFulfillable;

              if (isPenny) {
                console.log(`[HD Scanner] 🪙 PENNY: ${sku} — CLEARANCE, no pickup, no clr price, delivery fulfillable`);
              }

              // Walk the fulfillment tree for a location matching our storeId and
              // pull its inventory.quantity. HD strips the pickup/BOPIS branch on
              // pennies, but the delivery→express-delivery branch often still
              // carries a location node for the physical store. This is SELLABLE
              // quantity (reserved/damaged subtracted), so treat as a lower bound.
              let storeQuantity = null;
              let storeQuantityVia = null;
              const targetStore = String(storeId);
              outer: for (const opt of opts) {
                for (const svc of (opt.services || [])) {
                  for (const loc of (svc.locations || [])) {
                    if (String(loc.locationId) === targetStore && loc.inventory?.quantity != null) {
                      storeQuantity = loc.inventory.quantity;
                      storeQuantityVia = `${opt.type}/${svc.type}`;
                      break outer;
                    }
                  }
                }
              }

              const ids = p.identifiers || {};
              const avail = p.availabilityType || {};

              return {
                itemId: sku,
                error: false,
                pennySignal: isPenny,
                onlinePrice: pricing.value || 0,
                name: ids.productLabel || null,
                brand: ids.brandName || null,
                storeSkuNumber: ids.storeSkuNumber || '',
                url: ids.canonicalUrl ? `https://www.homedepot.com${ids.canonicalUrl}` : null,
                discontinued: avail.discontinued || false,
                availType: avail.type || null,
                storeQuantity,
                storeQuantityVia
              };
            });
          } catch (e) {
            console.error('[HD Scanner] Penny batch error:', e.message);
            return chunk.map(sku => ({ itemId: sku, error: true }));
          }
        }));

        allResults.push(...waveResults.flat());

        if (i + PARALLEL_CHUNKS < chunks.length) {
          await new Promise(r => setTimeout(r, 500));
        }
      }

      sendResponse({
        results: allResults,
        stopped: scanStopped,
        rateLimitHits: rateLimitHits - rateLimitHitsAtStart
      });
    })();
    return true;
  }

  // ==================== CACHE OPERATIONS ====================
  // Get cached SKUs for a store (used by "Check Cache" feature)
  if (request.action === 'getCachedSkus') {
    (async () => {
      await SKU_INVENTORY.load();
      const skus = SKU_INVENTORY.getAll(request.storeId);
      console.log(`[HD Scanner] getCachedSkus: returning ${skus.length} SKUs for store ${request.storeId}`);
      sendResponse({
        skus: skus,
        total: skus.length,
        storeId: request.storeId
      });
    })();
    return true;
  }

  // ==================== STORE SEARCH (for Telegram /zip) ====================
  // Searches HD stores by zip code or store name using the storeSearch GraphQL query.
  // Runs in content script so it can use HD session cookies via `credentials: 'include'`.
  if (request.action === 'searchStores') {
    console.log('[HD Scanner] searchStores called with query:', request.query);
    (async () => {
      try {
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
      storeType
    }
  }
}`;
        const resp = await fetchWithTimeout(`${API_URL}?opname=storeSearch`, {
          method: 'POST',
          credentials: 'include',
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
              storeSearchInput: String(request.query || '').trim(),
              storeFeaturesFilter: {}
            },
            query: STORE_SEARCH_QUERY
          })
        }, 20000);
        if (!resp.ok) {
          sendResponse({ ok: false, error: `HTTP ${resp.status}`, stores: [] });
          return;
        }
        const data = await resp.json();
        console.log('[HD Scanner] searchStores raw response:', JSON.stringify(data).substring(0, 500));
        const stores = data?.data?.storeSearch?.stores || [];
        console.log('[HD Scanner] searchStores found', stores.length, 'stores');
        sendResponse({ ok: true, stores });
      } catch (e) {
        console.error('[HD Scanner] searchStores error:', e);
        sendResponse({ ok: false, error: e?.message || 'search failed', stores: [] });
      }
    })();
    return true;
  }

  if (request.action === 'ping') {
    (async () => {
      await SKU_INVENTORY.load();
      const allStoresTotal = Object.values(SKU_INVENTORY.stores).reduce((sum, s) => sum + s.skus.size, 0);
      const storeCount = Object.keys(SKU_INVENTORY.stores).length;
      sendResponse({
        status: 'ok',
        cache: {
          total: allStoresTotal,
          storeCount: storeCount,
          stores: SKU_INVENTORY.getAllStoreStats(),
          clearance: CLEARANCE_CACHE.items.size
        }
      });
    })();
    return true;
  }
});

console.log('HD Clearance Scanner content script loaded');
} // close __hdContentListenerRegistered guard

} catch (e) {
  console.error('[HD Scanner] Fatal error in content script:', e);
}

