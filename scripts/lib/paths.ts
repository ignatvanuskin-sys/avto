import path from 'node:path';

/** Repository root (the directory that contains package.json). */
export const ROOT = path.resolve(import.meta.dirname, '..', '..');

export const TENANTS_DIR = path.join(ROOT, 'tenants');
export const PUBLIC_DIR = path.join(ROOT, 'public');
/** Everything the pipeline writes for one studio lives under this prefix. */
export const TENANT_PUBLIC_PREFIX = 's';
export const DIST_DIR = path.join(ROOT, 'dist');
export const SUPABASE_DIR = path.join(ROOT, 'supabase');
export const GENERATED_SQL_DIR = path.join(SUPABASE_DIR, 'generated');

/** Public path of a tenant directory, e.g. `/s/graphite-detailing`. */
export function tenantPublicPath(slug: string): string {
  return `/${TENANT_PUBLIC_PREFIX}/${slug}`;
}

export function tenantPublicDir(slug: string, base = PUBLIC_DIR): string {
  return path.join(base, TENANT_PUBLIC_PREFIX, slug);
}

export function tenantDir(slug: string): string {
  return path.join(TENANTS_DIR, slug);
}
