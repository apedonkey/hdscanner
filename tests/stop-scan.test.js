'use strict';
// Stop-button tests.
//
// Pressing Stop in the popup used to set a flag inside the Home Depot tab that
// only a full "Scan for Clearance" ever cleared. Every later Resume, Quick
// Recheck and Penny Scan in that tab then skipped its products without asking
// Home Depot anything, counted them all as errors, and ended with "Scan
// complete - 0 found". These tests press Stop and check that the scans which
// follow still do their work, and that a wave cut short by Stop is checked
// again on Resume instead of being skipped.
//
// Run from the extension folder:  node --test

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadContentScript, loadExtension } = require('./harness.js');

const STORE = '2580';
const WAVE = 80; // products the background worker hands the tab per wave
const GRAPHQL_RESPONSE_JSON = 'application/graphql-response+json; charset=UTF-8';

const json = (body) => ({ status: 200, contentType: GRAPHQL_RESPONSE_JSON, body });
const serverError = () => ({ status: 500, contentType: 'text/html', body: undefined });

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
// A scripted Home Depot
// ---------------------------------------------------------------------------

const clearancePricing = () => ({
  value: 49.97,
  original: 49.97,
  clearance: { value: 12.03, dollarOff: 37.94, percentageOff: 76 },
});
const regularPricing = () => ({ value: 19.98, original: 19.98, clearance: null });

// Pickup that is offered but not fulfillable, with stock at the store: what the
// scan treats as an advertised (yellow-tag) clearance item.
const pickupBlockedAtStore = () => ([{
  type: 'pickup',
  fulfillable: false,
  services: [{
    type: 'bopis',
    locations: [{ locationId: STORE, storeName: 'Test Store', inventory: { quantity: 3, isInStock: true } }],
  }],
}]);

const identifiers = (sku) => ({
  productLabel: `Product ${sku}`,
  brandName: 'Test brand',
  canonicalUrl: `/p/product/${sku}`,
  modelNumber: `M-${sku}`,
  storeSkuNumber: `S${sku}`,
});

// One product as the light price check returns it.
const lightProduct = (sku, onClearance) => ({
  itemId: sku,
  pricing: onClearance ? clearancePricing() : regularPricing(),
  fulfillment: { fulfillmentOptions: onClearance ? pickupBlockedAtStore() : [] },
});

// One product as the full product query returns it (the details pass).
const detailProduct = (sku, onClearance) => ({
  itemId: sku,
  identifiers: identifiers(sku),
  pricing: onClearance ? clearancePricing() : regularPricing(),
  fulfillment: {
    anchorStoreStatusType: onClearance ? 'CLEARANCE' : 'ACTIVE',
    fulfillmentOptions: onClearance ? pickupBlockedAtStore() : [],
  },
  availabilityType: { buyable: true, discontinued: false, status: true, type: 'Shared' },
});

// One product as the penny check returns it. A penny is on clearance at the
// store, has no pickup option and no clearance price, and can still be delivered.
const pennyProduct = (sku, isPenny) => ({
  itemId: sku,
  identifiers: identifiers(sku),
  pricing: regularPricing(),
  fulfillment: isPenny
    ? { anchorStoreStatusType: 'CLEARANCE', fulfillmentOptions: [{ type: 'delivery', fulfillable: true, services: [] }] }
    : { anchorStoreStatusType: 'ACTIVE', fulfillmentOptions: [{ type: 'pickup', fulfillable: true, services: [] }] },
  availabilityType: { buyable: !isPenny, discontinued: isPenny, type: 'Shared' },
});

const AISLE = 'Aisle 12, Bay 004';

