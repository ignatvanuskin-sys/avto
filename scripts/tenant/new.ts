#!/usr/bin/env tsx
/**
 * tenant:new — scaffold a brand new studio.
 *
 *   npm run tenant:new -- my-new-studio --name "Моя студия" --accent "#22d3ee"
 *
 * It writes a complete, VALID `business.json` (the validator runs at the end, so
 * the result is guaranteed to pass `tenant:validate`), generates the icon and
 * image set, and prints the exact next commands. No business name is baked into
 * the application source: a new studio is a new directory, and publishing it
 * never touches a studio that is already live.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { ROOT, tenantDir } from '../lib/paths';
import { loadTenant, TenantConfigError } from '../lib/tenant-config';
import { parseArgs } from '../lib/cli';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

interface NewTenantOptions {
  slug: string;
  name: string;
  accent: string;
  timezone: string;
  currency: string;
  locale: string;
}

function buildTemplate(options: NewTenantOptions) {
  return {
    $schema: '../../src/shared/business.schema.json',
    slug: options.slug,
    name: options.name,
    shortName: options.name.slice(0, 20),
    tagline: 'Заполните короткий слоган студии',
    description:
      'Опишите студию двумя-тремя предложениями: что делаете, на чём работаете, чем отличаетесь.',
    // Always preview first: a new studio must not send real notifications until
    // its business settings have been reviewed.
    status: 'preview',
    timezone: options.timezone,
    locale: options.locale,
    currency: options.currency,
    branding: {
      accentColor: options.accent,
      accentForeground: '#0b0b0c',
      themeColor: '#0b0b0c',
      backgroundColor: '#0b0b0c',
    },
    contacts: {
      phone: '+7 000 000-00-00',
      email: `hello@${options.slug}.example`,
    },
    address: 'Город, улица, дом',
    booking: {
      leadMinutes: 60,
      horizonDays: 45,
      slotStepMinutes: 30,
      minCancelNoticeMinutes: 120,
    },
    limits: {
      publicRateLimitPerMinute: 90,
      aiCallsPerDay: 200,
    },
    ai: {
      enabled: false,
      persona: 'Коротко и по делу помогает выбрать услугу и время. Цену не выдумывает.',
    },
    pwa: {
      display: 'standalone',
      orientation: 'portrait',
    },
    resources: [
      { key: 'post-1', name: 'Пост 1', kind: 'post', sortOrder: 1 },
      { key: 'post-2', name: 'Пост 2', kind: 'post', sortOrder: 2 },
    ],
    services: [
      {
        key: 'main-service',
        name: 'Основная услуга',
        description: 'Опишите, что входит в работу.',
        durationMin: 60,
        bufferBeforeMin: 10,
        bufferAfterMin: 10,
        price: 3000,
        requiredResourceKind: 'post',
        category: 'Основное',
        imageFile: 'assets/service-main.jpg',
        sortOrder: 1,
      },
      {
        key: 'long-service',
        name: 'Длительная услуга',
        description:
          'Работа занимает подъёмник непрерывно несколько дней. Выдача и приём — по рабочим часам.',
        durationMin: 2880,
        bufferBeforeMin: 30,
        bufferAfterMin: 30,
        price: 40000,
        requiredResourceKind: 'post',
        category: 'Основное',
        spansDays: true,
        sortOrder: 2,
      },
    ],
    hours: [
      { weekday: 1, opensAt: '09:00', closesAt: '20:00' },
      { weekday: 2, opensAt: '09:00', closesAt: '20:00' },
      { weekday: 3, opensAt: '09:00', closesAt: '20:00' },
      { weekday: 4, opensAt: '09:00', closesAt: '20:00' },
      { weekday: 5, opensAt: '09:00', closesAt: '20:00' },
      { weekday: 6, opensAt: '10:00', closesAt: '18:00' },
      { weekday: 7, opensAt: '10:00', closesAt: '18:00', isClosed: true },
    ],
    exceptions: [],
    assets: [
      { kind: 'logo', file: 'assets/logo.png', sortOrder: 1 },
      { kind: 'hero', file: 'assets/hero.jpg', sortOrder: 1 },
      { kind: 'gallery', file: 'assets/gallery-1.jpg', sortOrder: 1 },
      { kind: 'gallery', file: 'assets/gallery-2.jpg', sortOrder: 2 },
      { kind: 'icon', file: 'assets/icon-512.png', sortOrder: 1 },
      { kind: 'maskable', file: 'assets/maskable-512.png', sortOrder: 1 },
      { kind: 'apple-touch', file: 'assets/apple-touch-180.png', sortOrder: 1 },
    ],
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const rawSlug = args.slugs[0];
  if (!rawSlug) {
    console.error(
      'Usage: npm run tenant:new -- <slug> [--name "..."] [--accent "#rrggbb"] [--timezone Area/City] [--currency XXX] [--locale ru-RU]',
    );
    process.exit(1);
  }

  const slug = slugify(rawSlug);
  if (!slug) {
    console.error(`"${rawSlug}" cannot be turned into a slug.`);
    process.exit(1);
  }

  const options: NewTenantOptions = {
    slug,
    name: args.options.get('name') ?? slug,
    accent: args.options.get('accent') ?? '#ff6a00',
    timezone: args.options.get('timezone') ?? 'Europe/Moscow',
    currency: (args.options.get('currency') ?? 'RUB').toUpperCase(),
    locale: args.options.get('locale') ?? 'ru-RU',
  };

  const dir = tenantDir(slug);
  const configPath = path.join(dir, 'business.json');

  if (existsSync(configPath)) {
    console.error(`tenants/${slug}/business.json already exists — refusing to overwrite it.`);
    process.exit(1);
  }

  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(buildTemplate(options), null, 2)}\n`, 'utf8');

  console.log(`Created tenants/${slug}/business.json`);
  console.log(`  name      ${options.name}`);
  console.log(`  timezone  ${options.timezone}   currency ${options.currency}   locale ${options.locale}`);
  console.log(`  accent    ${options.accent}`);
  console.log(`  status    preview (must be switched to live deliberately)`);

  // Generate the images and immediately prove the config validates.
  console.log('\nGenerating placeholder images…');
  try {
    execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'tools', 'make-demo-assets.mjs'), slug],
      { stdio: 'inherit' },
    );
  } catch (error) {
    console.error(`Image generation failed: ${(error as Error).message}`);
    process.exit(1);
  }

  console.log('\nValidating the new tenant…');
  try {
    const tenant = await loadTenant(slug);
    console.log(
      `Valid: ${tenant.config.services.length} service(s), ${tenant.config.resources.length} resource(s), ${tenant.assets.length} asset(s).`,
    );
  } catch (error) {
    if (error instanceof TenantConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  console.log('\nNext steps:');
  console.log(`  1. Replace the placeholder images in tenants/${slug}/assets/ with real photography.`);
  console.log('  2. Edit the services, prices and working hours in business.json.');
  console.log(`  3. npm run tenant:validate -- ${slug}`);
  console.log(`  4. npm run tenant:publish -- ${slug}     # writes public/s/${slug}/ and the SQL`);
  console.log(`  5. npm run tenant:verify -- ${slug}`);
  console.log(`  6. npm run build                          # emits dist/s/${slug}/ for Cloudflare Pages`);
  console.log('\nThe studio stays in preview until its status is switched to "live".');
}

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
