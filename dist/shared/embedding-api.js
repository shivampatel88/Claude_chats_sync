"use strict";
(() => {
  const GEMINI_EMBED_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";
  const OUTPUT_DIMENSIONS = 768;
  async function generateEmbedding(text, apiKey) {
    if (!text || !text.trim()) {
      return [];
    }
    const cleanText = text.length > 2e3 ? text.slice(0, 2e3) : text;
    if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
      try {
        const bgResp = await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage(
              { type: "GENERATE_EMBEDDING", text: cleanText, apiKey },
              (response) => {
                if (chrome.runtime.lastError) {
                  resolve({ ok: false, error: chrome.runtime.lastError.message });
                } else {
                  resolve(response || { ok: false, error: "Empty background response" });
                }
              }
            );
          } catch (sendErr) {
            resolve({ ok: false, error: sendErr && sendErr.message ? sendErr.message : String(sendErr) });
          }
        });
        if (bgResp && bgResp.ok && Array.isArray(bgResp.values)) {
          return bgResp.values;
        }
        if (bgResp && bgResp.error) {
          if (bgResp.error === "INVALID_KEY" || bgResp.error === "RATE_LIMITED") {
            throw new Error(bgResp.error);
          }
        }
      } catch (err) {
        if (err && (err.message === "INVALID_KEY" || err.message === "RATE_LIMITED")) {
          throw err;
        }
      }
    }
    const res = await fetch(GEMINI_EMBED_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        model: "models/gemini-embedding-001",
        content: { parts: [{ text: cleanText }] },
        outputDimensionality: OUTPUT_DIMENSIONS
      })
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error("INVALID_KEY");
    }
    if (res.status === 429) {
      throw new Error("RATE_LIMITED");
    }
    if (!res.ok) {
      throw new Error(`Gemini API error: ${res.status}`);
    }
    const data = await res.json();
    return data && data.embedding && Array.isArray(data.embedding.values) ? data.embedding.values : [];
  }
  window.generateEmbedding = generateEmbedding;
})();
