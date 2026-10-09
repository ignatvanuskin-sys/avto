/**
 * booking-ics — download a booking as an iCalendar file.
 *
 * GET /functions/v1/booking-ics?token=<access-token>
 * GET /functions/v1/booking-ics?token=<access-token>&format=json
 *
 * The booking is resolved with the same token scheme as the `booking` function
 * (`sha256(token)` hex, passed as a bytea hash to `get_booking_by_token`). The
 * response is never cached and is served as an attachment.
 */
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { adminClient, anonClient } from '../_shared/admin.ts';
import { corsHeaders, handleOptions, jsonResponse, requestOrigin } from '../_shared/cors.ts';
import { buildIcs, type IcsEvent } from '../_shared/ics.ts';
import { tokenHashBytea } from '../_shared/hash.ts';

interface BookingByToken {
  bookingId: string;
  displayNumber: number;
  tenantSlug: string;
  tenantName: string;
  timezone: string;
  status: string;
  startsAt: string;
  endsAt: string;
  serviceName: string;
  resourceName: string | null;
  customerName: string | null;
  customerComment: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

serve(async (req: Request): Promise<Response> => {
  const origin = requestOrigin(req);
  const cors = corsHeaders(origin);
  const fail = (code: string, message: string, status: number): Response =>
    jsonResponse({ ok: false, code, message }, status, cors);

  if (req.method === 'OPTIONS') {
    return handleOptions(req);
  }
  if (req.method !== 'GET') {
    return fail('METHOD_NOT_ALLOWED', 'use GET', 405);
  }

  const url = new URL(req.url);
  const token = url.searchParams.get('token')?.trim() ?? '';
  const format = url.searchParams.get('format');
  if (!token) {
    return fail('TOKEN_REQUIRED', 'token query parameter is required', 400);
  }

  const tokenHash = await tokenHashBytea(token);
  const { data, error } = await anonClient().rpc('get_booking_by_token', {
    p_token_hash: tokenHash,
  });
  if (error) {
    return fail('RPC_FAILED', error.message, 500);
  }
  if (!isRecord(data) || typeof data.bookingId !== 'string') {
    return fail('TOKEN_INVALID', 'no booking matches this token', 404);
  }
  const booking = data as unknown as BookingByToken;

  // The address (LOCATION) and locale are not part of the public RPC projection.
  let address: string | null = null;
  try {
    const admin: SupabaseClient = adminClient();
    const tenantResult = await admin
      .from('tenants')
      .select('address')
      .eq('slug', booking.tenantSlug)
      .maybeSingle();
    const tenant = tenantResult.data as { address: string | null } | null;
    address = tenant?.address ?? null;
  } catch {
    // A missing address only degrades LOCATION; it must not break the download.
    address = null;
  }

  const cancelled = booking.status === 'cancelled';
  const event: IcsEvent = {
    uid: `${booking.bookingId}@booking`,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    summary: `${booking.serviceName} — ${booking.tenantName}`,
    description: buildDescription(booking),
    location: address ?? booking.tenantName,
    cancelled,
    stamp: new Date(),
  };

  if (format === 'json') {
    return jsonResponse(
      {
        bookingId: booking.bookingId,
        displayNumber: booking.displayNumber,
        status: booking.status,
        tenantSlug: booking.tenantSlug,
        tenantName: booking.tenantName,
        timezone: booking.timezone,
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
        summary: event.summary,
        description: event.description ?? null,
        location: event.location ?? null,
        cancelled,
        uid: event.uid,
      },
      200,
      { ...cors, 'Cache-Control': 'no-store' },
    );
  }

  const body = buildIcs(event);

  return new Response(body, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="booking-${booking.displayNumber}.ics"`,
      'Cache-Control': 'no-store',
    },
  });
});

function buildDescription(booking: BookingByToken): string {
  const parts = [`Запись №${booking.displayNumber} в ${booking.tenantName}.`];
  parts.push(`Услуга: ${booking.serviceName}.`);
  if (booking.resourceName) {
    parts.push(`Место: ${booking.resourceName}.`);
  }
  if (booking.customerComment) {
    parts.push(`Комментарий: ${booking.customerComment}`);
  }
  return parts.join(' ');
}
