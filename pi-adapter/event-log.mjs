import { randomUUID } from 'node:crypto';

/** Streaming change log (protocol `stream-delta-v1`).
 *
 * The native agent remains the source of truth. This log only keeps a bounded,
 * disposable window of recent per-session changes so clients can stream deltas
 * and repair short gaps. Envelope: `{ v, epoch, session, seq, kind, data }`.
 * - `epoch` is per session generation: it changes when the log restarts or the
 *   session window was evicted and recreated; clients must then reset.
 * - `seq` is contiguous per session within one epoch.
 * - `since(session, seq)` returns the missing events, or `{ reset: true }` when the
 *   gap is no longer retained. Clients then reload the latest bounded page.
 *
 * Extension point: `sinks` receive every envelope (auditing, forwarding). A sink is
 * isolated: sync throws and async rejections are swallowed and never block delivery.
 */
export const STREAM_PROTOCOL = 'stream-delta-v1';
export const MAX_EVENT_BYTES = 64 * 1024;

export function createEventLog({ maxEventsPerSession = 512, maxBytesPerSession = 1024 * 1024, maxSessions = 128, sinks = [], epoch = randomUUID() } = {}) {
 const sessions = new Map(); const listeners = new Set(); let generation = 0;
 const sinkList = [...sinks];
 const state = id => {
  let entry = sessions.get(id);
  if (entry) { sessions.delete(id); sessions.set(id, entry); return entry; }
  entry = { epoch: `${epoch}.${++generation}`, seq: 0, events: [], bytes: 0 };
  sessions.set(id, entry);
  while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
  return entry;
 };
 const deliver = envelope => {
  for (const listener of listeners) { try { listener(envelope); } catch { /* A slow/broken consumer never affects the producer. */ } }
  for (const sink of sinkList) {
   try { const result = sink.onEvent?.(envelope); if (result && typeof result.catch === 'function') result.catch(() => {}); }
   catch { /* Sinks are optional extensions; failures stay isolated. */ }
  }
 };
 return {
  epoch,
  append(session, kind, data = {}) {
   if (typeof session !== 'string' || !session || typeof kind !== 'string') throw Error('Invalid stream event');
   const entry = state(session);
   const envelope = { v: 1, epoch: entry.epoch, session, seq: entry.seq + 1, kind, data };
   const size = Buffer.byteLength(JSON.stringify(envelope));
   if (size > MAX_EVENT_BYTES) throw Error('Stream event exceeds frame budget');
   entry.seq = envelope.seq; entry.events.push({ envelope, size }); entry.bytes += size;
   while (entry.events.length > maxEventsPerSession || entry.bytes > maxBytesPerSession) entry.bytes -= entry.events.shift().size;
   deliver(envelope);
   return envelope;
  },
  // Creates the session window so the advertised epoch stays valid for later events.
  head(session) { const entry = state(session); return { epoch: entry.epoch, session, seq: entry.seq }; },
  since(session, seq, { epoch: clientEpoch, limit = 256 } = {}) {
   const entry = state(session), current = entry.seq, sessionEpoch = entry.epoch;
   const reset = { epoch: sessionEpoch, session, seq: current, reset: true, events: [] };
   if (clientEpoch !== undefined && clientEpoch !== sessionEpoch) return reset;
   if (!Number.isSafeInteger(seq) || seq < 0 || seq > current) return reset;
   if (seq === current) return { epoch: sessionEpoch, session, seq: current, events: [] };
   const first = entry.events[0]?.envelope.seq ?? current + 1;
   if (seq + 1 < first) return reset;
   const events = entry.events.filter(item => item.envelope.seq > seq).slice(0, Math.max(1, Math.min(limit, 512))).map(item => item.envelope);
   return { epoch: sessionEpoch, session, seq: current, events, more: events.at(-1).seq < current };
  },
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  addSink(sink) { sinkList.push(sink); return () => { const index = sinkList.indexOf(sink); if (index >= 0) sinkList.splice(index, 1); }; },
  forget(session) { sessions.delete(session); },
 };
}

const clip = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : value;
const preview = value => { try { return clip(typeof value === 'string' ? value : JSON.stringify(value ?? {}), 2000); } catch { return ''; } };

/** Turns raw native PI events into bounded stream deltas. Text deltas are coalesced
 * per session so token streams become a few small frames per second, not hundreds. */
