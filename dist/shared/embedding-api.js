"use strict";
(() => {
  const GEMINI_EMBED_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";
  const OUTPUT_DIMENSIONS = 768;
  async function generateEmbedding(text, apiKey) {
    if (text.length > 2e3) {
      throw new Error(`Input too long: ${text.length} chars (max 2000)`);
    }
    const res = await fetch(GEMINI_EMBED_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        model: "models/gemini-embedding-001",
        content: { parts: [{ text }] },
        outputDimensionality: OUTPUT_DIMENSIONS
      })
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new Error("INVALID_KEY");
    }
    if (res.status === 429) {
      throw new Error("RATE_LIMITED");
    }
    if (!res.ok) {
      throw new Error(`Gemini API error: ${res.status}`);
    }
    const data = await res.json();
    return data.embedding.values;
  }
  window.generateEmbedding = generateEmbedding;
  window.DEFAULT_EMBEDDING_KEY = typeof process !== "undefined" && process.env && "REMOVED" ? "REMOVED" : "";
})();
