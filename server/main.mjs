import { readFile } from 'node:fs/promises';
import { createDashboard } from './server.mjs';
const origin = process.env.HAYATE_DASHBOARD_ORIGIN ?? 'http://127.0.0.1:3210';
const upstream = process.env.HAYATE_AGENT_URL;
if (!upstream) throw Error('Set HAYATE_AGENT_URL to the existing agent API origin');
const tls = origin.startsWith('https:') ? {
  key: await readFile(process.env.HAYATE_TLS_KEY_FILE), cert: await readFile(process.env.HAYATE_TLS_CERT_FILE),
} : undefined;
const dashboard = await createDashboard({ origin, upstream, tls,
  host: process.env.HAYATE_DASHBOARD_HOST ?? '127.0.0.1',
  upstreamServername: process.env.HAYATE_AGENT_TLS_NAME,
  upstreamOrigin: process.env.HAYATE_AGENT_ORIGIN,
  port: process.env.HAYATE_DASHBOARD_PORT ? Number(process.env.HAYATE_DASHBOARD_PORT) : undefined,
  ca: process.env.HAYATE_AGENT_CA_FILE ? await readFile(process.env.HAYATE_AGENT_CA_FILE) : undefined,
});
console.log('Hayate dashboard listening at ' + origin);
let stopping;
const stop = () => { stopping ??= dashboard.stop().then(() => { process.exitCode = 0; }); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
