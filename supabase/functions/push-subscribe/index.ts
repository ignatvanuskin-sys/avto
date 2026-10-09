/**
 * push-subscribe — register a browser push subscription.
 *
 * Two audiences:
 *   * `customer` — the caller proves ownership of a booking with its access
 *     token; the subscription is bound to that booking;
 *   * `owner`    — the caller must be a signed-in owner/manager of the studio.
 *
 * The subscription is stored even when the server-side VAPID keys are missing;
 * the response then reports `pushConfigured: false` instead of pretending push
 * will work.
 */
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { adminClient, anonClient } from '../_shared/admin.ts';
import { corsHeaders, handleOptions, jsonResponse, requestOrigin } from '../_shared/cors.ts';
import { tokenHashBytea } from '../_shared/hash.ts';

type Audience = 'customer' | 'owner';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

serve(async (req: Request): Promise<Response> => {
  const origin = requestOrigin(req);
  const cors = corsHeaders(origin);
  const fail = (code: string, message: string, status: number): Response =>
    jsonResponse({ ok: false, code, message }, status, cors);

  if (req.method === 'OPTIONS') {
    return handleOptions(req);
  }
  if (req.method !== 'POST') {
    return fail('METHOD_NOT_ALLOWED', 'use POST', 405);
  }

  const raw: unknown = await req.json().catch(() => null);
  if (!isRecord(raw)) {
    return fail('INVALID_BODY', 'request body must be a JSON object', 400);
  }

  const slug = typeof raw.slug === 'string' ? raw.slug.trim() : '';
  const audience: Audience | null =
    raw.audience === 'customer' || raw.audience === 'owner' ? raw.audience : null;
  const subscription = isRecord(raw.subscription) ? raw.subscription : null;
  const keys = subscription && isRecord(subscription.keys) ? subscription.keys : null;

  const endpoint =
    subscription && typeof subscription.endpoint === 'string' ? subscription.endpoint.trim() : '';
  const p256dh = keys && typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
  const auth = keys && typeof keys.auth === 'string' ? keys.auth.trim() : '';
  const token = typeof raw.token === 'string' ? raw.token : null;
  const userAgent = typeof raw.userAgent === 'string' ? raw.userAgent : null;

  if (!slug) {
    return fail('SLUG_REQUIRED', 'slug is required', 400);
  }
  if (!audience) {
    return fail('AUDIENCE_INVALID', "audience must be 'customer' or 'owner'", 400);
  }
  if (!endpoint) {
    return fail('ENDPOINT_REQUIRED', 'subscription.endpoint is required', 400);
  }
  if (!p256dh || !auth) {
    return fail('KEYS_REQUIRED', 'subscription.keys.p256dh and .auth are required', 400);
  }

  let admin: SupabaseClient;
  try {
    admin = adminClient();
  } catch (error) {
    return fail('NOT_CONFIGURED', toMessage(error), 500);
  }

  const tenantResult = await admin
    .from('tenants')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();
  if (tenantResult.error) {
    return fail('STORE_FAILED', tenantResult.error.message, 500);
  }
  const tenant = tenantResult.data as { id: string } | null;
  if (!tenant) {
    return fail('TENANT_NOT_FOUND', `unknown tenant '${slug}'`, 404);
  }

  const target: Record<string, unknown> = {
    tenant_id: tenant.id,
    endpoint,
    p256dh,
    auth,
    audience,
    booking_id: null,
    owner_user_id: null,
    user_agent: userAgent,
    is_active: true,
  };

  if (audience === 'customer') {
    if (!token) {
      return fail('TOKEN_REQUIRED', 'token is required for a customer subscription', 400);
    }

    const tokenHash = await tokenHashBytea(token);
    const { data, error } = await anonClient().rpc('get_booking_by_token', {
      p_token_hash: tokenHash,
    });
    if (error) {
      return fail('RPC_FAILED', error.message, 500);
    }

    const booking = isRecord(data) ? data : null;
    const bookingId = booking && typeof booking.bookingId === 'string' ? booking.bookingId : null;
    const bookingSlug =
      booking && typeof booking.tenantSlug === 'string' ? booking.tenantSlug : null;

    if (!bookingId || (bookingSlug ?? '').toLowerCase() !== slug.toLowerCase()) {
      return fail('TOKEN_INVALID', 'no booking matches this token', 404);
    }
    target.booking_id = bookingId;
  } else {
    const authorization = req.headers.get('authorization');
    if (!authorization) {
      return fail('UNAUTHENTICATED', 'owner subscriptions require a signed-in user', 401);
    }

    const userClient = anonClient(authorization);
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) {
      return fail('UNAUTHENTICATED', 'invalid or expired session', 401);
    }

    const { data: contextData, error: contextError } = await userClient.rpc('owner_tenant_context');
    if (contextError) {
      return fail('RPC_FAILED', contextError.message, 500);
    }

    const contexts = Array.isArray(contextData)
      ? (contextData as Array<Record<string, unknown>>)
      : [];
    const match = contexts.find(
      (entry) => typeof entry.slug === 'string' && entry.slug.toLowerCase() === slug.toLowerCase(),
    );
    const role = match && typeof match.role === 'string' ? match.role : null;
    if (!match || (role !== 'owner' && role !== 'manager')) {
      return fail('NOT_A_MEMBER', 'only owners and managers may subscribe', 403);
    }

    target.owner_user_id = userData.user.id;
  }

  const { data: saved, error: saveError } = await admin
    .from('push_subscriptions')
    .upsert(target, { onConflict: 'endpoint' })
    .select('id')
    .single();
  if (saveError) {
    return fail('STORE_FAILED', saveError.message, 500);
  }

  const subscriptionId = (saved as { id: string }).id;
  const pushConfigured = Boolean(
    Deno.env.get('VAPID_PUBLIC_KEY')?.trim() &&
      Deno.env.get('VAPID_PRIVATE_KEY')?.trim() &&
      Deno.env.get('VAPID_SUBJECT')?.trim(),
  );

  return jsonResponse({ subscriptionId, pushConfigured }, 200, cors);
});
