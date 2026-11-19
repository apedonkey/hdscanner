'use strict';
// API-compatibility tests: how the extension copes with what Home Depot's
// GraphQL gateway actually sends. Background: issue #2 on apedonkey/hdscanner.
//
// Run from the extension folder:  node --test

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  readSource,
  loadContentScript,
  sharedHelperBlock,
  loadPopupHelpers,
  runPopupApiTest,
} = require('./harness.js');

const STORE = '2580';
const SKU = '100001';

// The content-type header quoted in issue #2 (2026-11-14).
const GRAPHQL_RESPONSE_JSON = 'application/graphql-response+json; charset=UTF-8';

// Home Depot's throttle body, reported in issue #2 with HTTP 206.
const GENERIC_ERRORS = {
  data: { 'Generic Errors API': null },
  error: [{ message: 'Generic Errors API errors' }],
};

// One clearance product, shaped as the light price check (mediaPriceInventory) gets it.
const LIGHT_PRODUCTS = {
  data: {
    products: [{
      itemId: SKU,
      pricing: {
        value: 49.97,
        original: 49.97,
        clearance: { value: 12.03, dollarOff: 37.94, percentageOff: 76 },
      },
      fulfillment: {
        fulfillmentOptions: [{
          type: 'pickup',
          fulfillable: false,
          services: [{
            type: 'bopis',
            locations: [{ locationId: STORE, inventory: { quantity: 3, isInStock: true } }],
          }],
        }],
      },
    }],
  },
};

const ok = (contentType = GRAPHQL_RESPONSE_JSON) => ({ status: 200, contentType, body: LIGHT_PRODUCTS });
const throttled = () => ({ status: 206, contentType: GRAPHQL_RESPONSE_JSON, body: GENERIC_ERRORS });

// Run the light price check for one SKU against a scripted Home Depot.
async function lightCheck(respond) {
  const page = loadContentScript({ respond });
  const response = await page.send({ action: 'checkSkuBatchLight', skus: [SKU], storeId: STORE });
  return { response, result: response.results[0], page };
}

// Backoff waits only: drops the 20-second request-timeout timers.
const backoffs = (page) => page.waits.filter((ms) => ms >= 10000 && ms !== 20000);

function assertFoundClearance(result) {
  assert.equal(result.error, false);
  assert.ok(result.clearance, 'expected clearance data for the SKU');
  assert.equal(result.clearance.clearancePrice, 12.03);
}

// ---------------------------------------------------------------------------
// Response media type
// ---------------------------------------------------------------------------

test('accepts the application/graphql-response+json media type Home Depot now sends', async () => {
  const { result, page } = await lightCheck(() => ok());
  assertFoundClearance(result);
  assert.equal(page.requests.length, 1);
});

test('still accepts plain application/json', async () => {
  const { result, page } = await lightCheck(() => ok('application/json'));
  assertFoundClearance(result);
  assert.equal(page.requests.length, 1);
});

test('rejects an HTML block page served with HTTP 200', async () => {
  const { result, page } = await lightCheck(() => ({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: undefined,
  }));
  assert.equal(result.error, true);
  assert.equal(page.requests.length, 1);
});

test('penny check accepts the new media type too', async () => {
  const page = loadContentScript({
    respond: () => ({
      status: 200,
      contentType: GRAPHQL_RESPONSE_JSON,
      body: {
        data: {
          products: [{
            itemId: SKU,
            identifiers: {
              productLabel: 'Test item',
              brandName: 'Test brand',
              canonicalUrl: '/p/test-item/100001',
              storeSkuNumber: '123456',
            },
            pricing: { value: 19.98, original: 19.98, clearance: null },
            fulfillment: {
              anchorStoreStatusType: 'CLEARANCE',
              fulfillmentOptions: [{ type: 'delivery', fulfillable: true, services: [] }],
            },
            availabilityType: { buyable: false, discontinued: true, type: 'Online' },
          }],
        },
      },
    }),
  });
  const response = await page.send({ action: 'checkPennyBatch', skus: [SKU], storeId: STORE });
  assert.equal(response.results[0].error, false);
  assert.equal(response.results[0].pennySignal, true);
  assert.equal(page.requests.length, 1);
});

