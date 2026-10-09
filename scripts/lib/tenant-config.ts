import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Metadata as SharpMetadata } from 'sharp';
import {
  businessConfigSchema,
  priceToCents,
  type AssetConfig,
  type BusinessConfigParsed,
} from '../../src/shared/business-schema';
import { TENANTS_DIR, tenantDir, tenantPublicPath } from './paths';

export interface ResolvedAsset extends AssetConfig {
  /** Absolute path on disk. */
  absolutePath: string;
  /** File name inside the tenant assets directory. */
  fileName: string;
  /** Public URL once published. */
  url: string;
  bytes: number;
  width: number;
  height: number;
  format: string;
}

export interface LoadedTenant {
  slug: string;
  dir: string;
  config: BusinessConfigParsed;
  /** sha256 of the canonical config, used to prove a publish is reproducible. */
  hash: string;
  assets: ResolvedAsset[];
}

export class TenantConfigError extends Error {
  readonly issues: string[];

  constructor(slug: string, issues: string[]) {
    super(`tenants/${slug}/business.json is not valid:\n  - ${issues.join('\n  - ')}`);
    this.name = 'TenantConfigError';
    this.issues = issues;
  }
}

/** Deterministic JSON so hashing does not depend on key order. */
export function canonicalJson(value: unknown): string {
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(walk);
    }
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, walk(item)]),
      );
    }
    return input;
  };
  return JSON.stringify(walk(value), null, 2);
}

export function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function listTenantSlugs(): Promise<string[]> {
  if (!existsSync(TENANTS_DIR)) {
    return [];
  }
  const entries = await readdir(TENANTS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(path.join(TENANTS_DIR, name, 'business.json')))
    .sort();
}

function describeIssues(error: unknown): string[] {
  const issues = (error as { issues?: Array<{ path: Array<string | number>; message: string }> })
    .issues;
  if (!Array.isArray(issues)) {
    return [error instanceof Error ? error.message : String(error)];
  }
  return issues.map((issue) => {
    const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
    return `${where}${issue.message}`;
  });
}

/**
 * Load and fully validate one tenant.
 *
 * Beyond the schema itself this checks the things a schema cannot: that every
 * referenced image really exists on disk and is a decodable image with sane
 * dimensions.
 */
export async function loadTenant(slug: string): Promise<LoadedTenant> {
  const dir = tenantDir(slug);
  const configPath = path.join(dir, 'business.json');

  if (!existsSync(configPath)) {
    throw new TenantConfigError(slug, [`missing ${configPath}`]);
  }

  const raw = await readFile(configPath, 'utf8');

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new TenantConfigError(slug, [
      `business.json is not valid JSON: ${(error as Error).message}`,
    ]);
  }

  const result = businessConfigSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new TenantConfigError(slug, describeIssues(result.error));
  }

  const config = result.data;
  const issues: string[] = [];

  if (config.slug !== slug) {
    issues.push(`slug "${config.slug}" does not match the directory name "${slug}"`);
  }

  // ----- assets -----------------------------------------------------------
  const assets: ResolvedAsset[] = [];
  const assetsDir = path.join(dir, 'assets');

  for (const asset of config.assets) {
    const absolutePath = path.resolve(dir, asset.file);
    if (!absolutePath.startsWith(path.resolve(assetsDir))) {
      issues.push(`asset "${asset.file}" must live inside tenants/${slug}/assets`);
      continue;
    }
    if (!existsSync(absolutePath)) {
      issues.push(`asset file not found: tenants/${slug}/${asset.file}`);
      continue;
    }

    const info = await stat(absolutePath);
    let metadata: SharpMetadata;
    try {
      metadata = await sharp(absolutePath).metadata();
    } catch (error) {
      issues.push(`asset "${asset.file}" is not a readable image: ${(error as Error).message}`);
      continue;
    }

    if (!metadata.width || !metadata.height) {
      issues.push(`asset "${asset.file}" has no readable dimensions`);
      continue;
    }

    assets.push({
      ...asset,
      absolutePath,
      fileName: path.basename(absolutePath),
      url: `${tenantPublicPath(slug)}/assets/${path.basename(absolutePath)}`,
      bytes: info.size,
      width: metadata.width,
      height: metadata.height,
      format: metadata.format ?? 'unknown',
    });
  }

  // PWA-critical dimensions
  for (const asset of assets) {
    if ((asset.kind === 'icon' || asset.kind === 'maskable') && asset.width !== asset.height) {
      issues.push(`asset "${asset.file}" must be square (it is ${asset.width}x${asset.height})`);
    }
    if (asset.kind === 'maskable' && asset.width < 512) {
      issues.push(`maskable icon must be at least 512x512 (it is ${asset.width}x${asset.height})`);
    }
    if (asset.kind === 'apple-touch' && (asset.width !== 180 || asset.height !== 180)) {
      issues.push(`apple-touch icon must be 180x180 (it is ${asset.width}x${asset.height})`);
    }
  }

  const icon = assets.find((asset) => asset.kind === 'icon');
  const maskable = assets.find((asset) => asset.kind === 'maskable');
  const appleTouch = assets.find((asset) => asset.kind === 'apple-touch');
  if (!icon) issues.push('an "icon" asset is required for the manifest');
  if (!maskable) issues.push('a "maskable" asset is required for the manifest');
  if (!appleTouch) issues.push('an "apple-touch" asset is required for iOS installs');

  // ----- service images ---------------------------------------------------
  for (const service of config.services) {
    if (!service.imageFile) continue;
    const absolutePath = path.resolve(dir, service.imageFile);
    if (!existsSync(absolutePath)) {
      issues.push(`service "${service.key}" references a missing image: ${service.imageFile}`);
    }
  }

  if (issues.length) {
    throw new TenantConfigError(slug, issues);
  }

  return {
    slug,
    dir,
    config,
    hash: hashString(canonicalJson(parsedJson)),
    assets,
  };
}

