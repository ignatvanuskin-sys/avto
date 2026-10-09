/**
 * notifications-dispatch — the transactional outbox worker.
 *
 * Invoked by Supabase Cron (see `cron-tick`) or by any trusted caller that
 * presents `x-cron-secret`. It claims a leased batch of `notification_jobs`,
 * renders the message for the booking, delivers it (Web Push or an ICS body),
 * and always reports the outcome back through `complete_notification_job`.
 *
 * A single malformed job must never abort the batch: every job is handled in
 * its own try/catch.
 */
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { adminClient, isCronAuthorized } from '../_shared/admin.ts';
import { corsHeaders, handleOptions, jsonResponse, requestOrigin } from '../_shared/cors.ts';
import { buildIcs } from '../_shared/ics.ts';
import { sendWebPush, type VapidConfig } from '../_shared/webpush.ts';

const CLAIM_LIMIT = 25;
const LEASE_SECONDS = 90;

type JobKind =
  | 'booking_created'
  | 'booking_rescheduled'
  | 'booking_cancelled'
  | 'reminder_24h'
  | 'reminder_2h';
type JobChannel = 'push' | 'ics' | 'email';
type Audience = 'customer' | 'owner';

interface NotificationJob {
  id: string;
  tenant_id: string;
  booking_id: string | null;
  kind: JobKind;
  channel: JobChannel;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: 'preview' | 'live' | 'suspended';
  timezone: string;
  locale: string;
  address: string | null;
}

interface BookingRow {
  id: string;
  customer_id: string;
  display_number: number;
  service_name_snapshot: string;
  starts_at: string;
  ends_at: string;
  status: string;
  customer_comment: string | null;
}

