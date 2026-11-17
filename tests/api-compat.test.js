'use strict';
// API-compatibility tests: how the extension copes with what Home Depot's
// GraphQL gateway actually sends. Background: issue #2 on apedonkey/hdscanner.
//
// Run from the extension folder:  node --test

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadContentScript } = require('./harness.js');

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
