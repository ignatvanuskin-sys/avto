/**
 * Backend wiring.
 *
 * The application never invents data. When the Supabase project is not
 * configured the screens show an explicit "backend not configured" state
 * instead of a plausible-looking mock, so a missing deployment can never be
 * mistaken for a working integration.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

export const backendConfig = {
  url: url ?? null,
  hasAnonKey: Boolean(anonKey),
  /** True only when both values are present and look usable. */
  get isConfigured(): boolean {
    return Boolean(url && anonKey && url.startsWith('http'));
  },
  vapidPublicKey: import.meta.env.VITE_VAPID_PUBLIC_KEY?.trim() ?? null,
};

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!backendConfig.isConfigured || !url || !anonKey) {
    return null;
  }
  cached ??= createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: 'booking-owner-auth',
    },
  });
  return cached;
}

export const BACKEND_NOT_CONFIGURED =
  'Supabase не подключён: задайте VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY и пересоберите приложение.';
