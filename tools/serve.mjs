#!/usr/bin/env node
// Zero-dependency static file server for the PWA in app/.
//
// CLI:
//   node tools/serve.mjs [port] [--base Pantri] [--host 127.0.0.1] [--root app]
//     port    default 8080 (0 = pick a free port)
//     --base  serve the app under a sub-path, like GitHub Pages does
//             (--base Pantri -> http://localhost:8080/Pantri/), to catch
//             accidental absolute URLs. Leading/trailing slashes are optional (omit the
//             leading one in Git Bash, which rewrites "/x" arguments into Windows paths).
//     --host  default: all interfaces (so phones on the LAN can reach it)
//
// Programmatic (tests/tools):
//   import { startServer } from './tools/serve.mjs';
//   const { url, port, close } = await startServer();   // url = 'http://127.0.0.1:<port>/'
//   ...
//   await close();
//
// Behaviour: GET/HEAD only; `/` and any directory -> its index.html (a directory
// requested without a trailing slash is 301-redirected to add it, like GitHub
// Pages); path traversal (incl. encoded `..`, backslashes, symlinks escaping the
// root) -> 403; anything else missing -> 404. Every response has
// `Cache-Control: no-store` so edits always show up.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

const BASE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
});

/** Content-Type for a file path (falls back to application/octet-stream). */
export function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function normalizeBase(base) {
  let b = String(base || '/').trim();
  if (/^[A-Za-z]:[\\/]/.test(b) || b.includes('\\')) {
    // Git Bash (MSYS) rewrites arguments that start with '/' into Windows paths.
    throw new Error(
      `Invalid base "${b}" (looks like a file path; Git Bash converts arguments starting with "/"). ` +
        'Pass it without the leading slash, e.g. --base Pantri, or set MSYS_NO_PATHCONV=1.',
    );
  }
  if (!b.startsWith('/')) b = `/${b}`;
  if (!b.endsWith('/')) b = `${b}/`;
  return b;
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function statOrNull(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

function sendText(req, res, status, text, extraHeaders = {}) {
  const body = `${text}\n`;
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function createHandler({ rootDir, base, log }) {
  return async function handle(req, res) {
    const started = Date.now();
    if (log) {
      res.on('finish', () => {
        console.log(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started} ms)`);
      });
    }
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(req, res, 405, '405 Method Not Allowed', { Allow: 'GET, HEAD' });
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        sendText(req, res, 400, '400 Bad Request (malformed URL encoding)');
        return;
      }
      if (pathname.includes('\0')) {
        sendText(req, res, 400, '400 Bad Request');
        return;
      }

      // Optional sub-path mount (mirrors https://<user>.github.io/<repo>/).
      if (base !== '/') {
        if (pathname === '/' || `${pathname}/` === base) {
          res.writeHead(301, { ...BASE_HEADERS, Location: base + url.search });
          res.end();
          return;
        }
        if (!pathname.startsWith(base)) {
          sendText(req, res, 404, `404 Not Found (the app is served under ${base})`);
          return;
        }
        pathname = `/${pathname.slice(base.length)}`;
      }

      // path.join normalises `.`/`..` and (on Windows) backslashes; anything that
      // ends up outside the root is a traversal attempt.
      let filePath = path.join(rootDir, pathname);
      if (!isInside(filePath, rootDir)) {
        sendText(req, res, 403, '403 Forbidden');
        return;
      }

      let stat = await statOrNull(filePath);
      if (stat?.isDirectory()) {
        if (!url.pathname.endsWith('/')) {
          // Relative URLs inside index.html must resolve against the directory.
          res.writeHead(301, { ...BASE_HEADERS, Location: `${url.pathname}/${url.search}` });
          res.end();
          return;
        }
        filePath = path.join(filePath, 'index.html');
        stat = await statOrNull(filePath);
      }
      if (!stat?.isFile()) {
        sendText(req, res, 404, '404 Not Found');
        return;
      }

      // Refuse symlinks/junctions that point outside the root.
      const [realFile, realRoot] = await Promise.all([fsp.realpath(filePath), fsp.realpath(rootDir)]);
      if (!isInside(realFile, realRoot)) {
        sendText(req, res, 403, '403 Forbidden');
        return;
      }

      res.writeHead(200, {
        ...BASE_HEADERS,
        'Content-Type': contentTypeFor(filePath),
        'Content-Length': stat.size,
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch (err) {
      if (log) console.error(err);
      if (!res.headersSent) sendText(req, res, 500, '500 Internal Server Error');
      else res.destroy();
    }
  };
}

/**
 * Start the static server.
 * @param {object} [options]
 * @param {string} [options.root='app']  Directory to serve; relative paths resolve against the project root.
 * @param {number} [options.port=0]      0 = any free port.
 * @param {string|null} [options.host='127.0.0.1']  null = all interfaces (dual-stack).
 * @param {string} [options.base='/']    URL sub-path to mount the app under, e.g. '/Pantri/'.
 * @param {boolean} [options.log=false]  Log one line per request.
 * @returns {Promise<{url: string, port: number, rootDir: string, server: http.Server, close: () => Promise<void>}>}
 *   `url` always ends with '/' (it is the app's base URL).
 */
export async function startServer({ root = 'app', port = 0, host = '127.0.0.1', base = '/', log = false } = {}) {
  const rootDir = path.resolve(PROJECT_ROOT, root);
  const mount = normalizeBase(base);
  const server = http.createServer(createHandler({ rootDir, base: mount, log }));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host ?? undefined, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const actualPort = server.address().port;
  const urlHost = !host || host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  let closing = null;
  return {
    url: `http://${urlHost}:${actualPort}${mount}`,
    port: actualPort,
    rootDir,
    server,
    close() {
      closing ??= new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections?.();
      });
      return closing;
    },
  };
}

/** Non-internal IPv4 addresses of this machine (for "open on your phone" URLs). */
export function lanAddresses() {
  const out = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      const v4 = info.family === 'IPv4' || info.family === 4;
      if (v4 && !info.internal && !info.address.startsWith('169.254.')) out.push(info.address);
    }
  }
  return out;
}

function isMainModule() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  try {
    const self = fileURLToPath(import.meta.url);
    const entry = path.resolve(process.argv[1] ?? '');
    return process.platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
  } catch {
    return false;
  }
}