/** Public URL of a service image, or null when the service has none. */
export function serviceImageUrl(slug: string, service: BusinessConfigParsed['services'][number]): string | null {
  if (!service.imageFile) return null;
  return `${tenantPublicPath(slug)}/assets/${path.basename(service.imageFile)}`;
}

/**
 * The payload sent to `public.publish_tenant_config`.
 *
 * Assets carry their public URL so the database stays the runtime source of
 * truth for the application, while the files themselves are static.
 */
export function toPublishPayload(tenant: LoadedTenant) {
  const { config, assets, slug } = tenant;

  return {
    slug: config.slug,
    name: config.name,
    tagline: config.tagline ?? null,
    description: config.description ?? null,
    status: config.status,
    timezone: config.timezone,
    locale: config.locale,
    currency: config.currency,
    accentColor: config.branding.accentColor,
    accentForeground: config.branding.accentForeground,
    contacts: {
      phone: config.contacts.phone ?? null,
      email: config.contacts.email ?? null,
      whatsapp: config.contacts.whatsapp ?? null,
      telegram: config.contacts.telegram ?? null,
    },
    address: config.address ?? null,
    mapUrl: config.mapUrl ?? null,
    booking: config.booking,
    limits: config.limits,
    ai: { enabled: config.ai.enabled, persona: config.ai.persona ?? null },
    pwa: config.pwa,
    resources: config.resources.map((resource) => ({
      key: resource.key,
      name: resource.name,
      kind: resource.kind,
      description: resource.description ?? null,
      sortOrder: resource.sortOrder,
      isActive: resource.isActive,
    })),
    services: config.services.map((service) => ({
      key: service.key,
      name: service.name,
      description: service.description ?? null,
      durationMin: service.durationMin,
      bufferBeforeMin: service.bufferBeforeMin,
      bufferAfterMin: service.bufferAfterMin,
      priceCents: priceToCents(service),
      currency: service.currency ?? config.currency,
      requiredResourceKind: service.requiredResourceKind,
      category: service.category ?? null,
      imageUrl: serviceImageUrl(slug, service),
      spansDays: service.spansDays,
      sortOrder: service.sortOrder,
      isActive: service.isActive,
    })),
    hours: config.hours.map((row) => ({
      weekday: row.weekday,
      opensAt: row.opensAt,
      closesAt: row.closesAt,
      isClosed: row.isClosed,
    })),
    exceptions: config.exceptions.map((row) => ({
      onDate: row.onDate,
      isClosed: row.isClosed,
      opensAt: row.opensAt ?? null,
      closesAt: row.closesAt ?? null,
      note: row.note ?? null,
    })),
    assets: assets.map((asset) => ({
      kind: asset.kind,
      url: asset.url,
      alt: asset.alt ?? null,
      sortOrder: asset.sortOrder,
      storagePath: null,
    })),
  };
}

export type PublishPayload = ReturnType<typeof toPublishPayload>;
