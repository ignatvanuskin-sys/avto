/**
 * All server communication, in one place.
 *
 * Two channels:
 *  * read-only RPCs called straight from the browser with the anon key
 *    (`public_tenant_profile`, `available_slots`);
 *  * Edge Functions for anything that needs a server secret — the booking
 *    access token, the LLM key, VAPID keys.
 *
 * Owner data is read through Row Level Security with the signed-in session;
 * every mutation goes through an RPC or an Edge Function.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { BACKEND_NOT_CONFIGURED, getSupabase } from './backend';
import { ApiError, toApiError } from './errors';
import type {
  AiUsageRow,
  AvailabilitySlot,
  BookingSummary,
  BookingView,
  NotificationJobRow,
  OwnerBookingRow,
  OwnerOccupancyRow,
  OwnerStats,
  OwnerTenantContext,
  PublicTenantProfile,
} from '@shared/tenant-types';

function client(): SupabaseClient {
  const supabase = getSupabase();
  if (!supabase) {
    throw new ApiError('BACKEND_NOT_CONFIGURED', BACKEND_NOT_CONFIGURED, 0);
  }
  return supabase;
}

export const isBackendReady = (): boolean => getSupabase() !== null;

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------
export async function fetchTenantProfile(slug: string): Promise<PublicTenantProfile | null> {
  const { data, error } = await client().rpc('public_tenant_profile', { p_slug: slug });
  if (error) throw toApiError(error);
  return (data as PublicTenantProfile | null) ?? null;
}

export async function fetchSlots(
  slug: string,
  serviceKey: string,
  from: string,
  to: string,
): Promise<AvailabilitySlot[]> {
  const { data, error } = await client().rpc('available_slots', {
    p_tenant_slug: slug,
    p_service_key: serviceKey,
    p_from: from,
    p_to: to,
  });
  if (error) throw toApiError(error);
  return (data ?? []) as AvailabilitySlot[];
}

// ---------------------------------------------------------------------------
// Edge Function channel
// ---------------------------------------------------------------------------
interface Envelope<T> {
  ok?: boolean;
  code?: string;
  message?: string;
  data?: T;
  error?: string;
}

async function invoke<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const supabase = client();
  const { data, error } = await supabase.functions.invoke(name, { body });

  if (error) {
    // supabase-js wraps a non-2xx response; try to read our envelope out of it.
    const context = (error as { context?: Response }).context;
    if (context) {
      try {
        const parsed = (await context.json()) as Envelope<T>;
        throw new ApiError(
          parsed.code ?? 'UNKNOWN',
          parsed.message ?? parsed.error ?? error.message,
          context.status,
        );
      } catch (inner) {
        if (inner instanceof ApiError) throw inner;
      }
    }
    throw toApiError(error);
  }

  const envelope = data as Envelope<T> | null;
  if (envelope && envelope.ok === false) {
    throw new ApiError(envelope.code ?? 'UNKNOWN', envelope.message ?? 'Request failed', 400);
  }
  return (envelope && 'data' in envelope ? (envelope.data as T) : (data as T));
}

export interface CreateBookingInput {
  slug: string;
  serviceKey: string;
  startsAt: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  comment?: string;
  preferredResourceId?: string;
  idempotencyKey: string;
}

export interface CreateBookingResult extends BookingSummary {
  accessToken: string;
}

export function createBooking(input: CreateBookingInput): Promise<CreateBookingResult> {
  return invoke<CreateBookingResult>('booking', { action: 'create', ...input });
}

export function getBooking(token: string): Promise<BookingView> {
  return invoke<BookingView>('booking', { action: 'get', token });
}

export function rescheduleBooking(
  token: string,
  startsAt: string,
  idempotencyKey: string,
): Promise<BookingSummary> {
  return invoke<BookingSummary>('booking', {
    action: 'reschedule',
    token,
    startsAt,
    idempotencyKey,
  });
}

export function cancelBooking(
  token: string,
  reason: string,
  idempotencyKey: string,
): Promise<BookingSummary> {
  return invoke<BookingSummary>('booking', { action: 'cancel', token, reason, idempotencyKey });
}

/** ICS is an extra channel: it never replaces the in-app confirmation. */
export function bookingIcsUrl(token: string): string | null {
  const base = import.meta.env.VITE_SUPABASE_URL?.trim();
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/functions/v1/booking-ics?token=${encodeURIComponent(token)}`;
}

export interface AiTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiReply {
  reply: string;
  /** Slots the assistant resolved through an allowed server tool, if any. */
  slots?: Array<{ startAt: string; resourceName: string }>;
  intent?: string;
  scope: 'client' | 'owner';
  model?: string;
  degraded?: boolean;
}

export function askAssistant(input: {
  slug: string;
  scope: 'client' | 'owner';
  message: string;
  history?: AiTurn[];
  serviceKey?: string;
}): Promise<AiReply> {
  return invoke<AiReply>('ai-assistant', input);
}

export function subscribeToPush(input: {
  slug: string;
  audience: 'customer' | 'owner';
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  token?: string;
  userAgent?: string;
}): Promise<{ subscriptionId: string }> {
  return invoke<{ subscriptionId: string }>('push-subscribe', input);
}

// ---------------------------------------------------------------------------
// Owner reads (RLS-scoped, no RPC needed)
// ---------------------------------------------------------------------------
export async function fetchOwnerContext(): Promise<OwnerTenantContext[]> {
  const { data, error } = await client().rpc('owner_tenant_context');
  if (error) throw toApiError(error);
  return (data ?? []) as OwnerTenantContext[];
}

export async function fetchOwnerStats(
  tenantId: string,
  from: string,
  to: string,
): Promise<OwnerStats> {
  const { data, error } = await client().rpc('owner_stats', {
    p_tenant_id: tenantId,
    p_from: from,
    p_to: to,
  });
  if (error) throw toApiError(error);
  return data as OwnerStats;
}

export async function fetchOwnerBookings(
  tenantId: string,
  fromIso: string,
  toIso: string,
): Promise<OwnerBookingRow[]> {
  const { data, error } = await client()
    .from('bookings')
    .select(
      `id, display_number, starts_at, ends_at, status, price_cents, currency, is_demo,
       service:services!bookings_service_fk ( name ),
       resource:resources!bookings_resource_fk ( name ),
       customer:customers!bookings_customer_fk ( name, phone )`,
    )
    .eq('tenant_id', tenantId)
    .gte('starts_at', fromIso)
    .lt('starts_at', toIso)
    .order('starts_at', { ascending: true })
    .limit(400);

  if (error) throw toApiError(error);

  return (data ?? []).map((row) => {
    const record = row as unknown as {
      id: string;
      display_number: number;
      starts_at: string;
      ends_at: string;
      status: OwnerBookingRow['status'];
      price_cents: number;
      currency: string;
      is_demo: boolean;
      service: { name: string } | null;
      resource: { name: string } | null;
      customer: { name: string; phone: string } | null;
    };
    return {
      id: record.id,
      display_number: record.display_number,
      starts_at: record.starts_at,
      ends_at: record.ends_at,
      status: record.status,
      price_cents: record.price_cents,
      currency: record.currency,
      service_name: record.service?.name ?? '—',
      resource_name: record.resource?.name ?? null,
      customer_name: record.customer?.name ?? null,
      customer_phone: record.customer?.phone ?? null,
      is_demo: record.is_demo,
    };
  });
}

export async function fetchOwnerOccupancies(
  tenantId: string,
  fromIso: string,
  toIso: string,
): Promise<OwnerOccupancyRow[]> {
  const { data, error } = await client()
    .from('resource_occupancies')
    .select('id, resource_id, kind, block_reason, period, resource:resources!resource_occupancies_resource_fk ( name )')
    .eq('tenant_id', tenantId)
    .overlaps('period', `[${fromIso},${toIso})`)
    .order('period', { ascending: true })
    .limit(400);

  if (error) throw toApiError(error);

  return (data ?? []).map((row) => {
    const record = row as unknown as {
      id: string;
      resource_id: string;
      kind: 'booking' | 'block';
      block_reason: string | null;
      period: string;
      resource: { name: string } | null;
    };
    const [startsAt, endsAt] = parsePgRange(record.period);
    return {
      id: record.id,
      resource_id: record.resource_id,
      resource_name: record.resource?.name ?? null,
      kind: record.kind,
      block_reason: record.block_reason,
      period: record.period,
      starts_at: startsAt,
      ends_at: endsAt,
    };
  });
}

export async function fetchNotificationJobs(tenantId: string, limit = 60): Promise<NotificationJobRow[]> {
  const { data, error } = await client()
    .from('notification_jobs')
    .select('id, kind, channel, status, attempts, max_attempts, last_error, run_after, sent_at')
    .eq('tenant_id', tenantId)
    .order('run_after', { ascending: false })
    .limit(limit);

  if (error) throw toApiError(error);
  return (data ?? []) as NotificationJobRow[];
}

export async function fetchAiUsage(tenantId: string): Promise<AiUsageRow[]> {
  const { data, error } = await client()
    .from('ai_usage')
    .select('window_start, calls, prompt_tokens, completion_tokens')
    .eq('tenant_id', tenantId)
    .order('window_start', { ascending: false })
    .limit(14);

  if (error) throw toApiError(error);
  return (data ?? []) as AiUsageRow[];
}

/** `["2026-05-01 09:00:00+03","2026-05-01 10:30:00+03")` → [start, end] */
export function parsePgRange(range: string): [string, string] {
  const match = /^[[(]"?([^",]+)"?,"?([^",)]+)"?[)\]]$/.exec(range.trim());
  if (!match?.[1] || !match[2]) return [range, range];
  return [new Date(match[1]).toISOString(), new Date(match[2]).toISOString()];
}

// ---------------------------------------------------------------------------
// Owner mutations
// ---------------------------------------------------------------------------
export async function ownerBlockResource(input: {
  tenantId: string;
  resourceId: string;
  startsAt: string;
  endsAt: string;
  reason: string;
}): Promise<{ occupancyId: string }> {
  const { data, error } = await client().rpc('block_resource', {
    p_tenant_id: input.tenantId,
    p_resource_id: input.resourceId,
    p_starts_at: input.startsAt,
    p_ends_at: input.endsAt,
    p_reason: input.reason,
  });
  if (error) throw toApiError(error);
  return data as { occupancyId: string };
}

export async function ownerReleaseOccupancy(tenantId: string, occupancyId: string): Promise<void> {
  const { error } = await client().rpc('release_occupancy', {
    p_tenant_id: tenantId,
    p_occupancy_id: occupancyId,
  });
  if (error) throw toApiError(error);
}

export async function ownerSetServicePrice(
  tenantId: string,
  serviceKey: string,
  priceCents: number,
): Promise<void> {
  const { error } = await client().rpc('set_service_price', {
    p_tenant_id: tenantId,
    p_service_key: serviceKey,
    p_price_cents: priceCents,
  });
  if (error) throw toApiError(error);
}

export async function ownerSetServiceActive(
  tenantId: string,
  serviceKey: string,
  isActive: boolean,
): Promise<void> {
  const { error } = await client().rpc('set_service_active', {
    p_tenant_id: tenantId,
    p_service_key: serviceKey,
    p_is_active: isActive,
  });
  if (error) throw toApiError(error);
}

export async function ownerSetBusinessHours(
  tenantId: string,
  weekday: number,
  opensAt: string,
  closesAt: string,
  isClosed: boolean,
): Promise<void> {
  const { error } = await client().rpc('set_business_hours', {
    p_tenant_id: tenantId,
    p_weekday: weekday,
    p_opens_at: opensAt,
    p_closes_at: closesAt,
    p_is_closed: isClosed,
  });
  if (error) throw toApiError(error);
}

export async function ownerSetTenantStatus(
  tenantId: string,
  status: 'preview' | 'live' | 'suspended',
): Promise<{ status: string }> {
  const { data, error } = await client().rpc('set_tenant_status', {
    p_tenant_id: tenantId,
    p_status: status,
  });
  if (error) throw toApiError(error);
  return data as { status: string };
}

export async function ownerSetBookingStatus(
  tenantId: string,
  bookingId: string,
  status: 'confirmed' | 'in_progress' | 'completed' | 'cancelled' | 'no_show',
): Promise<void> {
  const { error } = await client().rpc('set_booking_status', {
    p_tenant_id: tenantId,
    p_booking_id: bookingId,
    p_status: status,
  });
  if (error) throw toApiError(error);
}

export async function ownerRecordPayment(input: {
  tenantId: string;
  bookingId: string;
  amountCents: number;
  method: 'cash' | 'card' | 'transfer' | 'online';
  status: 'paid' | 'pending' | 'refunded';
  note?: string;
}): Promise<void> {
  const { error } = await client().rpc('record_payment', {
    p_tenant_id: input.tenantId,
    p_booking_id: input.bookingId,
    p_amount_cents: input.amountCents,
    p_method: input.method,
    p_status: input.status,
    p_note: input.note ?? null,
    p_provider_ref: null,
  });
  if (error) throw toApiError(error);
}

export async function ownerUploadAsset(input: {
  tenantId: string;
  file: File;
  kind: string;
  alt?: string;
}): Promise<{ url: string }> {
  const supabase = client();
  const extension = input.file.name.split('.').pop() ?? 'bin';
  const objectPath = `${input.tenantId}/${input.kind}/${Date.now()}.${extension}`;

  const upload = await supabase.storage
    .from('tenant-assets')
    .upload(objectPath, input.file, { cacheControl: '604800', upsert: false });

  if (upload.error) throw toApiError(upload.error);

  const { data: publicUrl } = supabase.storage.from('tenant-assets').getPublicUrl(objectPath);

  const { error } = await supabase.rpc('upsert_tenant_asset', {
    p_tenant_id: input.tenantId,
    p_kind: input.kind,
    p_url: publicUrl.publicUrl,
    p_origin: 'owner',
    p_alt: input.alt ?? null,
    p_sort_order: 0,
    p_storage_path: objectPath,
  });
  if (error) throw toApiError(error);

  return { url: publicUrl.publicUrl };
}
