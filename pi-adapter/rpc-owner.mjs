import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

/** A browser-created PI session has one RPC owner. Terminal clients must attach
 * through the adapter, not resume the same active file with a second PI. */
export class RpcOwner extends EventEmitter {
  pending = new Map();
  dialogs = new Map();
  constructor({ cwd, executable = 'pi', spawnProcess = spawn, sessionDir, forkFrom, shutdownTimeoutMs = 30000 }) {
    super();
    this.cwd = cwd;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve; });
    this.child = spawnProcess(executable, ['--mode', 'rpc', ...(sessionDir ? ['--session-dir', sessionDir] : []), ...(forkFrom ? ['--fork', forkFrom] : [])], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8'); let buffer = '';
    const consume = text => {
      buffer += text;
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { this.fail(); this.child.kill(); return; }
      let n;
      while ((n = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, n).replace(/\r$/, ''); buffer = buffer.slice(n + 1);
        let record;
        try { record = JSON.parse(line); } catch { this.fail(); this.child.kill(); return; }
        if (!record || typeof record !== 'object' || Array.isArray(record)) { this.fail(); this.child.kill(); return; }
        if (record.type === 'response') {
          const request = this.pending.get(record.id);
          if (!request) continue;
          clearTimeout(request.timer); this.pending.delete(record.id);
          if (!record.success && request.promptReservation && this.promptReservation === record.id) {
            this.promptReservation = undefined; this.busy = this.observedBusy === true;
          }
          if (record.success) request.resolve(record.data); else request.reject(Error('PI rejected command'));
        } else {
          if (record.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(record.method) && typeof record.id === 'string') {
            const dialog = { ...record, expiresAt: record.timeout ? Date.now() + record.timeout : undefined };
            this.dialogs.set(record.id, dialog);
          }
          if (record.type === 'agent_settled') this.dialogs.clear();
          if (record.type === 'agent_start') { this.observedBusy = true; this.busy = true; }
          if (record.type === 'agent_settled') { this.observedBusy = false; this.busy = false; this.promptReservation = undefined; }
          this.emit('event', record);
        }
      }
    };
    this.child.stdout.on('data', bytes => consume(decoder.write(bytes)));
    this.child.stdout.on('end', () => consume(decoder.end()));
    this.child.stderr.resume();
    const exited = () => {
      if (this.exited) return;
      this.exited = true; this.fail(); this.resolveExit(); this.emit('exit');
    };
    this.child.on('error', () => { this.fail(); if (!this.child.pid) exited(); });
    this.child.on('exit', exited);
    this.child.stdin.on('error', () => this.fail());
  }
  fail() {
    this.closed = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(Error('PI RPC disconnected; outcome may be unknown')); }
    this.pending.clear();
  }
  command(type, data = {}, timeout = 30000) {
    if (this.closed || this.closing || this.pending.size >= 32 || this.child.stdin.writableLength > 1024 * 1024) return Promise.reject(Error('PI RPC unavailable'));
    if (type === 'prompt' && !data.streamingBehavior && this.busy) return Promise.reject(Error('PI busy: choose steer or followUp explicitly'));
    // Reserve ownership immediately, before asynchronous provider events arrive.
    // Native RPC still enforces its own busy contract as a second boundary.
    const reserves = type === 'prompt' && !this.busy;
    const id = randomUUID();
    if (type === 'prompt') this.busy = true;
    if (reserves) this.promptReservation = id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error('PI RPC timed out; outcome unknown; do not retry automatically')); }, timeout);
      this.pending.set(id, { resolve, reject, timer, promptReservation: reserves });
      this.child.stdin.write(JSON.stringify({ ...data, id, type }) + '\n');
    });
  }
  async ready() {
    const state = await this.command('get_state');
    this.id = state.sessionId; this.busy = state.isStreaming || state.isCompacting; this.sessionFile = state.sessionFile;
    return state;
  }
  async snapshot() {
    const state = await this.command('get_state');
    const entries = await this.command('get_entries');
    this.observedBusy = state.isStreaming || state.isCompacting;
    this.busy = this.observedBusy || !!this.promptReservation;
    return { ...entries, busy: this.busy, sessionFile: state.sessionFile, dialogs: [...this.dialogs.values()].filter(dialog => !dialog.expiresAt || dialog.expiresAt > Date.now()) };
  }
  respondToDialog(id, answer) {
    const dialog = this.dialogs.get(id);
    if (!dialog || dialog.expiresAt && dialog.expiresAt <= Date.now() || this.closed || this.closing) throw Error('PI dialog expired or disconnected');
    const response = { type: 'extension_ui_response', id };
    if (answer.cancelled === true) response.cancelled = true;
    else if (dialog.method === 'confirm' && typeof answer.confirmed === 'boolean') response.confirmed = answer.confirmed;
    else if (['input', 'editor', 'select'].includes(dialog.method) && typeof answer.value === 'string' && answer.value.length <= 100000 && (dialog.method !== 'select' || dialog.options?.includes(answer.value))) response.value = answer.value;
    else throw Error('Invalid PI dialog response');
    if (this.child.stdin.writableLength > 1024 * 1024) throw Error('PI input busy');
    // First answer wins across browser/console clients. The RPC UI subprotocol
    // has no command acknowledgement; do not promise durable acceptance.
    this.dialogs.delete(id);
    this.child.stdin.write(JSON.stringify(response) + '\n');
    this.emit('event', { type: 'dialog_answered', id });
    return { submitted: true };
  }
  close() {
    if (this.exited) return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    // Channel failure does not imply process exit. Never release ownership on
    // timeout or kill a potentially persisting worker behind the user's back.
    if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.end();
    this.closePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.closePromise = undefined;
        reject(Error('PI shutdown timed out; owner retained until process exit'));
      }, this.shutdownTimeoutMs);
      this.exitPromise.then(() => { clearTimeout(timer); resolve(); });
    });
    return this.closePromise;
  }
}
