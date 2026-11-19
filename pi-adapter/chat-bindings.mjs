import { readFile, writeFile, rename } from 'node:fs/promises';
/** Only WebUI presentation bindings. Never touches native history or processes. */
export function chatBindings(file) {
 let queue = Promise.resolve();
 const read = async () => { try { const data = JSON.parse(await readFile(file, 'utf8')); if (data.version !== 1 || !data.sessions || typeof data.sessions !== 'object' || Array.isArray(data.sessions)) throw Error('Invalid chat bindings'); return data; } catch (error) { if (error.code === 'ENOENT') return { version: 1, sessions: {} }; throw error; } };
 return {
  async list() { await queue; return (await read()).sessions; },
  set(id, status) {
   if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !['active', 'closed', 'archived', 'deleted'].includes(status)) return Promise.reject(Error('Invalid chat binding'));
   const work = queue.then(async () => { const data = await read(); data.sessions[id] = { status }; await writeFile(file + '.tmp', JSON.stringify(data), { mode: 0o600 }); await rename(file + '.tmp', file); });
   queue = work.catch(() => {}); return work;
  },
 };
}
