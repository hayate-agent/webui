// What the operator sees in the write confirmation must be EXACTLY what is sent: the complete
// arguments, never a shortened copy. If they cannot be shown completely, the write is refused.
export const MAX_SHOWN_CHARS = 8000;

/** Returns { ok: true, text } or { ok: false } (unserialisable or too large to show completely). */
export function describeArgs(args) {
  let text;
  try { text = JSON.stringify(args ?? {}, null, 2); } catch { return { ok: false }; }
  if (typeof text !== 'string' || text.length > MAX_SHOWN_CHARS) return { ok: false };
  return { ok: true, text };
}
