// A page is projected inside the owning process, before socket serialization.
export function projectMessage(entry, budget = 100000) {
 const source = entry.message, blocks = Array.isArray(source.content) ? source.content : [];
 const message = { id: entry.id, role: source.role, timestamp: entry.timestamp ?? source.timestamp,
  text: (typeof source.content === 'string' ? source.content : blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')).slice(-12000),
  ...(source.role === 'assistant' ? { thinking: blocks.filter(block => block.type === 'thinking').map(block => block.thinking ?? '').join('\n').slice(-12000), toolCalls: blocks.filter(block => block.type === 'toolCall').slice(-4).map(block => ({ id: block.id, name: block.name, arguments: { preview: JSON.stringify(block.arguments ?? {}).slice(0, 1000) } })) } : {}),
  ...(source.role === 'toolResult' ? { toolCallId: source.toolCallId, toolName: source.toolName, isError: source.isError === true } : {}) };
 while (Buffer.byteLength(JSON.stringify(message)) > budget && (message.text.length > 100 || message.thinking?.length > 100)) {
  message.text = message.text.slice(-Math.max(100, Math.floor(message.text.length / 2)));
  if (message.thinking) message.thinking = message.thinking.slice(-Math.max(100, Math.floor(message.thinking.length / 2)));
 }
 return message;
}
const visible = entry => entry.type === 'message' && ['user', 'assistant', 'toolResult'].includes(entry.message?.role);

/** Shrinks an already projected message to fit one bounded stream frame. */
export function fitMessage(message, budget = 48000) {
 const copy = { ...message };
 while (Buffer.byteLength(JSON.stringify(copy)) > budget && ((copy.text?.length ?? 0) > 100 || (copy.thinking?.length ?? 0) > 100 || copy.toolCalls?.length)) {
  if (copy.text?.length > 100) copy.text = copy.text.slice(-Math.floor(copy.text.length / 2));
  if (copy.thinking?.length > 100) copy.thinking = copy.thinking.slice(-Math.floor(copy.thinking.length / 2));
  else if (copy.toolCalls?.length) copy.toolCalls = copy.toolCalls.slice(1);
  copy.truncated = true;
 }
 return copy;
}
/** Token and context figures like PI's TUI footer, derived only from the branch itself.
 * `tokens` is the last successful assistant turn's context size (what the next prompt
 * starts from); `totals` are session sums. Pure and bounded: one walk over the branch. */
export function sessionUsage(entries, leafId) {
 const byId = new Map(entries.map(entry => [entry.id, entry]));
 const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
 let entry = byId.get(leafId), tokens, provider, model, thinkingLevel; const seen = new Set();
 const num = value => Number.isFinite(value) && value >= 0 ? value : 0;
 while (entry && !seen.has(entry.id)) {
  seen.add(entry.id);
  const message = entry.type === 'message' ? entry.message : undefined;
  if (message?.role === 'assistant' && message.usage) {
   const usage = message.usage;
   totals.input += num(usage.input); totals.output += num(usage.output); totals.cacheRead += num(usage.cacheRead); totals.cacheWrite += num(usage.cacheWrite); totals.cost += num(usage.cost?.total);
   if (tokens === undefined && message.stopReason !== 'aborted' && message.stopReason !== 'error') {
    tokens = num(usage.totalTokens) || num(usage.input) + num(usage.output) + num(usage.cacheRead) + num(usage.cacheWrite);
    provider ??= message.provider; model ??= message.model;
   }
  } else if (entry.type === 'model_change') { provider ??= entry.provider; model ??= entry.modelId; }
  else if (entry.type === 'thinking_level_change') thinkingLevel ??= entry.thinkingLevel;
  entry = byId.get(entry.parentId);
 }
 return { tokens: tokens ?? null, provider, model, thinkingLevel, totals };
}

export function historyPage(entries, leafId, before) {
 const byId = new Map(entries.map(entry => [entry.id, entry]));
 let entry = byId.get(leafId), cursorFound = !before;
 const seen = new Set(), messages = []; let bytes = 0, more = false;
 while (entry && !seen.has(entry.id)) {
  seen.add(entry.id);
  if (!cursorFound) { if (entry.id === before) cursorFound = true; entry = byId.get(entry.parentId); continue; }
  if (visible(entry)) {
   const message = projectMessage(entry);
   const size = Buffer.byteLength(JSON.stringify(message));
   if (messages.length >= 64 || bytes + size > 120000) { more = true; break; }
   messages.unshift(message); bytes += size;
  }
  entry = byId.get(entry.parentId);
 }
 if (!cursorFound) throw Error('History cursor changed; reload conversation');
 return { messages, before: more && messages.length ? messages[0].id : null, historyTruncated: more, ...(before ? {} : { usage: sessionUsage(entries, leafId) }) };
}
