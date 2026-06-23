// shared/search-engine.js

function tokenize(text) {
  if (!text) return [];
  // lowercase, strip punctuation, split on whitespace
  const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return cleaned.split(/\s+/).filter(t => t.length >= 2);
}

/**
 * Builds an inverted index from all stored chat records.
 * @returns {Promise<{tokenMap: Map<string, Set<string>>, recordMap: Map<string, Object>}>}
 */
async function buildSearchIndex() {
  const records = await window.getAllIndexedEntries();
  const tokenMap = new Map();
  const recordMap = new Map();

  for (const [storageId, record] of Object.entries(records)) {
    recordMap.set(storageId, record);
    
    const tokens = new Set([
      ...tokenize(record.firstMessage),
      ...tokenize(record.lastMessage)
    ]);

    for (const token of tokens) {
      if (!tokenMap.has(token)) {
        tokenMap.set(token, new Set());
      }
      tokenMap.get(token).add(storageId);
    }
  }

  return { tokenMap, recordMap };
}

/**
 * Extracts a 150-char snippet centered on the first match of the query.
 */
function extractSnippet(record, firstQueryToken) {
  const fullText = (record.firstMessage || '') + " \n " + (record.lastMessage || '');
  const lowerText = fullText.toLowerCase();
  const tokenClean = firstQueryToken.toLowerCase();
  
  let idx = lowerText.indexOf(tokenClean);
  
  if (idx === -1) {
    let fallback = fullText.trim().replace(/\s+/g, ' ');
    if (fallback.length > 150) fallback = fallback.slice(0, 150) + '...';
    return fallback;
  }
  
  const start = Math.max(0, idx - 75);
  const end = Math.min(fullText.length, idx + tokenClean.length + 75);
  let snippet = fullText.slice(start, end).replace(/\s+/g, ' ');
  
  if (start > 0) snippet = '...' + snippet;
  if (end < fullText.length) snippet = snippet + '...';
  
  return snippet.trim();
}

/**
 * Basic scoring function for ranking results.
 */
function calculateScore(record, queryTokens) {
  let score = 0;
  const fullTextLower = ((record.firstMessage || '') + " " + (record.lastMessage || '')).toLowerCase();
  
  for (const q of queryTokens) {
    const qLower = q.toLowerCase();
    // exact token match gets higher score
    const exactRegex = new RegExp(`\\b${qLower}\\b`, 'g');
    const exactMatches = (fullTextLower.match(exactRegex) || []).length;
    score += exactMatches * 3;
    
    // partial match
    const partialMatches = (fullTextLower.split(qLower).length - 1);
    score += (partialMatches - exactMatches) * 1;
  }
  return score;
}

/**
 * Searches the inverted index for the given query.
 * @param {Object} indexHandle 
 * @param {string} query 
 * @returns {Array<{storageId: string, accountId: string, chatId: string, snippet: string, score: number}>}
 */
function searchContent(indexHandle, query) {
  if (!indexHandle || !query) return [];
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // AND search - every query token must match at least one index token
  let resultIds = null;
  for (const qToken of queryTokens) {
    let currentIds = new Set();
    
    for (const [idxToken, ids] of indexHandle.tokenMap.entries()) {
      if (idxToken.includes(qToken)) {
        for (const id of ids) currentIds.add(id);
      }
    }
    
    if (resultIds === null) {
      resultIds = currentIds;
    } else {
      resultIds = new Set([...resultIds].filter(id => currentIds.has(id)));
    }
    if (resultIds.size === 0) return []; // AND failed
  }

  const results = [];
  for (const id of resultIds) {
    const record = indexHandle.recordMap.get(id);
    if (record) {
      results.push({
        storageId: id,
        accountId: record.accountId,
        chatId: record.chatId,
        snippet: extractSnippet(record, queryTokens[0]),
        score: calculateScore(record, queryTokens)
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

// Export to window
if (typeof window !== 'undefined') {
  window.buildSearchIndex = buildSearchIndex;
  window.searchContent = searchContent;
}
