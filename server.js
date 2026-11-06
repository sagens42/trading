#!/usr/bin/env node
/*
 * Serve the BTC option odds page and proxy Bybit's public market API.
 * Use this when the browser can't call api.bybit.com directly (CORS or network).
 *   node server.js               # then open http://localhost:8000
 *   node server.js --port 9000
 * Only GET /bybit/v5/market/... is forwarded; no API keys are involved.
 * Needs Node 18+ (built-in fetch), no dependencies.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, 'web');
const ALLOWED_HOSTS = new Set(['api.bybit.com', 'api.bytick.com', 'api.bybit.nl', 'api.bybit.eu', 'api.bybit-tr.com', 'api.bybitglobal.com']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function proxy(req, res, url) {
  const apiPath = url.pathname.slice('/bybit'.length);
  if (!/^\/v5\/market\/[a-z-]+$/.test(apiPath)) return send(res, 404, 'Not found');
  const host = url.searchParams.get('host') || 'api.bybit.com';
  if (!ALLOWED_HOSTS.has(host)) return send(res, 400, 'host not allowed');
  url.searchParams.delete('host');
  try {
    const r = await fetch(`https://${host}${apiPath}?${url.searchParams}`, {
      headers: { 'User-Agent': 'btc-option-odds/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    send(res, r.status, Buffer.from(await r.arrayBuffer()), 'application/json');
  } catch (e) {
    send(res, 502, 'Upstream error: ' + (e.cause?.message || e.message));
  }
}

function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad path'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(WEB, path.normalize(rel));
  if (!file.startsWith(WEB + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/bybit/')) return proxy(req, res, url);
  serveStatic(req, res, url);
});

const port = +arg('port', 8000), host = arg('host', '127.0.0.1');
server.listen(port, host, () => {
  console.log(`Serving on http://${host}:${port}  (demo: http://${host}:${port}/?demo=1)`);
});
