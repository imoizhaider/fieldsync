// Static server for dist/. It serves the app under a sub-path (/fieldsync/ by
// default), the same shape as a GitHub Pages project site, so sub-path hosting
// is exercised every time the tests run.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { ROOT } from './env.mjs';

const DIST = resolve(ROOT, 'dist');
const PORT = Number(process.env.PORT ?? 4173);
const BASE = (process.env.BASE_PATH ?? '/fieldsync/').replace(/\/?$/, '/');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === BASE.slice(0, -1) || (BASE !== '/' && url.pathname === '/')) {
    res.writeHead(302, { Location: BASE });
    res.end();
    return;
  }
  if (!url.pathname.startsWith(BASE)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  let rel = normalize(decodeURIComponent(url.pathname.slice(BASE.length))).replace(/^(\.\.[/\\])+/, '');
  if (rel === '' || rel === '.' || rel.endsWith('/') || rel.endsWith('\\')) rel = join(rel, 'index.html');
  const file = join(DIST, rel);
  try {
    if (!file.startsWith(DIST) || !(await stat(file)).isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => console.log(`serve: http://localhost:${PORT}${BASE}`));