interface CustomerRow {
  id: string;
  name: string;
  phone: string;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

type CompletedStatus = 'sent' | 'failed' | 'dead';

interface JobOutcome {
  status: CompletedStatus;
  deactivated: number;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read the VAPID configuration from the environment, or null when incomplete. */
function readVapidConfig(): VapidConfig | null {
  const publicKey = Deno.env.get('VAPID_PUBLIC_KEY')?.trim();
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY')?.trim();
  const subject = Deno.env.get('VAPID_SUBJECT')?.trim();
  if (!publicKey || !privateKey || !subject) {
    return null;
  }
  return { publicKey, privateKey, subject };
}

/** Report a job's outcome. Never throws: a failed report leaves the lease to expire. */
async function complete(
  supabase: SupabaseClient,
  jobId: string,
  success: boolean,
  error: string | null,
  retryDelaySeconds: number,
): Promise<CompletedStatus> {
  const { data, error: rpcError } = await supabase.rpc('complete_notification_job', {
    p_job_id: jobId,
    p_success: success,
    p_error: error,
    p_retry_delay_seconds: retryDelaySeconds,
  });
  if (rpcError) {
    // The lease will expire and the job will be reclaimed later.
    console.error(`complete_notification_job failed for ${jobId}: ${rpcError.message}`);
    return 'failed';
  }
  return (data as CompletedStatus | null) ?? 'failed';
}

async function fail(
  supabase: SupabaseClient,
  job: NotificationJob,
  reason: string,
  retryDelaySeconds = 600,
): Promise<JobOutcome> {
  const status = await complete(supabase, job.id, false, reason, retryDelaySeconds);
  return { status, deactivated: 0 };
}

function formatWhen(iso: string, timezone: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  try {
    return new Intl.DateTimeFormat(locale || 'ru-RU', {
      timeZone: timezone || 'UTC',
      weekday: 'short',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }
}

interface CopyVars {
  when: string;
  service: string;
  customer: string;
  studio: string;
}

/** Russian, user-facing notification copy for one kind/audience pair. */
function copyFor(kind: JobKind, audience: Audience, v: CopyVars): { title: string; body: string } {
  switch (kind) {
    case 'booking_created':
      return audience === 'owner'
        ? { title: 'Новая запись', body: `${v.customer}: ${v.service}, ${v.when}.` }
        : {
            title: 'Запись подтверждена',
            body: `${v.studio}: ${v.service}, ${v.when}. Ждём вас!`,
          };
    case 'booking_rescheduled':
      return audience === 'owner'
        ? { title: 'Запись перенесена', body: `${v.customer}: ${v.service}, новое время — ${v.when}.` }
        : { title: 'Запись перенесена', body: `${v.studio}: новое время — ${v.when}, ${v.service}.` };
    case 'booking_cancelled':
      return audience === 'owner'
        ? { title: 'Запись отменена', body: `${v.customer}: ${v.service}, ${v.when} — отменено.` }
        : { title: 'Запись отменена', body: `${v.studio}: запись на ${v.when} отменена.` };
    case 'reminder_24h':
      return { title: 'Напоминание о записи', body: `Завтра, ${v.when}: ${v.service}, ${v.studio}.` };
    case 'reminder_2h':
      return { title: 'Скоро запись', body: `Через 2 часа, ${v.when}: ${v.service}, ${v.studio}.` };
  }
}

/** Load the active subscriptions that a job must be delivered to. */
async function loadSubscriptions(
  supabase: SupabaseClient,
  tenantId: string,
  audience: Audience,
  bookingId: string,
): Promise<SubscriptionRow[]> {
  let query = supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('tenant_id', tenantId)
    .eq('audience', audience)
    .eq('is_active', true);

  query = audience === 'customer' ? query.eq('booking_id', bookingId) : query.is('booking_id', null);

  const { data, error } = await query;
  if (error) {
    throw new Error(`loading push_subscriptions failed: ${error.message}`);
  }
  return (data ?? []) as SubscriptionRow[];
}

async function deactivateSubscription(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase
    .from('push_subscriptions')
    .update({ is_active: false })
    .eq('id', id);
  if (error) {
    throw new Error(`deactivating subscription ${id} failed: ${error.message}`);
  }
}

async function processJob(supabase: SupabaseClient, job: NotificationJob): Promise<JobOutcome> {
  if (!job.booking_id) {
    return fail(supabase, job, 'job has no booking_id', 3600);
  }

  const tenantResult = await supabase
    .from('tenants')
    .select('id, slug, name, status, timezone, locale, address')
    .eq('id', job.tenant_id)
    .maybeSingle();
  if (tenantResult.error) {
    throw new Error(tenantResult.error.message);
  }
  const tenant = tenantResult.data as TenantRow | null;
  if (!tenant) {
    return fail(supabase, job, 'tenant not found', 3600);
  }

  // Preview (and suspended) studios must never send real notifications.
  if (tenant.status !== 'live') {
    return fail(
      supabase,
      job,
      `tenant status is '${tenant.status}'; real notifications are suppressed`,
      3600,
    );
  }

  const bookingResult = await supabase
    .from('bookings')
    .select(
      'id, customer_id, display_number, service_name_snapshot, starts_at, ends_at, status, customer_comment',
    )
    .eq('tenant_id', job.tenant_id)
    .eq('id', job.booking_id)
    .maybeSingle();
  if (bookingResult.error) {
    throw new Error(bookingResult.error.message);
  }
  const booking = bookingResult.data as BookingRow | null;
  if (!booking) {
    return fail(supabase, job, 'booking not found', 3600);
  }

  // The booking may have moved or been cancelled after the job was enqueued.
  const enqueuedStartsAt = typeof job.payload.startsAt === 'string' ? job.payload.startsAt : null;
  if (enqueuedStartsAt && Date.parse(enqueuedStartsAt) !== Date.parse(booking.starts_at)) {
    return fail(supabase, job, 'booking was moved after this job was enqueued', 3600);
  }
  if (booking.status === 'cancelled' && job.kind !== 'booking_cancelled') {
    return fail(supabase, job, 'booking was cancelled after this job was enqueued', 3600);
  }

  const customerResult = await supabase
    .from('customers')
    .select('id, name, phone')
    .eq('tenant_id', job.tenant_id)
    .eq('id', booking.customer_id)
    .maybeSingle();
  if (customerResult.error) {
    throw new Error(customerResult.error.message);
  }
  const customer = customerResult.data as CustomerRow | null;

  const audience: Audience = job.payload.audience === 'owner' ? 'owner' : 'customer';

  const subscriptions = await loadSubscriptions(
    supabase,
    job.tenant_id,
    audience,
    booking.id,
  );

  // Nothing to deliver to: close the job so the outbox does not spin.
  if (subscriptions.length === 0) {
    const status = await complete(supabase, job.id, true, null, 60);
    return { status, deactivated: 0 };
  }

  const vapid = readVapidConfig();
  if (!vapid) {
    return fail(
      supabase,
      job,
      'push is not configured: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT are missing',
    );
  }

  // Build the payload text for the channel.
  let payloadText: string;
  if (job.channel === 'ics') {
    // For the ICS channel the calendar body itself is the payload text.
    payloadText = buildIcs({
      uid: `${booking.id}@booking`,
      startsAt: booking.starts_at,
      endsAt: booking.ends_at,
      summary: `${booking.service_name_snapshot} — ${tenant.name}`,
      description: `Запись №${booking.display_number}`,
      location: tenant.address ?? tenant.name,
      cancelled: job.kind === 'booking_cancelled',
      stamp: new Date(),
    });
  } else if (job.channel === 'push') {
    const when = formatWhen(booking.starts_at, tenant.timezone, tenant.locale);
    const copy = copyFor(job.kind, audience, {
      when,
      service: booking.service_name_snapshot,
      customer: customer?.name ?? 'Клиент',
      studio: tenant.name,
    });
    payloadText = JSON.stringify({ ...copy, url: '/', tag: `${job.kind}:${booking.id}` });
  } else {
    return fail(supabase, job, `channel '${job.channel}' is not configured`, 3600);
  }

  let delivered = 0;
  let deactivated = 0;
  const errors: string[] = [];

  for (const subscription of subscriptions) {
    const result = await sendWebPush(
      { endpoint: subscription.endpoint, p256dh: subscription.p256dh, auth: subscription.auth },
      payloadText,
      vapid,
    );
    if (result.ok) {
      delivered += 1;
      continue;
    }
    if (result.expired) {
      await deactivateSubscription(supabase, subscription.id);
      deactivated += 1;
      errors.push(`subscription ${subscription.id} expired (${result.status})`);
      continue;
    }
    errors.push(`subscription ${subscription.id}: ${result.error ?? `status ${result.status}`}`);
  }

  if (delivered > 0) {
    const status = await complete(supabase, job.id, true, null, 60);
    return { status, deactivated };
  }

  const status = await complete(supabase, job.id, false, errors.join('; ').slice(0, 500), 300);
  return { status, deactivated };
}

serve(async (req: Request): Promise<Response> => {
  const origin = requestOrigin(req);
  if (req.method === 'OPTIONS') {
    return handleOptions(req);
  }
  if (!isCronAuthorized(req)) {
    return jsonResponse(
      { ok: false, code: 'UNAUTHORIZED', message: 'invalid or missing x-cron-secret' },
      401,
      corsHeaders(origin),
    );
  }

  let supabase: SupabaseClient;
  try {
    supabase = adminClient();
  } catch (error) {
    return jsonResponse(
      { ok: false, code: 'NOT_CONFIGURED', message: toMessage(error) },
      500,
      corsHeaders(origin),
    );
  }

  const worker = `dispatch-${crypto.randomUUID()}`;
  const { data, error } = await supabase.rpc('claim_notification_jobs', {
    p_limit: CLAIM_LIMIT,
    p_lease_seconds: LEASE_SECONDS,
    p_worker: worker,
  });
  if (error) {
    return jsonResponse(
      { ok: false, code: 'CLAIM_FAILED', message: error.message },
      500,
      corsHeaders(origin),
    );
  }

  const jobs = (data ?? []) as NotificationJob[];
  let sent = 0;
  let failed = 0;
  let dead = 0;
  let deactivated = 0;

  const tally = (status: CompletedStatus): void => {
    if (status === 'sent') sent += 1;
    else if (status === 'dead') dead += 1;
    else failed += 1;
  };

  for (const job of jobs) {
    try {
      const outcome = await processJob(supabase, job);
      tally(outcome.status);
      deactivated += outcome.deactivated;
    } catch (error) {
      // One bad job must never abort the batch.
      const message = toMessage(error).slice(0, 500);
      try {
        const status = await complete(supabase, job.id, false, `handler error: ${message}`, 300);
        tally(status);
      } catch {
        tally('failed');
      }
    }
  }

  return jsonResponse(
    { claimed: jobs.length, sent, failed, dead, deactivated },
    200,
    corsHeaders(origin),
  );
});
