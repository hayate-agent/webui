import readline from 'node:readline/promises';
import { loadConfig } from '../pi-adapter/config.mjs';
import { enrollRelay } from '../pi-adapter/relay-client.mjs';
const config = await loadConfig(process.argv[2]);
if (!config.relay) throw Error('Configure relay.endpoint and relay.stateFile in ~/.pi/webui.json first');
if (!process.stdin.isTTY) throw Error('Use an interactive terminal for the single-use pairing code');
const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
try {
 const code = await terminal.question('Single-use invitation from central Dashboard → Agents → outbound connection: ');
 const result = await enrollRelay({ ...config.relay, code: code.trim(), name: 'Local PI' });
 console.log(`Enrolled ${result.id}. Approve this connection in the central dashboard, then restart the user service.`);
} finally { terminal.close(); }
