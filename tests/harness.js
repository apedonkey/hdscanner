'use strict';
// Test harness for the extension.
//
// Loads the real extension scripts into isolated VM contexts with a minimal fake
// of the browser APIs they touch. There are two ways in:
//   loadContentScript()  content.js on its own, driven through its message
//                        listener the same way background.js drives it.
//   loadExtension()      background.js and content.js wired together, driven the
//                        way the popup drives them.
// Nothing here talks to the network: every fetch() is answered by the test's own
// script. Timers fire immediately and advance a virtual clock, so the 10/30/90-
// second backoffs and the pauses between scan waves cost no real time.
//
// Run all tests from the extension folder with:  node --test

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT_ROOT = path.resolve(__dirname, '..');

function readSource(name) {
  return fs.readFileSync(path.join(EXT_ROOT, name), 'utf8');
}

// A copy that shares nothing with the original, as Chrome's own serialisation of
// messages and stored values produces. Also moves a value out of a VM realm.
function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// What fetch() resolves to. `body` is what json() returns; leave it undefined to
// simulate a body that is not valid JSON (an HTML block page, for example). A
// string body is what text() returns, as for a sitemap.
function fakeResponse({ status = 200, contentType = 'application/json', body } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null),
    },
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected token < in JSON at position 0');
      return structuredClone(body);
    },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? '')),
  };
}

// Stands in for the browser's DOMParser for the two lookups content.js makes on
// a sitemap: the <loc> of every <sitemap> entry and of every <url> entry.
class FakeDOMParser {
  parseFromString(text) {
    const locsOf = (tag) => [...String(text).matchAll(
      new RegExp(`<${tag}>[\\s\\S]*?<loc>([\\s\\S]*?)</loc>[\\s\\S]*?</${tag}>`, 'g')
    )].map((match) => ({ textContent: match[1].trim() }));
    return {
      querySelectorAll: (selector) => {
        if (selector === 'sitemap loc') return locsOf('sitemap');
        if (selector === 'url loc') return locsOf('url');
        throw new Error(`FakeDOMParser does not support the selector "${selector}"`);
      },
    };
  }
}

// A virtual clock, plus timers that fire on the next turn of the event loop and
// move the clock to the moment they were due. `waits` lists every delay asked for.
function createClock() {
  const waits = [];
  let now = 1_700_000_000_000;
  return {
    waits,
    now: () => now,
    setTimeout: (fn, ms = 0) => {
      waits.push(ms);
      const due = now + ms;
      return setTimeout(() => {
        now = Math.max(now, due);
        fn();
      }, 0);
    },
    clearTimeout: (id) => clearTimeout(id),
  };
}

// An in-memory chrome.storage.local. `api` is what the scripts see; `data` is
// its live contents, for tests to read.
function createStorageArea(initial = {}) {
  const data = copy(initial);
  const api = {
    get: async (keys) => {
      if (keys == null) return copy(data);
      const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const found = {};
      for (const name of names) {
        if (name in data) found[name] = copy(data[name]);
      }
      return found;
    },
    set: async (items) => {
      for (const [name, value] of Object.entries(items)) data[name] = copy(value);
    },
    remove: async (keys) => {
      for (const name of [].concat(keys)) delete data[name];
    },
  };
  return { data, api };
}

// A console that prints nothing and keeps error lines for failure messages.
function silentConsole(errors) {
  return {
    log() {},
    warn() {},
    error: (...args) => { errors.push(args.map(String).join(' ')); },
  };
}

// Hand a message to an onMessage listener and resolve with its answer, the way
// chrome.tabs.sendMessage and chrome.runtime.sendMessage do. Resolves with
// undefined when the listener neither answers nor keeps the channel open.
function deliver(listener, message, sender = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const sendResponse = (response) => {
      if (answered) return;
      answered = true;
      resolve(copy(response));
    };
    const keepsChannelOpen = listener(copy(message), sender, sendResponse);
    if (keepsChannelOpen !== true && !answered) resolve(undefined);
  });
}

