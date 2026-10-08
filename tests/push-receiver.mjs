// The browser's side of Web Push, for tests: subscription keys, decrypting aes128gcm messages and
// checking VAPID headers, with Node's own crypto (independent of the sender's WebCrypto code).
import crypto from 'node:crypto';

/** Keys like a browser's PushSubscription: { p256dh, auth } (base64url) plus the private parts. */
export function subscriptionKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, authSecret: auth, p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
}

/** Decrypt an aes128gcm push body (RFC 8291 / RFC 8188, single record). Returns { text, recordSize }. */
export function decryptPush(body, { ecdh, authSecret }) {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const recordSize = buf.readUInt32BE(16);
  const idLength = buf[20];
  const senderKey = buf.subarray(21, 21 + idLength);
  const sealed = buf.subarray(21 + idLength);
  const hkdf = (ikm, s, info, n) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, n));
  const shared = ecdh.computeSecret(senderKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), senderKey]);
  const ikm = hkdf(shared, authSecret, keyInfo, 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  let end = plain.length - 1;
  while (end > 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error('push message: missing last-record delimiter');
  return { text: plain.subarray(0, end).toString('utf8'), recordSize };
}

/** Check an "Authorization: vapid t=<JWT>, k=<key>" header (RFC 8292). Returns { valid, claims, publicKey }. */
export function checkVapid(authorization) {
  const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), ?k=([\w-]+)$/.exec(authorization || '');
  if (!m) return { valid: false, claims: null, publicKey: null };
  const [head, payload, signature] = m[1].split('.');
  const header = JSON.parse(Buffer.from(head, 'base64url'));
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  const pub = Buffer.from(m[2], 'base64url');
  const key = crypto.createPublicKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
  });
  const valid = header.alg === 'ES256' && crypto.verify('sha256', Buffer.from(`${head}.${payload}`),
    { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
  return { valid, claims, publicKey: m[2] };
}
