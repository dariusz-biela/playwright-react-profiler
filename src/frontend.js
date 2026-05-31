/**
 * Frontend service worker (background script).
 *
 * Runs Store + ProfilerStore OFF the page main thread, in Chrome's extension
 * service-worker process. This matches real DevTools architecture, where the
 * frontend lives in a different process from the page.
 *
 * Built from the published `react-devtools-inline` package: createBridge +
 * createStore give the same react-devtools-shared Store/ProfilerStore that the
 * official extension uses, so operations recorded here and the export produced
 * by the vendored prepareProfilingDataExport import into a same-versioned
 * (7.0.x) React DevTools extension with zero mapping.
 *
 * A service worker has no DOM, but the inline frontend bundle injects its
 * stylesheet at module-load time. scripts/build-devtools.mjs prepends a minimal
 * DOM stub via the esbuild banner so the bundle loads; the DevTools UI is never
 * mounted (we only use Store/ProfilerStore), so the stub is never otherwise hit.
 *
 * Communicates with backend.js (MAIN world) via proxy.js (ISOLATED world) using
 * chrome.runtime port messaging.
 */

import {createBridge, createStore} from 'react-devtools-inline/frontend';
import {prepareProfilingDataExport} from './vendor/prepareProfilingDataExport';

// Per-tab profiling state.
const tabState = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'react-profiler-proxy') {
    return;
  }

  const tabId = port.sender?.tab?.id;
  if (tabId == null) {
    return;
  }

  // Clean up previous state for this tab (page reload).
  tabState.delete(tabId);

  // ── Frontend Bridge ──
  // Messages flow: service worker ↔ proxy.js ↔ backend.js (MAIN world).
  const wall = {
    listen(fn) {
      const handler = (message) => {
        if (message.type === 'bridge') {
          fn(message.payload);
        }
      };
      port.onMessage.addListener(handler);
      return () => port.onMessage.removeListener(handler);
    },
    send(event, payload) {
      try {
        port.postMessage({type: 'bridge', payload: {event, payload}});
      } catch (e) {
        // Port disconnected — page navigated away or closed.
      }
    },
  };

  const bridge = createBridge(null, wall);

  // ── Store + ProfilerStore ──
  const store = createStore(bridge, {
    supportsReloadAndProfile: false,
    supportsTimeline: false,
    supportsTraceUpdates: false,
    checkBridgeProtocolCompatibility: false,
  });

  const profilerStore = store.profilerStore;

  // ── Shadow element map ──
  // Store removes unmounted elements from _idToElement. We keep a copy of every
  // element ever seen so fibers created and destroyed during profiling can still
  // be resolved by name in the export.
  const allElementsEverSeen = new Map();
  const origSet = store._idToElement.set.bind(store._idToElement);
  store._idToElement.set = function (id, element) {
    allElementsEverSeen.set(id, {
      id: element.id,
      children: element.children.slice(),
      displayName: element.displayName,
      hocDisplayNames: element.hocDisplayNames,
      key: element.key,
      type: element.type,
      compiledWithForget: element.compiledWithForget,
    });
    return origSet(id, element);
  };

  const state = {store, profilerStore, allElementsEverSeen};
  tabState.set(tabId, state);

  // ── Command handler ──
  // Receives commands from the page API via proxy, executes on Store/ProfilerStore.
  port.onMessage.addListener((message) => {
    if (message.type !== 'command') {
      return;
    }
    const {id, action, args} = message.payload;

    function respond(result) {
      try {
        port.postMessage({type: 'response', payload: {id, result}});
      } catch (e) {
        // Port disconnected.
      }
    }

    switch (action) {
      case 'start': {
        // Opt-in "Record why each component rendered". Off by default to keep
        // profiling overhead minimal; render durations are unaffected either way.
        store.recordChangeDescriptions = args?.recordChangeDescriptions === true;
        profilerStore.startProfiling();
        respond(true);
        break;
      }

      case 'stop': {
        const onData = () => {
          profilerStore.removeListener('profilingData', onData);
          profilerStore.removeListener('isProcessingData', onProcessing);
          respond(true);
        };
        const onProcessing = () => {
          if (!profilerStore.isProcessingData) {
            profilerStore.removeListener('isProcessingData', onProcessing);
            profilerStore.removeListener('profilingData', onData);
            respond(true);
          }
        };

        profilerStore.addListener('profilingData', onData);
        profilerStore.addListener('isProcessingData', onProcessing);
        profilerStore.stopProfiling();

        // Safety timeout — ensure we always respond.
        setTimeout(() => {
          profilerStore.removeListener('profilingData', onData);
          profilerStore.removeListener('isProcessingData', onProcessing);
          respond(true);
        }, 5000);
        break;
      }

      case 'export': {
        try {
          const data = profilerStore.profilingData;
          if (data == null) {
            respond(null);
            break;
          }

          // Enrich snapshots with elements created during profiling.
          // ProfilerStore only snapshots elements at profiling START; elements
          // mounted DURING profiling exist in the shadow map.
          data.dataForRoots.forEach((rootData) => {
            const snapshotMap = rootData.snapshots;
            const allFiberIds = new Set();

            rootData.commitData.forEach((commit) => {
              commit.fiberActualDurations.forEach((_duration, fiberId) => allFiberIds.add(fiberId));
              commit.fiberSelfDurations.forEach((_duration, fiberId) => allFiberIds.add(fiberId));
            });

            allFiberIds.forEach((fiberId) => {
              if (snapshotMap.has(fiberId)) {
                return;
              }
              const element = allElementsEverSeen.get(fiberId);
              if (element != null) {
                snapshotMap.set(fiberId, element);
              }
            });
          });

          respond(prepareProfilingDataExport(data));
        } catch (e) {
          respond({error: String(e), stack: e?.stack});
        }
        break;
      }

      case 'isReady': {
        respond(store.roots.length > 0);
        break;
      }

      case 'isProfiling': {
        respond(profilerStore.isProfiling);
        break;
      }

      case 'diagnostics': {
        respond({
          shadowMapSize: allElementsEverSeen.size,
          storeElementCount: store._idToElement.size,
          storeRoots: store.roots.length,
        });
        break;
      }

      default: {
        respond(null);
      }
    }
  });

  // Clean up on disconnect (page closed or navigated away).
  port.onDisconnect.addListener(() => {
    tabState.delete(tabId);
  });
});
