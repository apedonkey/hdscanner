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
// simulate a body that is not valid JSON (an HTML block page, for example).
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
  };
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

// Run content.js in a fresh VM context and return its message listener.
//   respond(request, n)  answer for the n-th fetch: { status, contentType, body }
//   requests             array every fetch is appended to: { url, payload }
//   toRuntime(message)   what chrome.runtime.sendMessage does with a message
function runContentScript({ respond, requests, clock, storage, toRuntime }) {
  const consoleErrors = [];
  let listener = null;

  const sandbox = {
    console: silentConsole(consoleErrors),
    URL,
    AbortController,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    fetch: async (url, init = {}) => {
      const request = { url: String(url), payload: init.body ? JSON.parse(init.body) : null };
      requests.push(request);
      return fakeResponse(respond(request, requests.length));
    },
    chrome: {
      storage: { local: storage.api },
      runtime: {
        onMessage: { addListener: (fn) => { listener = fn; } },
        sendMessage: (message) => toRuntime(message),
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
  return listener;
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
  const listener = runContentScript({
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
// The handle exposes:
//   popup.toBackground(message), popup.toTab(message)   what the popup sends
//   popup.pressStop()     runs popup.js's real stopScan()
//   popup.status          every status line the popup would have shown, in order
//   idle()                resolves once the worker's scan loop has ended
//   requests, broadcasts, waits
//   storage               live contents of chrome.storage.local
function loadExtension({ respond, storage: initialStorage = {}, onBroadcast = () => {} }) {
  const requests = [];
  const broadcasts = [];
  const backgroundErrors = [];
  const clock = createClock();
  const storage = createStorageArea(initialStorage);
  const hdTab = { id: 1, windowId: 1, active: true, url: 'https://www.homedepot.com/' };
  let backgroundListener = null;
  let contentListener = null;

  const broadcast = (message) => {
    const seen = copy(message);
    broadcasts.push(seen);
    onBroadcast(seen);
  };
  const toBackground = (message, sender = {}) => deliver(backgroundListener, message, sender);
  const toTab = (message) => deliver(contentListener, message);

  const backgroundSandbox = {
    console: silentConsole(backgroundErrors),
    URL,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    fetch: async (url) => {
      throw new Error(`background.js made an unexpected request to ${url}`);
    },
    chrome: {
      storage: { local: storage.api, onChanged: { addListener() {} } },
      alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
      tabs: {
        query: async () => [copy(hdTab)],
        // background.js uses both the callback form and the promise form.
        sendMessage: (_tabId, message, callback) => {
          const answer = toTab(message);
          if (typeof callback !== 'function') return answer;
          answer.then(callback);
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

  contentListener = runContentScript({
    respond,
    requests,
    clock,
    storage,
    // From the tab, the worker handles the message and an open popup sees it too.
    toRuntime: (message) => {
      broadcast(message);
      return toBackground(message, { tab: copy(hdTab) });
    },
  });

  // popup.js's real Stop handler, with the popup's own plumbing replaced.
  const popupStatus = [];
  const popupSandbox = vm.createContext({
    setStatus: (text) => { popupStatus.push(text); },
    setScanningUI() {},
    checkForInterruptedScan() {},
    sendToContentScript: (message) => toTab(message),
    chrome: { runtime: { sendMessage: (message) => toBackground(message) } },
  });
  vm.runInContext(
    topLevelFunctionSource(readSource('popup.js'), 'stopScan', 'popup.js'),
    popupSandbox,
    { filename: 'popup.js (stopScan)' }
  );
  const pressStop = () => { vm.runInContext('stopScan()', popupSandbox); };

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
    popup: { toBackground, toTab, pressStop, status: popupStatus },
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
// the request, or an Error to make fetch() itself fail.
async function runPopupApiTest(respond) {
  const source = readSource('popup.js');
  const banners = [];
  const context = vm.createContext({
    API_URL: 'https://example.invalid/graphql',
    PRODUCT_QUERY: 'query { test }',
    $: () => ({ value: '2580', disabled: false, textContent: '' }),
    showConnectionResult: (className, html) => { banners.push({ className, html }); },
    fetch: async () => {
      const answer = respond();
      if (answer instanceof Error) throw answer;
      return fakeResponse(answer);
    },
  });
  vm.runInContext(
    [
      popupPureSource(),
      topLevelFunctionSource(source, 'escapeHtml', 'popup.js'),
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
