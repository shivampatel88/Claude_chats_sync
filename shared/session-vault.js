// shared/session-vault.js
// Provides persistent multi-session cookie snapshotting, restoration, and transient background swapping.
// Compatible with both background service worker (self) and popup context (window).

"use strict";

(function (root) {
  const VAULT_STORAGE_KEY = "sessionVault";
  const CLAUDE_DOMAINS = ["claude.ai", "anthropic.com", "auth.anthropic.com"];
  const VTAG = "[CCT-VAULT]";

  const vLog = (...a) => console.log(VTAG, ...a);
  const vWarn = (...a) => console.warn(VTAG, ...a);

  /**
   * Clears all authentication and session cookies for Claude.ai and Anthropic domains.
   */
  async function clearClaudeCookies() {
    if (typeof chrome === "undefined" || !chrome.cookies) return;
    try {
      for (const domain of CLAUDE_DOMAINS) {
        const cookies = await chrome.cookies.getAll({ domain });
        await Promise.all(
          cookies.map((cookie) => {
            const host = cookie.domain.startsWith(".")
              ? cookie.domain.slice(1)
              : cookie.domain;
            const parts = host.split(".");
            const rootDomain =
              parts.length >= 2 ? parts.slice(-2).join(".") : host;
            const path = cookie.path || "/";
            const urlVariants = [
              `https://${host}${path}`,
              `http://${host}${path}`,
              `https://www.${rootDomain}${path}`,
              `http://www.${rootDomain}${path}`,
            ];
            return Promise.all(
              urlVariants.map((url) =>
                chrome.cookies
                  .remove({ url, name: cookie.name, storeId: cookie.storeId })
                  .catch(() => {}),
              ),
            );
          }),
        );
      }
    } catch (err) {
      vWarn("Error clearing Claude cookies:", err);
    }
  }

  /**
   * Retrieves all current cookies for Claude and Anthropic domains from the browser cookie jar.
   */
  async function getActiveClaudeCookies() {
    if (typeof chrome === "undefined" || !chrome.cookies) return [];
    const all = [];
    for (const domain of CLAUDE_DOMAINS) {
      try {
        const list = await chrome.cookies.getAll({ domain });
        all.push(...list);
      } catch (err) {
        vWarn("Error reading cookies for domain", domain, err);
      }
    }
    // Deduplicate by name + domain + path
    const seen = new Set();
    const result = [];
    for (const c of all) {
      const key = `${c.domain}|${c.path}|${c.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          expirationDate: c.expirationDate,
          storeId: c.storeId,
        });
      }
    }
    return result;
  }

  /**
   * Injects an array of serialized cookie objects into the browser cookie jar.
   */
  async function injectCookies(cookies) {
    if (typeof chrome === "undefined" || !chrome.cookies || !Array.isArray(cookies)) {
      return 0;
    }
    let injected = 0;
    for (const c of cookies) {
      try {
        const host = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
        const protocol = c.secure ? "https:" : "http:";
        const url = `${protocol}//${host}${c.path || "/"}`;
        const details = {
          url,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || "/",
          secure: c.secure !== false,
          httpOnly: c.httpOnly !== false,
          storeId: c.storeId,
        };
        if (c.sameSite && c.sameSite !== "unspecified") {
          details.sameSite = c.sameSite;
        }
        if (typeof c.expirationDate === "number") {
          details.expirationDate = c.expirationDate;
        }
        await chrome.cookies.set(details);
        injected++;
      } catch (err) {
        vWarn("Failed to inject cookie", c.name, err);
      }
    }
    return injected;
  }

  /**
   * Captures the current browser session cookies and saves them for the specified accountId.
   */
  async function captureSession(accountId, email = null, orgId = null) {
    if (!accountId) return null;
    const cookies = await getActiveClaudeCookies();
    if (cookies.length === 0) {
      vWarn("No cookies found to capture for account:", accountId);
      return null;
    }

    // Verify presence of session key
    const hasSessionKey = cookies.some((c) => c.name === "sessionKey" && c.value);
    if (!hasSessionKey) {
      vWarn("Active session does not contain sessionKey; skipping capture for", accountId);
      return null;
    }

    // Extract orgId from parameter or lastActiveOrg cookie
    let resolvedOrgId = orgId;
    if (!resolvedOrgId) {
      const orgCookie = cookies.find((c) => c.name === "lastActiveOrg" && c.value);
      if (orgCookie) {
        resolvedOrgId = orgCookie.value;
      }
    }

    const data = await chrome.storage.local.get(VAULT_STORAGE_KEY);
    const vault = data[VAULT_STORAGE_KEY] || {};

    const existing = vault[accountId] || {};
    vault[accountId] = {
      accountId,
      orgId: resolvedOrgId || existing.orgId || null,
      email: email || existing.email || null,
      savedAt: Date.now(),
      expired: false,
      cookies,
    };

    await chrome.storage.local.set({ [VAULT_STORAGE_KEY]: vault });
    vLog(`💾 Session vault saved for ${accountId} (${email || "no email"}) with ${cookies.length} cookies (orgId: ${resolvedOrgId || "unknown"})`);
    return vault[accountId];
  }

  /**
   * Restores a previously saved session for accountId into the browser cookie jar.
   */
  async function restoreSession(accountId) {
    if (!accountId) return { ok: false, error: "NO_ACCOUNT_ID" };
    const data = await chrome.storage.local.get(VAULT_STORAGE_KEY);
    const vault = data[VAULT_STORAGE_KEY] || {};
    const session = vault[accountId];

    if (!session || !Array.isArray(session.cookies) || session.cookies.length === 0) {
      return { ok: false, error: "NO_SAVED_SESSION" };
    }

    // 1. Wipe current cookies
    await clearClaudeCookies();

    // 2. Inject target account's cookies
    const count = await injectCookies(session.cookies);

    // 3. Mark current active account in local storage
    await chrome.storage.local.set({ currentAccountId: accountId });

    vLog(`🔓 Restored session for ${accountId} (${count} cookies injected)`);
    return { ok: true, accountId, count };
  }

  /**
   * Checks whether a saved session exists for accountId.
   */
  async function hasSavedSession(accountId) {
    if (!accountId) return false;
    const data = await chrome.storage.local.get(VAULT_STORAGE_KEY);
    const vault = data[VAULT_STORAGE_KEY] || {};
    const s = vault[accountId];
    return Boolean(s && Array.isArray(s.cookies) && s.cookies.length > 0 && !s.expired);
  }

  /**
   * Retrieves summary metadata for all sessions in the vault without leaking sensitive cookie values.
   */
  async function getAllSessionMetadata() {
    const data = await chrome.storage.local.get(VAULT_STORAGE_KEY);
    const vault = data[VAULT_STORAGE_KEY] || {};
    const meta = {};
    for (const [accId, s] of Object.entries(vault)) {
      meta[accId] = {
        accountId: s.accountId,
        email: s.email || null,
        savedAt: s.savedAt || 0,
        expired: Boolean(s.expired),
        cookieCount: Array.isArray(s.cookies) ? s.cookies.length : 0,
      };
    }
    return meta;
  }

  /**
   * Flags a session as expired in the vault (e.g. when an API call returns 401/403).
   */
  async function markSessionExpired(accountId) {
    if (!accountId) return;
    const data = await chrome.storage.local.get(VAULT_STORAGE_KEY);
    const vault = data[VAULT_STORAGE_KEY] || {};
    if (vault[accountId]) {
      vault[accountId].expired = true;
      await chrome.storage.local.set({ [VAULT_STORAGE_KEY]: vault });
      vWarn(`⚠️ Session marked as expired for account ${accountId}`);
    }
  }

  /**
   * Removes a saved session from the vault.
   */
  async function removeSavedSession(accountId) {
    if (!accountId) return;
    const data = await chrome.storage.local.get(VAULT_STORAGE_KEY);
    const vault = data[VAULT_STORAGE_KEY] || {};
    if (vault[accountId]) {
      delete vault[accountId];
      await chrome.storage.local.set({ [VAULT_STORAGE_KEY]: vault });
      vLog(`🗑️ Session vault deleted for ${accountId}`);
    }
  }

  // Export onto root (window or self)
  root.CctVault = {
    captureSession,
    restoreSession,
    hasSavedSession,
    getAllSessionMetadata,
    markSessionExpired,
    removeSavedSession,
    clearClaudeCookies,
    getActiveClaudeCookies,
    injectCookies,
  };
})(typeof window !== "undefined" ? window : self);
