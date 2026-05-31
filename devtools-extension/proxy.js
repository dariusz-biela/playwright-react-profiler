/**
 * Proxy content script (ISOLATED world, document_start).
 *
 * Relays messages between the page (MAIN world) and the service worker.
 * MAIN world content scripts cannot access chrome.runtime — this script
 * bridges that gap using window.postMessage ↔ chrome.runtime.connect().
 *
 * Message protocol:
 *   Page → SW:  {source: 'react-profiler-backend', payload}  → {type: 'bridge', payload}
 *   Page → SW:  {source: 'react-profiler-command', payload}  → {type: 'command', payload}
 *   SW → Page:  {type: 'bridge', payload}  → {source: 'react-profiler-frontend', payload}
 *   SW → Page:  {type: 'response', payload} → {source: 'react-profiler-response', payload}
 *
 * Self-healing: an MV3 service worker is ephemeral — it is stopped when idle
 * (~30s) and, on a cold start (e.g. right after the SW-cache purge the launcher
 * does), the first connection can drop before the worker is ready. A single
 * connect() at load time would leave the page→SW channel permanently dead
 * (every command silently dropped) until a full page reload. Instead we
 * reconnect whenever the port drops, so the channel re-establishes itself
 * without a reload.
 */
(function () {
  'use strict';

  var port = null;
  var reconnectTimer = null;

  function relayFromWorker(message) {
    if (message.type === 'bridge') {
      window.postMessage({source: 'react-profiler-frontend', payload: message.payload}, '*');
    } else if (message.type === 'response') {
      window.postMessage({source: 'react-profiler-response', payload: message.payload}, '*');
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer !== null) {
      return;
    }
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, 250);
  }

  function connect() {
    try {
      port = chrome.runtime.connect({name: 'react-profiler-proxy'});
    } catch (e) {
      // Extension context not ready (or invalidated) — retry shortly.
      port = null;
      scheduleReconnect();
      return;
    }

    port.onMessage.addListener(relayFromWorker);

    port.onDisconnect.addListener(function () {
      port = null;
      // The worker stopped or the cold-start connection dropped — re-establish.
      scheduleReconnect();
    });
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window || !event.data) {
      return;
    }

    var source = event.data.source;
    if (source !== 'react-profiler-backend' && source !== 'react-profiler-command') {
      return;
    }

    if (!port) {
      // Channel is down (cold SW / recycled worker). Kick a reconnect; the page
      // side polls (isReady) and the backend re-emits operations on the next
      // commit, so a dropped message here is recovered, not fatal.
      scheduleReconnect();
      return;
    }

    var type = source === 'react-profiler-backend' ? 'bridge' : 'command';
    try {
      port.postMessage({type: type, payload: event.data.payload});
    } catch (e) {
      // Worker died between the null-check and post — drop the dead port and
      // reconnect for subsequent messages.
      port = null;
      scheduleReconnect();
    }
  });

  connect();
})();
