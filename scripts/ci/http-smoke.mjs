#!/usr/bin/env node
/**
 * http-smoke — regression check against a running `vite preview`.
 *
 * It exists because several defects in this project are only visible over HTTP:
 * a deep link that serves the wrong studio's shell, a referenced-but-missing
 * favicon that silently returns HTML, a manifest that advertises a non-square
 * icon. `npm run tenant:verify` inspects the files on disk; this checks what a
 * browser would actually receive.
 *
 *   npx vite preview --port 4173 &
 *   node scripts/ci/http-smoke.mjs
 */
const base = process.env.SMOKE_BASE_URL ?? 'http://localhost:4173';

/**
 * Route deep links are requested WITH a trailing slash.
 *
 * `vite preview` resolves a directory index only for the trailing-slash form and
 * otherwise applies its SPA fallback. Real static hosts differ: Cloudflare Pages
 * resolves `/dir` to `/dir/index.html` on its own, and the generated `_redirects`
 * covers the rest. Requesting the slash form therefore tests what the deployable
 * artifact actually contains, instead of testing the preview server's quirk.
 */
const targets = [
  ['/s/graphite-detailing/', 'studio shell (graphite)'],
  ['/s/graphite-detailing/booking/', 'deep link /booking (graphite)'],
  ['/s/graphite-detailing/owner/', 'deep link /owner (graphite)'],
  ['/s/akzhol-motors/owner/', 'deep link /owner (akzhol)'],
  ['/s/akzhol-motors/booking/', 'deep link /booking (akzhol)'],
  ['/s/graphite-detailing/manifest.webmanifest', 'manifest (graphite)'],
  ['/s/akzhol-motors/manifest.webmanifest', 'manifest (akzhol)'],
  ['/favicon.svg', 'favicon'],
  ['/tenants.json', 'studio directory'],
];

function extract(html, pattern) {
  const match = pattern.exec(html);
  return match?.[1] ?? null;
}

let failures = 0;

for (const [path, label] of targets) {
  let response;
  try {
    response = await fetch(`${base}${path}`);
  } catch (error) {
    console.log(`ERR  ${path} — ${error.message}`);
    failures += 1;
    continue;
  }

  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();
  const title = extract(body, /<title>([^<]*)<\/title>/) ?? '-';
  const bootSlug = extract(body, /__TENANT__[^;]*?"slug":"([a-z0-9-]+)"/);

  const details = [`${response.status}`, contentType.split(';')[0].padEnd(24), `title="${title}"`];
  if (bootSlug) details.push(`tenant=${bootSlug}`);
  if (contentType.includes('json') && path.endsWith('manifest.webmanifest')) {
    const manifest = JSON.parse(body);
    const square = manifest.icons.every((icon) => {
      const [w, h] = String(icon.sizes).split('x').map(Number);
      return w === h;
    });
    details.push(`icons=${manifest.icons.length} allSquare=${square} scope=${manifest.scope}`);
  }

  console.log(`${label.padEnd(30)} ${details.join('  ')}`);

  // The regression that started this file: a deep link must carry its own studio.
  const expectsStudio = path.includes('/s/') && !path.endsWith('manifest.webmanifest') && !path.endsWith('tenants.json');
  if (expectsStudio) {
    const expectedSlug = /^\/s\/([^/]+)/.exec(path)?.[1];
    if (bootSlug !== expectedSlug) {
      console.log(`  FAIL expected tenant=${expectedSlug}, got ${bootSlug ?? 'none'}`);
      failures += 1;
    }
  }

  if (path === '/favicon.svg' && !contentType.includes('svg')) {
    console.log(`  FAIL favicon served as ${contentType}`);
    failures += 1;
  }
}

console.log(failures === 0 ? '\nAll HTTP smoke checks passed.' : `\n${failures} HTTP smoke check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
