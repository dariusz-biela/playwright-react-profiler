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
 */
(function () {
  'use strict';

  var port = null;

  function connect() {
    port = chrome.runtime.connect({name: 'react-profiler-proxy'});

    port.onMessage.addListener(function (message) {
      if (message.type === 'bridge') {
        window.postMessage(
          {source: 'react-profiler-frontend', payload: message.payload},
          '*',
        );
      } else if (message.type === 'response') {
        window.postMessage(
          {source: 'react-profiler-response', payload: message.payload},
          '*',
        );
      }
    });

    port.onDisconnect.addListener(function () {
      port = null;
    });
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window || !event.data || !port) {
      return;
    }

    var source = event.data.source;
    var payload = event.data.payload;

    if (source === 'react-profiler-backend') {
      port.postMessage({type: 'bridge', payload: payload});
    } else if (source === 'react-profiler-command') {
      port.postMessage({type: 'command', payload: payload});
    }
  });

  connect();
})();
