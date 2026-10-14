// google-account-helper.js
// Runs on: https://accounts.google.com/o/oauth2/* and /signin/*
//
// Handles two scenarios in the Google account flow:
//
// Scenario A — Account chooser screen:
//   Multiple Google account tiles are visible. We find the one matching
//   pendingOpen.accountEmail (by visible text) and click it.
//   Note: This is skipped if the login_hint DNR rule worked, because Google
//   will have already pre-selected the account and jumped to Scenario B.
//
// Scenario B — OAuth confirmation screen ("You're signing back in to Claude"):
//   Google shows a single account with "Continue" and "Cancel" buttons.
//   If the email on the page matches our target, we auto-click "Continue".
//   This eliminates the final manual click in the flow.
//   This script runs INSIDE the OAuth popup window, so auto-click is allowed
//   (the popup-blocker restriction only applies to window.open(), not button.click()).
//
// SAFETY: We verify the target email appears on the page before clicking anything.
// If no match is found within 8 seconds, we do nothing.

"use strict";

(async () => {
  let pendingOpen = null;
  try {
    const data = await chrome.storage.local.get("pendingOpen");
    pendingOpen = data.pendingOpen || null;
  } catch (_) {
    return;
  }

  const PENDING_OPEN_TTL_MS = 60 * 1000;
  if (!pendingOpen || Date.now() - Number(pendingOpen.createdAt || 0) > PENDING_OPEN_TTL_MS) {
    chrome.storage.local.set({ pendingOpen: null }).catch(() => {});
    chrome.runtime.sendMessage({ type: "CLEAR_LOGIN_HINT" }).catch(() => {});
    return;
  }

  const email = pendingOpen && pendingOpen.accountEmail
    ? pendingOpen.accountEmail.toLowerCase().trim()
    : null;

  if (!email) return;

  const CCT_GA = "[CCT-GA]";
  const log = (...a) => console.log(CCT_GA, ...a);
  const warn = (...a) => console.warn(CCT_GA, ...a);

  log("Google account helper active for:", email, "| url:", location.pathname);

  // ─── Utilities ────────────────────────────────────────────────────────────

  function containsExactEmail(text, targetEmail) {
    const escaped = targetEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^a-z0-9._%+-])${escaped}(?=$|[^a-z0-9.-])`, "i");
    return re.test(text || "");
  }

  function pageContainsEmail(targetEmail) {
    return containsExactEmail(document.body.innerText || document.body.textContent || "", targetEmail);
  }

  // Find the "Continue" (or "Sign in") confirmation button on the OAuth consent screen.
  // This is the button that appears when Google shows "You're signing back in to Claude"
  // with a single account already selected.
  function findContinueButton() {
    const interactive = Array.from(
      document.querySelectorAll('button, [role="button"], input[type="submit"]')
    );
    // Match by visible text: "Continue", "Sign in", "Next" — case-insensitive.
    // Exclude "Cancel" and "Deny" buttons.
    return interactive.find(el => {
      const text = (el.innerText || el.textContent || "").trim().toLowerCase();
      return (
        (text === "continue" || text === "sign in" || text === "next") &&
        text !== "cancel" &&
        text !== "deny"
      );
    });
  }

  // Find an account tile by visible email text (account chooser screen).
  function findAccountTileByText(targetEmail) {
    const candidates = Array.from(document.querySelectorAll(
      'li, [role="option"], [role="button"], [role="listitem"], a[href], div[data-authuser]'
    ));
    let bestMatch = null;
    let bestScore = Infinity;
    for (const el of candidates) {
      const text = (el.innerText || el.textContent || "").toLowerCase();
      if (!containsExactEmail(text, targetEmail)) continue;
      const childMatches = el.querySelectorAll("*");
      let score = 0;
      for (const child of childMatches) {
        if (containsExactEmail(child.innerText || child.textContent || "", targetEmail)) score++;
      }
      if (score < bestScore) { bestScore = score; bestMatch = el; }
    }
    return bestMatch;
  }

  // ─── Main polling loop ────────────────────────────────────────────────────

  const MAX_WAIT_MS = 8000;
  const POLL_INTERVAL_MS = 300;
  const start = Date.now();
  let acted = false;

  const poll = setInterval(() => {
    if (acted) { clearInterval(poll); return; }

    if (Date.now() - start > MAX_WAIT_MS) {
      clearInterval(poll);
      warn("Timed out waiting for Google account UI. User must proceed manually.");
      return;
    }

    // ── Scenario B: OAuth confirmation screen ──────────────────────────────
    // Detect: "Continue" button is present AND the target email is visible on page.
    // This runs inside the OAuth popup — button.click() is always allowed here.
    const continueBtn = findContinueButton();
    if (continueBtn && pageContainsEmail(email)) {
      log("Confirmation screen detected for", email, "— clicking Continue.");
      acted = true;
      clearInterval(poll);

      // Brief visual highlight.
      const prev = continueBtn.style.outline;
      continueBtn.style.outline = "2px solid #d97945";
      setTimeout(() => { continueBtn.style.outline = prev; }, 400);

      continueBtn.click();
      return;
    }

    // ── Scenario A: Account chooser screen ────────────────────────────────
    // Detect: multiple account tiles visible, find the one with our email.
    const tile = findAccountTileByText(email);
    if (tile) {
      log("Account chooser: found tile for", email, "— clicking.");
      acted = true;
      clearInterval(poll);

      const prev = tile.style.outline;
      tile.style.outline = "2px solid #d97945";
      setTimeout(() => { tile.style.outline = prev; }, 600);

      tile.click();
      return;
    }

    // Neither scenario ready yet — wait for next poll.
  }, POLL_INTERVAL_MS);
})();
