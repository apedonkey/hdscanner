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

    console.log(`[HD Scanner] Forced store to #${storeId} via cookie`);
  } catch (e) {
    // Silent — never break the page
  }
})();
