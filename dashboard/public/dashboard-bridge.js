// Connects a dashboard block to the agent it belongs to (see docs/DASHBOARD-TOOLS.md).
// Agent side contract, carried by the existing `messages` capability (so no relay re-enrolment):
//   { action: 'dashboard-tools', op: 'list', streamId }              -> { tools: [{ name, kind: 'read' | 'write' }] }
//   { action: 'dashboard-tools', op: 'call', streamId, tool, args }  -> { result }
// The agent marks what is read-only. Without the capability, or when the list fails, a dashboard has
// NO tools (never "all tools"). The call always goes through the owner/session-bound request path.
const MAX_TOOLS = 64;

export function cleanToolList(value) {
  const list = Array.isArray(value?.tools) ? value.tools : [];
  const seen = new Set(); const out = [];
  for (const tool of list) {
    if (out.length >= MAX_TOOLS) break;
    if (typeof tool?.name !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(tool.name) || seen.has(tool.name)) continue;
    seen.add(tool.name); out.push({ name: tool.name, kind: tool.kind === 'read' ? 'read' : 'write' });
  }
  return out;
}

/** request: (capability, input) => Promise. Returns { tools, call } for the block; tools [] on any failure. */
export async function connectDashboardTools({ request, agentId, streamId }) {
  if (typeof request !== 'function' || !agentId || !streamId) return { tools: [], call: async () => { throw new Error('no agent'); } };
  let tools = [];
  try { tools = cleanToolList(await request('messages', { action: 'dashboard-tools', op: 'list', streamId })); } catch { tools = []; }
  const call = async (tool, args) => {
    if (!tools.some(entry => entry.name === tool)) throw new Error(`Unknown dashboard tool ${tool}`);
    const response = await request('messages', { action: 'dashboard-tools', op: 'call', streamId, tool, args: args ?? {} });
    return response?.result;
  };
  return { tools, call };
}
