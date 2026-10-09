/**
 * Service-worker registration and privacy plumbing.
 *
 * Two rules matter here:
 *   * the worker is registered for the studio's own scope, so two studios on the
 *     same origin never share a worker or a cache;
 *   * anything private is removed when the owner signs out, and API responses
 *     are never cached in the first place (see src/pwa/sw.ts).
 */
import { readBootPayload } from '@/tenant/TenantProvider';

export type UpdateState = 'idle' | 'ready' | 'applied' | 'unsupported' | 'failed';

export interface ServiceWorkerHandle {
  supported: boolean;
  state: UpdateState;
  applyUpdate: () => void;
}

export function registerStudioServiceWorker(): ServiceWorkerHandle {
  const boot = readBootPayload();

  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !boot) {
    return { supported: false, state: 'unsupported', applyUpdate: () => undefined };
  }

  let registration: ServiceWorkerRegistration | null = null;

  void navigator.serviceWorker
    .register(boot.serviceWorkerUrl, { scope: boot.serviceWorkerScope })
    .then((registered) => {
      registration = registered;

      registered.addEventListener('updatefound', () => {
        const installing = registered.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            // A new worker is waiting; the app decides when to take it.
            window.dispatchEvent(new CustomEvent('studio-sw-update-ready'));
          }
        });
      });
    })
    .catch(() => {
      window.dispatchEvent(new CustomEvent('studio-sw-failed'));
    });

  const applyUpdate = (): void => {
    const waiting = registration?.waiting;
    if (!waiting) return;
    waiting.postMessage({ type: 'SKIP_WAITING' });
    window.location.reload();
  };

  return { supported: true, state: 'idle', applyUpdate };
}

/**
 * Called on owner logout. Drops runtime caches and any cached private state so
 * a signed-out device cannot serve the previous user's data.
 */
export async function clearPrivateState(): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      const controller = navigator.serviceWorker.controller;
      controller?.postMessage({ type: 'CLEAR_PRIVATE_CACHES' });
    }

    if (typeof caches !== 'undefined') {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name.startsWith('booking-') && !name.endsWith('-precache')).map((name) => caches.delete(name)),
      );
    }
  } catch {
    // Clearing is best effort; never block a sign-out on it.
  }

  try {
    window.localStorage.removeItem('booking-owner-auth');
    window.sessionStorage.removeItem('booking-flow-state');
  } catch {
    // Storage can be unavailable in private mode.
  }
}

/** Ask for notification permission and create a push subscription. */
export async function createPushSubscription(): Promise<PushSubscriptionJSON | null> {
  const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY?.trim();
  if (!vapidPublicKey) return null;
  if (typeof Notification === 'undefined') return null;
  if (Notification.permission === 'denied') return null;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return null;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    // PushManager wants a strictly ArrayBuffer-backed view; the array is freshly
    // allocated in urlBase64ToUint8Array, so this narrowing is safe.
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as unknown as BufferSource,
  });

  return subscription.toJSON();
}

export function supportsPush(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    Boolean(import.meta.env.VITE_VAPID_PUBLIC_KEY)
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(normalized);
  // Explicit ArrayBuffer backing: PushManager rejects a Uint8Array whose buffer
  // could be a SharedArrayBuffer.
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output;
}
