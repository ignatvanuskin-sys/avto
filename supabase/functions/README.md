# Supabase Edge Functions

Server-side pieces of the booking PWA. Each function lives in its own folder as
`<name>/index.ts`, imports the shared helpers from `_shared/`, and is deployed
independently.

The `_shared/` folder is **not** a deployable function — it is bundled into the
functions that import it:

| File | Purpose |
| --- | --- |
| `_shared/cors.ts` | `corsHeaders(origin)`, `jsonResponse(body, status, extraHeaders)`, `handleOptions(req)`, `requestOrigin(req)`. Only origins listed in `ALLOWED_ORIGINS` are echoed; `*` is never returned with credentials. |
| `_shared/admin.ts` | `requireEnv(name)`, `adminClient()` (service role), `anonClient(authorization?)`, `isCronAuthorized(req)`. |
| `_shared/hash.ts` | `sha256Hex(value)`, `tokenHashBytea(token)`, `timingSafeEqual(a, b)`. |
| `_shared/ics.ts` | Pure iCalendar builders: `buildIcs(event)`, `foldIcsLine(line)`, `escapeIcsText(value)`, `toIcsUtc(date)`. |
| `_shared/webpush.ts` | `sendWebPush(subscription, payload, vapid)` — dependency-free RFC 8291 / 8188 / 8292 Web Push. |

## Required secrets

Read from the environment only; nothing is hardcoded. Set them once with
`supabase secrets set` (Supabase also injects `SUPABASE_URL`, `SUPABASE_ANON_KEY`
and `SUPABASE_SERVICE_ROLE_KEY` automatically):

| Secret | Used by | Meaning |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | all browser-facing functions | Comma-separated allow-list of origins that may call the functions. |
| `CRON_SECRET` | `cron-tick`, `notifications-dispatch` | Shared secret required in the `x-cron-secret` header. |
| `VAPID_PUBLIC_KEY` | `push-subscribe`, `notifications-dispatch` | base64url uncompressed P-256 public key (65 bytes). |
| `VAPID_PRIVATE_KEY` | `notifications-dispatch` | base64url P-256 private scalar. |
| `VAPID_SUBJECT` | `notifications-dispatch` | VAPID JWT `sub` claim, e.g. `mailto:ops@example.com`. |

> No secret value belongs in this file or anywhere else in the repository.

When `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` are absent,
`push-subscribe` still stores the subscription but returns
`"pushConfigured": false`, and the dispatcher fails the push job with a clear
`last_error` instead of silently dropping it.

---

## `booking-ics`

Download a booking as an iCalendar file (RFC 5545).

- **Method / path**: `GET /functions/v1/booking-ics?token=<access-token>`
  (add `&format=json` for the JSON representation of the same event).
- **Auth**: none beyond the booking access token. The token is hashed as
  `sha256(token)` hex (bytea `\x`-literal) and resolved with the public
  `get_booking_by_token` RPC.
- **Secrets**: `ALLOWED_ORIGINS`.
- **Success**: `200`,
  `Content-Type: text/calendar; charset=utf-8`,
  `Content-Disposition: attachment; filename="booking-<displayNumber>.ics"`,
  `Cache-Control: no-store`. CRLF line endings, 75-octet folding, `DTSTART`/
  `DTEND` in UTC `Z` form, `STATUS:CANCELLED` (+ `METHOD:CANCEL`) when cancelled.
- **`format=json`**: `200` with
  `{ bookingId, displayNumber, status, tenantSlug, tenantName, timezone, startsAt, endsAt, summary, description, location, cancelled, uid }`.
- **Errors**: `{ "ok": false, "code": "TOKEN_REQUIRED" }`, `TOKEN_INVALID` (404).

```bash
supabase functions deploy booking-ics
```

## `push-subscribe`

Register a browser push subscription.

