declare var MiniSearch: any;

// ─── 1. buildSearchIndex ─────────────────────────────────────────────

export async function buildSearchIndex(): Promise<any> {
  const entries = await (window as any).getAllIndexedEntries() as Record<string, any>;

  const index = new MiniSearch({
    fields: ['firstMessage', 'lastMessage'],
    storeFields: ['storageId', 'accountId', 'chatId', 'firstMessage', 'lastMessage'],
    idField: 'storageId',
    // Tokenize on whitespace and common separators; minimum token length 2
    // to avoid single-char noise tokens ('a', 'i', etc.) polluting the index.
    tokenize: (text: string) =>
      text
        .toLowerCase()
        .split(/[\s\-_/\\.,;:!?()\[\]{}'"]+/)
        .filter((t) => t.length >= 2),
    processTerm: (term: string) => term.toLowerCase(),
  });

  const records = Object.entries(entries)
    .map(([storageId, record]) => {
      if (record && typeof record === 'object') {
        if (!record.storageId) {
          return { ...record, storageId };
        }
        return record;
      }
      return null;
    })
    .filter((r): r is any => r !== null && typeof r === 'object' && r.storageId);

  if (records.length > 0) {
    index.addAll(records);
  }

  return index;
}

// ─── 2. extractSnippet ───────────────────────────────────────────────

export function extractSnippet(record: any, query: string, queryWords?: string[]): string {
  const firstMessage: string = record.firstMessage ?? '';
  const lastMessage: string = record.lastMessage ?? '';
  const WINDOW = 150;

  // Accept pre-split tokens from the caller (avoids re-splitting per result);
  // fall back to splitting here for single-call usage.
  const words = queryWords ?? query
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

/**
 * Derives safe MiniSearch search options based on query characteristics.
 *
 * Rules:
 *  - prefix:  only enabled when the query term is ≥ 4 characters.  A 3-char
 *             term like "aws" would incorrectly match "awesome", "award", etc.
 *  - fuzzy:   only enabled when the term is ≥ 6 characters, capped at 0.15
 *             (≈ 1 edit on a 7-char word).  Short-term fuzzy causes massive
 *             false-positive fan-out.
 *  - boost:   firstMessage is 2× more important than lastMessage because it
 *             captures the user's original intent.
 */
function getMiniSearchOptions(query: string): Record<string, any> {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  // Use the shortest term to decide — if any term is short, be conservative.
  const minTermLen = terms.reduce((min, t) => Math.min(min, t.length), Infinity);

  return {
    prefix: minTermLen >= 4,
    fuzzy: minTermLen >= 6 ? 0.15 : false,
    boost: { firstMessage: 2 },
    // combineWith: AND ensures ALL query terms must appear (no partial-query hits)
    combineWith: 'AND',
  };
}

export function searchContent(
  index: any,
  query: string,
  accountId?: string,
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

  const opts = getMiniSearchOptions(query);
  let results = index.search(query, opts);

  if (accountId && accountId !== 'all') {
    results = results.filter((r: any) => r.accountId === accountId);
  }

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
const KEYWORD_WEIGHT = 0.4;

/** Fraction of the final score contributed by semantic (cosine) results. */
const SEMANTIC_WEIGHT = 0.6;

/**
 * Minimum cosine similarity threshold for a semantic-only result (no keyword hit).
 * 0.65 means the embedding must be noticeably close in meaning — avoids noise.
 */
const SEMANTIC_ONLY_THRESHOLD = 0.65;

/**
 * Minimum final combined score to include ANY result in the list.
 * Raised from 0.05 → 0.15 to cut low-quality noise aggressively.
 */
const MIN_COMBINED_SCORE = 0.15;

/**
 * A keyword hit must reach at least this fraction of the top keyword score
 * to be counted as a genuine keyword match.  Prevents very weak BM25 matches
 * (e.g. a single occurrence deep in a 2000-char blob) from being treated as
 * keyword matches and bypassing the combined-score filter.
 */
const MIN_KEYWORD_SCORE_FRACTION = 0.1;

/**
 * Cosine similarity between two vectors.
 * Handles zero-norm vectors safely (returns 0).
 */
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0 || vecA.length !== vecB.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot   += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Number.isFinite(sim) ? Math.max(0, sim) : 0;
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
 *
 * @param accountId  When provided (and not 'all'), only embeddings for this account are loaded.
 *   Prevents semantic results from one account from appearing when searching another.
 */
export async function searchContentHybrid(
  index: any,
  query: string,
  queryEmbedding?: number[] | null,
  searchMode: 'text' | 'semantic' | 'hybrid' = 'hybrid',
  accountId?: string,
): Promise<Array<{
  storageId: string;
  accountId: string;
  chatId: string;
  snippet: string;
  score: number;
}>> {
  // Pre-split query tokens once; passed to extractSnippet to avoid N re-splits.
  const queryWords = query
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());

  // 1. Always run keyword search (account-scoped if specified)
  const keywordResults = searchContent(index, query, accountId);

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

  // 4. Load embeddings: scoped to active account if specified, otherwise load all
  const hasSpecificAccount = Boolean(accountId && accountId !== 'all');
  const getEmbeds = hasSpecificAccount
    ? (window as any).getAllEmbeddingsForAccount(accountId)
    : (window as any).getAllEmbeddings();
  const embeddings = (await getEmbeds) as Record<string, number[]>;
  const semanticScoreMap = new Map<string, number>();
  for (const [storageId, vec] of Object.entries(embeddings)) {
    if (hasSpecificAccount && !storageId.startsWith(`${accountId}:`)) {
      continue;
    }
    semanticScoreMap.set(storageId, cosineSimilarity(queryEmbedding, vec));
  }

  // Prefer stored fields from MiniSearch directly to avoid reading full storage on every keystroke
  const canUseStoredFields = index && typeof index.getStoredFields === 'function';
  let entries: Record<string, any> = {};

  const getRecord = async (storageId: string) => {
    if (canUseStoredFields) {
      try {
        const stored = index.getStoredFields(storageId);
        if (stored) return stored;
      } catch (_) {}
    }
    if (Object.keys(entries).length === 0 && (window as any).getAllIndexedEntries) {
      entries = (await (window as any).getAllIndexedEntries()) as Record<string, any>;
    }
    return entries[storageId] || null;
  };

  // 4.5. Pure semantic search
  if (searchMode === 'semantic') {
    const merged = [];
    if (semanticScoreMap.size > 0) {
      for (const [storageId, semScore] of semanticScoreMap.entries()) {
        if (semScore >= SEMANTIC_ONLY_THRESHOLD) {
          const record = await getRecord(storageId);
          if (!record) continue;
          merged.push({
            storageId,
            accountId: record.accountId,
            chatId: record.chatId,
            snippet: extractSnippet(record, query, queryWords),
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
    for (const [storageId, semScore] of semanticScoreMap.entries()) {
      if (merged.has(storageId)) {
        // Update semantic score on existing keyword hit
        merged.get(storageId)!.semanticScore = semScore;
      } else if (semScore >= SEMANTIC_ONLY_THRESHOLD) {
        // New semantic-only result — only include above the quality floor
        const record = await getRecord(storageId);
        if (!record) continue;
        merged.set(storageId, {
          storageId,
          accountId: record.accountId,
          chatId: record.chatId,
          snippet: extractSnippet(record, query, queryWords),
          normalizedKeyword: 0,
          semanticScore: semScore,
        });
      }
    }
  }

  // 7. Compute final scores, filter noise, sort descending.
  //
  //    A result is kept when ANY of these conditions hold:
  //      (a) It has a strong keyword match (normalizedKeyword ≥ MIN_KEYWORD_SCORE_FRACTION, i.e. ≥ 10% of top BM25).
  //      (b) Its combined score ≥ MIN_COMBINED_SCORE (e.g. semantic match or semantic + weak keyword).
  //
  //    The old code used `r.hasKeyword` (normalizedKeyword > 0) as a free pass,
  //    which meant even a near-zero BM25 hit — e.g. "aws" fuzzy-matching "awesome" —
  //    would always appear in results.  Now only strong keyword hits or results meeting the score floor are kept.
  return Array.from(merged.values())
    .map((r) => ({
      storageId: r.storageId,
      accountId: r.accountId,
      chatId: r.chatId,
      snippet: r.snippet,
      score: (r.normalizedKeyword * KEYWORD_WEIGHT) + (r.semanticScore * SEMANTIC_WEIGHT),
      // isStrongKeyword: keyword score must be at least 10% of the top keyword score
      isStrongKeyword: r.normalizedKeyword >= MIN_KEYWORD_SCORE_FRACTION,
    }))
    .filter((r) => r.isStrongKeyword || r.score >= MIN_COMBINED_SCORE)
    .sort((a, b) => b.score - a.score)
    .map(({ isStrongKeyword: _drop, ...r }) => r);
}

(window as any).searchContentHybrid = searchContentHybrid;
