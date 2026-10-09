/**
 * Dependency-free Web Push sender implemented on WebCrypto only.
 *
 * It follows the RFCs step by step so the code can be audited next to them:
 *
 *  RFC 8291 (Message Encryption for Web Push, aes128gcm)
 *    1. ephemeral application-server ECDH P-256 key pair for this message;
 *    2. shared secret = ECDH(as_private, ua_public)                          (§3.4)
 *    3. IKM = HKDF(salt = auth_secret,
 *                  ikm  = shared secret,
 *                  info = "WebPush: info\0" || ua_public || as_public, 32B);
 *    4. PRK = HKDF-Extract(salt = random 16-byte salt, IKM);
 *    5. CEK   = HKDF-Expand(PRK, "Content-Encoding: aes128gcm\0", 16B);
 *       nonce = HKDF-Expand(PRK, "Content-Encoding: nonce\0", 12B);
 *    6. AES-128-GCM over (plaintext || 0x02) with the content header as AAD.
 *
 *  RFC 8188 (Encrypted Content-Encoding for HTTP)
 *    header = salt(16) || rs(4, big-endian) || idlen(1) || keyid(as_public);
 *    the record body is the AEAD output (ciphertext || 16-byte tag).
 *
 *  RFC 8292 (VAPID) + RFC 8187 (Authorization scheme)
 *    JWT (ES256) with claims aud = push service origin, exp <= 24h, sub; sent
 *    as `Authorization: vapid t=<jwt>, k=<public key>`.
 *
 * No third-party push library is used.
 */

export interface PushSubscriptionTarget {
  endpoint: string;
  /** base64url uncompressed P-256 browser public key (65 bytes). */
  p256dh: string;
  /** base64url 16-byte shared authentication secret. */
  auth: string;
}

export interface VapidConfig {
  /** base64url uncompressed P-256 public key (65 bytes). */
  publicKey: string;
  /** base64url P-256 private scalar. */
  privateKey: string;
  /** JWT `sub` claim, e.g. "mailto:ops@example.com". */
  subject: string;
}

export interface WebPushResult {
  ok: boolean;
  status: number;
  error?: string;
  /** True for HTTP 404/410: the subscription is gone and must be disabled. */
  expired?: boolean;
}

/** Maximum plaintext record; the payload must fit in one record. */
const RECORD_SIZE = 4096;
/** Push service retention for an undelivered message (28 days). */
const TTL_SECONDS = 2419200;

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

function base64UrlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * WebCrypto expects a `BufferSource`. TypeScript 5.7+ made typed arrays generic
 * over their backing buffer, so a plainly typed `Uint8Array` may not assign to
 * `BufferSource`; this cast is version-agnostic and keeps the call sites clear.
 */
function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

/** HKDF-SHA256. WebCrypto performs extract+expand in a single call. */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', asBufferSource(ikm), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: asBufferSource(salt), info: asBufferSource(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** Rebuild the VAPID private key as a JWK (the x/y point comes from the public key). */
async function importVapidPrivateKey(vapid: VapidConfig): Promise<CryptoKey> {
  const publicBytes = base64UrlToBytes(vapid.publicKey);
  if (publicBytes.length !== 65 || publicBytes[0] !== 4) {
    throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point');
  }
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: bytesToBase64Url(base64UrlToBytes(vapid.privateKey)),
    x: bytesToBase64Url(publicBytes.slice(1, 33)),
    y: bytesToBase64Url(publicBytes.slice(33, 65)),
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
  ]);
}

/** Sign the RFC 8292 VAPID JWT (ES256) for a push service origin. */
async function buildVapidJwt(audience: string, vapid: VapidConfig): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { typ: 'JWT', alg: 'ES256' };
  // RFC 8292: exp must be no more than 24 hours in the future.
  const claims = { aud: audience, exp: nowSeconds + 12 * 60 * 60, sub: vapid.subject };

  const signingInput = `${bytesToBase64Url(utf8(JSON.stringify(header)))}.${bytesToBase64Url(
    utf8(JSON.stringify(claims)),
  )}`;

  const key = await importVapidPrivateKey(vapid);
  // WebCrypto returns the raw R||S signature, which is exactly the JWS ES256 form.
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    asBufferSource(utf8(signingInput)),
  );

  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/**
 * Encrypt `payload` for one subscription and deliver it to the push service.
 * Returns a result object; it never throws, so a single bad subscription cannot
 * abort a batch.
 */
export async function sendWebPush(
  subscription: PushSubscriptionTarget,
  payload: string,
  vapid: VapidConfig,
): Promise<WebPushResult> {
  try {
    if (!vapid.publicKey || !vapid.privateKey || !vapid.subject) {
      return { ok: false, status: 0, error: 'VAPID keys/subject are not configured' };
    }

    const payloadBytes = utf8(payload);
    if (payloadBytes.length + 17 > RECORD_SIZE) {
      return { ok: false, status: 0, error: 'push payload exceeds a single 4096-byte record' };
    }

    // 1. Ephemeral application-server key pair (the message keyid).
    const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ]);
    const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));

    // 2 + 3. ECDH shared secret, then the RFC 8291 input keying material.
    const uaPublicBytes = base64UrlToBytes(subscription.p256dh);
    const uaPublicKey = await crypto.subtle.importKey(
      'raw',
      asBufferSource(uaPublicBytes),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    const sharedSecret = new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublicKey }, asKeys.privateKey, 256),
    );
    const authSecret = base64UrlToBytes(subscription.auth);

    const ikm = await hkdf(
      authSecret,
      sharedSecret,
      concatBytes(utf8('WebPush: info'), new Uint8Array([0]), uaPublicBytes, asPublic),
      32,
    );

    // 4 + 5. Per-message salt, then CEK and nonce.
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const cek = await hkdf(
      salt,
      ikm,
      concatBytes(utf8('Content-Encoding: aes128gcm'), new Uint8Array([0])),
      16,
    );
    const nonce = await hkdf(
      salt,
      ikm,
      concatBytes(utf8('Content-Encoding: nonce'), new Uint8Array([0])),
      12,
    );

    // 6. aes128gcm content header: salt | rs | idlen | keyid.
    const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
    header.set(salt, 0);
    new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
    header[20] = asPublic.length;
    header.set(asPublic, 21);

    const aesKey = await crypto.subtle.importKey('raw', asBufferSource(cek), { name: 'AES-GCM' }, false, [
      'encrypt',
    ]);
    // 0x02 is the RFC 8188 last-record delimiter; AES-GCM appends the tag.
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: asBufferSource(nonce),
          additionalData: asBufferSource(header),
          tagLength: 128,
        },
        aesKey,
        asBufferSource(concatBytes(payloadBytes, new Uint8Array([2]))),
      ),
    );
    const body = concatBytes(header, sealed);

    // 7. VAPID authorization for the push service origin.
    const audience = new URL(subscription.endpoint).origin;
    const jwt = await buildVapidJwt(audience, vapid);

    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(TTL_SECONDS),
      },
      body: asBufferSource(body),
    });

    if (response.ok) {
      return { ok: true, status: response.status };
    }

    const detail = await response.text().catch(() => '');
    return {
      ok: false,
      status: response.status,
      expired: response.status === 404 || response.status === 410,
      error: `push service responded ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
