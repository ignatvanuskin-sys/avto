/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Public VAPID key used to create a browser push subscription. */
  readonly VITE_VAPID_PUBLIC_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Injected into every studio shell by `npm run tenant:finalize`. */
interface TenantBootPayload {
  slug: string;
  basePath: string;
  name: string;
  locale: string;
  timezone: string;
  currency: string;
  accentColor: string;
  accentForeground: string;
  themeColor: string;
  configUrl: string;
  serviceWorkerUrl: string;
  serviceWorkerScope: string;
  configHash: string;
}

interface Window {
  __TENANT__?: TenantBootPayload;
}