// Answers every request a scan makes. `clearance` and `pennies` list the product
// numbers that come back as finds. `onRequest` runs before each answer, which is
// where a test presses Stop at a chosen moment. Requests it does not recognise
// are answered 404 and collected in `unexpected`.
function scriptedHomeDepot({ clearance = [], pennies = [], onRequest = () => {} } = {}) {
  const clearanceSkus = new Set(clearance);
  const pennySkus = new Set(pennies);
  const unexpected = [];

  function respond(request) {
    onRequest(request);
    const { operationName, variables, query } = request.payload || {};

    if (operationName === 'mediaPriceInventory') {
      const pennyCheck = query.includes('anchorStoreStatusType');
      return json({
        data: {
          products: variables.itemIds.map((sku) => (
            pennyCheck ? pennyProduct(sku, pennySkus.has(sku)) : lightProduct(sku, clearanceSkus.has(sku))
          )),
        },
      });
    }
    if (operationName === 'productClientOnlyProduct') {
      const sku = variables.itemId;
      return json({ data: { product: detailProduct(sku, clearanceSkus.has(sku)) } });
    }
    if (operationName === 'aislebay') {
      return json({
        data: {
          aislebay: {
            storeSkus: variables.storeSkuIds.map((storeSkuId) => ({
              storeNumber: STORE,
              storeSkuId,
              aisleBayInfo: { aisle: '12', bay: '004', invLocDesc: AISLE, invLocDescFriendly: AISLE },
            })),
          },
        },
      });
    }
    unexpected.push(operationName || request.url);
    return { status: 404 };
  }

  respond.unexpected = unexpected;
  return respond;
}

const asksAbout = (request, sku) => (request.payload?.variables?.itemIds || []).includes(sku);

// ---------------------------------------------------------------------------
// The tab on its own: a Stop must not outlive the work it stopped
// ---------------------------------------------------------------------------

test('after a Stop, the next price-check batch still checks its products', async () => {
  const [sku] = skuList(1);
  const page = loadContentScript({ respond: scriptedHomeDepot({ clearance: [sku] }) });
  await page.send({ action: 'stopScan' });

  const response = await page.send({ action: 'checkSkuBatchLight', skus: [sku], storeId: STORE });

  assert.equal(page.requests.length, 1, 'Home Depot was asked about the product');
  assert.equal(response.stopped, false);
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].clearance.clearancePrice, 12.03);
});

test('after a Stop, the next penny batch still checks its products', async () => {
  const [sku] = skuList(1);
  const page = loadContentScript({ respond: scriptedHomeDepot({ pennies: [sku] }) });
  await page.send({ action: 'stopScan' });

  const response = await page.send({ action: 'checkPennyBatch', skus: [sku], storeId: STORE });

  assert.equal(page.requests.length, 1, 'Home Depot was asked about the product');
  assert.equal(response.stopped, false);
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].pennySignal, true);
});

test('after a Stop, the next product-details batch still looks up its products', async () => {
  const skus = skuList(2);
  const page = loadContentScript({ respond: scriptedHomeDepot({ clearance: skus }) });
  await page.send({ action: 'stopScan' });

  const response = await page.send({ action: 'getProductDetailsBatch', skus, storeId: STORE });

  assert.equal(page.requests.length, 2, 'Home Depot was asked about both products');
  assert.equal(response.stopped, false);
  assert.deepEqual(response.results.map((result) => result.clearance.itemId), skus);
});

test('after a Stop, the single-request batch check still falls back to one lookup per product', async () => {
  const skus = skuList(2);
  const homeDepot = scriptedHomeDepot({ clearance: skus });
  const page = loadContentScript({
    // The batch request fails, which sends the check down its one-by-one fallback.
    respond: (request) => (
      request.payload?.operationName === 'batchProducts' ? serverError() : homeDepot(request)
    ),
  });
  await page.send({ action: 'stopScan' });

  const response = await page.send({ action: 'checkSkuBatchFast', skus, storeId: STORE });

  assert.equal(response.results.length, 2, 'both products were looked up');
  assert.deepEqual(response.results.map((result) => result.clearance.itemId), skus);
});

test('a Stop during a product-details batch ends that batch early, and only that batch', async () => {
  const skus = skuList(8);
  let lookups = 0;
  const page = loadContentScript({
    respond: scriptedHomeDepot({
      clearance: skus,
      // Stop arrives while the third lookup is in flight.
      onRequest: () => {
        lookups += 1;
        if (lookups === 3) page.send({ action: 'stopScan' });
      },
    }),
  });

  const cutShort = await page.send({ action: 'getProductDetailsBatch', skus, storeId: STORE });
  assert.equal(cutShort.stopped, true);
  assert.equal(cutShort.results.length, 3, 'the lookup in flight finishes; the rest are not started');

  const next = await page.send({ action: 'getProductDetailsBatch', skus: skus.slice(3), storeId: STORE });
  assert.equal(next.stopped, false);
  assert.equal(next.results.length, 5, 'the batch after the Stop runs in full');
});