async function main(argv) {
  const opts = { root: 'app', port: 8080, host: null, base: '/', log: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${arg}`);
      return v;
    };
    if (arg === '--base') opts.base = value();
    else if (arg === '--host') opts.host = value();
    else if (arg === '--root') opts.root = value();
    else if (arg === '--quiet') opts.log = false;
    else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node tools/serve.mjs [port=8080] [--base Pantri] [--host <addr>] [--root app] [--quiet]');
      return;
    } else if (/^\d+$/.test(arg)) opts.port = Number(arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  let handle;
  try {
    handle = await startServer(opts);
  } catch (err) {
    if (err?.code === 'EADDRINUSE') {
      console.error(`Port ${opts.port} is already in use. Try: node tools/serve.mjs ${opts.port + 1}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const { port, rootDir } = handle;
  const mount = normalizeBase(opts.base);
  if (!fs.existsSync(rootDir)) console.warn(`Warning: ${rootDir} does not exist (yet); every request will 404.`);
  console.log(`Serving ${path.relative(process.cwd(), rootDir) || '.'} (Cache-Control: no-store)`);
  if (opts.host && opts.host !== '0.0.0.0' && opts.host !== '::') {
    console.log(`  Local:   ${handle.url}`);
  } else {
    console.log(`  Local:   http://localhost:${port}${mount}`);
    for (const ip of lanAddresses()) console.log(`  Network: http://${ip}:${port}${mount}`);
    console.log('  Note: the camera and service workers need a secure context. http://localhost is fine;');
    console.log('        plain-http LAN URLs are not, so scanning on a phone needs HTTPS (e.g. a tunnel).');
  }
  console.log('Press Ctrl+C to stop.');

  const stop = () => {
    handle.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (isMainModule()) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
