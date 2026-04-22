/**
 * Profiler Bridge — auto-activates React DevTools backend and exposes
 * profiling controls on the hook.
 *
 * Runs as a Chrome extension content script (MAIN world, document_start)
 * AFTER installHook.js and react_devtools_backend_compact.js.
 *
 * The extension approach keeps DevTools plumbing off the page's JS thread:
 *   - Hook installation is handled by Chrome's content-script loader
 *   - Backend registration happens before page JS executes
 *   - Bridge uses a no-op wall (no IPC serialization overhead)
 *   - Only the renderer interface callbacks (startProfiling/stopProfiling)
 *     touch the main thread — and those are React's own instrumentation hooks
 *
 * Exposes: window.__REACT_DEVTOOLS_GLOBAL_HOOK__.__profilerAgent__
 *   with { rendererInterfaces } populated by the Agent after React registers.
 */
(function () {
  'use strict';

  var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) return;

  var backend = hook.backends && hook.backends.get('compact');
  if (!backend) return;

  var Agent = backend.Agent;
  var Bridge = backend.Bridge;
  var initBackend = backend.initBackend;

  // No-op bridge — we don't need DevTools UI communication.
  // This avoids the serialization/messaging overhead of a real bridge.
  var bridge = new Bridge({
    listen: function () {
      return function () {};
    },
    send: function () {},
  });

  var agent = new Agent(bridge, false, function () {});
  initBackend(hook, agent, window, false);

  // Expose the agent on the hook so Playwright can access renderer interfaces.
  // Using defineProperty to avoid enumeration in DevTools console noise.
  Object.defineProperty(hook, '__profilerAgent__', {
    value: agent,
    configurable: true,
    enumerable: false,
  });
})();