test('a Stop during a large price-check batch ends it between waves, and only that batch', async () => {
  const skus = skuList(200); // 13 requests of up to 16 products, sent 5 at a time
  const page = loadContentScript({
    respond: scriptedHomeDepot({
      // Stop arrives as the very first request goes out.
      onRequest: onFirst(() => true, () => page.send({ action: 'stopScan' })),
    }),
  });

  const cutShort = await page.send({ action: 'checkSkuBatchLight', skus, storeId: STORE });
  assert.equal(cutShort.stopped, true);
  assert.equal(page.requests.length, 5, 'the five requests already sent finish; no more are sent');
  assert.equal(cutShort.results.length, 80);

  const next = await page.send({ action: 'checkSkuBatchLight', skus: skus.slice(80), storeId: STORE });
  assert.equal(next.stopped, false);
  assert.equal(next.results.length, 120, 'the batch after the Stop runs in full');
});

test('Stop still ends a discovery in progress, and the next discovery is not affected', async () => {
  // Every sitemap address answers 404, so a discovery finds nothing: it tries
  // the entry points, then a long list of fallback addresses.
  let stopOnRequest = 1;
  const page = loadContentScript({
    respond: (_request, n) => {
      if (n === stopOnRequest) page.send({ action: 'stopScan' });
      return { status: 404 };
    },
  });

  const stopped = await page.send({ action: 'getStoreSkusSitemap', storeId: STORE });
  const requestsWhenStopped = page.requests.length;
  assert.equal(stopped.stopped, true);

  stopOnRequest = 0; // never
  const full = await page.send({ action: 'getStoreSkusSitemap', storeId: STORE });
  const requestsInFullRun = page.requests.length - requestsWhenStopped;
  assert.equal(full.stopped, false);
  assert.ok(
    requestsInFullRun > requestsWhenStopped,
    `the second discovery ran on past where the first was stopped (${requestsInFullRun} vs ${requestsWhenStopped} requests)`
  );
});

// ---------------------------------------------------------------------------
// The whole extension: background worker and tab together, driven like the popup
// ---------------------------------------------------------------------------

const startScan = (ext, skus, scanType = 'skuCheckOnly') => (
  ext.popup.toBackground({ action: 'startBackgroundScan', skus, storeId: STORE, scanType })
);
const resumeScan = (ext) => ext.popup.toBackground({ action: 'resumeScan' });
const completions = (ext) => ext.broadcasts.filter((message) => message.type === 'scanComplete');
const foundSkus = (ext) => (ext.storage.clearanceItems || []).map((item) => item.itemId);
const firstWaveSaved = (message) => message.type === 'scanProgress' && message.checked === WAVE;

// The scan reached every product, counted none as an error, and said so once.
function assertScanFinished(ext, { checked, found }) {
  const state = ext.storage.scanState;
  assert.equal(state.currentIndex, checked, 'every product was reached');
  assert.equal(state.checked, checked);
  assert.equal(state.errors, 0, 'no product was counted as an error');
  assert.deepEqual(foundSkus(ext), found);
  const done = completions(ext);
  assert.equal(done.length, 1, 'the scan reported completion once');
  assert.equal(done[0].found, found.length);
  assert.equal(done[0].checked, checked);
}

test('a scan that is never stopped checks every product and reports its find', async () => {
  const skus = skuList(3 * WAVE);
  const deal = skus[WAVE + 20];
  const homeDepot = scriptedHomeDepot({ clearance: [deal] });
  const ext = loadExtension({ respond: homeDepot });

  await startScan(ext, skus);
  await ext.idle();

  assertScanFinished(ext, { checked: 3 * WAVE, found: [deal] });
  assert.equal(ext.storage.clearanceItems[0].location, AISLE);
  assert.deepEqual(homeDepot.unexpected, []);
});

