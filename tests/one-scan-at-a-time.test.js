'use strict';
// One scan at a time.
//
// Nothing used to stop a second scan from starting while one was running. A
// second price check replaced the first and threw away its progress. A second
// full scan built its product list alongside the first, doubling the request
// rate to Home Depot for as long as that took. The popup made this easy to do
// by accident: after reopening, it showed its scan buttons for a second or two
// before it noticed the running scan.
//
// Run from the extension folder:  node --test

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadContentScript, loadExtension } = require('./harness.js');

const STORE = '2580';
const WAVE = 80; // products the background worker hands the tab per wave
const SITEMAP_URL = 'https://www.homedepot.com/sitemap.xml';

const json = (body) => ({
  status: 200,
  contentType: 'application/graphql-response+json; charset=UTF-8',
  body,
});

// n distinct product numbers.
const skuList = (n) => Array.from({ length: n }, (_, i) => String(300000 + i));

// Runs `action` the first time `when(event)` is true, and never again.
function onFirst(when, action) {
  let done = false;
  return (event) => {
    if (done || !when(event)) return;
    done = true;
    action();
  };
}

// ---------------------------------------------------------------------------
// A scripted Home Depot with a small store behind it
// ---------------------------------------------------------------------------

const regularProduct = (sku) => ({
  itemId: sku,
  pricing: { value: 19.98, original: 19.98, clearance: null },
  fulfillment: { fulfillmentOptions: [] },
});

