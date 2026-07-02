// ─── Phase B: Embedding API ───────────────────────────────────────────
// Generates text embeddings using Google AI gemini-embedding-001.
// This is a thin fetch wrapper — no frameworks, no WASM, no bundled weights.

const GEMINI_EMBED_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';

/**
 * Output dimensionality: 768 (truncated from the default 3072).
 * Google recommends 768 as the best quality-vs-storage tradeoff.
 * At 768 dims: ~13.8 KB per record, ~1.4 MB for 100 chats.
 */
const OUTPUT_DIMENSIONS = 768;

/**
 * Generate a 768-dimensional embedding vector for the given text.
 *
 * @throws 'INVALID_KEY' if the API key is rejected (400/401/403)
 * @throws 'RATE_LIMITED' if the quota is exceeded (429)
 * @throws generic Error for other HTTP failures
 */
export async function generateEmbedding(text: string, apiKey: string): Promise<number[]> {
  // Guard against token-limit rejections — same cap the indexer queue uses.
  if (text.length > 2000) {
    throw new Error(`Input too long: ${text.length} chars (max 2000)`);
  }

  // API key sent as a header instead of a URL query param so it does not
  // appear in browser DevTools network logs, proxies, or server access logs.
  const res = await fetch(GEMINI_EMBED_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text }] },
      outputDimensionality: OUTPUT_DIMENSIONS,
    }),
  });

  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new Error('INVALID_KEY');
  }
  if (res.status === 429) {
    throw new Error('RATE_LIMITED');
  }
  if (!res.ok) {
    throw new Error(`Gemini API error: ${res.status}`);
  }

  const data = await res.json() as { embedding: { values: number[] } };
  return data.embedding.values;
}

// Expose on window so popup.js and content scripts (plain JS) can call this.
// NOTE: No API key is compiled into this file. The key is stored securely in
// chrome.storage.local (set once via the Settings drawer UI) and read at
// runtime via state.semanticSettings.apiKey in popup.js.
(window as any).generateEmbedding = generateEmbedding;
