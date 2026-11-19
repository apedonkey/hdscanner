// Open a product link on the store named in its ?storeId= parameter.
// Runs at document_start, before Home Depot's own JavaScript reads the store.
//
// Which cookie the site reads (seen in a real browser, 2026-11-18): the store is
// the THD_LOCSTORE field inside the THD_LOCALIZER cookie, a URL-encoded JSON
// object, written as "4149+Carlisle - Carlisle, PA+". The plain THD_LOCSTORE
// cookie alone does not move the site: with it set to the linked store and
// THD_LOCALIZER still on another one, the page stayed on the other store and
// showed that store's price. Rewriting the field in THD_LOCALIZER and reloading
// did move it.
(function() {
  const COOKIE_DAYS = 30;

  function readCookie(name) {
    const prefix = name + '=';
    const found = document.cookie.split('; ').find(part => part.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
  }

  function writeCookie(name, value) {
    const expires = new Date(Date.now() + COOKIE_DAYS * 24 * 60 * 60 * 1000).toUTCString();
    document.cookie = `${name}=${value};path=/;domain=.homedepot.com;expires=${expires};Secure`;
  }

  // The parsed THD_LOCALIZER cookie, or null when it is missing or unreadable.
  function readLocalizer() {
    const raw = readCookie('THD_LOCALIZER');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(decodeURIComponent(raw));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  // The store value in the site's own format. The name and town are known only
  // for the store selected in the popup; any other store is written by number
  // alone. Whether the site accepts the number alone has not been checked
  // against the live site.
  async function localizerStoreValue(storeId) {
    try {
      const { selectedStore } = await chrome.storage.local.get(['selectedStore']);
      if (selectedStore && String(selectedStore.storeId) === storeId) {
        const name = selectedStore.name || selectedStore.storeName;
        const address = selectedStore.address || {};
        if (name && address.city && address.state) {
          return `${storeId}+${name} - ${address.city}, ${address.state}+`;
        }
      }
    } catch (e) {
      // Extension storage unavailable: fall through to the number alone.
    }
    return `${storeId}+`;
  }

  async function forceStore() {
    const storeId = new URLSearchParams(window.location.search).get('storeId');
    if (!storeId || !/^\d{3,5}$/.test(storeId)) return;

    const localizer = readLocalizer();
    const alreadyThere = localizer
      ? String(localizer.THD_LOCSTORE || '').startsWith(storeId + '+')
      : readCookie('THD_LOCSTORE') === storeId;
    if (alreadyThere) return;

    // An unreadable THD_LOCALIZER is left as it is: nothing safe to write.
    if (!localizer && readCookie('THD_LOCALIZER')) return;

    // The server answered this request with the previous store, so the page has
    // to be loaded again once the cookie is right. Reload once per tab and
    // store: if the site answers by putting its own store back, stop there.
    const reloadKey = `hdScannerForcedStore:${storeId}`;
    if (sessionStorage.getItem(reloadKey)) {
      console.log(`[HD Scanner] Home Depot put its own store back — the page is not showing store #${storeId}`);
      return;
    }

    if (localizer) {
      localizer.THD_LOCSTORE = await localizerStoreValue(storeId);
      writeCookie('THD_LOCALIZER', encodeURIComponent(JSON.stringify(localizer)));
    }
    writeCookie('THD_LOCSTORE', storeId);
    writeCookie('THD_PERSIST_LOCSTORE', storeId);

    sessionStorage.setItem(reloadKey, '1');
    console.log(`[HD Scanner] Switched the site to store #${storeId} — reloading so the page shows it`);
    window.location.reload();
  }

  // Never break the page.
  forceStore().catch(() => {});
})();
