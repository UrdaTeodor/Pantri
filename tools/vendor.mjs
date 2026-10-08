#!/usr/bin/env node
// Copies / bundles the browser dependencies from node_modules into app/vendor/
// so the app runs with no build step and no CDN. Re-runnable: app/vendor/ is
// wiped and regenerated each time. Run after `npm install` or a dependency bump:
//
//   npm run vendor
//
// Outputs (all referenced with relative URLs by the app):
//   app/vendor/preact.module.js      preact core (ESM)
//   app/vendor/hooks.module.js       preact/hooks (ESM; imports the bare specifier "preact",
//                                    resolved by the import map in index.html)
//   app/vendor/htm.module.js         htm (ESM)
//   app/vendor/barcode-detector.js   barcode-detector *ponyfill* + zxing-wasm reader glue,
//                                    one self-contained ESM file (no imports at all). Its
//                                    default wasm location is patched from jsDelivr to
//                                    new URL('./zxing_reader.wasm', import.meta.url), and it
//                                    also exports ZXING_WASM_URL + LOCAL_ZXING_OVERRIDES.
//   app/vendor/zxing_reader.wasm     the exact wasm that barcode-detector's zxing-wasm expects
//                                    (verified against its ZXING_WASM_SHA256)
//   app/vendor/licenses/*            license texts + README.txt index

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'app', 'vendor');
const LICENSES = path.join(VENDOR, 'licenses');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/** Locate an installed package the way Node does (walking up node_modules). */
async function findPackageDir(name, fromDir = ROOT) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    try {
      await fs.access(path.join(candidate, 'package.json'));
      return candidate;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Cannot find package "${name}" (from ${fromDir}). Run "npm install" first.`);
    dir = parent;
  }
}

async function readPkg(dir) {
  return JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
}

/** Resolve an "exports" subpath to an ESM file, preferring browser/import builds. */
function resolveExport(pkg, subpath) {
  const pick = (target) => {
    if (typeof target === 'string') return target;
    if (Array.isArray(target)) return target.map(pick).find(Boolean);
    if (target && typeof target === 'object') {
      for (const cond of ['browser', 'import', 'module', 'default']) {
        if (cond in target) {
          const hit = pick(target[cond]);
          if (hit) return hit;
        }
      }
    }
    return undefined;
  };
  let target;
  if (pkg.exports && typeof pkg.exports === 'object' && !Array.isArray(pkg.exports) && Object.keys(pkg.exports)[0]?.startsWith('.')) {
    target = pick(pkg.exports[subpath]);
  } else if (subpath === '.') {
    target = pick(pkg.exports) ?? pkg.module ?? pkg.main;
  }
  if (!target) throw new Error(`${pkg.name}: cannot resolve export "${subpath}"`);
  return target;
}

async function findLicense(dir) {
  const names = await fs.readdir(dir);
  const hit = names.find((n) => /^licen[cs]e(\.(md|txt))?$/i.test(n));
  if (!hit) throw new Error(`No LICENSE file in ${dir}`);
  return path.join(dir, hit);
}

/** Import specifiers of an ES module source, as parsed by esbuild (exact, unlike regexes). */
async function importSpecifiers(code) {
  const result = await esbuild.build({
    stdin: { contents: code, loader: 'js', resolveDir: ROOT, sourcefile: 'module.js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    metafile: true,
    external: ['*'],
    logLevel: 'silent',
  });
  return [...new Set(Object.values(result.metafile.inputs).flatMap((i) => i.imports.map((imp) => imp.original ?? imp.path)))];
}

const stripSourceMap = (code) => code.replace(/\s*\/\/[#@] sourceMappingURL=\S+\s*$/u, '\n');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const outputs = [];
async function writeOut(file, data, source) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
  outputs.push({ file: rel(file), bytes: Buffer.byteLength(data), source });
}

/** Copy one ESM file, add a provenance banner, strip the source map, check its imports. */
async function vendorModule({ pkgDir, pkg, subpath, outName, allowedImports }) {
  const entry = resolveExport(pkg, subpath);
  const src = path.join(pkgDir, entry);
  const code = stripSourceMap(await fs.readFile(src, 'utf8'));
  const unexpected = (await importSpecifiers(code)).filter((s) => !allowedImports.includes(s));
  if (unexpected.length) {
    throw new Error(`${rel(src)} imports ${unexpected.join(', ')}; the import map only provides: ${allowedImports.join(', ') || '(none)'}`);
  }
  const banner = `/*! ${pkg.name}@${pkg.version} (${pkg.license}) - ${pkg.name}/${entry.replace(/^\.\//, '')}, vendored by tools/vendor.mjs */\n`;
  await writeOut(path.join(VENDOR, outName), banner + code, `${pkg.name}@${pkg.version}/${entry.replace(/^\.\//, '')}`);
}

// The default zxing-wasm locateFile (inside barcode-detector/dist/es/zxing-exported.js) points
// at jsDelivr. Rewrite it to a URL relative to the bundle so that even the library's *default*
// (e.g. after purgeZXingModule()) is the local copy.
const CDN_TEMPLATE_RE = /`https:\/\/fastly\.jsdelivr\.net\/npm\/zxing-wasm@[^`$]*\/dist\/\$\{\w+\[1\]\}\/\$\{(\w+)\}`/g;
const localWasmPlugin = {
  name: 'zxing-local-wasm',
  setup(build) {
    build.onLoad({ filter: /[\\/]barcode-detector[\\/]dist[\\/]es[\\/][^\\/]+\.js$/ }, async (args) => {
      const code = await fs.readFile(args.path, 'utf8');
      let count = 0;
      const patched = code.replace(CDN_TEMPLATE_RE, (_m, fileVar) => {
        count += 1;
        return `new URL(\`./\${${fileVar}}\`, import.meta.url).href`;
      });
      if (/jsdelivr|unpkg/.test(code) && count !== 1) {
        throw new Error(
          `${rel(args.path)}: expected exactly one jsDelivr wasm URL template, found ${count}. ` +
            'barcode-detector/zxing-wasm changed - update CDN_TEMPLATE_RE in tools/vendor.mjs.',
        );
      }
      return { contents: patched, loader: 'js' };
    });
  },
};

