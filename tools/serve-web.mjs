/* Minimal static file server for the web build.
   The phone build is a plain static site, so this is only needed for local
   testing on a desktop browser (ES modules and service workers need a real
   http origin). Usage: node tools/serve-web.mjs [port] [root] */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const port = Number(process.argv[2] ?? 8081);
const root = resolve(process.argv[3] ?? join(process.cwd(), 'web', 'hkbus'));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const relative = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    const target = normalize(join(root, relative));

    if (!target.startsWith(root + sep) && target !== root) {
      response.writeHead(403).end('forbidden');
      return;
    }

    try {
      const info = await stat(target);
      if (!info.isFile()) throw new Error('not a file');
      const body = await readFile(target);
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'service-worker-allowed': '/',
      });
      response.end(body);
    } catch {
      // Single page app fallback.
      try {
        const body = await readFile(join(root, 'index.html'));
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(body);
      } catch {
        response.writeHead(404).end('not found');
      }
    }
  })();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${root} at http://127.0.0.1:${port}/`);
});
