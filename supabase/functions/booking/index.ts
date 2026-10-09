/**
 * booking — the single public write path for the customer-facing app.
 *
 * A POST endpoint with a JSON body discriminated by `action`:
 *   create | get | reschedule | cancel
 *
 * The studio is identified by `slug`; the tenant is resolved server-side. The
 * client can never set `tenant_id`, price, duration or buffers — those fields are
 * simply not read here, and the SECURITY DEFINER RPCs resolve and re-validate
 * every one of them from the slug and the service key.
 *
 * `get` / `reschedule` / `cancel` authenticate purely by the customer token.
 *
 * =========================================================================
 * Access-token scheme (shared with booking-ics, push-subscribe and the push
 * dispatcher — this is what makes retries idempotent):
 *
 *   token = base64url(HMAC-SHA256(TOKEN_HMAC_SECRET, tenantId + ':' + bookingId))
 *
 * The database stores only `sha256(token)` as `bytea` (`tokenHashBytea(token)`).
 * Because the token is DERIVED from the booking id, re-issuing access on a retry
 * yields the SAME token without ever storing the plaintext: the RPC may replay a
 * stored response for the original bookingId, and we recompute the token from
 * that id. The plaintext token is returned to the caller exactly once, in the
 * `create` response body, and is never logged or echoed anywhere else.
 * =========================================================================
 */
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { adminClient, requireEnv } from '../_shared/admin.ts';
import { corsHeaders, handleOptions, jsonResponse, requestOrigin } from '../_shared/cors.ts';
import { sha256Hex, tokenHashBytea } from '../_shared/hash.ts';

/** HTTP status for each stable booking error code. Anything else -> 400. */
const STATUS_BY_CODE: Record<string, number> = {
  BK001: 409, // slot outside working hours / does not fit / taken
  BK007: 409, // booking is not in a mutable state
  BK008: 409, // idempotency key reused with a different payload
  BK011: 429, // tenant request budget exhausted
  BK005: 404, // tenant not found or suspended
  BK006: 404, // booking not found
};

const IDEMPOTENCY_MIN_LENGTH = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalString(value: unknown): string | null {
  return isNonEmptyString(value) ? value.trim() : null;
}

/** Pull a `BK0xx` code out of a PostgREST error (code or message). */
function rpcErrorCode(error: unknown): string | null {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
  const message = isRecord(error) && typeof error.message === 'string' ? error.message : '';
  const match = /BK0\d{2}/.exec(`${code} ${message}`);
  return match ? match[0] : null;
}

function errorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }
  return error instanceof Error ? error.message : 'internal error';
}

/** base64url without padding, per RFC 4648 §5. */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Derive the deterministic customer token for a booking. The same
 * (tenantId, bookingId) pair always yields the same token, which is why a
 * replayed create/reschedule never leaks a new secret and never needs storage.
 */