test('Stop between waves, then Resume: the rest of the products are checked', async () => {
  const skus = skuList(3 * WAVE);
  const deal = skus[2 * WAVE + 40]; // in the third wave
  const homeDepot = scriptedHomeDepot({ clearance: [deal] });
  const ext = loadExtension({
    respond: homeDepot,
    onBroadcast: onFirst(firstWaveSaved, () => ext.popup.pressStop()),
  });

  await startScan(ext, skus);
  await ext.idle();
  assert.equal(ext.storage.scanState.userStopped, true);
  assert.equal(ext.storage.scanState.currentIndex, WAVE, 'paused after the first wave');
  const requestsBeforeResume = ext.requests.length;

  assert.deepEqual(await resumeScan(ext), { resumed: true, from: WAVE });
  await ext.idle();

  assert.ok(
    ext.requests.length > requestsBeforeResume,
    'the resumed scan asked Home Depot about products'
  );
  assertScanFinished(ext, { checked: 3 * WAVE, found: [deal] });
  assert.deepEqual(homeDepot.unexpected, []);
});

test('Stop, then a Penny Scan: products are checked and the penny is found', async () => {
  const skus = skuList(2 * WAVE);
  const penny = skus[WAVE + 10];
  const homeDepot = scriptedHomeDepot({ pennies: [penny] });
  const ext = loadExtension({
    respond: homeDepot,
    onBroadcast: onFirst(firstWaveSaved, () => ext.popup.pressStop()),
  });

  await startScan(ext, skus); // an ordinary recheck, stopped after its first wave
  await ext.idle();
  assert.equal(ext.storage.scanState.userStopped, true);

  await startScan(ext, skus, 'penny');
  await ext.idle();

  assertScanFinished(ext, { checked: 2 * WAVE, found: [penny] });
  assert.equal(ext.storage.clearanceItems[0].location, AISLE);
  assert.deepEqual(homeDepot.unexpected, []);
});

test('Stop while a wave is in flight: Resume checks that wave again instead of skipping it', async () => {
  const skus = skuList(3 * WAVE);
  const deal = skus[WAVE + 20]; // in the second wave
  const homeDepot = scriptedHomeDepot({
    clearance: [deal],
    // Stop as the second wave's first price request goes out.
    onRequest: onFirst((request) => asksAbout(request, skus[WAVE]), () => ext.popup.pressStop()),
  });
  const ext = loadExtension({ respond: homeDepot });

  await startScan(ext, skus);
  await ext.idle();
  const paused = ext.storage.scanState;
  assert.equal(paused.userStopped, true);
  assert.equal(paused.currentIndex, WAVE, 'the interrupted wave is not counted as done');
  assert.equal(paused.checked, WAVE);
  assert.equal(paused.errors, 0);
  assert.equal(completions(ext).length, 0, 'a stopped scan is not reported as finished');

  await resumeScan(ext);
  await ext.idle();

  assertScanFinished(ext, { checked: 3 * WAVE, found: [deal] });
  assert.deepEqual(homeDepot.unexpected, []);
});

test('Stop, then Resume straight away while the stopped wave is still in flight', async () => {
  const skus = skuList(3 * WAVE);
  const deal = skus[WAVE + 20]; // in the second wave
  let resumed;
  const homeDepot = scriptedHomeDepot({
    clearance: [deal],
    // Stop as the second wave goes out, and Resume without waiting for it to end.
    onRequest: onFirst((request) => asksAbout(request, skus[WAVE]), () => {
      ext.popup.pressStop();
      resumed = resumeScan(ext);
    }),
  });
  const ext = loadExtension({ respond: homeDepot });

  await startScan(ext, skus);
  await ext.idle();

  assert.deepEqual(await resumed, { resumed: true, from: WAVE });
  assertScanFinished(ext, { checked: 3 * WAVE, found: [deal] });
  assert.deepEqual(homeDepot.unexpected, []);
});

