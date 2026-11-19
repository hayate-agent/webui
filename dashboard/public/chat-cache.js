/** Bounded, disposable per-chat page cache (the agent stays the source of truth).
 *
 * Switching to a chat shows its last known newest page immediately and the live
 * read only repairs it (stale-while-revalidate). Entries are tiny projections
 * (<= 64 messages, text only: media bytes are never cached), evicted LRU, and
 * mirrored to sessionStorage so a reload also starts warm. Anything that cannot
 * be stored is simply skipped; correctness never depends on this cache.
 */
export const MAX_CACHED_CHATS = 12, MAX_CACHED_MESSAGES = 64, MAX_ENTRY_BYTES = 180000;
const MIRROR_SLOT = 'workspace.chat-cache.v1';

export function createChatCache({ storage = globalThis.sessionStorage, maxChats = MAX_CACHED_CHATS } = {}) {
  const entries = new Map();
  try {
    const rows = JSON.parse(storage?.getItem(MIRROR_SLOT) ?? '[]');
    if (Array.isArray(rows)) for (const [key, value] of rows.slice(-maxChats)) if (typeof key === 'string' && valid(value)) entries.set(key, value);
  } catch { /* A corrupt mirror is just an empty cache. */ }
  // Restored data is untrusted: enforce the same bounds as set().
  function valid(value) {
    return value && typeof value === 'object' && Array.isArray(value.messages) && value.messages.length <= MAX_CACHED_MESSAGES
      && value.messages.every(message => message && typeof message === 'object' && typeof message.id === 'string')
      && JSON.stringify(value).length <= MAX_ENTRY_BYTES;
  }
  function persist() {
    try {
      let rows = [...entries];
      // Keep the mirror well below the storage quota; drop oldest first.
      while (rows.length && JSON.stringify(rows).length > 1500000) rows = rows.slice(1);
      storage?.setItem(MIRROR_SLOT, JSON.stringify(rows));
    } catch { /* Quota or privacy mode: memory only. */ }
  }
  const slim = message => {
    const { attachments, images, ...rest } = message; return rest;
  };
  return {
    get(key) {
      const value = entries.get(key); if (!value) return undefined;
      entries.delete(key); entries.set(key, value);
      return { ...value, messages: value.messages.map(message => ({ ...message })) };
    },
    set(key, conversation) {
      if (!conversation || !Array.isArray(conversation.messages)) return;
      const messages = conversation.messages.slice(-MAX_CACHED_MESSAGES).map(slim);
      const entry = { id: conversation.id, title: conversation.title, readOnly: conversation.readOnly === true, before: conversation.messages.length > messages.length ? messages[0]?.id ?? null : conversation.before ?? null, messages, cachedAt: Date.now() };
      if (JSON.stringify(entry).length > MAX_ENTRY_BYTES) return;
      entries.delete(key); entries.set(key, entry);
      while (entries.size > maxChats) entries.delete(entries.keys().next().value);
      persist();
    },
    delete(key) { if (entries.delete(key)) persist(); },
    clear() { entries.clear(); try { storage?.removeItem(MIRROR_SLOT); } catch { /* ignore */ } },
    get size() { return entries.size; },
  };
}
