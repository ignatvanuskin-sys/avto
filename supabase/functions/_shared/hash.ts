/**
 * Hashing helpers built on WebCrypto.
 *
 * No Deno-specific APIs are used, so this module can be unit-tested with a
 * plain test runner outside the Edge runtime.
 */

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/** `sha256(value)` as a lower-case hex string. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

/**
 * Bytea argument for the token-based RPCs.
 *
 * The `booking` function hashes the customer token as `sha256(token)` hex, and
 * the database stores `digest(token, 'sha256')` in the `bookings.access_token_hash`
 * bytea column. The lookup value must therefore be exactly those 32 bytes.
 * PostgREST represents a bytea argument as a hex-escape literal, so the hex
 * digest is prefixed with `\x`.
 */
export async function tokenHashBytea(token: string): Promise<string> {
  return `\\x${await sha256Hex(token)}`;
}

/**
 * Constant-time string comparison. Used for the shared cron secret so a
 * mismatch cannot be timed.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
