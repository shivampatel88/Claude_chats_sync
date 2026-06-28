declare var MiniSearch: any;

// ─── 1. buildSearchIndex ─────────────────────────────────────────────

export async function buildSearchIndex(): Promise<any> {
  const entries = await (window as any).getAllIndexedEntries() as Record<string, any>;

  const index = new MiniSearch({
    fields: ['firstMessage', 'lastMessage'],
    storeFields: ['storageId', 'accountId', 'chatId', 'firstMessage', 'lastMessage'],
    idField: 'storageId',
  });

  const records = Object.values(entries);
  if (records.length > 0) {
    index.addAll(records);
  }

  return index;
}

// ─── 2. extractSnippet ───────────────────────────────────────────────

export function extractSnippet(record: any, query: string): string {
  const firstMessage: string = record.firstMessage ?? '';
  const lastMessage: string = record.lastMessage ?? '';
  const WINDOW = 150;

  const words = query
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());

  // Search both fields; find the earliest hit across them
  for (const field of [firstMessage, lastMessage]) {
    const lower = field.toLowerCase();
    for (const word of words) {
      const idx = lower.indexOf(word);
      if (idx !== -1) {
        const half = Math.floor(WINDOW / 2);
        const start = Math.max(0, idx - half);
        const end = Math.min(field.length, start + WINDOW);
        const snippet = field.slice(start, end);
        // Prefix/suffix ellipsis to indicate truncation
        return (start > 0 ? '…' : '') + snippet + (end < field.length ? '…' : '');
      }
    }
  }

  // No match found – return first 150 chars of firstMessage
  if (firstMessage.length <= WINDOW) return firstMessage;
  return firstMessage.slice(0, WINDOW) + '…';
}

// ─── 3. searchContent ───────────────────────────────────────────────

export function searchContent(
  index: any,
  query: string,
): Array<{
  storageId: string;
  accountId: string;
  chatId: string;
  snippet: string;
  score: number;
}> {
  if (index === null || index === undefined || !query.trim()) {
    return [];
  }

  const results = index.search(query, {
    prefix: true,
    fuzzy: 0.2,
    boost: { firstMessage: 2 },
  });

  return results.map((result: any) => ({
    storageId: result.storageId as string,
    accountId: result.accountId as string,
    chatId: result.chatId as string,
    snippet: extractSnippet(result, query),
    score: result.score as number,
  }));
}

// ─── Window exposure ─────────────────────────────────────────────────

(window as any).buildSearchIndex = buildSearchIndex;
(window as any).searchContent = searchContent;

// ─── Phase B: Hybrid Search ──────────────────────────────────────────

/** Fraction of the final score contributed by keyword (BM25) results. */
const KEYWORD_WEIGHT = 0.3;

/** Fraction of the final score contributed by semantic (cosine) results. */
const SEMANTIC_WEIGHT = 0.7;

/**
 * Minimum cosine similarity threshold for semantic-only results (no keyword hit).
 * Prevents low-relevance chats from appearing purely because they have an embedding.
 */
const SEMANTIC_ONLY_THRESHOLD = 0.3;

/** Minimum final combined score to include a result. Suppresses noise. */
const MIN_COMBINED_SCORE = 0.05;

/**
 * Cosine similarity between two vectors.
 * Handles zero-norm vectors safely (returns 0).
 */
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot   += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Hybrid search combining MiniSearch keyword results and Gemini cosine similarity.
 *
 * Score fusion:
 *   1. Keyword BM25 scores are normalized to 0–1 (score / maxKeywordScore).
 *   2. Semantic cosine similarity is already 0–1.
 *   3. finalScore = normalizedKeyword * KEYWORD_WEIGHT + semanticScore * SEMANTIC_WEIGHT
 *
 * Graceful degradation: if queryEmbedding is null/undefined, returns keyword results unchanged.
 */
