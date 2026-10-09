#!/usr/bin/env node
/**
 * Generate the demo tenant images.
 *
 * These are deliberately abstract, text-free compositions built from vector
 * shapes, so they rasterise deterministically on any machine without a font
 * dependency. They exist so the pipeline, the PWA icons and the per-tenant
 * manifest can be built and tested end to end with no external service.
 *
 * A real studio replaces `tenants/<slug>/assets/*` with its own photography and
 * re-runs `npm run tenant:publish`. Nothing in the code knows or cares which
 * images are used.
 *
 * Usage:
 *   node scripts/tools/make-demo-assets.mjs                 # every tenant
 *   node scripts/tools/make-demo-assets.mjs graphite-detailing
 */
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..', '..');
const tenantsDir = path.join(root, 'tenants');

function hashToSeed(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

/** A dark studio-ish composition: gradient ground, accent glow, light streaks. */
function sceneSvg({ width, height, background, accent, seed, density = 1 }) {
  const random = mulberry32(seed);
  const rgb = hexToRgb(accent);
  const accentSoft = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
  const glowX = 0.2 + random() * 0.6;
  const glowY = 0.15 + random() * 0.4;

  const streaks = Array.from({ length: Math.round(7 * density) }, () => {
    const x = Math.round(random() * width);
    const w = 1 + Math.round(random() * 3);
    const opacity = (0.03 + random() * 0.09).toFixed(3);
    return `<rect x="${x}" y="0" width="${w}" height="${height}" fill="#ffffff" opacity="${opacity}"/>`;
  }).join('');

  const plates = Array.from({ length: Math.round(3 * density) }, () => {
    const w = Math.round(width * (0.18 + random() * 0.3));
    const h = Math.round(height * (0.05 + random() * 0.12));
    const x = Math.round(random() * (width - w));
    const y = Math.round(height * 0.55 + random() * height * 0.3);
    const opacity = (0.05 + random() * 0.1).toFixed(3);
    const radius = Math.round(Math.min(w, h) * 0.25);
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${accentSoft}" opacity="${opacity}"/>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="${background}"/>
      <stop offset="1" stop-color="#000000"/>
    </linearGradient>
    <radialGradient id="glow" cx="${glowX}" cy="${glowY}" r="0.75">
      <stop offset="0" stop-color="${accentSoft}" stop-opacity="0.55"/>
      <stop offset="0.55" stop-color="${accentSoft}" stop-opacity="0.12"/>
      <stop offset="1" stop-color="${accentSoft}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#ground)"/>
  <rect width="${width}" height="${height}" fill="url(#glow)"/>
  ${streaks}
  ${plates}
</svg>`;
}

/** A mark-only icon: accent field with a dark rounded notch, safe for masking. */
function iconSvg({ size, background, accent, maskable }) {
  const inset = maskable ? size * 0.22 : size * 0.14;
  const inner = size - inset * 2;
  const radius = Math.round(inner * (maskable ? 0.16 : 0.22));
  const barHeight = Math.round(inner * 0.14);
  const gap = Math.round(inner * 0.1);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="field" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.95"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0.55"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" fill="${background}"/>
  <rect x="${inset}" y="${inset}" width="${inner}" height="${inner}" rx="${radius}" fill="url(#field)"/>
  <rect x="${inset + inner * 0.2}" y="${inset + inner * 0.34}" width="${inner * 0.6}" height="${barHeight}" rx="${barHeight / 2}" fill="${background}" opacity="0.92"/>
  <rect x="${inset + inner * 0.2}" y="${inset + inner * 0.34 + barHeight + gap}" width="${inner * 0.42}" height="${barHeight}" rx="${barHeight / 2}" fill="${background}" opacity="0.7"/>
</svg>`;
}

function logoSvg({ width, height, background, accent }) {
  const barHeight = Math.round(height * 0.1);
  const gap = Math.round(height * 0.09);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="0" y="${(height - (barHeight * 2 + gap)) / 2}" width="${width * 0.62}" height="${barHeight}" rx="${barHeight / 2}" fill="${accent}"/>
  <rect x="0" y="${(height - (barHeight * 2 + gap)) / 2 + barHeight + gap}" width="${width * 0.4}" height="${barHeight}" rx="${barHeight / 2}" fill="${accent}" opacity="0.6"/>
  <circle cx="${width * 0.85}" cy="${height * 0.5}" r="${height * 0.28}" fill="${background}" stroke="${accent}" stroke-width="${Math.max(2, height * 0.03)}"/>
</svg>`;
}

async function renderPng(svg, file) {
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(file);
}

async function renderJpg(svg, file, size, quality = 86) {
  await sharp(Buffer.from(svg))
    .resize(size.width, size.height, { fit: 'cover' })
    .jpeg({ quality, mozjpeg: true })
    .toFile(file);
}

async function generateForTenant(slug) {
  const tenantDir = path.join(tenantsDir, slug);
  const assetsDir = path.join(tenantDir, 'assets');
  const configRaw = await readFile(path.join(tenantDir, 'business.json'), 'utf8');
  const config = JSON.parse(configRaw);

  await mkdir(assetsDir, { recursive: true });

  const background = config.branding?.backgroundColor ?? '#0b0b0c';
  const accent = config.branding?.accentColor ?? '#ff6a00';

  const written = [];

  const hero = sceneSvg({ width: 1600, height: 900, background, accent, seed: hashToSeed(`${slug}:hero`) });
  await renderJpg(hero, path.join(assetsDir, 'hero.jpg'), { width: 1600, height: 900 });
  written.push('hero.jpg');

  for (const index of [1, 2]) {
    const scene = sceneSvg({
      width: 1200,
      height: 800,
      background,
      accent,
      seed: hashToSeed(`${slug}:gallery:${index}`),
      density: 0.8,
    });
    await renderJpg(scene, path.join(assetsDir, `gallery-${index}.jpg`), { width: 1200, height: 800 });
    written.push(`gallery-${index}.jpg`);
  }

  // an image for every service that declares one
  const serviceKeyToFile = new Map(
    (config.services ?? [])
      .filter((service) => typeof service.imageFile === 'string')
      .map((service) => [service.key, path.basename(service.imageFile)]),
  );
  for (const [key, filename] of serviceKeyToFile) {
    const scene = sceneSvg({
      width: 800,
      height: 600,
      background,
      accent,
      seed: hashToSeed(`${slug}:service:${key}`),
      density: 0.5,
    });
    await renderJpg(scene, path.join(assetsDir, filename), { width: 800, height: 600 });
    written.push(filename);
  }

  await renderPng(
    logoSvg({ width: 1024, height: 288, background, accent }),
    path.join(assetsDir, 'logo.png'),
  );
  written.push('logo.png');

  await renderPng(
    iconSvg({ size: 512, background, accent, maskable: false }),
    path.join(assetsDir, 'icon-512.png'),
  );
  await renderPng(
    iconSvg({ size: 192, background, accent, maskable: false }),
    path.join(assetsDir, 'icon-192.png'),
  );
  await renderPng(
    iconSvg({ size: 512, background, accent, maskable: true }),
    path.join(assetsDir, 'maskable-512.png'),
  );
  await renderPng(
    iconSvg({ size: 180, background, accent, maskable: false }),
    path.join(assetsDir, 'apple-touch-180.png'),
  );
  written.push('icon-512.png', 'icon-192.png', 'maskable-512.png', 'apple-touch-180.png');

  // iOS startup images (one per aspect family)
  for (const [name, size] of [
    ['startup-1170x2532.png', { width: 1170, height: 2532 }],
    ['startup-1284x2778.png', { width: 1284, height: 2778 }],
  ]) {
    const svg = sceneSvg({ width: size.width, height: size.height, background, accent, seed: hashToSeed(`${slug}:${name}`) });
    await renderPng(svg, path.join(assetsDir, name));
    written.push(name);
  }

  return written;
}

async function main() {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const slugs = requested.length
    ? requested
    : existsSync(tenantsDir)
      ? readdirSync(tenantsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .filter((name) => existsSync(path.join(tenantsDir, name, 'business.json')))
      : [];

  if (slugs.length === 0) {
    console.error('No tenants with business.json found.');
    process.exitCode = 1;
    return;
  }

  for (const slug of slugs) {
    const written = await generateForTenant(slug);
    console.log(`${slug}: ${written.length} files -> tenants/${slug}/assets`);
  }
}

await main();
