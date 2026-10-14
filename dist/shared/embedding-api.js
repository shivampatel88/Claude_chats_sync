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
      let responded = false;
      let bgResult = null;
      try {
        bgResult = await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage(
              { type: "GENERATE_EMBEDDING", text: cleanText, apiKey },
              (response) => {
                if (chrome.runtime.lastError) {
                  resolve(null);
                } else {
                  responded = true;
                  resolve(response || { ok: false, error: "Empty background response" });
                }
              }
            );
          } catch {
            resolve(null);
          }
        });
      } catch {
        bgResult = null;
      }
      if (responded && bgResult) {
        if (bgResult.ok && Array.isArray(bgResult.values)) {
          return bgResult.values;
        }
        throw new Error(bgResult.error || "Failed to generate embedding");
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15e3);
    let res;
    try {
      res = await fetch(GEMINI_EMBED_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          model: "models/gemini-embedding-001",
          content: { parts: [{ text: cleanText }] },
          outputDimensionality: OUTPUT_DIMENSIONS
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error("INVALID_KEY");
    }
    if (res.status === 429) {
      throw new Error("RATE_LIMITED");
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      if (res.status === 400 && (errText.includes("API_KEY_INVALID") || errText.includes("API key not valid"))) {
        throw new Error("INVALID_KEY");
      }
      throw new Error(`Gemini API error: ${res.status}${errText ? " - " + errText.slice(0, 200) : ""}`);
    }
    const data = await res.json();
    return data && data.embedding && Array.isArray(data.embedding.values) ? data.embedding.values : [];
  }
  window.generateEmbedding = generateEmbedding;
})();
