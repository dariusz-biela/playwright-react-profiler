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

// ── 0. Reload-and-profile flag (the DevTools "Reload and profile" button) ──
// To capture the initial mount, profiling must start before React renders —
// which is impossible to request after the page has loaded. Real DevTools
// solves this by persisting a flag in sessionStorage, reloading, and reading
// the flag at document_start on the next load. We use the exact same keys, so
// profiler.reloadAndProfile() sets them from the page before reloading.
const RELOAD_AND_PROFILE_KEY = 'React::DevTools::reloadAndProfile';
const RECORD_CHANGE_DESCRIPTIONS_KEY = 'React::DevTools::recordChangeDescriptions';
const RECORD_TIMELINE_KEY = 'React::DevTools::recordTimeline';

function readReloadAndProfileState() {
  try {
    return {
      shouldStartProfilingNow: sessionStorage.getItem(RELOAD_AND_PROFILE_KEY) === 'true',
      recordChangeDescriptions: sessionStorage.getItem(RECORD_CHANGE_DESCRIPTIONS_KEY) === 'true',
      recordTimeline: sessionStorage.getItem(RECORD_TIMELINE_KEY) === 'true',
    };
  } catch (e) {
    // sessionStorage can throw (disabled cookies / sandboxed frame). Treat as
    // a normal load with no reload-and-profile request.
    return {shouldStartProfilingNow: false, recordChangeDescriptions: false, recordTimeline: false};
  }
}

function clearReloadAndProfileFlags() {
  try {
    sessionStorage.removeItem(RELOAD_AND_PROFILE_KEY);
    sessionStorage.removeItem(RECORD_CHANGE_DESCRIPTIONS_KEY);
    sessionStorage.removeItem(RECORD_TIMELINE_KEY);
  } catch (e) {
    // Nothing to clear if sessionStorage is unavailable.
  }
}

const reloadAndProfile = readReloadAndProfileState();

// ── 1. Install the DevTools hook before React initializes ──
// initialize() seeds the hook with getDefaultComponentFilters(), so host
// components (divs, etc.) are filtered out exactly as in the real DevTools.
// When reloadAndProfile is requested, the second argument starts profiling the
// moment each renderer attaches, so the initial mount is recorded.
initialize(undefined, reloadAndProfile.shouldStartProfilingNow, {
  recordChangeDescriptions: reloadAndProfile.recordChangeDescriptions,
  recordTimeline: reloadAndProfile.recordTimeline,
});

// ── 2. Outgoing transport (backend → frontend) with operations buffering ──
// On a reload-and-profile load, profiling is already active before the first
// commit, so buffer operations from the very first one.
let isProfilingActive = reloadAndProfile.shouldStartProfilingNow;
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
  // Reload-and-profile: tell the Agent profiling is already active so it
  // broadcasts profilingStatus(true) to the frontend ProfilerStore (which then
  // accepts the buffered mount operations on stop). The flags are one-shot —
  // connectWithCustomMessagingProtocol calls this reset right after wiring the
  // Agent, so an ordinary reload afterwards profiles nothing.
  isProfiling: reloadAndProfile.shouldStartProfilingNow,
  onReloadAndProfileFlagsReset: clearReloadAndProfileFlags,
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
  startProfiling(options) {
    return sendCommand('start', options);
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