// ---------------------------------------------------------------------------
// Throttling
// ---------------------------------------------------------------------------

test('HTTP 206 "Generic Errors" throttle: backs off, retries, then recovers', async () => {
  const { response, result, page } = await lightCheck((_request, n) => (n === 1 ? throttled() : ok()));
  assertFoundClearance(result);
  assert.equal(page.requests.length, 2);
  assert.equal(response.rateLimitHits, 1);
  const waits = backoffs(page);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 10000 && waits[0] < 15000, `first backoff was ${waits[0]} ms`);
});

test('HTTP 206 throttle that never clears: gives up after 3 retries and reports an error', async () => {
  const { response, result, page } = await lightCheck(() => throttled());
  assert.equal(result.error, true);
  assert.equal(page.requests.length, 4);
  assert.equal(response.rateLimitHits, 4);
  const waits = backoffs(page);
  assert.equal(waits.length, 3);
  assert.ok(waits[0] >= 10000 && waits[0] < 15000, `1st backoff was ${waits[0]} ms`);
  assert.ok(waits[1] >= 30000 && waits[1] < 35000, `2nd backoff was ${waits[1]} ms`);
  assert.ok(waits[2] >= 90000 && waits[2] < 95000, `3rd backoff was ${waits[2]} ms`);
});

test('HTTP 206 with a non-JSON body is treated as a throttle', async () => {
  const { result, page } = await lightCheck((_request, n) => (
    n === 1 ? { status: 206, contentType: 'text/html', body: undefined } : ok()
  ));
  assertFoundClearance(result);
  assert.equal(page.requests.length, 2);
});

test('HTTP 206 with JSON but no data is treated as a throttle', async () => {
  const { result, page } = await lightCheck((_request, n) => (
    n === 1
      ? { status: 206, contentType: GRAPHQL_RESPONSE_JSON, body: { data: { products: null } } }
      : ok()
  ));
  assertFoundClearance(result);
  assert.equal(page.requests.length, 2);
});

test('HTTP 403 block: same backoff and retry path as before', async () => {
  const { response, result, page } = await lightCheck(() => ({
    status: 403,
    contentType: 'text/html',
    body: undefined,
  }));
  assert.equal(result.error, true);
  assert.equal(page.requests.length, 4);
  assert.equal(response.rateLimitHits, 4);
  assert.equal(backoffs(page).length, 3);
});

test('HTTP 500 is reported as an error straight away, with no retry', async () => {
  const { response, result, page } = await lightCheck(() => ({
    status: 500,
    contentType: 'text/html',
    body: undefined,
  }));
  assert.equal(result.error, true);
  assert.equal(page.requests.length, 1);
  assert.equal(response.rateLimitHits, 0);
  assert.equal(backoffs(page).length, 0);
});

// ---------------------------------------------------------------------------
// A 206 that carries data
//
// 206 means "partial content". Whether Home Depot ever sends one with real data
// alongside errors is not known, so the rule is: a response that carries data
// is never thrown away, whatever its status.
// ---------------------------------------------------------------------------

test('HTTP 206 that carries product data is used, not retried or dropped', async () => {
  const { response, result, page } = await lightCheck(() => ({
    status: 206,
    contentType: GRAPHQL_RESPONSE_JSON,
    body: { ...LIGHT_PRODUCTS, errors: [{ message: 'Some products could not be resolved' }] },
  }));
  assertFoundClearance(result);
  assert.equal(page.requests.length, 1);
  assert.equal(response.rateLimitHits, 0);
  assert.equal(backoffs(page).length, 0);
});

