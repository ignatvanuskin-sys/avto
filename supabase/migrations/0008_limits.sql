-- =============================================================================
-- 0008_limits.sql
-- Atomic shared counters for two budgets:
--   * public request budget  (protects the booking endpoint from abuse);
--   * LLM budget             (protects the AI assistant from runaway cost).
--
-- Both are single-statement upserts: the counter is read and incremented in one
-- atomic operation, so N concurrent requests can never exceed the limit by
-- racing. Booking must keep working when the AI budget is exhausted, which is
-- why the two budgets are completely independent.
-- =============================================================================

create table public.api_counters (
  bucket text not null,
  window_start timestamptz not null,
  count bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (bucket, window_start)
);

create index api_counters_window_idx on public.api_counters (window_start);

-- Returns true when the caller is still inside the budget. The increment and
-- the check happen in the same statement, so there is no window in which two
-- callers both observe "under the limit".
create or replace function public.consume_quota(
  p_bucket text,
  p_limit bigint,
  p_window_seconds integer
)
returns table (allowed boolean, used bigint, remaining bigint, resets_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window_seconds integer;
  v_window_start timestamptz;
  v_used bigint;
begin
  v_window_seconds := greatest(1, coalesce(p_window_seconds, 60));
  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / v_window_seconds) * v_window_seconds
  );

  insert into public.api_counters (bucket, window_start, count, updated_at)
  values (p_bucket, v_window_start, 1, now())
  on conflict (bucket, window_start)
    do update set count = public.api_counters.count + 1, updated_at = now()
  returning count into v_used;

  allowed := (p_limit is null or v_used <= greatest(0, p_limit));
  used := v_used;
  remaining := greatest(0, coalesce(p_limit, v_used) - v_used);
  resets_at := v_window_start + make_interval(secs => v_window_seconds);
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- LLM budget, tracked per tenant and per window so one studio cannot consume
-- the AI allowance of another.
-- ---------------------------------------------------------------------------
create table public.ai_usage (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  window_start timestamptz not null,
  calls bigint not null default 0,
  prompt_tokens bigint not null default 0,
  completion_tokens bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, window_start)
);

create or replace function public.consume_ai_budget(
  p_tenant_id uuid,
  p_call_limit bigint,
  p_window_seconds integer default 86400
)
returns table (allowed boolean, calls bigint, call_limit bigint, resets_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window_seconds integer;
  v_window_start timestamptz;
  v_calls bigint;
begin
  v_window_seconds := greatest(60, coalesce(p_window_seconds, 86400));
  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / v_window_seconds) * v_window_seconds
  );

  insert into public.ai_usage (tenant_id, window_start, calls, updated_at)
  values (p_tenant_id, v_window_start, 1, now())
  on conflict (tenant_id, window_start)
    do update set calls = public.ai_usage.calls + 1, updated_at = now()
  returning calls into v_calls;

  allowed := (p_call_limit is null or v_calls <= greatest(0, p_call_limit));
  calls := v_calls;
  call_limit := p_call_limit;
  resets_at := v_window_start + make_interval(secs => v_window_seconds);
  return next;
end;
$$;

-- Convenience wrapper used from inside the public RPCs: it consumes the shared
-- budget and turns an exhausted budget into a stable error code.
create or replace function app.enforce_rate_limit(
  p_bucket text,
  p_limit bigint,
  p_window_seconds integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_allowed boolean;
begin
  select q.allowed into v_allowed
  from public.consume_quota(p_bucket, p_limit, p_window_seconds) as q;

  if not coalesce(v_allowed, true) then
    raise exception 'BK011: too many requests, please try again shortly'
      using errcode = 'BK011';
  end if;
end;
$$;

revoke all on function app.enforce_rate_limit(text, bigint, integer) from public;

create or replace function public.record_ai_tokens(
  p_tenant_id uuid,
  p_prompt_tokens bigint,
  p_completion_tokens bigint
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.ai_usage (tenant_id, window_start, calls, prompt_tokens, completion_tokens, updated_at)
  values (
    p_tenant_id,
    date_trunc('day', now()),
    0,
    greatest(0, coalesce(p_prompt_tokens, 0)),
    greatest(0, coalesce(p_completion_tokens, 0)),
    now()
  )
  on conflict (tenant_id, window_start)
    do update set
      prompt_tokens = public.ai_usage.prompt_tokens + greatest(0, coalesce(p_prompt_tokens, 0)),
      completion_tokens = public.ai_usage.completion_tokens + greatest(0, coalesce(p_completion_tokens, 0)),
      updated_at = now();
$$;
