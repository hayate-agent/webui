import { WebSocket } from 'ws';
import { chatBindings } from './chat-bindings.mjs';
import { readFile, writeFile, mkdir, chmod, lstat, rename } from 'node:fs/promises';
import path from 'node:path';
const capabilities = ['projects', 'streams', 'messages', 'activity'];
// Read-only data a dashboard may query on a PI host. Adding a tool here is a security decision (docs/DASHBOARD-TOOLS.md).
// Results contain names and flags only: no paths, no message text.
const DASHBOARD_TOOLS = [
 { name: 'list_sessions', kind: 'read', async run({ request, bindings }) {
   const [result, selected] = await Promise.all([request('/api/pi/sessions'), bindings.list()]);
   const sessions = (Array.isArray(result?.sessions) ? result.sessions : []).filter(session => typeof session?.id === 'string' && selected[session.id]?.status === 'active').slice(0, 200)
     .map(session => ({ id: session.id, name: String(session.name ?? '').slice(0, 200), busy: session.busy === true }));
   return { sessions, count: sessions.length };
 } },
];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export async function enrollRelay({ endpoint, code, name, stateFile }) {
 const url = new URL(endpoint);
 if (url.protocol !== 'https:' || url.origin !== endpoint || url.username || url.password) throw Error('Canonical HTTPS relay origin required');
 try { await lstat(stateFile); throw Error('Relay state already exists; reconcile or revoke before enrolling again'); }
 catch (error) { if (error.code !== 'ENOENT') throw error; }
 const response = await fetch(endpoint + '/api/agent-link/v1/enroll', { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, agent: name, capabilities }), signal: AbortSignal.timeout(15000) });
 if (!response.ok) throw Error(`Relay enrollment refused (${response.status})`);
 const state = await response.json();
 if (state.protocol !== 1 || state.endpoint !== endpoint || !UUID.test(state.id) || !/^[A-Za-z0-9_-]{43}$/.test(state.token) || !Array.isArray(state.capabilities) || state.capabilities.some(c => !capabilities.includes(c)) || !Number.isSafeInteger(state.expiresAt) || state.expiresAt <= Date.now()) throw Error('Invalid enrollment response');
 await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
 await writeFile(stateFile, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
 return { id: state.id, endpoint };
}
/** Uses the existing authenticated central AgentLink relay, not a public local port.
 * Only explicit PI routes cross the link. Productive requests are never replayed. */
