/**
 * Frontend service worker (background script).
 *
 * Runs Store + ProfilerStore OFF the main thread, in Chrome's extension
 * service worker process. This matches real DevTools architecture where
 * the frontend runs in a separate process from the page.
 *
 * Key benefit: Store operations processing, element tracking, and profiling
 * data collection happen without interfering with React's scheduler on the
 * main thread — producing more natural commit batching patterns.
 *
 * Communicates with backend.js (MAIN world) via proxy.js (ISOLATED world)
 * using chrome.runtime port messaging.
 */

import Bridge from 'react-devtools-shared/src/bridge';
import Store from 'react-devtools-shared/src/devtools/store';
import ProfilerStore from 'react-devtools-shared/src/devtools/ProfilerStore';
import {prepareProfilingDataExport} from 'react-devtools-shared/src/devtools/views/Profiler/utils';

// Per-tab profiling state
const tabState = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'react-profiler-proxy') {
    return;
  }

  const tabId = port.sender?.tab?.id;
  if (tabId == null) {
    return;
  }

  // Clean up previous state for this tab (page reload)
  tabState.delete(tabId);

  // ── Frontend Bridge ──
  // Messages flow: service worker ↔ proxy.js ↔ backend.js (MAIN world)
  const bridge = new Bridge({
    listen(fn) {
      const handler = (message) => {
        if (message.type === 'bridge') {
          fn(message.payload);
        }
      };
      port.onMessage.addListener(handler);
      return () => port.onMessage.removeListener(handler);
    },
    send(event, payload, transferable) {
      try {
        port.postMessage({type: 'bridge', payload: {event, payload}});
      } catch (e) {
        // Port disconnected — page navigated away or closed
      }
    },
  });

  // ── Store + ProfilerStore ──
  const store = new Store(bridge, {
    supportsReloadAndProfile: false,
    supportsTimeline: false,
    supportsTraceUpdates: false,
  });

  const profilerStore = new ProfilerStore(bridge, store, false);

  // ── Shadow element map ──
  // Store removes unmounted elements from _idToElement. We keep a copy of
  // every element ever seen so that fibers created and destroyed during
  // profiling can still be resolved by name in the export.
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
  // Receives commands from page API via proxy, executes on Store/ProfilerStore.
  port.onMessage.addListener((message) => {
    if (message.type !== 'command') {
      return;
    }
    const {id, action, args} = message.payload;

    function respond(result) {
      try {
        port.postMessage({type: 'response', payload: {id, result}});
      } catch (e) {
        // Port disconnected
      }
    }

    switch (action) {
      case 'start': {
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

        // Safety timeout — ensure we always respond
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
          // ProfilerStore only snapshots elements at profiling START.
          // Elements mounted DURING profiling exist in the shadow map.
          data.dataForRoots.forEach((rootData) => {
            const snapshotMap = rootData.snapshots;
            const allFiberIds = new Set();

            rootData.commitData.forEach((commit) => {
              commit.fiberActualDurations.forEach((_duration, fiberId) =>
                allFiberIds.add(fiberId),
              );
              commit.fiberSelfDurations.forEach((_duration, fiberId) =>
                allFiberIds.add(fiberId),
              );
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

  // Clean up on disconnect (page closed or navigated away)
  port.onDisconnect.addListener(() => {
    tabState.delete(tabId);
  });
});
