import { createContextWindows } from './context-window.mjs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createMediaStore, validatePromptImages } from './media.mjs';
import { verifyDecodedImage } from './media-decode.mjs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { createOwnerServer } from './owner-server.mjs';
import { RpcOwner } from './rpc-owner.mjs';
import { SessionCatalog } from './catalog.mjs';
import { NativeHistoryReader } from './native-history-reader.mjs';
import { historyPage, fitMessage, imageChunk } from './history-page.mjs';
import { createEventLog, createPiEventNormalizer } from './event-log.mjs';

export function projectEntries(entries, leafId) {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const branch = [], seen = new Set();
  let entry = byId.get(leafId);
  while (entry && !seen.has(entry.id)) { seen.add(entry.id); branch.unshift(entry); entry = byId.get(entry.parentId); }
  return branch.filter(entry => entry.type === 'message' && ['user', 'assistant', 'toolResult'].includes(entry.message?.role)).map(entry => ({
    id: entry.id, role: entry.message.role,
    text: typeof entry.message.content === 'string' ? entry.message.content : (entry.message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n'),
    timestamp: entry.timestamp ?? entry.message.timestamp,
    ...(entry.message.role === 'assistant' ? { thinking: (Array.isArray(entry.message.content) ? entry.message.content : []).filter(block => block.type === 'thinking').map(block => block.thinking ?? '').join('\n'), toolCalls: (Array.isArray(entry.message.content) ? entry.message.content : []).filter(block => block.type === 'toolCall').map(block => ({ id: block.id, name: block.name, arguments: block.arguments })) } : {}),
    ...(entry.message.role === 'toolResult' ? { toolCallId: entry.message.toolCallId, toolName: entry.message.toolName, isError: entry.message.isError === true } : {}),
  }));
}

/** Loopback-only HTTP surface, reached through the dashboard's same-origin proxy.
 * This is not a remotely deployable multiuser authentication service. */
export async function createPiService({ directory, roots, port = 0, executable = 'pi', makeRpc = options => new RpcOwner(options), sessionRoots = [], sinks = [] }) {
  if (!roots?.length) throw Error('Explicit workspace roots required');
  const allowed = await Promise.all(roots.map(root => realpath(root)));
  const media = createMediaStore();
  const catalog = new SessionCatalog(sessionRoots);
  // Legacy configurations predate sessionRoots. Read only PI's standard
  // same-user history location; never fall back to unbounded owner snapshots.
  const nativeHistory = new NativeHistoryReader(sessionRoots.length ? sessionRoots : [path.join(homedir(), '.pi', 'agent', 'sessions')]);
  await catalog.refresh();
  const owners = await createOwnerServer(directory), workers = new Map(), streams = new Set();
  let pendingCreations = 0, stopping = false;
  const liveTexts = new Map(), names = new Map(), liveThinking = new Map(), liveTools = new Map();
  // Extension point: `sinks` observe every stream envelope (auditing, forwarding).
  const log = createEventLog({ sinks });
  const normalizer = createPiEventNormalizer(log, { flushMs: 100 });
  const recordEvent = ({ sessionId, event }) => {
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') liveTexts.set(sessionId, ((liveTexts.get(sessionId) ?? '') + event.assistantMessageEvent.delta).slice(-100000));
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'thinking_delta') liveThinking.set(sessionId, ((liveThinking.get(sessionId) ?? '') + event.assistantMessageEvent.delta).slice(-12000));
    if (event.type === 'tool_execution_start') {
      const tools = liveTools.get(sessionId) ?? new Map();
      tools.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, arguments: event.args, started: Date.now(), status: 'running' }); liveTools.set(sessionId, tools);
    }
    if (event.type === 'tool_execution_end') {
      const tool = liveTools.get(sessionId)?.get(event.toolCallId);
      if (tool) { tool.status = event.isError ? 'failed' : 'completed'; tool.durationMs = Date.now() - tool.started; }
    }
    if (event.type === 'message_end') { liveTexts.delete(sessionId); liveThinking.delete(sessionId); }
    if (event.type === 'agent_settled') { liveTexts.delete(sessionId); liveThinking.delete(sessionId); liveTools.delete(sessionId); }
    try { normalizer.handle(sessionId, event); } catch { /* Oversized/invalid native event never breaks the owner. */ }
    if (['message_end', 'agent_settled', 'session_info_changed'].includes(event.type)) trackEntries(sessionId);
  };
  // Bounded last successful remote page per connected session. Never used for
  // mutations or as evidence that an owner is idle/available.
  const remotePages = new Map();
  const children = new Set();
  const list = () => {
    const live = [...owners.list(), ...[...workers.values()].map(worker => ({ id: worker.id, cwd: worker.cwd, name: 'PI · browser session', owner: 'rpc', features: ['image-prompt-v1'], connected: !worker.closed }))];
    const active = new Set(live.map(session => session.id));
    return [...live.map(session => ({ ...session, name: names.get(session.id) ?? session.name })), ...catalog.list().filter(session => !active.has(session.nativeId))];
  };
  const broadcast = value => {
    const bytes = `data: ${JSON.stringify(value)}\n\n`;
    for (const response of streams) { if (response.writableLength > 1024 * 1024) response.destroy(); else response.write(bytes); }
  };
  owners.events.on('change', () => broadcast({ type: 'sessions', sessions: list() }));
  log.subscribe(envelope => broadcast({ type: 'stream', envelope }));
  owners.events.on('event', value => { recordEvent(value); broadcast(value); });
  const liveState = id => ({ liveText: (liveTexts.get(id) ?? '').slice(-12000), liveThinking: (liveThinking.get(id) ?? '').slice(-12000), liveTools: [...(liveTools.get(id)?.values() ?? [])].slice(-12).map(tool => ({ ...tool, arguments: JSON.stringify(tool.arguments ?? {}).slice(0, 2000) })) });
  // Bounded latest/older page. The stream position and live state are captured
  // together BEFORE the snapshot: every later event is then delivered on top of
  // the page. Entries already in the page merge idempotently by id; nothing that
  // happens while the snapshot is in flight can be skipped.
  // Context figures (see sessionUsage). Connectors started before this feature do
  // not report usage; their session file is read once per few seconds instead.
  const contextWindows = createContextWindows();
  const usageFallback = new Map();
  async function withContext(id, nativeOwner, page, before) {
    if (before) return {}; // Older pages carry no session figures.
    let usage = page.usage;
    if (!usage && nativeOwner) {
      const hit = usageFallback.get(id);
      if (hit && Date.now() - hit.at < 5000) usage = hit.usage;
      else {
        usage = (await nativeHistory.page(id, nativeOwner.cwd).catch(() => null))?.usage;
        usageFallback.set(id, { at: Date.now(), usage });
        while (usageFallback.size > 64) usageFallback.delete(usageFallback.keys().next().value);
      }
    }
    if (!usage) return {};
    const contextWindow = await contextWindows.resolve(usage.model);
    return { usage: { ...usage, contextWindow, percent: usage.tokens != null && contextWindow ? Math.min(100, usage.tokens / contextWindow * 100) : null } };
  }
  async function remotePage(id, before) {
    const worker = workers.get(id), nativeOwner = owners.list().find(owner => owner.id === id);
    normalizer.flush(id);
    const live = liveState(id), stream = log.head(id);
    let page;
    if (!worker && nativeOwner && !nativeOwner.features.includes('history-page-v1')) {
      page = await nativeHistory.page(id, nativeOwner.cwd, before);
      if (!page) throw Error('Legacy history unavailable; full snapshot refused to preserve active owner');
      page = { ...page, busy: true, busyUnknown: true, readOnly: false };
    } else if (!worker && nativeOwner) page = await owners.command(id, 'snapshot-page', { before });
    else {
      const snapshot = id.startsWith('disk_') ? catalog.snapshot(id) : worker ? await worker.snapshot() : await owners.command(id, 'snapshot');
      page = { ...historyPage(snapshot.entries, snapshot.leafId, before), busy: snapshot.busy, readOnly: snapshot.readOnly, dialogs: snapshot.dialogs ?? [] };
    }
    const { sessionFile, ...visible } = page;
    return { ...visible, ...(await withContext(id, nativeOwner, page, before)), ...live, stream };
  }
  // Durable entries become bounded stream events. The agent stays the source
  // of truth: this reads its latest bounded page and emits only what is new.
  // Clients merge by message id, so an overlapping tail is harmless.
  const tracked = new Map();
  const tracker = id => {
    let state = tracked.get(id);
    if (!state) { state = { last: undefined, timer: undefined, running: false, again: false, failures: 0 }; tracked.set(id, state); while (tracked.size > 128) tracked.delete(tracked.keys().next().value); }
    return state;
  };
  const baseline = (id, last) => { const state = tracker(id); if (!state.last && last) state.last = last; };
  const trackEntries = id => {
    const state = tracker(id);
    if (state.timer) return;
    state.timer = setTimeout(async () => {
      state.timer = undefined;
      if (state.running) { state.again = true; return; }
      state.running = true;
      try {
        const page = await remotePage(id);
        const messages = page.messages ?? [], newest = messages.at(-1)?.id;
        // No baseline (tracker evicted, or no page served since start): a client
        // view could be older than this page, so it reloads one bounded page.
        if (!state.last) { state.last = newest; log.append(id, 'history.reset', { reason: 'baseline' }); }
        else if (newest !== state.last) {
          const index = messages.findIndex(message => message.id === state.last);
          const fresh = index < 0 ? undefined : messages.slice(index + 1);
          // Branch moved, cursor left the page or too many entries: one bounded
          // page reload is correct, a partial delta would silently skip history.
          if (!fresh || fresh.length > 8) log.append(id, 'history.reset', { reason: 'gap' });
          else for (const message of fresh) {
            try { log.append(id, 'entry.appended', { message: fitMessage(message) }); }
            catch { log.append(id, 'history.reset', { reason: 'oversized' }); break; }
          }
          state.last = newest;
        }
        // Context figures follow the stream: send them only when they changed.
        const usageKey = page.usage ? JSON.stringify(page.usage) : undefined;
        if (usageKey && usageKey !== state.usageKey) { state.usageKey = usageKey; log.append(id, 'usage.update', { usage: page.usage }); }
        state.failures = 0;
      } catch {
        // Owner briefly unavailable: bounded retry, then a reset so clients
        // reload one bounded page instead of silently missing the entry.
        if (++state.failures <= 3) state.again = true;
        else { state.failures = 0; log.append(id, 'history.reset', { reason: 'unavailable' }); }
      }
      finally { state.running = false; if (state.again) { state.again = false; trackEntries(id); } }
    }, state.failures ? 1000 : 150);
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
    const json = (status, data) => { res.writeHead(status); res.end(JSON.stringify(data)); };
    try {
      if (stopping) return json(503, { error: 'PI adapter shutting down' });
      const host = `127.0.0.1:${server.address().port}`;
      if (req.headers.host !== host || req.headers.origin && req.headers.origin !== `http://${host}` || req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return json(403, { error: 'Origin refused' });
      if (!['GET', 'POST'].includes(req.method)) return json(405, { error: 'Method refused' });
      if (req.method === 'POST' && (req.headers.origin !== `http://${host}` || req.headers['x-hayate-webui'] !== '1' || !req.headers['content-type']?.startsWith('application/json'))) return json(403, { error: 'Same-origin JSON required' });
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname === '/api/pi/events' && req.method === 'GET') {
        if (streams.size >= 32) return json(503, { error: 'Too many streams' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ type: 'sessions', sessions: list() })}\n\n`);
        streams.add(res); const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000);
        res.on('close', () => { streams.delete(res); clearInterval(heartbeat); }); return;
      }
      if (url.pathname === '/api/pi/sessions' && req.method === 'GET') {
        await catalog.refresh(); return json(200, { sessions: list(), roots: allowed });
      }
      let body = {};
      if (req.method === 'POST') {
        let text = '';
        for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 128 * 1024) return json(413, { error: 'Request too large' }); }
        body = JSON.parse(text);
      }
      if (url.pathname === '/api/pi/sessions' && req.method === 'POST') {
        if (children.size + pendingCreations >= 8) return json(409, { error: 'PI worker limit reached' });
        pendingCreations++;
        try {
        if (typeof body.cwd !== 'string') return json(400, { error: 'Choose a workspace' });
        const cwd = await realpath(body.cwd);
        if (!allowed.some(root => cwd === root || !path.relative(root, cwd).startsWith('..') && !path.isAbsolute(path.relative(root, cwd)))) return json(403, { error: 'Workspace outside allowed roots' });
        if (stopping) return json(503, { error: 'PI adapter shutting down' });
        const worker = makeRpc({ cwd, executable });
        children.add(worker); worker.once('exit', () => children.delete(worker));
        try { await worker.ready(); } catch (error) { await worker.close(); throw error; }
        if (!worker.id || workers.has(worker.id) || owners.list().some(owner => owner.id === worker.id)) { await worker.close(); throw Error('Duplicate PI owner'); }
        workers.set(worker.id, worker);
        worker.on('event', event => { recordEvent({ sessionId: worker.id, event }); broadcast({ sessionId: worker.id, event }); });
        worker.once('exit', () => { workers.delete(worker.id); broadcast({ type: 'sessions', sessions: list() }); });
        broadcast({ type: 'sessions', sessions: list() }); return json(201, { id: worker.id });
        } finally { pendingCreations--; }
      }
      const match = /^\/api\/pi\/sessions\/([a-zA-Z0-9_-]{1,128})(?:\/(prompt|abort|snapshot|dialog|release|rename|fork|media|changes|image))?$/.exec(url.pathname);
      if (!match) return json(404, { error: 'Unknown PI route' });
      const [, id, action = 'snapshot'] = match, worker = workers.get(id);
      if (req.method === 'POST' && action === 'media') {
        if (!worker && !owners.list().some(owner => owner.id === id && owner.features.includes('image-prompt-v1'))) return json(409, { error: 'Reload this PI connector to enable image messages' });
        const result = media.chunk(id, body);
        if (result.id) {
          try { await verifyDecodedImage(media.get(id, result.id)); }
          catch { media.remove(id, result.id); return json(400, { error: 'Image is corrupt, animated or exceeds the 16 megapixel limit' }); }
        }
        return json(200, result);
      }
      if (req.method === 'GET' && action === 'image') {
        // Bounded lazy read of one image block. Source of truth stays the session entries.
        try {
          // Never snapshot a live worker/owner for an image: that moves the whole session over its
          // bounded RPC pipe. Read the persisted session file read-only instead.
          const nativeOwner = owners.list().find(owner => owner.id === id), live = workers.get(id);
          const entries = id.startsWith('disk_') ? catalog.snapshot(id).entries : live || nativeOwner ? await nativeHistory.entries(id, (live ?? nativeOwner).cwd) : null;
          if (!entries) return json(404, { error: 'Session history unavailable' });
          res.setHeader('Cache-Control', 'private, no-store');
          return json(200, imageChunk(entries, url.searchParams.get('message') ?? '', Number(url.searchParams.get('index') ?? 0), Number(url.searchParams.get('offset') ?? 0)));
        } catch (error) { return json(error.status ?? 500, { error: error.status ? error.message : 'Image unavailable' }); }
      }
      if (req.method === 'GET' && action === 'changes') {
        // HTTP fallback for the streaming channel: same envelopes, bounded.
        const since = Number(url.searchParams.get('since') ?? 0);
        const epoch = url.searchParams.get('epoch') || undefined;
        normalizer.flush(id);
        return json(200, log.since(id, since, { epoch, limit: 128 }));
      }
      if (req.method === 'GET' && action === 'snapshot') {
        const remote = url.searchParams.get('view') === 'remote';
        const cursor = url.searchParams.get('before') || '';
        const pageKey = JSON.stringify([id, cursor]);
        const replyPage = data => {
          remotePages.delete(pageKey);
          remotePages.set(pageKey, data);
          while (remotePages.size > 16) remotePages.delete(remotePages.keys().next().value);
          return json(200, data);
        };
        try {
        if (remote) {
          const page = await remotePage(id, cursor || undefined);
          if (!cursor) baseline(id, page.messages?.at(-1)?.id);
          if (!cursor) return replyPage(page);
          // A closed page (cursor X) holds only ancestors of X. Session entries
          // are append-only with immutable parent links, so its content depends
          // on (session, X) alone and has a stable ETag. Browsers keep it but
          // revalidate each use (authorization always applies); unchanged = 304.
          const closed = { messages: page.messages, before: page.before, historyTruncated: page.historyTruncated, immutable: true };
          const etag = '"' + createHash('sha256').update(JSON.stringify(closed)).digest('base64url') + '"';
          res.setHeader('Cache-Control', 'private, no-cache'); res.setHeader('ETag', etag);
          remotePages.delete(pageKey); remotePages.set(pageKey, closed);
          while (remotePages.size > 16) remotePages.delete(remotePages.keys().next().value);
          if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
          return json(200, closed);
        }
        const snapshot = id.startsWith('disk_') ? catalog.snapshot(id) : worker ? await worker.snapshot() : await owners.command(id, 'snapshot');
        const messages = projectEntries(snapshot.entries, snapshot.leafId);
        return json(200, { ...snapshot, liveText: liveTexts.get(id) ?? '', messages });
        } catch (error) {
          if (error?.message === 'History cursor changed; reload conversation') return json(409, { error: error.message });
          const retained = remote && remotePages.get(pageKey);
          if (!retained) throw error;
          res.setHeader('Cache-Control', 'no-store');
          return json(200, { ...retained, immutable: false, stale: true, readOnly: true, busy: undefined, dialogs: [], liveText: '', liveThinking: '', liveTools: [], connectionState: 'interrupted' });
        }
      }
      if (req.method === 'GET' && action === 'fork') {
        const source = list().find(session => session.id === id);
        if (!source) return json(404, { error: 'Session unavailable' });
        if (id.startsWith('disk_')) return json(200, { eligible: false, reason: 'Attach the original session before forking' });
        const snapshot = worker ? await worker.snapshot() : await owners.command(id, 'snapshot');
        const reason = snapshot.busy || worker?.releasing
          ? 'Wait for the original session to become idle before forking'
          : typeof snapshot.sessionFile !== 'string'
            ? 'Reload the connector in the original PI terminal with native /reload, then retry Fork. Restarting the gateway alone does not update a running PI extension.' : null;
        return json(200, { eligible: !reason, reason });
      }
      if (req.method === 'POST' && action === 'fork') {
        if (id.startsWith('disk_')) return json(409, { error: 'Attach the original session before forking' });
        if (children.size + pendingCreations >= 8) return json(409, { error: 'PI worker limit reached' });
        pendingCreations++;
        try {
          const source = list().find(session => session.id === id);
          if (!source) return json(404, { error: 'Session unavailable' });
          const snapshot = worker ? await worker.snapshot() : await owners.command(id, 'snapshot');
          if (snapshot.busy || worker?.releasing) return json(409, { error: 'Wait for the original session to become idle before forking' });
          if (typeof snapshot.sessionFile !== 'string') return json(409, { error: 'Reload the connector in the original PI terminal with native /reload, then retry Fork' });
          const cwd = await realpath(source.cwd);
          if (!allowed.some(root => cwd === root || !path.relative(root, cwd).startsWith('..') && !path.isAbsolute(path.relative(root, cwd)))) return json(403, { error: 'Workspace outside allowed roots' });
          const fork = makeRpc({ cwd, executable, forkFrom: snapshot.sessionFile });
          children.add(fork); fork.once('exit', () => children.delete(fork));
          try { await fork.ready(); if (!fork.id || fork.id === id || workers.has(fork.id) || owners.list().some(owner => owner.id === fork.id)) throw Error('Native fork did not create an independent session'); }
          catch (error) { await fork.close(); throw error; }
          workers.set(fork.id, fork);
          fork.on('event', event => { recordEvent({ sessionId: fork.id, event }); broadcast({ sessionId: fork.id, event }); });
          fork.once('exit', () => { workers.delete(fork.id); broadcast({ type: 'sessions', sessions: list() }); });
          names.set(fork.id, `${source.name} · Fork`);
          broadcast({ type: 'sessions', sessions: list() }); return json(201, { id: fork.id, title: `${source.name} · Fork` });
        } finally { pendingCreations--; }
      }
      if (id.startsWith('disk_') && req.method !== 'GET') return json(409, { error: 'Read-only disk session: attach a live owner before writing' });
      if (req.method === 'POST' && action === 'rename') {
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 300) return json(400, { error: 'Choose a session name (1–300 characters)' });
        if (worker?.releasing) return json(409, { error: 'Session release in progress' });
        const name = body.name.trim();
        if (worker) await worker.command('set_session_name', { name });
        else await owners.command(id, 'rename', { name });
        names.set(id, name); broadcast({ type: 'sessions', sessions: list() });
        return json(200, { renamed: true, name });
      }
      if (req.method === 'POST' && action === 'release') {
        if (!worker) return json(409, { error: 'Only adapter-owned RPC sessions can be released' });
        if (worker.releasing) return json(409, { error: 'Session release already in progress' });
        worker.releasing = true;
        try {
          const state = await worker.command('get_state');
          if (state.isStreaming || state.isCompacting || state.pendingMessageCount || worker.busy) return json(409, { error: 'Session busy: stop or wait before releasing' });
          if (typeof state.sessionFile !== 'string') return json(409, { error: 'PI has not persisted this session yet' });
          const persistedFile = await stat(state.sessionFile);
          if (!persistedFile.isFile() || persistedFile.size === 0) return json(409, { error: 'Session has no persisted conversation yet' });
          await worker.close();
          if (workers.get(id) === worker) workers.delete(id);
          broadcast({ type: 'sessions', sessions: list() });
          return json(200, { released: true, cwd: worker.cwd, executable, args: ['--session', state.sessionFile], note: 'RPC owner exited. Resume once in a native console; do not start multiple writers.' });
        } finally { worker.releasing = false; }
      }
      if (worker?.releasing && req.method === 'POST') return json(409, { error: 'Session ownership release in progress' });
      if (req.method === 'POST' && action === 'dialog') {
        if (!worker || typeof body.id !== 'string' || !body.answer || typeof body.answer !== 'object') return json(409, { error: 'Only pending RPC dialogs accept responses; TUI dialogs stay with their owner' });
        return json(200, worker.respondToDialog(body.id, body.answer));
      }
      if (req.method !== 'POST' || !['prompt', 'abort'].includes(action)) return json(405, { error: 'Method refused' });
      if (action === 'prompt' && body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.length > 4 || body.attachments.some(item => !item || typeof item.id !== 'string'))) return json(400, { error: 'Invalid image attachments' });
      if (action === 'prompt' && (typeof body.text !== 'string' || (!body.text.trim() && !body.attachments?.length) || body.text.length > 100000 || body.text.trimStart().startsWith('/') && body.text.trim() !== '/reload' || body.mode !== undefined && !['steer', 'followUp'].includes(body.mode))) return json(400, { error: 'Invalid prompt or delivery mode; use native controls for slash commands' });
      if (action === 'prompt' && body.text.trim() === '/reload' && body.attachments?.length) return json(400, { error: 'Reload cannot include images; remove or keep them for a normal message' });
      if (action === 'prompt' && body.text.trim() === '/reload') {
        if (worker) return json(409, { error: 'Reload currently requires a native TUI owner' });
        if (!owners.list().find(owner => owner.id === id)?.features?.includes('reload-v1')) return json(409, { error: 'Connected PI uses an older connector; reload once in its terminal or start a new native session to enable WebUI reload' });
        return json(200, await owners.command(id, 'reload'));
      }
            const images = validatePromptImages(action === 'prompt' && body.attachments?.length ? body.attachments.map(attachment => media.get(id, attachment.id)) : []);
      if (images.length > 4) return json(400, { error: 'At most four images' });
      if (images.length && !worker && !owners.list().some(owner => owner.id === id && owner.features.includes('image-prompt-v1'))) return json(409, { error: 'Reload this PI connector to enable image messages' });
      const result = worker ? await worker.command(action, action === 'prompt' ? { message: body.text, ...(images.length ? { images } : {}), ...(body.mode ? { streamingBehavior: body.mode } : {}) } : {}) : await owners.command(id, action, action === 'prompt' ? { text: body.text, ...(body.mode ? { mode: body.mode } : {}), ...(images.length ? { images } : {}) } : body);
      json(200, result ?? {});
    } catch (error) {
      // Do not log native data, paths, prompts or arbitrary exception messages.
      const reason = ['PI owner rejected command', 'PI disconnected; command outcome may be unknown', 'PI command timed out; outcome unknown; do not automatically retry'].includes(error?.message) ? error.message : error?.name ?? 'Error';
      console.error('PI request failed:', reason);
      if (!res.headersSent) json(409, { error: 'PI operation failed or acceptance unknown; not automatically retried' }); else res.destroy();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, owners, async stop() {
    stopping = true;
    for (const stream of streams) stream.destroy();
    const closed = new Promise(resolve => server.close(resolve));
    const results = await Promise.allSettled([...children].map(worker => worker.close()));
    await closed;
    // Keep the private owner socket alive when a child could still be writing.
    // Shutdown failure is explicit; a later stop can retry after actual exit.
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'PI workers have not exited; ownership retained');
    await owners.close();
  } };
}
