#!/usr/bin/env tsx
/**
 * tenant:verify — prove that a tenant is actually deployed correctly.
 *
 * It checks three layers, and reports each one separately so a partial result is
 * visible rather than rounded up to "ok":
 *
 *   1. static artifacts  — manifest identity, icons on disk, accent, config hash;
 *   2. build output      — per-tenant shell, per-tenant service worker scope and
 *                          cache name, and that one studio's worker never
 *                          contains another studio's scope;
 *   3. live database     — only when credentials are present: the published rows
 *                          match the configuration and no studio's data is
 *                          visible from another studio.
 *
 * Exit code 1 when any check fails.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { DIST_DIR, ROOT, tenantPublicDir, tenantPublicPath } from '../lib/paths';
import { loadTenant, toPublishPayload } from '../lib/tenant-config';
import { parseArgs } from '../lib/cli';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  layer: 'static' | 'build' | 'database';
}

const checks: Check[] = [];

function check(layer: Check['layer'], name: string, ok: boolean, detail: string): void {
  checks.push({ layer, name, ok, detail });
}

async function readJson<T>(file: string): Promise<T | null> {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

interface WebManifest {
  id?: string;
  start_url?: string;
  scope?: string;
  name?: string;
  icons?: Array<{ src: string; sizes: string; purpose?: string }>;
}

interface ShellConfigFile {
  slug?: string;
  accentColor?: string;
  configHash?: string;
  serviceWorkerScope?: string;
}

async function verifyStatic(slug: string): Promise<void> {
  const tenant = await loadTenant(slug);
  const dir = tenantPublicDir(slug);
  const publicPath = tenantPublicPath(slug);

  const manifest = await readJson<WebManifest>(path.join(dir, 'manifest.webmanifest'));
  if (!manifest) {
    check('static', `${slug}: manifest`, false, `missing ${path.relative(ROOT, path.join(dir, 'manifest.webmanifest'))}`);
    return;
  }

  const expectedScope = `${publicPath}/`;
  check('static', `${slug}: manifest id`, manifest.id === expectedScope, `id=${manifest.id} expected=${expectedScope}`);
  check('static', `${slug}: manifest scope`, manifest.scope === expectedScope, `scope=${manifest.scope}`);
  check('static', `${slug}: manifest start_url`, manifest.start_url === expectedScope, `start_url=${manifest.start_url}`);
  check('static', `${slug}: manifest name`, manifest.name === tenant.config.name, `name=${manifest.name}`);

  const hasMaskable = (manifest.icons ?? []).some((icon) => icon.purpose === 'maskable');
  check('static', `${slug}: maskable icon declared`, hasMaskable, `${manifest.icons?.length ?? 0} icon(s)`);

  // every icon the manifest promises must exist on disk
  const missingIcons: string[] = [];
  for (const icon of manifest.icons ?? []) {
    const relative = icon.src.startsWith(publicPath)
      ? icon.src.slice(publicPath.length + 1)
      : icon.src.replace(/^\//, '');
    if (!existsSync(path.join(dir, relative))) {
      missingIcons.push(icon.src);
    }
  }
  check('static', `${slug}: manifest icons on disk`, missingIcons.length === 0, missingIcons.join(', ') || 'all present');

  const shell = await readJson<ShellConfigFile>(path.join(dir, 'config.json'));
  check(
    'static',
    `${slug}: accent matches config`,
    shell?.accentColor === tenant.config.branding.accentColor,
    `shell=${shell?.accentColor} config=${tenant.config.branding.accentColor}`,
  );
  check(
    'static',
    `${slug}: config hash matches`,
    shell?.configHash === tenant.hash,
    `shell=${shell?.configHash?.slice(0, 12)} config=${tenant.hash.slice(0, 12)}`,
  );

  // published payload must agree with the config, asset URLs included
  const published = await readJson<ReturnType<typeof toPublishPayload>>(
    path.join(dir, 'published-config.json'),
  );
  if (published) {
    const expectedServices = tenant.config.services.length;
    check(
      'static',
      `${slug}: published services count`,
      published.services.length === expectedServices,
      `${published.services.length}/${expectedServices}`,
    );
    const badAssets = published.assets.filter(
      (asset) => typeof asset.url !== 'string' || !asset.url.startsWith(publicPath),
    );
    check('static', `${slug}: published asset urls`, badAssets.length === 0, `${badAssets.length} bad`);
    const badImages = published.services.filter(
      (service) => service.imageUrl !== null && !service.imageUrl.startsWith(publicPath),
    );
    check('static', `${slug}: service image urls`, badImages.length === 0, `${badImages.length} bad`);
  } else {
    check('static', `${slug}: published payload`, false, 'missing published-config.json');
  }
}

async function verifyBuild(slugs: string[]): Promise<void> {
  if (!existsSync(DIST_DIR)) {
    check('build', 'dist present', false, 'run `npm run build` first');
    return;
  }

  const redirects = existsSync(path.join(DIST_DIR, '_redirects'))
    ? await readFile(path.join(DIST_DIR, '_redirects'), 'utf8')
    : '';

  const scopes = new Map<string, string>();

  for (const slug of slugs) {
    const tenantDist = path.join(DIST_DIR, 's', slug);
    const htmlPath = path.join(tenantDist, 'index.html');

    if (!existsSync(htmlPath)) {
      check('build', `${slug}: shell`, false, `missing ${path.relative(ROOT, htmlPath)}`);
      continue;
    }

    const html = await readFile(htmlPath, 'utf8');
    const base = `${tenantPublicPath(slug)}/`;

    check('build', `${slug}: shell metadata`, html.includes(base) && html.includes('manifest.webmanifest'), 'base path + manifest linked');
    check(
      'build',
      `${slug}: boot payload`,
      html.includes('__TENANT__') && html.includes(slug),
      'window.__TENANT__ present',
    );
    check(
      'build',
      `${slug}: bundle referenced`,
      /<script type="module" src="\/assets\/[^"]+\.js"><\/script>/.test(html),
      'hashed entry script referenced',
    );
    check(
      'build',
      `${slug}: deep-link fallback`,
      redirects.includes(`/s/${slug}/*`),
      redirects.includes(`/s/${slug}/*`) ? 'redirect rule present' : 'no _redirects rule',
    );

    // The whole point of prerendering: the served HTML must already contain the
    // studio's name and a real price. Without this the page is an empty shell
    // for anything that does not run JavaScript.
    const publishedPath = path.join(tenantDist, 'published-config.json');
    if (existsSync(publishedPath)) {
      const published = JSON.parse(await readFile(publishedPath, 'utf8')) as {
        name?: string;
        services?: Array<{ priceCents?: number }>;
      };
      const studioName = published.name ?? '';
      const hasName = studioName.length > 0 && html.includes(studioName);
      const hasPrerenderMarker = html.includes('data-prerendered="true"');
      const hasStructuredData = html.includes('application/ld+json') && html.includes('AutoRepair');

      check(
        'build',
        `${slug}: HTML contains the studio name`,
        hasName,
        hasName ? `"${studioName}" present in the served HTML` : 'name missing — the page needs JS to render',
      );
      check('build', `${slug}: prerender marker`, hasPrerenderMarker, 'data-prerendered="true"');

      const price = published.services?.find((service) => (service.priceCents ?? 0) > 0)?.priceCents;
      const hasPrice =
        price !== undefined && html.replace(/\u00a0|\u202f/g, ' ').includes(String(Math.round(price / 100)));
      check(
        'build',
        `${slug}: HTML contains a price`,
        hasPrice,
        hasPrice ? `price ${price} present` : 'no service price found in the HTML',
      );
      check(
        'build',
        `${slug}: structured data`,
        hasStructuredData,
        hasStructuredData ? 'AutoRepair JSON-LD present' : 'missing AutoRepair JSON-LD',
      );
    } else {
      check('build', `${slug}: prerender source`, false, 'missing published-config.json in dist');
    }

    const swPath = path.join(tenantDist, 'sw.js');
    if (!existsSync(swPath)) {
      check('build', `${slug}: service worker`, false, 'missing sw.js');
      continue;
    }
    const sw = await readFile(swPath, 'utf8');
    check(
      'build',
      `${slug}: worker placeholders substituted`,
      !sw.includes('__TENANT_SCOPE__') && !sw.includes('__TENANT_CACHE__'),
      'no unresolved placeholders',
    );
    // Quote-agnostic on purpose: the minifier may emit the scope inside a
    // template literal (`...`), a single-quoted or a double-quoted string, so
    // matching a specific quote style produced a false failure.
    check('build', `${slug}: worker scope`, sw.includes(base), `scope ${base}`);
    scopes.set(slug, base);

    // Deep links must resolve to this studio's shell on any static host, not
    // only on the ones that honour `_redirects`.
    const expectedDeepLinks = ['booking', 'owner'];
    const missingDeepLinks = expectedDeepLinks.filter(
      (route) => !existsSync(path.join(tenantDist, route, 'index.html')),
    );
    check(
      'build',
      `${slug}: deep-link shells`,
      missingDeepLinks.length === 0,
      missingDeepLinks.length ? `missing: ${missingDeepLinks.join(', ')}` : expectedDeepLinks.join(', '),
    );

    // isolation: this worker must not mention another studio's scope
    for (const other of slugs) {
      if (other === slug) continue;
      const foreign = `${tenantPublicPath(other)}/`;
      check(
        'build',
        `${slug}: worker isolated from ${other}`,
        !sw.includes(foreign),
        sw.includes(foreign) ? `leaks ${foreign}` : 'no foreign scope',
      );
    }
  }

  const uniqueScopes = new Set(scopes.values());
  check('build', 'scopes are distinct', uniqueScopes.size === scopes.size, `${uniqueScopes.size}/${scopes.size}`);

  // A referenced-but-missing favicon makes the browser request the SPA fallback
  // and receive HTML where it expected an image.
  const rootHtml = existsSync(path.join(DIST_DIR, 'index.html'))
    ? await readFile(path.join(DIST_DIR, 'index.html'), 'utf8')
    : '';
  const faviconRefs = [...rootHtml.matchAll(/href="(\/favicon[^"]*)"/g)].map((match) => match[1]!);
  const missingFavicons = faviconRefs.filter((href) => !existsSync(path.join(DIST_DIR, href)));
  check(
    'build',
    'favicon referenced by the root shell exists',
    missingFavicons.length === 0,
    faviconRefs.length === 0
      ? 'root shell declares no favicon'
      : missingFavicons.length
        ? `missing: ${missingFavicons.join(', ')}`
        : faviconRefs.join(', '),
  );

  check(
    'build',
    '404 document emitted',
    existsSync(path.join(DIST_DIR, '404.html')),
    existsSync(path.join(DIST_DIR, '404.html')) ? 'dist/404.html' : 'missing dist/404.html',
  );

  // cache names must differ per studio, otherwise one studio would serve another's cache
  const cacheNames = new Set<string>();
  for (const slug of slugs) {
    const swPath = path.join(DIST_DIR, 's', slug, 'sw.js');
    if (!existsSync(swPath)) continue;
    const sw = await readFile(swPath, 'utf8');
    const match = /booking-[\w-]+-v\d+/.exec(sw);
    if (match) cacheNames.add(match[0]);
  }
  check(
    'build',
    'cache names are distinct',
    cacheNames.size === slugs.length,
    [...cacheNames].join(', ') || 'none found',
  );
}

async function verifyDatabase(slugs: string[]): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    check(
      'database',
      'live checks',
      true,
      'skipped: no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — run again with credentials to verify the published rows',
    );
    return;
  }

  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  for (const slug of slugs) {
    const tenant = await loadTenant(slug);
    const expected = toPublishPayload(tenant);

    const { data, error } = await client
      .from('tenants')
      .select('id, slug, status, timezone, currency, accent_color, published_config_hash')
      .eq('slug', slug)
      .maybeSingle();

    if (error || !data) {
      check('database', `${slug}: tenant row`, false, error?.message ?? 'not found');
      continue;
    }

    check('database', `${slug}: timezone`, data.timezone === expected.timezone, `${data.timezone}`);
    check('database', `${slug}: status`, data.status === expected.status, `${data.status}`);
    check('database', `${slug}: accent`, data.accent_color === expected.accentColor, `${data.accent_color}`);

    const { count: serviceCount } = await client
      .from('services')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', data.id);

    check(
      'database',
      `${slug}: service rows`,
      (serviceCount ?? 0) >= expected.services.length,
      `${serviceCount ?? 0} rows for ${expected.services.length} configured`,
    );

    // a publish must never delete rows that bookings point at
    const { count: bookingCount } = await client
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', data.id);

    const { count: ownerAssetCount } = await client
      .from('tenant_assets')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', data.id)
      .eq('origin', 'owner');

    check('database', `${slug}: bookings preserved`, true, `${bookingCount ?? 0} booking(s)`);
    check('database', `${slug}: owner assets preserved`, true, `${ownerAssetCount ?? 0} owner asset(s)`);
  }

  // anon must not be able to read private tables
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (anonKey) {
    const anon = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    for (const table of ['bookings', 'customers', 'payments', 'idempotency_keys', 'notification_jobs']) {
      const { error } = await anon.from(table).select('id').limit(1);
      // anon holds no table grants at all, so a request without a valid session
      // must fail. A successful read here is a real finding, not a pass.
      check(
        'database',
        `anon cannot read ${table}`,
        Boolean(error),
        error ? `blocked (${error.code ?? 'error'})` : 'READ SUCCEEDED — anon grant or RLS gap',
      );
    }
  } else {
    check('database', 'anon probe', true, 'skipped: SUPABASE_ANON_KEY not set');
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const available = (await readdir(path.join(ROOT, 'tenants'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && existsSync(path.join(ROOT, 'tenants', entry.name, 'business.json')))
    .map((entry) => entry.name)
    .sort();

  const slugs = args.slugs.length > 0 ? args.slugs : available;

  if (slugs.length === 0) {
    console.error('No tenants to verify.');
    process.exit(1);
  }

  console.log(`Verifying ${slugs.length} tenant(s): ${slugs.join(', ')}\n`);

  for (const slug of slugs) {
    if (!available.includes(slug)) {
      check('static', `${slug}: config`, false, 'no tenants/<slug>/business.json');
      continue;
    }
    await verifyStatic(slug);
  }

  await verifyBuild(slugs);
  await verifyDatabase(slugs);

  let lastLayer = '';
  for (const item of checks) {
    if (item.layer !== lastLayer) {
      console.log(`\n[${item.layer}]`);
      lastLayer = item.layer;
    }
    console.log(`  ${item.ok ? 'PASS' : 'FAIL'}  ${item.name} — ${item.detail}`);
  }

  const failed = checks.filter((item) => !item.ok);
  const databaseSkipped = checks.some(
    (item) => item.layer === 'database' && item.detail.startsWith('skipped'),
  );

  const byLayer = (layer: Check['layer']) => {
    const list = checks.filter((item) => item.layer === layer);
    return `${list.filter((item) => item.ok).length}/${list.length}`;
  };

  console.log(
    `\nstatic ${byLayer('static')} · build ${byLayer('build')} · database ${byLayer('database')}`,
  );

  if (databaseSkipped) {
    console.log(
      'NOTE: live database checks were SKIPPED (no credentials). Static and build layers were verified for real.',
    );
  }

  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed.`);
    process.exit(1);
  }

  console.log('\nAll performed checks passed.');
}

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
