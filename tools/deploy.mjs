#!/usr/bin/env node
// Publish app/ to the gh-pages branch (GitHub Pages → "Deploy from a branch": gh-pages, / root).
//
//   npm run deploy                 deploy the committed app/ (refuses if app/ has uncommitted changes)
//   npm run deploy -- --allow-dirty
//
// A copy of app/ is stamped (service worker VERSION + precache list, see tools/stamp.mjs), given a
// .nojekyll marker, committed as a single commit and force-pushed to gh-pages. Phones pick up the new
// version through the service worker's update prompt.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (args, cwd = ROOT) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

if (git(['status', '--porcelain', '--', 'app']) && !process.argv.includes('--allow-dirty')) {
  console.error('app/ has uncommitted changes. Commit them first (or pass --allow-dirty).');
  process.exit(1);
}
const remote = git(['remote', 'get-url', 'origin']);
const sha = git(['rev-parse', '--short', 'HEAD']);
const name = git(['config', 'user.name']);
const email = git(['config', 'user.email']);

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'office-pantry-deploy-'));
try {
  fs.cpSync(path.join(ROOT, 'app'), out, { recursive: true });
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'stamp.mjs'), '--root', out], { stdio: 'inherit' });
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  git(['init', '-q', '-b', 'gh-pages'], out);
  git(['add', '-A'], out);
  git(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', `Deploy ${sha}`], out);
  execFileSync('git', ['push', '--force', '--quiet', remote, 'gh-pages'], { cwd: out, stdio: 'inherit' });
  console.log(`Deployed ${sha} to gh-pages. GitHub Pages usually updates within a minute.`);
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
