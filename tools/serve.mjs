/**
 * serve.mjs — the dev server. Zero dependencies, Node's stdlib only.
 *
 * This exists because the app is built from ES modules, and ES modules are
 * fetched with CORS semantics. Opening index.html straight off the disk gives
 * it a `file://` origin, which is opaque, so every import is blocked and the
 * page loads as a completely silent, completely dead shell. That failure looks
 * exactly like a broken app, so the fastest way to never hit it is to make
 * starting a server a single command.
 *
 *   node tools/serve.mjs           → http://localhost:8000
 *   node tools/serve.mjs 3000      → pick a port
 *   npm start                      → same thing
 *
 * Caching is deliberately disabled. Chrome caches ES modules aggressively, and
 * during development that means editing a file and reloading gets you the old
 * one — a genuinely expensive thing to debug because nothing looks wrong.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 8000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/index.html';

    // Resolve inside ROOT and refuse anything that escapes it. `..` in a URL is
    // normally collapsed by the browser, but nothing stops a raw HTTP client.
    const full = normalize(join(ROOT, path));
    if (full !== ROOT && !full.startsWith(ROOT + sep)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('403 outside project root\n');
    }

    const info = await stat(full);
    if (info.isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('404 not found\n');
    }

    const body = await readFile(full);
    res.writeHead(200, {
      'content-type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      // See the header comment: stale cached modules are a silent time sink.
      'cache-control': 'no-store, no-cache, must-revalidate',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (err) {
    const code = err && err.code === 'ENOENT' ? 404 : 500;
    res.writeHead(code, { 'content-type': 'text/plain' });
    res.end(`${code} ${code === 404 ? 'not found' : 'server error'}\n`);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Try another one:  node tools/serve.mjs ${PORT + 1}\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`\n  ENGINE SIM\n`);
  console.log(`  →  http://localhost:${PORT}\n`);
  console.log(`  serving ${ROOT}`);
  console.log(`  Ctrl-C to stop\n`);
});