const BARCODE_ENTRY = `
import { prepareZXingModule } from 'barcode-detector/ponyfill';
export * from 'barcode-detector/ponyfill';
/** Absolute URL of the vendored zxing reader wasm (next to this file). */
export const ZXING_WASM_URL = new URL('./zxing_reader.wasm', import.meta.url).href;
/** zxing-wasm module overrides that load ZXING_WASM_URL (never a CDN). Frozen + stable identity,
 *  so passing it to prepareZXingModule() repeatedly never re-instantiates the module. */
export const LOCAL_ZXING_OVERRIDES = Object.freeze({
  locateFile: (file, prefix) => (file.endsWith('.wasm') ? ZXING_WASM_URL : prefix + file),
});
// Register before anything can construct a BarcodeDetector (its constructor starts loading
// the wasm). This only stores the overrides; nothing is fetched until first use.
prepareZXingModule({ overrides: LOCAL_ZXING_OVERRIDES });
`;

async function vendorBarcodeDetector() {
  const bdDir = await findPackageDir('barcode-detector');
  const bdPkg = await readPkg(bdDir);
  const zxDir = await findPackageDir('zxing-wasm', bdDir); // the copy barcode-detector resolves
  const zxPkg = await readPkg(zxDir);

  const ponyfillFile = path.join(bdDir, resolveExport(bdPkg, './ponyfill'));
  const meta = await import(pathToFileURL(ponyfillFile).href); // side-effect free in Node
  if (meta.ZXING_WASM_VERSION !== zxPkg.version) {
    throw new Error(`barcode-detector embeds zxing-wasm ${meta.ZXING_WASM_VERSION} but resolves ${zxPkg.version} from ${rel(zxDir)}`);
  }

  // 1. The wasm (must be byte-identical to what the JS glue was built against).
  const wasm = await fs.readFile(path.join(zxDir, 'dist', 'reader', 'zxing_reader.wasm'));
  const wasmHash = sha256(wasm);
  if (wasmHash !== meta.ZXING_WASM_SHA256) {
    throw new Error(`zxing_reader.wasm sha256 ${wasmHash} != ZXING_WASM_SHA256 ${meta.ZXING_WASM_SHA256}`);
  }
  await writeOut(path.join(VENDOR, 'zxing_reader.wasm'), wasm, `zxing-wasm@${zxPkg.version}/dist/reader/zxing_reader.wasm`);

  // 2. The ponyfill as one self-contained ES module.
  const outfile = path.join(VENDOR, 'barcode-detector.js');
  const result = await esbuild.build({
    stdin: { contents: BARCODE_ENTRY, resolveDir: ROOT, sourcefile: 'barcode-detector.vendor-entry.js', loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    legalComments: 'inline',
    charset: 'utf8',
    sourcemap: false,
    metafile: true,
    write: false,
    outfile,
    logLevel: 'warning',
    plugins: [localWasmPlugin],
    banner: {
      js:
        `/*! barcode-detector@${bdPkg.version} ponyfill (${bdPkg.license}) + zxing-wasm@${zxPkg.version} reader glue (${zxPkg.license}; ` +
        `wasm contains zxing-cpp ${meta.ZXING_CPP_COMMIT.slice(0, 12)}, Apache-2.0). Bundled by tools/vendor.mjs. ` +
        'Loads ./zxing_reader.wasm relative to this file. Licenses: ./licenses/ */',
    },
  });
  const out = result.outputFiles.find((f) => path.resolve(f.path) === path.resolve(outfile));
  const code = out.text;
  const leftovers = Object.values(result.metafile.outputs).flatMap((o) => o.imports.map((i) => i.path));
  if (leftovers.length) throw new Error(`barcode-detector bundle still imports: ${leftovers.join(', ')}`);
  const remote = code.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
  if (remote.length) throw new Error(`barcode-detector bundle still references remote URLs: ${[...new Set(remote)].join(', ')}`);
  const bundleImports = await importSpecifiers(code);
  if (bundleImports.length) throw new Error(`barcode-detector bundle contains imports: ${bundleImports.join(', ')}`);
  await writeOut(outfile, code, `barcode-detector@${bdPkg.version}/ponyfill (esbuild bundle)`);

  return { bdDir, bdPkg, zxDir, zxPkg, meta };
}

async function main() {
  await fs.rm(VENDOR, { recursive: true, force: true });
  await fs.mkdir(LICENSES, { recursive: true });

  const preactDir = await findPackageDir('preact');
  const preactPkg = await readPkg(preactDir);
  const htmDir = await findPackageDir('htm');
  const htmPkg = await readPkg(htmDir);

  await vendorModule({ pkgDir: preactDir, pkg: preactPkg, subpath: '.', outName: 'preact.module.js', allowedImports: [] });
  await vendorModule({ pkgDir: preactDir, pkg: preactPkg, subpath: './hooks', outName: 'hooks.module.js', allowedImports: ['preact'] });
  await vendorModule({ pkgDir: htmDir, pkg: htmPkg, subpath: '.', outName: 'htm.module.js', allowedImports: [] });

  const { bdDir, bdPkg, zxDir, zxPkg, meta } = await vendorBarcodeDetector();

  // Licenses.
  const licensed = [
    { pkg: preactPkg, dir: preactDir, files: 'preact.module.js, hooks.module.js' },
    { pkg: htmPkg, dir: htmDir, files: 'htm.module.js' },
    { pkg: bdPkg, dir: bdDir, files: 'barcode-detector.js' },
    { pkg: zxPkg, dir: zxDir, files: 'barcode-detector.js (reader glue), zxing_reader.wasm' },
  ];
  for (const { pkg, dir } of licensed) {
    const text = await fs.readFile(await findLicense(dir));
    await writeOut(path.join(LICENSES, `${pkg.name}.LICENSE.txt`), text, `${pkg.name}@${pkg.version}/LICENSE`);
  }

  // zxing-cpp (compiled into the wasm) is Apache-2.0 but its license text is not shipped in the
  // npm package. The Apache-2.0 terms are standard; take them from htm's copy (same license).
  const apache = await fs.readFile(await findLicense(htmDir), 'utf8');
  const end = apache.indexOf('END OF TERMS AND CONDITIONS');
  const apacheTerms = end > 0 ? apache.slice(0, end + 'END OF TERMS AND CONDITIONS'.length).replace(/^\s*\n/, '') : null;
  const zxingCpp = [
    'zxing_reader.wasm (vendored from zxing-wasm) is compiled from:',
    `  - zxing-cpp, https://github.com/zxing-cpp/zxing-cpp (commit ${meta.ZXING_CPP_COMMIT})`,
    '    Copyright the ZXing authors / zxing-cpp contributors.',
    '  - zxing-wasm src/cpp/ZXingWasm.cpp, https://github.com/Sec-ant/zxing-wasm',
    '    Copyright Ze-Zheng Wu.',
    'Both are licensed under the Apache License, Version 2.0',
    '(https://www.apache.org/licenses/LICENSE-2.0), reproduced below.',
    '',
    apacheTerms ?? 'See https://www.apache.org/licenses/LICENSE-2.0 for the full text.',
    '',
  ].join('\n');
  await writeOut(path.join(LICENSES, 'zxing-cpp.LICENSE.txt'), zxingCpp, 'generated (Apache-2.0 notice)');

  const index = [
    'Third-party code in app/vendor/ (generated by tools/vendor.mjs - do not edit by hand)',
    '',
    ...licensed.map(({ pkg, files }) => `${pkg.name}@${pkg.version}  ${pkg.license}  -> ${files}  (licenses/${pkg.name}.LICENSE.txt)`),
    `zxing-cpp@${meta.ZXING_CPP_COMMIT.slice(0, 12)}  Apache-2.0  -> compiled into zxing_reader.wasm  (licenses/zxing-cpp.LICENSE.txt)`,
    '',
    `zxing_reader.wasm sha256 ${meta.ZXING_WASM_SHA256}`,
    '',
  ].join('\n');
  await writeOut(path.join(LICENSES, 'README.txt'), index, 'generated index');

  const width = Math.max(...outputs.map((o) => o.file.length));
  console.log(`Vendored into ${rel(VENDOR)}/:`);
  for (const o of outputs) console.log(`  ${o.file.padEnd(width)}  ${String(o.bytes).padStart(8)} B  <- ${o.source}`);
}

main().catch((err) => {
  console.error(`vendor failed: ${err?.message ?? err}`);
  process.exit(1);
});
