/**
 * Backend content script (MAIN world, document_start).
 *
 * Runs the React DevTools Agent on the page's main thread.
 * Communicates with the frontend (Store/ProfilerStore in service worker)
 * via window.postMessage through proxy.js (ISOLATED world).
 *
 * This matches real DevTools architecture: backend on main thread,
 * frontend in a separate process. The key benefit is that Store/ProfilerStore
 * processing happens off the main thread, reducing interference with
 * React's scheduler and producing more natural commit batching patterns.
 *
 * Exposes: window.__REACT_PROFILER__ (all methods return Promises)
 */

import Agent from 'react-devtools-shared/src/backend/agent';
import {initBackend} from 'react-devtools-shared/src/backend';
import Bridge from 'react-devtools-shared/src/bridge';
import {getDefaultComponentFilters} from 'react-devtools-shared/src/utils';

const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
if (hook != null) {
  // ── Bridge wall ──
  // Messages flow: backend.js ↔ proxy.js ↔ service worker (frontend.js)
  // MAIN world cannot access chrome.runtime, so we use window.postMessage
  // to reach proxy.js in the ISOLATED world.
  const bridge = new Bridge({
    listen(fn) {
      const handler = (event) => {
        if (
          event.source !== window ||
          event.data?.source !== 'react-profiler-frontend'
        ) {
          return;
        }
        fn(event.data.payload);
      };
      window.addEventListener('message', handler);
      return () => window.removeEventListener('message', handler);
    },
    send(event, payload, transferable) {
      window.postMessage(
        {source: 'react-profiler-backend', payload: {event, payload}},
        '*',
        transferable,
      );
    },
  });

  // ── Agent ──
  const agent = new Agent(bridge, false, () => {});

  // ── Apply default component filters ──
  // Hide host components (div, span, svg, etc.) same as real DevTools.
  // Must be applied before flushInitialOperations — monkey-patch
  // registerRendererInterface since renderers aren't attached yet at
  // document_start.
  const defaultFilters = getDefaultComponentFilters();
  const origRegister = agent.registerRendererInterface.bind(agent);
  agent.registerRendererInterface = function (id, rendererInterface) {
    rendererInterface.updateComponentFilters(defaultFilters);
    return origRegister(id, rendererInterface);
  };

  initBackend(hook, agent, window, false);

  // ── Command / response protocol ──
  // Page API sends commands to service worker via proxy, receives responses.
  let commandId = 0;
  const pendingCommands = new Map();

  window.addEventListener('message', (event) => {
    if (
      event.source !== window ||
      event.data?.source !== 'react-profiler-response'
    ) {
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
      window.postMessage(
        {
          source: 'react-profiler-command',
          payload: {id, action, args},
        },
        '*',
      );
    });
  }

  // ── Public API ──
  // All methods return Promises (cross-process communication).
  window.__REACT_PROFILER__ = {
    startProfiling(recordChangeDescriptions) {
      return sendCommand('start', {recordChangeDescriptions});
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
}