// Run content.js in a fresh VM context, as one loaded Home Depot page does.
// Returns { listener, unload }: the script's message listener, and a function
// that ends the page the way closing its tab or leaving the page does. After
// unload() the script never runs again: its requests, timers, storage calls
// and messages never complete.
//   respond(request, n)  answer for the n-th fetch: { status, contentType, body }
//   requests             array every fetch is appended to: { url, payload }
//   toRuntime(message)   what chrome.runtime.sendMessage does with a message
function runContentScript({ respond, requests, clock, storage, toRuntime }) {
  const consoleErrors = [];
  let listener = null;
  let unloaded = false;
  const never = new Promise(() => {});
  // Settles as `promise` does, but only while the page is still loaded.
  const whileLoaded = (promise) => new Promise((resolve, reject) => {
    promise.then(
      (value) => { if (!unloaded) resolve(value); },
      (error) => { if (!unloaded) reject(error); }
    );
  });
  const storageCall = (name) => (...args) => (
    unloaded ? never : whileLoaded(storage.api[name](...args))
  );

  const sandbox = {
    console: silentConsole(consoleErrors),
    URL,
    AbortController,
    DOMParser: FakeDOMParser,
    setTimeout: (fn, ms) => clock.setTimeout(() => { if (!unloaded) fn(); }, ms),
    clearTimeout: clock.clearTimeout,
    fetch: async (url, init = {}) => {
      if (unloaded) return never;
      const request = { url: String(url), payload: init.body ? JSON.parse(init.body) : null };
      requests.push(request);
      // respond() is where a test acts, and what it does may be to end this page.
      const answer = respond(request, requests.length);
      return unloaded ? never : fakeResponse(answer);
    },
    chrome: {
      storage: {
        local: { get: storageCall('get'), set: storageCall('set'), remove: storageCall('remove') },
      },
      runtime: {
        onMessage: { addListener: (fn) => { listener = fn; } },
        sendMessage: (message) => (unloaded ? never : whileLoaded(toRuntime(message))),
      },
    },
    __virtualNow: clock.now,
  };
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext('Date.now = () => __virtualNow();', sandbox);
  vm.runInContext(readSource('content.js'), sandbox, { filename: 'content.js' });

  if (!listener) {
    // content.js wraps itself in try/catch and only logs a fatal load error.
    throw new Error(`content.js registered no message listener. ${consoleErrors[0] || ''}`);
  }
  return { listener, unload: () => { unloaded = true; } };
}

// Load content.js on its own and return a handle for talking to it.
//   respond(request, n) -> { status, contentType, body } for the n-th fetch (1-based)
// The handle exposes:
//   send(message)  -> Promise of the listener's response (as background.js would get it)
//   requests       -> every fetch made so far: { url, payload }
//   waits          -> every setTimeout delay requested so far, in ms
function loadContentScript({ respond }) {
  const requests = [];
  const clock = createClock();
  const { listener } = runContentScript({
    respond,
    requests,
    clock,
    storage: createStorageArea(),
    toRuntime: async () => {},
  });

  function send(message) {
    return new Promise((resolve, reject) => {
      const guard = setTimeout(
        () => reject(new Error(`content.js sent no response to "${message.action}" within 5s`)),
        5000
      );
      deliver(listener, message).then((response) => {
        clearTimeout(guard);
        resolve(response);
      });
    });
  }

  return { send, requests, waits: clock.waits };
}

