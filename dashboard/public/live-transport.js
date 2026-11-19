/** Exactly one update source: WebSocket, or conditional HTTP fallback.
 * Receives invalidations (`changed`) and, when available, streaming deltas
 * (`event`, stream-delta-v1) passed to `onEvent` without any HTTP read.
 * Mutations never enter its retry path.
 */
export function createLiveTransport({ socketURL, revisionURL, onChange, onEvent, onAck, onClose = () => {}, onState = () => {}, WebSocketClass = WebSocket, fetcher = fetch, timers = globalThis, pollMs = 10000, retryMs = 15000 }) {
 let socket, pollTimer, retryTimer, connectTimer, generation = 0, stopped = true, controller, revision;
 let mode = 'stopped', polling = false, refreshing = false, dirty = false;
 async function changed(event) {
  if (refreshing) { dirty = true; return; }
  refreshing = true;
  try { do { dirty = false; if (!stopped) await onChange(event); } while (dirty && !stopped); }
  finally { refreshing = false; }
 }
 const state = next => { mode = next; onState(next); };
 const cancelPoll = () => { if (pollTimer !== undefined) timers.clearTimeout(pollTimer); pollTimer = undefined; controller?.abort(); };
 async function poll(connectionGeneration) {
  if (stopped || mode !== 'fallback' || polling || connectionGeneration !== generation) return;
  polling = true; controller = new AbortController();
  try {
   const response = await fetcher(revisionURL, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', headers: revision ? { 'If-None-Match': revision } : {}, signal: controller.signal });
   if (response.status === 401 || response.status === 403) { stop(); onState('unauthorized'); return; }
   if (response.status !== 304 && !response.ok) throw Error('Revision request failed');
   if (stopped || mode !== 'fallback' || connectionGeneration !== generation) return;
   const next = response.headers.get('etag');
   if (response.status !== 304 && (!next || next !== revision)) {
    await changed({ transport: 'fallback', signal: controller.signal });
    if (!stopped && mode === 'fallback' && connectionGeneration === generation) revision = next;
   }
  } catch (error) { if (error.name !== 'AbortError' && !stopped) onState('fallback-error'); }
  finally {
   polling = false;
   if (!stopped && mode === 'fallback') {
    const activeGeneration = generation;
    pollTimer = timers.setTimeout(() => poll(activeGeneration), activeGeneration === connectionGeneration ? pollMs : 0);
   }
  }
 }
 function fallback(connectionGeneration) {
  if (connectTimer !== undefined) timers.clearTimeout(connectTimer); connectTimer = undefined;
  if (stopped || connectionGeneration !== generation) return;
  state('fallback'); cancelPoll(); void poll(connectionGeneration);
  if (retryTimer === undefined) retryTimer = timers.setTimeout(() => { retryTimer = undefined; connect(); }, retryMs);
 }
 function connect() {
  if (stopped) return;
  const connectionGeneration = ++generation;
  cancelPoll(); socket?.close();
  if (retryTimer !== undefined) timers.clearTimeout(retryTimer); retryTimer = undefined;
  state('connecting');
  connectTimer = timers.setTimeout(() => { if (connectionGeneration === generation && mode === 'connecting') { socket?.close(); fallback(connectionGeneration); } }, 5000);
  try { socket = new WebSocketClass(socketURL, 'hayate.workspace.v1'); }
  catch { fallback(connectionGeneration); return; }
  socket.onopen = () => {
   if (stopped || connectionGeneration !== generation) return;
   if (connectTimer !== undefined) timers.clearTimeout(connectTimer); connectTimer = undefined;
   cancelPoll(); state('websocket');
   // A reconnect requires one bounded GET resynchronization, never a mutation.
   void Promise.resolve(changed({ transport: 'websocket', resync: true })).catch(() => onState('resync-error'));
  };
  socket.onmessage = event => {
   if (stopped || connectionGeneration !== generation || mode !== 'websocket') return;
   let frame; try { frame = JSON.parse(event.data); } catch { socket.close(1008); return; }
   if (frame.type === 'ack' && onAck && typeof frame.opId === 'string') { try { onAck(frame); } catch { onState('ack-error'); } return; }
   if (frame.type === 'event' && onEvent && frame.envelope && typeof frame.agentId === 'string') { try { onEvent(frame); } catch { onState('event-error'); } return; }
   if (frame.type !== 'changed' || typeof frame.revision !== 'string') return;
   if (frame.revision === revision) return;
   revision = frame.revision;
   void Promise.resolve(changed({ transport: 'websocket', revision })).catch(() => onState('read-error'));
  };
  socket.onerror = () => { if (connectionGeneration === generation) socket.close(); };
  socket.onclose = event => {
   if (connectionGeneration === generation) onClose();
   if (stopped || connectionGeneration !== generation) return;
   if (event?.code === 4003) { stop(); onState('unauthorized'); } else fallback(connectionGeneration);
  };
 }
 function stop() { stopped = true; onClose(); generation++; if (connectTimer !== undefined) timers.clearTimeout(connectTimer); connectTimer = undefined; cancelPoll(); if (retryTimer !== undefined) timers.clearTimeout(retryTimer); retryTimer = undefined; socket?.close(); state('stopped'); }
 // Sends one command frame on a healthy socket. `false` means: use the POST
 // fallback (same opId, same server ledger).
 function command(frame) {
  if (stopped || mode !== 'websocket' || socket?.readyState !== 1 || socket.bufferedAmount > 262144) return false;
  let text; try { text = JSON.stringify(frame); } catch { return false; }
  // Larger than the server frame limit: POST instead of a socket close.
  if (new TextEncoder().encode(text).length > 90 * 1024) return false;
  try { socket.send(text); return true; } catch { return false; }
 }
 return { start() { if (!stopped) return; stopped = false; connect(); }, stop, command, get mode() { return mode; } };
}