// A store with one department per entry in `departmentSizes`, each holding that
// many products. Answers everything a full scan asks: the sitemap, the walk
// through the departments, each department's product list, and the price
// check. Every sitemap address except the first answers 404. `onRequest` runs
// before each answer, which is where a test acts at a chosen moment.
function scriptedStore({ departmentSizes = [3, 3, 3, 3, 3, 3], onRequest = () => {} } = {}) {
  const navParams = departmentSizes.map((_, d) => `5yc1vZdept${d}`);
  const productsOf = (navParam) => {
    const d = navParams.indexOf(navParam);
    return Array.from({ length: departmentSizes[d] || 0 }, (_, i) => String(5000000 + d * 1000 + i));
  };
  const sitemapXml = `<urlset>${navParams.map((navParam, d) => (
    `<url><loc>https://www.homedepot.com/b/Department-${d}/N-${navParam}</loc></url>`
  )).join('')}</urlset>`;

  function respond(request) {
    onRequest(request);
    if (!request.payload) {
      return request.url === SITEMAP_URL
        ? { status: 200, contentType: 'application/xml', body: sitemapXml }
        : { status: 404 };
    }
    const { operationName, variables } = request.payload;
    if (operationName === 'searchModel' && variables.ps === undefined) {
      // The walk through the departments: none has sub-departments.
      return json({ data: { searchModel: { metadata: { productCount: { inStore: 0 } }, dimensions: [] } } });
    }
    if (operationName === 'searchModel') {
      const all = productsOf(variables.navParam);
      const page = all.slice(variables.si, variables.si + variables.ps);
      return json({
        data: {
          searchModel: {
            metadata: { productCount: { inStore: all.length } },
            products: page.map((itemId) => ({ itemId })),
          },
        },
      });
    }
    if (operationName === 'mediaPriceInventory') {
      return json({ data: { products: variables.itemIds.map(regularProduct) } });
    }
    return { status: 404 };
  }

  return {
    respond,
    navParams,
    productCount: departmentSizes.reduce((sum, size) => sum + size, 0),
  };
}

const isSitemapRequest = (request) => !request.payload;
const isProductListRequest = (request) => (
  request.payload?.operationName === 'searchModel' && request.payload.variables.ps !== undefined
);
const isPriceRequest = (request) => request.payload?.operationName === 'mediaPriceInventory';

// Product numbers that more than one price request asked about.
function productsAskedMoreThanOnce(requests) {
  const timesAsked = new Map();
  for (const request of requests.filter(isPriceRequest)) {
    for (const sku of request.payload.variables.itemIds) {
      timesAsked.set(sku, (timesAsked.get(sku) || 0) + 1);
    }
  }
  return [...timesAsked].filter(([, times]) => times > 1).map(([sku]) => sku);
}

const fullScan = { action: 'getStoreSkusSitemap', storeId: STORE };

// ---------------------------------------------------------------------------
// The tab on its own: one product-list build at a time
// ---------------------------------------------------------------------------

test('a second full scan while the product list is being built is refused, not run alongside', async () => {
  const lone = loadContentScript({ respond: scriptedStore().respond });
  await lone.send(fullScan);

  const store = scriptedStore();
  const page = loadContentScript({ respond: store.respond });
  const first = page.send(fullScan);
  const second = await page.send(fullScan);
  const firstResult = await first;

  assert.deepEqual(second, { busy: 'discovery' });
  assert.equal(firstResult.stopped, false);
  assert.equal(firstResult.total, store.productCount, 'the first scan found every product');
  assert.equal(
    page.requests.length, lone.requests.length,
    'Home Depot was asked no more than one scan asks'
  );
});

test('after Stop a new full scan can start at once, and the stopped one stays stopped', async () => {
  const store = scriptedStore();
  let second;
  const page = loadContentScript({
    respond: (request, n) => {
      // On the very first request: press Stop, then start again straight away.
      if (n === 1) {
        page.send({ action: 'stopScan' });
        second = page.send(fullScan);
      }
      return store.respond(request);
    },
  });

  const first = await page.send(fullScan);
  const secondResult = await second;

  assert.equal(first.stopped, true, 'the stopped scan stays stopped');
  assert.equal(first.total, 0, 'and collects nothing more');
  assert.equal(secondResult.stopped, false);
  assert.equal(secondResult.total, store.productCount, 'the new scan finds every product');
});

test('ping says whether a full scan is building its product list', async () => {
  const store = scriptedStore();
  let during;
  const page = loadContentScript({
    respond: (request, n) => {
      if (n === 1) during = page.send({ action: 'ping' });
      return store.respond(request);
    },
  });

  assert.equal((await page.send({ action: 'ping' })).discovering, false);
  await page.send(fullScan);
  assert.equal((await during).discovering, true);
  assert.equal((await page.send({ action: 'ping' })).discovering, false);
});

// ---------------------------------------------------------------------------
// The background worker and the tab together
// ---------------------------------------------------------------------------

const startScan = (ext, skus, scanType = 'skuCheckOnly') => (
  ext.popup.toBackground({ action: 'startBackgroundScan', skus, storeId: STORE, scanType })
);
const completions = (ext) => ext.broadcasts.filter((message) => message.type === 'scanComplete');
const firstWaveSaved = (message) => message.type === 'scanProgress' && message.checked === WAVE;

test('starting a scan while prices are being checked is refused, and the running scan is left alone', async () => {
  const skus = skuList(3 * WAVE);
  let secondStart;
  const ext = loadExtension({
    respond: scriptedStore().respond,
    onBroadcast: onFirst(firstWaveSaved, () => { secondStart = startScan(ext, skus, 'penny'); }),
  });

  assert.deepEqual(await startScan(ext, skus), { started: true });
  await ext.idle();

  assert.deepEqual(await secondStart, { started: false, reason: 'already_running' });
  assert.equal(completions(ext).length, 1);
  assert.equal(ext.storage.scanState.scanType, 'skuCheckOnly', 'the running scan was not replaced');
  assert.equal(ext.storage.scanState.checked, 3 * WAVE);
  assert.deepEqual(productsAskedMoreThanOnce(ext.requests), [], 'no product was asked about twice');
});

test('Resume while prices are being checked is refused', async () => {
  const skus = skuList(3 * WAVE);
  let resume;
  const ext = loadExtension({
    respond: scriptedStore().respond,
    onBroadcast: onFirst(firstWaveSaved, () => {
      resume = ext.popup.toBackground({ action: 'resumeScan' });
    }),
  });

  await startScan(ext, skus);
  await ext.idle();

  assert.deepEqual(await resume, { resumed: false, reason: 'A scan is already running' });
  assert.equal(completions(ext).length, 1);
  assert.equal(ext.storage.scanState.checked, 3 * WAVE);
  assert.deepEqual(productsAskedMoreThanOnce(ext.requests), []);
});

test('a full scan is refused while prices are being checked', async () => {
  const skus = skuList(3 * WAVE);
  let refused;
  const ext = loadExtension({
    respond: scriptedStore().respond,
    onBroadcast: onFirst(firstWaveSaved, () => { refused = ext.popup.toTab(fullScan); }),
  });

  await startScan(ext, skus);
  await ext.idle();

  assert.deepEqual(await refused, { busy: 'scan' });
  assert.equal(ext.requests.filter(isSitemapRequest).length, 0, 'no product-list request was made');
  assert.equal(completions(ext).length, 1);
  assert.equal(ext.storage.scanState.scanType, 'skuCheckOnly');
  assert.equal(ext.storage.scanState.checked, 3 * WAVE);
});

test('a full scan whose product list is ready while another scan runs does not replace that scan', async () => {
  const store = scriptedStore();
  const otherSkus = skuList(2 * WAVE);
  let otherStart;
  const ext = loadExtension({
    respond: store.respond,
    // Another scan gets in just as the full scan is about to start its price check.
    onBroadcast: onFirst(
      (message) => message.action === 'startBackgroundScan',
      () => { otherStart = startScan(ext, otherSkus); }
    ),
  });

  const discovery = await ext.popup.toTab(fullScan);
  await ext.idle();

  assert.deepEqual(await otherStart, { started: true });
  assert.equal(discovery.total, store.productCount);
  assert.equal(ext.storage.scanState.scanType, 'skuCheckOnly', 'the running scan was not replaced');
  assert.equal(ext.storage.scanState.checked, 2 * WAVE);
  assert.equal(completions(ext).length, 1);
});

// What chrome.storage.local holds when the worker was shut down in the middle
// of a scan. The worker picks such a scan back up as soon as it starts again.
function interruptedScanStorage(skus) {
  return {
    scanSkus: skus,
    scanState: {
      running: true,
      storeId: STORE,
      total: skus.length,
      currentIndex: WAVE,
      checked: WAVE,
      errors: 0,
      startTime: 1_700_000_000_000,
      scanType: 'skuCheckOnly',
      userStopped: false,
      totalClearanceSeen: 0,
      totalFilteredOut: 0,
    },
    clearanceItems: [],
  };
}

test('a scan start that wakes the worker is refused when the worker has a scan to pick back up', async () => {
  const skus = skuList(3 * WAVE);
  const ext = loadExtension({ storage: interruptedScanStorage(skus), respond: scriptedStore().respond });

  // Arrives before the worker has looked for a scan to pick back up.
  const start = await startScan(ext, skuList(WAVE), 'penny');
  await ext.idle();

  assert.deepEqual(start, { started: false, reason: 'already_running' });
  assert.equal(ext.storage.scanState.scanType, 'skuCheckOnly', 'the interrupted scan carried on');
  assert.equal(ext.storage.scanState.checked, 3 * WAVE);
  assert.equal(completions(ext).length, 1);
});

test('a worker that has just woken reports the scan it is about to pick back up as running', async () => {
  const skus = skuList(3 * WAVE);
  const ext = loadExtension({ storage: interruptedScanStorage(skus), respond: scriptedStore().respond });

  const state = await ext.popup.toBackground({ action: 'getScanState' });
  await ext.idle();

  assert.equal(state.running, true);
  assert.equal(state.total, 3 * WAVE);
});

// ---------------------------------------------------------------------------
// A full scan from start to finish, and Stop at each of its stages
// ---------------------------------------------------------------------------

test('a full scan builds the product list, re-checks an overstuffed department, and checks every price', async () => {
  const store = scriptedStore({ departmentSizes: [3, 720, 3] }); // 720 is Home Depot's cap per department
  const ext = loadExtension({ respond: store.respond });

  const discovery = await ext.popup.toTab(fullScan);
  await ext.idle();

  assert.equal(discovery.stopped, false);
  assert.equal(discovery.total, store.productCount);
  assert.equal(discovery.cappedCategories, 1);
  assert.equal(ext.broadcasts.filter((message) => message.type === 'sitemapOverflowDone').length, 1);
  assert.equal(ext.storage.scanState.scanType, 'sitemap');
  assert.equal(ext.storage.scanState.checked, store.productCount);
  assert.equal(ext.storage.scanState.errors, 0);
  assert.equal(completions(ext).length, 1);
});

test('Stop partway through the departments ends the full scan and keeps the products found so far', async () => {
  const store = scriptedStore();
  const ext = loadExtension({
    respond: (request) => {
      // Stop as the fourth department's product list is requested.
      if (isProductListRequest(request) && request.payload.variables.navParam === store.navParams[3]) {
        pressStopOnce();
      }
      return store.respond(request);
    },
  });
  const pressStopOnce = onFirst(() => true, () => ext.popup.pressStop());

  const discovery = await ext.popup.toTab(fullScan);
  await ext.idle();

  assert.equal(discovery.stopped, true);
  assert.equal(discovery.total, 12, 'three departments done, plus the one in flight');
  assert.equal(
    ext.broadcasts.filter((message) => message.action === 'startBackgroundScan').length, 0,
    'no price check was started'
  );
  assert.equal(ext.storage.skuInventoryMultiStore[STORE].skus.length, 12, 'the products found so far are saved');
});

test('Stop during the re-check of an overstuffed department ends it after the sort order in flight', async () => {
  const store = scriptedStore({ departmentSizes: [720] });
  const sortOf = (request) => `${request.payload.variables.orderBy.field} ${request.payload.variables.orderBy.order}`;
  const isRecheck = (request) => isProductListRequest(request) && sortOf(request) !== 'TOP_SELLERS ASC';
  const ext = loadExtension({
    respond: (request) => {
      if (isRecheck(request)) pressStopOnce();
      return store.respond(request);
    },
  });
  const pressStopOnce = onFirst(() => true, () => ext.popup.pressStop());

  const discovery = await ext.popup.toTab(fullScan);
  await ext.idle();

  assert.equal(discovery.stopped, true);
  const sortsUsed = new Set(ext.requests.filter(isRecheck).map(sortOf));
  assert.equal(sortsUsed.size, 1, 'only the sort order in flight finished; the other three were not started');
  assert.equal(completions(ext).length, 0, 'the price check it had started was stopped too');
});

// ---------------------------------------------------------------------------
// The popup's scan buttons
//
// The popup needs a moment after opening before it shows a running scan, and
// its buttons are live in that moment, so each button asks what is running at
// the moment it is clicked.
// ---------------------------------------------------------------------------

const refusals = (ext) => ext.popup.status.filter((line) => /^A scan is already running/.test(line));

// chrome.storage.local with a saved product list, which Quick Recheck and Penny
// Scan need.
const savedProductList = (skus) => ({
  skuInventoryMultiStore: { [STORE]: { skus, lastUpdated: 1_700_000_000_000 } },
});

// Waits, in turns of the event loop, until `condition()` is true.
async function until(condition, what) {
  const giveUpAt = Date.now() + 10000;
  while (!condition()) {
    if (Date.now() > giveUpAt) throw new Error(`gave up waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// Click Scan for Clearance and wait for the whole scan to finish.
