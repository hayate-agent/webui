import { createServer as httpServer, request as httpRequest } from 'node:http';
import { createServer as httpsServer, request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const assetRoot = fileURLToPath(new URL('../dist/public/', import.meta.url));
const canonical = value => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Canonical origin required');
  return url;
};
const loopback = host => ['127.0.0.1', '[::1]', 'localhost'].includes(host);

/** Standalone presentation process. All projects, work and credentials remain on
 * the configured agent API. No Core imports, secret vault or agent runtime. */
export async function createDashboard({ origin, upstream, host = '127.0.0.1', port, tls, upstreamServername, upstreamOrigin, ca, assets = assetRoot }) {
  const publicURL = canonical(origin), backend = canonical(upstream);
  const apiOrigin = canonical(upstreamOrigin ?? upstream);
  if (publicURL.protocol === 'https:' && !tls || publicURL.protocol === 'http:' && (!loopback(host) || !loopback(publicURL.hostname))) throw Error('Network dashboard requires TLS');
  if (backend.protocol !== 'https:' && !loopback(backend.hostname)) throw Error('Remote backend requires HTTPS');
  const sockets = new Set(), requests = new Set(); let closing = false;
  const handle = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const refuse = status => { res.writeHead(status); res.end(); };
    if (closing) return refuse(503);
    if (req.headers.host !== publicURL.host) return refuse(403);
    if (req.headers.origin && req.headers.origin !== publicURL.origin) return refuse(403);
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return refuse(403);
    const url = new URL(req.url, publicURL);
    if (url.pathname.startsWith('/api/')) {
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) return refuse(405);
      const machine = req.method === 'POST' && ['/api/agent-link/v1/enroll', '/api/agent-link/v1/leave'].includes(url.pathname)
        && !req.headers.origin && !req.headers.cookie && !req.headers['sec-fetch-site'];
      if (req.method !== 'GET' && !machine && (req.headers.origin !== publicURL.origin || req.headers['x-hayate-webui'] !== '1')) return refuse(403);
      const headers = { host: apiOrigin.host };
      for (const name of ['content-type', 'content-length', 'cookie', 'origin', 'x-hayate-webui', 'sec-fetch-site', 'last-event-id']) if (req.headers[name]) headers[name] = req.headers[name];
      if (machine && req.headers.authorization) headers.authorization = req.headers.authorization;
      if (headers.origin) headers.origin = apiOrigin.origin;
      const request = backend.protocol === 'https:' ? httpsRequest : httpRequest;
      const remote = request(new URL(url.pathname + url.search, backend), { method: req.method, headers, agent: false, ca, servername: upstreamServername ?? apiOrigin.hostname }, response => {
        if (response.headers['content-type']?.startsWith('text/event-stream')) remote.setTimeout(0);
        for (const name of ['content-type', 'cache-control', 'set-cookie']) if (response.headers[name]) res.setHeader(name, response.headers[name]);
        res.writeHead(response.statusCode); response.on('error', () => res.destroy()); response.pipe(res);
      });
      requests.add(remote); remote.once('close', () => requests.delete(remote));
      remote.setTimeout(45000, () => remote.destroy());
      remote.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('{"error":"Agent API unavailable; no request automatically retried"}'); } else res.destroy(); });
      res.once('close', () => remote.destroy()); req.once('aborted', () => remote.destroy());
      req.pipe(remote); return;
    }
    if (req.method !== 'GET') return refuse(405);
    const file = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] }[url.pathname];
    if (!file) return refuse(404);
    try { const bytes = await readFile(path.join(assets, file[0])); res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` }); res.end(bytes); }
    catch { refuse(503); }
  };
  const server = tls ? httpsServer({ ...tls, minVersion: 'TLSv1.2' }, (req, res) => { void handle(req, res).catch(() => res.destroy()); }) : httpServer((req, res) => { void handle(req, res).catch(() => res.destroy()); });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  let upgrades = 0;
  server.on('upgrade', (req, socket, head) => {
    if (closing || upgrades >= 32 || req.method !== 'GET' || req.url !== '/api/agent-link/v1/connect'
      || req.headers.host !== publicURL.host || req.headers.origin || req.headers.cookie || req.headers['sec-fetch-site']
      || req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || !/^[A-Za-z0-9+/]{22}==$/.test(req.headers['sec-websocket-key'] ?? '')
      || !/^Bearer [A-Za-z0-9_-]{43}$/.test(req.headers.authorization ?? '')
      || !/^[a-f0-9-]{36}$/.test(req.headers['x-hayate-agent-id'] ?? '') || req.headers['sec-websocket-protocol'] !== 'hayate.agent-link.v1') { socket.destroy(); return; }
    upgrades++; let upstream;
    const remote = (backend.protocol === 'https:' ? httpsRequest : httpRequest)(new URL(req.url, backend), {
      agent: false, ca, servername: upstreamServername ?? apiOrigin.hostname,
      headers: { host: apiOrigin.host, connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-key': req.headers['sec-websocket-key'], 'sec-websocket-version': req.headers['sec-websocket-version'],
        'sec-websocket-protocol': 'hayate.agent-link.v1', authorization: req.headers.authorization, 'x-hayate-agent-id': req.headers['x-hayate-agent-id'] },
    });
    requests.add(remote); remote.once('close', () => requests.delete(remote));
    const timer = setTimeout(() => { remote.destroy(); socket.destroy(); }, 10000);
    remote.on('upgrade', (response, connection, initial) => {
      clearTimeout(timer); upstream = connection;
      if (closing || socket.destroyed || response.statusCode !== 101 || response.headers['sec-websocket-protocol'] !== 'hayate.agent-link.v1') { connection.destroy(); socket.destroy(); return; }
      sockets.add(connection); connection.once('close', () => sockets.delete(connection));
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ' + response.headers['sec-websocket-accept'] + '\r\nSec-WebSocket-Protocol: hayate.agent-link.v1\r\n\r\n');
      if (head.length) connection.write(head); if (initial.length) socket.write(initial);
      connection.on('error', () => socket.destroy()); connection.on('close', () => socket.destroy()); socket.on('error', () => connection.destroy());
      connection.pipe(socket); socket.pipe(connection);
    });
    remote.on('response', response => { response.resume(); clearTimeout(timer); socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); });
    remote.on('error', () => { clearTimeout(timer); socket.destroy(); });
    socket.once('close', () => { clearTimeout(timer); upgrades--; remote.destroy(); upstream?.destroy(); });
    remote.end();
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port ?? Number(publicURL.port || (tls ? 443 : 80)), host, resolve); });
  return { server, reloadTLS(value) { if (closing || !server.setSecureContext) throw Error('TLS listener unavailable'); server.setSecureContext({ ...value, minVersion: 'TLSv1.2' }); }, async stop() { closing = true; const closed = new Promise(resolve => server.close(resolve)); for (const request of requests) request.destroy(); for (const socket of sockets) socket.destroy(); await closed; } };
}