const MAX_DELTA_JSON = 48 * 1024;
export function createPiEventNormalizer(log, { flushMs = 50, maxDeltaChars = 16000, timers = globalThis } = {}) {
 const buffers = new Map();
 const flush = session => {
  const pending = buffers.get(session); if (!pending) return;
  buffers.delete(session); timers.clearTimeout(pending.timer);
  for (const kind of ['thinking.delta', 'text.delta']) {
   let text = pending[kind];
   while (text) {
    // Bound by serialized size, not characters: JSON escaping can expand
    // control characters six-fold. Never split a surrogate pair.
    let cut = Math.min(text.length, maxDeltaChars);
    while (cut > 1 && JSON.stringify(text.slice(0, cut)).length > MAX_DELTA_JSON) cut = Math.floor(cut / 2);
    if (cut < text.length && /[\uD800-\uDBFF]/.test(text[cut - 1])) cut--;
    try { log.append(session, kind, { delta: text.slice(0, cut) }); }
    catch { /* Never terminate the adapter for one delta; clients repair from the durable entry. */ }
    text = text.slice(Math.max(1, cut));
   }
  }
 };
 const delta = (session, kind, text) => {
  if (typeof text !== 'string' || !text) return;
  let pending = buffers.get(session);
  if (!pending) { pending = { 'text.delta': '', 'thinking.delta': '' }; pending.timer = timers.setTimeout(() => { try { flush(session); } catch { /* isolated */ } }, flushMs); buffers.set(session, pending); }
  pending[kind] += text;
  if (pending[kind].length >= maxDeltaChars) flush(session);
 };
 return {
  flush,
  handle(session, event) {
   if (!event || typeof event.type !== 'string') return;
   const update = event.assistantMessageEvent;
   if (event.type === 'message_update' && update?.type === 'text_delta') return delta(session, 'text.delta', update.delta);
   if (event.type === 'message_update' && update?.type === 'thinking_delta') return delta(session, 'thinking.delta', update.delta);
   // Order matters: pending text must precede the status change it belongs to.
   flush(session);
   if (event.type === 'agent_start') log.append(session, 'turn.status', { busy: true });
   else if (event.type === 'agent_settled') log.append(session, 'turn.status', { busy: false });
   else if (event.type === 'ui_prompt_start') log.append(session, 'turn.status', { busy: true, waiting: clip(event.title ?? event.kind ?? 'question', 300) });
   else if (event.type === 'ui_prompt_end') log.append(session, 'turn.status', { busy: true, waiting: null });
   // Answerable RPC dialogs travel as bounded events; answering still uses the
   // explicit dialog route. TUI prompts stay with their native terminal.
   else if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(event.method) && typeof event.id === 'string') {
    const dialog = (scale = 1) => ({ id: clip(event.id, 200), method: event.method, title: clip(event.title, 300 * scale), message: clip(event.message, 4000 * scale), placeholder: clip(event.placeholder, 300 * scale), prefill: clip(event.prefill, 8000 * scale), options: Array.isArray(event.options) ? event.options.slice(0, 64).map(option => clip(String(option), 300)) : undefined, ...(Number.isFinite(event.timeout) ? { expiresAt: Date.now() + event.timeout } : {}) });
    // Escaped content may exceed the frame budget: shrink rather than hide the question.
    try { log.append(session, 'dialog.open', { dialog: dialog() }); }
    catch { log.append(session, 'dialog.open', { dialog: { ...dialog(0.1), options: dialog().options?.slice(0, 16).map(option => option.slice(0, 100)) } }); }
   }
   else if (event.type === 'dialog_answered' && typeof event.id === 'string') log.append(session, 'dialog.closed', { id: clip(event.id, 200) });
   else if (event.type === 'message_end' && ['assistant', 'toolResult', 'user'].includes(event.message?.role)) log.append(session, 'message.end', { role: event.message.role });
   else if (event.type === 'tool_execution_start') log.append(session, 'tool.status', { id: clip(event.toolCallId, 200), name: clip(event.toolName, 200), status: 'running', arguments: preview(event.args) });
   else if (event.type === 'tool_execution_end') log.append(session, 'tool.status', { id: clip(event.toolCallId, 200), name: clip(event.toolName, 200), status: event.isError ? 'failed' : 'completed', ...(Number.isFinite(event.durationMs) ? { durationMs: event.durationMs } : {}) });
   else if (event.type === 'session_info_changed') log.append(session, 'session.info', { name: clip(event.name ?? event.sessionName, 300) ?? null });
  },
 };
}