// Load background.js and content.js and wire them together the way Chrome does:
//   - the worker reaches the tab through chrome.tabs.sendMessage,
//   - the tab reaches the worker through chrome.runtime.sendMessage,
//   - both share one chrome.storage.local,
//   - whatever either side broadcasts (progress, completion) is what an open
//     popup would receive; it is collected in `broadcasts`.
// Options:
//   respond(request, n)   answer for the tab's n-th fetch, as in loadContentScript
//   storage               initial contents of chrome.storage.local
//   onBroadcast(message)  called for each broadcast as it happens
//   onTelegramCall(call)  called for each request the bot makes to Telegram,
//                         before it is answered: { method, body }
//   storeId               the store selected in the popup
//   tabCount              how many Home Depot tabs are open (ids 1, 2, ...); each
//                         runs its own content.js, and the popup is on tab 1
//   telegram              true to connect a Telegram bot: its API calls are
//                         recorded, and its long poll for commands is answered
//                         by telegram.tap() and telegram.say()
// The handle exposes:
//   popup.toBackground(message), popup.toTab(message, tabId)   what a popup sends
//   popup.clickFullScan(), popup.clickQuickRecheck(), popup.clickPennyScan(),
//   popup.clickResume(), popup.pressStop()   run popup.js's real button handlers
//   popup.open()          runs the check the popup makes first when it opens
//   popup.status          every status line the popup would have shown, in order
//   popup.errors          every error banner it would have shown
//   popup.view.scanning   whether it is showing its scanning view
//   telegram.startScan({ cached }), telegram.startPennyScan(), telegram.pressStop(),
//   telegram.showStatus() run background.js's real handlers for those bot commands
//   telegram.tap(data), telegram.say(text)   send the bot a command through its
//                         real long poll: a button tap or a text message
//   telegram.messages()   every message the bot has sent or edited in:
//                         { text, buttons }, buttons being what each sends back
//   telegram.texts()      the texts of those messages
//   tabs.close(tabId), tabs.goTo(url, tabId)   close a tab, or send it to another
//                         page; either ends the content.js running in it, and
//                         whatever is waiting for its answer is told it is gone
//   idle()                resolves once the worker's scan loop has ended
//   requests, broadcasts, waits
//   storage               live contents of chrome.storage.local
function loadExtension({
  respond,
  storage: initialStorage = {},
  onBroadcast = () => {},
  onTelegramCall = () => {},
  storeId = '2580',
  tabCount = 1,
  telegram = false,
}) {
  const requests = [];
  const broadcasts = [];
  const backgroundErrors = [];
  const clock = createClock();
  const storage = createStorageArea(initialStorage);
  const openTabs = Array.from({ length: tabCount }, (_, i) => ({
    id: i + 1,
    windowId: 1,
    active: i === 0,
    url: 'https://www.homedepot.com/',
  }));
  // tab id -> the Home Depot page loaded in that tab: { listener, unload,
  // unanswered }. A tab that is on another site has none.
  const pages = new Map();
  let backgroundListener = null;

  const telegramChatId = 7;
  const telegramCalls = [];
  const telegramUpdates = []; // commands waiting for the bot's next long poll
  const telegramPolls = []; // long polls waiting for a command
  let telegramUpdateId = 1; // the cursor seeded below
  const deliverTelegramUpdates = () => {
    if (telegramPolls.length === 0 || telegramUpdates.length === 0) return;
    const answerPoll = telegramPolls.shift();
    answerPoll(fakeResponse({ body: { ok: true, result: telegramUpdates.splice(0) } }));
  };
  const receiveTelegramUpdate = (update) => {
    telegramUpdateId += 1;
    telegramUpdates.push({ update_id: telegramUpdateId, ...update });
    deliverTelegramUpdates();
  };
  if (telegram) {
    storage.data.telegramConfig = {
      botToken: '123456789:TEST-TOKEN-TEST-TOKEN-TEST-TOKEN',
      chatId: telegramChatId,
    };
    storage.data.telegramLastUpdateId = 1;
  }

  const broadcast = (message) => {
    const seen = copy(message);
    broadcasts.push(seen);
    onBroadcast(seen);
  };
  const toBackground = (message, sender = {}) => deliver(backgroundListener, message, sender);
  // What chrome.tabs.sendMessage does with a message for a tab: resolves with
  // the answer of the Home Depot page loaded there, and rejects when the tab
  // has no such page, or loses it before the page has answered.
  const toTab = (message, tabId = 1) => new Promise((resolve, reject) => {
    const page = pages.get(tabId);
    if (!page) {
      reject(new Error('Could not establish connection. Receiving end does not exist.'));
      return;
    }
    page.unanswered.add(reject);
    deliver(page.listener, message).then((response) => {
      page.unanswered.delete(reject);
      resolve(response);
    });
  });

  // Load a Home Depot page in a tab, and with it a fresh content.js.
  function loadPage(tab) {
    const page = runContentScript({
      respond,
      requests,
      clock,
      storage,
      // From a tab, the worker handles the message and an open popup sees it too.
      toRuntime: (message) => {
        broadcast(message);
        return toBackground(message, { tab: copy(tab) });
      },
    });
    pages.set(tab.id, { ...page, unanswered: new Set() });
  }

  // End the page loaded in a tab, as closing the tab or leaving the page does.
  // Its script stops for good, and whoever is still waiting for an answer from
  // it is told the tab went away.
  function unloadPage(tabId) {
    const page = pages.get(tabId);
    if (!page) return;
    pages.delete(tabId);
    page.unload();
    for (const reject of page.unanswered) {
      reject(new Error('The message port closed before a response was received.'));
    }
    page.unanswered.clear();
  }

  const backgroundSandbox = {
    console: silentConsole(backgroundErrors),
    URL,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    fetch: async (url, init = {}) => {
      const telegramMethod = /^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/.exec(String(url));
      if (!telegram || !telegramMethod) {
        throw new Error(`background.js made an unexpected request to ${url}`);
      }
      // The bot's long poll for commands: answered when a test sends one with
      // telegram.tap() or telegram.say(), and left hanging until then.
      if (telegramMethod[1] === 'getUpdates') {
        return new Promise((resolve) => {
          telegramPolls.push(resolve);
          deliverTelegramUpdates();
        });
      }
      const call = { method: telegramMethod[1], body: init.body ? JSON.parse(init.body) : null };
      telegramCalls.push(call);
      onTelegramCall(copy(call));
      return fakeResponse({ body: { ok: true, result: { message_id: telegramCalls.length } } });
    },
    chrome: {
      storage: { local: storage.api, onChanged: { addListener() {} } },
      alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
      tabs: {
        query: async () => copy(openTabs),
        // background.js uses both the callback form and the promise form. A
        // tab that does not answer rejects the promise; the callback form is
        // told through chrome.runtime.lastError, set only while the callback runs.
        sendMessage: (tabId, message, callback) => {
          const answer = toTab(message, tabId);
          if (typeof callback !== 'function') return answer;
          answer.then(callback, (error) => {
            backgroundSandbox.chrome.runtime.lastError = { message: error.message };
            try {
              callback();
            } finally {
              backgroundSandbox.chrome.runtime.lastError = undefined;
            }
          });
          return undefined;
        },
      },
      scripting: {
        executeScript: async () => {
          throw new Error('background.js tried to inject the content script, which is already loaded');
        },
      },
      runtime: {
        lastError: undefined,
        onMessage: { addListener: (fn) => { backgroundListener = fn; } },
        // From the worker, only an open popup is listening.
        sendMessage: async (message) => { broadcast(message); },
      },
    },
    __virtualNow: clock.now,
  };
  vm.createContext(backgroundSandbox);
  vm.runInContext('Date.now = () => __virtualNow();', backgroundSandbox);
  vm.runInContext(readSource('background.js'), backgroundSandbox, { filename: 'background.js' });
  if (!backgroundListener) throw new Error('background.js registered no message listener');

  for (const tab of openTabs) loadPage(tab);

  // popup.js's real handlers for the scan buttons, Resume and Stop, with the
  // popup's own plumbing (its page elements, status line and views) replaced by
  // recorders.
  const popupStatus = [];
  const popupErrors = [];
  const popupView = { scanning: false };
  const popupElements = { storeId: { value: storeId, style: {} } };
  const popupSource = readSource('popup.js');
  const popupSandbox = vm.createContext({
    console: silentConsole([]),
    setTimeout: clock.setTimeout,
    $: (id) => popupElements[id] || (popupElements[id] = { value: '', style: {} }),
    setStatus: (text) => { popupStatus.push(text); },
    showError: (text) => { popupErrors.push(text); },
    hideError() {},
    setScanningUI: (isScanning) => { popupView.scanning = isScanning; },
    setProgress() {},
    setOverflowStatus() {},
    formatCacheAge: () => '',
    checkForInterruptedScan() {},
    checkConnection: async () => true,
    sendToContentScript: (message) => toTab(message),
    chrome: {
      storage: { local: storage.api },
      runtime: { sendMessage: (message) => toBackground(message) },
      tabs: {
        query: async () => copy(openTabs),
        sendMessage: (tabId, message) => toTab(message, tabId),
      },
    },
  });
  vm.runInContext(
    [
      // State the handlers assign to; popup.js declares these at its top.
      'var currentScanType = null, clearanceItems = [], stats = {};',
      sliceBetweenMarkers(popupSource, '>>> one-scan-at-a-time', '<<< one-scan-at-a-time', 'popup.js'),
      ...['startSitemapScan', 'startCheckSkusOnly', 'startPennyScan', 'stopScan']
        .map((name) => topLevelFunctionSource(popupSource, name, 'popup.js')),
    ].join('\n'),
    popupSandbox,
    { filename: 'popup.js (scan buttons)' }
  );
  const inPopup = (call) => vm.runInContext(call, popupSandbox);

  // background.js's real handlers for the bot's commands, called as its update
  // dispatcher calls them: only once the bot's settings have been loaded.
  const botCommand = (call) => vm.runInContext(
    `telegramConfigReady.then(() => ${call})`, backgroundSandbox
  );
  const telegramHandle = {
    startScan: ({ cached }) => botCommand(
      `telegramHandleScanTrigger(${telegramChatId}, ${JSON.stringify(storeId)}, ${cached ? 'true' : 'false'})`
    ),
    startPennyScan: () => botCommand(
      `telegramHandlePennyScanTrigger(${telegramChatId}, ${JSON.stringify(storeId)})`
    ),
    pressStop: () => botCommand(`telegramHandleStop(${telegramChatId})`),
    showStatus: () => botCommand(`telegramHandleStatus(${telegramChatId}, null)`),
    // Send the bot a command through its real long poll, as Telegram does: a tap
    // on an inline button ('scan:2580', 'menu:stop'), or a text ('/status').
    tap: (data) => receiveTelegramUpdate({
      callback_query: {
        id: `tap-${telegramUpdateId}`,
        data,
        message: { chat: { id: telegramChatId }, message_id: 1 },
      },
    }),
    say: (text) => receiveTelegramUpdate({ message: { chat: { id: telegramChatId }, text } }),
    // Every message the bot has sent or edited in: its text, and what each of
    // its buttons sends back when tapped.
    messages: () => telegramCalls
      .filter((call) => call.body && typeof call.body.text === 'string')
      .map((call) => ({
        text: call.body.text,
        buttons: (call.body.reply_markup?.inline_keyboard || [])
          .flat()
          .map((button) => button.callback_data),
      })),
    texts: () => telegramHandle.messages().map((message) => message.text),
  };

  // What can happen to a Home Depot tab while a scan runs.
  const tabsHandle = {
    close: (tabId = 1) => {
      const at = openTabs.findIndex((tab) => tab.id === tabId);
      if (at < 0) throw new Error(`there is no tab ${tabId} to close`);
      unloadPage(tabId);
      openTabs.splice(at, 1);
    },
    // A homedepot.com address loads a fresh content.js, as the manifest's
    // content_scripts entry does; any other address leaves the tab without one.
    goTo: (url, tabId = 1) => {
      const tab = openTabs.find((candidate) => candidate.id === tabId);
      if (!tab) throw new Error(`there is no tab ${tabId} to send to ${url}`);
      unloadPage(tabId);
      tab.url = url;
      if (/^https:\/\/(www\.)?homedepot\.com\//.test(url)) loadPage(tab);
    },
  };

  // Resolves once the worker's scan loop has ended, whether the scan finished
  // or was stopped.
  async function idle() {
    const giveUpAt = Date.now() + 10000;
    do {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (Date.now() > giveUpAt) {
        throw new Error(`the scan loop was still running after 10s. ${backgroundErrors[0] || ''}`);
      }
    } while (vm.runInContext('scanLoopActive', backgroundSandbox));
    // One more turn, so the loop's last storage writes and broadcasts have landed.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return {
    popup: {
      toBackground,
      toTab,
      clickFullScan: () => inPopup('startSitemapScan()'),
      clickQuickRecheck: () => inPopup('startCheckSkusOnly()'),
      clickPennyScan: () => inPopup('startPennyScan()'),
      clickResume: () => inPopup('resumeInterruptedScan()'),
      pressStop: () => { inPopup('stopScan()'); },
      open: () => inPopup('showRunningScanEarly()'),
      status: popupStatus,
      errors: popupErrors,
      view: popupView,
    },
    telegram: telegramHandle,
    tabs: tabsHandle,
    idle,
    requests,
    broadcasts,
    waits: clock.waits,
    storage: storage.data,
  };
}

// Text strictly between the line containing `beginMarker` and the line
// containing `endMarker`. Throws when either marker is missing, so a moved or
// renamed block fails loudly instead of silently testing nothing.
function sliceBetweenMarkers(source, beginMarker, endMarker, label) {
  const lines = source.split(/\r?\n/);
  const begin = lines.findIndex((line) => line.includes(beginMarker));
  const end = lines.findIndex((line, i) => i > begin && line.includes(endMarker));
  if (begin < 0 || end < 0) {
    throw new Error(`${label}: marker "${begin < 0 ? beginMarker : endMarker}" not found`);
  }
  return lines.slice(begin + 1, end).join('\n');
}

// The helper block that content.js and popup.js must carry identical copies of.
function sharedHelperBlock(fileName) {
  return sliceBetweenMarkers(
    readSource(fileName), '>>> shared-api-helpers', '<<< shared-api-helpers', fileName
  );
}

// Source of popup.js's pure helpers: the shared block plus the verdict function.
function popupPureSource() {
  const verdictBlock = sliceBetweenMarkers(
    readSource('popup.js'), '>>> api-test-verdict', '<<< api-test-verdict', 'popup.js'
  );
  return `${sharedHelperBlock('popup.js')}\n${verdictBlock}`;
}

// popup.js's pure helpers, evaluated on their own (popup.js as a whole needs a DOM).
function loadPopupHelpers() {
  const context = vm.createContext({});
  vm.runInContext(popupPureSource(), context, { filename: 'popup.js (pure helpers)' });
  return vm.runInContext('({ isJsonContentType, hasUsableData, classifyApiTestResponse })', context);
}

// Source of one top-level function: from its declaration line to the first
// line after it that is a lone "}" in column 0.
function topLevelFunctionSource(source, name, label) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex(
    (line) => line.startsWith(`function ${name}(`) || line.startsWith(`async function ${name}(`)
  );
  const end = lines.findIndex((line, i) => i > start && line === '}');
  if (start < 0 || end < 0) throw new Error(`${label}: function ${name} not found`);
  return lines.slice(start, end + 1).join('\n');
}

