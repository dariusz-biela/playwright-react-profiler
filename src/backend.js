/**
 * Backend content script (MAIN world, document_start).
 *
 * Built from the published `react-devtools-core` package (NOT bleeding-edge
 * react source), so the Bridge operations encoding matches a same-versioned
 * React DevTools 7.0.x extension and exported profiles import with zero mapping.
 *
 * Two calls do the work:
 *   - initialize()                       installs __REACT_DEVTOOLS_GLOBAL_HOOK__
 *                                        before React loads, seeded with the
 *                                        default component filters.
 *   - connectWithCustomMessagingProtocol wires Agent + Bridge + initBackend over
 *                                        a custom wall (window.postMessage via
 *                                        proxy.js, ISOLATED world).
 *
 * Optimization: during profiling, 'operations' events are buffered instead of
 * being sent per commit. This removes per-commit structured-clone overhead on
 * the page main thread. Buffered operations are flushed in one burst right
 * before 'profilingData' (or on profiling stop) so ProfilerStore still receives
 * them in order.
 *
 * Exposes: window.__REACT_PROFILER__ (all methods return Promises).
 */

import {initialize, connectWithCustomMessagingProtocol} from 'react-devtools-core/backend';

// ── 1. Install the DevTools hook before React initializes ──
// initialize() seeds the hook with getDefaultComponentFilters(), so host
// components (divs, etc.) are filtered out exactly as in the real DevTools.
initialize();

// ── 2. Outgoing transport (backend → frontend) with operations buffering ──
let isProfilingActive = false;
const bufferedOperations = [];

function postToProxy(event, payload) {
  window.postMessage({source: 'react-profiler-backend', payload: {event, payload}}, '*');
}

function flushBufferedOperations() {
  for (let i = 0; i < bufferedOperations.length; i++) {
    postToProxy('operations', bufferedOperations[i]);
  }
  bufferedOperations.length = 0;
}

// ── 3. Bridge wall over the custom messaging protocol ──
let bridgeListeners = [];

connectWithCustomMessagingProtocol({
  onSubscribe(listener) {
    bridgeListeners.push(listener);
  },
  onUnsubscribe(listener) {
    bridgeListeners = bridgeListeners.filter((l) => l !== listener);
  },
  onMessage(event, payload) {
    // Detect profiling start.
    if (event === 'profilingStatus' && payload === true) {
      isProfilingActive = true;
    }

    // Buffer operations during profiling — biggest main-thread saving.
    if (isProfilingActive && event === 'operations') {
      bufferedOperations.push(payload);
      return;
    }

    // Flush buffered operations before profilingData so ProfilerStore can build
    // commit data correctly.
    if (event === 'profilingData' && bufferedOperations.length > 0) {
      flushBufferedOperations();
      isProfilingActive = false;
    }

    // Backup flush — profilingData may not fire if no data was collected.
    if (event === 'profilingStatus' && payload === false) {
      if (bufferedOperations.length > 0) {
        flushBufferedOperations();
      }
      isProfilingActive = false;
    }

    postToProxy(event, payload);
  },
});

// Incoming transport (frontend → backend). proxy.js relays service-worker
// bridge messages as {source: 'react-profiler-frontend', payload: {event, payload}}.
window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== 'react-profiler-frontend') {
    return;
  }
  const message = event.data.payload;
  for (const listener of bridgeListeners) {
    listener(message);
  }
});

// ── 4. Command / response protocol (page API ↔ service worker) ──
let commandId = 0;
const pendingCommands = new Map();

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== 'react-profiler-response') {
    return;
  }
  const {id, result} = event.data.payload;
  const resolver = pendingCommands.get(id);
  if (resolver) {
    pendingCommands.delete(id);
    resolver(result);
  }
});

function sendCommand(action, args) {
  return new Promise((resolve) => {
    const id = ++commandId;
    pendingCommands.set(id, resolve);
    window.postMessage({source: 'react-profiler-command', payload: {id, action, args}}, '*');
  });
}

// ── 5. Public API ──
window.__REACT_PROFILER__ = {
  startProfiling() {
    return sendCommand('start');
  },
  stopProfiling() {
    return sendCommand('stop');
  },
  exportProfilingData() {
    return sendCommand('export');
  },
  isReady() {
    return sendCommand('isReady');
  },
  isProfiling() {
    return sendCommand('isProfiling');
  },
  _diagnostics() {
    return sendCommand('diagnostics');
  },
};