async function runFullScanFromPopup(ext) {
  await ext.popup.clickFullScan();
  await until(() => completions(ext).length === 1, 'the full scan to finish');
  await ext.idle();
}

test('Quick Recheck and Penny Scan start normally when nothing is running', async () => {
  const skus = skuList(2 * WAVE);
  for (const [click, scanType] of [['clickQuickRecheck', 'skuCheckOnly'], ['clickPennyScan', 'penny']]) {
    const ext = loadExtension({ storage: savedProductList(skus), respond: scriptedStore().respond });

    await ext.popup[click]();
    await ext.idle();

    assert.equal(completions(ext).length, 1, `${click} ran a scan`);
    assert.equal(ext.storage.scanState.scanType, scanType);
    assert.equal(ext.storage.scanState.checked, 2 * WAVE);
    assert.deepEqual(refusals(ext), []);
    assert.deepEqual(ext.popup.errors, []);
  }
});

test('Scan for Clearance starts normally when nothing is running', async () => {
  const store = scriptedStore();
  const ext = loadExtension({ respond: store.respond });

  await runFullScanFromPopup(ext);

  assert.equal(ext.storage.scanState.scanType, 'sitemap');
  assert.equal(ext.storage.scanState.checked, store.productCount);
  assert.deepEqual(refusals(ext), []);
  assert.deepEqual(ext.popup.errors, []);
});

