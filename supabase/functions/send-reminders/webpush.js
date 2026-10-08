// Web Push for the send-reminders function: VAPID (RFC 8292) and aes128gcm message encryption
// (RFC 8291 on top of RFC 8188). WebCrypto only, so the same file runs in the Supabase Edge Runtime
// (Deno), in Node (tests/cloud.test.mjs) and in browsers. Every message gets a fresh key pair and salt.

const enc = new TextEncoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };
const RECORD_SIZE = 4096;
/** Push services accept 4096-byte bodies: minus the header (86), the tag (16) and the delimiter (1). */
export const MAX_PAYLOAD = 4096 - 86 - 16 - 1;

/** Bytes from base64url (or plain base64) text. */
export function fromBase64Url(text) {
  const b64 = String(text).trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

/** base64url text (no padding) from bytes. */
export function toBase64Url(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/**
 * VAPID keys from the usual base64url strings: the 65-byte public key (what browsers take as
 * applicationServerKey) and the 32-byte private key. Throws if they are malformed or not a pair.
 */
export async function importVapidKeys(publicKey, privateKey) {
  const pub = fromBase64Url(publicKey);
  const d = fromBase64Url(privateKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY must be a base64url P-256 public key (65 bytes).');
  if (d.length !== 32) throw new Error('VAPID_PRIVATE_KEY must be a base64url P-256 private key (32 bytes).');
  const jwk = { kty: 'EC', crv: 'P-256', x: toBase64Url(pub.subarray(1, 33)), y: toBase64Url(pub.subarray(33)), d: toBase64Url(d) };
  let signKey;
  try {
    signKey = await crypto.subtle.importKey('jwk', jwk, ECDSA, false, ['sign']);
  } catch {
    throw new Error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not a valid key pair.');
  }
  // A private key that doesn't belong to the public key would make every push service refuse us.
  const verifyKey = await crypto.subtle.importKey('raw', pub, ECDSA, false, ['verify']);
  const probe = enc.encode('vapid key check');
  if (!(await crypto.subtle.verify(SIGN, verifyKey, await crypto.subtle.sign(SIGN, signKey, probe), probe))) {
    throw new Error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not a pair.');
  }
  return { publicKey: toBase64Url(pub), signKey };
}

/** Authorization header for a push service: "vapid t=<signed JWT>, k=<public key>" (RFC 8292). */
export async function vapidAuthorization(vapid, endpoint, subject, { expiresIn = 12 * 3600, now = Date.now() } = {}) {
  const part = obj => toBase64Url(enc.encode(JSON.stringify(obj)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + expiresIn,
    sub: subject,
  })}`;
  // WebCrypto signatures are r || s (64 bytes), which is exactly the JWS ES256 format.
  const signature = await crypto.subtle.sign(SIGN, vapid.signKey, enc.encode(unsigned));
  return `vapid t=${unsigned}.${toBase64Url(signature)}, k=${vapid.publicKey}`;
}

/**
 * Encrypt a message for a subscription ({ p256dh, auth }, base64url) as one aes128gcm record.
 * `keys` (an ECDH key pair) and `salt` are only passed by tests; normally both are fresh.
 */
export async function encryptPayload(message, { p256dh, auth }, { keys = null, salt = null } = {}) {
  const data = typeof message === 'string' ? enc.encode(message) : message;
  if (data.length > MAX_PAYLOAD) throw new Error(`Push message too long (${data.length} bytes, at most ${MAX_PAYLOAD}).`);
  const uaPublic = fromBase64Url(p256dh);
  const authSecret = fromBase64Url(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length < 16) throw new Error('Invalid subscription keys.');
  salt ||= crypto.getRandomValues(new Uint8Array(16));
  keys ||= await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, ECDH, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, keys.privateKey, 256));
  // RFC 8291 §3.4: combine the ECDH secret with the subscription's auth secret, then RFC 8188 keys.
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\u0000'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\u0000'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\u0000'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // One (last) record: the message, then the 0x02 padding delimiter.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(data, Uint8Array.of(2))));
  // Header: salt (16) | record size (uint32) | key id length (1) | key id = our public key (65).
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, sealed);
}

/**
 * Send one message to a subscription ({ endpoint, p256dh, auth }). Resolves to
 * { status, ok, gone, detail }; `gone` (404 / 410) means the subscription no longer exists and should be
 * deleted. Network errors and timeouts reject.
 */
export async function sendPush(subscription, message, {
  vapid, subject, ttl = 6 * 3600, urgency = 'normal', timeoutMs = 15000, fetchFn = fetch,
} = {}) {
  const body = await encryptPayload(message, subscription);
  const res = await fetchFn(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
      Authorization: await vapidAuthorization(vapid, subscription.endpoint, subject),
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => '');
  return { status: res.status, ok: res.ok, gone: res.status === 404 || res.status === 410, detail: res.ok ? '' : text.slice(0, 300) };
}
