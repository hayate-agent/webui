/** Agent commands (send, stop, media chunks, dialog answers) with a stable opId.
 *
 * Preferred path: a `command` frame on the healthy live WebSocket, acknowledged
 * by an `ack` frame. Fallback: POST with the SAME opId. The server keeps one
 * ledger for both paths, so a command executes at most once even when a frame
 * was delivered but its acknowledgement was lost. Nothing is replayed blindly:
 * after an unanswered frame the POST either returns the recorded outcome, joins
 * the running execution, or executes the command for the first time.
 */
/** opId = `<issue time ms, base36>-<uuid>` in server time (the server only
 * deduplicates inside a bounded window derived from the issue time). */
export const issueOpId = (now = Date.now()) => `${Math.max(0, Math.round(now)).toString(36)}-${crypto.randomUUID()}`;

export function createCommandChannel({ transport, post, ackTimeoutMs = 30000, timers = globalThis, serverOffsetMs = 0, now = Date.now }) {
 const pending = new Map();
 const settle = (opId, outcome) => { const entry = pending.get(opId); if (!entry) return; pending.delete(opId); timers.clearTimeout(entry.timer); entry.resolve(outcome); };
 const fallback = (frame) => post(frame);
 return {
  /** Feed `ack` frames from the live transport. */
  receive(frame) { if (frame?.type === 'ack' && typeof frame.opId === 'string') settle(frame.opId, frame); },
  /** Socket closed: unanswered frames move to the POST fallback (same opId). */
  disconnected() { for (const opId of [...pending.keys()]) settle(opId, undefined); },
  async run({ agentId, capability, input, opId = issueOpId(now() + serverOffsetMs) }) {
   const frame = { type: 'command', opId, agentId, capability, input };
   let outcome;
   if (!pending.has(opId) && transport.command?.(frame)) {
    outcome = await new Promise(resolve => pending.set(opId, { resolve, timer: timers.setTimeout(() => settle(opId, undefined), ackTimeoutMs) }));
   }
   // No acknowledgement (socket unavailable, closed or slow) or not executed
   // because of backpressure: the POST shares the ledger, so this is safe.
   if (!outcome || outcome.executed === false) return fallback(frame);
   if (!outcome.ok) throw Object.assign(Error(outcome.error || 'Agent operation failed'), { status: outcome.status });
   return outcome.result;
  },
  get pending() { return pending.size; },
 };
}
