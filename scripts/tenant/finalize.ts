#!/usr/bin/env tsx
/**
 * tenant:finalize — the post-build half of the pipeline.
 *
 * Runs after `vite build`, because both things it writes depend on the build:
 *
 *   1. `dist/s/<slug>/index.html` — the studio shell, pointing at the hashed
 *      shared bundle read from Vite's build manifest;
 *   2. `dist/s/<slug>/sw.js` — a copy of the single compiled service worker
 *      (`dist/sw.js`, produced by vite-plugin-pwa `injectManifest`) with that
 *      studio's scope and cache name substituted in.
 *
 * With this, one JS/CSS build serves every studio while each studio keeps its
 * own installable identity: its own manifest, its own worker scope and its own
 * cache name.
 *
 *   npm run tenant:finalize
 *   npm run tenant:finalize -- graphite-detailing
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  buildHeaders,
  buildNotFoundHtml,
  buildRedirects,
  buildTenantShellHtml,
  type BundleRefs,
} from '../lib/shell-html';
import { buildShellConfig } from '../lib/manifest';
import { loadTenant } from '../lib/tenant-config';
import { DIST_DIR, ROOT } from '../lib/paths';
import { fail, logSection, parseArgs, resolveTargets } from '../lib/cli';

interface ViteManifestChunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  css?: string[];
  imports?: string[];
}

const SCOPE_PLACEHOLDER = '__TENANT_SCOPE__';
const CACHE_PLACEHOLDER = '__TENANT_CACHE__';

/**
 * In-app routes that get their own physical shell directory, so a hard load or a
 * shared deep link resolves to the right studio without any server rewrite.
 * Keep this in sync with the routes declared in src/App.tsx.
 */
const CLIENT_ROUTES = ['booking', 'owner'];

async function readBundleRefs(): Promise<BundleRefs> {
  const manifestPath = path.join(DIST_DIR, '.vite', 'manifest.json');
  if (!existsSync(manifestPath)) {
    fail(
      `Vite build manifest not found at ${path.relative(ROOT, manifestPath)}. ` +
        'Ensure `build.manifest = true` in vite.config.ts and run `vite build` first.',
    );
  }

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
    string,
    ViteManifestChunk
  >;

  const entry =
    manifest['index.html'] ??
    Object.values(manifest).find((chunk) => chunk.isEntry) ??
    Object.values(manifest).find((chunk) => chunk.file.endsWith('.js'));

  if (!entry) {
    fail('Could not locate the entry chunk in the Vite build manifest.');
  }

  const script = `/${entry.file}`;
  const styles = (entry.css ?? []).map((file) => `/${file}`);

  const preloads = new Set<string>();
  for (const imported of entry.imports ?? []) {
    const chunk = manifest[imported];
    if (chunk?.file) {
      preloads.add(`/${chunk.file}`);
      for (const css of chunk.css ?? []) {
        styles.push(`/${css}`);
      }
    }
  }

  return {
    script,
    styles: [...new Set(styles)],
    preloads: [...preloads],
  };
}

function substituteWorker(source: string, scope: string, cacheName: string): string {
  if (!source.includes(SCOPE_PLACEHOLDER) || !source.includes(CACHE_PLACEHOLDER)) {
    fail(
      `The compiled service worker does not contain the ${SCOPE_PLACEHOLDER} / ${CACHE_PLACEHOLDER} placeholders. ` +
        'Check src/pwa/sw.ts.',
    );
  }
  return source.replaceAll(SCOPE_PLACEHOLDER, scope).replaceAll(CACHE_PLACEHOLDER, cacheName);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const targets = await resolveTargets(args);

  if (!existsSync(DIST_DIR)) {
    fail('dist/ does not exist — run `vite build` before tenant:finalize.');
  }

  logSection(`Finalizing ${targets.length} tenant shell(s)`);

  const bundle = await readBundleRefs();
  console.log(`shared bundle: ${bundle.script}`);
  console.log(`stylesheets:   ${bundle.styles.length}`);
  console.log(`preloads:      ${bundle.preloads.length}`);

  // Vite 8 emits the injectManifest worker as `sw.js` or `sw.mjs` depending on
  // the output format, so accept whichever the plugin produced.
  const workerCandidates = ['sw.js', 'sw.mjs'];
  const workerSource = workerCandidates
    .map((name) => path.join(DIST_DIR, name))
    .find((candidate) => existsSync(candidate));

  if (!workerSource) {
    fail(
      `No compiled service worker found in dist/ (looked for ${workerCandidates.join(', ')}). ` +
        'Is vite-plugin-pwa configured with injectManifest?',
    );
  }
  const compiledWorker = await readFile(workerSource, 'utf8');

  // The root shell keeps scope "/" and its own cache name.
  const workerPath = path.join(DIST_DIR, 'sw.js');
  await writeFile(workerPath, substituteWorker(compiledWorker, '/', 'booking-shell-root-v1'), 'utf8');

  // Remove the plugin's own naming so only the substituted worker remains.
  if (workerSource !== workerPath) {
    await rm(workerSource, { force: true });
  }
  console.log('wrote dist/sw.js (scope /)');

  const writtenSlugs: string[] = [];

  for (const slug of targets) {
    const tenant = await loadTenant(slug);
    const shell = buildShellConfig(tenant.config, tenant.assets, tenant.hash);
    const tenantDist = path.join(DIST_DIR, 's', slug);

    if (!existsSync(path.join(tenantDist, 'config.json'))) {
      fail(
        `dist/s/${slug}/config.json is missing. Run \`npm run tenant:publish -- ${slug}\` before the build.`,
      );
    }

    await mkdir(tenantDist, { recursive: true });

    const shellHtml = buildTenantShellHtml({ shell, assets: tenant.assets, bundle });

    await writeFile(path.join(tenantDist, 'index.html'), shellHtml, 'utf8');

    // Physical shells for every known in-app route.
    //
    // `_redirects` only works on hosts that honour it, and it demonstrably did
    // not apply under `vite preview`: a hard load of `/s/<slug>/owner` returned
    // the ROOT document, so the wrong studio rendered with the wrong accent and
    // no `__TENANT__`. Writing a real directory per route makes deep links land
    // in the correct studio on any static host — no rewrite rules required.
    for (const route of CLIENT_ROUTES) {
      const routeDir = path.join(tenantDist, route);
      await mkdir(routeDir, { recursive: true });
      await writeFile(path.join(routeDir, 'index.html'), shellHtml, 'utf8');
    }

    await writeFile(
      path.join(tenantDist, 'sw.js'),
      substituteWorker(compiledWorker, shell.serviceWorkerScope, `booking-${slug}-v1`),
      'utf8',
    );

    writtenSlugs.push(slug);
    console.log(
      `  ${slug.padEnd(22)} shells: ${['', ...CLIENT_ROUTES].map((route) => route || '/').join(' ')} + sw.js (scope ${shell.serviceWorkerScope})`,
    );
  }

  // Every tenant that exists on disk gets a redirect rule, not just the ones
  // touched in this run, so the file is stable across incremental publishes.
  const allSlugs = (await readdir(path.join(DIST_DIR, 's'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  await writeFile(path.join(DIST_DIR, '_redirects'), buildRedirects(allSlugs), 'utf8');
  await writeFile(path.join(DIST_DIR, '_headers'), buildHeaders(allSlugs), 'utf8');
  await writeFile(path.join(DIST_DIR, '404.html'), buildNotFoundHtml(), 'utf8');

  logSection('Done');
  console.log(`shells:     ${writtenSlugs.length}`);
  console.log(`redirects:  ${allSlugs.length} studio(s)`);
}

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
