import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPiService } from '../pi-adapter/service.mjs';
import { createDashboard } from '../server/server.mjs';
import { dashboardToolsFromEnvironment } from '../server/dashboard-config.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export async function startLocal(env = process.env) {
  if (!env.HAYATE_AGENT_URL) throw Error('Set HAYATE_AGENT_URL to your existing Hayate API. No backend address is guessed.');
  const roots = env.PI_WEBUI_ROOTS?.split('\n').filter(Boolean);
  if (!roots?.length) throw Error('Set PI_WEBUI_ROOTS to allowed absolute working directories (one per line).');
  for (const root of roots) {
    if (!path.isAbsolute(root) || !(await stat(await realpath(root))).isDirectory()) throw Error('Every PI_WEBUI_ROOTS entry must be an existing absolute directory');
  }
  await readFile(path.join(projectRoot, 'dist/public/app.js')).catch(() => { throw Error('Missing browser build. Run npm run build first.'); });
  const directory = env.PI_WEBUI_BRIDGE_DIR ?? path.join(homedir(), '.local/state/pi-webui');
  if (!path.isAbsolute(directory)) throw Error('PI_WEBUI_BRIDGE_DIR must be absolute');
  const port = Number(env.HAYATE_DASHBOARD_PORT ?? 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid HAYATE_DASHBOARD_PORT');
  const origin = `http://127.0.0.1:${port}`;
  const adapter = await createPiService({ directory, roots, port: env.PI_WEBUI_PORT === undefined ? 0 : Number(env.PI_WEBUI_PORT), executable: env.PI_WEBUI_EXECUTABLE ?? 'pi', sessionRoots: env.PI_WEBUI_SESSION_ROOTS?.split('\n').filter(Boolean) ?? [] });
  let dashboard;
  try {
    const tools = dashboardToolsFromEnvironment(env);
    if (tools.warning) console.warn(tools.warning);
    dashboard = await createDashboard({ origin, upstream: env.HAYATE_AGENT_URL, dashboardTools: tools.mode,
      piUpstream: `http://127.0.0.1:${adapter.server.address().port}`,
      upstreamOrigin: env.HAYATE_AGENT_ORIGIN, upstreamServername: env.HAYATE_AGENT_TLS_NAME,
      ca: env.HAYATE_AGENT_CA_FILE ? await readFile(env.HAYATE_AGENT_CA_FILE) : undefined,
    });
  } catch (error) { await adapter.stop(); throw error; }
  return { origin, adapterOrigin: `http://127.0.0.1:${adapter.server.address().port}`, directory, extension: path.join(projectRoot, 'pi-adapter/extension.mjs'), async stop() { await dashboard.stop(); await adapter.stop(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const local = await startLocal();
    console.log(`Unified WebUI: ${local.origin}\nPI console endpoint: ${local.adapterOrigin}\nPI connector directory: ${local.directory}\nPI extension: ${local.extension}\nNo existing PI process is changed automatically. See docs/LOCAL-START.md.`);
    let stopping;
    const stop = () => { stopping ??= local.stop().catch(error => { console.error(error.message); process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
