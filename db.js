// IndexedDB Database for HD Clearance Scanner
// Stores: price history, scan history, watchlist, cross-store data

const DB_NAME = 'HDClearanceDB';
const DB_VERSION = 2;

let db = null;

// Initialize the database
function initDB() {
  return new Promise((resolve, reject) => {
    if (db) {
      resolve(db);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('[HD DB] Failed to open database:', request.error);
      reject(request.error);
    };

    // Older tabs holding v1 connections block v2 upgrades forever without this.
    request.onblocked = () => {
      console.warn('[HD DB] Upgrade blocked by another open connection. Close other HD tabs.');
      reject(new Error('IndexedDB upgrade blocked — close other HD tabs and retry'));
    };

    request.onsuccess = () => {
      db = request.result;
      // If another context bumps the version later, close so that upgrade can proceed.
      db.onversionchange = () => {
        console.warn('[HD DB] Version change detected, closing this connection');
        db.close();
        db = null;
      };
      console.log('[HD DB] Database opened successfully');
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      console.log('[HD DB] Upgrading database schema...');

      // Store: clearance_items - Main item data with latest info
      // Key: [storeId, itemId]
      if (!database.objectStoreNames.contains('clearance_items')) {
        const itemStore = database.createObjectStore('clearance_items', {
          keyPath: ['storeId', 'itemId']
        });
        itemStore.createIndex('by_item', 'itemId', { unique: false });
        itemStore.createIndex('by_store', 'storeId', { unique: false });
        itemStore.createIndex('by_price', 'clearancePrice', { unique: false });
        itemStore.createIndex('by_percent_off', 'percentOff', { unique: false });
        itemStore.createIndex('by_first_seen', 'firstSeen', { unique: false });
        itemStore.createIndex('by_last_seen', 'lastSeen', { unique: false });
        console.log('[HD DB] Created clearance_items store');
      }

      // Store: price_history - Track price changes over time
      // Key: auto-increment
      if (!database.objectStoreNames.contains('price_history')) {
        const historyStore = database.createObjectStore('price_history', {
          keyPath: 'id',
          autoIncrement: true
        });
        historyStore.createIndex('by_item_store', ['itemId', 'storeId'], { unique: false });
        historyStore.createIndex('by_item', 'itemId', { unique: false });
        historyStore.createIndex('by_date', 'timestamp', { unique: false });
        console.log('[HD DB] Created price_history store');
      }

      // Store: scans - Record of each scan performed
      // Key: auto-increment
      if (!database.objectStoreNames.contains('scans')) {
        const scanStore = database.createObjectStore('scans', {
          keyPath: 'id',
          autoIncrement: true
        });
        scanStore.createIndex('by_store', 'storeId', { unique: false });
        scanStore.createIndex('by_date', 'timestamp', { unique: false });
        console.log('[HD DB] Created scans store');
      }

      // Store: watchlist - Items user wants to track
      // Key: [storeId, itemId] or just itemId for all-store watch
      if (!database.objectStoreNames.contains('watchlist')) {
        const watchStore = database.createObjectStore('watchlist', {
          keyPath: 'id',
          autoIncrement: true
        });
        watchStore.createIndex('by_item', 'itemId', { unique: false });
        watchStore.createIndex('by_store', 'storeId', { unique: false });
        console.log('[HD DB] Created watchlist store');
      }

      // Store: fulfillment_log - Raw per-SKU fulfillment payloads from penny scans
      // Key: auto-increment
      if (!database.objectStoreNames.contains('fulfillment_log')) {
        const logStore = database.createObjectStore('fulfillment_log', {
          keyPath: 'id',
          autoIncrement: true
        });
        logStore.createIndex('by_scan', 'scanId', { unique: false });
        logStore.createIndex('by_item', 'itemId', { unique: false });
        logStore.createIndex('by_store', 'storeId', { unique: false });
        logStore.createIndex('by_date', 'timestamp', { unique: false });
        console.log('[HD DB] Created fulfillment_log store');
      }

      console.log('[HD DB] Database schema upgrade complete');
    };
  });
}

// ==================== CLEARANCE ITEMS ====================

