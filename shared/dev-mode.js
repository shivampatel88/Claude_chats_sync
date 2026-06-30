// shared/dev-mode.js
// Secret developer mode for Claude Chat Tracker.
//
// Activated by clicking the "Claude Chats" title in the popup header 5 times.
// Persisted in chrome.storage.local under "devMode".
//
// Load order: must be the VERY FIRST script loaded in every context
// (popup.html and content_scripts in manifest.json).
//
// When devMode is OFF (default — all users):
//   - console.log/warn/info/debug/group/groupEnd are replaced with no-ops
//     in this JS context, silencing all other scripts automatically.
//   - All dev-only UI elements (export diag button, account stats, etc.) stay hidden.
//
// When devMode is ON (for the owner/dev):
//   - All console calls pass through normally.
//   - Export diagnostic log button appears.
//   - Account stats (Total Chats / Scanned / Embeddings) appear in the drawer.
//   - Popup width increases by 20% (416px → ~499px).
//   - A small amber [DEV] badge appears in the header.

"use strict";

(function () {
  const DEV_STORAGE_KEY = "devMode";

  // ── Synchronous placeholder ──────────────────────────────────────────────
  // Other scripts can read window.CCT_DEV_MODE at any time.
  // It starts false and is updated once the async storage read resolves.
  window.CCT_DEV_MODE = false;

  // ── Console silencer ─────────────────────────────────────────────────────
  // Replaces console output methods with no-ops for this entire JS context.
  // Called immediately when devMode is confirmed to be OFF.
  function _silenceLogs() {
    const noop = function () {};
    console.log   = noop;
    console.warn  = noop;
    console.info  = noop;
    console.debug = noop;
    console.group    = noop;
    console.groupEnd = noop;
  }

  // ── Public toggle ────────────────────────────────────────────────────────
  // Called by the 5-tap handler in popup.js.
  // Flips the devMode flag in storage and returns the new value.
  window.cctDevToggle = async function () {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local)
      return false;
    try {
      const stored = await chrome.storage.local.get([DEV_STORAGE_KEY]);
      const next = !stored[DEV_STORAGE_KEY];
      await chrome.storage.local.set({ [DEV_STORAGE_KEY]: next });
      return next;
    } catch (_) {
      return false;
    }
  };

  // ── Async init ───────────────────────────────────────────────────────────
  // Reads devMode from storage once on load. Exposes a Promise so popup.js
  // can await it before calling applyDevMode() and rendering.
  window.cctDevModeReady = (async function () {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
      // Plain-browser test environment — silence logs and bail out.
      _silenceLogs();
      return false;
    }
    try {
      const stored = await chrome.storage.local.get([DEV_STORAGE_KEY]);
      const isDev = !!stored[DEV_STORAGE_KEY];
      window.CCT_DEV_MODE = isDev;
      if (!isDev) _silenceLogs();
      return isDev;
    } catch (_) {
      _silenceLogs();
      return false;
    }
  })();
})();
