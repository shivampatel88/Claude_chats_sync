(function () {
  "use strict";

  const STORAGE_KEYS = {
    accounts: "accounts",
    chats: "chats",
    currentAccountId: "currentAccountId",
    syncStatus: "syncStatus",
    pendingOpen: "pendingOpen",
    profileLocalId: "profileLocalId",
  };

  const SYNC_KEYS = {
    accounts: "syncAccounts",
    meta: "syncMeta",
    chatPrefix: "syncChats_",
    deletedAccounts: "syncDeletedAccounts",
  };

  const ACCOUNT_COLORS = [
    "#4A90D9",
    "#D9784A",
    "#45A878",
    "#8D66CC",
    "#C9A227",
    "#2D9BA3",
    "#C85C7A",
    "#789A45",
  ];

  const ACCOUNT_SELECTORS = [
    '[data-testid="user-menu-email"]',
    '[data-testid="account-email"]',
    '[data-testid*="account"]',
    '[data-testid*="user"]',
    '[aria-label*="@"]',
    'button[aria-label*="account" i]',
    'button[aria-label*="profile" i]',
    "nav",
    "aside",
    '[role="navigation"]',
    "header",
  ];

  const CHAT_LINK_SELECTOR = 'a[href*="/chat/"]';
  const CHAT_CONTAINER_SELECTOR = 'aside, nav, [role="navigation"]';
  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const SCRAPE_DEBOUNCE_MS = 1200;
  const INITIAL_RETRY_DELAYS = [800, 1800, 3500, 6000, 12000, 20000];
  // Fallback display name shown when Claude does not expose an email address
  const FALLBACK_ACCOUNT_NAME = "Current Claude account";

  // Set during init to a value unique per Chrome profile — never shared across profiles
  let profileFallbackAccountId = null;
  const MIN_SYNC_INTERVAL_MS = 30000;
  const PENDING_OPEN_TTL_MS = 60 * 1000;

  // Phase 5: pending sync payload — populated by saveScrape(), flushed on idle/hide.
  let pendingSyncAccounts = null;
  let pendingSyncChats = null;
  let idleSyncTimer = null;
  const IDLE_SYNC_DELAY_MS = 5 * 60 * 1000; // 5 minutes of user inactivity
  const MIGRATION_DOUBLED_TITLES_V1 = "migration_doubledTitles_v1";
  // V2: re-run migration after deduplicate() was extended to title attr + span paths.
  const MIGRATION_DOUBLED_TITLES_V2 = "migration_doubledTitles_v2";

  // API-based timestamp sync: fetch real conversation updatedAt from Claude's internal API.
  const API_SYNC_INTERVAL_MS = 60 * 1000; // at most once per 60 s
  let cachedOrgId = null; // cached so we don't re-fetch /api/organizations every time
  let lastApiSyncAt = 0; // epoch ms of last successful API call

  let scrapeTimer = null;
  let syncTimer = null;
  let observer = null;
  let accountObserver = null;
  let lastSnapshot = "";
  let lastSyncAt = 0;
  let lastDetectedEmail = null; // persisted email seed so first scrape uses real identity
  let cookieDetectedEmail = null; // email extracted from auth-cookie JWT by background worker at init

  // Gate that resolves when identity is confirmed — scrapes wait on this.
  let identityReadyResolve;
  const identityReady = new Promise(resolve => {
    identityReadyResolve = resolve;
  });
  let warnedMissingAccount = false;
  let warnedStorageUnavailable = false;
  let stopped = false;
  let pendingToast = null;
  let pendingNavigationTimer = null;
  let pendingNavigationScheduled = false; // true while the redirect/logout timer is pending on the landing page
  let googleStartTimer = null;

  // ─── Structured debug logging ──────────────────────────────────────────────────
  const CCT = "[CCT]";
  const cctLog = (...a) => console.log(CCT, ...a);
  const cctWarn = (...a) => console.warn(CCT, ...a);
  const cctError = (...a) => console.error(CCT, ...a);
  const cctGroup = (label) => console.group(`${CCT} ${label}`);
  const cctGroupEnd = () => console.groupEnd();
  // ────────────────────────────────────────────────────────────

  function isExtensionContextInvalidated(error) {
    return /extension context invalidated/i.test(
      String(error && (error.message || error)),
    );
  }

  function stopTracking() {
    stopped = true;
    pendingNavigationScheduled = false;
    window.clearTimeout(scrapeTimer);
    window.clearTimeout(syncTimer);
    window.clearTimeout(pendingNavigationTimer);
    window.clearTimeout(googleStartTimer);
    window.clearTimeout(accountCheckTimer);
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (accountObserver) {
      accountObserver.disconnect();
      accountObserver = null;
    }
  }

  function hasStorageApi() {
    try {
      return (
        !stopped &&
        typeof chrome !== "undefined" &&
        chrome.runtime &&
        chrome.runtime.id &&
        chrome.storage &&
        chrome.storage.local &&
        typeof chrome.storage.local.get === "function" &&
        typeof chrome.storage.local.set === "function"
      );
    } catch (_error) {
      return false;
    }
  }

  function hasSyncApi() {
    try {
      return (
        !stopped &&
        typeof chrome !== "undefined" &&
        chrome.runtime &&
        chrome.runtime.id &&
        chrome.storage &&
        chrome.storage.sync &&
        typeof chrome.storage.sync.get === "function" &&
        typeof chrome.storage.sync.set === "function"
      );
    } catch (_error) {
      return false;
    }
  }

  async function storageGet(keys) {
    if (!hasStorageApi()) return {};
    try {
      return await chrome.storage.local.get(keys);
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        stopTracking();
        return {};
      }
      throw error;
    }
  }

  async function storageSet(value) {
    if (!hasStorageApi()) return;
    try {
      return await chrome.storage.local.set(value);
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        stopTracking();
        return;
      }
      throw error;
    }
  }

  async function syncGet(keys) {
    if (!hasSyncApi()) return {};
    try {
      return await chrome.storage.sync.get(keys);
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        stopTracking();
        return {};
      }
      throw error;
    }
  }

  async function syncSet(value) {
    if (!hasSyncApi()) return;
    try {
      return await chrome.storage.sync.set(value);
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        stopTracking();
        return;
      }
      throw error;
    }
  }

  async function syncRemove(keys) {
    if (!hasSyncApi()) return;
    try {
      return await chrome.storage.sync.remove(keys);
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        stopTracking();
        return;
      }
      throw error;
    }
  }

  function textOf(element) {
    return (element && element.textContent ? element.textContent : "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function removePendingToast() {
    if (pendingToast) {
      pendingToast.remove();
      pendingToast = null;
    }
  }

  // NOTE: chrome.storage.session is NOT available in content scripts — it throws
  // "Access to storage is not allowed from this context" even though the API object exists.
  // Content scripts can only access chrome.storage.local and chrome.storage.sync.
  // pendingOpen therefore stays in chrome.storage.local; the popup reads/writes it there too.
  async function getPendingOpen() {
    const data = await storageGet([STORAGE_KEYS.pendingOpen]);
    return data[STORAGE_KEYS.pendingOpen] || null;
  }

  async function setPendingOpen(value) {
    return storageSet({ [STORAGE_KEYS.pendingOpen]: value });
  }

  async function clearPendingOpen() {
    await storageSet({ [STORAGE_KEYS.pendingOpen]: null });
    removePendingToast();
    window.clearTimeout(pendingNavigationTimer);
    pendingNavigationScheduled = false;
  }

  function sameClaudeChatUrl(a, b) {
    try {
      const left = new URL(a, location.origin);
      const right = new URL(b, location.origin);
      return left.pathname === right.pathname;
    } catch (_error) {
      return false;
    }
  }

  function isLoginPage() {
    return location.pathname.startsWith("/login");
  }

  function isPostLoginLandingPage() {
    return location.pathname === "/" || location.pathname === "/new";
  }

  function shouldHandlePendingOpenHere(pendingOpen) {
    // isPendingFlowUrl (ctt param) was removed: Google OAuth strips all custom query params,
    // so the ctt value can never be verified after the OAuth redirect.
    return (
      isLoginPage() ||
      isPostLoginLandingPage() ||
      sameClaudeChatUrl(location.href, pendingOpen.chatUrl)
    );
  }

  // Finds the "Continue with Google" (or equivalent) button on Claude's login page.
  // Handles text-based, aria-label-based, and image/SVG-based Google buttons.
  // BUG-04 fix: removed the text.length === 0 fallback that matched any icon-only button.
  function findGoogleSignInElement() {
    const candidates = Array.from(
      document.querySelectorAll('button, a, [role="button"]'),
    );
    return candidates.find((element) => {
      const aria = (element.getAttribute("aria-label") || "").toLowerCase();
      // Rule 1: If aria-label contains google, match it.
      if (aria.includes("google")) {
        return true;
      }

      // Rule 2: If a child image alt or src contains google, match it.
      const hasChildImgGoogle = Boolean(
        element.querySelector('img[src*="google" i], img[alt*="google" i]'),
      );
      if (hasChildImgGoogle) {
        return true;
      }

      // Rule 3: If only visible text contains google, also require one action word
      const text = textOf(element).toLowerCase();
      if (text.includes("google")) {
        const hasActionWord =
          text.includes("continue") ||
          text.includes("sign") ||
          text.includes("log");
        if (hasActionWord) {
          return true;
        }
      }

      // Rule 4: Never match a button that has no Google reference.
      return false;
    });
  }

  // Polls for the Google sign-in button and clicks it automatically.
  // Uses an interval-based loop instead of recursive setTimeout so a slow page load
  // (which is common after a logout redirect) is handled reliably.
  async function startGoogleLoginIfAvailable(pendingOpen) {
    if (!isLoginPage() || pendingOpen.googleStarted) return;

    window.clearTimeout(googleStartTimer);
    const maxAttempts = 20; // 20 × 500 ms = 10 s max wait
    let attempts = 0;

    const tryClick = async () => {
      if (stopped || !isLoginPage() || pendingOpen.googleStarted) return;

      const button = findGoogleSignInElement();
      if (!button) {
        attempts += 1;
        if (attempts >= maxAttempts) {
          // Could not find Google button — ask user to click manually
          const detailEl = document.querySelector(
            '#claude-chat-tracker-toast [style*="color:#b8b0a7"]',
          );
          if (detailEl)
            detailEl.textContent =
              'Could not find Google button — click "Continue with Google" manually';
          return;
        }
        googleStartTimer = window.setTimeout(tryClick, 500);
        return;
      }

      // Persist googleStarted BEFORE clicking — the storage write is awaited so it
      // completes before any navigation triggered by button.click().
      await setPendingOpen({
        ...pendingOpen,
        googleStarted: true,
        loginStartedAt: Date.now(),
      });
      button.click();
    };

    googleStartTimer = window.setTimeout(tryClick, 500);
  }

  function makePendingToast(pendingOpen) {
    removePendingToast();

    const toast = document.createElement("div");
    toast.id = "claude-chat-tracker-toast";
    toast.style.cssText = [
      "position:fixed",
      "top:14px",
      "left:50%",
      "transform:translateX(-50%)",
      "z-index:2147483647",
      "width:min(720px,calc(100vw - 32px))",
      "background:#191817",
      "color:#f4f1ea",
      "border:1px solid #d97945",
      "border-radius:10px",
      "box-shadow:0 16px 44px rgba(0,0,0,.42)",
      "padding:12px 14px",
      'font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      "display:grid",
      "grid-template-columns:minmax(0,1fr) auto auto",
      "gap:10px",
      "align-items:center",
    ].join(";");

    const message = document.createElement("div");
    message.style.minWidth = "0";

    const title = document.createElement("div");
    title.textContent = `Switch to "${pendingOpen.accountName}" — logging in…`;
    title.style.cssText =
      "font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";

    const detail = document.createElement("div");
    detail.textContent = isLoginPage()
      ? `Select "${pendingOpen.accountName}" on the Google screen. Target: ${pendingOpen.chatTitle}`
      : `Opening: ${pendingOpen.chatTitle}`;
    detail.style.cssText =
      "color:#b8b0a7;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px";

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.textContent = isLoginPage() ? "Start login" : "Open now";
    openButton.style.cssText =
      "height:30px;border:1px solid #6d5a4b;border-radius:8px;background:#2a2420;color:#f4f1ea;padding:0 10px;cursor:pointer;font:inherit;font-size:12px";
    openButton.addEventListener("click", async () => {
      if (isLoginPage()) {
        const button = findGoogleSignInElement();
        if (button) {
          await setPendingOpen({
            ...pendingOpen,
            googleStarted: true,
            loginStartedAt: Date.now(),
          });
          button.click();
          return;
        }
      }
      location.assign(pendingOpen.chatUrl);
    });

    const dismissButton = document.createElement("button");
    dismissButton.type = "button";
    dismissButton.textContent = "Dismiss";
    dismissButton.style.cssText =
      "height:30px;border:1px solid #37352f;border-radius:8px;background:#1d1d1c;color:#b8b0a7;padding:0 10px;cursor:pointer;font:inherit;font-size:12px";
    dismissButton.addEventListener("click", () => {
      clearPendingOpen();
    });

    message.append(title, detail);
    toast.append(message, openButton, dismissButton);
    document.documentElement.appendChild(toast);
    pendingToast = toast;
  }

  async function handlePendingOpen() {
    if (!hasStorageApi()) return;

    const pendingOpen = await getPendingOpen();
    if (!pendingOpen || !pendingOpen.chatUrl || !pendingOpen.accountName) {
      removePendingToast();
      return;
    }

    if (Date.now() - Number(pendingOpen.createdAt || 0) > PENDING_OPEN_TTL_MS) {
      await clearPendingOpen();
      return;
    }

    if (!shouldHandlePendingOpenHere(pendingOpen)) {
      removePendingToast();
      return;
    }

    // Only show the toast once per page load — avoid constant DOM churn from scrape re-runs.
    if (!pendingToast) {
      makePendingToast(pendingOpen);
    }

    // Already on the target chat — clear and stop.
    if (sameClaudeChatUrl(location.href, pendingOpen.chatUrl)) {
      await clearPendingOpen();
      return;
    }

    if (isPostLoginLandingPage()) {
      // Only schedule ONE timer per page load.
      // handlePendingOpen() runs on every scrape (~1.2 s); without this flag the 2 s timer
      // would be cancelled and reset each time and would never fire.
      if (pendingNavigationScheduled) return;
      pendingNavigationScheduled = true;

      pendingNavigationTimer = window.setTimeout(() => {
        pendingNavigationScheduled = false;
        if (stopped || !isPostLoginLandingPage()) return;
        // Session cookies were cleared by the popup before opening this tab, so
        // any user on the landing page has necessarily just completed a fresh login.
        // Navigate straight to the target chat.
        location.assign(pendingOpen.chatUrl);
      }, 2000);
    }
  }

  function findEmailInElement(element) {
    if (!element) return null;

    const ariaLabel =
      element.getAttribute && element.getAttribute("aria-label");
    const title = element.getAttribute && element.getAttribute("title");
    const candidates = [ariaLabel, title, textOf(element)].filter(Boolean);

    for (const candidate of candidates) {
      const match = candidate.match(EMAIL_RE);
      if (match) return match[0].toLowerCase();
    }

    return null;
  }

  function detectAccountEmail() {
    for (const selector of ACCOUNT_SELECTORS) {
      const elements = document.querySelectorAll(selector);
      for (const element of elements) {
        const email = findEmailInElement(element);
        if (email) return email;
      }
    }

    return null;
  }

  function cleanAccountDisplayName(value) {
    const raw = value || "";
    const emailMatch = raw.match(EMAIL_RE);
    if (emailMatch) return accountLabelFromEmail(emailMatch[0].toLowerCase());

    // Claude's profile button aria-label is formatted as "Name, Settings" or "Name, Profile".
    // Strip trailing comma-separated UI label fragments before processing.
    // e.g. "shivam patel, Settings" → "shivam patel"
    const UI_SUFFIXES = [
      "settings",
      "help",
      "upgrade",
      "free plan",
      "profile",
      "account",
      "customize",
      "sign out",
      "log out",
      "logout",
    ];

    // Pre-process: if the value contains ", SuffixWord" at the end, strip it
    let cleaned = raw;
    for (const suffix of UI_SUFFIXES) {
      const pattern = new RegExp(`,\\s*${suffix}\\s*$`, "i");
      cleaned = cleaned.replace(pattern, "");
    }

    const blocked = [
      "claude",
      "new chat",
      "search",
      "chats",
      "projects",
      "artifacts",
      "code",
      "customize",
      "free plan",
      "upgrade",
      "settings",
      "help",
    ];

    const lines = cleaned
      .split(/\n| {2,}/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    for (const line of lines) {
      const lower = line.toLowerCase();
      if (line.length > 36) continue;
      if (blocked.includes(lower)) continue;
      if (
        blocked.some(
          (word) =>
            lower === word ||
            lower.startsWith(`${word} `) ||
            lower.endsWith(` ${word}`) ||
            lower.endsWith(`, ${word}`),
        )
      )
        continue;
      if (/^\d+\s/.test(line)) continue;
      return line;
    }

    return null;
  }

  function findDisplayNameInElement(element) {
    if (!element) return null;

    const candidates = [
      element.getAttribute && element.getAttribute("aria-label"),
      element.getAttribute && element.getAttribute("title"),
      element.innerText,
      textOf(element),
    ].filter(Boolean);

    for (const candidate of candidates) {
      const displayName = cleanAccountDisplayName(candidate);
      if (displayName) return displayName;
    }

    return null;
  }

  // BUG-08 fix: two-pass approach — high-confidence selectors first, then broad scan.
  // BUG-07 fix: also check lastDetectedEmail as a seed so persisted email is used on reload.
  // Fix A: cookieDetectedEmail is checked before display-name fallback so the real identity
  //        is used from the very first scrape, even before the user opens the account menu.
  function detectAccountIdentity() {
    const email = detectAccountEmail();
    if (email) {
      // Fix F (sticky): pin the email into cookieDetectedEmail the first time DOM exposes it.
      // This ensures subsequent scrapes use the real identity even after the toggle closes.
      if (!cookieDetectedEmail) {
        cookieDetectedEmail = email;
        cctLog("🔒 DOM email pinned for session:", email);
      }
      return {
        email,
        displayName: accountLabelFromEmail(email),
      };
    }

    // Fix A: cookie-extracted email — available immediately at page load without UI interaction.
    if (cookieDetectedEmail) {
      return {
        email: cookieDetectedEmail,
        displayName: accountLabelFromEmail(cookieDetectedEmail),
      };
    }

    // Pass 1: specific high-confidence selectors (most reliable)
    const highConfidenceSelectors = [
      '[data-testid*="user"]',
      '[data-testid*="account"]',
      'button[aria-label*="account" i]',
      'button[aria-label*="profile" i]',
    ];

    for (const selector of highConfidenceSelectors) {
      const elements = Array.from(document.querySelectorAll(selector)).filter(
        isVisible,
      );
      for (const el of elements) {
        const displayName = findDisplayNameInElement(el);
        if (displayName) return { email: null, displayName };
      }
    }

    // Pass 2: broad scan of sidebar/nav/header buttons, sorted bottom-first
    // (Claude's account button is at bottom-left of the sidebar)
    const broadCandidates = Array.from(
      document.querySelectorAll("aside button, nav button, header button"),
    )
      .filter(isVisible)
      .sort(
        (a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top,
      );

    for (const element of broadCandidates) {
      const displayName = findDisplayNameInElement(element);
      if (displayName) return { email: null, displayName };
    }

    return {
      email: null,
      displayName: FALLBACK_ACCOUNT_NAME,
    };
  }

  async function hashValue(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function accountLabelFromEmail(email) {
    return email.split("@")[0] || email;
  }

  async function resolveAccountIdentity(accountIdentity) {
    if (!accountIdentity || !accountIdentity.email) {
      // Always use the per-profile unique fallback — never read currentAccountId here.
      // currentAccountId is a popup UI preference only and must not influence scraping identity.
      // Using it caused chats from one Chrome profile to be attributed to another profile's account.
      return {
        accountId: profileFallbackAccountId,
        email: null,
        displayName:
          accountIdentity && accountIdentity.displayName
            ? accountIdentity.displayName
            : FALLBACK_ACCOUNT_NAME,
        isFallback: true,
      };
    }

    const accountHash = await hashValue(accountIdentity.email);
    return {
      accountId: `acc_${accountHash.slice(0, 16)}`,
      email: accountIdentity.email,
      displayName:
        accountIdentity.displayName ||
        accountLabelFromEmail(accountIdentity.email),
      isFallback: false,
    };
  }

  // One-time migration: fix any doubled titles already stored in chrome.storage.local.
  // Runs on every page load but only writes if it finds something to fix.
  // Necessary because fixing getTitleFromLink only prevents NEW doubles — stale chats
  // beyond the current scroll window are never re-scraped and would keep their doubled titles.
  async function migrateDoubledTitles() {
    try {
      const { chats = {} } = await storageGet([STORAGE_KEYS.chats]);
      let dirty = false;
      for (const chat of Object.values(chats)) {
        const fixed = deduplicate(chat.title || "");
        if (fixed !== (chat.title || "")) {
          chat.title = fixed;
          dirty = true;
        }
      }
      if (dirty) await storageSet({ chats });
    } catch (_) {
      /* non-critical — silently skip if storage is unavailable */
    }
  }

  // Auto-trigger the profile dropdown to extract the email address without user interaction.
  // Strategy:
  //   1. Find the profile toggle button (bottom-left of sidebar).
  //   2. Click it to open the menu — the email appears in the DOM within ~150 ms.
  //   3. Poll for up to 1.5 s for an email to appear in the document.
  //   4. Close the menu immediately by clicking the button again (or pressing Escape).
  //   5. Pin the email into cookieDetectedEmail / lastDetectedEmail for the session.
  //
  // The open+close happens fast enough that users on a normal page load will never notice.
  // Guard: only runs once per session (emailAutoDetectAttempted flag) and only when
  // cookieDetectedEmail is still null after all other probes have failed.
  let emailAutoDetectAttempted = false;

  function findProfileButton() {
    // High-confidence: look for the bottom-most visible button in aside/nav
    // that carries a name/aria-label matching the user's display name or "open menu".
    // Claude renders the account button at the bottom-left of the sidebar.
    const selectors = [
      'button[data-testid*="user"]',
      'button[data-testid*="account"]',
      'button[data-testid*="profile"]',
      'button[aria-label*="account" i]',
      'button[aria-label*="profile" i]',
      'button[aria-haspopup="menu"]',
      'button[aria-haspopup="true"]',
    ];

    for (const sel of selectors) {
      const els = Array.from(document.querySelectorAll(sel)).filter(isVisible);
      if (els.length > 0) {
        // Prefer the bottom-most one (account button is at the bottom of the sidebar)
        return els.sort(
          (a, b) =>
            b.getBoundingClientRect().top - a.getBoundingClientRect().top,
        )[0];
      }
    }

    // Broad fallback: bottom-most visible button in aside/nav that is NOT a chat link
    const candidates = Array.from(
      document.querySelectorAll("aside button, nav button"),
    )
      .filter(isVisible)
      .filter((el) => !el.closest('a[href*="/chat/"]'))
      .sort(
        (a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top,
      );

    return candidates[0] || null;
  }

  // How many times we've attempted the auto-detect (reset on success, capped at MAX_ATTEMPTS).
  const AUTO_DETECT_MAX_ATTEMPTS = 4;
  let autoDetectAttemptCount = 0;

  async function tryAutoDetectEmailViaDropdown() {
    if (cookieDetectedEmail) return; // already have it
    if (autoDetectAttemptCount >= AUTO_DETECT_MAX_ATTEMPTS) return; // give up
    autoDetectAttemptCount++;
    emailAutoDetectAttempted = true; // still used as a one-shot guard in setupAccountObserver

    // Wait for the profile button itself to appear and stabilise.
    // On fresh login the sidebar exists but React hasn't mounted the account component yet.
    const btn = await new Promise((resolve) => {
      const deadline = Date.now() + 8000;
      const check = () => {
        const found = findProfileButton();
        if (found) return resolve(found);
        if (Date.now() >= deadline) return resolve(null);
        window.setTimeout(check, 200);
      };
      check();
    });

    if (!btn) {
      cctLog(
        "👤 Auto-detect: profile button not found after 8 s — attempt",
        autoDetectAttemptCount,
      );
      scheduleAutoDetectRetry();
      return;
    }

    cctLog(
      "👤 Auto-detect: clicking profile button (attempt",
      autoDetectAttemptCount,
      ")…",
    );
    btn.click();

    // After clicking, wait up to 3000 ms for email to appear.
    // On a slow/freshly-loaded page the dropdown content renders asynchronously.
    const email = await new Promise((resolve) => {
      const deadline = Date.now() + 3000;
      const poll = () => {
        const found = detectAccountEmail();
        if (found) return resolve(found);
        if (Date.now() >= deadline) return resolve(null);
        window.setTimeout(poll, 100);
      };
      poll();
    });

    // Close the menu regardless of whether we found an email.
    btn.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((r) => window.setTimeout(r, 150));
    if (btn.getAttribute("aria-expanded") === "true") {
      btn.click();
      await new Promise((r) => window.setTimeout(r, 80));
    }
    if (btn.getAttribute("aria-expanded") === "true") {
      document.body.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    }

    if (email) {
      cookieDetectedEmail = email;
      lastDetectedEmail = email;
      const attemptThatWorked = autoDetectAttemptCount;
      autoDetectAttemptCount = 0; // reset on success
      cctLog(
        "✅ Auto-detect: email captured:",
        email,
        "(attempt",
        attemptThatWorked,
        ")",
      );
      lastSnapshot = "";
      scheduleScrape();
    } else {
      cctLog(
        "👤 Auto-detect: no email found (attempt",
        autoDetectAttemptCount,
        ") — will retry",
      );
      scheduleAutoDetectRetry();
    }
  }

  // Retry with exponential backoff: 3 s, 8 s, 20 s after previous attempt.
  const AUTO_DETECT_RETRY_DELAYS = [3000, 8000, 20000];
  function scheduleAutoDetectRetry() {
    if (cookieDetectedEmail) return;
    if (autoDetectAttemptCount >= AUTO_DETECT_MAX_ATTEMPTS) {
      cctLog(
        "👤 Auto-detect: max attempts reached — giving up, DOM observer will catch manual open",
      );
      return;
    }
    const delay = AUTO_DETECT_RETRY_DELAYS[autoDetectAttemptCount - 1] || 20000;
    cctLog("👤 Auto-detect: retry scheduled in", delay / 1000, "s");
    window.setTimeout(() => {
      if (!cookieDetectedEmail) tryAutoDetectEmailViaDropdown();
    }, delay);
  }

  // Reads or generates a stable, unique seed for this Chrome profile from local storage,
  // then derives profileFallbackAccountId from it.  Each Chrome profile gets its own seed
  // so fallback accounts are never shared or merged across profiles via chrome.storage.sync.
  // BUG-05 fix: use crypto.randomUUID() instead of Date.now() + Math.random() to avoid collisions.
  // BUG-07 fix: also restore lastKnownEmail from storage so the first scrape uses real identity.
  async function initProfileLocalId() {
    cctGroup("🚀 Init — profile & email seed");
    try {
      const data = await storageGet([
        STORAGE_KEYS.profileLocalId,
        "lastKnownEmail",
        "lastKnownOrgId",
        MIGRATION_DOUBLED_TITLES_V1,
        MIGRATION_DOUBLED_TITLES_V2,
      ]);
      let id = data[STORAGE_KEYS.profileLocalId];
      if (!id) {
        id = `profile_${crypto.randomUUID()}`;
        await storageSet({ [STORAGE_KEYS.profileLocalId]: id });
        cctLog("🆕 New profile seed generated:", id);
      } else {
        cctLog("🆔 Existing profile seed loaded:", id);
      }
      profileFallbackAccountId = `acc_pfl_${id.replace(/[^a-z0-9]/gi, "").slice(0, 16)}`;
      cctLog("🆔 Fallback account ID:", profileFallbackAccountId);

      // Change B — seed cookieDetectedEmail from persisted lastKnownEmail so the
      // FIRST scrape (which fires ~2 s after document_idle, before the dropdown
      // auto-detect has a chance to complete) uses the real account identity.
      //
      // Security gate: we only trust the seeded email if we can validate it against
      // the live org ID BEFORE the first scrape fires. initProfileLocalId() is awaited
      // by the init chain (see bottom of file), so this fetch completes before any
      // scheduleScrape() call. If the org IDs don't match, the user switched accounts
      // since last session — clear both stale values and let the dropdown detect run.
      const storedEmail = data.lastKnownEmail;
      const storedOrgIdForSeed = data.lastKnownOrgId;
      if (storedEmail && storedOrgIdForSeed) {
        // We have a stored email AND a stored orgId to validate against.
        // Fetch the live orgId now (before scheduleScrape) to confirm they match.
        cctLog("🔑 Validating stored email against live org ID before seeding…");
        try {
          const liveOrgId = await fetchOrganizationId();
          if (liveOrgId && liveOrgId === storedOrgIdForSeed) {
            // OrgIds match — same account as last session, seed is safe.
            if (!cookieDetectedEmail) {
              cookieDetectedEmail = storedEmail;
              cctLog("🔑 Email seeded from lastKnownEmail (validated):", storedEmail);
            }
          } else if (liveOrgId && liveOrgId !== storedOrgIdForSeed) {
            // OrgIds differ — account switched since last session.
            // Clear stale values from storage so scheduleApiSync doesn't loop.
            cctWarn(
              `🔑 Stored email "${storedEmail}" failed org validation (stored: ${storedOrgIdForSeed}, live: ${liveOrgId}). Clearing stale identity.`,
            );
            await storageSet({ lastKnownEmail: null, lastKnownOrgId: null });
            // Do NOT seed cookieDetectedEmail — let dropdown auto-detect resolve it.
          } else {
            // liveOrgId is null — API failure or fresh install; seed optimistically,
            // the mismatch guard in scheduleApiSync will catch it if wrong.
            if (!cookieDetectedEmail) {
              cookieDetectedEmail = storedEmail;
              cctLog("🔑 Email seeded from lastKnownEmail (org fetch failed, optimistic):", storedEmail);
            }
          }
        } catch (orgFetchErr) {
          // Non-fatal — seed optimistically, mismatch guard is the backstop.
          if (!cookieDetectedEmail) {
            cookieDetectedEmail = storedEmail;
            cctLog("🔑 Email seeded from lastKnownEmail (org fetch error, optimistic):", storedEmail);
          }
        }
      } else if (storedEmail && !storedOrgIdForSeed) {
        // Have email but no orgId to validate against — unsafe to seed.
        // This happens on a fresh install or if a previous session never wrote orgId.
        // Don't seed; let dropdown auto-detect run cleanly.
        cctLog("🔑 lastKnownEmail present but no lastKnownOrgId to validate — skipping seed, letting dropdown detect run.");
      }
      // (If neither is stored, nothing to seed — normal fresh-install path.)

      if (!data[MIGRATION_DOUBLED_TITLES_V1]) {
        cctLog("🔧 Running title-dedup migration V1…");
        await migrateDoubledTitles();
        await storageSet({ [MIGRATION_DOUBLED_TITLES_V1]: true });
        cctLog("✅ Migration V1 done");
      }
      if (!data[MIGRATION_DOUBLED_TITLES_V2]) {
        cctLog("🔧 Running title-dedup migration V2…");
        await migrateDoubledTitles();
        await storageSet({ [MIGRATION_DOUBLED_TITLES_V2]: true });
        cctLog("✅ Migration V2 done");
      }

      // Silently click the profile button to expose the email in the DOM,
      // then immediately close it.  Because cookieDetectedEmail is already seeded
      // above (if lastKnownEmail was present), tryAutoDetectEmailViaDropdown will
      // short-circuit immediately (its first guard is: if (cookieDetectedEmail) return)
      // and skip the intrusive dropdown click — which is exactly the desired behaviour.
      tryAutoDetectEmailViaDropdown();
    } catch (_error) {
      cctError("❌ Init failed — using session-only fallback ID", _error);
      profileFallbackAccountId = `acc_pfl_${Date.now().toString(36)}`;
    } finally {
      // ✅ Identity is as resolved as it's going to be synchronously.
      // Scrapes may now fire. If email is still null, fallback will be used
      // but the dropdown auto-detect will upgrade it shortly after.
      identityReadyResolve();
      cctGroupEnd();
    }
  }

  // Storage optimisation: drop s (storageId) and u (url) — both are reconstructable:
  //   storageId = accountId + ":" + chatId
  //   url       = "https://claude.ai/chat/" + chatId
  // Saves ~57 bytes per chat entry in chrome.storage.sync chunks.
  // st = sectionTimestamp: date-bucket timestamp scraped from Claude's sidebar section headers.

  async function readSyncedData() {
    const syncHeader = await syncGet([
      SYNC_KEYS.accounts,
      SYNC_KEYS.meta,
      SYNC_KEYS.deletedAccounts,
    ]);
    const meta = syncHeader[SYNC_KEYS.meta] || {};
    const chunkCount = Number(meta.chatChunkCount || 0);
    const chunkKeys = Array.from(
      { length: chunkCount },
      (_value, index) => `${SYNC_KEYS.chatPrefix}${index}`,
    );
    const chunkData = chunkKeys.length > 0 ? await syncGet(chunkKeys) : {};
    const chats = {};

    for (const key of chunkKeys) {
      const rows = Array.isArray(chunkData[key]) ? chunkData[key] : [];
      for (const row of rows) {
        const chat = expandChat(row);
        if (chat.storageId) chats[chat.storageId] = chat;
      }
    }

    return {
      accounts: syncHeader[SYNC_KEYS.accounts] || {},
      chats,
      meta,
      deletedAccounts: syncHeader[SYNC_KEYS.deletedAccounts] || {},
    };
  }

  // Deprecated after Phase 2: sync writes must go through the background service worker.
  async function writeSyncedData(accounts, chats, previousChunkCount) {
    const chunks = makeChatChunks(chats);
    const payload = {
      [SYNC_KEYS.accounts]: accounts,
      [SYNC_KEYS.meta]: {
        chatChunkCount: chunks.length,
        updatedAt: Date.now(),
        version: 2,
      },
    };

    chunks.forEach((chunk, index) => {
      payload[`${SYNC_KEYS.chatPrefix}${index}`] = chunk;
    });

    await syncSet(payload);

    if (previousChunkCount > chunks.length) {
      const staleKeys = [];
      for (let index = chunks.length; index < previousChunkCount; index += 1) {
        staleKeys.push(`${SYNC_KEYS.chatPrefix}${index}`);
      }
      await syncRemove(staleKeys);
    }
  }

  async function syncMergedData(localAccounts, localChats) {
    if (!hasSyncApi()) return;

    try {
      const synced = await readSyncedData();
      const localData = await storageGet(["deletedChatIds"]);
      const deletedChatIds = localData.deletedChatIds || [];

      // Remove deleted storageIds from the sync side.
      for (const id of deletedChatIds) {
        if (synced.chats) delete synced.chats[id];
      }

      // Fix: also strip deletedChatIds from localChats before merging.
      // Without this, a storageId deleted by the phantom purge in applyServerTimestamps()
      // can re-enter the merged result via localChats — re-writing the phantom entry to
      // sync storage and causing an infinite re-hydration cycle on the next page load.
      const filteredLocalChats = {};
      for (const [sid, chat] of Object.entries(localChats || {})) {
        if (!deletedChatIds.includes(sid)) filteredLocalChats[sid] = chat;
      }

      const deletedAccounts = synced.deletedAccounts || {};
      const accounts = mergeAccounts(
        synced.accounts,
        localAccounts,
        deletedAccounts,
      );
      const chats = mergeChats(synced.chats, filteredLocalChats, deletedAccounts);
      const response = await chrome.runtime.sendMessage({
        type: "SYNC_DATA",
        accounts,
        chats,
        deletedAccounts,
        deletedChatIds,
      });
      if (response && response.ok) {
        const msg =
          response.prunedCount > 0
            ? `Synced; ${response.prunedCount} older chats skipped from sync`
            : "Synced";
        await storageSet({
          accounts,
          chats,
          deletedChatIds: [],
          syncStatus: { ok: true, updatedAt: Date.now(), message: msg },
        });
      } else {
        throw new Error(
          response && response.error ? response.error : "Sync write failed",
        );
      }
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        stopTracking();
        return;
      }
      await storageSet({
        syncStatus: {
          ok: false,
          updatedAt: Date.now(),
          message: error && error.message ? error.message : String(error),
        },
      });
      cctWarn("🔄 Sync failed. Local tracking still works.", error);
    }
  }

  // ─── API-based real timestamp sync ───────────────────────────────────────────
  // Content scripts run inside claude.ai, so fetch() automatically carries the
  // user's session cookies — no extra permissions needed.

  // Step 1: get (and cache) the user's organisation UUID.
  async function fetchOrganizationId() {
    if (cachedOrgId) {
      cctLog("📡 Org ID (cached):", cachedOrgId);
      return cachedOrgId;
    }
    cctLog("📡 Fetching org ID from /api/organizations…");
    try {
      const res = await fetch("https://claude.ai/api/organizations", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        cctWarn("📡 /api/organizations returned", res.status);
        return null;
      }
      const data = await res.json();
      const orgs = Array.isArray(data) ? data : data.organizations || [];
      const org = orgs.find((o) => !o.is_default_org) || orgs[0];
      if (org) {
        cachedOrgId = org.uuid || org.id || null;
        cctLog("📡 Org ID resolved:", cachedOrgId);
      }
    } catch (err) {
      cctWarn("📡 fetchOrganizationId error:", err.message || err);
    }
    return cachedOrgId;
  }

  // Step 2: fetch conversation list for the org, returning an array of
  // { chatId, title, updatedAt } objects.  Returns null on any error.
  async function fetchRecentChats() {
    const orgId = await fetchOrganizationId();
    if (!orgId) return null;
    cctLog(`📡 Fetching conversations for org ${orgId}…`);
    try {
      const res = await fetch(
        `https://claude.ai/api/organizations/${orgId}/chat_conversations?limit=100`,
        { credentials: "include", headers: { Accept: "application/json" } },
      );
      if (!res.ok) {
        cctWarn("📡 chat_conversations returned", res.status);
        return null;
      }
      const data = await res.json();
      const convs = Array.isArray(data)
        ? data
        : data.conversations || data.chat_conversations || [];
      const result = convs
        .map((c) => ({
          chatId: c.uuid || c.id,
          apiTitle: (c.name || c.title || "").trim() || null,
          updatedAt: c.updated_at ? new Date(c.updated_at).getTime() : null,
        }))
        .filter((c) => c.chatId);
      cctLog(`📡 API returned ${result.length} conversation(s)`);
      return result;
    } catch (err) {
      cctWarn("📡 fetchRecentChats error:", err.message || err);
      return null;
    }
  }

  // Step 3: merge server timestamps (and titles where the API is cleaner) into
  // local storage without triggering a full re-scrape.
  async function applyServerTimestamps(apiChats, currentAccountId) {
    if (!apiChats || apiChats.length === 0) return;
    if (!hasStorageApi()) return;

    const local = await storageGet([STORAGE_KEYS.accounts, STORAGE_KEYS.chats, "deletedChatIds"]);
    const accounts = local[STORAGE_KEYS.accounts] || {};
    const chats = local[STORAGE_KEYS.chats] || {};
    const deletedChatIds = local.deletedChatIds || [];

    const apiMap = new Map(apiChats.map((c) => [c.chatId, c]));
    let dirty = false;
    let timestampsUpdated = 0;
    let titlesFixed = 0;
    let orphanedDeleted = 0;

    // ── PHANTOM ENTRY PURGE ──────────────────────────────────────────────────
    // The server's apiMap is ground truth: every chatId it returns belongs to
    // currentAccountId's org. If local storage has that same chatId stored under
    // a DIFFERENT real accountId, it is a phantom written by a bad scrape session
    // where identity resolved to the wrong account. Remove it now.
    //
    // Safety guards:
    //   • Only runs when currentAccountId is known (avoids purging on fallback sessions).
    //   • Skips acc_pfl_* entries (handled by the existing fallback migration).
    //   • Only acts on chatIds the server explicitly confirms — never guesses.
    if (currentAccountId) {
      const phantomStorageIds = [];
      for (const [storageId, chat] of Object.entries(chats)) {
        if (chat.accountId === currentAccountId) continue;       // correct entry — skip
        if (chat.accountId.startsWith('acc_pfl_')) continue;     // fallback — skip
        if (!apiMap.has(chat.chatId)) continue;                  // not server-confirmed — skip
        // Server says this chatId belongs to currentAccountId, but this entry
        // is stored under a different real accountId → phantom.
        phantomStorageIds.push(storageId);
        cctLog(`🧹 Phantom purge: "${chat.title}" stored under ${chat.accountId}, server confirms it belongs to ${currentAccountId} (storageId: ${storageId})`);
      }
      for (const sid of phantomStorageIds) {
        delete chats[sid];
        if (!deletedChatIds.includes(sid)) deletedChatIds.push(sid);
        dirty = true;
        orphanedDeleted++;
      }
      if (phantomStorageIds.length > 0) {
        cctLog(`🧹 Phantom purge complete: removed ${phantomStorageIds.length} phantom entry/entries`);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    let oldestApiTs = 0;
    if (apiChats.length >= 100) {
      oldestApiTs = Math.min(...apiChats.map((c) => c.updatedAt || 0));
    }

    for (const [storageId, chat] of Object.entries(chats)) {
      if (currentAccountId && chat.accountId === currentAccountId && !apiMap.has(chat.chatId)) {
        let shouldDelete = false;
        if (apiChats.length < 100) {
          shouldDelete = true;
        } else {
          if (chat.serverUpdatedAt && chat.serverUpdatedAt >= oldestApiTs) {
            shouldDelete = true;
          } else if (!chat.serverUpdatedAt && chat.sectionTimestamp && chat.sectionTimestamp >= oldestApiTs) {
            shouldDelete = true;
          }
        }

        if (shouldDelete) {
          cctLog(`🗑️ Chat deleted via API sync: "${chat.title}" (${storageId})`);
          delete chats[storageId];
          if (!deletedChatIds.includes(storageId)) {
            deletedChatIds.push(storageId);
          }
          dirty = true;
          orphanedDeleted++;
          continue;
        }
      }

      const api = apiMap.get(chat.chatId);
      if (!api) continue;

      let changed = false;

      if (api.updatedAt && api.updatedAt !== chat.serverUpdatedAt) {
        chat.serverUpdatedAt = api.updatedAt;
        changed = true;
        timestampsUpdated++;
      }

      if (api.apiTitle) {
        const stored = (chat.title || "").trim();
        const apiTitle = api.apiTitle.trim();
        const isDuplicated =
          stored.length > 10 &&
          stored.slice(0, Math.floor(stored.length / 2)) ===
            stored.slice(Math.floor(stored.length / 2));
        if (!stored || isDuplicated || stored !== apiTitle) {
          cctLog(`🔧 Title fixed via API: "${stored}" → "${apiTitle}"`);
          chat.title = apiTitle;
          changed = true;
          titlesFixed++;
        }
      }

      if (changed) dirty = true;
    }

    cctLog(
      `💾 applyServerTimestamps: ${timestampsUpdated} timestamps updated, ${titlesFixed} titles fixed, ${orphanedDeleted} orphaned deleted`,
    );

    if (dirty) {
      await storageSet({ chats, deletedChatIds });
      // Fix: update pendingSyncChats to the POST-purge state.
      // Without this, pendingSyncChats still holds the pre-purge snapshot (set by the
      // previous saveScrape call). When syncMergedData() flushes that stale payload,
      // it re-introduces phantom entries into chrome.storage.sync — undoing this purge.
      pendingSyncAccounts = accounts;
      pendingSyncChats = chats;
      cctLog("💾 Local storage updated with server timestamps and deletions; pendingSyncChats refreshed to post-purge state");
    } else {
      cctLog("💾 No changes — all timestamps already current");
    }
  }

  // Throttled entry point: called from runFullScrape() on every scrape that produces
  // a change.  The 60-second guard means we never hammer Claude's API.
  function scheduleApiSync(accountId) {
    if (stopped) return;
    const elapsed = Date.now() - lastApiSyncAt;
    if (elapsed < API_SYNC_INTERVAL_MS) {
      cctLog(
        `⏭️  API sync skipped — cooldown (${Math.round((API_SYNC_INTERVAL_MS - elapsed) / 1000)}s remaining)`,
      );
      return;
    }
    lastApiSyncAt = Date.now();
    cctLog("📡 API sync starting…");

    // Change C — orgId mismatch safety net.
    // fetchOrganizationId() returns the live org UUID for the currently-logged-in
    // Claude account.  If it differs from lastKnownOrgId (written by the previous
    // saveScrape session), the user has switched Claude accounts since last visit.
    // In that case: invalidate the seeded email, clear the snapshot so the next
    // scrape re-resolves identity from scratch, and abort this sync cycle.
    // Guards: both values must be non-null — null orgId means an API failure or
    // fresh install, not a real account switch; never trigger a reset on that.
    fetchOrganizationId()
      .then(async (orgId) => {
        if (stopped) return;
        const stored = await storageGet(["lastKnownOrgId"]);
        const storedOrgId = stored.lastKnownOrgId || null;
        if (storedOrgId && orgId && orgId !== storedOrgId) {
          cctWarn(
            `⚠️ Org ID mismatch — account switched since last session (stored: ${storedOrgId}, live: ${orgId}). Resetting identity.`,
          );
          cookieDetectedEmail = null;
          lastSnapshot = "";
          // Bug 1 fix: MUST clear lastKnownEmail and lastKnownOrgId from persistent
          // storage here. Without this, the fallback scrape that follows has no email
          // so saveScrape never writes lastKnownOrgId — leaving the stale value in
          // storage. Every subsequent API sync then sees the same mismatch and resets
          // again, creating an infinite reset loop.
          await storageSet({ lastKnownEmail: null, lastKnownOrgId: null });
          scheduleScrape();
          return; // abort this sync cycle; next scrape will re-resolve identity
        }
        return fetchRecentChats();
      })
      .then((apiChats) => {
        if (!stopped && apiChats) {
          applyServerTimestamps(apiChats, accountId);
        } else if (apiChats === null) {
          cctLog(
            "📡 API sync returned no data — will retry on next scrape cycle",
          );
        }
        // apiChats === undefined means we returned early from the mismatch branch — no-op
      })
      .catch((err) => cctWarn("📡 API sync error:", err.message || err));
  }
  // ─────────────────────────────────────────────────────────────────────────────

  function scheduleSync(accounts, chats) {
    if (!hasSyncApi()) return;

    window.clearTimeout(syncTimer);
    const elapsed = Date.now() - lastSyncAt;
    const delay =
      elapsed >= MIN_SYNC_INTERVAL_MS ? 0 : MIN_SYNC_INTERVAL_MS - elapsed;

    syncTimer = window.setTimeout(() => {
      lastSyncAt = Date.now();
      syncMergedData(accounts, chats);
    }, delay);
  }

  function colorForAccount(existingAccounts) {
    const count = Object.keys(existingAccounts).length;
    return ACCOUNT_COLORS[count % ACCOUNT_COLORS.length];
  }

  function normalizeChatHref(href) {
    try {
      const url = new URL(href, location.origin);
      if (url.hostname !== "claude.ai") return null;

      const match = url.pathname.match(/\/chat\/([^/?#]+)/);
      if (!match) return null;

      return {
        chatId: decodeURIComponent(match[1]),
        url: `https://claude.ai/chat/${match[1]}`,
      };
    } catch (_error) {
      return null;
    }
  }

  function cleanTitle(rawTitle) {
    const title = (rawTitle || "").replace(/\s+/g, " ").trim();
    return title || "Untitled Chat";
  }

  // BUG-06 real fix: detect and remove exact front-half duplication.
  // Claude's React renders aria-label as "Title" + " " + "Title" in some versions,
  // so the doubled string is IN the aria-label itself — not just in textContent.
  // Applying this to every candidate makes the fix bulletproof regardless of source.
  function deduplicate(s) {
    const t = (s || "").replace(/\s+/g, " ").trim();
    const h = Math.floor(t.length / 2);
    if (t.length > 10 && t.slice(0, h) === t.slice(h)) {
      return t.slice(0, h).trim();
    }
    return t;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;

    const style = window.getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  }

  function orderedChatLinks() {
    const containers = Array.from(
      document.querySelectorAll(CHAT_CONTAINER_SELECTOR),
    ).filter(isVisible);

    const scopedLinks = containers.flatMap((container) => {
      return Array.from(container.querySelectorAll(CHAT_LINK_SELECTOR));
    });

    const links =
      scopedLinks.length > 0
        ? scopedLinks
        : Array.from(document.querySelectorAll(CHAT_LINK_SELECTOR));

    return links
      .filter(isVisible)
      .map((link) => ({
        link,
        rect: link.getBoundingClientRect(),
      }))
      .sort((a, b) => {
        return a.rect.top - b.rect.top || a.rect.left - b.rect.left;
      })
      .map((item) => item.link);
  }

  // Fix C: deduplicate() now applied to ALL extraction paths.
  // Claude's React renderer can inject doubled text into aria-label, the title attribute,
  // span textContent, or raw textContent depending on version — cover every case.
  function getTitleFromLink(link) {
    // 1. aria-label
    const ariaLabel = link.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim().length > 2) {
      return cleanTitle(deduplicate(ariaLabel));
    }

    // 2. title attribute — now deduplicated
    const titleAttr = link.getAttribute("title");
    if (titleAttr && titleAttr.trim().length > 2) {
      return cleanTitle(deduplicate(titleAttr));
    }

    // 3. first visible span:not([aria-hidden]) — now deduplicated
    const firstTextSpan = link.querySelector("span:not([aria-hidden])");
    if (firstTextSpan) {
      const text = firstTextSpan.textContent.trim();
      if (text.length > 2) return cleanTitle(deduplicate(text));
    }

    // 4. raw textContent
    const raw = (link.textContent || "").replace(/\s+/g, " ").trim();
    return cleanTitle(deduplicate(raw));
  }

  // Reads Claude's sidebar section header labels ("Today", "Yesterday", "Previous 7 days", etc.)
  // and maps each chat link element to the bucket it falls under.
  // This gives meaningful date-range metadata without hitting Claude's private API.
  function getSectionBuckets() {
    const buckets = new Map(); // <a> element → bucket label string
    let currentLabel = null;
    const container = document.querySelector(CHAT_CONTAINER_SELECTOR);
    if (!container) return buckets;

    for (const child of container.querySelectorAll("*")) {
      const text = (child.textContent || "").replace(/\s+/g, " ").trim();
      const isHeader =
        text.length > 0 &&
        text.length < 40 &&
        !child.querySelector('a[href*="/chat/"]') &&
        /^(today|yesterday|previous \d+ days?|january|february|march|april|may|june|july|august|september|october|november|december)/i.test(
          text,
        );

      if (isHeader) {
        currentLabel = text.toLowerCase();
        continue;
      }

      const link = child.matches('a[href*="/chat/"]')
        ? child
        : child.querySelector('a[href*="/chat/"]');
      if (link && currentLabel && !buckets.has(link)) {
        buckets.set(link, currentLabel);
      }
    }

    return buckets;
  }

  const MONTHS_MAP = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
  };

  // Converts a Claude sidebar section header label to a representative Unix timestamp.
  // Used to sort chats by date bucket when sidebarOrder is stale.
  function bucketToTimestamp(label) {
    const cleanLabel = (label || "").trim().toLowerCase();
    const now = Date.now();
    const d = 86400000; // ms per day
    if (/today/i.test(cleanLabel)) return now - 3600000; // proxy: 1h ago
    if (/yesterday/i.test(cleanLabel)) return now - d - 3600000;
    const m = cleanLabel.match(/previous (\d+) days?/i);
    if (m) return now - Number(m[1]) * d;

    // Try parsing a month-year string like "may 2026" or "may" → first day of that month
    const words = cleanLabel.split(/\s+/);
    if (words.length > 0) {
      const monthStr = words[0];
      const monthIdx = MONTHS_MAP[monthStr];
      if (monthIdx !== undefined) {
        let year = new Date().getFullYear();
        if (words.length > 1) {
          const yearNum = parseInt(words[1], 10);
          if (!isNaN(yearNum)) {
            year = yearNum;
          }
        }
        const dt = new Date(year, monthIdx, 1, 0, 0, 0, 0);
        return dt.getTime();
      }
    }
    return null;
  }

  function scrapeVisibleChats() {
    const links = orderedChatLinks();
    const buckets = getSectionBuckets();
    const byId = new Map();
    let sidebarOrder = 0;

    for (const link of links) {
      const normalized = normalizeChatHref(link.getAttribute("href"));
      if (!normalized) continue;
      if (byId.has(normalized.chatId)) continue;

      const title = getTitleFromLink(link);
      const bucketLabel = buckets.get(link) || null;
      const sectionTimestamp = bucketLabel
        ? bucketToTimestamp(bucketLabel)
        : null;

      byId.set(normalized.chatId, {
        chatId: normalized.chatId,
        title,
        url: normalized.url,
        sidebarOrder,
        sectionTimestamp,
      });
      sidebarOrder += 1;
    }

    return Array.from(byId.values());
  }

  // BUG-07 fix B: include isFallback in the snapshot so that when an email is newly detected,
  // the snapshot changes and saveScrape() is not short-circuited.
  function makeSnapshot(accountId, chats, isFallback) {
    return JSON.stringify({
      accountId,
      isFallback: Boolean(isFallback),
      chatIds: chats.map(
        (chat) =>
          `${chat.sidebarOrder}:${chat.chatId}:${chat.title}:${chat.sectionTimestamp || ""}`,
      ),
    });
  }

  async function saveScrape(account, chats) {
    const now = Date.now();
    const accountId = account.accountId;

    // ── IDENTITY AUDIT LOG ───────────────────────────────────────────────────
    // Logs the evidence that determined this scrape's account identity.
    // If identitySource ever shows 'MISMATCH-cookie-vs-resolved', that is the
    // phantom-scrape signature: resolveAccountIdentity() returned a different
    // email than the one extracted from the cookie/DOM at init time.
    const _identitySource = cookieDetectedEmail
      ? (cookieDetectedEmail === account.email ? 'cookie-confirmed' : 'MISMATCH-cookie-vs-resolved')
      : lastDetectedEmail ? 'dom-email' : 'display-name-only';
    cctLog('🔍 saveScrape:identity', {
      accountId,
      email:          account.email,
      isFallback:     account.isFallback,
      identitySource: _identitySource,
      cookieEmail:    cookieDetectedEmail,
      cachedOrgId,
      chatCount:      chats.length,
      firstChatId:    chats[0]?.chatId ?? null,
      ts:             Date.now(),
    });
    if (_identitySource === 'MISMATCH-cookie-vs-resolved' && window.cctDiag) {
      window.cctDiag.push('identity-mismatch', {
        accountId,
        email:       account.email,
        cookieEmail: cookieDetectedEmail,
        cachedOrgId,
        chatCount:   chats.length,
        firstChatId: chats[0]?.chatId ?? null,
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    const localData = await storageGet(["deletedAccountIds"]);
    let localDeleted = localData.deletedAccountIds || [];

    let syncedDeleted = {};
    if (hasSyncApi()) {
      try {
        const synced = await readSyncedData();
        syncedDeleted = synced.deletedAccounts || {};
      } catch (_) {}
    }

    cctGroup(
      `🔍 saveScrape — account: ${accountId} | chats: ${chats.length} | isFallback: ${account.isFallback}`,
    );

    // Tombstone / resurrection check
    if (
      (localDeleted.includes(accountId) || syncedDeleted[accountId]) &&
      !account.isFallback
    ) {
      cctLog(
        "🪦→🌱 Tombstone RESURRECTION for",
        accountId,
        "— removing from deletedAccountIds",
      );
      // Remove from local deleted list
      localDeleted = localDeleted.filter((id) => id !== accountId);
      await storageSet({ deletedAccountIds: localDeleted });

      // Signal background to remove from sync tombstones
      if (hasSyncApi()) {
        try {
          await chrome.runtime.sendMessage({
            type: "RESURRECT_ACCOUNT",
            accountId,
          });
        } catch (_) {
          /* background may be inactive; local resurrection still proceeds */
        }
      }
      // Fall through — allow saveScrape to continue normally
    } else if (localDeleted.includes(accountId) || syncedDeleted[accountId]) {
      // Fallback account is tombstoned and no verified email — respect the tombstone
      await storageSet({
        syncStatus: {
          ok: false,
          updatedAt: now,
          message:
            "Current Claude account was deleted from tracker; scrape skipped",
        },
      });
      return;
    }

    const local = await storageGet([
      STORAGE_KEYS.accounts,
      STORAGE_KEYS.chats,
      STORAGE_KEYS.currentAccountId,
      "lastKnownEmail",
    ]);
    const originalAccounts = local[STORAGE_KEYS.accounts] || {};
    const originalChats = local[STORAGE_KEYS.chats] || {};
    const originalCurrentAccountId = local[STORAGE_KEYS.currentAccountId] || "";
    const originalLastKnownEmail = local.lastKnownEmail || null;

    const accounts = JSON.parse(JSON.stringify(originalAccounts));
    const existingChats = JSON.parse(JSON.stringify(originalChats));

    const currentChatIds = new Set(chats.map((chat) => chat.chatId));

    if (
      !account.isFallback &&
      profileFallbackAccountId &&
      accounts[profileFallbackAccountId]
    ) {
      const fallbackChats = Object.values(existingChats).filter(
        (c) => c.accountId === profileFallbackAccountId,
      );
      cctLog(
        `🔄 Fallback migration: ${fallbackChats.length} chat(s) moving from ${profileFallbackAccountId} → ${accountId}`,
      );
      for (const chat of fallbackChats) {
        const newStorageId = `${accountId}:${chat.chatId}`;
        existingChats[newStorageId] = {
          ...chat,
          storageId: newStorageId,
          accountId,
        };
        delete existingChats[chat.storageId];
      }

      // Fix B: Formally tombstone the fallback so mergeAccounts() cannot
      // resurrect it from syncAccounts on the next sync pass.
      if (!localDeleted.includes(profileFallbackAccountId)) {
        cctLog("🪦 Tombstoning fallback account:", profileFallbackAccountId);
        const updatedDeleted = [...localDeleted, profileFallbackAccountId];
        await storageSet({ deletedAccountIds: updatedDeleted });
        if (hasSyncApi()) {
          try {
            await chrome.runtime.sendMessage({
              type: "TOMBSTONE_ACCOUNT",
              accountId: profileFallbackAccountId,
            });
            cctLog(
              "🪦 Background tombstone confirmed for",
              profileFallbackAccountId,
            );
          } catch (_) {
            cctWarn("🪦 Background tombstone message failed (non-critical)");
          }
        }
      }
    }

    const existingAccount = accounts[accountId] || {};
    const displayName =
      account.displayName ||
      existingAccount.displayName ||
      FALLBACK_ACCOUNT_NAME;

    accounts[accountId] = {
      accountId,
      email: account.email,
      displayName,
      color: existingAccount.color || colorForAccount(accounts),
      firstSeen: existingAccount.firstSeen || now,
      lastSeen: now,
      isFallback: account.isFallback,
      autoDetectedName: true,
    };

    for (const chat of chats) {
      const storageId = `${accountId}:${chat.chatId}`;
      const existingChat = existingChats[storageId] || {};
      existingChats[storageId] = {
        storageId,
        chatId: chat.chatId,
        accountId,
        title: chat.title,
        url: chat.url,
        sidebarOrder: chat.sidebarOrder,
        orderSeenAt: now,
        firstSeen: existingChat.firstSeen || now,
        lastSeen: now,
        // Preserve the most recent non-null sectionTimestamp.
        sectionTimestamp:
          chat.sectionTimestamp !== null
            ? chat.sectionTimestamp
            : existingChat.sectionTimestamp || null,
        // Preserve server-sourced timestamp — never overwrite with null from DOM scrape.
        serverUpdatedAt: existingChat.serverUpdatedAt || null,
      };

      if (!account.isFallback) {
        // Remove the same chat if it was previously stored under this profile's fallback ID.
        // Safe because profileFallbackAccountId is unique per Chrome profile — it never
        // matches another profile's fallback ID.
        //
        // Change A — the former "cross-account cleanup loop" that deleted any storageId
        // sharing this chatId under a different accountId has been intentionally removed.
        // Rationale: two genuine separate Claude accounts CAN produce the same chatId
        // (UUIDs are only namespace-unique, not globally unique across orgs). Deleting the
        // other account's entry on every scrape was causing permanent data loss. The
        // fallback→real migration above (lines ~1577-1613) is the correct and safe mechanism
        // for reclaiming chats written under profileFallbackAccountId; it is profile-scoped
        // and cannot touch entries belonging to other real accounts.
        delete existingChats[`${profileFallbackAccountId}:${chat.chatId}`];
      }
    }

    if (!account.isFallback && accounts[profileFallbackAccountId]) {
      const hasFallbackChats = Object.values(existingChats).some(
        (c) => c.accountId === profileFallbackAccountId,
      );
      if (!hasFallbackChats) {
        delete accounts[profileFallbackAccountId];
      }
    }

    // BUG-07/Fix G: persist lastKnownEmail + lastKnownOrgId together.
    // The org ID is the reliable discriminant on next page load — if it matches,
    // the same account is logged in and the email can be safely restored.
    const storagePayload = {
      accounts,
      chats: existingChats,
      [STORAGE_KEYS.currentAccountId]: accountId,
    };
    if (account.email) {
      storagePayload.lastKnownEmail = account.email;
      if (cachedOrgId) storagePayload.lastKnownOrgId = cachedOrgId;
    }

    // Also persist currentAccountId so the popup "Tracking as" label always reflects
    // the account the content script actually detected — not a guess from another profile.
    const hasChanged =
      stableStringify(originalAccounts) !== stableStringify(accounts) ||
      stableStringify(originalChats) !== stableStringify(existingChats) ||
      originalCurrentAccountId !== accountId ||
      (account.email && originalLastKnownEmail !== account.email);

    if (hasChanged) {
      cctLog(
        `💾 saveScrape writing storage: ${chats.length} chat(s) for account ${accountId}`,
      );
      await storageSet(storagePayload);
      pendingSyncAccounts = accounts;
      pendingSyncChats = existingChats;
      scheduleApiSync(accountId);
    } else {
      cctLog("💾 saveScrape: no changes detected — storage write skipped");
    }
    cctGroupEnd();
  }

  async function runFullScrape() {
    if (stopped) return;
    if (!profileFallbackAccountId) return;

    // Wait for init to fully resolve identity before first scrape.
    // This eliminates the race window where chats get written under
    // acc_pfl_... because the orgId fetch hadn't finished yet.
    await identityReady;

    await handlePendingOpen();

    const accountIdentity = detectAccountIdentity();
    const chats = scrapeVisibleChats();
    cctLog(
      `🔍 Scrape: ${chats.length} chat(s) visible | identity: ${accountIdentity.email || accountIdentity.displayName || "unknown"}`,
    );

    if (!hasStorageApi()) {
      if (!warnedStorageUnavailable) {
        console.info(
          "[Claude Chat Tracker] Extension storage is unavailable in this Claude tab. Reload the extension, then refresh this Claude tab.",
        );
        warnedStorageUnavailable = true;
      }
      return;
    }

    const account = await resolveAccountIdentity(accountIdentity);
    if (chats.length === 0 && isLoginPage()) {
      return;
    }

    if (!account.email && !warnedMissingAccount) {
      cctLog(
        "🔍 No email in DOM — tracking under display name:",
        account.displayName,
      );
      warnedMissingAccount = true;
    }

    // BUG-07 fix B: include isFallback in the snapshot so email upgrades are not blocked
    const snapshot = makeSnapshot(account.accountId, chats, account.isFallback);
    if (snapshot === lastSnapshot) return;
    lastSnapshot = snapshot;

    await saveScrape(account, chats);
  }

  // IMP-04 fix: also wait for page to be fully loaded before scheduling a scrape.
  function scheduleScrape() {
    if (stopped || document.hidden) return;

    // If page hasn't fully loaded yet, wait for readystatechange before scheduling
    if (document.readyState !== "complete") {
      document.addEventListener(
        "readystatechange",
        () => {
          if (document.readyState === "complete") scheduleScrape();
        },
        { once: true },
      );
      return;
    }

    window.clearTimeout(scrapeTimer);
    scrapeTimer = window.setTimeout(() => {
      runFullScrape().catch((error) => {
        if (isExtensionContextInvalidated(error)) {
          stopTracking();
          return;
        }

        console.warn("[Claude Chat Tracker] Scrape failed.", error);
      });
    }, SCRAPE_DEBOUNCE_MS);
  }

  function nodeMayContainChats(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    if (
      node.matches &&
      node.matches(`${CHAT_LINK_SELECTOR}, ${CHAT_CONTAINER_SELECTOR}`)
    )
      return true;
    return Boolean(
      node.querySelector &&
      node.querySelector(`${CHAT_LINK_SELECTOR}, ${CHAT_CONTAINER_SELECTOR}`),
    );
  }

  function mutationsMayAffectChats(mutations) {
    return mutations.some((mutation) => {
      if (nodeMayContainChats(mutation.target)) return true;

      for (const node of mutation.addedNodes) {
        if (nodeMayContainChats(node)) return true;
      }

      for (const node of mutation.removedNodes) {
        if (nodeMayContainChats(node)) return true;
      }

      return false;
    });
  }

  // Phase 5: flush pending sync payload to background worker when conditions are right.
  function flushPendingSync() {
    if (!pendingSyncAccounts || !pendingSyncChats) {
      cctLog("🔄 flushPendingSync: nothing pending — skipping");
      return;
    }
    cctLog("🔄 flushPendingSync: pushing to background sync…");
    const accounts = pendingSyncAccounts;
    const chats = pendingSyncChats;
    pendingSyncAccounts = null;
    pendingSyncChats = null;
    syncMergedData(accounts, chats).catch(() => {
      /* best-effort */
    });
  }

  // Phase 5: reset the 5-minute idle timer on any user interaction.
  function resetIdleSyncTimer() {
    window.clearTimeout(idleSyncTimer);
    idleSyncTimer = window.setTimeout(flushPendingSync, IDLE_SYNC_DELAY_MS);
  }

  function setupObserver() {
    observer = new MutationObserver((mutations) => {
      if (stopped) return;
      if (mutationsMayAffectChats(mutations)) {
        scheduleScrape();
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });

    // Phase 5: flush pending sync when tab becomes hidden (user switches tabs / minimises).
    // Also resume scraping when tab becomes visible again.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        flushPendingSync();
      } else {
        scheduleScrape();
      }
    });

    // Phase 5: idle sync — reset the 5-min timer on each meaningful user interaction.
    document.addEventListener("pointerup", resetIdleSyncTimer, {
      passive: true,
    });
    document.addEventListener("keyup", resetIdleSyncTimer, { passive: true });
    // Seed the timer so a user who never interacts still gets a sync eventually.
    resetIdleSyncTimer();
  }

  // BUG-07 fix C: a separate observer watches for account panel DOM mutations
  // (e.g. when the user opens their profile menu) and triggers a forced re-scrape
  // when a new email becomes visible — even if the chat list has not changed.
  //
  // New bug fix: the previous version ran detectAccountEmail() on EVERY DOM mutation
  // because characterData:true was set, causing CPU overhead from typing/scroll/render.
  // Fixed by: (1) removing characterData:true so only structural DOM changes trigger it,
  // (2) throttling the email check behind a 500ms timer so it runs at most twice/second.
  let accountCheckTimer = null;
  function setupAccountObserver() {
    accountObserver = new MutationObserver(() => {
      if (stopped || accountCheckTimer) return;
      accountCheckTimer = window.setTimeout(() => {
        accountCheckTimer = null;
        if (stopped) return;
        const email = detectAccountEmail();
        if (email && email !== lastDetectedEmail) {
          lastDetectedEmail = email;
          // Force a scrape regardless of snapshot — account identity just upgraded
          lastSnapshot = "";
          window.clearTimeout(scrapeTimer);
          scrapeTimer = window.setTimeout(() => {
            runFullScrape().catch((error) => {
              if (isExtensionContextInvalidated(error)) stopTracking();
            });
          }, 300);
        }
      }, 500); // throttle: check at most every 500ms, not on every DOM mutation
    });

    const root =
      document.querySelector("aside") ||
      document.querySelector("nav") ||
      document.querySelector("header") ||
      document.body ||
      document.documentElement;

    accountObserver.observe(root, {
      childList: true,
      subtree: true,
    });
  }

  setupObserver();
  setupAccountObserver();

  // Listen for the rescrapeRequested sentinel written by the popup's "Clear" button.
  // When the popup wipes chrome.storage.local, the DOM on the Claude tab has not changed,
  // so runFullScrape()'s snapshot guard would silently skip the save and the popup would
  // remain empty. Resetting lastSnapshot here forces the next scrape to write everything.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (stopped || areaName !== "local") return;
    if (changes.rescrapeRequested && changes.rescrapeRequested.newValue) {
      lastSnapshot = ""; // invalidate cached snapshot so the next scrape is unconditional
      scheduleScrape();
    }
  });

  // Handle messages from the popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'CCT_RESUME_INDEXING') {
      const { queue } = window.__cctInternal || {};
      if (queue) queue.resume();
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'CCT_INDEX_ACCOUNT') {
      const { indexAccount } = window.__cctInternal || {};
      if (indexAccount) {
        indexAccount(message.accountId, message.orgId).catch(err => cctWarn("Index account failed:", err));
      }
      sendResponse({ ok: true });
      return true;
    }
  });

  // Load (or generate) the per-profile identity seed before scheduling any scrapes.
  // initProfileLocalId() sets profileFallbackAccountId, which runFullScrape() requires.
  initProfileLocalId().then(() => {
    for (const delay of INITIAL_RETRY_DELAYS) {
      window.setTimeout(scheduleScrape, delay);
    }
  });
  // Private cross-file bridge for extension-internal modules loaded in the same context.
  // Do not access from page scripts — namespaced under __cctInternal to signal intent.
  window.__cctInternal = window.__cctInternal || {};
  window.__cctInternal.fetchRecentChats = fetchRecentChats;
  window.__cctInternal.fetchOrganizationId = fetchOrganizationId;

})();
