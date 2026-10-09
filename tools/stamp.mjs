#!/usr/bin/env node
// Stamps the service worker for a deploy: rewrites the `// <stamp>` ... `// </stamp>` block in
// app/sw.js with
//   VERSION = first 10 hex chars of sha256(paths + contents of every deployed file), and
//   FILES   = sorted relative URLs of every file under app/ (except sw.js, dotfiles and the files
//             the service worker caches on first use instead: LAZY), plus './'.
// The repo keeps sw.js in dev mode (VERSION '__BUILD__', FILES []); CI stamps before uploading.
//
//   node tools/stamp.mjs              stamp app/sw.js in place (idempotent)
//   node tools/stamp.mjs --check      dry run (alias --dry-run): print what would be written
//   node tools/stamp.mjs --reset      put the block back to dev mode
//   node tools/stamp.mjs --root DIR   operate on another copy of the app (default: app/)
//
// Deterministic across OSes: paths use '/', sorting is by UTF-16 code unit, and CRLF is
// normalised to LF in text files before hashing (so a Windows checkout hashes like CI).

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW_FILE = 'sw.js';
const DEV_VERSION = '__BUILD__';
// Deployed but not precached: the service worker fetches them when first used (see OCR_CACHE in sw.js).
const LAZY = ['vendor/ocr/'];
const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt', '.md', '.xml']);
const IGNORED_NAMES = new Set(['Thumbs.db', 'desktop.ini']);
// opening line (kept verbatim) / generated body / closing line
const BLOCK_RE = /(^[ \t]*\/\/[ \t]*<stamp>[^\r\n]*(\r?\n))([\s\S]*?)(^[ \t]*\/\/[ \t]*<\/stamp>)/m;

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Relative paths ('/'-separated) of all deployable files under rootDir, sorted. */
export async function listFiles(rootDir) {
  const out = [];
  async function walk(dir, prefix) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      // upload-pages-artifact drops dotfiles, so they must not be precached either.
      if (entry.name.startsWith('.') || IGNORED_NAMES.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      const stat = entry.isSymbolicLink() ? await fs.stat(abs) : entry;
      if (stat.isDirectory()) await walk(abs, rel);
      else if (stat.isFile() && rel !== SW_FILE) out.push(rel);
    }
  }
  await walk(rootDir, '');
  return out.sort(byCodeUnit);
}

function hashableContent(rel, buf) {
  if (!TEXT_EXTENSIONS.has(path.extname(rel).toLowerCase())) return buf;
  return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

const toUrl = (rel) => `./${rel.split('/').map(encodeURIComponent).join('/')}`;

function devBody(eol) {
  return `const VERSION = '${DEV_VERSION}';${eol}const FILES = [];${eol}`;
}

function renderBody({ version, files }, eol) {
  if (version === DEV_VERSION) return devBody(eol);
  const lines = [`const VERSION = '${version}';`, 'const FILES = ['];
  for (const url of files) lines.push(`  ${JSON.stringify(url)},`);
  lines.push('];');
  return lines.join(eol) + eol;
}

function findBlock(source, swPath) {
  const count = (source.match(new RegExp(BLOCK_RE.source, 'gm')) ?? []).length;
  if (count !== 1) throw new Error(`${swPath}: expected exactly one "// <stamp>" ... "// </stamp>" block, found ${count}`);
  return BLOCK_RE.exec(source);
}

/** Replace the stamp block body in a service-worker source. `stamp` null = dev mode. */
export function applyStamp(source, stamp, swPath = SW_FILE) {
  const match = findBlock(source, swPath);
  const eol = match[2];
  const body = stamp ? renderBody(stamp, eol) : devBody(eol);
  return source.slice(0, match.index) + match[1] + body + match[4] + source.slice(match.index + match[0].length);
}

/** Compute { version, files } for the app in rootDir (does not modify anything). */
export async function computeStamp(rootDir = path.join(ROOT, 'app')) {
  const rels = await listFiles(rootDir);
  const hash = createHash('sha256');
  for (const rel of rels) {
    hash.update(`${rel}\0`);
    hash.update(hashableContent(rel, await fs.readFile(path.join(rootDir, rel))));
    hash.update('\0');
  }
  // sw.js itself (with its stamp block reset) so service-worker logic changes bump VERSION too.
  const sw = await fs.readFile(path.join(rootDir, SW_FILE), 'utf8');
  hash.update(`${SW_FILE}\0`);
  hash.update(applyStamp(sw, null).replace(/\r\n/g, '\n'));
  return {
    version: hash.digest('hex').slice(0, 10),
    files: ['./', ...rels.filter((rel) => !LAZY.some((dir) => rel.startsWith(dir))).map(toUrl)].sort(byCodeUnit),
  };
}

function parseArgs(argv) {
  const opts = { dryRun: false, reset: false, root: path.join(ROOT, 'app') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check' || arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--reset') opts.reset = true;
    else if (arg === '--root') opts.root = path.resolve(argv[++i] ?? '');
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node tools/stamp.mjs [--check|--dry-run] [--reset] [--root <app dir>]');
    return;
  }
  const swPath = path.join(opts.root, SW_FILE);
  const shown = path.relative(process.cwd(), swPath) || swPath;
  const source = await fs.readFile(swPath, 'utf8');
  const stamp = opts.reset ? null : await computeStamp(opts.root);
  const next = applyStamp(source, stamp, shown);
  const body = findBlock(next, shown)[3];
  const summary = stamp ? `VERSION=${stamp.version}, ${stamp.files.length} files precached` : `dev mode (VERSION='${DEV_VERSION}', FILES=[])`;

  if (opts.dryRun) {
    console.log(`stamp --check: would write ${shown}: ${summary}`);
    console.log(body.trimEnd());
    console.log(next === source ? '(already up to date)' : '(dry run - no files were modified)');
    return;
  }
  if (next !== source) await fs.writeFile(swPath, next);
  console.log(`stamp: ${shown} ${next === source ? 'already' : 'now'} ${summary}`);
}

const isMain = (() => {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  try {
    const self = fileURLToPath(import.meta.url);
    const entry = path.resolve(process.argv[1] ?? '');
    return process.platform === 'win32' ? self.toLowerCase() === entry.toLowerCase() : self === entry;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error(`stamp failed: ${err?.message ?? err}`);
    process.exit(1);
  });
}