// Run popup.js's real testApiConnection() once and return the banner it ends
// on: { className, html }. respond() returns { status, contentType, body } for
// the request, or an Error to make fetch() itself fail; it is given the item id
// the request asked for. `storage` is what chrome.storage.local holds (the
// selected store is 2580). The banner also carries `asked`: the item ids
// requested, in order.
async function runPopupApiTest(respond, { storage = {} } = {}) {
  const source = readSource('popup.js');
  const banners = [];
  const asked = [];
  const context = vm.createContext({
    API_URL: 'https://example.invalid/graphql',
    PRODUCT_QUERY: 'query { test }',
    $: () => ({ value: '2580', disabled: false, textContent: '' }),
    showConnectionResult: (className, html) => { banners.push({ className, html, asked }); },
    chrome: { storage: { local: { get: async () => storage } } },
    fetch: async (_url, init) => {
      const itemId = JSON.parse(init.body).variables.itemId;
      asked.push(itemId);
      const answer = respond(itemId);
      if (answer instanceof Error) throw answer;
      return fakeResponse(answer);
    },
  });
  vm.runInContext(
    [
      popupPureSource(),
      topLevelFunctionSource(source, 'escapeHtml', 'popup.js'),
      topLevelFunctionSource(source, 'apiTestProducts', 'popup.js'),
      topLevelFunctionSource(source, 'testApiConnection', 'popup.js'),
    ].join('\n'),
    context,
    { filename: 'popup.js (testApiConnection)' }
  );
  await vm.runInContext('testApiConnection()', context);
  return banners[banners.length - 1];
}

module.exports = {
  readSource,
  loadContentScript,
  loadExtension,
  sliceBetweenMarkers,
  sharedHelperBlock,
  loadPopupHelpers,
  runPopupApiTest,
};
