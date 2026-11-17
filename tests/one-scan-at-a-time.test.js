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
