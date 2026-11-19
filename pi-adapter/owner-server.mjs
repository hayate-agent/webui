import net from 'node:net';
import { mkdir, lstat, chmod, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

/** Dedicated daemon boundary. Only the owning PI process executes commands.
 * Unix socket access grants agent control: require a private same-user directory.
 * No session file is opened for writing by this service. */
export async function createOwnerServer(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077) throw Error('PI bridge directory must be private and owned by current user');
  const socketPath = path.join(directory, 'owners.sock');
  const owners = new Map(), peers = new Set(), events = new EventEmitter();
  const server = net.createServer(peer => {
    peers.add(peer); peer.setEncoding('utf8');
    let buffer = '', owner;
    const timeout = setTimeout(() => peer.destroy(), 5000);
    peer.on('error', () => {});
    peer.on('data', chunk => {
      buffer += chunk;
      // Legacy connectors send the complete branch before HTTP pagination.
      // Keep a bounded compatibility allowance; new connectors compact remote snapshots.
      if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) return peer.destroy();
      let n;
      while ((n = buffer.indexOf('\n')) !== -1) {
        let record;
        try { record = JSON.parse(buffer.slice(0, n)); } catch { return peer.destroy(); }
        buffer = buffer.slice(n + 1);
        if (!record || typeof record !== 'object' || Array.isArray(record)) return peer.destroy();
        if (!owner) {
          if (record.type !== 'register' || typeof record.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(record.sessionId) || typeof record.cwd !== 'string' || !path.isAbsolute(record.cwd) || owners.has(record.sessionId)) return peer.destroy();
          clearTimeout(timeout);
          owner = { id: record.sessionId, cwd: record.cwd, name: typeof record.name === 'string' ? record.name.slice(0, 300) : 'PI session', features: Array.isArray(record.features) ? ['reload-v1', 'history-page-v1', 'image-prompt-v1'].filter(feature => record.features.includes(feature)) : [], pending: new Map(), peer };
          owners.set(owner.id, owner);
          peer.write(JSON.stringify({ type: 'registered' }) + '\n'); events.emit('change');
        } else if (record.type === 'response' && typeof record.id === 'string') {
          const request = owner.pending.get(record.id);
          if (!request) continue;
          clearTimeout(request.timer); owner.pending.delete(record.id);
          if (record.success === true) request.resolve(record.data);
          else request.reject(Error('PI owner rejected command'));
        } else if (record.type === 'event' && record.event && typeof record.event.type === 'string') {
          events.emit('event', { sessionId: owner.id, event: record.event });
        } else return peer.destroy();
      }
    });
    peer.on('close', () => {
      clearTimeout(timeout); peers.delete(peer);
      if (!owner) return;
      if (owners.get(owner.id) === owner) owners.delete(owner.id);
      for (const request of owner.pending.values()) { clearTimeout(request.timer); request.reject(Error('PI disconnected; command outcome may be unknown')); }
      owner.pending.clear(); events.emit('change');
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  const bound = await lstat(socketPath);
  return {
    events, socketPath,
    list: () => [...owners.values()].map(({ id, cwd, name, features }) => ({ id, cwd, name, features, owner: 'tui', connected: true })),
    command(sessionId, command, data = {}, timeoutMs = 30000) {
      const owner = owners.get(sessionId);
      if (!owner) return Promise.reject(Error('Session has no connected owner'));
      if (!['snapshot', 'snapshot-page', 'prompt', 'abort', 'rename', 'reload'].includes(command)) return Promise.reject(Error('Unsupported owner command'));
      // Read-only snapshots are identical for concurrent consumers. Coalesce
      // them rather than making a legacy connector queue multiple huge branches
      // (its socket backpressure guard can disconnect the native owner).
      if (command === 'snapshot' && owner.snapshotPending) return owner.snapshotPending;
      if (owner.pending.size >= 32 || owner.peer.writableLength > 1024 * 1024) return Promise.reject(Error('PI owner busy'));
      const id = randomUUID();
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { owner.pending.delete(id); reject(Error('PI command timed out; outcome unknown; do not automatically retry')); }, timeoutMs);
        owner.pending.set(id, { resolve, reject, timer });
        owner.peer.write(JSON.stringify({ type: 'command', id, command, data }) + '\n');
      });
      if (command === 'snapshot') {
        owner.snapshotPending = result;
        const clear = () => { if (owner.snapshotPending === result) owner.snapshotPending = undefined; };
        result.then(clear, clear);
      }
      return result;
    },
    async close() {
      const closed = new Promise(resolve => server.close(resolve));
      for (const peer of peers) peer.destroy();
      await closed;
      try { const now = await lstat(socketPath); if (now.ino === bound.ino && now.dev === bound.dev && now.isSocket()) await unlink(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
}
