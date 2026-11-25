import net from 'node:net';
import { validatePromptImages } from './media.mjs';
import { historyPage } from './history-page.mjs';
import { OPENUI_GUIDE } from './openui-guide.mjs';

// A session counts as shown in the WebUI while the bridge is connected, plus a grace period so a gateway
// restart does not flip the system prompt (and lose the prompt cache) twice.
export const GUIDE_GRACE_MS = 5 * 60 * 1000;
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function connectorDirectory(env = process.env, configFile = path.join(homedir(), '.pi/webui.json')) {
  if (env.PI_WEBUI_BRIDGE_DIR) return env.PI_WEBUI_BRIDGE_DIR;
  try {
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    if (config.version !== 1) return;
    return config.bridgeDir ?? path.join(homedir(), '.pi/webui-runtime');
  } catch { return; }
}

/** Thin connector only: the adapter daemon is a separate process. Reads the
 * user service config; PI_WEBUI_BRIDGE_DIR remains available for isolated tests. */
export default function piWebUIConnector(pi) {
  let socket, retry, active = false, context, promptReserved = false, connected = false, lastConnected = 0;
  pi.registerCommand('webui-reload-runtime', {
    description: 'Reload the native PI runtime from the authenticated WebUI bridge',
    handler: async (_args, ctx) => { await ctx.reload(); },
  });
  const send = record => {
    if (!socket || socket.destroyed) return;
    if (socket.writableLength > 8 * 1024 * 1024) { socket.destroy(); return; }
    socket.write(JSON.stringify(record) + '\n');
  };
  pi.on('session_start', (_event, ctx) => {
    const directory = connectorDirectory();
    if (!directory || ctx.mode !== 'tui') return;
    context = ctx; active = true;
    const connect = () => {
      if (!active) return;
      try {
        const info = lstatSync(directory);
        if (!path.isAbsolute(directory) || !info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077) throw Error('Unsafe bridge directory');
      } catch { retry = setTimeout(connect, 5000); return; }
      const peer = net.createConnection(path.join(directory, 'owners.sock'));
      socket = peer; peer.setEncoding('utf8'); let buffer = '';
      peer.on('connect', () => { connected = true; lastConnected = Date.now(); });
      peer.on('connect', () => send({ type: 'register', sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, name: ctx.sessionManager.getSessionName(), features: ['reload-v1', 'history-page-v1', 'image-prompt-v1', 'history-images-v1'] }));
      peer.on('error', () => {});
      peer.on('close', () => { if (socket === peer) { socket = undefined; if (connected) lastConnected = Date.now(); connected = false; } if (active) retry = setTimeout(connect, 5000); });
      peer.on('data', chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) return peer.destroy();
        let n;
        while ((n = buffer.indexOf('\n')) !== -1) {
          let record;
          try { record = JSON.parse(buffer.slice(0, n)); } catch { peer.destroy(); return; }
          buffer = buffer.slice(n + 1);
          if (!record || typeof record !== 'object' || Array.isArray(record)) { peer.destroy(); return; }
          if (record.type === 'registered') continue;
          if (record.type !== 'command' || typeof record.id !== 'string') { peer.destroy(); return; }
          void Promise.resolve().then(async () => {
            const { command, data = {} } = record;
            if (command === 'snapshot-page') return { ...historyPage(ctx.sessionManager.getBranch(), ctx.sessionManager.getLeafId(), data.before), busy: !ctx.isIdle(), sessionFile: ctx.sessionManager.getSessionFile?.() };
            if (command === 'snapshot') return { entries: ctx.sessionManager.getBranch(), busy: !ctx.isIdle(), leafId: ctx.sessionManager.getLeafId(), sessionFile: ctx.sessionManager.getSessionFile?.() };
            if (command === 'reload') {
              if (!ctx.isIdle() || promptReserved) throw Error('Reload requires an idle session');
              promptReserved = true;
              // Ack means admitted, not completed. The native command owns reload.
              setTimeout(() => {
                try { pi.sendUserMessage('/webui-reload-runtime', { expandPromptTemplates: true }); }
                catch { promptReserved = false; send({ type: 'event', event: { type: 'webui_reload_failed' } }); }
              }, 25);
              return { accepted: true, operation: 'reload', completion: 'reconnect-required' };
            }
            if (command === 'abort') { await ctx.abort(); return { requested: true }; }
            if (command === 'rename' && typeof data.name === 'string' && data.name.length <= 300) { pi.setSessionName(data.name); return {}; }
            if (command === 'prompt' && typeof data.text === 'string' && (data.text.trim() || data.images?.length) && data.text.length <= 100000) {
              if (data.mode !== undefined && !['steer', 'followUp'].includes(data.mode)) throw Error('Invalid delivery mode');
              if ((!ctx.isIdle() || promptReserved) && !data.mode) throw Error('Busy: choose steer or followUp explicitly');
              // Slash commands can replace the session or open terminal UI. Do not
              // pretend they have ordinary model-message semantics.
              if (data.text.trimStart().startsWith('/')) throw Error('Use native PI controls for slash commands');
              const images = validatePromptImages(data.images);
              const content = images.length ? [...(data.text.trim() ? [{ type: 'text', text: data.text }] : []), ...images] : data.text;
              const previousReservation = promptReserved;
              promptReserved = true;
              try { pi.sendUserMessage(content, { ...(data.mode ? { deliverAs: data.mode } : {}), expandPromptTemplates: true }); }
              catch (error) { promptReserved = previousReservation; throw error; }
              return { accepted: true };
            }
            throw Error('Unsupported command');
          }).then(data => { if (socket === peer) send({ type: 'response', id: record.id, success: true, data }); }, () => { if (socket === peer) send({ type: 'response', id: record.id, success: false }); });
        }
      });
    };
    connect();
  });
  // Tell the agent the WebUI renders ```openui blocks. Only while this session is connected to the
  // WebUI (otherwise the block would show as plain code), and never twice in one prompt.
  pi.on('before_agent_start', event => {
    const shown = active && (connected || lastConnected > 0 && Date.now() - lastConnected < GUIDE_GRACE_MS);
    if (!shown || typeof event?.systemPrompt !== 'string' || event.systemPrompt.includes(OPENUI_GUIDE)) return;
    return { systemPrompt: event.systemPrompt + '\n\n<webui_openui>\n' + OPENUI_GUIDE + '\n</webui_openui>' };
  });
  for (const name of ['agent_start', 'agent_settled', 'message_start', 'message_update', 'message_end', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'session_info_changed', 'ui_prompt_start', 'ui_prompt_end']) {
    pi.on(name, event => { if (name === 'agent_settled') promptReserved = false; if (active && context) send({ type: 'event', event }); });
  }
  pi.on('session_shutdown', () => { active = false; connected = false; lastConnected = 0; promptReserved = false; clearTimeout(retry); socket?.destroy(); socket = undefined; context = undefined; });
}
