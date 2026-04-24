/**
 * Backend content script (MAIN world, document_start).
 *
 * Runs the React DevTools Agent on the page's main thread.
 * Communicates with the frontend (Store/ProfilerStore in service worker)
 * via window.postMessage through proxy.js (ISOLATED world).
 *
 * Optimization: during profiling, 'operations' events are buffered instead
 * of being sent via postMessage per commit. This eliminates structured
 * cloning overhead on the main thread during profiling. Buffered operations
 * are flushed in one burst before profilingData arrives.
 *
 * Exposes: window.__REACT_PROFILER__ (all methods return Promises)
 */

import Agent from 'react-devtools-shared/src/backend/agent';
import {initBackend} from 'react-devtools-shared/src/backend';
import Bridge from 'react-devtools-shared/src/bridge';
import {getDefaultComponentFilters} from 'react-devtools-shared/src/utils';

const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
if (hook != null) {
  // ── Operations buffering ──
  // During profiling, buffer 'operations' events to avoid per-commit
  // postMessage overhead. Flush them before profilingData so ProfilerStore
  // receives operations in correct order.
  let isProfilingActive = false;
  const bufferedOperations = [];

  function postToProxy(event, payload, transferable) {
    window.postMessage(
      {source: 'react-profiler-backend', payload: {event, payload}},
      '*',
      transferable,
    );
  }

  // ── Bridge wall ──
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
      // Detect profiling start
      if (event === 'profilingStatus' && payload === true) {
        isProfilingActive = true;
      }

      // Buffer operations during profiling — biggest main thread savings
      if (isProfilingActive && event === 'operations') {
        bufferedOperations.push(payload);
        return;
      }

      // Flush buffered operations before profilingData arrives
      // ProfilerStore needs operations to build commit data correctly
      if (event === 'profilingData' && bufferedOperations.length > 0) {
        for (let i = 0; i < bufferedOperations.length; i++) {
          postToProxy('operations', bufferedOperations[i]);
        }
        bufferedOperations.length = 0;
        isProfilingActive = false;
      }

      // Detect profiling stop (backup — profilingData may not fire if no data)
      if (event === 'profilingStatus' && payload === false) {
        if (bufferedOperations.length > 0) {
          for (let i = 0; i < bufferedOperations.length; i++) {
            postToProxy('operations', bufferedOperations[i]);
          }
          bufferedOperations.length = 0;
        }
        isProfilingActive = false;
      }

      postToProxy(event, payload, transferable);
    },
  });

  // ── Agent ──
  const agent = new Agent(bridge, false, () => {});

  // ── Apply default component filters ──
  const defaultFilters = getDefaultComponentFilters();
  const origRegister = agent.registerRendererInterface.bind(agent);
  agent.registerRendererInterface = function (id, rendererInterface) {
    rendererInterface.updateComponentFilters(defaultFilters);
    return origRegister(id, rendererInterface);
  };

  initBackend(hook, agent, window, false);

  // ── Command / response protocol ──
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
}
