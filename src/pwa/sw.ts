/**
 * The one service worker source for the whole product.
 *
 * vite-plugin-pwa compiles this file with `injectManifest`, replacing
 * `self.__WB_MANIFEST` with the real precache list of the shared bundle. The
 * two placeholders below are then substituted once per studio by
 * `npm run tenant:finalize`, so a single compiled worker becomes one worker per
 * studio with its own scope and its own cache namespace.
 *
 * Caching policy, deliberately narrow:
 *   * the shared bundle is precached;
 *   * studio photography is cached at runtime on first use;
 *   * API traffic — including anything authenticated — is never cached, so no
 *     private data can end up in a cache that outlives a logout.
 *
 * Types: the project's tsconfig uses the DOM lib, so instead of pulling in the
 * WebWorker lib (which would collide globally) this file declares the small
 * facade it actually touches.
 */

const TENANT_SCOPE = '__TENANT_SCOPE__';
const TENANT_CACHE = '__TENANT_CACHE__';

const PRECACHE = `${TENANT_CACHE}-precache`;
const RUNTIME = `${TENANT_CACHE}-runtime`;

declare global {
  /**
   * Injected by vite-plugin-pwa `injectManifest` at build time.
   *
   * Declared as a global so the literal `self.__WB_MANIFEST` can appear in the
   * source — workbox locates the injection point by searching for that exact
   * text, so it must not be hidden behind an aliased variable.
   */
  var __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
}

interface SwEvent {
  waitUntil(promise: Promise<unknown>): void;
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
  data: unknown;
  clientId?: string;
}

interface SwClient {
  url?: string;
  focus(): Promise<SwClient>;
  postMessage(message: unknown): void;
}

interface SwScope {
  addEventListener(type: string, handler: (event: SwEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: {
    claim(): Promise<void>;
    matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<SwClient[]>;
    openWindow(url: string): Promise<SwClient | null>;
  };
  registration: {
    showNotification(title: string, options?: Record<string, unknown>): Promise<void>;
    scope: string;
  };
  caches: CacheStorage;
}

const worker = self as unknown as SwScope;

/** Requests that must never be served from, or written to, a cache. */
function isPrivateRequest(request: Request, url: URL): boolean {
  if (request.headers.has('authorization') || request.headers.has('apikey')) {
    return true;
  }
  const pathname = url.pathname;
  return (
    pathname.startsWith('/rest/') ||
    pathname.startsWith('/auth/') ||
    pathname.startsWith('/functions/') ||
    pathname.startsWith('/realtime/') ||
    pathname.startsWith('/storage/v1/object/authenticated/') ||
    pathname.includes('/api/') ||
    url.searchParams.has('token')
  );
}

function isCacheableAsset(url: URL): boolean {
  return (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith(`${TENANT_SCOPE}assets/`) ||
    url.pathname.endsWith('.woff2') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.webp')
  );
}

async function precacheBundle(): Promise<void> {
  const cache = await worker.caches.open(PRECACHE);
  const entries = self.__WB_MANIFEST ?? [];

  await Promise.all(
    entries.map(async (entry) => {
      const url = entry.revision && !entry.url.includes('?')
        ? `${entry.url}?__wb_rev=${entry.revision}`
        : entry.url;
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch {
        // A single missing optional asset must not break the install.
      }
    }),
  );
}

/** Drop every cache this studio owned that is no longer current. */
async function pruneOwnCaches(): Promise<void> {
  const names = await worker.caches.keys();
  await Promise.all(
    names
      .filter((name) => name.startsWith(`${TENANT_CACHE}-`))
      .filter((name) => name !== PRECACHE && name !== RUNTIME)
      .map((name) => worker.caches.delete(name)),
  );
}

worker.addEventListener('install', (event) => {
  // No skipWaiting here on purpose: the application decides when to activate an
  // update, so a running booking flow is never swapped out mid-flight.
  event.waitUntil(precacheBundle());
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await worker.clients.claim();
      await pruneOwnCaches();
    })(),
  );
});