test('a Stop that only the tab hears still pauses the scan and keeps its place', async () => {
  const skus = skuList(3 * WAVE);
  const deal = skus[WAVE + 20]; // in the second wave
  const homeDepot = scriptedHomeDepot({
    clearance: [deal],
    // The tab gets the Stop as the second wave goes out; the worker is not told.
    onRequest: onFirst(
      (request) => asksAbout(request, skus[WAVE]),
      () => ext.popup.toTab({ action: 'stopScan' })
    ),
  });
  const ext = loadExtension({ respond: homeDepot });

  await startScan(ext, skus);
  await ext.idle();
  const paused = ext.storage.scanState;
  assert.equal(completions(ext).length, 0, 'the scan is not reported as finished');
  assert.equal(paused.running, false);
  assert.equal(paused.userStopped, true);
  assert.equal(paused.currentIndex, WAVE, 'the interrupted wave is not counted as done');

  await resumeScan(ext);
  await ext.idle();

  assertScanFinished(ext, { checked: 3 * WAVE, found: [deal] });
  assert.deepEqual(homeDepot.unexpected, []);
});

test('Stop during the details pass: finds already looked up are kept, the rest come on Resume, none twice', async () => {
  const skus = skuList(3 * WAVE);
  const deals = skus.slice(WAVE, WAVE + 8); // eight deals at the start of the second wave
  let lookups = 0;
  const homeDepot = scriptedHomeDepot({
    clearance: deals,
    // Stop while the third product-details lookup is in flight.
    onRequest: (request) => {
      if (request.payload?.operationName !== 'productClientOnlyProduct') return;
      lookups += 1;
      if (lookups === 3) ext.popup.pressStop();
    },
  });
  const ext = loadExtension({ respond: homeDepot });

  await startScan(ext, skus);
  await ext.idle();
  assert.equal(ext.storage.scanState.currentIndex, WAVE, 'the interrupted wave is not counted as done');
  assert.deepEqual(foundSkus(ext), deals.slice(0, 3), 'the three finds already looked up are kept');

  await resumeScan(ext);
  await ext.idle();

  assertScanFinished(ext, { checked: 3 * WAVE, found: deals });
  assert.deepEqual(homeDepot.unexpected, []);
});

test('Stop before the first wave goes out: nothing is asked or counted, and Resume starts from the top', async () => {
  const skus = skuList(2 * WAVE);
  const deal = skus[5];
  const homeDepot = scriptedHomeDepot({ clearance: [deal] });
  const ext = loadExtension({ respond: homeDepot });

  const started = startScan(ext, skus);
  ext.popup.pressStop(); // the worker is still looking for the Home Depot tab
  await started;
  await ext.idle();
  assert.equal(ext.requests.length, 0, 'no product was asked about after the Stop');
  assert.equal(ext.storage.scanState.userStopped, true);
  assert.equal(ext.storage.scanState.currentIndex, 0);
  assert.equal(ext.storage.scanState.checked, 0);

  await resumeScan(ext);
  await ext.idle();

  assertScanFinished(ext, { checked: 2 * WAVE, found: [deal] });
  assert.deepEqual(homeDepot.unexpected, []);
});

test('unchanged: a wave Home Depot fails outright is counted as errors and passed over', async () => {
  const skus = skuList(3 * WAVE);
  const failing = new Set(skus.slice(WAVE, 2 * WAVE)); // the whole second wave
  const homeDepot = scriptedHomeDepot();
  const ext = loadExtension({
    respond: (request) => (
      (request.payload?.variables?.itemIds || []).some((sku) => failing.has(sku))
        ? serverError()
        : homeDepot(request)
    ),
  });

  await startScan(ext, skus);
  await ext.idle();

  const state = ext.storage.scanState;
  assert.equal(state.checked, 3 * WAVE);
  assert.equal(state.errors, WAVE);
  assert.equal(state.currentIndex, 3 * WAVE);
  assert.equal(completions(ext).length, 1);
});

// ---------------------------------------------------------------------------
// Stop when nothing is being price-checked
//
// Stop is also pressed while a full scan is still building its product list,
// which happens in the tab. The worker's own scan state is then the last
// scan's, or empty if the worker has restarted since. Saving that state on Stop
// used to overwrite the saved results and the resume point with it.
// ---------------------------------------------------------------------------

