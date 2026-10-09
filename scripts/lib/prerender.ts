/**
 * Static content for a studio shell.
 *
 * Why this exists: the application is a client-rendered SPA, so the HTML a host
 * serves contains an empty `<div id="root">` and nothing else — no studio name,
 * no prices, no phone number. Anything that does not execute JavaScript (a link
 * preview, a crawler, a moderation bot checking the site attached to a 2GIS
 * business card) therefore sees an empty page, and a customer on a slow
 * connection watches a blank screen until 700+ KB of JS arrives.
 *
 * This module renders the studio's published configuration into real, semantic
 * HTML. React replaces the contents of `#root` when it mounts, so the result is
 * a fast first paint plus a crawler-readable document, with no SSR build.
 */

interface PrerenderAsset {
  kind?: unknown;
  url?: unknown;
  alt?: unknown;
}

interface PrerenderService {
  key?: unknown;
  name?: unknown;
  description?: unknown;
  durationMin?: unknown;
  priceCents?: unknown;
  currency?: unknown;
  category?: unknown;
  imageUrl?: unknown;
}

interface PrerenderHours {
  weekday?: unknown;
  opensAt?: unknown;
  closesAt?: unknown;
  isClosed?: unknown;
}

interface PrerenderPayload {
  slug?: unknown;
  name?: unknown;
  tagline?: unknown;
  description?: unknown;
  address?: unknown;
  mapUrl?: unknown;
  currency?: unknown;
  timezone?: unknown;
  locale?: unknown;
  contacts?: Record<string, unknown>;
  services?: PrerenderService[];
  hours?: PrerenderHours[];
  assets?: PrerenderAsset[];
}

const WEEKDAY_NAMES: Record<number, string> = {
  1: 'Понедельник',
  2: 'Вторник',
  3: 'Среда',
  4: 'Четверг',
  5: 'Пятница',
  6: 'Суббота',
  7: 'Воскресенье',
};

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** JSON inside a <script> must not be able to close the tag. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
}

function formatMoney(cents: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return `${Math.round(cents / 100)} ${currency}`;
  }
}

function formatDuration(minutes: number): string {
  if (minutes <= 0) return '';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    return restHours === 0 ? `${days} сут` : `${days} сут ${restHours} ч`;
  }
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

export interface PrerenderResult {
  /** Markup that goes inside `<div id="root">`. */
  content: string;
  /** schema.org JSON-LD describing the business. */
  structuredData: string;
}

