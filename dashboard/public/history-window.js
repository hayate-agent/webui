/** Bounded retained chat history in the browser (the DOM is virtualized
 * separately). The agent stays the source of truth, so anything dropped here
 * can be paged in again through the `before` cursor.
 *
 * - New messages at the end (live): the oldest are dropped and `before` moves
 *   to the oldest retained id, so "Load earlier" fetches exactly what was
 *   dropped (a page with cursor X returns ancestors of X).
 * - Older pages prepended by the user: the newest are dropped and the window is
 *   marked `detached`; the UI then offers "Jump to latest" instead of merging
 *   live messages across the gap.
 */
export const MAX_RETAINED_MESSAGES = 1000;

export function appendNewer(history, before, messages, max = MAX_RETAINED_MESSAGES) {
 const known = new Set(history.map(message => message.id));
 const updates = new Map(messages.map(message => [message.id, message]));
 const merged = [...history.map(message => updates.get(message.id) ?? message), ...messages.filter(message => !known.has(message.id))];
 if (merged.length <= max) return { history: merged, before };
 const kept = merged.slice(-max);
 return { history: kept, before: kept[0].id };
}

export function prependOlder(history, page, max = MAX_RETAINED_MESSAGES) {
 const existing = new Set(history.map(message => message.id));
 const merged = [...page.messages.filter(message => !existing.has(message.id)), ...history];
 if (merged.length <= max) return { history: merged, before: page.before, detached: false };
 return { history: merged.slice(0, max), before: page.before, detached: true };
}
