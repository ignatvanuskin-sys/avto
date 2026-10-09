import type { BusinessConfigParsed } from '../../src/shared/business-schema';
import type { ResolvedAsset } from './tenant-config';
import { tenantPublicPath } from './paths';

export interface WebAppManifest {
  id: string;
  name: string;
  short_name: string;
  description?: string;
  lang: string;
  dir: 'ltr' | 'rtl';
  start_url: string;
  scope: string;
  display: string;
  orientation: string;
  background_color: string;
  theme_color: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
}

function mimeFor(format: string): string {
  switch (format) {
    case 'png':
      return 'image/png';
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'avif':
      return 'image/avif';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

/**
 * One manifest per studio.
 *
 * `id`, `start_url` and `scope` are all tenant-scoped, which is what makes two
 * studios installable side by side as two separate applications instead of one
 * overwriting the other.
 */
export function buildManifest(
  config: BusinessConfigParsed,
  assets: ResolvedAsset[],
): WebAppManifest {
  const base = `${tenantPublicPath(config.slug)}/`;

  // Only square, purpose-built icons belong in the manifest. A wide brand
  // logo declared as an install icon gets letterboxed or cropped by the OS, so
  // it is deliberately excluded from `icons` even though it stays a public asset.
  const icons = assets
    .filter((asset) => asset.kind === 'icon' || asset.kind === 'maskable')
    .map((asset) => ({
      src: asset.url,
      sizes: `${asset.width}x${asset.height}`,
      type: mimeFor(asset.format),
      purpose: asset.kind === 'maskable' ? 'maskable' : 'any',
    }));

  // A square apple-touch icon is a perfectly good regular icon too; including it
  // keeps Android installs working for a tenant that ships a minimal asset set.
  const appleTouch = assets.find((asset) => asset.kind === 'apple-touch');
  if (appleTouch && !icons.some((icon) => icon.sizes === '180x180')) {
    icons.push({
      src: appleTouch.url,
      sizes: '180x180',
      type: mimeFor(appleTouch.format),
      purpose: 'any',
    });
  }

  return {
    id: base,
    name: config.name,
    short_name: config.shortName ?? config.name.slice(0, 24),
    ...(config.description ? { description: config.description } : {}),
    lang: config.locale.split('-')[0] ?? 'ru',
    dir: 'ltr',
    start_url: base,
    scope: base,
    display: config.pwa.display,
    orientation: config.pwa.orientation,
    background_color: config.branding.backgroundColor,
    theme_color: config.branding.themeColor ?? config.branding.backgroundColor,
    icons,
  };
}

/** Metadata-only projection used by the static shell and the root directory. */
export function buildShellConfig(
  config: BusinessConfigParsed,
  assets: ResolvedAsset[],
  hash: string,
) {
  const base = `${tenantPublicPath(config.slug)}/`;
  const hero = assets.find((asset) => asset.kind === 'hero');
  const logo = assets.find((asset) => asset.kind === 'logo');

  return {
    slug: config.slug,
    name: config.name,
    shortName: config.shortName ?? config.name.slice(0, 24),
    tagline: config.tagline ?? null,
    description: config.description ?? null,
    locale: config.locale,
    timezone: config.timezone,
    currency: config.currency,
    accentColor: config.branding.accentColor,
    accentForeground: config.branding.accentForeground,
    themeColor: config.branding.themeColor ?? config.branding.backgroundColor,
    backgroundColor: config.branding.backgroundColor,
    basePath: base,
    heroUrl: hero?.url ?? null,
    heroAlt: hero?.alt ?? null,
    logoUrl: logo?.url ?? null,
    manifestUrl: `${base}manifest.webmanifest`,
    serviceWorkerUrl: `${base}sw.js`,
    serviceWorkerScope: base,
    configHash: hash,
  };
}

export type ShellConfig = ReturnType<typeof buildShellConfig>;
