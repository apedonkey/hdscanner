'use strict';
// Test harness for the extension.
//
// Loads the real content.js into an isolated VM context with a minimal fake of
// the browser APIs it touches, then drives it through its message listener the
// same way background.js does. Nothing here talks to the network: every fetch()
// is answered by the test's own script. Timers fire immediately and advance a
// virtual clock, so the 10/30/90-second backoffs cost no real time.
//
// Run all tests from the extension folder with:  node --test

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT_ROOT = path.resolve(__dirname, '..');

function readSource(name) {
  return fs.readFileSync(path.join(EXT_ROOT, name), 'utf8');
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

// Load content.js and return a handle for talking to it.
//   respond(request, n) -> { status, contentType, body } for the n-th fetch (1-based)
// The handle exposes:
//   send(message)  -> Promise of the listener's response (as background.js would get it)
//   requests       -> every fetch made so far: { url, payload }
//   waits          -> every setTimeout delay requested so far, in ms
function loadContentScript({ respond }) {
  const requests = [];
  const waits = [];
  const consoleErrors = [];
  let listener = null;
  let virtualNow = 1_700_000_000_000;

  const sandbox = {
    console: {
      log() {},
      warn() {},
      error: (...args) => { consoleErrors.push(args.map(String).join(' ')); },
    },
    URL,
    AbortController,
    setTimeout: (fn, ms = 0) => {
      waits.push(ms);
      const due = virtualNow + ms;
      return setTimeout(() => {
        virtualNow = Math.max(virtualNow, due);
        fn();
      }, 0);
    },
    clearTimeout: (id) => clearTimeout(id),
    fetch: async (url, init = {}) => {
      const request = { url: String(url), payload: init.body ? JSON.parse(init.body) : null };
      requests.push(request);
      return fakeResponse(respond(request, requests.length));
    },
    chrome: {
      storage: {
        local: {
          get: async () => ({}),
          set: async () => {},
          remove: async () => {},
        },
      },
      runtime: {
        onMessage: { addListener: (fn) => { listener = fn; } },
        sendMessage: async () => {},
      },
    },
    __virtualNow: () => virtualNow,
  };
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext('Date.now = () => __virtualNow();', sandbox);
  vm.runInContext(readSource('content.js'), sandbox, { filename: 'content.js' });

  if (!listener) {
    // content.js wraps itself in try/catch and only logs a fatal load error.
    throw new Error(`content.js registered no message listener. ${consoleErrors[0] || ''}`);
  }

  function send(message) {
    return new Promise((resolve, reject) => {
      const guard = setTimeout(
        () => reject(new Error(`content.js sent no response to "${message.action}" within 5s`)),
        5000
      );
      listener(message, {}, (response) => {
        clearTimeout(guard);
        // Round-trip through JSON: the response was built inside the VM realm,
        // and this also mirrors how Chrome serialises messages.
        resolve(JSON.parse(JSON.stringify(response)));
      });
    });
  }

  return { send, requests, waits };
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
  sliceBetweenMarkers,
  sharedHelperBlock,
  loadPopupHelpers,
  runPopupApiTest,
};
