'use strict';
// store-force.js: a product link from the extension must open on the store that
// was scanned, whichever store the browser was on before.
//
// Background (2026-11-18): the site takes its store from the THD_LOCALIZER
// cookie. The script only set THD_LOCSTORE, so a link for Hanover (#4168)
// opened on Carlisle (#4149) and the clearance price was not shown.
//
// Run from the extension folder:  node --test

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readSource } = require('./harness.js');

const SOURCE = readSource('store-force.js');

// The cookie as seen in a real browser on 2026-11-18 (decoded).
const CARLISLE_LOCALIZER = {
  THD_STRFINDERZIP: '17013',
  THD_STORE_HOURS_EXPIRY: 1795057751,
  THD_STORE_HOURS: '1;8:00-20:00;2;6:00-21:00',
  THD_LOCSTORE: '4149+Carlisle - Carlisle, PA+',
  THD_INTERNAL: '0',
  THD_FORCE_LOC: '1',
  WORKFLOW: 'LOCALIZED_BY_GPS_HIGH',
};

const HANOVER = {
  storeId: '4168',
  name: 'Hanover',
  address: { street: '1 Main St', city: 'Hanover', state: 'PA', postalCode: '17331' },
};

const localizerCookie = (localizer) => `THD_LOCALIZER=${encodeURIComponent(JSON.stringify(localizer))}`;

// A browser tab on homedepot.com, reduced to what the script touches. `session`
// is the tab's sessionStorage, which survives a reload of the same tab.
function openPage({ search = '?storeId=4168', cookies = [], storage = {}, session = new Map() } = {}) {
  const jar = new Map(cookies.map((cookie) => {
    const at = cookie.indexOf('=');
    return [cookie.slice(0, at), cookie.slice(at + 1)];
  }));
  const page = { reloads: 0, jar, session };
  const sandbox = {
    URLSearchParams,
    console: { log() {}, warn() {} },
    window: { location: { search, reload: () => { page.reloads++; } } },
    document: {
      get cookie() { return [...jar].map(([name, value]) => `${name}=${value}`).join('; '); },
      set cookie(text) {
        const pair = text.split(';')[0];
        const at = pair.indexOf('=');
        jar.set(pair.slice(0, at), pair.slice(at + 1));
      },
    },
    sessionStorage: {
      getItem: (key) => (session.has(key) ? session.get(key) : null),
      setItem: (key, value) => { session.set(key, String(value)); },
    },
    chrome: { storage: { local: { get: async () => storage } } },
  };
  vm.runInNewContext(SOURCE, sandbox, { filename: 'store-force.js' });
  return page;
}

// The script reads extension storage before it acts; let that settle.
const settle = () => new Promise((resolve) => setImmediate(resolve));

const localizerIn = (page) => JSON.parse(decodeURIComponent(page.jar.get('THD_LOCALIZER')));

test('a link for another store rewrites the store in THD_LOCALIZER and reloads once', async () => {
  const page = openPage({
    cookies: [localizerCookie(CARLISLE_LOCALIZER)],
    storage: { selectedStore: HANOVER },
  });
  await settle();

  assert.deepEqual(localizerIn(page), { ...CARLISLE_LOCALIZER, THD_LOCSTORE: '4168+Hanover - Hanover, PA+' });
  assert.equal(page.reloads, 1);
});

test('the state seen on 2026-11-18 is corrected: THD_LOCSTORE already right, THD_LOCALIZER on the old store', async () => {
  const page = openPage({
    cookies: ['THD_PERSIST=', 'THD_LOCSTORE=4168', 'THD_PERSIST_LOCSTORE=4168', localizerCookie(CARLISLE_LOCALIZER)],
    storage: { selectedStore: HANOVER },
  });
  await settle();

  assert.match(localizerIn(page).THD_LOCSTORE, /^4168\+/);
  assert.equal(page.reloads, 1);
});