// Save or update a clearance item
async function saveItem(item, storeId) {
  const database = await initDB();

  return new Promise((resolve, reject) => {
    const tx = database.transaction(['clearance_items', 'price_history'], 'readwrite');
    const store = tx.objectStore('clearance_items');
    const historyStore = tx.objectStore('price_history');

    // First check if item exists
    const getRequest = store.get([storeId, item.itemId]);

    getRequest.onsuccess = () => {
      const existing = getRequest.result;
      const now = Date.now();

      const record = {
        storeId: storeId,
        itemId: item.itemId,
        name: item.name,
        brand: item.brand,
        modelNumber: item.modelNumber || '',
        storeSkuNumber: item.storeSkuNumber || '',
        variant: item.variant || null,
        onlinePrice: item.onlinePrice,
        clearancePrice: item.clearancePrice,
        percentOff: item.percentOff,
        dollarOff: item.dollarOff,
        quantity: item.quantity,
        isInStock: item.isInStock,
        isAdvertised: item.isAdvertised,
        possiblePenny: item.possiblePenny || false,
        pennyConfidence: item.pennyConfidence || null,
        url: item.url,
        firstSeen: existing ? existing.firstSeen : now,
        lastSeen: now,
        priceHistory: existing ? existing.priceHistory : []
      };

      // Track price changes. logPrice drives a matching row in the
      // price_history store: seeded on first insert, appended on change.
      let logPrice = !existing;
      if (existing && existing.clearancePrice !== item.clearancePrice) {
        record.priceHistory.push({
          price: existing.clearancePrice,
          date: existing.lastSeen
        });
        record.previousPrice = existing.clearancePrice;
        record.priceDropped = item.clearancePrice < existing.clearancePrice;
        logPrice = true;
      }

      const putRequest = store.put(record);
      putRequest.onsuccess = () => {
        if (logPrice) {
          // Mirror addPriceHistory into the price_history store within the
          // same transaction so getPriceHistory returns real rows.
          historyStore.add({
            itemId: item.itemId,
            storeId: storeId,
            price: item.clearancePrice,
            timestamp: now
          });
        }
        resolve(record);
      };
      putRequest.onerror = () => reject(putRequest.error);
    };

    getRequest.onerror = () => reject(getRequest.error);
  });
}

// Save multiple items (batch)
async function saveItems(items, storeId) {
  const results = [];
  for (const item of items) {
    try {
      const result = await saveItem(item, storeId);
      results.push(result);
    } catch (e) {
      console.error('[HD DB] Error saving item:', item.itemId, e);
    }
  }
  return results;
}