async function customerAccessToken(tenantId: string, bookingId: string): Promise<string> {
  const secret = requireEnv('TOKEN_HMAC_SECRET');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${tenantId}:${bookingId}`),
  );
  return base64UrlEncode(new Uint8Array(mac));
}

/** Validate the `create` payload. Returns a human message or null when valid. */
function validateCreate(raw: Record<string, unknown>): string | null {
  if (!isNonEmptyString(raw.slug)) return 'slug is required';
  if (!isNonEmptyString(raw.serviceKey)) return 'serviceKey is required';
  if (!isNonEmptyString(raw.startsAt)) return 'startsAt is required';
  if (Number.isNaN(Date.parse(raw.startsAt))) return 'startsAt must be an ISO date-time';
  if (!isNonEmptyString(raw.customerName)) return 'customerName is required';
  if (!isNonEmptyString(raw.customerPhone)) return 'customerPhone is required';
  if (raw.customerEmail !== undefined && raw.customerEmail !== null &&
    typeof raw.customerEmail !== 'string') {
    return 'customerEmail must be a string';
  }
  if (raw.comment !== undefined && raw.comment !== null && typeof raw.comment !== 'string') {
    return 'comment must be a string';
  }
  if (raw.preferredResourceId !== undefined && raw.preferredResourceId !== null &&
    typeof raw.preferredResourceId !== 'string') {
    return 'preferredResourceId must be a string';
  }
  if (!isNonEmptyString(raw.idempotencyKey) || raw.idempotencyKey.trim().length < IDEMPOTENCY_MIN_LENGTH) {
    return `idempotencyKey must be at least ${IDEMPOTENCY_MIN_LENGTH} characters`;
  }
  return null;
}

serve(async (req: Request): Promise<Response> => {
  const cors = corsHeaders(requestOrigin(req));
  const fail = (code: string, message: string, status: number): Response =>
    jsonResponse({ ok: false, code, message }, status, cors);

  if (req.method === 'OPTIONS') {
    return handleOptions(req);
  }
  if (req.method !== 'POST') {
    return fail('METHOD_NOT_ALLOWED', 'use POST', 405);
  }

  let admin: SupabaseClient;
  try {
    admin = adminClient();
  } catch (error) {
    console.error('booking: admin client not configured', errorMessage(error));
    return fail('INTERNAL', 'internal error', 500);
  }

  /** Map a failed RPC to the client response, logging only what is safe. */
  const mapRpcError = (error: unknown): Response => {
    const code = rpcErrorCode(error);
    if (code) {
      const status = STATUS_BY_CODE[code] ?? 400;
      return fail(code, errorMessage(error), status);
    }
    // Unrecognised: log the real error server-side, never echo it to the client.
    console.error('booking: unrecognised RPC error', errorMessage(error));
    return fail('INTERNAL', 'internal error', 500);
  };

  try {
    // ------------------------------------------------------------------
    // Per-IP rate limit for the whole endpoint. The RPCs already spend the
    // tenant budget under their own `booking:<tenantId>` / `slots:<tenantId>`
    // buckets, so this uses a separate `booking:ip:` namespace. The bucket is
    // derived from a hash of the client IP (never the raw IP) so the raw
    // address is neither stored nor logged.
    // ------------------------------------------------------------------
    const forwardedFor = req.headers.get('x-forwarded-for') ?? '';
    const clientIp = forwardedFor.split(',')[0].trim() || 'unknown';
    const ipBucket = `booking:ip:${await sha256Hex(clientIp)}`;
    const quota = await admin.rpc('consume_quota', {
      p_bucket: ipBucket,
      p_limit: 120,
      p_window_seconds: 60,
    });
    if (quota.error) {
      // Fail open: a broken counter must not take the booking endpoint down.
      console.error('booking: quota check failed', errorMessage(quota.error));
    } else {
      const row = Array.isArray(quota.data) ? quota.data[0] : quota.data;
      if (isRecord(row) && row.allowed === false) {
        return fail('RATE_LIMITED', 'too many requests', 429);
      }
    }

    const raw: unknown = await req.json().catch(() => null);
    if (!isRecord(raw)) {
      return fail('INVALID_REQUEST', 'request body must be a JSON object', 400);
    }

    const action = raw.action;

    // ------------------------------------------------------------------
    // create
    // ------------------------------------------------------------------
    if (action === 'create') {
      const problem = validateCreate(raw);
      if (problem) {
        return fail('INVALID_REQUEST', problem, 400);
      }

      const slug = (raw.slug as string).trim();
      const serviceKey = (raw.serviceKey as string).trim();
      const startsAt = (raw.startsAt as string).trim();
      const idempotencyKey = (raw.idempotencyKey as string).trim();

      // Resolve the tenant id server-side: it is what the token is derived from,
      // and it is never accepted from the client.
      const tenantLookup = await admin
        .from('tenants')
        .select('id')
        .eq('slug', slug)
        .maybeSingle();
      if (tenantLookup.error) {
        console.error('booking: tenant lookup failed', tenantLookup.error.message);
        return fail('INTERNAL', 'internal error', 500);
      }
      const tenantId = isRecord(tenantLookup.data) && typeof tenantLookup.data.id === 'string'
        ? tenantLookup.data.id
        : null;

      // We choose the id; the token is derived from it.
      const proposedBookingId = crypto.randomUUID();
      let accessToken: string | null = null;
      let tokenHash: string | null = null;
      if (tenantId) {
        accessToken = await customerAccessToken(tenantId, proposedBookingId);
        tokenHash = await tokenHashBytea(accessToken);
      }

      const { data, error } = await admin.rpc('create_booking', {
        p_tenant_slug: slug,
        p_service_key: serviceKey,
        p_starts_at: startsAt,
        p_customer_name: raw.customerName,
        p_customer_phone: raw.customerPhone,
        p_customer_email: optionalString(raw.customerEmail),
        p_customer_comment: optionalString(raw.comment),
        p_booking_id: proposedBookingId,
        p_token_hash: tokenHash,
        p_idempotency_key: idempotencyKey,
        // null => the RPC derives the canonical hash itself.
        p_request_hash: null,
        p_preferred_resource_id: optionalString(raw.preferredResourceId),
      });
      if (error) {
        return mapRpcError(error);
      }

      const result = isRecord(data) ? data : {};
      // A replayed idempotency key returns the ORIGINAL bookingId. Recompute the
      // token from that id so the caller gets the very same access again.
      const effectiveBookingId = typeof result.bookingId === 'string'
        ? result.bookingId
        : proposedBookingId;
      if (tenantId) {
        accessToken = await customerAccessToken(tenantId, effectiveBookingId);
      }

      // The plaintext token is placed here and nowhere else.
      return jsonResponse(
        { ok: true, data: { ...result, accessToken } },
        200,
        cors,
      );
    }

    // ------------------------------------------------------------------
    // get
    // ------------------------------------------------------------------
    if (action === 'get') {
      if (!isNonEmptyString(raw.token)) {
        return fail('INVALID_REQUEST', 'token is required', 400);
      }
      const tokenHash = await tokenHashBytea((raw.token as string).trim());
      const { data, error } = await admin.rpc('get_booking_by_token', {
        p_token_hash: tokenHash,
      });
      if (error) {
        return mapRpcError(error);
      }
      if (!isRecord(data)) {
        return fail('TOKEN_INVALID', 'no booking matches this token', 404);
      }
      return jsonResponse({ ok: true, data }, 200, cors);
    }

    // ------------------------------------------------------------------
    // reschedule
    // ------------------------------------------------------------------
    if (action === 'reschedule') {
      if (!isNonEmptyString(raw.token)) {
        return fail('INVALID_REQUEST', 'token is required', 400);
      }
      if (!isNonEmptyString(raw.startsAt) || Number.isNaN(Date.parse(raw.startsAt))) {
        return fail('INVALID_REQUEST', 'startsAt must be an ISO date-time', 400);
      }
      if (!isNonEmptyString(raw.idempotencyKey) ||
        (raw.idempotencyKey as string).trim().length < IDEMPOTENCY_MIN_LENGTH) {
        return fail('INVALID_REQUEST', `idempotencyKey must be at least ${IDEMPOTENCY_MIN_LENGTH} characters`, 400);
      }
      const tokenHash = await tokenHashBytea((raw.token as string).trim());
      const { data, error } = await admin.rpc('reschedule_booking', {
        p_token_hash: tokenHash,
        p_new_starts_at: (raw.startsAt as string).trim(),
        p_idempotency_key: (raw.idempotencyKey as string).trim(),
        p_request_hash: null,
      });
      if (error) {
        return mapRpcError(error);
      }
      return jsonResponse({ ok: true, data }, 200, cors);
    }

    // ------------------------------------------------------------------
    // cancel
    // ------------------------------------------------------------------
    if (action === 'cancel') {
      if (!isNonEmptyString(raw.token)) {
        return fail('INVALID_REQUEST', 'token is required', 400);
      }
      if (!isNonEmptyString(raw.idempotencyKey) ||
        (raw.idempotencyKey as string).trim().length < IDEMPOTENCY_MIN_LENGTH) {
        return fail('INVALID_REQUEST', `idempotencyKey must be at least ${IDEMPOTENCY_MIN_LENGTH} characters`, 400);
      }
      const tokenHash = await tokenHashBytea((raw.token as string).trim());
      const { data, error } = await admin.rpc('cancel_booking', {
        p_token_hash: tokenHash,
        p_reason: optionalString(raw.reason),
        p_idempotency_key: (raw.idempotencyKey as string).trim(),
        p_request_hash: null,
      });
      if (error) {
        return mapRpcError(error);
      }
      return jsonResponse({ ok: true, data }, 200, cors);
    }

    return fail('INVALID_REQUEST', "action must be one of 'create', 'get', 'reschedule', 'cancel'", 400);
  } catch (error) {
    // Last-resort guard: log server-side, never leak internals to the client.
    console.error('booking: unhandled error', errorMessage(error));
    return fail('INTERNAL', 'internal error', 500);
  }
});
