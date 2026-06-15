(function () {
  'use strict';

  const STORAGE_KEYS = {
    accounts: 'accounts',
    chats: 'chats',
    currentAccountId: 'currentAccountId',
    syncStatus: 'syncStatus',
    pendingOpen: 'pendingOpen',
    profileLocalId: 'profileLocalId'
  };

  const SYNC_KEYS = {
    accounts: 'syncAccounts',
    meta: 'syncMeta',
    chatPrefix: 'syncChats_',
    deletedAccounts: 'syncDeletedAccounts'
  };

  const ACCOUNT_COLORS = [
    '#4A90D9',
    '#D9784A',
    '#45A878',
    '#8D66CC',
    '#C9A227',
    '#2D9BA3',
    '#C85C7A',
    '#789A45'
  ];

  const ACCOUNT_SELECTORS = [
    '[data-testid="user-menu-email"]',
    '[data-testid="account-email"]',
    '[data-testid*="account"]',
    '[data-testid*="user"]',
    '[aria-label*="@"]',
    'button[aria-label*="account" i]',
    'button[aria-label*="profile" i]',
    'nav',
    'aside',
    '[role="navigation"]',
    'header'
  ];

  const CHAT_LINK_SELECTOR = 'a[href*="/chat/"]';
  const CHAT_CONTAINER_SELECTOR = 'aside, nav, [role="navigation"]';
  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const SCRAPE_DEBOUNCE_MS = 1200;
  const INITIAL_RETRY_DELAYS = [800, 1800, 3500, 6000, 12000, 20000];
  // Fallback display name shown when Claude does not expose an email address
  const FALLBACK_ACCOUNT_NAME = 'Current Claude account';

  // Set during init to a value unique per Chrome profile — never shared across profiles
  let profileFallbackAccountId = null;
  const MIN_SYNC_INTERVAL_MS = 30000;
  const PENDING_OPEN_TTL_MS = 60 * 1000;

  // Phase 5: pending sync payload — populated by saveScrape(), flushed on idle/hide.
  let pendingSyncAccounts = null;
  let pendingSyncChats = null;
  let idleSyncTimer = null;
  const IDLE_SYNC_DELAY_MS = 5 * 60 * 1000; // 5 minutes of user inactivity
  const MIGRATION_DOUBLED_TITLES_V1 = 'migration_doubledTitles_v1';
  // V2: re-run migration after deduplicate() was extended to title attr + span paths.
  const MIGRATION_DOUBLED_TITLES_V2 = 'migration_doubledTitles_v2';

  // API-based timestamp sync: fetch real conversation updatedAt from Claude's internal API.
  const API_SYNC_INTERVAL_MS = 60 * 1000; // at most once per 60 s
  let cachedOrgId = null;     // cached so we don't re-fetch /api/organizations every time
  let lastApiSyncAt = 0;      // epoch ms of last successful API call

  let scrapeTimer = null;
  let syncTimer = null;
  let observer = null;
  let accountObserver = null;
  let lastSnapshot = '';
  let lastSyncAt = 0;
  let lastDetectedEmail = null; // persisted email seed so first scrape uses real identity
  let cookieDetectedEmail = null; // email extracted from auth-cookie JWT by background worker at init
  let warnedMissingAccount = false;
  let warnedStorageUnavailable = false;
  let stopped = false;
  let pendingToast = null;
  let pendingNavigationTimer = null;
  let pendingNavigationScheduled = false; // true while the redirect/logout timer is pending on the landing page
  let googleStartTimer = null;

  function isExtensionContextInvalidated(error) {
    return /extension context invalidated/i.test(String(error && (error.message || error)));
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
      return !stopped
        && typeof chrome !== 'undefined'
        && chrome.runtime
        && chrome.runtime.id
        && chrome.storage
        && chrome.storage.local
        && typeof chrome.storage.local.get === 'function'
        && typeof chrome.storage.local.set === 'function';
    } catch (_error) {
      return false;
    }
  }

  function hasSyncApi() {
    try {
      return !stopped
        && typeof chrome !== 'undefined'
        && chrome.runtime
        && chrome.runtime.id
        && chrome.storage
        && chrome.storage.sync
        && typeof chrome.storage.sync.get === 'function'
        && typeof chrome.storage.sync.set === 'function';
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

  // Fix A: Ask the background worker to scan auth-cookie JWTs for the user's email.
  // This gives us the real email before the user ever opens the account dropdown.
  // Best-effort — returns null if the background is inactive or cookies contain no JWT.
  async function tryGetEmailFromBackground() {
    if (!hasStorageApi()) return null;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNT_EMAIL' });
      if (response && response.ok && response.email) return response.email.toLowerCase();
    } catch (_) { /* background may not be running yet */ }
    return null;
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
    return (element && element.textContent ? element.textContent : '').replace(/\s+/g, ' ').trim();
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
    return location.pathname.startsWith('/login');
  }

  function isPostLoginLandingPage() {
    return location.pathname === '/'
      || location.pathname === '/new';
  }

  function shouldHandlePendingOpenHere(pendingOpen) {
    // isPendingFlowUrl (ctt param) was removed: Google OAuth strips all custom query params,
    // so the ctt value can never be verified after the OAuth redirect.
    return isLoginPage()
      || isPostLoginLandingPage()
      || sameClaudeChatUrl(location.href, pendingOpen.chatUrl);
  }

  // Finds the "Continue with Google" (or equivalent) button on Claude's login page.
  // Handles text-based, aria-label-based, and image/SVG-based Google buttons.
  // BUG-04 fix: removed the text.length === 0 fallback that matched any icon-only button.
  function findGoogleSignInElement() {
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    return candidates.find(element => {
      const aria = (element.getAttribute('aria-label') || '').toLowerCase();
      // Rule 1: If aria-label contains google, match it.
      if (aria.includes('google')) {
        return true;
      }

      // Rule 2: If a child image alt or src contains google, match it.
      const hasChildImgGoogle = Boolean(element.querySelector('img[src*="google" i], img[alt*="google" i]'));
      if (hasChildImgGoogle) {
        return true;
      }

      // Rule 3: If only visible text contains google, also require one action word
      const text = textOf(element).toLowerCase();
      if (text.includes('google')) {
        const hasActionWord = text.includes('continue') || text.includes('sign') || text.includes('log');
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
          const detailEl = document.querySelector('#claude-chat-tracker-toast [style*="color:#b8b0a7"]');
          if (detailEl) detailEl.textContent = 'Could not find Google button — click "Continue with Google" manually';
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
        loginStartedAt: Date.now()
      });
      button.click();
    };

    googleStartTimer = window.setTimeout(tryClick, 500);
  }

  function makePendingToast(pendingOpen) {
    removePendingToast();

    const toast = document.createElement('div');
    toast.id = 'claude-chat-tracker-toast';
    toast.style.cssText = [
      'position:fixed',
      'top:14px',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:2147483647',
      'width:min(720px,calc(100vw - 32px))',
      'background:#191817',
      'color:#f4f1ea',
      'border:1px solid #d97945',
      'border-radius:10px',
      'box-shadow:0 16px 44px rgba(0,0,0,.42)',
      'padding:12px 14px',
      'font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'display:grid',
      'grid-template-columns:minmax(0,1fr) auto auto',
      'gap:10px',
      'align-items:center'
    ].join(';');

    const message = document.createElement('div');
    message.style.minWidth = '0';

    const title = document.createElement('div');
    title.textContent = `Switch to "${pendingOpen.accountName}" — logging in…`;
    title.style.cssText = 'font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';

    const detail = document.createElement('div');
    detail.textContent = isLoginPage()
      ? `Select "${pendingOpen.accountName}" on the Google screen. Target: ${pendingOpen.chatTitle}`
      : `Opening: ${pendingOpen.chatTitle}`;
    detail.style.cssText = 'color:#b8b0a7;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px';

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.textContent = isLoginPage() ? 'Start login' : 'Open now';
    openButton.style.cssText = 'height:30px;border:1px solid #6d5a4b;border-radius:8px;background:#2a2420;color:#f4f1ea;padding:0 10px;cursor:pointer;font:inherit;font-size:12px';
    openButton.addEventListener('click', async () => {
      if (isLoginPage()) {
        const button = findGoogleSignInElement();
        if (button) {
          await setPendingOpen({
            ...pendingOpen,
            googleStarted: true,
            loginStartedAt: Date.now()
          });
          button.click();
          return;
        }
      }
      location.assign(pendingOpen.chatUrl);
    });

    const dismissButton = document.createElement('button');
    dismissButton.type = 'button';
    dismissButton.textContent = 'Dismiss';
    dismissButton.style.cssText = 'height:30px;border:1px solid #37352f;border-radius:8px;background:#1d1d1c;color:#b8b0a7;padding:0 10px;cursor:pointer;font:inherit;font-size:12px';
    dismissButton.addEventListener('click', () => {
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

    const ariaLabel = element.getAttribute && element.getAttribute('aria-label');
    const title = element.getAttribute && element.getAttribute('title');
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
    const raw = value || '';
    const emailMatch = raw.match(EMAIL_RE);
    if (emailMatch) return accountLabelFromEmail(emailMatch[0].toLowerCase());

    // Claude's profile button aria-label is formatted as "Name, Settings" or "Name, Profile".
    // Strip trailing comma-separated UI label fragments before processing.
    // e.g. "shivam patel, Settings" → "shivam patel"
    const UI_SUFFIXES = [
      'settings', 'help', 'upgrade', 'free plan', 'profile',
      'account', 'customize', 'sign out', 'log out', 'logout'
    ];

    // Pre-process: if the value contains ", SuffixWord" at the end, strip it
    let cleaned = raw;
    for (const suffix of UI_SUFFIXES) {
      const pattern = new RegExp(`,\\s*${suffix}\\s*$`, 'i');
      cleaned = cleaned.replace(pattern, '');
    }

    const blocked = [
      'claude',
      'new chat',
      'search',
      'chats',
      'projects',
      'artifacts',
      'code',
      'customize',
      'free plan',
      'upgrade',
      'settings',
      'help'
    ];

    const lines = cleaned
      .split(/\n| {2,}/)
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    for (const line of lines) {
      const lower = line.toLowerCase();
      if (line.length > 36) continue;
      if (blocked.includes(lower)) continue;
      if (blocked.some(word => lower === word || lower.startsWith(`${word} `) || lower.endsWith(` ${word}`) || lower.endsWith(`, ${word}`))) continue;
      if (/^\d+\s/.test(line)) continue;
      return line;
    }

    return null;
  }

  function findDisplayNameInElement(element) {
    if (!element) return null;

    const candidates = [
      element.getAttribute && element.getAttribute('aria-label'),
      element.getAttribute && element.getAttribute('title'),
      element.innerText,
      textOf(element)
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
      return {
        email,
        displayName: accountLabelFromEmail(email)
      };
    }

    // Fix A: cookie-extracted email — available immediately at page load without UI interaction.
    if (cookieDetectedEmail) {
      return {
        email: cookieDetectedEmail,
        displayName: accountLabelFromEmail(cookieDetectedEmail)
      };
    }

    // Pass 1: specific high-confidence selectors (most reliable)
    const highConfidenceSelectors = [
      '[data-testid*="user"]',
      '[data-testid*="account"]',
      'button[aria-label*="account" i]',
      'button[aria-label*="profile" i]'
    ];

    for (const selector of highConfidenceSelectors) {
      const elements = Array.from(document.querySelectorAll(selector)).filter(isVisible);
      for (const el of elements) {
        const displayName = findDisplayNameInElement(el);
        if (displayName) return { email: null, displayName };
      }
    }

    // Pass 2: broad scan of sidebar/nav/header buttons, sorted bottom-first
    // (Claude's account button is at bottom-left of the sidebar)
    const broadCandidates = Array.from(document.querySelectorAll('aside button, nav button, header button'))
      .filter(isVisible)
      .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);

    for (const element of broadCandidates) {
      const displayName = findDisplayNameInElement(element);
      if (displayName) return { email: null, displayName };
    }

    return {
      email: null,
      displayName: FALLBACK_ACCOUNT_NAME
    };
  }


  async function hashValue(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
  }



  function accountLabelFromEmail(email) {
    return email.split('@')[0] || email;
  }

  async function resolveAccountIdentity(accountIdentity) {
    if (!accountIdentity || !accountIdentity.email) {
      // Always use the per-profile unique fallback — never read currentAccountId here.
      // currentAccountId is a popup UI preference only and must not influence scraping identity.
      // Using it caused chats from one Chrome profile to be attributed to another profile's account.
      return {
        accountId: profileFallbackAccountId,
        email: null,
        displayName: accountIdentity && accountIdentity.displayName
          ? accountIdentity.displayName
          : FALLBACK_ACCOUNT_NAME,
        isFallback: true
      };
    }

    const accountHash = await hashValue(accountIdentity.email);
    return {
      accountId: `acc_${accountHash.slice(0, 16)}`,
      email: accountIdentity.email,
      displayName: accountIdentity.displayName || accountLabelFromEmail(accountIdentity.email),
      isFallback: false
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
        const fixed = deduplicate(chat.title || '');
        if (fixed !== (chat.title || '')) {
          chat.title = fixed;
          dirty = true;
        }
      }
      if (dirty) await storageSet({ chats });
    } catch (_) { /* non-critical — silently skip if storage is unavailable */ }
  }

  // Reads or generates a stable, unique seed for this Chrome profile from local storage,
  // then derives profileFallbackAccountId from it.  Each Chrome profile gets its own seed
  // so fallback accounts are never shared or merged across profiles via chrome.storage.sync.
  // BUG-05 fix: use crypto.randomUUID() instead of Date.now() + Math.random() to avoid collisions.
  // BUG-07 fix: also restore lastKnownEmail from storage so the first scrape uses real identity.
  async function initProfileLocalId() {
    try {
      const data = await storageGet([
        STORAGE_KEYS.profileLocalId,
        'lastKnownEmail',
        MIGRATION_DOUBLED_TITLES_V1,
        MIGRATION_DOUBLED_TITLES_V2
      ]);
      let id = data[STORAGE_KEYS.profileLocalId];
      if (!id) {
        // crypto.randomUUID() is available in MV3 content scripts — zero collision probability
        id = `profile_${crypto.randomUUID()}`;
        await storageSet({ [STORAGE_KEYS.profileLocalId]: id });
      }
      // Derive a stable, unique fallback account ID from the per-profile seed.
      // Sanitise to alphanum only, then take first 16 chars as a short readable suffix.
      profileFallbackAccountId = `acc_pfl_${id.replace(/[^a-z0-9]/gi, '').slice(0, 16)}`;

      // One-time title deduplication migration for already-stored doubled titles (original)
      if (!data[MIGRATION_DOUBLED_TITLES_V1]) {
        await migrateDoubledTitles();
        await storageSet({ [MIGRATION_DOUBLED_TITLES_V1]: true });
      }

      // V2: re-run now that deduplicate() covers title-attr and span-text paths too
      if (!data[MIGRATION_DOUBLED_TITLES_V2]) {
        await migrateDoubledTitles();
        await storageSet({ [MIGRATION_DOUBLED_TITLES_V2]: true });
      }

      // Fix A: seed cookieDetectedEmail early so the first scrape uses the real email
      // even before the user opens the Claude account dropdown.
      const cookieEmail = await tryGetEmailFromBackground();
      if (cookieEmail) {
        cookieDetectedEmail = cookieEmail;
        lastDetectedEmail = cookieEmail; // also seed the snapshot guard
      }
    } catch (_error) {
      // If storage is unavailable at init time, use a session-only ID so scraping can
      // still proceed. It will not persist across page reloads, but it prevents cross-
      // profile contamination for the current session.
      profileFallbackAccountId = `acc_pfl_${Date.now().toString(36)}`;
    }
  }

  // Storage optimisation: drop s (storageId) and u (url) — both are reconstructable:
  //   storageId = accountId + ":" + chatId
  //   url       = "https://claude.ai/chat/" + chatId
  // Saves ~57 bytes per chat entry in chrome.storage.sync chunks.
  // st = sectionTimestamp: date-bucket timestamp scraped from Claude's sidebar section headers.


  async function readSyncedData() {
    const syncHeader = await syncGet([SYNC_KEYS.accounts, SYNC_KEYS.meta, SYNC_KEYS.deletedAccounts]);
    const meta = syncHeader[SYNC_KEYS.meta] || {};
    const chunkCount = Number(meta.chatChunkCount || 0);
    const chunkKeys = Array.from({ length: chunkCount }, (_value, index) => `${SYNC_KEYS.chatPrefix}${index}`);
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
      deletedAccounts: syncHeader[SYNC_KEYS.deletedAccounts] || {}
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
        version: 2
      }
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
      const deletedAccounts = synced.deletedAccounts || {};
      const accounts = mergeAccounts(synced.accounts, localAccounts, deletedAccounts);
      const chats = mergeChats(synced.chats, localChats, deletedAccounts);
      const response = await chrome.runtime.sendMessage({
        type: 'SYNC_DATA',
        accounts,
        chats,
        deletedAccounts
      });
      if (response && response.ok) {
        const msg = (response.prunedCount > 0)
          ? `Synced; ${response.prunedCount} older chats skipped from sync`
          : 'Synced';
        await storageSet({
          accounts,
          chats,
          syncStatus: { ok: true, updatedAt: Date.now(), message: msg }
        });
      } else {
        throw new Error(response && response.error ? response.error : 'Sync write failed');
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
          message: error && error.message ? error.message : String(error)
        }
      });
      console.warn('[Claude Chat Tracker] Sync failed. Local tracking still works.', error);
    }
  }

  // ─── API-based real timestamp sync ───────────────────────────────────────────
  // Content scripts run inside claude.ai, so fetch() automatically carries the
  // user's session cookies — no extra permissions needed.

  // Step 1: get (and cache) the user's organisation UUID.
  async function fetchOrganizationId() {
    if (cachedOrgId) return cachedOrgId;
    try {
      const res = await fetch('https://claude.ai/api/organizations', {
        credentials: 'include',
        headers: { Accept: 'application/json' }
      });
      if (!res.ok) return null;
      const data = await res.json();
      // API returns an array of org objects; take the first active one.
      const orgs = Array.isArray(data) ? data : (data.organizations || []);
      const org = orgs.find(o => !o.is_default_org) || orgs[0];
      if (org) cachedOrgId = org.uuid || org.id || null;
    } catch (_) {}
    return cachedOrgId;
  }

  // Step 2: fetch conversation list for the org, returning an array of
  // { chatId, title, updatedAt } objects.  Returns null on any error.
  async function fetchRecentChats() {
    const orgId = await fetchOrganizationId();
    if (!orgId) return null;
    try {
      // Fetch up to 100 conversations — covers the vast majority of users.
      const res = await fetch(
        `https://claude.ai/api/organizations/${orgId}/chat_conversations?limit=100`,
        { credentials: 'include', headers: { Accept: 'application/json' } }
      );
      if (!res.ok) return null;
      const data = await res.json();
      const convs = Array.isArray(data) ? data : (data.conversations || data.chat_conversations || []);
      return convs.map(c => ({
        chatId: c.uuid || c.id,
        // Use API title only when it's non-empty; scraper may have a better deduped value.
        apiTitle: (c.name || c.title || '').trim() || null,
        updatedAt: c.updated_at ? new Date(c.updated_at).getTime() : null
      })).filter(c => c.chatId);
    } catch (_) {
      return null;
    }
  }

  // Step 3: merge server timestamps (and titles where the API is cleaner) into
  // local storage without triggering a full re-scrape.
  async function applyServerTimestamps(apiChats) {
    if (!apiChats || apiChats.length === 0) return;
    if (!hasStorageApi()) return;

    const local = await storageGet([STORAGE_KEYS.accounts, STORAGE_KEYS.chats]);
    const accounts = local[STORAGE_KEYS.accounts] || {};
    const chats    = local[STORAGE_KEYS.chats]    || {};

    // Build a lookup of chatId → api entry for O(1) access.
    const apiMap = new Map(apiChats.map(c => [c.chatId, c]));
    let dirty = false;

    for (const chat of Object.values(chats)) {
      const api = apiMap.get(chat.chatId);
      if (!api) continue;

      let changed = false;

      // Always prefer the server updatedAt — it is the authoritative conversation date.
      if (api.updatedAt && api.updatedAt !== chat.serverUpdatedAt) {
        chat.serverUpdatedAt = api.updatedAt;
        changed = true;
      }

      // Use API title only if our stored title looks doubled (dedup heuristic) or is blank.
      // The API title is the clean canonical name Claude's backend recorded.
      if (api.apiTitle) {
        const stored = (chat.title || '').trim();
        const isDuplicated = stored.length > 10 &&
          stored.slice(0, Math.floor(stored.length / 2)) === stored.slice(Math.floor(stored.length / 2));
        if (!stored || isDuplicated) {
          chat.title = api.apiTitle;
          changed = true;
        }
      }

      if (changed) dirty = true;
    }

    if (dirty) {
      await storageSet({ chats });
      // Update pending sync payload so the next flush includes fresh timestamps.
      pendingSyncAccounts = accounts;
      pendingSyncChats = chats;
    }
  }

  // Throttled entry point: called from runFullScrape() on every scrape that produces
  // a change.  The 60-second guard means we never hammer Claude's API.
  function scheduleApiSync() {
    if (stopped) return;
    const elapsed = Date.now() - lastApiSyncAt;
    if (elapsed < API_SYNC_INTERVAL_MS) return; // still within cooldown
    lastApiSyncAt = Date.now();
    fetchRecentChats().then(apiChats => {
      if (!stopped && apiChats) applyServerTimestamps(apiChats);
    }).catch(() => { /* best-effort — local data is never at risk */ });
  }
  // ─────────────────────────────────────────────────────────────────────────────

  function scheduleSync(accounts, chats) {
    if (!hasSyncApi()) return;

    window.clearTimeout(syncTimer);
    const elapsed = Date.now() - lastSyncAt;
    const delay = elapsed >= MIN_SYNC_INTERVAL_MS ? 0 : MIN_SYNC_INTERVAL_MS - elapsed;

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
      if (url.hostname !== 'claude.ai') return null;

      const match = url.pathname.match(/\/chat\/([^/?#]+)/);
      if (!match) return null;

      return {
        chatId: decodeURIComponent(match[1]),
        url: `https://claude.ai/chat/${match[1]}`
      };
    } catch (_error) {
      return null;
    }
  }

  function cleanTitle(rawTitle) {
    const title = (rawTitle || '').replace(/\s+/g, ' ').trim();
    return title || 'Untitled Chat';
  }

  // BUG-06 real fix: detect and remove exact front-half duplication.
  // Claude's React renders aria-label as "Title" + " " + "Title" in some versions,
  // so the doubled string is IN the aria-label itself — not just in textContent.
  // Applying this to every candidate makes the fix bulletproof regardless of source.
  function deduplicate(s) {
    const t = (s || '').replace(/\s+/g, ' ').trim();
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
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function orderedChatLinks() {
    const containers = Array.from(document.querySelectorAll(CHAT_CONTAINER_SELECTOR))
      .filter(isVisible);

    const scopedLinks = containers.flatMap(container => {
      return Array.from(container.querySelectorAll(CHAT_LINK_SELECTOR));
    });

    const links = scopedLinks.length > 0
      ? scopedLinks
      : Array.from(document.querySelectorAll(CHAT_LINK_SELECTOR));

    return links
      .filter(isVisible)
      .map(link => ({
        link,
        rect: link.getBoundingClientRect()
      }))
      .sort((a, b) => {
        return (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left);
      })
      .map(item => item.link);
  }

  // Fix C: deduplicate() now applied to ALL extraction paths.
  // Claude's React renderer can inject doubled text into aria-label, the title attribute,
  // span textContent, or raw textContent depending on version — cover every case.
  function getTitleFromLink(link) {
    // 1. aria-label
    const ariaLabel = link.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim().length > 2) {
      return cleanTitle(deduplicate(ariaLabel));
    }

    // 2. title attribute — now deduplicated
    const titleAttr = link.getAttribute('title');
    if (titleAttr && titleAttr.trim().length > 2) {
      return cleanTitle(deduplicate(titleAttr));
    }

    // 3. first visible span:not([aria-hidden]) — now deduplicated
    const firstTextSpan = link.querySelector('span:not([aria-hidden])');
    if (firstTextSpan) {
      const text = firstTextSpan.textContent.trim();
      if (text.length > 2) return cleanTitle(deduplicate(text));
    }

    // 4. raw textContent
    const raw = (link.textContent || '').replace(/\s+/g, ' ').trim();
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

    for (const child of container.querySelectorAll('*')) {
      const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
      const isHeader =
        text.length > 0 &&
        text.length < 40 &&
        !child.querySelector('a[href*="/chat/"]') &&
        /^(today|yesterday|previous \d+ days?|january|february|march|april|may|june|july|august|september|october|november|december)/i.test(text);

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
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
  };

  // Converts a Claude sidebar section header label to a representative Unix timestamp.
  // Used to sort chats by date bucket when sidebarOrder is stale.
  function bucketToTimestamp(label) {
    const cleanLabel = (label || '').trim().toLowerCase();
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
      const normalized = normalizeChatHref(link.getAttribute('href'));
      if (!normalized) continue;
      if (byId.has(normalized.chatId)) continue;

      const title = getTitleFromLink(link);
      const bucketLabel = buckets.get(link) || null;
      const sectionTimestamp = bucketLabel ? bucketToTimestamp(bucketLabel) : null;

      byId.set(normalized.chatId, {
        chatId: normalized.chatId,
        title,
        url: normalized.url,
        sidebarOrder,
        sectionTimestamp
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
      chatIds: chats.map(chat => `${chat.sidebarOrder}:${chat.chatId}:${chat.sectionTimestamp || ''}`)
    });
  }

  async function saveScrape(account, chats) {
    const now = Date.now();
    const accountId = account.accountId;

    const localData = await storageGet(['deletedAccountIds']);
    let localDeleted = localData.deletedAccountIds || [];

    let syncedDeleted = {};
    if (hasSyncApi()) {
      try {
        const synced = await readSyncedData();
        syncedDeleted = synced.deletedAccounts || {};
      } catch (_) {}
    }

    // Phase 1 — Tombstone Resurrection:
    // If the account is tombstoned but we have a verified real email (isFallback === false),
    // the user has deliberately logged back in. Resurrect: clean the tombstone locally and
    // signal the background worker to remove it from sync.
    if ((localDeleted.includes(accountId) || syncedDeleted[accountId]) && !account.isFallback) {
      // Remove from local deleted list
      localDeleted = localDeleted.filter(id => id !== accountId);
      await storageSet({ deletedAccountIds: localDeleted });

      // Signal background to remove from sync tombstones
      if (hasSyncApi()) {
        try {
          await chrome.runtime.sendMessage({ type: 'RESURRECT_ACCOUNT', accountId });
        } catch (_) { /* background may be inactive; local resurrection still proceeds */ }
      }
      // Fall through — allow saveScrape to continue normally
    } else if (localDeleted.includes(accountId) || syncedDeleted[accountId]) {
      // Fallback account is tombstoned and no verified email — respect the tombstone
      await storageSet({
        syncStatus: {
          ok: false,
          updatedAt: now,
          message: 'Current Claude account was deleted from tracker; scrape skipped'
        }
      });
      return;
    }

    const local = await storageGet([
      STORAGE_KEYS.accounts,
      STORAGE_KEYS.chats,
      STORAGE_KEYS.currentAccountId,
      'lastKnownEmail'
    ]);
    const originalAccounts = local[STORAGE_KEYS.accounts] || {};
    const originalChats = local[STORAGE_KEYS.chats] || {};
    const originalCurrentAccountId = local[STORAGE_KEYS.currentAccountId] || '';
    const originalLastKnownEmail = local.lastKnownEmail || null;

    const accounts = JSON.parse(JSON.stringify(originalAccounts));
    const existingChats = JSON.parse(JSON.stringify(originalChats));

    const currentChatIds = new Set(chats.map(chat => chat.chatId));

    if (!account.isFallback && profileFallbackAccountId && accounts[profileFallbackAccountId]) {
      // Phase 2 — Migrate ALL fallback chats, not just currently visible ones.
      // profileFallbackAccountId is crypto.randomUUID()-derived: unique per Chrome profile,
      // so cross-profile contamination is impossible. The currentChatIds visibility guard
      // was the cause of older scrolled-away chats being permanently stranded.
      const fallbackChats = Object.values(existingChats)
        .filter(c => c.accountId === profileFallbackAccountId);
      for (const chat of fallbackChats) {
        const newStorageId = `${accountId}:${chat.chatId}`;
        existingChats[newStorageId] = {
          ...chat,
          storageId: newStorageId,
          accountId
        };
        delete existingChats[chat.storageId];
      }

      // Fix B: Formally tombstone the fallback account so mergeAccounts() cannot
      // resurrect it from syncAccounts on the next sync pass.
      // Without this, the ghost "Patel" account re-appears from sync after migration.
      if (!localDeleted.includes(profileFallbackAccountId)) {
        const updatedDeleted = [...localDeleted, profileFallbackAccountId];
        await storageSet({ deletedAccountIds: updatedDeleted });
        if (hasSyncApi()) {
          try {
            await chrome.runtime.sendMessage({ type: 'TOMBSTONE_ACCOUNT', accountId: profileFallbackAccountId });
          } catch (_) { /* best-effort — local tombstone is sufficient */ }
        }
      }
    }

    const existingAccount = accounts[accountId] || {};
    const displayName = account.displayName
      || existingAccount.displayName
      || FALLBACK_ACCOUNT_NAME;

    accounts[accountId] = {
      accountId,
      email: account.email,
      displayName,
      color: existingAccount.color || colorForAccount(accounts),
      firstSeen: existingAccount.firstSeen || now,
      lastSeen: now,
      isFallback: account.isFallback,
      autoDetectedName: true
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
        sectionTimestamp: chat.sectionTimestamp !== null
          ? chat.sectionTimestamp
          : (existingChat.sectionTimestamp || null),
        // Preserve server-sourced timestamp — never overwrite with null from DOM scrape.
        serverUpdatedAt: existingChat.serverUpdatedAt || null
      };

      if (!account.isFallback) {
        // Remove the same chat if it was previously stored under this profile's fallback ID.
        // Safe because profileFallbackAccountId is unique per Chrome profile — it never
        // matches another profile's fallback ID.
        delete existingChats[`${profileFallbackAccountId}:${chat.chatId}`];
      }
    }

    if (!account.isFallback && accounts[profileFallbackAccountId]) {
      const hasFallbackChats = Object.values(existingChats)
        .some(c => c.accountId === profileFallbackAccountId);
      if (!hasFallbackChats) {
        delete accounts[profileFallbackAccountId];
      }
    }

    // BUG-07 fix A: persist lastKnownEmail so it survives page reloads without needing the panel open.
    const storagePayload = { accounts, chats: existingChats, [STORAGE_KEYS.currentAccountId]: accountId };
    if (account.email) {
      storagePayload.lastKnownEmail = account.email;
    }

    // Also persist currentAccountId so the popup "Tracking as" label always reflects
    // the account the content script actually detected — not a guess from another profile.
    const hasChanged =
      stableStringify(originalAccounts) !== stableStringify(accounts) ||
      stableStringify(originalChats) !== stableStringify(existingChats) ||
      originalCurrentAccountId !== accountId ||
      (account.email && originalLastKnownEmail !== account.email);

    if (hasChanged) {
      await storageSet(storagePayload);
      // Phase 5: store pending sync payload; do NOT dispatch immediately.
      pendingSyncAccounts = accounts;
      pendingSyncChats = existingChats;
      // Trigger an API-based timestamp refresh (throttled at 60s).
      scheduleApiSync();
    }
  }

  async function runFullScrape() {
    if (stopped) return;
    // Guard against running before initProfileLocalId() completes.
    // The initial retry delays (800ms+) are long enough that init always finishes first,
    // but this guard makes the invariant explicit and safe.
    if (!profileFallbackAccountId) return;

    await handlePendingOpen();

    const accountIdentity = detectAccountIdentity();
    const chats = scrapeVisibleChats();

    if (!hasStorageApi()) {
      if (!warnedStorageUnavailable) {
        console.info('[Claude Chat Tracker] Extension storage is unavailable in this Claude tab. Reload the extension, then refresh this Claude tab.');
        warnedStorageUnavailable = true;
      }
      return;
    }

    const account = await resolveAccountIdentity(accountIdentity);
    if (chats.length === 0 && isLoginPage()) {
      return;
    }

    if (!account.email && !warnedMissingAccount) {
      console.info(`[Claude Chat Tracker] Claude did not expose an account email. Tracking under "${account.displayName}" for this Chrome profile.`);
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
    if (document.readyState !== 'complete') {
      document.addEventListener('readystatechange', () => {
        if (document.readyState === 'complete') scheduleScrape();
      }, { once: true });
      return;
    }

    window.clearTimeout(scrapeTimer);
    scrapeTimer = window.setTimeout(() => {
      runFullScrape().catch(error => {
        if (isExtensionContextInvalidated(error)) {
          stopTracking();
          return;
        }

        console.warn('[Claude Chat Tracker] Scrape failed.', error);
      });
    }, SCRAPE_DEBOUNCE_MS);
  }

  function nodeMayContainChats(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.matches && node.matches(`${CHAT_LINK_SELECTOR}, ${CHAT_CONTAINER_SELECTOR}`)) return true;
    return Boolean(node.querySelector && node.querySelector(`${CHAT_LINK_SELECTOR}, ${CHAT_CONTAINER_SELECTOR}`));
  }

  function mutationsMayAffectChats(mutations) {
    return mutations.some(mutation => {
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
  // Called on tab-hide and after a 5-minute user-idle window.
  function flushPendingSync() {
    if (!pendingSyncAccounts || !pendingSyncChats) return;
    const accounts = pendingSyncAccounts;
    const chats = pendingSyncChats;
    pendingSyncAccounts = null;
    pendingSyncChats = null;
    syncMergedData(accounts, chats).catch(() => { /* best-effort — local data is safe */ });
  }

  // Phase 5: reset the 5-minute idle timer on any user interaction.
  function resetIdleSyncTimer() {
    window.clearTimeout(idleSyncTimer);
    idleSyncTimer = window.setTimeout(flushPendingSync, IDLE_SYNC_DELAY_MS);
  }

  function setupObserver() {
    observer = new MutationObserver(mutations => {
      if (stopped) return;
      if (mutationsMayAffectChats(mutations)) {
        scheduleScrape();
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    // Phase 5: flush pending sync when tab becomes hidden (user switches tabs / minimises).
    // Also resume scraping when tab becomes visible again.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        flushPendingSync();
      } else {
        scheduleScrape();
      }
    });

    // Phase 5: idle sync — reset the 5-min timer on each meaningful user interaction.
    document.addEventListener('pointerup', resetIdleSyncTimer, { passive: true });
    document.addEventListener('keyup', resetIdleSyncTimer, { passive: true });
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
          lastSnapshot = '';
          window.clearTimeout(scrapeTimer);
          scrapeTimer = window.setTimeout(() => {
            runFullScrape().catch(error => {
              if (isExtensionContextInvalidated(error)) stopTracking();
            });
          }, 300);
        }
      }, 500); // throttle: check at most every 500ms, not on every DOM mutation
    });

    const root = document.querySelector('aside') ||
                 document.querySelector('nav') ||
                 document.querySelector('header') ||
                 document.body ||
                 document.documentElement;

    accountObserver.observe(root, {
      childList: true,
      subtree: true
    });
  }

  setupObserver();
  setupAccountObserver();

  // Listen for the rescrapeRequested sentinel written by the popup's "Clear" button.
  // When the popup wipes chrome.storage.local, the DOM on the Claude tab has not changed,
  // so runFullScrape()'s snapshot guard would silently skip the save and the popup would
  // remain empty. Resetting lastSnapshot here forces the next scrape to write everything.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (stopped || areaName !== 'local') return;
    if (changes.rescrapeRequested && changes.rescrapeRequested.newValue) {
      lastSnapshot = ''; // invalidate cached snapshot so the next scrape is unconditional
      scheduleScrape();
    }
  });

  // Load (or generate) the per-profile identity seed before scheduling any scrapes.
  // initProfileLocalId() sets profileFallbackAccountId, which runFullScrape() requires.
  initProfileLocalId().then(() => {
    for (const delay of INITIAL_RETRY_DELAYS) {
      window.setTimeout(scheduleScrape, delay);
    }
  });
})();
