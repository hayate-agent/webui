import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
export const defaultConfigPath = () => path.join(homedir(), '.pi', 'webui.json');
export async function loadConfig(file = defaultConfigPath()) {
 const config = JSON.parse(await readFile(file, 'utf8'));
 const allowed = ['version', 'hayateUrl', 'port', 'adapterPort', 'roots', 'sessionRoots', 'bridgeDir', 'piExecutable', 'hayateOrigin', 'tlsName', 'caFile', 'relay'];
 if (!config || config.version !== 1) throw Error('webui.json requires version: 1');
 for (const key of Object.keys(config)) if (!allowed.includes(key)) throw Error(`Unknown webui.json setting: ${key}`);
 const url = new URL(config.hayateUrl);
 if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Invalid hayateUrl (no embedded credentials)');
 for (const key of ['roots', 'sessionRoots']) {
  if (key === 'sessionRoots' && config[key] === undefined) continue;
  if (!Array.isArray(config[key]) || (key === 'roots' && !config[key].length) || config[key].some(p => typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\n'))) throw Error(`${key} must contain absolute directories`);
 }
 for (const key of ['port', 'adapterPort']) if (config[key] !== undefined && (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > 65535)) throw Error(`Invalid ${key}`);
 for (const key of ['bridgeDir', 'piExecutable', 'caFile']) if (config[key] !== undefined && (typeof config[key] !== 'string' || !path.isAbsolute(config[key]))) throw Error(`${key} must be absolute`);
 if (config.relay !== undefined) {
  if (!config.relay || typeof config.relay !== 'object' || Array.isArray(config.relay) || Object.keys(config.relay).some(key => !['endpoint', 'stateFile'].includes(key))) throw Error('Invalid relay config');
  const relayURL = new URL(config.relay.endpoint);
  if (relayURL.protocol !== 'https:' || relayURL.origin !== config.relay.endpoint || typeof config.relay.stateFile !== 'string' || !path.isAbsolute(config.relay.stateFile)) throw Error('Relay requires canonical HTTPS endpoint and absolute stateFile');
 }
 return { ...config, port: config.port ?? 3210, adapterPort: config.adapterPort ?? 3211, bridgeDir: config.bridgeDir ?? path.join(homedir(), '.pi', 'webui-runtime') };
}
export function configEnvironment(c) {
 return { HAYATE_AGENT_URL: c.hayateUrl, HAYATE_DASHBOARD_PORT: String(c.port), PI_WEBUI_PORT: String(c.adapterPort), PI_WEBUI_ROOTS: c.roots.join('\n'), PI_WEBUI_SESSION_ROOTS: c.sessionRoots?.join('\n'), PI_WEBUI_BRIDGE_DIR: c.bridgeDir, PI_WEBUI_EXECUTABLE: c.piExecutable, HAYATE_AGENT_ORIGIN: c.hayateOrigin, HAYATE_AGENT_TLS_NAME: c.tlsName, HAYATE_AGENT_CA_FILE: c.caFile };
}
