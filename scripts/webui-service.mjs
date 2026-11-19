import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadConfig, configEnvironment, defaultConfigPath } from '../pi-adapter/config.mjs';
import { startRelayClient } from '../pi-adapter/relay-client.mjs';
import { startLocal } from './start-local.mjs';
const label = 'net.hayate.pi-webui';
const script = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function servicePlist({ config, logs, node = process.execPath }) {
 return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${[node, script, 'run', config].map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path.dirname(node))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer>
<key>StandardOutPath</key><string>${xml(path.join(logs, 'stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, 'stderr.log'))}</string>
</dict></plist>\n`;
}
export function serviceUnit({ config, node = process.execPath }) {
 const quote = value => '"' + String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$').replaceAll('\n', '\\n').replaceAll('\r', '\\r') + '"';
 return `[Unit]\nDescription=Hayate PI WebUI gateway\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${[node, script, 'run', config].map(quote).join(' ')}\nRestart=on-failure\nRestartSec=15\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}
function systemctl(args, tolerateMissing = false) {
 const result = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
 if (result.status !== 0 && !tolerateMissing) throw Error(result.stderr || result.error?.message || 'systemctl failed');
 return result.stdout;
}
function launchctl(args, tolerateMissing = false) {
 const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
 if (result.status !== 0 && !tolerateMissing) throw Error(result.stderr || result.error?.message || 'launchctl failed');
 return result.stdout;
}
export async function main(action = 'status', file = defaultConfigPath()) {
 file = path.resolve(file);
 const domain = `gui/${process.getuid()}`, target = `${domain}/${label}`;
 const plist = path.join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
 const logs = path.join(homedir(), '.pi/webui-logs');
 if (action === 'run') {
  const config = await loadConfig(file);
  const local = await startLocal(configEnvironment(config));
  let relay;
  try { if (config.relay) relay = await startRelayClient({ ...config.relay, adapterOrigin: local.adapterOrigin }); }
  catch (error) { await local.stop(); throw error; }
  console.log(`PI WebUI listening at ${local.origin}; adapter ${local.adapterOrigin}; central relay ${relay ? 'configured' : 'not configured'}`);
  let stopping;
  const stop = () => { stopping ??= (async () => { await relay?.stop(); await local.stop(); })().catch(error => { console.error(error.message); process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop); return;
 }
 if (action === 'check') { await loadConfig(file); console.log(`Configuration valid: ${file}`); return; }
 if (process.platform === 'linux') {
  const unit = path.join(homedir(), '.config/systemd/user', `${label}.service`);
  const name = `${label}.service`;
  if (action === 'install') {
   await loadConfig(file); await mkdir(path.dirname(unit), { recursive: true, mode: 0o700 });
   await writeFile(unit, serviceUnit({ config: file }), { flag: 'wx', mode: 0o600 });
   systemctl(['daemon-reload']); systemctl(['enable', '--now', name]);
   console.log(`Installed user service. Logs: journalctl --user -u ${name}`);
  } else if (action === 'status') console.log(systemctl(['show', name, '--property=ActiveState,SubState,MainPID,Result']));
  else if (['start', 'stop', 'restart'].includes(action)) { if (action !== 'stop') await loadConfig(file); systemctl([action, name]); }
  else if (action === 'uninstall') { systemctl(['disable', '--now', name], true); await unlink(unit); systemctl(['daemon-reload']); }
  else throw Error('Actions: check, install, status, restart, stop, start, uninstall');
  return;
 }
 if (process.platform !== 'darwin') throw Error('Managed services support macOS launchd and Linux systemd; use service run for foreground execution');
 if (action === 'install') {
  await loadConfig(file);
  await mkdir(path.dirname(plist), { recursive: true }); await mkdir(logs, { recursive: true, mode: 0o700 });
  // Exclusive creation: never replace an existing service definition implicitly.
  await writeFile(plist, servicePlist({ config: file, logs }), { flag: 'wx', mode: 0o600 });
  launchctl(['bootstrap', domain, plist]); console.log(`Installed login service. Config: ${file}\nLogs: ${logs}`);
 } else if (action === 'status') {
  const status = launchctl(['print', target]);
  // launchctl prints inherited credentials too: expose lifecycle fields only.
  console.log(status.split('\n').filter(line => /^\s*(state|pid|runs|last exit code|path|stdout path|stderr path) = /.test(line)).join('\n'));
 }
 else if (action === 'restart') { await loadConfig(file); launchctl(['kill', 'SIGTERM', target]); }
 else if (action === 'stop') launchctl(['bootout', domain, plist]);
 else if (action === 'start') launchctl(['bootstrap', domain, plist]);
 else if (action === 'uninstall') { launchctl(['bootout', domain, plist], true); await unlink(plist); }
 else throw Error('Actions: check, install, status, restart, stop, start, uninstall');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2], process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