test('Resume still resumes a paused scan when nothing is running', async () => {
  const skus = skuList(3 * WAVE);
  const paused = interruptedScanStorage(skus);
  paused.scanState.running = false;
  paused.scanState.userStopped = true;
  const ext = loadExtension({ storage: paused, respond: scriptedStore().respond });

  await ext.popup.clickResume();
  await ext.idle();

  assert.deepEqual(refusals(ext), []);
  assert.match(ext.popup.status.at(-1), /^Resuming scan from 80/);
  assert.equal(ext.storage.scanState.checked, 3 * WAVE);
  assert.equal(completions(ext).length, 1);
});

test('every scan button and Resume do nothing while prices are being checked', async () => {
  const skus = skuList(3 * WAVE);
  const clicks = [];
  const ext = loadExtension({
    storage: savedProductList(skus),
    respond: scriptedStore().respond,
    onBroadcast: onFirst(firstWaveSaved, () => {
      clicks.push(
        ext.popup.clickQuickRecheck(),
        ext.popup.clickPennyScan(),
        ext.popup.clickFullScan(),
        ext.popup.clickResume()
      );
    }),
  });

  await startScan(ext, skus);
  await ext.idle();
  await Promise.all(clicks);

  assert.equal(refusals(ext).length, 4, 'each click was answered with "already running"');
  assert.equal(ext.popup.view.scanning, true, 'the popup switched to its scanning view');
  assert.equal(completions(ext).length, 1);
  assert.equal(ext.storage.scanState.scanType, 'skuCheckOnly', 'the running scan was not replaced');
  assert.deepEqual(productsAskedMoreThanOnce(ext.requests), []);
  assert.equal(ext.requests.filter(isSitemapRequest).length, 0, 'no product-list request was made');
});

