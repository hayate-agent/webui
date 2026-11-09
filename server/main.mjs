import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
let stopping, refreshing;
const digest = value => createHash('sha256').update(value.key).update(value.cert).digest('hex');
let tlsDigest = tls ? digest(tls) : undefined;
const timer = tls ? setInterval(() => {
  if (stopping || refreshing) return;
  refreshing = (async () => {
    const value = { key: await readFile(process.env.HAYATE_TLS_KEY_FILE), cert: await readFile(process.env.HAYATE_TLS_CERT_FILE) };
    const next = digest(value); if (next !== tlsDigest && !stopping) { dashboard.reloadTLS(value); tlsDigest = next; }
  })().catch(() => console.error('Dashboard TLS reload failed; retaining existing listener')).finally(() => { refreshing = undefined; });
}, 30000) : undefined;
timer?.unref();
const stop = () => { if (stopping) return; clearInterval(timer); stopping = (async () => { await refreshing; await dashboard.stop(); process.exitCode = 0; })(); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
