#!/usr/bin/env node
// Prints a fresh VAPID key pair for Web Push reminders, base64url-encoded (the format browsers and the
// send-reminders function use):
//   - the PUBLIC key goes into app/js/config.js (VAPID_PUBLIC_KEY) and into the function secrets;
//   - the PRIVATE key goes ONLY into the function secrets. Never commit it.
//
//   node tools/vapid.mjs                     print a key pair
//   node tools/vapid.mjs --write <file>      write a secrets file for the send-reminders function:
//      [--subject <mailto:… | https://…>]    VAPID_SUBJECT (default https://example.com/, change it)
//      [--cron-secret <text>]                CRON_SECRET (default: a random one)
//      [--force]                             replace an existing file
//
// Local stack:  node tools/vapid.mjs --write supabase/functions/.env --cron-secret local-dev-cron-secret
// Production:   see docs/cloud-setup.md. Both files are git-ignored (.env*).

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = name => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
};

/** A P-256 key pair: public = 65-byte uncompressed point, private = 32-byte scalar, both base64url. */
function vapidKeys() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const hex = b64 => Buffer.from(b64, 'base64url').toString('hex').padStart(64, '0');
  return {
    publicKey: Buffer.from(`04${hex(jwk.x)}${hex(jwk.y)}`, 'hex').toString('base64url'),
    privateKey: Buffer.from(hex(jwk.d), 'hex').toString('base64url'),
  };
}

function main() {
  if (args.includes('-h') || args.includes('--help')) {
    const lines = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1);
    console.log(lines.slice(0, lines.findIndex(l => !l.startsWith('//'))).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  const keys = vapidKeys();
  const file = opt('--write');
  if (!file) {
    console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
    console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
    console.log('\nPublic key: app/js/config.js and the function secrets. Private key: function secrets only.');
    return;
  }
  const subject = opt('--subject') || 'https://example.com/';
  if (!/^(mailto:|https:\/\/)\S+$/.test(subject)) throw new Error('--subject must start with mailto: or https://');
  const cron = opt('--cron-secret') || randomBytes(32).toString('base64url');
  if (fs.existsSync(file) && !args.includes('--force')) throw new Error(`${file} exists already (add --force to replace it)`);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, [
    '# Secrets for the send-reminders Edge Function. Keep this file out of git.',
    `VAPID_PUBLIC_KEY=${keys.publicKey}`,
    `VAPID_PRIVATE_KEY=${keys.privateKey}`,
    `VAPID_SUBJECT=${subject}`,
    `CRON_SECRET=${cron}`,
    '',
  ].join('\n'));
  console.log(`Wrote ${file}`);
  console.log(`VAPID_PUBLIC_KEY (also goes into app/js/config.js): ${keys.publicKey}`);
  console.log(`CRON_SECRET (also goes into Vault as cron_secret):   ${cron}`);
}

try {
  main();
} catch (e) {
  console.error(`vapid: ${e.message}`);
  process.exit(1);
}
