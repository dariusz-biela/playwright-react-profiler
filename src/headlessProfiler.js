/**
 * Headless React Profiler — runs the full DevTools profiling pipeline
 * without the DevTools UI panel.
 *
 * This is a Chrome extension content script (MAIN world, document_start)
 * that creates the same Store + ProfilerStore infrastructure as the
 * real DevTools Profiler tab, connected via an in-process paired Bridge.
 *
 * The exported profiling data is identical to what the DevTools "Export"
 * button produces — including full fiber tree snapshots with children,
 * hocDisplayNames, key, type, and compiledWithForget.
 *
 * Exposes: window.__REACT_PROFILER__
 */

import Agent from 'react-devtools-shared/src/backend/agent';
import {initBackend} from 'react-devtools-shared/src/backend';
import Bridge from 'react-devtools-shared/src/bridge';
import Store from 'react-devtools-shared/src/devtools/store';
import ProfilerStore from 'react-devtools-shared/src/devtools/ProfilerStore';
import {prepareProfilingDataExport} from 'react-devtools-shared/src/devtools/views/Profiler/utils';

const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
if (hook != null) {
  // ── Paired in-process Bridge ──
  // Backend and frontend both run in the page's MAIN world.
  // Wall delivery uses queueMicrotask to match Bridge's internal
  // batching behavior and avoid re-entrant event emission.
  let frontendListener = null;
  let backendListener = null;

  const backendBridge = new Bridge({
    listen(fn) {
      backendListener = fn;
      return () => {
        backendListener = null;
      };
    },
    send(event, payload) {
      const msg = {event, payload};
      queueMicrotask(() => {
        if (frontendListener) frontendListener(msg);
      });
    },
  });

  const frontendBridge = new Bridge({
    listen(fn) {
      frontendListener = fn;
      return () => {
        frontendListener = null;
      };
    },
    send(event, payload) {
      const msg = {event, payload};
      queueMicrotask(() => {
        if (backendListener) backendListener(msg);
      });
    },
  });

  // ── Frontend: Store + ProfilerStore ──
  const store = new Store(frontendBridge, {
    supportsReloadAndProfile: false,
    supportsTimeline: false,
    supportsTraceUpdates: false,
  });

  const profilerStore = new ProfilerStore(frontendBridge, store, false);

  // ── Backend: Agent + renderer interfaces ──
  const agent = new Agent(backendBridge, false, () => {});

  // ── Apply default component filters ──
  // The default Store filters hide host components (div, span, svg, etc.)
  // but are never sent to the backend automatically. In the real DevTools
  // extension, the panel UI pushes filters before the tree is processed.
  //
  // Since our content script runs at document_start (before React loads),
  // hook.rendererInterfaces is empty. We monkey-patch agent to apply
  // filters on each renderer as soon as it's registered.
  const defaultFilters = store.componentFilters;
  const origRegister = agent.registerRendererInterface.bind(agent);
  agent.registerRendererInterface = function(id, rendererInterface) {
    rendererInterface.updateComponentFilters(defaultFilters);
    return origRegister(id, rendererInterface);
  };

  initBackend(hook, agent, window, false);

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

  // ── Public API ──
  window.__REACT_PROFILER__ = {
    startProfiling() {
      profilerStore.startProfiling();
    },

    /**
     * Stop profiling and wait for data to arrive via Bridge.
     * Returns a Promise that resolves when profilerStore.profilingData is set.
     */
    stopProfiling() {
      return new Promise((resolve) => {
        const onData = () => {
          profilerStore.removeListener('profilingData', onData);
          profilerStore.removeListener('isProcessingData', onProcessing);
          resolve();
        };
        const onProcessing = () => {
          if (!profilerStore.isProcessingData) {
            profilerStore.removeListener('isProcessingData', onProcessing);
            profilerStore.removeListener('profilingData', onData);
            resolve();
          }
        };

        profilerStore.addListener('profilingData', onData);
        profilerStore.addListener('isProcessingData', onProcessing);
        profilerStore.stopProfiling();

        // Safety timeout
        setTimeout(() => {
          profilerStore.removeListener('profilingData', onData);
          profilerStore.removeListener('isProcessingData', onProcessing);
          resolve();
        }, 5000);
      });
    },

    exportProfilingData() {
      const data = profilerStore.profilingData;
      if (data == null) return null;

      // Enrich snapshots with elements created during profiling.
      // ProfilerStore only snapshots elements at profiling START.
      // Elements mounted DURING profiling exist in the shadow map or
      // can be resolved via the renderer interface.
      data.dataForRoots.forEach((rootData) => {
        const snapshotMap = rootData.snapshots;

        // Collect all fiber IDs from commit data (Maps in frontend format)
        const allFiberIds = new Set();
        rootData.commitData.forEach((commit) => {
          commit.fiberActualDurations.forEach((dur, id) => allFiberIds.add(id));
          commit.fiberSelfDurations.forEach((dur, id) => allFiberIds.add(id));
        });

        // Add missing elements from shadow map, then renderer fallback
        allFiberIds.forEach((id) => {
          if (snapshotMap.has(id)) return;

          const element = allElementsEverSeen.get(id);
          if (element != null) {
            snapshotMap.set(id, element);
            return;
          }

          // Last resort: query renderer interface for fibers the Store
          // never processed (internal React fibers not sent as operations)
          for (const rendererID in agent.rendererInterfaces) {
            const renderer = agent.rendererInterfaces[rendererID];
            const displayName = renderer.getDisplayNameForElementID(id);
            if (displayName != null) {
              snapshotMap.set(id, {
                id,
                children: [],
                displayName,
                hocDisplayNames: null,
                key: null,
                type: 0,
                compiledWithForget: false,
              });
              break;
            }
          }
        });
      });

      return prepareProfilingDataExport(data);
    },

    isReady() {
      return store.roots.length > 0;
    },

    isProfiling() {
      return profilerStore.isProfiling;
    },

    _diagnostics: {
      get shadowMapSize() {
        return allElementsEverSeen.size;
      },
      get storeElementCount() {
        return store._idToElement.size;
      },
      get storeRoots() {
        return store.roots.length;
      },
    },
  };
}