// Get all items for a store
async function getItemsByStore(storeId) {
  const database = await initDB();

  return new Promise((resolve, reject) => {
    const tx = database.transaction('clearance_items', 'readonly');
    const store = tx.objectStore('clearance_items');
    const index = store.index('by_store');
    const request = index.getAll(storeId);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Get item across all stores (for comparison)
async function getItemAllStores(itemId) {
  const database = await initDB();

  return new Promise((resolve, reject) => {
    const tx = database.transaction('clearance_items', 'readonly');
    const store = tx.objectStore('clearance_items');
    const index = store.index('by_item');
    const request = index.getAll(itemId);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Get all items (across all stores)
async function getAllItems() {
  const database = await initDB();

  return new Promise((resolve, reject) => {
    const tx = database.transaction('clearance_items', 'readonly');
    const store = tx.objectStore('clearance_items');
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Get items with price drops since last scan
async function getItemsWithPriceDrops(storeId = null) {
  const items = storeId ? await getItemsByStore(storeId) : await getAllItems();
  return items.filter(item => item.priceDropped);
}

// Get newest items (first seen in last N days)
async function getNewItems(days = 7, storeId = null) {
  const items = storeId ? await getItemsByStore(storeId) : await getAllItems();
  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
  return items.filter(item => item.firstSeen > cutoff);
}

// ==================== PRICE HISTORY ====================

// Add price history entry
async function addPriceHistory(itemId, storeId, price) {
  const database = await initDB();

  return new Promise((resolve, reject) => {
    const tx = database.transaction('price_history', 'readwrite');
    const store = tx.objectStore('price_history');

    const record = {
      itemId,
      storeId,
      price,
      timestamp: Date.now()
    };

    const request = store.add(record);
    request.onsuccess = () => resolve(record);
    request.onerror = () => reject(request.error);
  });
}

// Get price history for an item at a store
async function getPriceHistory(itemId, storeId = null) {
  const database = await initDB();

  return new Promise((resolve, reject) => {
    const tx = database.transaction('price_history', 'readonly');
    const store = tx.objectStore('price_history');

    let request;
    if (storeId) {
      const index = store.index('by_item_store');
      request = index.getAll([itemId, storeId]);
    } else {
      const index = store.index('by_item');
      request = index.getAll(itemId);
    }

    request.onsuccess = () => {
      const results = request.result.sort((a, b) => a.timestamp - b.timestamp);
      resolve(results);
    };
    request.onerror = () => reject(request.error);
  });
}

// ==================== SCAN HISTORY ====================

// Record a scan
async function recordScan(storeId, stats) {
  const database = await initDB();

  return new Promise((resolve, reject) => {
    const tx = database.transaction('scans', 'readwrite');
    const store = tx.objectStore('scans');

    const record = {
      storeId,
      timestamp: Date.now(),
      skusChecked: stats.skusChecked || 0,
      clearanceFound: stats.clearanceFound || 0,
      newItems: stats.newItems || 0,
      priceDrops: stats.priceDrops || 0,
      errors: stats.errors || 0
    };

    const request = store.add(record);
    request.onsuccess = () => {
      record.id = request.result;
      resolve(record);
    };
    request.onerror = () => reject(request.error);
  });
}

// Get scan history
async function getScanHistory(storeId = null, limit = 50) {
  const database = await initDB();

  return new Promise((resolve, reject) => {
    const tx = database.transaction('scans', 'readonly');
    const store = tx.objectStore('scans');

    let request;
    if (storeId) {
      const index = store.index('by_store');
      request = index.getAll(storeId);
    } else {
      request = store.getAll();
    }

    request.onsuccess = () => {
      const results = request.result
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit);
      resolve(results);
    };
    request.onerror = () => reject(request.error);
  });
}

// ==================== WATCHLIST ====================

// Add item to watchlist
async function addToWatchlist(itemId, storeId = null, targetPrice = null, notes = '') {
  const database = await initDB();

  return new Promise((resolve, reject) => {
    const tx = database.transaction('watchlist', 'readwrite');
    const store = tx.objectStore('watchlist');

    const record = {
      itemId,
      storeId, // null = watch all stores
      targetPrice,
      notes,
      addedAt: Date.now(),
      notified: false
    };

    const request = store.add(record);
    request.onsuccess = () => {
      record.id = request.result;
      resolve(record);
    };
    request.onerror = () => reject(request.error);
  });
}

// Remove from watchlist
async function removeFromWatchlist(id) {
  const database = await initDB();

  return new Promise((resolve, reject) => {
    const tx = database.transaction('watchlist', 'readwrite');
    const store = tx.objectStore('watchlist');
    const request = store.delete(id);

    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

// Get watchlist
async function getWatchlist() {
  const database = await initDB();

  return new Promise((resolve, reject) => {
    const tx = database.transaction('watchlist', 'readonly');
    const store = tx.objectStore('watchlist');
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Check watchlist against current items (returns alerts)
async function checkWatchlistAlerts(currentItems, storeId) {
  const database = await initDB();
  const watchlist = await getWatchlist();
  const alerts = [];

  for (const watch of watchlist) {
    // Skip if watching specific store and this isn't it
    if (watch.storeId && watch.storeId !== storeId) continue;

    // Already alerted once — don't re-fire on every subsequent scan.
    if (watch.notified) continue;

    const item = currentItems.find(i => i.itemId === watch.itemId);
    if (!item) continue;

    // Check if price hit target
    if (watch.targetPrice && item.clearancePrice <= watch.targetPrice) {
      alerts.push({
        type: 'target_hit',
        watch,
        item,
        message: `${item.name} hit target price: $${item.clearancePrice} (target: $${watch.targetPrice})`
      });

      // Persist notified=true so this alert fires once, not every scan.
      watch.notified = true;
      await new Promise((resolve, reject) => {
        const tx = database.transaction('watchlist', 'readwrite');
        const store = tx.objectStore('watchlist');
        const request = store.put(watch);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }
  }

  return alerts;
}

// ==================== CROSS-STORE COMPARISON ====================

// Find items available at multiple stores with price comparison
async function compareStores(itemIds = null) {
  const allItems = await getAllItems();

  // Group by itemId
  const byItem = {};
  allItems.forEach(item => {
    if (itemIds && !itemIds.includes(item.itemId)) return;

    if (!byItem[item.itemId]) {
      byItem[item.itemId] = {
        itemId: item.itemId,
        name: item.name,
        brand: item.brand,
        stores: []
      };
    }
    byItem[item.itemId].stores.push({
      storeId: item.storeId,
      price: item.clearancePrice,
      quantity: item.quantity,
      lastSeen: item.lastSeen
    });
  });

  // Only return items at multiple stores
  const multiStore = Object.values(byItem).filter(item => item.stores.length > 1);

  // Sort stores by price for each item
  multiStore.forEach(item => {
    item.stores.sort((a, b) => a.price - b.price);
    item.lowestPrice = item.stores[0].price;
    item.highestPrice = item.stores[item.stores.length - 1].price;
    item.priceDiff = item.highestPrice - item.lowestPrice;
  });

  return multiStore.sort((a, b) => b.priceDiff - a.priceDiff);
}

// Find best deals across all stores
async function getBestDeals(limit = 50) {
  const allItems = await getAllItems();

  return allItems
    .filter(item => item.isAdvertised)
    .sort((a, b) => {
      // Penny items first
      if (a.possiblePenny && !b.possiblePenny) return -1;
      if (!a.possiblePenny && b.possiblePenny) return 1;
      // Then by percent off
      return b.percentOff - a.percentOff;
    })
    .slice(0, limit);
}

// ==================== STATS & UTILITIES ====================

// Get database stats
async function getStats() {
  const database = await initDB();

  const counts = {};
  const storeNames = ['clearance_items', 'price_history', 'scans', 'watchlist', 'fulfillment_log'];

  for (const storeName of storeNames) {
    counts[storeName] = await new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Get unique stores
  const items = await getAllItems();
  const uniqueStores = [...new Set(items.map(i => i.storeId))];

  return {
    totalItems: counts.clearance_items,
    priceHistoryEntries: counts.price_history,
    totalScans: counts.scans,
    watchlistItems: counts.watchlist,
    fulfillmentLogCount: counts.fulfillment_log,
    storesTracked: uniqueStores.length,
    stores: uniqueStores
  };
}

// Clear all data
async function clearAllData() {
  const database = await initDB();

  const storeNames = ['clearance_items', 'price_history', 'scans', 'watchlist', 'fulfillment_log'];

  for (const storeName of storeNames) {
    await new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  console.log('[HD DB] All data cleared');
  return true;
}

// ==================== FULFILLMENT LOG ====================

// Append a batch of fulfillment records in a single transaction
async function saveFulfillmentBatch(records) {
  if (!records || records.length === 0) return 0;
  const database = await initDB();

  return new Promise((resolve, reject) => {
    const tx = database.transaction('fulfillment_log', 'readwrite');
    const store = tx.objectStore('fulfillment_log');

    let count = 0;
    for (const record of records) {
      store.add(record);
      count++;
    }

    tx.oncomplete = () => resolve(count);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Get fulfillment log, optionally filtered by scanId
async function getFulfillmentLog(scanId = null) {
  const database = await initDB();

  return new Promise((resolve, reject) => {
    const tx = database.transaction('fulfillment_log', 'readonly');
    const store = tx.objectStore('fulfillment_log');

    let request;
    if (scanId) {
      const index = store.index('by_scan');
      request = index.getAll(scanId);
    } else {
      request = store.getAll();
    }

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Clear the entire fulfillment log
async function clearFulfillmentLog() {
  const database = await initDB();

  return new Promise((resolve, reject) => {
    const tx = database.transaction('fulfillment_log', 'readwrite');
    const store = tx.objectStore('fulfillment_log');
    const request = store.clear();

    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error);
  });
}

// Count fulfillment log entries
async function countFulfillmentLog(scanId = null) {
  const database = await initDB();

  return new Promise((resolve, reject) => {
    const tx = database.transaction('fulfillment_log', 'readonly');
    const store = tx.objectStore('fulfillment_log');

    let request;
    if (scanId) {
      const index = store.index('by_scan');
      request = index.count(scanId);
    } else {
      request = store.count();
    }

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Make functions available globally
window.HDDB = {
  init: initDB,
  // Items
  saveItem,
  saveItems,
  getItemsByStore,
  getItemAllStores,
  getAllItems,
  getItemsWithPriceDrops,
  getNewItems,
  // Price history
  addPriceHistory,
  getPriceHistory,
  // Scans
  recordScan,
  getScanHistory,
  // Watchlist
  addToWatchlist,
  removeFromWatchlist,
  getWatchlist,
  checkWatchlistAlerts,
  // Cross-store
  compareStores,
  getBestDeals,
  // Fulfillment log (penny scan raw payloads)
  saveFulfillmentBatch,
  getFulfillmentLog,
  clearFulfillmentLog,
  countFulfillmentLog,
  // Utilities
  getStats,
  clearAllData
};

// Initialize on load
initDB().then(() => {
  console.log('[HD DB] Database ready');
}).catch(err => {
  console.error('[HD DB] Database init failed:', err);
});
