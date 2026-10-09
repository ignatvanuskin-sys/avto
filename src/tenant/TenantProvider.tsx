/**
 * Tenant context.
 *
 * The shell injects `window.__TENANT__` with metadata and the accent colour, so
 * the studio is branded before any network call. Everything else — services,
 * prices, working hours — is read from the database, which is the runtime
 * source of truth.
 *
 * The accent drives two things:
 *   * an Astryx theme derived from the studio's colour seed (`defineTheme`), so
 *     every design-system component adopts the brand palette;
 *   * a `--tenant-accent` custom property, for the few places that need the
 *     studio's exact hex rather than the derived palette.
 */
import { useEffect, useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Theme, defineTheme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { fetchTenantProfile } from '@/lib/api';
import { backendConfig } from '@/lib/backend';
import type { PublicTenantProfile, TenantBoot } from '@shared/tenant-types';

export interface TenantState {
  boot: TenantBoot | null;
  /** Path prefix of this studio, e.g. `/s/graphite-detailing/`. */
  basePath: string;
  profile: PublicTenantProfile | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function readBootPayload(): TenantBoot | null {
  if (typeof window === 'undefined') return null;
  return window.__TENANT__ ?? null;
}

/** Slug from the boot payload, or from the URL when running `vite dev`. */
export function readSlugFromLocation(): string | null {
  const boot = readBootPayload();
  if (boot?.slug) return boot.slug;
  const match = /^\/s\/([^/]+)/.exec(window.location.pathname);
  return match?.[1] ?? null;
}

export function readBasePath(): string {
  const boot = readBootPayload();
  if (boot?.basePath) return boot.basePath;
  const slug = readSlugFromLocation();
  return slug ? `/s/${slug}/` : '/';
}

export function useTenant(): TenantState {
  const boot = readBootPayload();
  const slug = readSlugFromLocation();
  const basePath = readBasePath();

  const query = useQuery({
    queryKey: ['tenant-profile', slug],
    enabled: Boolean(slug) && backendConfig.isConfigured,
    staleTime: 60_000,
    retry: 1,
    queryFn: async () => {
      if (!slug) throw new Error('Не удалось определить студию из адреса.');
      return fetchTenantProfile(slug);
    },
  });

  return {
    boot,
    basePath,
    profile: query.data ?? null,
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
    refetch: () => {
      void query.refetch();
    },
  };
}

/**
 * A theme per studio. `defineTheme` derives the whole accent palette from the
 * studio's seed with the HCT model, so we never hand-pick a second colour and
 * light/dark contrast stays correct.
 */
function useTenantTheme(slug: string | null, accent: string) {
  return useMemo(
    () =>
      defineTheme({
        name: `tenant-${slug ?? 'default'}`,
        extends: neutralTheme,
        color: { accent },
      }),
    [slug, accent],
  );
}

export function TenantThemeProvider({
  slug,
  accent,
  accentForeground,
  children,
}: {
  slug: string | null;
  accent: string;
  accentForeground: string;
  children: ReactNode;
}) {
  const theme = useTenantTheme(slug, accent);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--tenant-accent', accent);
    root.style.setProperty('--tenant-accent-foreground', accentForeground);
    return () => {
      root.style.removeProperty('--tenant-accent');
      root.style.removeProperty('--tenant-accent-foreground');
    };
  }, [accent, accentForeground]);

  return (
    <Theme theme={theme} mode="dark">
      {children}
    </Theme>
  );
}
