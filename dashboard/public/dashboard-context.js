// The agent the visible conversation belongs to. workspace-client sets it when a conversation is
// shown; an openui block reads it when it mounts. No context means no tools.
let context;
export function setDashboardContext(next) { context = next && typeof next.request === 'function' && next.agentId && next.streamId ? { request: next.request, agentId: next.agentId, streamId: next.streamId } : undefined; }
export function getDashboardContext() { return context; }

/** Runs `render` with the context set and ALWAYS clears it afterwards, also when render throws. */
export function withDashboardContext(next, render) {
  setDashboardContext(next);
  try { return render(); } finally { setDashboardContext(undefined); }
}