test('nothing happens when the site is already on the linked store', async () => {
  const onHanover = { ...CARLISLE_LOCALIZER, THD_LOCSTORE: '4168+Hanover - Hanover, PA+' };
  const page = openPage({ cookies: [localizerCookie(onHanover)], storage: { selectedStore: HANOVER } });
  await settle();

  assert.deepEqual(localizerIn(page), onHanover);
  assert.equal(page.reloads, 0);
});

test('a store number that only starts with the linked one is not taken for it', async () => {
  const on41680 = { ...CARLISLE_LOCALIZER, THD_LOCSTORE: '41680+Elsewhere - Elsewhere, PA+' };
  const page = openPage({ cookies: [localizerCookie(on41680)], storage: { selectedStore: HANOVER } });
  await settle();

  assert.match(localizerIn(page).THD_LOCSTORE, /^4168\+/);
  assert.equal(page.reloads, 1);
});

test('the page is not reloaded again when the site puts its own store back', async () => {
  const session = new Map();
  const first = openPage({ cookies: [localizerCookie(CARLISLE_LOCALIZER)], storage: { selectedStore: HANOVER }, session });
  await settle();
  assert.equal(first.reloads, 1);

  // After the reload the site has reset the cookie to Carlisle.
  const second = openPage({ cookies: [localizerCookie(CARLISLE_LOCALIZER)], storage: { selectedStore: HANOVER }, session });
  await settle();
  assert.equal(second.reloads, 0);
});

test('a store whose address is not known is written by number alone', async () => {
  const page = openPage({ cookies: [localizerCookie(CARLISLE_LOCALIZER)], storage: {} });
  await settle();

  assert.equal(localizerIn(page).THD_LOCSTORE, '4168+');
  assert.equal(page.reloads, 1);
});

test('the address of a different selected store is not used', async () => {
  const page = openPage({
    cookies: [localizerCookie(CARLISLE_LOCALIZER)],
    storage: { selectedStore: { ...HANOVER, storeId: '4149', name: 'Carlisle' } },
  });
  await settle();

  assert.equal(localizerIn(page).THD_LOCSTORE, '4168+');
});

test('a store picked earlier, and no longer the selected one, is still written in full', async () => {
  const page = openPage({
    cookies: [localizerCookie(CARLISLE_LOCALIZER)],
    storage: {
      selectedStore: { ...HANOVER, storeId: '4149', name: 'Carlisle' },
      savedStoreDetails: { 4168: { ...HANOVER, name: undefined, storeName: 'Hanover' } },
    },
  });
  await settle();

  assert.equal(localizerIn(page).THD_LOCSTORE, '4168+Hanover - Hanover, PA+');
  assert.equal(page.reloads, 1);
});

test('with no THD_LOCALIZER cookie the plain store cookies are set and the page reloads once', async () => {
  const page = openPage({ cookies: [] });
  await settle();

  assert.equal(page.jar.get('THD_LOCSTORE'), '4168');
  assert.equal(page.jar.get('THD_PERSIST_LOCSTORE'), '4168');
  assert.equal(page.jar.has('THD_LOCALIZER'), false);
  assert.equal(page.reloads, 1);
});

test('with no THD_LOCALIZER cookie and the plain cookie already right, nothing happens', async () => {
  const page = openPage({ cookies: ['THD_LOCSTORE=4168'] });
  await settle();

  assert.equal(page.reloads, 0);
});

test('a page with no storeId in its address is left alone', async () => {
  const page = openPage({ search: '', cookies: [localizerCookie(CARLISLE_LOCALIZER)] });
  await settle();

  assert.deepEqual(localizerIn(page), CARLISLE_LOCALIZER);
  assert.equal(page.reloads, 0);
});

test('a THD_LOCALIZER cookie that cannot be read does not break the page', async () => {
  const page = openPage({ cookies: ['THD_LOCALIZER=%7Bnot-json'] });
  await settle();

  assert.equal(page.jar.get('THD_LOCALIZER'), '%7Bnot-json');
});