test('the scan buttons do nothing while a full scan is building its product list', async () => {
  const cachedList = savedProductList(skuList(WAVE));
  const lone = loadExtension({ storage: cachedList, respond: scriptedStore().respond });
  await runFullScanFromPopup(lone);

  const store = scriptedStore();
  const clicks = [];
  const ext = loadExtension({
    storage: cachedList,
    respond: (request, n) => {
      // On the first product-list request, press all three scan buttons.
      if (n === 1) {
        clicks.push(ext.popup.clickFullScan(), ext.popup.clickQuickRecheck(), ext.popup.clickPennyScan());
      }
      return store.respond(request);
    },
  });
  await runFullScanFromPopup(ext);
  await Promise.all(clicks);

  assert.equal(refusals(ext).length, 3, 'each click was answered with "already running"');
  assert.equal(
    ext.requests.length, lone.requests.length,
    'Home Depot was asked no more than one full scan asks'
  );
  assert.equal(ext.storage.scanState.scanType, 'sitemap');
  assert.equal(completions(ext).length, 1);
});

test('a double click on Scan for Clearance builds one product list', async () => {
  const lone = loadExtension({ respond: scriptedStore().respond });
  await runFullScanFromPopup(lone);

  const ext = loadExtension({ respond: scriptedStore().respond });
  ext.popup.clickFullScan(); // both clicks land before either scan has started
  await runFullScanFromPopup(ext);

  assert.equal(refusals(ext).length, 1, 'the second click ended on "already running"');
  assert.equal(ext.requests.length, lone.requests.length);
  assert.equal(completions(ext).length, 1);
});

test('a double click on Quick Recheck starts one scan', async () => {
  const skus = skuList(2 * WAVE);
  const ext = loadExtension({ storage: savedProductList(skus), respond: scriptedStore().respond });

  const first = ext.popup.clickQuickRecheck(); // both clicks land before either scan has started
  await ext.popup.clickQuickRecheck();
  await first;
  await ext.idle();

  assert.equal(refusals(ext).length, 1, 'one of the two clicks ended on "already running"');
  assert.equal(completions(ext).length, 1);
  assert.equal(ext.storage.scanState.checked, 2 * WAVE);
  assert.deepEqual(productsAskedMoreThanOnce(ext.requests), []);
});

test('on opening, the popup shows a running scan at once, and nothing when none is running', async () => {
  const idle = loadExtension({ respond: scriptedStore().respond });
  assert.equal(await idle.popup.open(), null);
  assert.equal(idle.popup.view.scanning, false);
  assert.deepEqual(idle.popup.status, []);

  let openedWhilePricing;
  const pricing = loadExtension({
    respond: scriptedStore().respond,
    onBroadcast: onFirst(firstWaveSaved, () => { openedWhilePricing = pricing.popup.open(); }),
  });
  await startScan(pricing, skuList(3 * WAVE));
  await pricing.idle();
  assert.equal(await openedWhilePricing, 'scan');
  assert.equal(pricing.popup.view.scanning, true);
  assert.match(pricing.popup.status.at(-1), /^Scan running/);

  let openedWhileListing;
  const store = scriptedStore();
  const listing = loadExtension({
    respond: (request, n) => {
      if (n === 1) openedWhileListing = listing.popup.open();
      return store.respond(request);
    },
  });
  await listing.popup.toTab(fullScan);
  await listing.idle();
  assert.equal(await openedWhileListing, 'discovery');
  assert.equal(listing.popup.view.scanning, true);
  assert.match(listing.popup.status.at(-1), /building the product list/);
});