test('HTTP 206 with one product and a benign error still returns the product', async () => {
  const page = loadContentScript({
    respond: () => ({
      status: 206,
      contentType: GRAPHQL_RESPONSE_JSON,
      body: {
        data: {
          product: {
            itemId: SKU,
            identifiers: {
              productLabel: 'Test item',
              brandName: 'Test brand',
              canonicalUrl: '/p/test-item/100001',
              modelNumber: 'M-1',
              storeSkuNumber: '123456',
            },
            pricing: { value: 19.98, original: 19.98, clearance: null },
            fulfillment: { anchorStoreStatusType: 'ACTIVE', fulfillmentOptions: [] },
            availabilityType: { buyable: true, discontinued: false, status: true, type: 'Shared' },
          },
        },
        errors: [{ message: 'online status is false' }],
      },
    }),
  });
  const response = await page.send({ action: 'getProductDetailsBatch', skus: [SKU], storeId: STORE });
  assert.equal(response.results[0].error, false);
  assert.equal(response.results[0].identifiers.name, 'Test item');
  assert.equal(page.requests.length, 1);
});

// ---------------------------------------------------------------------------
// Helpers shared by content.js and popup.js
// ---------------------------------------------------------------------------

test('content.js and popup.js carry identical copies of the shared helpers', () => {
  const inContent = sharedHelperBlock('content.js');
  assert.equal(inContent, sharedHelperBlock('popup.js'));
  assert.match(inContent, /function isJsonContentType\(/);
  assert.match(inContent, /function hasUsableData\(/);
});

test('isJsonContentType accepts JSON and +json media types only', () => {
  const { isJsonContentType } = loadPopupHelpers();
  const cases = [
    [GRAPHQL_RESPONSE_JSON, true],
    ['application/graphql-response+json', true],
    ['application/json', true],
    ['application/json; charset=utf-8', true],
    ['Application/JSON;charset=UTF-8', true],
    ['  application/json  ', true],
    ['application/vnd.api+json', true],
    ['text/html; charset=utf-8', false],
    ['text/html; note=application/json', false],
    ['application/jsonp', false],
    ['application/json-seq', false],
    ['application/xml', false],
    ['text/plain', false],
    ['', false],
    [null, false],
    [undefined, false],
  ];
  for (const [contentType, expected] of cases) {
    assert.equal(isJsonContentType(contentType), expected, `content type: ${JSON.stringify(contentType)}`);
  }
});

test('hasUsableData is true only when some field under data is non-null', () => {
  const { hasUsableData } = loadPopupHelpers();
  const cases = [
    [LIGHT_PRODUCTS, true],
    [{ data: { product: { itemId: '1' } } }, true],
    [{ data: { products: [] } }, true],
    [{ data: { a: null, b: 0 } }, true],
    [GENERIC_ERRORS, false],
    [{ data: { product: null } }, false],
    [{ data: {} }, false],
    [{ data: null }, false],
    [{ data: 'text' }, false],
    [{}, false],
    [null, false],
    [undefined, false],
    ['text', false],
  ];
  for (const [body, expected] of cases) {
    assert.equal(hasUsableData(body), expected, `body: ${JSON.stringify(body)}`);
  }
});

// ---------------------------------------------------------------------------
// Test API Connection (popup)
// ---------------------------------------------------------------------------

const PRODUCT = { data: { product: { itemId: '1' } } };
const VERDICT_CASES = [
  ['product data', 200, PRODUCT, 'working'],
  ['a 206 that carries product data', 206, PRODUCT, 'working'],
  ['the 206 Generic Errors throttle', 206, GENERIC_ERRORS, 'refused'],
  ['a Generic Errors body on a 200', 200, GENERIC_ERRORS, 'refused'],
  ['a 206 with an unreadable body', 206, null, 'refused'],
  ['a 206 with a null product', 206, { data: { product: null } }, 'refused'],
  ['HTTP 403', 403, null, 'blocked'],
  ['HTTP 429', 429, null, 'tooManyRequests'],
  ['HTTP 500', 500, null, 'httpError'],
  ['a 200 that is not JSON', 200, null, 'nonJson'],
  ['the retired test product', 200,
    { data: { product: null }, errors: [{ message: 'Item not found: 100375745' }] }, 'testItemGone'],
  ['another GraphQL error', 200,
    { data: null, errors: [{ message: 'Cannot query field "x" on type "Product"' }] }, 'graphqlErrors'],
  ['no product and no errors', 200, { data: { product: null } }, 'reachable'],
];

test('Test API Connection reports the right verdict for each kind of answer', () => {
  const { classifyApiTestResponse } = loadPopupHelpers();
  for (const [label, status, body, expected] of VERDICT_CASES) {
    assert.equal(classifyApiTestResponse(status, body), expected, label);
  }
});

test('every Test API Connection verdict has a banner in popup.js', () => {
  const popupSource = readSource('popup.js');
  const verdicts = new Set(VERDICT_CASES.map(([, , , verdict]) => verdict));
  assert.equal(verdicts.size, 9);
  for (const verdict of verdicts) {
    assert.match(popupSource, new RegExp(`\\n\\s+${verdict}: \\['banner `), `no banner for "${verdict}"`);
  }
});

// Home Depot's answer for a product it no longer carries.
const itemGone = (itemId) => ({
  status: 200,
  contentType: GRAPHQL_RESPONSE_JSON,
  body: { data: { product: null }, errors: [{ message: `Item not found: ${itemId}` }] },
});

// Issue #6: the one built-in test product (100375745) was retired, and the check
// could no longer confirm product data.
test('Test API Connection moves on to the next test product when one is retired', async () => {
  const banner = await runPopupApiTest((itemId) => (
    itemId === '303115700' ? itemGone(itemId) : { status: 200, contentType: GRAPHQL_RESPONSE_JSON, body: PRODUCT }
  ));
  assert.equal(banner.className, 'banner ok');
  assert.match(banner.html, /API is working/);
  assert.deepEqual(banner.asked, ['303115700', '319738646']);
});

test('Test API Connection tries a product from the store\'s own saved list first', async () => {
  const banner = await runPopupApiTest(
    () => ({ status: 200, contentType: GRAPHQL_RESPONSE_JSON, body: PRODUCT }),
    { storage: { skuInventoryMultiStore: { 2580: { skus: ['555001', '555002', '555003'] }, 4168: { skus: ['777001'] } } } }
  );
  assert.match(banner.html, /API is working/);
  assert.equal(banner.asked.length, 1);
  assert.ok(['555001', '555002', '555003'].includes(banner.asked[0]), `asked for ${banner.asked[0]}`);
});

test('Test API Connection stops at the first answer that is not a retired product', async () => {
  const banner = await runPopupApiTest(() => throttled());
  assert.match(banner.html, /refusing requests \(206\)/);
  assert.equal(banner.asked.length, 1);
});

test('Test API Connection, run for real: the banner matches the answer', async () => {
  const cases = [
    ['product data in the new media type',
      () => ({ status: 200, contentType: GRAPHQL_RESPONSE_JSON, body: PRODUCT }),
      'banner ok', /API is working/],
    ['the 206 throttle',
      () => throttled(),
      'banner warn', /refusing requests \(206\).*clock is correct/],
    ['every test product retired',
      (itemId) => itemGone(itemId),
      'banner ok', /none of the 3 test products tried exists any more \(last answer: Item not found: 100375745\)/],
    ['an HTML block page',
      () => ({ status: 200, contentType: 'text/html', body: undefined }),
      'banner warn', /Non-JSON response/],
    ['HTTP 403',
      () => ({ status: 403, contentType: 'text/html', body: undefined }),
      'banner warn', /Rate limited \(403\)/],
    ['a network failure',
      () => new Error('Failed to fetch'),
      'banner error', /Connection failed.*Failed to fetch/],
  ];
  for (const [label, respond, className, pattern] of cases) {
    const banner = await runPopupApiTest(respond);
    assert.equal(banner.className, className, label);
    assert.match(banner.html, pattern, label);
  }
});

test('Test API Connection escapes error text from the API before showing it', async () => {
  const banner = await runPopupApiTest(() => ({
    status: 200,
    contentType: GRAPHQL_RESPONSE_JSON,
    body: { data: null, errors: [{ message: '<b>bad</b>' }] },
  }));
  assert.equal(banner.className, 'banner warn');
  assert.match(banner.html, /&lt;b&gt;bad&lt;\/b&gt;/);
  assert.doesNotMatch(banner.html, /<b>bad/);
});
