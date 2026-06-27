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