worker.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Cross-origin (the Supabase project) is always network-only.
  if (url.origin !== self.location.origin) return;

  if (isPrivateRequest(request, url)) return;

  // Navigations: always try the network so a customer sees fresh availability,
  // then fall back to the cached studio shell when offline.
  if (request.mode === 'navigate') {
    if (!url.pathname.startsWith(TENANT_SCOPE)) return;

    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const cache = await worker.caches.open(RUNTIME);
            await cache.put(`${TENANT_SCOPE}index.html`, response.clone());
          }
          return response;
        } catch {
          const cache = await worker.caches.open(RUNTIME);
          const cached =
            (await cache.match(`${TENANT_SCOPE}index.html`)) ??
            (await worker.caches.match(`${TENANT_SCOPE}index.html`));
          if (cached) return cached;
          return new Response(
            '<!doctype html><meta charset="utf-8"><title>Нет сети</title><p style="font-family:system-ui;padding:24px">Нет соединения. Откройте приложение, когда сеть появится.',
            { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
          );
        }
      })(),
    );
    return;
  }

  if (!isCacheableAsset(url)) return;

  event.respondWith(
    (async () => {
      const cached =
        (await worker.caches.match(request)) ??
        (await (await worker.caches.open(PRECACHE)).match(request));
      if (cached) return cached;

      const response = await fetch(request);
      if (response.ok) {
        const cache = await worker.caches.open(RUNTIME);
        await cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});

/**
 * Push is an extra channel, never the only one. Nothing here changes the fact
 * that the customer also receives the booking details in the interface and can
 * add the appointment to a calendar.
 */
worker.addEventListener('push', (event) => {
  const payload = readPushPayload(event.data);

  event.waitUntil(
    worker.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      data: { url: payload.url },
      icon: payload.icon,
      badge: payload.badge,
      requireInteraction: false,
    }),
  );
});

worker.addEventListener('notificationclick', (event) => {
  const data = (event as unknown as { notification?: { data?: { url?: string } } }).notification
    ?.data;
  const target = data?.url ?? TENANT_SCOPE;

  event.waitUntil(
    (async () => {
      const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        if (client.url && client.url.includes(TENANT_SCOPE)) {
          await client.focus();
          return;
        }
      }
      await worker.clients.openWindow(target);
    })(),
  );
});

worker.addEventListener('message', (event) => {
  const message = event.data as { type?: string } | null;
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'SKIP_WAITING') {
    event.waitUntil(worker.skipWaiting());
    return;
  }

  if (message.type === 'CLEAR_PRIVATE_CACHES') {
    // Called by the app on logout. Runtime caches may hold studio data the
    // signed-out user should no longer see; the precached bundle stays.
    event.waitUntil(
      (async () => {
        const names = await worker.caches.keys();
        await Promise.all(
          names
            .filter((name) => name.startsWith(`${TENANT_CACHE}-`))
            .filter((name) => name !== PRECACHE)
            .map((name) => worker.caches.delete(name)),
        );
      })(),
    );
  }
});

interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  icon?: string;
  badge?: string;
}

function readPushPayload(raw: unknown): PushPayload {
  const fallback: PushPayload = {
    title: 'Запись',
    body: 'Откройте приложение, чтобы посмотреть детали.',
    url: TENANT_SCOPE,
    tag: 'booking',
  };

  if (!raw || typeof raw !== 'object' || !('json' in raw) || typeof raw.json !== 'function') {
    return fallback;
  }

  try {
    const parsed = (raw as { json(): unknown }).json();
    if (!parsed || typeof parsed !== 'object') return fallback;

    const record = parsed as Record<string, unknown>;
    return {
      title: typeof record.title === 'string' ? record.title : fallback.title,
      body: typeof record.body === 'string' ? record.body : fallback.body,
      url: typeof record.url === 'string' ? record.url : fallback.url,
      tag: typeof record.tag === 'string' ? record.tag : fallback.tag,
      ...(typeof record.icon === 'string' ? { icon: record.icon } : {}),
      ...(typeof record.badge === 'string' ? { badge: record.badge } : {}),
    };
  } catch {
    return fallback;
  }
}
