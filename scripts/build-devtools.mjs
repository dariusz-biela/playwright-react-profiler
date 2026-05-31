/**
 * Builds the React DevTools profiling extension from the PUBLISHED npm packages
 * (react-devtools-core + react-devtools-inline), not bleeding-edge react source.
 *
 * Output (devtools-extension/):
 *   backend.js   MAIN-world content script  — react-devtools-core/backend
 *   frontend.js  service worker             — react-devtools-inline/frontend
 *   proxy.js     ISOLATED-world relay        — committed, not built here
 *
 * Why a service worker can host the inline frontend: the inline bundle injects
 * its stylesheet at module-load time, which needs a DOM. We prepend a minimal
 * DOM stub via the esbuild `banner` (runs before any bundled module). The
 * DevTools UI is never mounted (we only use Store/ProfilerStore), so the stub
 * is never hit again after load.
 */

import {build} from 'esbuild';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'devtools-extension');

const require = createRequire(import.meta.url);
const rdtVersion = require('react-devtools-core/package.json').version;

const LICENSE_BANNER =
  `/**\n` +
  ` * Bundled from react-devtools-core + react-devtools-inline v${rdtVersion}\n` +
  ` * (https://github.com/facebook/react). Copyright (c) Meta Platforms, Inc.\n` +
  ` * and affiliates. Licensed under the MIT License.\n` +
  ` */\n`;

// Minimal DOM stub for the service worker. Only needs to satisfy the inline
// bundle's load-time stylesheet injection (style-loader). Assigns onto `self`
// (the SW global) so free `window`/`document` references resolve.
const SW_DOM_STUB = `
;(function () {
  if (typeof self !== 'undefined' && typeof self.document === 'undefined') {
    var noop = function () {};
    function makeEl(tag) {
      var children = [];
      return {
        nodeType: 1, tagName: (tag || 'div').toUpperCase(), style: {}, dataset: {}, attributes: {},
        setAttribute: function (k, v) { this.attributes[k] = v; },
        removeAttribute: noop,
        getAttribute: function (k) { return this.attributes[k] != null ? this.attributes[k] : null; },
        appendChild: function (c) { children.push(c); return c; },
        removeChild: function (c) { return c; },
        insertBefore: function (c) { children.push(c); return c; },
        append: noop, prepend: noop, remove: noop,
        addEventListener: noop, removeEventListener: noop, dispatchEvent: function () { return true; },
        classList: {add: noop, remove: noop, contains: function () { return false; }, toggle: noop},
        querySelector: function () { return null; }, querySelectorAll: function () { return []; },
        cloneNode: function () { return makeEl(tag); },
        get firstChild() { return children[0] || null; },
        get lastChild() { return children[children.length - 1] || null; },
        get childNodes() { return children; },
        get children() { return children; },
        textContent: '', innerHTML: '', innerText: '',
        sheet: {insertRule: noop, cssRules: []},
      };
    }
    var head = makeEl('head');
    var body = makeEl('body');
    self.document = {
      nodeType: 9,
      createElement: function (t) { return makeEl(t); },
      createElementNS: function (ns, t) { return makeEl(t); },
      createTextNode: function (t) { return {nodeType: 3, textContent: t}; },
      createComment: function () { return {nodeType: 8}; },
      head: head, body: body, documentElement: makeEl('html'),
      getElementById: function () { return null; },
      getElementsByTagName: function (t) { return t === 'head' ? [head] : (t === 'body' ? [body] : []); },
      querySelector: function (s) { return /head/i.test(s) ? head : (/body/i.test(s) ? body : null); },
      querySelectorAll: function () { return []; },
      addEventListener: noop, removeEventListener: noop,
      createEvent: function () { return {initEvent: noop}; },
      styleSheets: [],
    };
    self.window = self;
    if (typeof self.navigator === 'undefined') { self.navigator = {userAgent: 'sw', platform: 'sw', languages: ['en']}; }
    self.matchMedia = function () { return {matches: false, addListener: noop, removeListener: noop, addEventListener: noop, removeEventListener: noop}; };
    self.localStorage = {getItem: function () { return null; }, setItem: noop, removeItem: noop};
  }
})();
`;

const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  define: {'process.env.NODE_ENV': '"production"'},
  legalComments: 'none',
  logLevel: 'info',
  logOverride: {'direct-eval': 'silent'},
};

async function run() {
  fs.mkdirSync(OUT, {recursive: true});

  // ── backend.js (MAIN world): installs the hook + connects the Agent ──
  await build({
    ...common,
    entryPoints: [path.join(SRC, 'backend.js')],
    outfile: path.join(OUT, 'backend.js'),
    banner: {js: LICENSE_BANNER},
  });

  // ── frontend.js (service worker): Store + ProfilerStore + export ──
  await build({
    ...common,
    entryPoints: [path.join(SRC, 'frontend.js')],
    outfile: path.join(OUT, 'frontend.js'),
    banner: {js: LICENSE_BANNER + SW_DOM_STUB},
  });

  // ── installHook.js is merged into backend.js — remove the stale legacy file ──
  const legacyInstallHook = path.join(OUT, 'installHook.js');
  if (fs.existsSync(legacyInstallHook)) {
    fs.rmSync(legacyInstallHook);
  }

  // ── manifest.json: MAIN world loads only backend.js now ──
  const manifestPath = path.join(OUT, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.content_scripts = manifest.content_scripts.map((cs) =>
    cs.world === 'MAIN' ? {...cs, js: ['backend.js']} : cs,
  );
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const sizes = ['backend.js', 'frontend.js']
    .map((f) => `${f} ${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0)}KB`)
    .join('  |  ');
  console.log(`\nDevTools extension built from npm react-devtools v${rdtVersion}`);
  console.log(`  ${OUT}`);
  console.log(`  ${sizes}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
