// shared/diag-logger.js
// Persistent diagnostic ring buffer for Claude Chat Tracker.
//
// Captures two classes of events:
//   'identity-decision'  — logged by saveScrape() on every save; records what
//                          evidence was used to determine the scraping account.
//   'chatId-collision'   — logged by mergeChats() when the same chatId appears
//                          under two different non-fallback accountIds.
//
// Events are batched in memory and flushed to chrome.storage.local['cct_diag_v1']
// with a 6-second debounce, and immediately on tab visibility hide.
//
// API (exposed on window.cctDiag):
//   push(category, data)  — record one event (non-blocking)
//   export()              — flush + return full log as an array
//   clear()               — wipe buffer and storage
//
// Load order: must be loaded BEFORE shared.js and content-script.js.

'use strict';

(function () {
  const CCT_DIAG_KEY = 'cct_diag_v1';
  const MAX_ENTRIES  = 300;

  // In-memory staging buffer (not yet written to storage).
  const _buf = [];
  let _timer = null;

  function _push(category, data) {
    _buf.push({ t: Date.now(), c: category, d: data });
    // Trim buffer if it grows beyond 2× cap (prevents unbounded growth on high-event pages).
    if (_buf.length > MAX_ENTRIES * 2) {
      _buf.splice(0, _buf.length - MAX_ENTRIES);
    }
    // Debounce the storage flush — coalesce rapid successive events.
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(_flush, 6000);
  }

  async function _flush() {
    _timer = null;
    if (_buf.length === 0) return;
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    try {
      const stored  = await chrome.storage.local.get([CCT_DIAG_KEY]);
      const prev    = Array.isArray(stored[CCT_DIAG_KEY]) ? stored[CCT_DIAG_KEY] : [];
      // Drain the in-memory buffer into storage, then trim to MAX_ENTRIES.
      const merged  = [...prev, ..._buf].slice(-MAX_ENTRIES);
      _buf.length   = 0;
      await chrome.storage.local.set({ [CCT_DIAG_KEY]: merged });
    } catch (_) {
      // Non-fatal — silently discard if storage is unavailable.
    }
  }

  async function _export() {
    await _flush();
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return [];
    try {
      const stored = await chrome.storage.local.get([CCT_DIAG_KEY]);
      return stored[CCT_DIAG_KEY] || [];
    } catch (_) {
      return [];
    }
  }

  async function _clear() {
    _buf.length = 0;
    if (_timer) { clearTimeout(_timer); _timer = null; }
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    try {
      await chrome.storage.local.remove([CCT_DIAG_KEY]);
    } catch (_) {}
  }

  // Flush when the tab/popup goes hidden — ensures events are not lost when the
  // service worker sleeps or the popup closes before the debounce fires.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) _flush();
    });
  }

  // Expose the public API on window so both content scripts and popup.js can use it.
  if (typeof window !== 'undefined') {
    window.cctDiag = {
      push:   _push,
      export: _export,
      clear:  _clear
    };
  }
})();
