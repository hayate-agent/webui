/** Client-side streaming state (protocol stream-delta-v1).
 *
 * A conversation view starts from one bounded GET page carrying
 * `stream: { epoch, seq }`. Afterwards only small envelopes are applied, in strict
 * per-session order. Gaps are repaired with `changes(since)`; a lost window or a
 * restarted producer (`epoch` changed) leads to exactly one bounded page reload.
 * This module never sends mutations and never replays anything.
 */
export const MAX_LIVE_TEXT = 12000;

export function createStreamState({ fetchChanges, reload, onUpdate = () => {}, onError = () => {}, now = Date.now }) {
 let view, repairing = false, repairAgain = false, queued = [];
 const touch = () => onUpdate(view);
 function apply(envelope) {
  const data = envelope.data ?? {};
  switch (envelope.kind) {
   case 'text.delta': view.activity.text = (view.activity.text + (data.delta ?? '')).slice(-MAX_LIVE_TEXT); view.activity.busy = true; break;
   case 'thinking.delta': view.activity.thinking = (view.activity.thinking + (data.delta ?? '')).slice(-MAX_LIVE_TEXT); view.activity.busy = true; break;
   case 'tool.status': {
    const tools = view.activity.executions; const index = tools.findIndex(tool => tool.id === data.id);
    const next = { ...(index >= 0 ? tools[index] : {}), ...data };
    // The producer sends no start time; PI shows `Elapsed` while a tool runs, so the
    // viewer stamps first sight and derives `Took` when the producer sent no duration.
    if (next.startedAt === undefined) next.startedAt = now();
    if (next.status !== 'running' && !Number.isFinite(next.durationMs)) next.durationMs = Math.max(0, now() - next.startedAt);
    if (index >= 0) tools[index] = next; else tools.push(next);
    if (tools.length > 12) tools.splice(0, tools.length - 12);
    view.activity.busy = true; break;
   }
   case 'turn.status':
    view.activity.busy = data.busy === true; view.activity.waiting = data.waiting ?? null;
    if (!data.busy) { view.activity.text = ''; view.activity.thinking = ''; view.activity.executions = []; view.dialogs = []; }
    break;
   case 'message.end': view.activity.text = ''; view.activity.thinking = ''; break;
   case 'entry.appended': {
    const message = data.message; if (!message?.id) break;
    const index = view.messages.findIndex(item => item.id === message.id);
    if (index >= 0) view.messages[index] = message; else view.messages.push(message);
    if (view.messages.length > 256) view.messages.splice(0, view.messages.length - 256);
    if (message.role === 'assistant') { view.activity.text = ''; view.activity.thinking = ''; }
    break;
   }
   case 'usage.update': if (data.usage && typeof data.usage === 'object') view.usage = data.usage; break;
   case 'session.info': view.title = data.name ?? view.title; break;
   case 'dialog.open': if (data.dialog?.id) { view.dialogs = [...view.dialogs.filter(item => item.id !== data.dialog.id), data.dialog].slice(-8); } break;
   case 'dialog.closed': view.dialogs = view.dialogs.filter(item => item.id !== data.id); break;
   case 'history.reset': return 'reset';
   default: break;
  }
  return 'applied';
 }
 async function repair() {
  if (!view) return;
  if (repairing) { repairAgain = true; return; }
  repairing = true;
  const target = view;
  try {
   // Bounded: after a few rounds without closing the gap, reload one page.
   for (let rounds = 0; view === target; rounds++) {
    if (rounds >= 8) { queued = []; await reload(); return; }
    repairAgain = false;
    const before = target.seq;
    const result = await fetchChanges(target.session, target.seq, target.epoch);
    if (view !== target) return;
    if (result.reset || result.epoch !== target.epoch) { queued = []; await reload(); return; }
    for (const envelope of result.events ?? []) if (envelope.seq === target.seq + 1) { if (apply(envelope) === 'reset') { queued = []; await reload(); return; } target.seq = envelope.seq; }
    drain();
    touch();
    // Continue while the producer has more, a new repair was requested during
    // this round, or a queued event still leaves a gap. Otherwise done.
    if (!result.more && !repairAgain && !queued.length) break;
    if (!result.more && target.seq === before && !repairAgain) { queued = []; await reload(); return; }
   }
  } catch (error) { onError(error); }
  finally { repairing = false; }
 }
 function drain() {
  queued.sort((a, b) => a.seq - b.seq);
  while (queued.length && queued[0].seq <= view.seq + 1) {
   const envelope = queued.shift();
   if (envelope.seq <= view.seq) continue;
   if (apply(envelope) === 'reset') { queued = []; void reload(); return; }
   view.seq = envelope.seq;
  }
 }
 return {
  /** Starts from a GET page. Returns the normalized view object (mutated in place). */
  reset(session, page) {
   queued = [];
   view = { session, epoch: page.stream?.epoch, seq: page.stream?.seq ?? 0, title: page.title, messages: [...(page.messages ?? [])], usage: page.usage, dialogs: [...(page.dialogs ?? [])].slice(-8),
    activity: { busy: !!(page.busy && !page.busyUnknown), text: page.liveText ?? page.activity?.text ?? '', thinking: page.liveThinking ?? page.activity?.thinking ?? '', executions: [...(page.liveTools ?? page.activity?.executions ?? [])].map(tool => tool.status === 'running' && tool.startedAt === undefined ? { ...tool, startedAt: tool.durationMs !== undefined ? now() - tool.durationMs : now() } : tool), waiting: null } };
   return view;
  },
  get view() { return view; },
  get streaming() { return !!view?.epoch; },
  /** Applies one pushed envelope. Returns true when the view changed. */
  receive(envelope) {
   if (!view || !view.epoch || envelope?.session !== view.session) return false;
   if (envelope.epoch !== view.epoch) { void reload(); return false; }
   if (envelope.seq <= view.seq) return false;
   if (envelope.seq > view.seq + 1) { if (queued.length < 512) queued.push(envelope); void repair(); return false; }
   if (apply(envelope) === 'reset') { void reload(); return false; }
   view.seq = envelope.seq; drain(); touch(); return true;
  },
  /** After reconnecting: fetch only what was missed. */
  resync() { return repair(); },
  clear() { view = undefined; queued = []; },
 };
}