export async function startRelayClient({ stateFile, endpoint, adapterOrigin, WebSocketClass = WebSocket, reconnectMs = 2000 }) {
 const state = JSON.parse(await readFile(stateFile, 'utf8'));
 const url = new URL(endpoint), adapter = new URL(adapterOrigin);
 if (url.protocol !== 'https:' || url.origin !== endpoint || state.endpoint !== endpoint || !UUID.test(state.id) || !/^[A-Za-z0-9_-]{43}$/.test(state.token) || !Number.isSafeInteger(state.expiresAt) || state.expiresAt <= Date.now() || !Array.isArray(state.capabilities) || state.capabilities.some(c => !capabilities.includes(c))) throw Error('Invalid or expired relay enrollment');
 if (adapter.protocol !== 'http:' || adapter.hostname !== '127.0.0.1' || adapter.pathname !== '/' || adapter.username || adapter.password || adapter.search || adapter.hash) throw Error('Local adapter origin required');
 await chmod(stateFile, 0o600);
 let socket, timer, heartbeat, stopped = false, blocked = false;
 const inFlight = new Set();
 let totalActive = 0;
 const seen = new Set();
 const seenReads = new Set();
 const request = async (route, body) => {
  const response = await fetch(adapterOrigin + route, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', headers: body === undefined ? {} : { origin: adapterOrigin, 'x-hayate-webui': '1', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw Error('Local PI request refused');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
   size += chunk.byteLength;
   if (size > 230000) throw Error('PI response too large');
   chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
 };
 const bindings = chatBindings(stateFile + '.chats.json');
 const submissions = new Map();
 const eventAbort = new AbortController(); let eventRevision = 0, eventTimer, eventRetry, eventRetryDone;
 const invalidate = () => {
  if (eventTimer || stopped) return;
  eventTimer = setTimeout(() => {
   eventTimer = undefined;
   if (socket?.readyState !== 1) return; // A reconnect resynchronizes anyway.
   // Backpressure delays, never loses, the invalidation.
   if (socket.bufferedAmount >= 500000) { invalidate(); return; }
   socket.send(JSON.stringify({ type: 'changed', revision: String(++eventRevision) }));
  }, 100);
 };
 // Streaming deltas (stream-delta-v1) are pushed only after the central relay
 // acknowledged the advertised feature on this socket (`features` frame).
 // Older relays never send it and keep receiving invalidations only.
 let streaming;
 // Advertise stream-delta-v1 in the handshake without touching authentication.
 const BaseSocket = WebSocketClass;
 WebSocketClass = class extends BaseSocket { constructor(target, protocol, options = {}) { super(target, protocol, { ...options, headers: { ...options.headers, 'X-Hayate-Agent-Features': 'stream-delta-v1' } }); } };
 const forward = envelope => {
  if (!streaming || streaming !== socket || socket.readyState !== 1) return false;
  if (!envelope || typeof envelope.session !== 'string' || !Number.isSafeInteger(envelope.seq)) return false;
  const text = JSON.stringify({ type: 'event', envelope });
  // Never drop silently: an undeliverable event becomes an invalidation, and
  // browsers repair it through `changes?since` (no transcript reload).
  if (Buffer.byteLength(text) > 70000 || socket.bufferedAmount >= 500000) return false;
  socket.send(text);
  return true;
 };
 let subscribed = 0;
 const events = (async () => {
  while (!eventAbort.signal.aborted) {
  try {
   const response = await fetch(adapterOrigin + '/api/pi/events', { signal: eventAbort.signal });
   if (!response.ok) throw Error('Event source unavailable');
   // Events emitted while the subscription was down were never seen: every
   // (re)subscription invalidates, so browsers repair via `changes?since`.
   if (subscribed++) invalidate();
   let buffer = '';
   for await (const chunk of response.body) {
    buffer += Buffer.from(chunk).toString('utf8');
    if (buffer.length > 262144) buffer = buffer.slice(-262144);
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
     const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
     if (!frame.startsWith('data:')) continue;
     let value; try { value = JSON.parse(frame.slice(5)); } catch { invalidate(); continue; }
     if (value?.type === 'stream' && forward(value.envelope)) continue;
     // Raw native events are represented by stream envelopes while streaming.
     if (streaming && streaming === socket && value?.sessionId && value?.event) continue;
     invalidate();
    }
   }
  } catch { /* A read subscription may reconnect; mutations never replay. */ }
  if (!eventAbort.signal.aborted) await new Promise(resolve => { eventRetryDone = resolve; eventRetry = setTimeout(resolve, 2000); });
  }
 })();
 const knownChats = new Map();
 const dispatch = async frame => {
  if (!capabilities.includes(frame.capability) || !state.capabilities.includes(frame.capability)) throw Error('Scope refused');
  const input = frame.input;
  // Existing central clients can identify this host without backend protocol changes.
  if (frame.capability === 'projects' && input.action === 'list') return { projects: [], features: ['pi-live-v1'] };
  if (frame.capability === 'projects' && input.action === 'resolve') return { projectId: null, features: ['pi-live-v1'] };
  if (frame.capability === 'streams' && input.action === 'fork-eligibility') {
    if (!/^[A-Za-z0-9_-]+$/.test(input.streamId)) throw Error('Invalid source session');
    return request(`/api/pi/sessions/${input.streamId}/fork`);
  }
  if (frame.capability === 'streams' && input.action === 'fork') {
    if (!UUID.test(input.idempotencyKey) || !/^[A-Za-z0-9_-]+$/.test(input.streamId)) throw Error('Fork requires source and stable creation identity');
    if (input.entryId !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(input.entryId)) throw Error('Invalid message to fork from');
    const ledgerDir = stateFile + '.operations'; await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
    const operation = path.join(ledgerDir, input.idempotencyKey + '.json');
    const fingerprint = JSON.stringify({ action: 'fork', source: input.streamId, ...(input.entryId !== undefined ? { entryId: input.entryId } : {}) });
    // Definite read-only rejection must not poison the durable mutation receipt.
    try { await readFile(operation, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const eligibility = await request(`/api/pi/sessions/${input.streamId}/fork`);
      if (eligibility?.eligible === false) throw Error(eligibility.reason || 'Session cannot be forked yet');
    }
    try { await writeFile(operation, JSON.stringify({ fingerprint, pending: true }), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const prior = JSON.parse(await readFile(operation, 'utf8'));
      if (prior.fingerprint !== fingerprint || !prior.result) throw Error('Fork outcome unknown; reconcile sessions before retry');
      await bindings.set(prior.result.id, 'active'); return prior.result;
    }
    const created = await request(`/api/pi/sessions/${input.streamId}/fork`, input.entryId !== undefined ? { entryId: input.entryId } : {});
    const result = { ...created, projectId: null };
    await writeFile(operation + '.tmp', JSON.stringify({ fingerprint, result }), { mode: 0o600 }); await rename(operation + '.tmp', operation);
    await bindings.set(result.id, 'active'); return result;
  }
  if (frame.capability === 'streams' && input.action === 'create') {
    if (!UUID.test(input.idempotencyKey) || input.projectId != null) throw Error('Choose a standalone PI workspace');
    const ledgerDir = stateFile + '.operations';
    await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
    const operation = path.join(ledgerDir, input.idempotencyKey + '.json');
    const fingerprint = JSON.stringify({ cwd: input.cwd, title: input.title });
    try { await writeFile(operation, JSON.stringify({ fingerprint, pending: true }), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const prior = JSON.parse(await readFile(operation, 'utf8'));
      if (prior.fingerprint !== fingerprint) throw Error('Creation outcome unknown; reconcile sessions before retry');
      if (prior.result) { await bindings.set(prior.result.id, 'active'); return prior.result; }
      // Unfinished earlier attempt: the adapter answers the same key with the same session (or starts one).
    }
    const created = await request('/api/pi/sessions', { cwd: input.cwd, idempotencyKey: input.idempotencyKey });
    const result = { id: created.id, title: input.title ?? 'PI conversation', projectId: null };
    await writeFile(operation + '.tmp', JSON.stringify({ fingerprint, result }), { mode: 0o600 });
    await rename(operation + '.tmp', operation);
    await bindings.set(created.id, 'active');
    return result;
  }
  if (frame.capability === 'streams' && input.action === 'list') {
    const result = await request('/api/pi/sessions');
    const selected = await bindings.list();
    for (const session of result.sessions) knownChats.set(session.id, { id: session.id, projectId: null, title: session.name, readOnly: session.owner === 'disk', features: session.features ?? [], cwd: session.cwd });
    for (const id of knownChats.keys()) if (selected[id]?.status !== 'active') knownChats.delete(id);
    const connected = new Set(result.sessions.map(session => session.id));
    return { streams: [...knownChats.values()].filter(session => selected[session.id]?.status === 'active').map(session => ({ ...session, unavailable: !connected.has(session.id) })), features: ['pi-live-v1', 'standalone-chats', 'idempotent-stream-create', 'pi-chat-bindings', 'chat-fork-v1', 'fork-eligibility-v1', 'fork-from-message-v1'] };
  }
  if (frame.capability === 'messages' && input.action === 'pi-chats') {
    if (input.operation === 'list') { const result = await request('/api/pi/sessions'); const selected = await bindings.list(); return { sessions: result.sessions.map(session => ({ ...session, chatStatus: selected[session.id]?.status ?? 'unselected' })) }; }
    if (input.operation === 'preview' && /^[A-Za-z0-9_-]+$/.test(input.sessionId)) {
      const result = await request(`/api/pi/sessions/${input.sessionId}?view=remote`);
      return { messages: result.messages.filter(message => ['user', 'assistant'].includes(message.role) && message.text).slice(-3).map(message => ({ role: message.role, text: message.text.slice(0, 350) })) };
    }
    if (input.operation === 'rename' && /^[A-Za-z0-9_-]+$/.test(input.sessionId)) return request(`/api/pi/sessions/${input.sessionId}/rename`, { name: input.name });
    if (input.operation === 'set') {
      const result = await request('/api/pi/sessions');
      if (!result.sessions.some(session => session.id === input.sessionId)) throw Error('Unknown PI session');
      await bindings.set(input.sessionId, input.status); return { updated: true };
    }
    throw Error('Invalid chat binding operation');
  }
  if (frame.capability === 'messages' && input.action === 'read' && /^[A-Za-z0-9_-]+$/.test(input.streamId)) {
    const result = await request(`/api/pi/sessions/${input.streamId}?view=remote${input.before ? '&before=' + encodeURIComponent(input.before) : ''}`);
    return { ...result, id: input.streamId, title: 'PI conversation', activity: result.busy || result.liveText ? { text: result.liveText, thinking: result.liveThinking, executions: result.liveTools, tools: {} } : null };
  }
  if (frame.capability === 'messages' && input.action === 'changes' && /^[A-Za-z0-9_-]+$/.test(input.streamId) && Number.isSafeInteger(input.since) && input.since >= 0) {
    return request(`/api/pi/sessions/${input.streamId}/changes?since=${input.since}${typeof input.epoch === 'string' && input.epoch.length <= 64 ? '&epoch=' + encodeURIComponent(input.epoch) : ''}`);
  }
  if (frame.capability === 'messages' && input.action === 'image-read' && /^[A-Za-z0-9_-]+$/.test(input.streamId) && typeof input.messageId === 'string' && input.messageId.length <= 128 && Number.isSafeInteger(input.index) && Number.isSafeInteger(input.offset ?? 0)) {
    return request(`/api/pi/sessions/${input.streamId}/image?message=${encodeURIComponent(input.messageId)}&index=${input.index}&offset=${input.offset ?? 0}`);
  }
  if (frame.capability === 'messages' && input.action === 'submission-status' && /^[A-Za-z0-9_-]+$/.test(input.streamId) && UUID.test(input.id)) {
    const submission = submissions.get(input.streamId + ':' + input.id);
    return { status: submission?.status ?? 'unknown' };
  }
  if (frame.capability === 'messages' && input.action === 'media-chunk' && /^[A-Za-z0-9_-]+$/.test(input.streamId)) {
    return request(`/api/pi/sessions/${input.streamId}/media`, input.chunk);
  }
  if (frame.capability === 'messages' && input.action === 'send' && /^[A-Za-z0-9_-]+$/.test(input.streamId) && UUID.test(input.id)) {
    const key = input.streamId + ':' + input.id;
    const fingerprint = JSON.stringify({ text: input.text, mode: input.mode ?? null, attachments: input.attachments ?? [] });
    if (submissions.has(key)) {
      if (submissions.get(key).fingerprint !== fingerprint) throw Error('Message identity conflict');
      throw Error('Already submitted; reconcile history before retry');
    }
    if (submissions.size >= 4096) throw Error('Submission ledger full; reconcile before restarting bridge');
    const submission = { status: 'unknown', fingerprint }; submissions.set(key, submission);
    const result = await request(`/api/pi/sessions/${input.streamId}/prompt`, { text: input.text, ...(input.attachments ? { attachments: input.attachments } : {}), ...(input.mode ? { mode: input.mode } : {}) });
    submission.status = 'accepted';
    return result;
  }
  // Dashboard tools (docs/DASHBOARD-TOOLS.md). A PI host offers none: the list is empty and a call is refused,
  // so dashboards in PI chats render layout and static values only. A real tool source plugs in here.
  if (frame.capability === 'messages' && input.action === 'dashboard-tools') {
    if (typeof input.streamId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(input.streamId)) throw Error('Dashboard tools need a conversation');
    if (input.op === 'list') return { tools: DASHBOARD_TOOLS.map(({ name, kind }) => ({ name, kind })) };
    // Only tools from the fixed list below, only read-only, only chats the operator selected for this relay.
    const tool = input.op === 'call' ? DASHBOARD_TOOLS.find(entry => entry.name === input.tool) : undefined;
    if (!tool) throw Error('Unknown dashboard tool');
    return { result: await tool.run({ request, bindings }) };
  }
  if (frame.capability === 'activity' && input.action === 'list') return { streams: [], features: ['pi-live-v1'] };
  if (frame.capability !== 'messages' || input.action !== 'pi') throw Error('Unsupported PI capability');
  const route = input.route;
  const dirs = typeof route === 'string' && /^\/api\/pi\/dirs(?:\?path=[^#\s]{1,1024})?$/.test(route) && input.body === undefined;
  if (!dirs && (typeof route !== 'string' || !/^\/api\/pi\/sessions(?:\/[A-Za-z0-9_-]+(?:\/(?:prompt|abort|dialog|release))?)?$/.test(route))) throw Error('PI route refused');
  if (input.body !== undefined && (!input.body || typeof input.body !== 'object' || Array.isArray(input.body))) throw Error('PI JSON body required');
  const snapshot = input.body === undefined && /^\/api\/pi\/sessions\/[A-Za-z0-9_-]+$/.test(route);
  return request(route + (snapshot ? '?view=remote' : ''), input.body);
 };
 const connect = () => {
  if (stopped || blocked || state.expiresAt <= Date.now()) return;
  socket = new WebSocketClass(endpoint.replace(/^https:/, 'wss:') + '/api/agent-link/v1/connect', 'hayate.agent-link.v1', { headers: { Authorization: 'Bearer ' + state.token, 'X-Hayate-Agent-ID': state.id }, handshakeTimeout: 10000, maxPayload: 262144, perMessageDeflate: false, followRedirects: false });
  const current = socket;
  const alive = () => { clearTimeout(heartbeat); heartbeat = setTimeout(() => current.terminate(), 90000); };
  current.on('open', alive); current.on('ping', alive); current.on('error', () => {});
  current.on('unexpected-response', (_req, res) => { res.resume(); if ([401, 403].includes(res.statusCode)) blocked = true; current.terminate(); });
  current.on('close', code => { clearTimeout(heartbeat); if (code === 4003) blocked = true; if (!stopped && !blocked) timer = setTimeout(connect, reconnectMs); });
  current.on('message', (bytes, binary) => {
   let frame;
   try { frame = JSON.parse(bytes.toString()); } catch { current.close(1008, 'Invalid request'); return; }
   if (!binary && frame?.type === 'features' && Array.isArray(frame.features)) { if (frame.features.includes('stream-delta-v1')) streaming = current; return; }
   try { if (binary || !UUID.test(frame.id) || frame.type !== 'request' || !frame.input || typeof frame.input !== 'object' || seen.has(frame.id) || seenReads.has(frame.id)) throw Error(); }
   catch { current.close(1008, 'Invalid request'); return; }
   const readOnly = ['list', 'read', 'resolve', 'submission-status', 'fork-eligibility', 'changes', 'image-read'].includes(frame.input.action) || frame.input.action === 'pi-chats' && ['list', 'preview'].includes(frame.input.operation) || frame.input.action === 'pi' && frame.input.body === undefined
    // Dashboards poll: listing tools and calling a read tool must not fill the (non-evicting) mutation ledger.
    || frame.input.action === 'dashboard-tools' && (frame.input.op === 'list' || frame.input.op === 'call' && DASHBOARD_TOOLS.some(tool => tool.name === frame.input.tool && tool.kind === 'read'));
   if (readOnly) {
    if (seenReads.size >= 4096) seenReads.delete(seenReads.values().next().value);
    seenReads.add(frame.id);
   } else {
    if (seen.size >= 4096) { current.close(1008, 'Mutation replay ledger full; reconcile before restarting'); return; }
    seen.add(frame.id);
   }
   // Capacity is not a malformed frame. Refuse this admitted request only;
   // closing the socket also aborts unrelated readers in other browser tabs.
   if (totalActive >= 8) {
    console.error('PI relay: request capacity reached; connection retained');
    if (!stopped && current.readyState === 1) current.send(JSON.stringify({ type: 'response', id: frame.id, ok: false }), () => {});
    return;
   }
   totalActive++;
   const work = (async () => {
    let response;
    try { response = { type: 'response', id: frame.id, ok: true, result: await dispatch(frame) }; }
    catch (error) {
      const category = error?.message === 'PI response too large' ? 'response-size' : error?.message === 'Local PI request refused' ? 'adapter-refused' : error?.name === 'TimeoutError' ? 'timeout' : 'dispatch-failed';
      console.error('PI relay request failed:', category);
      response = { type: 'response', id: frame.id, ok: false };
    }
    const text = JSON.stringify(response);
    if (Buffer.byteLength(text) > 250000 || current.bufferedAmount > 500000) current.close(1009, 'Response limit');
    else if (!stopped && current.readyState === 1) current.send(text, () => {});
   })().finally(() => { totalActive--; inFlight.delete(work); });
   inFlight.add(work);
  });
 };
 connect();
 return { async stop() { stopped = true; eventAbort.abort(); clearTimeout(eventRetry); eventRetryDone?.(); clearTimeout(eventTimer); clearTimeout(timer); clearTimeout(heartbeat); socket?.terminate(); await Promise.allSettled([...inFlight, events]); } };
}
