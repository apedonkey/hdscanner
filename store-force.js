// Force HD store location to match ?storeId= URL parameter.
// Runs at document_start (before HD's JavaScript) so the cookie is set
// before their frontend reads it and picks a store.
(function() {
  try {
    const params = new URLSearchParams(window.location.search);
    const storeId = params.get('storeId');
    if (!storeId || !/^\d{3,5}$/.test(storeId)) return;

    // Check if THD_LOCSTORE already points at this store
    const match = document.cookie.match(/THD_LOCSTORE=(\d+)/);
    if (match && match[1] === storeId) return;

    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toUTCString();
    const domain = '.homedepot.com';

    // THD_LOCSTORE is HD's primary store-selection cookie.
    // THD_PERSIST_LOCSTORE is the long-lived variant some pages check.
    document.cookie = `THD_LOCSTORE=${storeId};path=/;domain=${domain};expires=${expires};Secure`;
    document.cookie = `THD_PERSIST_LOCSTORE=${storeId};path=/;domain=${domain};expires=${expires};Secure`;

    // document_start still runs *after* the server answered this request, and
    // it answered using the previous store cookie — so the price and stock on
    // screen belong to whichever store was set before. Setting the cookie only
    // fixes later navigations, which is why a link with the right ?storeId=
    // still landed on the old store. Reload once now that the cookie is right.
    //
    // Loop safety, in order: the cookie check above turns the second pass into
    // an early return, and the sessionStorage key stops any further reload if
    // HD answers by resetting the cookie to a store of its own choosing.
    const reloadKey = `hdScannerForcedStore:${storeId}`;
    if (sessionStorage.getItem(reloadKey)) {
      console.log(`[HD Scanner] Store #${storeId} cookie was reset by HD — page shows HD's chosen store`);
      return;
    }
    sessionStorage.setItem(reloadKey, '1');
    console.log(`[HD Scanner] Forced store to #${storeId} via cookie — reloading so the server uses it`);
    window.location.reload();
  } catch (e) {
    // Silent — never break the page
  }
})();
