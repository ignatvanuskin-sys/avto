/**
 * Adapts `published-config.json` into the same shape the database RPC returns,
 * so screens never branch on where the data came from — they only branch on
 * whether booking is possible.
 */
import type { PublicAsset, PublicService, PublicTenantProfile } from '@shared/tenant-types';

interface PublishedService {
  key?: unknown;
  name?: unknown;
  description?: unknown;
  durationMin?: unknown;
  bufferBeforeMin?: unknown;
  bufferAfterMin?: unknown;
  priceCents?: unknown;
  currency?: unknown;
  requiredResourceKind?: unknown;
  category?: unknown;
  imageUrl?: unknown;
  spansDays?: unknown;
  isActive?: unknown;
}

interface PublishedConfig {
  slug?: unknown;
  name?: unknown;
  tagline?: unknown;
  description?: unknown;
  status?: unknown;
  timezone?: unknown;
  locale?: unknown;
  currency?: unknown;
  accentColor?: unknown;
  accentForeground?: unknown;
  address?: unknown;
  mapUrl?: unknown;
  contacts?: Record<string, unknown>;
  booking?: Record<string, unknown>;
  ai?: Record<string, unknown>;
  resources?: unknown[];
  services?: PublishedService[];
  hours?: unknown[];
  assets?: unknown[];
}

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const strOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const bool = (value: unknown, fallback = false): boolean =>
  typeof value === 'boolean' ? value : fallback;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function adaptService(raw: PublishedService): PublicService | null {
  const key = str(raw.key);
  const name = str(raw.name);
  if (!key || !name) return null;

  return {
    key,
    name,
    description: strOrNull(raw.description),
    durationMin: num(raw.durationMin),
    bufferBeforeMin: num(raw.bufferBeforeMin),
    bufferAfterMin: num(raw.bufferAfterMin),
    priceCents: num(raw.priceCents),
    currency: str(raw.currency, 'RUB'),
    category: strOrNull(raw.category),
    imageUrl: strOrNull(raw.imageUrl),
    spansDays: bool(raw.spansDays),
    resourceKind: str(raw.requiredResourceKind),
  };
}

function adaptAssets(raw: unknown[]): PublicAsset[] {
  return raw
    .filter(isRecord)
    .map((asset) => ({
      kind: str(asset.kind),
      url: strOrNull(asset.url),
      alt: strOrNull(asset.alt),
    }))
    .filter((asset) => asset.kind.length > 0);
}

export async function fetchPublishedProfile(
  slug: string,
  basePath: string,
): Promise<PublicTenantProfile | null> {
  let response: Response;
  try {
    response = await fetch(`${basePath}published-config.json`, { cache: 'no-cache' });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let raw: PublishedConfig;
  try {
    raw = (await response.json()) as PublishedConfig;
  } catch {
    return null;
  }

  // A snapshot for a different studio must never be rendered under this shell.
  if (str(raw.slug) !== slug) return null;

  const contacts = isRecord(raw.contacts) ? raw.contacts : {};
  const booking = isRecord(raw.booking) ? raw.booking : {};
  const ai = isRecord(raw.ai) ? raw.ai : {};

  const services = (Array.isArray(raw.services) ? raw.services : [])
    .map(adaptService)
    .filter((service): service is PublicService => service !== null);

  const hours = (Array.isArray(raw.hours) ? raw.hours : [])
    .filter(isRecord)
    .map((row) => ({
      weekday: num(row.weekday),
      opensAt: str(row.opensAt, '09:00'),
      closesAt: str(row.closesAt, '09:00'),
      isClosed: bool(row.isClosed),
    }))
    .filter((row) => row.weekday >= 1 && row.weekday <= 7);

  const resources = (Array.isArray(raw.resources) ? raw.resources : [])
    .filter(isRecord)
    .map((row) => ({ key: str(row.key), name: str(row.name), kind: str(row.kind) }))
    .filter((row) => row.key.length > 0);

  const status = str(raw.status, 'preview');
  const normalisedStatus: PublicTenantProfile['status'] =
    status === 'live' || status === 'suspended' ? status : 'preview';

  return {
    // Not a database id; the `published:` prefix keeps that unambiguous.
    id: `published:${slug}`,
    slug,
    name: str(raw.name, slug),
    tagline: strOrNull(raw.tagline),
    description: strOrNull(raw.description),
    status: normalisedStatus,
    timezone: str(raw.timezone, 'UTC'),
    locale: str(raw.locale, 'ru-RU'),
    currency: str(raw.currency, 'RUB'),
    accentColor: str(raw.accentColor, '#ff6a00'),
    accentForeground: str(raw.accentForeground, '#0b0b0c'),
    contactPhone: strOrNull(contacts.phone),
    contactEmail: strOrNull(contacts.email),
    contactWhatsapp: strOrNull(contacts.whatsapp),
    contactTelegram: strOrNull(contacts.telegram),
    address: strOrNull(raw.address),
    mapUrl: strOrNull(raw.mapUrl),
    booking: {
      leadMinutes: num(booking.leadMinutes, 60),
      horizonDays: num(booking.horizonDays, 45),
      slotStepMinutes: num(booking.slotStepMinutes, 30),
      minCancelNoticeMinutes: num(booking.minCancelNoticeMinutes, 120),
    },
    ai: { enabled: bool(ai.enabled) },
    assets: adaptAssets(Array.isArray(raw.assets) ? raw.assets : []),
    services,
    resources,
    hours,
  };
}
