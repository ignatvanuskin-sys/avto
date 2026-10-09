import type { ResolvedAsset } from './tenant-config';
import type { ShellConfig } from './manifest';

export interface BundleRefs {
  /** Hashed entry script produced by the Vite build, e.g. `/assets/index-abc.js`. */
  script: string;
  /** Hashed stylesheets produced by the Vite build. */
  styles: string[];
  /** Hashed module preloads for the entry chunk. */
  preloads: string[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** JSON embedded in a <script> must not be able to close the tag. */
function escapeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
}

const STARTUP_MEDIA: Array<{ file: string; media: string }> = [
  {
    file: 'startup-1170x2532.png',
    media:
      '(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)',
  },
  {
    file: 'startup-1284x2778.png',
    media:
      '(device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3)',
  },
];

/**
 * The static HTML shell of one studio.
 *
 * Three things make this per-tenant rather than shared:
 *   * the metadata (title, description, theme colour, Open Graph);
 *   * the manifest / apple-touch / startup asset links;
 *   * the boot payload (`window.__TENANT__`) that tells the shared bundle which
 *     studio it is rendering.
 *
 * Deep links such as `/s/<slug>/booking/<id>` are served this same file — see
 * the generated `_redirects` — so a customer opening a link from a message
 * always lands in the right studio.
 */
export function buildTenantShellHtml(options: {
  shell: ShellConfig;
  assets: ResolvedAsset[];
  bundle: BundleRefs;
}): string {
  const { shell, assets, bundle } = options;

  const assetByKind = (kind: string) => assets.find((asset) => asset.kind === kind);

  const icon = assetByKind('icon');
  const appleTouch = assetByKind('apple-touch');
  const hero = assetByKind('hero');
  const logo = assetByKind('logo');

  const startupLinks = STARTUP_MEDIA.map(({ file, media }) => {
    const present = assets.some((asset) => asset.fileName === file);
    if (!present) return '';
    return `    <link rel="apple-touch-startup-image" href="${shell.basePath}assets/${file}" media="${media}" />`;
  })
    .filter(Boolean)
    .join('\n');

  const boot = {
    slug: shell.slug,
    basePath: shell.basePath,
    name: shell.name,
    locale: shell.locale,
    timezone: shell.timezone,
    currency: shell.currency,
    accentColor: shell.accentColor,
    accentForeground: shell.accentForeground,
    themeColor: shell.themeColor,
    configUrl: `${shell.basePath}config.json`,
    serviceWorkerUrl: shell.serviceWorkerUrl,
    serviceWorkerScope: shell.serviceWorkerScope,
    configHash: shell.configHash,
  };

  const styles = bundle.styles
    .map((href) => `    <link rel="stylesheet" href="${href}" />`)
    .join('\n');

  const preloads = bundle.preloads
    .map((href) => `    <link rel="modulepreload" href="${href}" />`)
    .join('\n');

  const description = shell.description ?? shell.tagline ?? `${shell.name} — онлайн-запись`;

  return `<!doctype html>
<html lang="${escapeHtml(shell.locale.split('-')[0] ?? 'ru')}" class="dark">
  <head>
    <meta charset="utf-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=5"
    />
    <title>${escapeHtml(shell.name)} — онлайн-запись</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="theme-color" content="${escapeHtml(shell.themeColor)}" />
    <meta name="color-scheme" content="dark" />
    <meta name="format-detection" content="telephone=no" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="${escapeHtml(shell.shortName)}" />

    <link rel="manifest" href="${shell.manifestUrl}" />
    <link rel="canonical" href="${shell.basePath}" />
    <link rel="icon" href="${icon?.url ?? `${shell.basePath}assets/icon-192.png`}" />
    <link rel="apple-touch-icon" href="${appleTouch?.url ?? `${shell.basePath}assets/apple-touch-180.png`}" />
${startupLinks}

    <meta property="og:type" content="website" />
    <meta property="og:title" content="${escapeHtml(shell.name)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${shell.basePath}" />
${hero ? `    <meta property="og:image" content="${hero.url}" />\n` : ''}${logo ? `    <meta property="og:logo" content="${logo.url}" />\n` : ''}    <meta name="twitter:card" content="summary_large_image" />

${styles}
${preloads}
    <script>
      window.__TENANT__ = ${escapeJson(boot)};
    </script>
  </head>
  <body class="bg-background text-foreground">
    <div id="root"></div>
    <noscript>
      <div style="padding:24px;font-family:system-ui">
        Для записи включите JavaScript или позвоните в студию.
      </div>
    </noscript>
    <script type="module" src="${bundle.script}"></script>
  </body>
</html>
`;
}

/**
 * A real 404 document.
 *
 * Without it the preview server and several static hosts answer an unknown path
 * with HTTP 200 and the fallback document, which hides broken links from both
 * users and crawlers. This page is standalone: no JS, no app boot, so it also
 * works when the bundle itself cannot load.
 */
export function buildNotFoundHtml(): string {
  return `<!doctype html>
<html lang="ru" class="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Страница не найдена</title>
    <meta name="robots" content="noindex" />
    <meta name="color-scheme" content="dark" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <style>
      body {
        margin: 0;
        min-height: 100dvh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #0b0b0c;
        color: #f5f5f5;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      main { padding: 24px; max-width: 32rem; }
      h1 { margin: 0 0 8px; font-size: 1.5rem; }
      p { margin: 0 0 16px; color: #a3a3a3; line-height: 1.5; }
      a { color: #ff6a00; }
    </style>
  </head>
  <body>
    <main>
      <h1>Страница не найдена</h1>
      <p>
        Такой страницы нет. Откройте список студий и запишитесь заново — это займёт меньше минуты.
      </p>
      <p><a href="/">← К списку студий</a></p>
    </main>
  </body>
</html>
`;
}

/**
 * Root `_redirects` for static hosts that honour it.
 *
 * Two layers of protection, because neither alone is enough:
 *   1. `tenant:finalize` writes a real `index.html` inside each known route
 *      directory, so hosts with directory-index resolution need no rules;
 *   2. these rules cover hosts that do NOT resolve directory indexes, and the
 *      `*` rules cover any deeper path a future route might introduce.
 *
 * The verified failure this prevents: a hard load of `/s/<slug>/owner` returned
 * the ROOT document, so the studio rendered with another studio's accent and no
 * tenant payload at all.
 */
export function buildRedirects(slugs: string[], routes: string[] = ['booking', 'owner']): string {
  const lines = [
    '# Generated by `npm run tenant:finalize`. Do not edit by hand.',
    '# Every studio keeps its own shell on a deep link, with or without a trailing slash.',
  ];

  for (const slug of slugs) {
    lines.push(`/s/${slug}  /s/${slug}/index.html  200`);
    lines.push(`/s/${slug}/  /s/${slug}/index.html  200`);

    for (const route of routes) {
      lines.push(`/s/${slug}/${route}  /s/${slug}/${route}/index.html  200`);
      lines.push(`/s/${slug}/${route}/  /s/${slug}/${route}/index.html  200`);
      lines.push(`/s/${slug}/${route}/*  /s/${slug}/${route}/index.html  200`);
    }

    // Anything else under the studio falls back to the studio's own shell, never
    // to another studio's and never to the root catalogue.
    lines.push(`/s/${slug}/*  /s/${slug}/index.html  200`);
  }

  lines.push('');
  return lines.join('\n');
}

export function buildHeaders(slugs: string[]): string {
  const lines = [
    '# Generated by `npm run tenant:finalize`. Do not edit by hand.',
    '',
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
    '/s/*/assets/*',
    '  Cache-Control: public, max-age=604800',
    '',
    '/s/*/sw.js',
    '  Cache-Control: no-cache',
    '  Service-Worker-Allowed: /',
    '',
    '/s/*/manifest.webmanifest',
    '  Content-Type: application/manifest+json',
    '  Cache-Control: no-cache',
    '',
    '/s/*/config.json',
    '  Cache-Control: no-cache',
    '',
    '/api/*',
    '  Cache-Control: no-store',
    '',
  ];
  // Explicit per-tenant service worker entries so the scope header can never be
  // lost to a wildcard rule.
  for (const slug of slugs) {
    lines.push(`/s/${slug}/sw.js`);
    lines.push('  Cache-Control: no-cache');
    lines.push('  Service-Worker-Allowed: /');
    lines.push('');
  }
  return lines.join('\n');
}
