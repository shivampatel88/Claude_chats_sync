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

  const MIN_SYNC_INTERVAL_MS = 30000;
  const PENDING_OPEN_TTL_MS = 60 * 1000;

  const MIGRATION_DOUBLED_TITLES_V1 = "migration_doubledTitles_v1";
  // V2: re-run migration after deduplicate() was extended to title attr + span paths.
  const MIGRATION_DOUBLED_TITLES_V2 = "migration_doubledTitles_v2";
  // V1: migrate flat legacy searchIndex / embeddingIndex keys to per-account keys.
  const MIGRATION_LEGACY_SEARCH_V1 = "migration_legacySearch_v1";
  const MIGRATION_LEGACY_ACCOUNTS_V1 = "migration_legacyAccounts_v1";

  // API-based timestamp sync: fetch real conversation updatedAt from Claude's internal API.
  const API_SYNC_INTERVAL_MS = 60 * 1000; // at most once per 60 s
  let cachedOrgId = null; // cached so we don't re-fetch /api/organizations every time
  let cachedOrgIdAt = 0; // timestamp when cachedOrgId was last resolved
  const CACHED_ORG_TTL_MS = 60 * 1000; // 60 seconds TTL before re-verifying active org
  let lastApiSyncAt = 0; // epoch ms of last successful API call
  let lastFetchOrgIdAttemptAt = 0;
  const FETCH_ORG_COOLDOWN_MS = 10000; // 10 seconds cooldown between API requests when logged out

  let scrapeTimer = null;
  let syncTimer = null;
  let observer = null;
  let accountObserver = null;
  let lastSnapshot = "";
  let lastSyncAt = 0;
  // cookieDetectedEmail: best-effort email for display metadata only (does NOT affect accountId).
  let cookieDetectedEmail = null;

  // Gate: true only after initProfileLocalId() confirms a fresh orgId.
  // Reset to false on logout so the next login re-arms it.
  let isIdentityReady = false;
  let initInProgress = false; // prevents concurrent re-entry of initProfileLocalId
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

  // Reset all per-session identity state.
  // Called on every confirmed logout so the next login starts with a clean slate.
  // IMPORTANT: keep this in sync with every module-scoped variable that is
  // identity-dependent — adding a new identity var without resetting it here
  // is how RC-1 class bugs are born.
  function resetSessionState() {
    cachedOrgId = null;
    cachedOrgIdAt = 0;
    cookieDetectedEmail = null;
    lastSnapshot = "";
    lastApiSyncAt = 0;
    lastFetchOrgIdAttemptAt = 0;
    isIdentityReady = false;
    warnedMissingAccount = false;
    cctLog("🔄 Session state reset — identity cleared for new login.");
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
    // Remove the login_hint DNR rule now that the flow is complete or cancelled.
    chrome.runtime.sendMessage({ type: "CLEAR_LOGIN_HINT" }).catch(() => {});
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

    const email = pendingOpen.accountEmail || null;

    // Inject a one-time keyframe for the pulse animation on the CTA button.
    if (!document.getElementById("cct-keyframes")) {
      const style = document.createElement("style");
      style.id = "cct-keyframes";
      style.textContent =
        "@keyframes cct-pulse{0%,100%{box-shadow:0 0 0 0 rgba(217,121,69,.5)}50%{box-shadow:0 0 0 6px rgba(217,121,69,0)}}";
      document.head.appendChild(style);
    }

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
    if (isLoginPage() && email) {
      title.innerHTML = `Signing in as <span style="color:#f4a261;font-weight:800;letter-spacing:.01em">${email}</span>…`;
    } else {
      title.textContent = `Switch to "${pendingOpen.accountName}" — logging in…`;
    }
    title.style.cssText =
      "font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";

    const detail = document.createElement("div");
    if (isLoginPage()) {
      if (email) {
        detail.textContent = "We'll sign you in automatically — one click away";
      } else {
        detail.textContent = `Select "${pendingOpen.accountName}" on the Google screen`;
      }
    } else {
      detail.textContent = `Opening: ${pendingOpen.chatTitle}`;
    }
    detail.style.cssText =
      "color:#b8b0a7;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px";

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.textContent = isLoginPage() ? "Start login" : "Open now";
    // On the login page, make the button a pulsing primary CTA so the user
    // knows exactly what to click (one tap = done).
    openButton.style.cssText = isLoginPage()
      ? "height:30px;border:none;border-radius:8px;background:#d97945;color:#fff;padding:0 14px;cursor:pointer;font:inherit;font-size:12px;font-weight:700;animation:cct-pulse 1.8s ease-in-out infinite"
      : "height:30px;border:1px solid #6d5a4b;border-radius:8px;background:#2a2420;color:#f4f1ea;padding:0 10px;cursor:pointer;font:inherit;font-size:12px";

    openButton.addEventListener("click", () => {
      if (isLoginPage()) {
        const googleBtn = findGoogleSignInElement();
        if (googleBtn) {
          // CRITICAL: click the Google button FIRST — this is the real user gesture.
          // Chrome's popup blocker allows window.open() only from synchronous user
          // gesture handlers. We must NOT await anything before clicking.
          googleBtn.click();
          // Update storage asynchronously after clicking — no race condition because
          // the popup flow takes several seconds to complete.
          setPendingOpen({
            ...pendingOpen,
            googleStarted: true,
            loginStartedAt: Date.now(),
          }).catch(() => {});
          // Stop the pulse animation so the user knows the click was registered.
          openButton.style.animation = "none";
          openButton.textContent = "Logging in…";
          openButton.disabled = true;
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
      }, 800); // 800 ms is sufficient — session cookie is set synchronously on OAuth redirect
    }

    // On the login page, Claude's own auto-login code (GSI + FedCM) fires automatically
    // and fails because there is no active session. This produces a red
    // "There was an error logging you in" banner that confuses users.
    // Since our extension caused this state (we cleared the session cookies), we
    // suppress that specific error element so the user only sees our clean toast.
    if (isLoginPage()) {
      suppressClaudeLoginError();
    }
  }

  // Hides Claude's "There was an error logging you in" banner that appears whenever
  // the page loads without a session and their auto-login (GSI popup + FedCM) fails.
  // We caused this state by clearing cookies for the account switch, so we clean it up.
  // The suppression is scoped to the login page and only active while pendingOpen exists.
  let claudeErrorSuppressor = null;
  function suppressClaudeLoginError() {
    if (claudeErrorSuppressor) return; // already watching

    const ERROR_TEXT = "There was an error logging you in";

    function hideErrorEl() {
      // Walk text nodes looking for the exact error string.
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        null,
      );
      let node;
      while ((node = walker.nextNode())) {
        if (!node.textContent.includes(ERROR_TEXT)) continue;
        // Walk up to find the rendered container block (first element with
        // meaningful width/height that isn't the body itself).
        let el = node.parentElement;
        while (el && el !== document.body) {
          if (el.offsetWidth > 60 && el.offsetHeight > 10) {
            el.style.setProperty("display", "none", "important");
            cctLog("🧹 Suppressed Claude login error banner.");
            break;
          }
          el = el.parentElement;
        }
        break; // only need to hide one instance
      }
    }

    // Run immediately (in case it already rendered) and watch for late injection.
    hideErrorEl();
    claudeErrorSuppressor = new MutationObserver(hideErrorEl);
    claudeErrorSuppressor.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Disconnect after 20 s — the error always appears within the first few seconds.
    window.setTimeout(() => {
      if (claudeErrorSuppressor) {
        claudeErrorSuppressor.disconnect();
        claudeErrorSuppressor = null;
      }
    }, 20000);
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
      // Filter out avatar initials (e.g. single letters like "S" or empty symbols)
      if (line.length < 2) continue;
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

  // Fix A: cookieDetectedEmail is checked before display-name fallback so the real identity
  //        is used from the very first scrape, even before the user opens the account menu.
  function detectAccountIdentity() {
    const email = detectAccountEmail() || cookieDetectedEmail || null;
    if (email && !cookieDetectedEmail) {
      cookieDetectedEmail = email;
      cctLog("🔒 DOM email pinned for session:", email);
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
        if (displayName) return { email, displayName };
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
      if (displayName) return { email, displayName };
    }

    return {
      email,
      displayName: email ? accountLabelFromEmail(email) : FALLBACK_ACCOUNT_NAME,
    };
  }

  function accountLabelFromEmail(email) {
    return email.split("@")[0] || email;
  }

  // accountId is always derived from cachedOrgId (server-confirmed org UUID).
  // orgId is fetched and awaited in initProfileLocalId() before identityReady resolves.
  async function resolveAccountIdentity(accountIdentity) {
    if (!cachedOrgId) return null; // defensive: should never happen after initProfileLocalId

    const accountId = `acc_org_${cachedOrgId.replace(/[^a-z0-9]/gi, "").slice(0, 16)}`;
    const email = (accountIdentity && accountIdentity.email) || cookieDetectedEmail || null;
    const validDisplayName =
      accountIdentity &&
      accountIdentity.displayName &&
      accountIdentity.displayName.length >= 2 &&
      accountIdentity.displayName !== FALLBACK_ACCOUNT_NAME
        ? accountIdentity.displayName
        : null;

    const emailHandle = email ? accountLabelFromEmail(email) : null;
    const displayName =
      emailHandle ||
      validDisplayName ||
      FALLBACK_ACCOUNT_NAME;

    return { accountId, email, displayName };
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

  // One-time migration: purge legacy non-org account duplicate chats when modern
  // acc_org_ entries exist for the same chatIds. Resolves 300+ chatId collision errors.
  async function migrateLegacyAccounts() {
    try {
      const data = await storageGet([STORAGE_KEYS.accounts, STORAGE_KEYS.chats]);
      const accounts = data[STORAGE_KEYS.accounts] || {};
      const chats = data[STORAGE_KEYS.chats] || {};
      let dirty = false;

      // Find all modern org accounts
      const orgAccounts = Object.keys(accounts).filter((id) => id.startsWith("acc_org_"));
      if (orgAccounts.length === 0) return;

      // Map chatIds belonging to modern org accounts
      const orgChatIds = new Set();
      for (const chat of Object.values(chats)) {
        if (chat && chat.accountId && chat.accountId.startsWith("acc_org_")) {
          orgChatIds.add(chat.chatId);
        }
      }

      // If a chat exists under a legacy non-org account, but its chatId is also under an org account, remove the legacy duplicate
      for (const [sid, chat] of Object.entries(chats)) {
        if (chat && chat.accountId && !chat.accountId.startsWith("acc_org_") && orgChatIds.has(chat.chatId)) {
          delete chats[sid];
          dirty = true;
        }
      }

      // If a legacy account has 0 remaining chats, remove it from accounts
      const remainingAccountIds = new Set(Object.values(chats).map((c) => c.accountId));
      for (const acctId of Object.keys(accounts)) {
        if (!acctId.startsWith("acc_org_") && !remainingAccountIds.has(acctId)) {
          delete accounts[acctId];
          dirty = true;
        }
      }

      if (dirty) {
        await storageSet({ [STORAGE_KEYS.accounts]: accounts, [STORAGE_KEYS.chats]: chats });
        cctLog("✅ Migrated legacy accounts and purged pre-org duplicate chats.");
      }
    } catch (err) {
      cctWarn("Migration legacy accounts error:", err);
    }
  }

  // init: fetch orgId (the single account discriminant) then seed email for display.
  // May be called more than once (e.g. after re-login via setupNavigationWatcher);
  // the initInProgress guard prevents concurrent runs.
  async function initProfileLocalId() {
    if (initInProgress) return;
    initInProgress = true;
    isIdentityReady = false; // re-arm the gate while we fetch
    cctGroup("🚀 Init");
    try {
      const data = await storageGet([
        STORAGE_KEYS.profileLocalId,
        STORAGE_KEYS.accounts,
        MIGRATION_DOUBLED_TITLES_V1,
        MIGRATION_DOUBLED_TITLES_V2,
        MIGRATION_LEGACY_SEARCH_V1,
        MIGRATION_LEGACY_ACCOUNTS_V1,
      ]);

      // Fetch orgId first — this is the single source of truth for account identity.
      // All scrapes are gated behind cachedOrgId being non-null.
      cctLog("🔑 Fetching orgId…");
      try {
        await fetchOrganizationId(); // sets cachedOrgId as a side effect
        if (cachedOrgId) {
          const accountId = `acc_org_${cachedOrgId.replace(/[^a-z0-9]/gi, "").slice(0, 16)}`;
          cctLog("✅ orgId confirmed:", cachedOrgId, "— accountId:", accountId);

          // Seed display email specifically for this account from storage
          const localAccounts = data[STORAGE_KEYS.accounts] || {};
          const existingAccount = localAccounts[accountId];
          if (existingAccount && existingAccount.email) {
            cookieDetectedEmail = existingAccount.email;
            cctLog(
              "📧 Email seeded from storage for display:",
              cookieDetectedEmail,
            );
          }
        } else {
          cctLog(
            "⚠️ Not logged in or API error — scrapes blocked until orgId resolves.",
          );
        }
      } catch (orgErr) {
        cctWarn("⚠️ orgId fetch failed:", orgErr && orgErr.message);
      }

      if (!cookieDetectedEmail) {
        // One-shot passive DOM check — no button clicks, no polling.
        const domEmail = detectAccountEmail();
        if (domEmail) {
          cookieDetectedEmail = domEmail;
          cctLog("📧 Email from DOM:", domEmail);
        }
      }

      if (!cookieDetectedEmail && cachedOrgId) {
        const apiEmail = await fetchAccountEmailFromApi();
        if (apiEmail) {
          cookieDetectedEmail = apiEmail;
          cctLog("📧 Email resolved from API:", apiEmail);
        }
      }

      if (cachedOrgId) {
        const activeAccountId = `acc_org_${cachedOrgId.replace(/[^a-z0-9]/gi, "").slice(0, 16)}`;
        
        // Immediately persist currentAccountId to storage so the popup knows the active account
        // without having to wait for a full DOM scrape
        await storageSet({ [STORAGE_KEYS.currentAccountId]: activeAccountId });

        chrome.runtime.sendMessage({
          type: "VAULT_CAPTURE_SESSION",
          accountId: activeAccountId,
          email: cookieDetectedEmail || null,
          orgId: cachedOrgId,
        }).catch(() => {});
      }

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
      if (!data[MIGRATION_LEGACY_SEARCH_V1] && window.migrateLegacyIndexToPerAccount) {
        cctLog("🔧 Running legacy search index migration V1…");
        await window.migrateLegacyIndexToPerAccount();
        await storageSet({ [MIGRATION_LEGACY_SEARCH_V1]: true });
        cctLog("✅ Legacy search index migration V1 done");
      }
      if (!data[MIGRATION_LEGACY_ACCOUNTS_V1]) {
        cctLog("🔧 Running legacy account cleanup migration V1…");
        await migrateLegacyAccounts();
        await storageSet({ [MIGRATION_LEGACY_ACCOUNTS_V1]: true });
        cctLog("✅ Legacy account cleanup migration V1 done");
      }
    } catch (_error) {
      cctError("❌ Init failed:", _error);
    } finally {
      isIdentityReady = true;  // unblock any scrapes waiting in the poll loop
      initInProgress = false;
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
    const chunkKeys = [];
    for (let i = 0; i < chunkCount; i++) {
      chunkKeys.push(`${SYNC_KEYS.chatPrefix}${i}`);
      chunkKeys.push(`${SYNC_KEYS.chatPrefix}${i}_a`);
      chunkKeys.push(`${SYNC_KEYS.chatPrefix}${i}_b`);
    }
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

  async function syncMergedData(localAccounts, localChats) {
    if (!hasSyncApi()) return;

    try {
      const synced = await readSyncedData();
      const localData = await storageGet([
        "deletedChatIds",
        "deletedAccountIds",
      ]);
      const deletedChatIds = localData.deletedChatIds || [];
      const deletedAccountIds = localData.deletedAccountIds || [];

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
        deletedAccountIds,
      );
      const chats = mergeChats(
        synced.chats,
        filteredLocalChats,
        deletedAccounts,
        deletedAccountIds,
      );
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
  async function fetchOrganizationId(bypassCache = false) {
    const now = Date.now();
    const isFresh = cachedOrgId && (now - cachedOrgIdAt < CACHED_ORG_TTL_MS);
    if (isFresh && !bypassCache) {
      cctLog("📡 Org ID (cached):", cachedOrgId);
      return cachedOrgId;
    }
    if (isLoginPage()) {
      cctLog("📡 Login page — skipping org ID fetch.");
      return null;
    }
    if (!bypassCache && now - lastFetchOrgIdAttemptAt < FETCH_ORG_COOLDOWN_MS) {
      return null;
    }
    if (!bypassCache) {
      lastFetchOrgIdAttemptAt = now;
    }
    cctLog("📡 Fetching org ID from /api/organizations…");
    try {
      const res = await fetch("https://claude.ai/api/organizations", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        cctWarn("📡 /api/organizations returned", res.status);
        if (res.status === 403 || res.status === 401) {
          cachedOrgId = null;
          cachedOrgIdAt = 0;
        }
        return null;
      }
      const data = await res.json();
      const orgs = Array.isArray(data) ? data : data.organizations || [];
      const org = orgs.find((o) => !o.is_default_org) || orgs[0];
      if (org) {
        cachedOrgId = org.uuid || org.id || null;
        cachedOrgIdAt = now;
        cctLog("📡 Org ID resolved:", cachedOrgId);
      }
    } catch (err) {
      cctWarn("📡 fetchOrganizationId error:", err.message || err);
    }
    return cachedOrgId;
  }

  // Fetch user account details (like email) from Claude's internal API.
  async function fetchAccountEmailFromApi() {
    if (isLoginPage()) {
      return null;
    }
    cctLog("📡 Fetching account email from /api/account…");
    try {
      const res = await fetch("https://claude.ai/api/account", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        cctWarn("📡 /api/account returned", res.status);
        return null;
      }
      const data = await res.json();
      const email = data.email_address || data.email || null;
      if (email && typeof email === "string") {
        return email.toLowerCase();
      }
    } catch (err) {
      cctWarn("📡 fetchAccountEmailFromApi error:", err.message || err);
    }
    return null;
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

    const local = await storageGet([
      STORAGE_KEYS.accounts,
      STORAGE_KEYS.chats,
      "deletedChatIds",
    ]);
    const accounts = local[STORAGE_KEYS.accounts] || {};
    const chats = local[STORAGE_KEYS.chats] || {};
    const deletedChatIds = local.deletedChatIds || [];

    const apiMap = new Map(apiChats.map((c) => [c.chatId, c]));
    let dirty = false;
    let timestampsUpdated = 0;
    let titlesFixed = 0;
    let orphanedDeleted = 0;

    // Cross-account phantom purge.
    // The API confirms exactly which chatIds belong to currentAccountId's org.
    // If the same chatId exists under a DIFFERENT real accountId, that entry
    // is a phantom from a mis-attributed scrape — remove it now.
    // Guard: only act on chatIds the API explicitly returned (apiMap.has).
    // This cleans up existing historical duplicates; new ones cannot form
    // because accountId is now always derived from cachedOrgId.
    if (currentAccountId) {
      for (const [storageId, chat] of Object.entries(chats)) {
        if (chat.accountId === currentAccountId) continue;
        if (chat.accountId.startsWith('acc_pfl_')) continue;
        if (!apiMap.has(chat.chatId)) continue;
        cctLog(`🧹 Phantom purge: "${chat.title}" (${storageId}) confirmed belongs to ${currentAccountId}`);
        delete chats[storageId];
        if (!deletedChatIds.includes(storageId)) deletedChatIds.push(storageId);
        dirty = true;
        orphanedDeleted++;
      }
    }

    let oldestApiTs = 0;
    if (apiChats.length >= 100) {
      oldestApiTs = Math.min(...apiChats.map((c) => c.updatedAt || 0));
    }

    for (const [storageId, chat] of Object.entries(chats)) {
      if (
        currentAccountId &&
        chat.accountId === currentAccountId &&
        !apiMap.has(chat.chatId)
      ) {
        let shouldDelete = false;
        if (apiChats.length < 100) {
          shouldDelete = true;
        } else {
          if (chat.serverUpdatedAt && chat.serverUpdatedAt >= oldestApiTs) {
            shouldDelete = true;
          } else if (
            !chat.serverUpdatedAt &&
            chat.sectionTimestamp &&
            chat.sectionTimestamp >= oldestApiTs
          ) {
            shouldDelete = true;
          }
        }

        if (shouldDelete) {
          cctLog(
            `🗑️ Chat deleted via API sync: "${chat.title}" (${storageId})`,
          );
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
      // Trigger a sync to push the updated state to chrome.storage.sync.
      scheduleSync(accounts, chats);
      cctLog("💾 Local storage updated; sync scheduled.");
    } else {
      cctLog("💾 No changes — all timestamps already current");
    }
  }

  // Throttled entry point: called from saveScrape() on every scrape that produces a change.
  // The 60-second guard means we never hammer Claude's API.
  //
  // Phase 2 simplification: the orgId mismatch guard is gone. accountId is now always
  // derived from the live cachedOrgId fetched at init time, so there is no stale cached
  // email to invalidate. If the user switches accounts, the next page load fetches a new
  // orgId → new accountId → new storage key. No reset loop possible.
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

    fetchRecentChats()
      .then((apiChats) => {
        if (!stopped && apiChats) {
          applyServerTimestamps(apiChats, accountId);
        } else if (apiChats === null) {
          cctLog(
            "📡 API sync returned no data — will retry on next scrape cycle",
          );
        }
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

  function makeSnapshot(accountId, chats) {
    return JSON.stringify({
      accountId,
      chatIds: chats.map(
        (chat) =>
          `${chat.sidebarOrder}:${chat.chatId}:${chat.title}:${chat.sectionTimestamp || ""}`,
      ),
    });
  }

  async function saveScrape(account, chats) {
    const now = Date.now();
    const accountId = account.accountId;
    cctLog(
      `🔍 saveScrape: account=${accountId} email=${account.email || "(none)"} chats=${chats.length} org=${cachedOrgId}`,
    );

    const localData = await storageGet(["deletedAccountIds"]);
    let localDeleted = localData.deletedAccountIds || [];

    let syncedDeleted = {};
    if (hasSyncApi()) {
      try {
        const synced = await readSyncedData();
        syncedDeleted = synced.deletedAccounts || {};
      } catch (_) {}
    }

    cctGroup(`🔍 saveScrape — account: ${accountId} | chats: ${chats.length}`);

    // Tombstone check: resurrect if the account was previously deleted.
    // orgId-derived accountIds are server-confirmed, so we always resurrect on re-detection.
    if (localDeleted.includes(accountId) || syncedDeleted[accountId]) {
      cctLog("🪦→🌱 Tombstone RESURRECTION for", accountId);
      localDeleted = localDeleted.filter((id) => id !== accountId);
      await storageSet({ deletedAccountIds: localDeleted });
      if (hasSyncApi()) {
        try {
          await chrome.runtime.sendMessage({
            type: "RESURRECT_ACCOUNT",
            accountId,
          });
        } catch (_) {
          /* background may be inactive */
        }
      }
      // Fall through — allow saveScrape to continue
    }

    const local = await storageGet([
      STORAGE_KEYS.accounts,
      STORAGE_KEYS.chats,
      STORAGE_KEYS.currentAccountId,
    ]);
    const originalAccounts = local[STORAGE_KEYS.accounts] || {};
    const originalChats = local[STORAGE_KEYS.chats] || {};
    const originalCurrentAccountId = local[STORAGE_KEYS.currentAccountId] || "";

    const accounts = JSON.parse(JSON.stringify(originalAccounts));
    const existingChats = JSON.parse(JSON.stringify(originalChats));

    // Phase 2: fallback migration block deleted. accountId is always orgId-derived;
    // acc_pfl_* entries are never written. Existing acc_pfl_* entries in storage
    // remain visible in the popup until naturally evicted by sync pruning.

    const existingAccount = accounts[accountId] || {};
    const displayName =
      (existingAccount.autoDetectedName === false && existingAccount.displayName)
        ? existingAccount.displayName
        : (account.displayName && account.displayName !== FALLBACK_ACCOUNT_NAME)
          ? account.displayName
          : (existingAccount.displayName || FALLBACK_ACCOUNT_NAME);

    accounts[accountId] = {
      accountId,
      email: account.email || existingAccount.email || null,
      displayName,
      color: existingAccount.color || colorForAccount(accounts),
      firstSeen: existingAccount.firstSeen || now,
      lastSeen: now,
      autoDetectedName: existingAccount.autoDetectedName === false ? false : true,
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

      // Clean up legacy non-org entries for this chatId to prevent collision and duplication
      for (const [sid, c] of Object.entries(existingChats)) {
        if (sid !== storageId && c && c.chatId === chat.chatId && typeof c.accountId === "string" && !c.accountId.startsWith("acc_org_")) {
          delete existingChats[sid];
        }
      }
    }

    // Phase 2: lastKnownEmail write removed. Email is stored on the account object
    // (accounts[accountId].email) and /api/account fetches it fresh at init time.
    // A separate lastKnownEmail key is redundant and was never read for identity.
    const storagePayload = {
      accounts,
      chats: existingChats,
      [STORAGE_KEYS.currentAccountId]: accountId,
    };

    const hasChanged =
      stableStringify(originalAccounts) !== stableStringify(accounts) ||
      stableStringify(originalChats) !== stableStringify(existingChats) ||
      originalCurrentAccountId !== accountId;

    if (hasChanged) {
      cctLog(
        `💾 saveScrape writing storage: ${chats.length} chat(s) for account ${accountId}`,
      );
      await storageSet(storagePayload);
      chrome.runtime.sendMessage({
        type: "VAULT_CAPTURE_SESSION",
        accountId,
        email: account.email || null,
        orgId: cachedOrgId,
      }).catch(() => {});
      // Phase 2: direct scheduleSync call.
      scheduleSync(accounts, existingChats);
      scheduleApiSync(accountId);
    } else {
      cctLog("💾 saveScrape: no changes detected — storage write skipped");
    }
    cctGroupEnd();
  }

  async function runFullScrape() {
    if (stopped) return;

    // RC-3 fix: isIdentityReady is a resettable boolean (was a one-shot Promise).
    // Poll with a 50 ms yield so we never block the JS thread while waiting for
    // initProfileLocalId() to confirm the orgId after a re-login.
    while (!isIdentityReady) {
      await new Promise((r) => setTimeout(r, 50));
      if (stopped) return;
    }

    // Snapshot the orgId at the point we enter the scrape body.
    // RC-5 fix: if cachedOrgId shifts during the async await chain below (e.g.
    // another logout/login fires mid-flight), we abort before saveScrape.
    const orgIdAtScrapeStart = cachedOrgId;

    // ROOT-FIX (Change 1B): Never scrape without a confirmed orgId.
    // RC-2 fix: use bypassCache=true here so a fresh login is not blocked by
    // the 10-second cooldown that was set when the previous user's session ended.
    if (!cachedOrgId) {
      await fetchOrganizationId(true);
      if (cachedOrgId) {
        // Just resolved orgId! Reset lastSnapshot to force a fresh scrape write.
        lastSnapshot = "";

        // Try to restore display email from existing account details in storage
        const local = await storageGet([STORAGE_KEYS.accounts]);
        const localAccounts = local[STORAGE_KEYS.accounts] || {};
        const accountId = `acc_org_${cachedOrgId.replace(/[^a-z0-9]/gi, "").slice(0, 16)}`;
        const existingAccount = localAccounts[accountId];
        if (existingAccount && existingAccount.email) {
          cookieDetectedEmail = existingAccount.email;
          cctLog(
            "📧 Email restored from storage for newly resolved account:",
            cookieDetectedEmail,
          );
        }

        if (!cookieDetectedEmail && cachedOrgId) {
          const apiEmail = await fetchAccountEmailFromApi();
          if (apiEmail) {
            cookieDetectedEmail = apiEmail;
            cctLog(
              "📧 Email resolved from API for newly resolved account:",
              apiEmail,
            );
          }
        }
      }
    }

    if (!cachedOrgId) {
      // Still run handlePendingOpen even when logged out.
      // The toast and Google-button auto-click MUST fire on the /login page,
      // which is exactly the state where cachedOrgId is null (cookies cleared).
      await handlePendingOpen();
      cctLog(
        "🚫 runFullScrape: no orgId confirmed — user not logged in or API error. Scrape skipped.",
      );
      return;
    }

    await handlePendingOpen();

    const accountIdentity = detectAccountIdentity();
    const chats = scrapeVisibleChats();
    cctLog(
      `🔍 Scrape: ${chats.length} chat(s) visible | orgId: ${cachedOrgId} | email: ${accountIdentity.email || accountIdentity.displayName || "(not yet detected)"}`,
    );

    if (chats.length === 0) {
      cctLog(
        "🔍 0 chats detected. Verifying active session before updating storage…",
      );
      const activeOrgId = await fetchOrganizationId(true);
      if (!activeOrgId) {
        cctLog(
          "🚫 Active session lost or logged out. Scrape aborted to protect existing data.",
        );
        return;
      }
    }

    if (!hasStorageApi()) {
      if (!warnedStorageUnavailable) {
        console.info(
          "[Claude Chat Tracker] Extension storage is unavailable in this Claude tab. Reload the extension, then refresh this Claude tab.",
        );
        warnedStorageUnavailable = true;
      }
      return;
    }

    // ROOT-FIX (Change 1D): resolveAccountIdentity returns null if cachedOrgId is somehow
    // absent (defensive — Change 1B should prevent reaching here without it).
    const account = await resolveAccountIdentity(accountIdentity);
    if (!account) {
      cctLog(
        "🚫 runFullScrape: resolveAccountIdentity returned null — scrape aborted.",
      );
      return;
    }

    if (chats.length === 0 && isLoginPage()) {
      return;
    }

    if (!account.email && !warnedMissingAccount) {
      cctLog(
        "🔍 No email in DOM yet — tracking under orgId-derived accountId:",
        account.accountId,
      );
      warnedMissingAccount = true;
    }

    const snapshot = makeSnapshot(account.accountId, chats);
    if (snapshot === lastSnapshot) return;
    lastSnapshot = snapshot;

    // RC-5 fix: abort if a logout/login occurred during the async chain above.
    // cachedOrgId could have been reset to null (logout) or to a new orgId (re-login)
    // while we were awaiting resolveAccountIdentity or the 0-chats guard fetch.
    if (cachedOrgId !== orgIdAtScrapeStart) {
      cctLog(
        "⚠️ orgId changed mid-scrape (was:",
        orgIdAtScrapeStart,
        "now:",
        cachedOrgId,
        ") — aborting to prevent mis-attribution.",
      );
      return;
    }

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

    // Resume scraping when tab becomes visible again after being hidden.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        scheduleScrape();
      }
    });
  }

  // Account observer: passively captures email from DOM for display metadata.
  // accountId is orgId-derived and unaffected by email detection.
  let accountCheckTimer = null;
  function setupAccountObserver() {
    accountObserver = new MutationObserver(() => {
      if (stopped || accountCheckTimer) return;
      accountCheckTimer = window.setTimeout(() => {
        accountCheckTimer = null;
        if (stopped) return;
        const email = detectAccountEmail();
        if (email && email !== cookieDetectedEmail) {
          cookieDetectedEmail = email;
          cctLog(
            "📧 Account observer: email captured/updated for display:",
            email,
          );
          lastSnapshot = ""; // Invalidate snapshot so the new email gets written to storage
          scheduleScrape();
        }
      }, 500);
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

  // RC-1 + RC-3 fix: watch SPA URL changes to detect logout and re-login
  // without relying on page reloads.  Claude uses history.pushState for all
  // navigation, so we intercept it to get zero-latency logout detection.
  function setupNavigationWatcher() {
    let lastPathname = location.pathname;

    function onNavigate() {
      const current = location.pathname;
      if (current === lastPathname) return;

      const wasLoggedIn  = !lastPathname.startsWith("/login");
      const isNowLogin   =  current.startsWith("/login");
      const wasLogin     =  lastPathname.startsWith("/login");
      const isNowLoggedIn = !current.startsWith("/login");

      if (wasLoggedIn && isNowLogin) {
        // Navigated to /login → user just logged out.
        cctLog("🔓 Logout detected (URL:", lastPathname, "→", current, ") — resetting session state.");
        resetSessionState();
      } else if (current === "/" || current === "/new" || current === "/chats" || (wasLogin && isNowLoggedIn)) {
        // Landing or root navigation — re-verify org identity in case user switched profiles
        cachedOrgIdAt = 0; // invalidate cache TTL
        initProfileLocalId().then(() => scheduleScrape());
      }

      lastPathname = current;
    }

    // Intercept history.pushState and history.replaceState (used by Claude's SPA router).
    const origPushState = history.pushState.bind(history);
    history.pushState = function (...args) {
      origPushState(...args);
      onNavigate();
    };

    const origReplaceState = history.replaceState.bind(history);
    history.replaceState = function (...args) {
      origReplaceState(...args);
      onNavigate();
    };

    // Also handle browser back/forward navigation.
    window.addEventListener("popstate", onNavigate);
  }

  setupObserver();
  setupAccountObserver();
  setupNavigationWatcher();

  // Listen for rescrapeRequested (written by popup's "Clear" button) to force
  // the next scrape to write everything even if the DOM hasn't visually changed.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (stopped || areaName !== "local") return;
    if (changes.rescrapeRequested && changes.rescrapeRequested.newValue) {
      lastSnapshot = ""; // reset snapshot so next scrape writes unconditionally
      scheduleScrape();
    }
    if (changes.currentAccountId && changes.currentAccountId.newValue) {
      // Popup or background switched accounts: invalidate cached orgId and re-verify identity
      cachedOrgId = null;
      cachedOrgIdAt = 0;
      lastSnapshot = "";
      initProfileLocalId().then(() => scheduleScrape());
    }
  });

  // Handle messages from the popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "CCT_RESUME_INDEXING") {
      const { queue } = window.__cctInternal || {};
      if (queue) queue.resume();
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === "CCT_INDEX_ACCOUNT") {
      const { indexAccount } = window.__cctInternal || {};
      if (indexAccount) {
        indexAccount(message.accountId, message.orgId, message.apiKey || null).catch((err) =>
          cctWarn("Index account failed:", err),
        );
      }
      sendResponse({ ok: true });
      return true;
    }
  });

  // Fetch orgId + init profile seed, then schedule the initial scrape retries.
  // All scrapes are gated on cachedOrgId being non-null (set inside initProfileLocalId).
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
