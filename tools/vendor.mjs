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
//   app/vendor/supabase.js           @supabase/supabase-js (createClient) and its dependencies as one
//                                    self-contained, minified ES module. Only js/cloud.js loads it,
//                                    lazily, when online backup is configured.
//   app/vendor/ocr/*                 tesseract.js (browser build + worker), its LSTM cores (SIMD and
//                                    plain .js + .wasm) and the English model, for reading expiry
//                                    dates. Loaded by js/datescan.js on first use; not precached.
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

/** Bundle supabase-js; returns the packages that ended up in the bundle (for their licenses). */
async function vendorSupabase() {
  const sbDir = await findPackageDir('@supabase/supabase-js');
  const sbPkg = await readPkg(sbDir);
  const outfile = path.join(VENDOR, 'supabase.js');
  const result = await esbuild.build({
    stdin: { contents: "export { createClient } from '@supabase/supabase-js';", resolveDir: ROOT, sourcefile: 'supabase.vendor-entry.js', loader: 'js' },
    absWorkingDir: ROOT,
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
    banner: {
      js: `/*! @supabase/supabase-js@${sbPkg.version} (${sbPkg.license}) and its dependencies, bundled by tools/vendor.mjs. Licenses: ./licenses/ */`,
    },
  });
  const code = result.outputFiles.find((f) => path.resolve(f.path) === path.resolve(outfile)).text;
  const leftovers = Object.values(result.metafile.outputs).flatMap((o) => o.imports.map((i) => i.path));
  if (leftovers.length) throw new Error(`supabase bundle still imports: ${leftovers.join(', ')}`);
  const bundleImports = await importSpecifiers(code);
  if (bundleImports.length) throw new Error(`supabase bundle contains imports: ${bundleImports.join(', ')}`);
  await writeOut(outfile, code, `@supabase/supabase-js@${sbPkg.version} (esbuild bundle)`);

  const names = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    const m = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    if (m) names.add(m[1]);
  }
  return Promise.all([...names].sort().map(async (name) => {
    const dir = await findPackageDir(name);
    return { pkg: await readPkg(dir), dir, files: 'supabase.js' };
  }));
}

/**
 * Tesseract (OCR), for reading expiry dates: the browser build, its worker, the LSTM cores (SIMD and
 * plain) and the English model, copied as published into vendor/ocr/. js/datescan.js loads them only
 * when the date reader first runs; the worker finds the core's .wasm next to itself.
 */
async function vendorOcr() {
  const tjDir = await findPackageDir('tesseract.js');
  const tjPkg = await readPkg(tjDir);
  const coreDir = await findPackageDir('tesseract.js-core');
  const corePkg = await readPkg(coreDir);
  const engDir = await findPackageDir('@tesseract.js-data/eng');
  const engPkg = await readPkg(engDir);
  const wanted = tjPkg.dependencies['tesseract.js-core'];
  if (wanted.replace(/^\D*/, '').split('.')[0] !== corePkg.version.split('.')[0]) {
    throw new Error(`tesseract.js@${tjPkg.version} wants tesseract.js-core ${wanted}, but ${corePkg.version} is installed`);
  }
  const OCR = path.join(VENDOR, 'ocr');
  const text = async (dir, file, out, pkg) => writeOut(path.join(OCR, out), stripSourceMap(await fs.readFile(path.join(dir, file), 'utf8')), `${pkg.name}@${pkg.version}/${file}`);
  const binary = async (dir, file, out, pkg) => writeOut(path.join(OCR, out), await fs.readFile(path.join(dir, file)), `${pkg.name}@${pkg.version}/${file}`);

  await text(tjDir, 'dist/tesseract.esm.min.js', 'tesseract.esm.min.js', tjPkg);
  await text(tjDir, 'dist/worker.min.js', 'worker.min.js', tjPkg);
  await text(tjDir, 'dist/worker.min.js.LICENSE.txt', 'worker.min.js.LICENSE.txt', tjPkg);
  for (const core of ['tesseract-core-simd-lstm', 'tesseract-core-lstm']) {
    await text(coreDir, `${core}.js`, `${core}.js`, corePkg);
    await binary(coreDir, `${core}.wasm`, `${core}.wasm`, corePkg);
  }
  await binary(engDir, '4.0.0_best_int/eng.traineddata.gz', 'eng.traineddata.gz', engPkg);
  return { tjDir, tjPkg, coreDir, corePkg, engPkg };
}

/** licenses/<name>.LICENSE.txt, with scoped names flattened (@scope/pkg -> scope-pkg). */
const licenseFile = (pkg) => `${pkg.name.replace(/^@/, '').replace('/', '-')}.LICENSE.txt`;

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
  const supabaseParts = await vendorSupabase();
  const ocr = await vendorOcr();

  // Licenses.
  const licensed = [
    { pkg: preactPkg, dir: preactDir, files: 'preact.module.js, hooks.module.js' },
    { pkg: htmPkg, dir: htmDir, files: 'htm.module.js' },
    { pkg: bdPkg, dir: bdDir, files: 'barcode-detector.js' },
    { pkg: zxPkg, dir: zxDir, files: 'barcode-detector.js (reader glue), zxing_reader.wasm' },
    ...supabaseParts,
    { pkg: ocr.tjPkg, dir: ocr.tjDir, files: 'ocr/tesseract.esm.min.js, ocr/worker.min.js (bundled code: ocr/worker.min.js.LICENSE.txt)' },
    { pkg: ocr.corePkg, dir: ocr.coreDir, files: 'ocr/tesseract-core-*-lstm.js, ocr/tesseract-core-*-lstm.wasm' },
  ];
  for (const { pkg, dir } of licensed) {
    const text = await fs.readFile(await findLicense(dir));
    await writeOut(path.join(LICENSES, licenseFile(pkg)), text, `${pkg.name}@${pkg.version}/LICENSE`);
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

  // The English model comes from Tesseract's tessdata_best (Apache-2.0); the npm package that ships it
  // (MIT) has no license file of its own.
  const tessdata = [
    `ocr/eng.traineddata.gz is 4.0.0_best_int/eng.traineddata.gz from ${ocr.engPkg.name}@${ocr.engPkg.version}`,
    `(packaging licensed ${ocr.engPkg.license}). The model itself is Tesseract's English LSTM model from`,
    'https://github.com/tesseract-ocr/tessdata_best, licensed under the Apache License, Version 2.0',
    '(https://www.apache.org/licenses/LICENSE-2.0), reproduced below.',
    '',
    apacheTerms ?? 'See https://www.apache.org/licenses/LICENSE-2.0 for the full text.',
    '',
  ].join('\n');
  await writeOut(path.join(LICENSES, 'tessdata.LICENSE.txt'), tessdata, 'generated (Apache-2.0 notice)');

  const index = [
    'Third-party code in app/vendor/ (generated by tools/vendor.mjs - do not edit by hand)',
    '',
    ...licensed.map(({ pkg, files }) => `${pkg.name}@${pkg.version}  ${pkg.license}  -> ${files}  (licenses/${licenseFile(pkg)})`),
    `zxing-cpp@${meta.ZXING_CPP_COMMIT.slice(0, 12)}  Apache-2.0  -> compiled into zxing_reader.wasm  (licenses/zxing-cpp.LICENSE.txt)`,
    `tessdata_best eng (via ${ocr.engPkg.name}@${ocr.engPkg.version})  Apache-2.0  -> ocr/eng.traineddata.gz  (licenses/tessdata.LICENSE.txt)`,
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