// chrome.storage.local as a scan paused at 160 of 240 leaves it, with one find.
function pausedScanStorage(skus, stateOverrides = {}) {
  return {
    scanSkus: skus,
    scanState: {
      running: false,
      storeId: STORE,
      total: skus.length,
      currentIndex: 2 * WAVE,
      checked: 2 * WAVE,
      errors: 0,
      startTime: 1_700_000_000_000,
      scanType: 'skuCheckOnly',
      userStopped: true,
      totalClearanceSeen: 1,
      totalFilteredOut: 0,
      ...stateOverrides,
    },
    clearanceItems: [
      { itemId: skus[10], name: `Product ${skus[10]}`, clearancePrice: 12.03, location: AISLE },
    ],
  };
}

test('Stop while a new scan builds its product list leaves the paused scan and its finds alone', async () => {
  const skus = skuList(3 * WAVE);
  const deal = skus[2 * WAVE + 40]; // in the part of the paused scan still to do
  const saved = pausedScanStorage(skus);
  const homeDepot = scriptedHomeDepot({ clearance: [deal] });
  const pressStopOnce = onFirst(() => true, () => ext.popup.pressStop());
  const ext = loadExtension({
    storage: saved,
    // Product-list requests (plain GETs for sitemaps) answer 404, and Stop is
    // pressed on the first of them.
    respond: (request) => {
      if (request.payload) return homeDepot(request);
      pressStopOnce();
      return { status: 404 };
    },
  });

  const discovery = await ext.popup.toTab({ action: 'getStoreSkusSitemap', storeId: STORE });
  await ext.idle();

  assert.equal(discovery.stopped, true);
  assert.deepEqual(ext.storage.scanState, saved.scanState, 'the paused scan is untouched');
  assert.deepEqual(ext.storage.clearanceItems, saved.clearanceItems, 'its finds are untouched');
  assert.equal(ext.popup.status.at(-1), 'Scan stopped.');

  assert.deepEqual(await resumeScan(ext), { resumed: true, from: 2 * WAVE });
  await ext.idle();

  assertScanFinished(ext, { checked: 3 * WAVE, found: [skus[10], deal] });
  assert.deepEqual(homeDepot.unexpected, []);
});

test('Stop after a scan has finished changes nothing that was saved', async () => {
  const skus = skuList(WAVE);
  const deal = skus[7];
  const ext = loadExtension({ respond: scriptedHomeDepot({ clearance: [deal] }) });
  await startScan(ext, skus);
  await ext.idle();
  const savedState = ext.storage.scanState;
  const savedItems = ext.storage.clearanceItems;

  ext.popup.pressStop();
  await ext.idle();

  assert.deepEqual(ext.storage.scanState, savedState);
  assert.equal(ext.storage.scanState.userStopped, false, 'a finished scan is not relabelled as stopped');
  assert.deepEqual(ext.storage.clearanceItems, savedItems);
  assert.equal(ext.popup.status.at(-1), 'Scan stopped.');
});

test('Stop that wakes the worker stops the scan the worker was about to pick back up', async () => {
  const skus = skuList(3 * WAVE);
  const deal = skus[2 * WAVE + 40];
  // What storage holds when the worker was shut down in the middle of a scan.
  const saved = pausedScanStorage(skus, {
    running: true,
    userStopped: false,
    currentIndex: WAVE,
    checked: WAVE,
  });
  const homeDepot = scriptedHomeDepot({ clearance: [deal] });
  const ext = loadExtension({ storage: saved, respond: homeDepot });

  ext.popup.pressStop(); // arrives before the worker has looked for a scan to resume
  await ext.idle();

  assert.equal(ext.requests.length, 0, 'no product was asked about after the Stop');
  const paused = ext.storage.scanState;
  assert.equal(paused.running, false);
  assert.equal(paused.userStopped, true);
  assert.equal(paused.currentIndex, WAVE, 'the scan keeps its place');
  assert.deepEqual(ext.storage.clearanceItems, saved.clearanceItems, 'its finds are kept');
  assert.match(ext.popup.status.at(-1), /^Scan paused/);

  await resumeScan(ext);
  await ext.idle();

  assertScanFinished(ext, { checked: 3 * WAVE, found: [skus[10], deal] });
  assert.deepEqual(homeDepot.unexpected, []);
});