export async function searchContentHybrid(
  index: any,
  query: string,
  queryEmbedding?: number[] | null,
  searchMode: 'text' | 'semantic' | 'hybrid' = 'hybrid',
): Promise<Array<{
  storageId: string;
  accountId: string;
  chatId: string;
  snippet: string;
  score: number;
}>> {
  // 1. Always run keyword search
  const keywordResults = searchContent(index, query);

  // 2. No embedding or text mode -> pure keyword fallback (graceful degradation)
  if (searchMode === 'text' || !queryEmbedding || queryEmbedding.length === 0) {
    return keywordResults;
  }

  // 3. Normalize BM25 scores to 0–1 to make them comparable with cosine similarity
  const rawScores = keywordResults.map((r) => r.score);
  const maxKeywordScore = Math.max(...rawScores, 1); // guard against empty array
  const normalizedKeywordMap = new Map<string, number>();
  for (const r of keywordResults) {
    normalizedKeywordMap.set(r.storageId, r.score / maxKeywordScore);
  }

  // 4. Load all embeddings and compute cosine similarity for each
  const embeddings = await (window as any).getAllEmbeddings() as Record<string, number[]>;
  const semanticScoreMap = new Map<string, number>();
  for (const [storageId, vec] of Object.entries(embeddings)) {
    semanticScoreMap.set(storageId, cosineSimilarity(queryEmbedding, vec));
  }

  // 4.5. Pure semantic search
  if (searchMode === 'semantic') {
    const merged = [];
    if (semanticScoreMap.size > 0) {
      const entries = await (window as any).getAllIndexedEntries() as Record<string, any>;
      for (const [storageId, semScore] of semanticScoreMap.entries()) {
        if (semScore >= SEMANTIC_ONLY_THRESHOLD) {
          const record = entries[storageId];
          if (!record) continue;
          merged.push({
            storageId,
            accountId: record.accountId,
            chatId: record.chatId,
            snippet: extractSnippet(record, query),
            score: semScore,
          });
        }
      }
    }
    return merged.sort((a, b) => b.score - a.score);
  }

  // 5. Build merged result map starting from keyword hits
  const merged = new Map<string, {
    storageId: string;
    accountId: string;
    chatId: string;
    snippet: string;
    normalizedKeyword: number;
    semanticScore: number;
  }>();

  for (const r of keywordResults) {
    merged.set(r.storageId, {
      storageId: r.storageId,
      accountId: r.accountId,
      chatId: r.chatId,
      snippet: r.snippet,
      normalizedKeyword: normalizedKeywordMap.get(r.storageId) ?? 0,
      semanticScore: semanticScoreMap.get(r.storageId) ?? 0,
    });
  }

  // 6. Add semantic-only results (no keyword match) that exceed the quality threshold
  if (semanticScoreMap.size > 0) {
    const entries = await (window as any).getAllIndexedEntries() as Record<string, any>;
    for (const [storageId, semScore] of semanticScoreMap.entries()) {
      if (merged.has(storageId)) {
        // Update semantic score on existing keyword hit
        merged.get(storageId)!.semanticScore = semScore;
      } else if (semScore >= SEMANTIC_ONLY_THRESHOLD) {
        // New semantic-only result — only include above the quality floor
        const record = entries[storageId];
        if (!record) continue;
        merged.set(storageId, {
          storageId,
          accountId: record.accountId,
          chatId: record.chatId,
          snippet: extractSnippet(record, query),
          normalizedKeyword: 0,
          semanticScore: semScore,
        });
      }
    }
  }

  // 7. Compute final scores, filter noise, sort descending
  return Array.from(merged.values())
    .map((r) => ({
      storageId: r.storageId,
      accountId: r.accountId,
      chatId: r.chatId,
      snippet: r.snippet,
      score: (r.normalizedKeyword * KEYWORD_WEIGHT) + (r.semanticScore * SEMANTIC_WEIGHT),
    }))
    .filter((r) => r.score >= MIN_COMBINED_SCORE)
    .sort((a, b) => b.score - a.score);
}

(window as any).searchContentHybrid = searchContentHybrid;
