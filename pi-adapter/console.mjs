import readline from 'node:readline';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

/** Terminal client to the SAME owner (RPC or TUI). It never opens a session file. */
export async function attachConsole({ origin = 'http://127.0.0.1:3211', sessionId, input = process.stdin, output = process.stdout, signal }) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password.length > 0 || url.pathname !== '/' || url.search || url.hash) throw Error('Console requires loopback PI adapter origin');
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId ?? '')) throw Error('Choose a valid session ID');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const request = async (route, body) => {
    const response = await fetch(new URL(route, origin), { signal: controller.signal, ...(body ? { method: 'POST', headers: { origin: url.origin, 'content-type': 'application/json', 'x-hayate-webui': '1' }, body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw Error('PI operation failed; acceptance may be unknown; no automatic retry');
    return response.json();
  };
  const dialogs = new Map();
  const showDialog = dialog => {
    if (!['select', 'confirm', 'input', 'editor'].includes(dialog.method)) return;
    dialogs.set(dialog.id, dialog);
    output.write(`\n[PI question ${dialog.id}] ${dialog.title ?? dialog.method}\n${dialog.message ?? ''}\n`);
    if (dialog.options) output.write(dialog.options.map((option, index) => `${index + 1}. ${option}`).join('\n') + '\n');
    output.write(`/answer ${dialog.id} VALUE (${dialog.method === 'confirm' ? 'yes or no' : dialog.method === 'select' ? 'option number' : 'text'}), or /cancel ${dialog.id}\n`);
  };
  const snapshot = await request(`/api/pi/sessions/${sessionId}`);
  for (const dialog of snapshot.dialogs ?? []) showDialog(dialog);
  for (const message of snapshot.messages) output.write(`\n[${message.role}] ${message.text}\n`);
  output.write('\nAttached to existing PI owner. /stop, /steer TEXT, /followup TEXT, /quit\n');
  const events = await fetch(new URL('/api/pi/events', origin), { signal: controller.signal });
  if (!events.ok) throw Error('PI event stream unavailable');
  const pump = (async () => {
    const decoder = new TextDecoder(); let buffer = '';
    for await (const bytes of events.body) {
      buffer += decoder.decode(bytes, { stream: true });
      if (buffer.length > 16 * 1024 * 1024) throw Error('Event record too large');
      let n;
      while ((n = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, n); buffer = buffer.slice(n + 2);
        const line = frame.split('\n').find(line => line.startsWith('data: '));
        if (!line) continue;
        const value = JSON.parse(line.slice(6));
        if (value.sessionId !== sessionId) continue;
        const event = value.event;
        if (event?.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') output.write(event.assistantMessageEvent.delta);
        if (event?.type === 'agent_settled') output.write('\n[PI idle]\n');
        if (event?.type === 'extension_ui_request') showDialog(event);
        if (event?.type === 'dialog_answered') dialogs.delete(event.id);
        if (event?.type === 'ui_prompt_start') output.write('\n[Answer TUI question in owning native terminal]\n');
      }
    }
  })();
  const lines = readline.createInterface({ input, terminal: false });
  let tail = Promise.resolve();
  lines.on('line', line => {
    tail = tail.then(async () => {
      if (!line.trim()) return;
      if (line === '/quit') { lines.close(); return; }
      if (line === '/stop') { await request(`/api/pi/sessions/${sessionId}/abort`, {}); return; }
      const answer = /^\/(answer|cancel)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(line);
      if (answer) {
        const dialog = dialogs.get(answer[2]);
        if (!dialog) throw Error('Question no longer pending; refresh or wait for current question');
        let response;
        if (answer[1] === 'cancel') response = { cancelled: true };
        else if (dialog.method === 'confirm') {
          if (!['yes', 'no'].includes(answer[3])) throw Error('Answer yes or no explicitly');
          response = { confirmed: answer[3] === 'yes' };
        } else if (dialog.method === 'select') {
          const index = Number(answer[3]) - 1;
          if (!Number.isInteger(index) || !dialog.options?.[index]) throw Error('Choose a listed option number');
          response = { value: dialog.options[index] };
        } else response = { value: answer[3] ?? '' };
        await request(`/api/pi/sessions/${sessionId}/dialog`, { id: dialog.id, answer: response });
        dialogs.delete(dialog.id); return;
      }
      const match = /^\/(steer|followup)\s+([\s\S]+)$/.exec(line);
      await request(`/api/pi/sessions/${sessionId}/prompt`, match ? { text: match[2], mode: match[1] === 'steer' ? 'steer' : 'followUp' } : { text: line });
    }).catch(error => output.write(`\n${error.message}\n`));
  });
  try { await Promise.race([once(lines, 'close'), pump]); await tail; }
  finally { lines.close(); controller.abort(); signal?.removeEventListener('abort', abort); await pump.catch(() => {}); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origin = process.env.PI_WEBUI_ADAPTER_URL ?? 'http://127.0.0.1:3211';
  if (!process.argv[2] || process.argv[2] === 'list') {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw Error('Loopback adapter required');
    const response = await fetch(new URL('/api/pi/sessions', origin));
    if (!response.ok) throw Error('PI adapter unavailable');
    for (const session of (await response.json()).sessions) console.log(`${session.id}\t${session.owner}\t${session.cwd}\t${session.name}`);
  } else await attachConsole({ origin, sessionId: process.argv[2] });
}