export function buildPrerender(payload: PrerenderPayload, basePath: string): PrerenderResult {
  const name = str(payload.name, 'Студия');
  const locale = str(payload.locale, 'ru-RU');
  const currency = str(payload.currency, 'RUB');
  const contacts = payload.contacts ?? {};
  const phone = str(contacts.phone);
  const address = str(payload.address);
  const mapUrl = str(payload.mapUrl);
  const tagline = str(payload.tagline);
  const description = str(payload.description);

  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  const hero = assets.find((asset) => str(asset.kind) === 'hero');
  const gallery = assets.filter((asset) => str(asset.kind) === 'gallery');

  const services = (Array.isArray(payload.services) ? payload.services : []).filter(
    (service) => str(service.name).length > 0,
  );

  const hours = (Array.isArray(payload.hours) ? payload.hours : []).filter(
    (row) => num(row.weekday) >= 1 && num(row.weekday) <= 7,
  );

  const serviceItems = services
    .map((service) => {
      const image = str(service.imageUrl);
      const price = num(service.priceCents);
      const duration = formatDuration(num(service.durationMin));
      return `<li>
        ${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(str(service.name))}" width="800" height="600" loading="lazy" decoding="async" />` : ''}
        <h3>${escapeHtml(str(service.name))}</h3>
        ${str(service.description) ? `<p>${escapeHtml(str(service.description))}</p>` : ''}
        <p>${[duration, formatMoney(price, currency, locale)].filter(Boolean).map(escapeHtml).join(' · ')}</p>
      </li>`;
    })
    .join('\n');

  const hoursRows = hours
    .map((row) => {
      const weekday = WEEKDAY_NAMES[num(row.weekday)] ?? '';
      const value = row.isClosed === true ? 'выходной' : `${str(row.opensAt)}–${str(row.closesAt)}`;
      return `<tr><th scope="row">${escapeHtml(weekday)}</th><td>${escapeHtml(value)}</td></tr>`;
    })
    .join('\n');

  const content = `<div class="pp">
  <header>
    ${hero?.url ? `<img src="${escapeHtml(str(hero.url))}" alt="${escapeHtml(str(hero.alt) || name)}" width="1600" height="900" />` : ''}
    <h1>${escapeHtml(name)}</h1>
    ${tagline ? `<p>${escapeHtml(tagline)}</p>` : ''}
    ${description ? `<p>${escapeHtml(description)}</p>` : ''}
  </header>
  <main>
    ${services.length ? `<section><h2>Услуги</h2><ul>${serviceItems}</ul></section>` : ''}
    ${hoursRows ? `<section><h2>Часы работы</h2><table><tbody>${hoursRows}</tbody></table></section>` : ''}
    ${
      gallery.length
        ? `<section><h2>Фотографии</h2>${gallery
            .map(
              (asset) =>
                `<img src="${escapeHtml(str(asset.url))}" alt="${escapeHtml(str(asset.alt) || name)}" width="1200" height="800" loading="lazy" decoding="async" />`,
            )
            .join('\n')}</section>`
        : ''
    }
    ${
      phone || address
        ? `<section><h2>Контакты</h2>
            ${phone ? `<p><a href="tel:${escapeHtml(phone.replace(/[^+\d]/g, ''))}">${escapeHtml(phone)}</a></p>` : ''}
            ${address ? `<p>${escapeHtml(address)}</p>` : ''}
            ${mapUrl ? `<p><a href="${escapeHtml(mapUrl)}">Показать на карте</a></p>` : ''}
          </section>`
        : ''
    }
    <p><a href="${escapeHtml(basePath)}booking/">Моя запись</a></p>
  </main>
</div>`;

  const structuredData = jsonForScript({
    '@context': 'https://schema.org',
    '@type': 'AutoRepair',
    name,
    ...(description ? { description } : {}),
    ...(phone ? { telephone: phone } : {}),
    ...(address
      ? { address: { '@type': 'PostalAddress', streetAddress: address } }
      : {}),
    ...(str(payload.timezone) ? {} : {}),
    url: basePath,
    ...(hero?.url ? { image: str(hero.url) } : {}),
    makesOffer: services.map((service) => ({
      '@type': 'Offer',
      itemOffered: { '@type': 'Service', name: str(service.name) },
      price: num(service.priceCents) / 100,
      priceCurrency: currency,
    })),
    openingHoursSpecification: hours
      .filter((row) => row.isClosed !== true)
      .map((row) => ({
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: `https://schema.org/${
          ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][
            num(row.weekday) - 1
          ] ?? 'Monday'
        }`,
        opens: str(row.opensAt),
        closes: str(row.closesAt),
      })),
  });

  return { content, structuredData };
}

/**
 * Styles for the prerendered block.
 *
 * Kept inline and minimal: it must render correctly before any stylesheet has
 * been applied, and React removes it on mount. Colours come from the studio's
 * branding so the first paint matches the app instead of flashing white.
 */
export function buildPrerenderStyles(accent: string, background: string): string {
  return `    <style>
      .pp { max-width: 42rem; margin: 0 auto; padding: 16px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #f5f5f5; background: ${escapeHtml(background)}; }
      .pp h1 { font-size: 1.6rem; margin: 12px 0 4px; }
      .pp h2 { font-size: 1.15rem; margin: 20px 0 8px; color: ${escapeHtml(accent)}; }
      .pp h3 { font-size: 1rem; margin: 8px 0 4px; }
      .pp p { margin: 4px 0; color: #a3a3a3; line-height: 1.5; }
      .pp img { width: 100%; height: auto; border-radius: 12px; background: #171717; }
      .pp ul { list-style: none; padding: 0; margin: 0; }
      .pp li { padding: 12px; margin-bottom: 12px; border: 1px solid #262626; border-radius: 12px; }
      .pp table { width: 100%; border-collapse: collapse; }
      .pp th, .pp td { text-align: left; padding: 6px 0; font-weight: 400; color: #a3a3a3; }
      .pp a { color: ${escapeHtml(accent)}; }
    </style>`;
}