// ---------------------------------------------------------------------------
// Scans started from Telegram, and a second Home Depot tab
//
// A bot command starts its scan in the background worker with no popup
// involved, so the worker has to ask the tabs whether a full scan is building
// its product list in one of them.
// ---------------------------------------------------------------------------

const telegramSaid = (ext, pattern) => ext.telegram.texts().filter((text) => pattern.test(text));

test('a penny scan from Telegram starts normally when nothing is running', async () => {
  const skus = skuList(2 * WAVE);
  const ext = loadExtension({
    telegram: true,
    storage: savedProductList(skus),
    respond: scriptedStore().respond,
  });

  await ext.telegram.startPennyScan();
  await ext.idle();

  assert.equal(completions(ext).length, 1);
  assert.equal(ext.storage.scanState.scanType, 'telegram_penny');
  assert.equal(ext.storage.scanState.checked, 2 * WAVE);
  assert.deepEqual(telegramSaid(ext, /already running/), []);
});

test('scans from Telegram are refused while a full scan is building its product list', async () => {
  const cachedList = savedProductList(skuList(WAVE));
  const lone = loadExtension({ telegram: true, storage: cachedList, respond: scriptedStore().respond });
  await runFullScanFromPopup(lone);

  const store = scriptedStore();
  const commands = [];
  const ext = loadExtension({
    telegram: true,
    storage: cachedList,
    respond: (request, n) => {
      // On the first product-list request, send the bot three scan commands.
      if (n === 1) {
        commands.push(
          ext.telegram.startPennyScan(),
          ext.telegram.startScan({ cached: true }),
          ext.telegram.startScan({ cached: false })
        );
      }
      return store.respond(request);
    },
  });
  await runFullScanFromPopup(ext);
  await Promise.all(commands);

  assert.equal(
    telegramSaid(ext, /already running/).length, 3,
    'each command was answered with "already running"'
  );
  assert.equal(
    ext.requests.length, lone.requests.length,
    'Home Depot was asked no more than one full scan asks'
  );
  assert.equal(ext.storage.scanState.scanType, 'sitemap', 'the full scan went on to check its prices');
  assert.equal(completions(ext).length, 1);
});

test('Stop from Telegram ends a full scan that is building its product list', async () => {
  const store = scriptedStore();
  let stop;
  const ext = loadExtension({
    telegram: true,
    respond: (request) => {
      // Stop as the first department's product list is requested.
      if (isProductListRequest(request)) pressStopOnce();
      return store.respond(request);
    },
  });
  const pressStopOnce = onFirst(() => true, () => { stop = ext.telegram.pressStop(); });

  const discovery = await ext.popup.toTab(fullScan);
  await stop;
  await ext.idle();

  assert.equal(discovery.stopped, true);
  assert.equal(telegramSaid(ext, /Scan stopped/).length, 1);
  assert.deepEqual(telegramSaid(ext, /No scan is running/), []);
  assert.equal(
    ext.broadcasts.filter((message) => message.action === 'startBackgroundScan').length, 0,
    'no price check was started'
  );
});

test('Stop from Telegram still stops a price check, and says so when nothing is running', async () => {
  const idle = loadExtension({ telegram: true, respond: scriptedStore().respond });
  await idle.telegram.pressStop();
  assert.equal(telegramSaid(idle, /No scan is running/).length, 1);

  let stop;
  const ext = loadExtension({
    telegram: true,
    respond: scriptedStore().respond,
    onBroadcast: onFirst(firstWaveSaved, () => { stop = ext.telegram.pressStop(); }),
  });
  await startScan(ext, skuList(3 * WAVE));
  await ext.idle();
  await stop;

  assert.equal(ext.storage.scanState.userStopped, true);
  assert.equal(ext.storage.scanState.currentIndex, WAVE);
  assert.equal(telegramSaid(ext, /Scan stopped/).length, 1);
  assert.equal(completions(ext).length, 0);
});

