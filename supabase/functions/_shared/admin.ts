/**
 * Supabase clients and environment helpers for Edge Functions.
 *
 * Secrets are read from the environment only; none are hardcoded. A missing
 * variable fails loudly so a misconfigured deployment is obvious instead of
 * silently running with the wrong identity.
 */
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { timingSafeEqual } from './hash.ts';

/** Return the value of a required environment variable, or throw a clear error. */
export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing required environment variable: ${name}. Set it as a Supabase Edge Function secret.`,
    );
  }
  return value;
}

/**
 * Service-role client. Bypasses RLS and is the only identity allowed to drive
 * the notification outbox — never expose it to a browser.
 */
export function adminClient(): SupabaseClient {
  const url = requireEnv('SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * Anon client. When an `authorization` value is passed it is forwarded, so
 * RPCs such as `owner_tenant_context` run as that signed-in user.
 */
export function anonClient(authorization?: string): SupabaseClient {
  const url = requireEnv('SUPABASE_URL');
  const anonKey = requireEnv('SUPABASE_ANON_KEY');
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(authorization ? { global: { headers: { Authorization: authorization } } } : {}),
  });
}

/**
 * Worker authorization for the cron-driven endpoints.
 *
 * Primary check: the `x-cron-secret` header equals CRON_SECRET (constant-time).
 * Secondary check: a Supabase Cron invocation that forwards the service-role
 * bearer token is also accepted, so the same endpoint serves both callers.
 */
export function isCronAuthorized(req: Request): boolean {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || secret.trim() === '') {
    return false;
  }

  const provided = req.headers.get('x-cron-secret');
  if (provided !== null && timingSafeEqual(provided, secret)) {
    return true;
  }

  const authorization = req.headers.get('authorization');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (authorization && serviceRoleKey && authorization === `Bearer ${serviceRoleKey}`) {
    return true;
  }

  return false;
}