- **Method / path**: `POST /functions/v1/push-subscribe`.
- **Auth**:
  - `audience: "customer"` — the request must carry the booking `token`; the
    subscription is bound to that booking.
  - `audience: "owner"` — the request must carry the caller's `Authorization:
    Bearer <jwt>` header; membership is verified with `owner_tenant_context` via
    an anon client that forwards the header, and only `owner`/`manager` roles are
    accepted.
- **Secrets**: `ALLOWED_ORIGINS` (VAPID keys are optional here).
- **Request body**:

```json
{
  "slug": "akzhol-motors",
  "audience": "customer",
  "subscription": { "endpoint": "https://...", "keys": { "p256dh": "...", "auth": "..." } },
  "token": "<booking access token>",
  "userAgent": "Mozilla/5.0 ..."
}
```

- **Success**: `200` `{ "subscriptionId": "<uuid>", "pushConfigured": true|false }`.
  The insert uses `on conflict (endpoint) do update`, so re-subscribing the same
  browser refreshes the row instead of duplicating it.
- **Errors**: `{ "ok": false, "code": "...", "message": "..." }` with codes
  `SLUG_REQUIRED`, `AUDIENCE_INVALID`, `ENDPOINT_REQUIRED`, `KEYS_REQUIRED`,
  `TOKEN_REQUIRED`, `TOKEN_INVALID` (404), `TENANT_NOT_FOUND` (404),
  `UNAUTHENTICATED` (401), `NOT_A_MEMBER` (403).

```bash
supabase functions deploy push-subscribe
```

## `notifications-dispatch`

The transactional outbox worker.

- **Method / path**: `POST /functions/v1/notifications-dispatch`.
- **Auth**: `x-cron-secret` must equal `CRON_SECRET` (constant-time compare).
  A Supabase Cron invocation that forwards the service-role bearer token is also
  accepted. Otherwise the function replies `401`.
- **Secrets**: `CRON_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
  `VAPID_SUBJECT` (the VAPID trio is only needed once there is something to
  push).
- **Behaviour**:
  1. `claim_notification_jobs(p_limit := 25, p_lease_seconds := 90, p_worker := ...)`;
  2. per job it loads the booking, tenant and customer with the service role;
  3. it fails the job with a clear `last_error` when the tenant is not `live`
     (preview studios must never send real notifications) or when the booking
     was cancelled/moved after the job was enqueued;
  4. for the `push` channel it sends to the matching `push_subscriptions`
     (`job.payload->>'audience'`) via `sendWebPush` and sets `is_active = false`
     on subscriptions that answer 404/410; for the `ics` channel the calendar
     body is the notification payload text;
  5. it always finishes with `complete_notification_job(p_job_id, p_success,
     p_error, p_retry_delay_seconds)`.
- **Response**: `200` `{ "claimed": n, "sent": n, "failed": n, "dead": n, "deactivated": n }`.
  A single bad job never aborts the batch.
- **Errors**: `401` `UNAUTHORIZED`, `500` `NOT_CONFIGURED` / `CLAIM_FAILED`.

```bash
supabase functions deploy notifications-dispatch
```

## `cron-tick`

The single scheduled entry point (Supabase Cron, `*/5 * * * *`).

- **Method / path**: `POST /functions/v1/cron-tick`.
- **Auth**: same `x-cron-secret` header as the dispatcher.
- **Secrets**: `CRON_SECRET` (+ the auto-injected Supabase values).
- **Behaviour**: calls `enqueue_due_reminders(p_window_minutes := 5)`, then
  invokes the notification dispatcher once over HTTP with the shared secret.
- **Response**: `200` `{ "enqueued": n, "dispatch": { "ok": true, "status": 200, "body": { ... } } }`.
- **Errors**: `401` `UNAUTHORIZED`, `500` `NOT_CONFIGURED` / `ENQUEUE_FAILED`.

```bash
supabase functions deploy cron-tick
```

---

## Deploying everything

```bash
supabase functions deploy booking-ics
supabase functions deploy push-subscribe
supabase functions deploy notifications-dispatch
supabase functions deploy cron-tick
```

Set the secrets (values supplied out of band — never committed):

```bash
supabase secrets set \
  ALLOWED_ORIGINS=... \
  CRON_SECRET=... \
  VAPID_PUBLIC_KEY=... \
  VAPID_PRIVATE_KEY=... \
  VAPID_SUBJECT=...
```

### Type checking

The Edge Functions use Deno globals and `https://` module specifiers, which the
root `tsconfig.json` cannot resolve, so `supabase/functions` is excluded from the
repository-wide `tsc`. A minimal `supabase/functions/tsconfig.json` describes the
intended compiler settings; the authoritative check for these files is Deno's
own `deno check`. The pure modules (`_shared/ics.ts`, `_shared/hash.ts`,
`_shared/webpush.ts`) avoid Deno APIs and can be unit-tested in a plain runtime.