test('status from Telegram says when a full scan is building its product list', async () => {
  const store = scriptedStore();
  let status;
  const ext = loadExtension({
    telegram: true,
    respond: (request, n) => {
      if (n === 1) status = ext.telegram.showStatus();
      return store.respond(request);
    },
  });

  await ext.popup.toTab(fullScan);
  await status;
  await ext.idle();

  assert.equal(telegramSaid(ext, /building its product list/).length, 1);
  assert.deepEqual(telegramSaid(ext, /NO SCAN RUNNING/), []);
});

test('with two Home Depot tabs open, nothing starts while the other tab builds a product list', async () => {
  const store = scriptedStore();
  const attempts = [];
  const ext = loadExtension({
    telegram: true,
    tabCount: 2,
    storage: savedProductList(skuList(WAVE)),
    respond: (request, n) => {
      // The full scan runs in tab 2. On its first request, try to start scans
      // from the popup, which is on tab 1, and from Telegram.
      if (n === 1) {
        attempts.push(
          ext.popup.clickQuickRecheck(),
          ext.popup.clickFullScan(),
          ext.telegram.startPennyScan()
        );
      }
      return store.respond(request);
    },
  });

  const discovery = await ext.popup.toTab(fullScan, 2);
  await until(() => completions(ext).length === 1, 'the full scan to finish');
  await ext.idle();
  await Promise.all(attempts);

  assert.equal(refusals(ext).length, 2, 'both popup clicks were answered with "already running"');
  assert.equal(telegramSaid(ext, /already running/).length, 1);
  assert.equal(discovery.stopped, false);
  assert.equal(
    ext.requests.filter((request) => request.url === SITEMAP_URL).length, 1,
    'only one product list was built'
  );
  assert.equal(ext.storage.scanState.scanType, 'sitemap');
});

// ---------------------------------------------------------------------------
// The bot while its own full scan builds the product list
//
// The bot reads its commands one at a time. It used to wait for a full scan's
// whole product-list stage before reading the next one, so for all that time
// it answered nothing, Stop included. These tests send commands through the
// bot's real polling loop.
// ---------------------------------------------------------------------------

test('a full scan started from Telegram builds the product list and checks every price', async () => {
  const store = scriptedStore();
  const ext = loadExtension({ telegram: true, respond: store.respond });

  ext.telegram.tap(`scan:${STORE}`);
  await until(() => completions(ext).length === 1, 'the full scan to finish');
  await ext.idle();

  assert.equal(ext.storage.scanState.scanType, 'telegram_full');
  assert.equal(ext.storage.scanState.checked, store.productCount);
  assert.equal(ext.storage.scanState.errors, 0);
});

test('the bot answers status while its own full scan builds the product list', async () => {
  const store = scriptedStore();
  const ext = loadExtension({
    telegram: true,
    respond: (request, n) => {
      // On the first product-list request, ask the bot for its status.
      if (n === 1) ext.telegram.say('/status');
      return store.respond(request);
    },
  });

  ext.telegram.tap(`scan:${STORE}`);
  await until(() => completions(ext).length === 1, 'the full scan to finish');
  await ext.idle();

  assert.equal(
    telegramSaid(ext, /building its product list/).length, 1,
    'status was answered during the product-list stage'
  );
  assert.equal(ext.storage.scanState.scanType, 'telegram_full');
  assert.equal(ext.storage.scanState.checked, store.productCount);
});

test('Stop from Telegram ends the bot\'s own full scan while it builds the product list', async () => {
  const store = scriptedStore();
  const ext = loadExtension({
    telegram: true,
    respond: (request) => {
      // Send Stop as the first department's product list is requested.
      if (isProductListRequest(request)) sendStopOnce();
      return store.respond(request);
    },
  });
  const sendStopOnce = onFirst(() => true, () => ext.telegram.say('/stop'));

  ext.telegram.tap(`scan:${STORE}`);
  await until(() => telegramSaid(ext, /SCAN STOPPED/).length === 1, 'the bot to report the stopped scan');
  await ext.idle();

  assert.equal(telegramSaid(ext, /Scan stopped/).length, 1, 'the Stop command was answered');
  assert.equal(ext.storage.scanState, undefined, 'no price check was started');
  assert.equal(completions(ext).length, 0);
  assert.ok(
    ext.storage.skuInventoryMultiStore[STORE].skus.length > 0,
    'the products found so far are saved'
  );
});
