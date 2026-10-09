#!/usr/bin/env tsx
/**
 * tenant:validate — check one, several or all `business.json` files.
 *
 *   npm run tenant:validate -- graphite-detailing
 *   npm run tenant:validate -- --all
 *
 * Exit code 1 when any tenant is invalid, so it is usable as a CI gate.
 */
import process from 'node:process';
import { fail, logSection, parseArgs, resolveTargets } from '../lib/cli';
import { TenantConfigError, loadTenant, type LoadedTenant } from '../lib/tenant-config';
import { tenantPublicPath } from '../lib/paths';

function formatMoney(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

function report(tenant: LoadedTenant): void {
  const { config, assets, hash } = tenant;

  console.log(`✓ ${config.slug} — ${config.name}`);
  console.log(`    timezone      ${config.timezone}   currency ${config.currency}`);
  console.log(`    status        ${config.status}`);
  console.log(`    accent        ${config.branding.accentColor}`);
  console.log(`    public path   ${tenantPublicPath(config.slug)}/`);
  console.log(`    resources     ${config.resources.length}`);
  console.log(`    services      ${config.services.length}`);

  const shortest = Math.min(...config.services.map((service) => service.durationMin));
  const longest = Math.max(...config.services.map((service) => service.durationMin));
  const multiDay = config.services.filter((service) => service.spansDays).length;
  console.log(
    `    durations     ${shortest}–${longest} min (${multiDay} multi-day service${multiDay === 1 ? '' : 's'})`,
  );

  const openDays = config.hours.filter((row) => !row.isClosed);
  console.log(
    `    hours         ${openDays.length}/7 open days, slot step ${config.booking.slotStepMinutes} min`,
  );

  if (config.exceptions.length) {
    console.log(`    exceptions    ${config.exceptions.length}`);
  }

  console.log(`    assets        ${assets.length} (${assets.map((a) => a.kind).join(', ')})`);
  for (const asset of assets) {
    console.log(
      `      • ${asset.kind.padEnd(12)} ${asset.fileName.padEnd(26)} ${asset.width}x${asset.height} ${asset.format} ${(asset.bytes / 1024).toFixed(1)} KiB`,
    );
  }

  console.log('    prices');
  for (const service of config.services) {
    const cents =
      'priceCents' in service && typeof service.priceCents === 'number'
        ? service.priceCents
        : Math.round((service as { price: number }).price * 100);
    console.log(
      `      • ${service.key.padEnd(20)} ${String(service.durationMin).padStart(5)} min  ${formatMoney(cents, service.currency ?? config.currency)}`,
    );
  }

  console.log(`    config hash   ${hash.slice(0, 16)}…`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const targets = await resolveTargets(args);

  if (targets.length === 0) {
    fail('No tenants found under tenants/*/business.json');
  }

  logSection(`Validating ${targets.length} tenant(s)`);

  let failed = 0;
  for (const slug of targets) {
    try {
      const tenant = await loadTenant(slug);
      report(tenant);
      console.log('');
    } catch (error) {
      failed += 1;
      if (error instanceof TenantConfigError) {
        console.error(`✗ ${error.message}\n`);
      } else {
        console.error(`✗ ${slug}: ${(error as Error).message}\n`);
      }
    }
  }

  if (failed > 0) {
    fail(`${failed} of ${targets.length} tenant(s) are invalid`);
  }

  console.log(`All ${targets.length} tenant config(s) are valid.`);
}

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
