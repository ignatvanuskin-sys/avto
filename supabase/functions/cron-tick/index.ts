// cron-tick — the single scheduled entry point.
//
// Runs on a Supabase Cron schedule and does two things:
//   1. `enqueue_due_reminders(p_window_minutes => 5)` turns bookings that are
//      24h / 2h away into outbox rows (idempotent, deduplicated in SQL);
//   2. invokes the notification dispatcher once to drain the outbox.
//
// Expected Supabase Cron schedule (every five minutes):
//
//   */5 * * * *
//
// Example schedule registration (run once in the SQL editor):
//
//   select cron.schedule('cron-tick', '*/5 * * * *', $job$
//     select net.http_post(
//       url := 'https://<project-ref>.supabase.co/functions/v1/cron-tick',
//       headers := jsonb_build_object(
//         'x-cron-secret', '<CRON_SECRET>',
//         'Content-Type', 'application/json'
//       ),
//       body := '{}'::jsonb
//     );
//   $job$);
//
// Authentication is the same `x-cron-secret` header used by the dispatcher.
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { adminClient, isCronAuthorized, requireEnv } from '../_shared/admin.ts';
import { corsHeaders, handleOptions, jsonResponse, requestOrigin } from '../_shared/cors.ts';

const REMINDER_WINDOW_MINUTES = 5;

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Invoke the dispatcher over HTTP with the shared cron secret. */
async function invokeDispatcher(): Promise<unknown> {
  const baseUrl = requireEnv('SUPABASE_URL').replace(/\/+$/, '');
  const secret = requireEnv('CRON_SECRET');
  try {
    const response = await fetch(`${baseUrl}/functions/v1/notifications-dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cron-secret': secret },
      body: JSON.stringify({ trigger: 'cron-tick' }),
    });
    const body: unknown = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, error: toMessage(error) };
  }
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

  const { data, error } = await supabase.rpc('enqueue_due_reminders', {
    p_window_minutes: REMINDER_WINDOW_MINUTES,
  });
  if (error) {
    return jsonResponse(
      { ok: false, code: 'ENQUEUE_FAILED', message: error.message },
      500,
      corsHeaders(origin),
    );
  }

  const dispatch = await invokeDispatcher();

  return jsonResponse(
    { enqueued: typeof data === 'number' ? data : 0, dispatch },
    200,
    corsHeaders(origin),
  );
});
