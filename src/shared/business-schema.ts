/**
 * business.json is the single input of the tenant pipeline.
 *
 * This module is shared by:
 *   * `scripts/tenant/*` — validate / publish / verify;
 *   * the application — to type the published configuration it reads back.
 *
 * It intentionally contains no business names: every concrete studio lives in
 * its own `tenants/<slug>/business.json`.
 */
import { z } from 'zod';

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** `2026-01-31` */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected an ISO date (YYYY-MM-DD)')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'not a real date');

/** `09:00` */
const clockTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM in 24-hour form');

const slug = z
  .string()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes only');

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'expected a #rrggbb colour');

/**
 * Money is always stored as an integer number of minor units. The config lets
 * an author write `price: 3500` (major units) which is converted to 350000
 * cents exactly once, here, so no rounding ever happens downstream.
 */
export const priceSchema = z.union([
  z.object({ priceCents: z.number().int().nonnegative() }),
  z.object({ price: z.number().nonnegative().max(100_000_000) }),
]);

export const resourceSchema = z.object({
  key: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase letters, digits, dash and underscore'),
  name: z.string().min(1).max(120),
  kind: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[a-z][a-z0-9_]*$/, 'lowercase identifier, e.g. post, bay, lift'),
  description: z.string().max(500).optional(),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  isActive: z.boolean().default(true),
});

export const serviceSchema = z
  .object({
    key: z
      .string()
      .min(2)
      .max(48)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase letters, digits, dash and underscore'),
    name: z.string().min(1).max(160),
    description: z.string().max(2000).optional(),
    durationMin: z.number().int().min(5).max(43200),
    bufferBeforeMin: z.number().int().min(0).max(2880).default(0),
    bufferAfterMin: z.number().int().min(0).max(2880).default(0),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    /** Resource kind that can serve this service. */
    requiredResourceKind: z
      .string()
      .min(2)
      .max(32)
      .regex(/^[a-z][a-z0-9_]*$/),
    category: z.string().max(60).optional(),
    imageFile: z.string().max(200).optional(),
    /** true for work that keeps the resource for several days in a row. */
    spansDays: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(9999).default(0),
    isActive: z.boolean().default(true),
  })
  .and(priceSchema);

export const hoursSchema = z.object({
  weekday: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7)]),
  opensAt: clockTime,
  closesAt: clockTime,
  isClosed: z.boolean().default(false),
});

export const exceptionSchema = z
  .object({
    onDate: isoDate,
    isClosed: z.boolean().default(true),
    opensAt: clockTime.optional(),
    closesAt: clockTime.optional(),
    note: z.string().max(200).optional(),
  })
  .refine((value) => value.isClosed || (value.opensAt && value.closesAt), {
    message: 'an open exception needs opensAt and closesAt',
    path: ['opensAt'],
  })
  .refine((value) => !value.opensAt || !value.closesAt || value.closesAt > value.opensAt, {
    message: 'closesAt must be after opensAt',
    path: ['closesAt'],
  });

export const assetSchema = z.object({
  kind: z.enum([
    'logo',
    'hero',
    'gallery',
    'icon',
    'maskable',
    'apple-touch',
    'startup',
    'other',
  ]),
  /** Path relative to the tenant directory. */
  file: z.string().min(1).max(200),
  alt: z.string().max(200).optional(),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});

export const businessConfigSchema = z
  .object({
    $schema: z.string().optional(),
    slug,
    name: z.string().min(1).max(120),
    shortName: z.string().min(1).max(24).optional(),
    tagline: z.string().max(200).optional(),
    description: z.string().max(4000).optional(),
    /** preview until the owner explicitly activates the studio. */
    status: z.enum(['preview', 'live', 'suspended']).default('preview'),
    timezone: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[A-Za-z]+\/[A-Za-z_+-]+$/, 'expected an IANA timezone, e.g. Europe/Moscow'),
    locale: z.string().min(2).max(16).default('ru-RU'),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default('RUB'),
    branding: z.object({
      accentColor: hexColor,
      accentForeground: hexColor.default('#0b0b0c'),
      themeColor: hexColor.optional(),
      backgroundColor: hexColor.default('#0b0b0c'),
    }),
    contacts: z
      .object({
        phone: z.string().max(40).optional(),
        email: z.string().email().max(160).optional(),
        whatsapp: z.string().max(200).optional(),
        telegram: z.string().max(200).optional(),
      })
      .default({}),
    address: z.string().max(300).optional(),
    mapUrl: z.string().url().max(500).optional(),
    booking: z
      .object({
        leadMinutes: z.number().int().min(0).max(43200).default(60),
        horizonDays: z.number().int().min(1).max(730).default(45),
        slotStepMinutes: z.number().int().min(5).max(480).default(30),
        minCancelNoticeMinutes: z.number().int().min(0).max(43200).default(120),
      })
      .default({
        leadMinutes: 60,
        horizonDays: 45,
        slotStepMinutes: 30,
        minCancelNoticeMinutes: 120,
      }),
    limits: z
      .object({
        publicRateLimitPerMinute: z.number().int().min(1).max(100000).default(90),
        aiCallsPerDay: z.number().int().min(0).max(100000).default(200),
      })
      .default({ publicRateLimitPerMinute: 90, aiCallsPerDay: 200 }),
    ai: z
      .object({
        enabled: z.boolean().default(false),
        persona: z.string().max(2000).optional(),
      })
      .default({ enabled: false }),
    pwa: z
      .object({
        display: z.enum(['standalone', 'minimal-ui', 'fullscreen']).default('standalone'),
        orientation: z.enum(['portrait', 'portrait-primary', 'any']).default('portrait'),
      })
      .default({ display: 'standalone', orientation: 'portrait' }),
    resources: z.array(resourceSchema).min(1, 'at least one resource is required'),
    services: z.array(serviceSchema).min(1, 'at least one service is required'),
    hours: z.array(hoursSchema).min(1, 'at least one working-hours row is required'),
    exceptions: z.array(exceptionSchema).default([]),
    assets: z.array(assetSchema).default([]),
  })
  .superRefine((config, ctx) => {
    // unique keys
    for (const [field, items] of [
      ['resources', config.resources],
      ['services', config.services],
    ] as const) {
      const seen = new Set<string>();
      for (const item of items) {
        if (seen.has(item.key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate key "${item.key}"`,
            path: [field],
          });
        }
        seen.add(item.key);
      }
    }

    // every service must point at an existing resource kind
    const kinds = new Set(config.resources.map((resource) => resource.kind));
    config.services.forEach((service, index) => {
      if (!kinds.has(service.requiredResourceKind)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `no resource has kind "${service.requiredResourceKind}"`,
          path: ['services', index, 'requiredResourceKind'],
        });
      }
    });

    // all seven weekdays must be described, otherwise a day would silently be
    // "no hours configured" which is indistinguishable from a bug
    const weekdays = new Set(config.hours.map((row) => row.weekday));
    if (weekdays.size !== 7) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'working hours must describe all 7 weekdays (use isClosed for days off)',
        path: ['hours'],
      });
    }

    // a closed day must not carry a window, an open day must
    config.hours.forEach((row, index) => {
      if (!row.isClosed && !(row.closesAt > row.opensAt)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'closesAt must be after opensAt on an open day',
          path: ['hours', index, 'closesAt'],
        });
      }
    });

    // the grid has to divide the shortest service, otherwise a 40-minute
    // service would never be offered on a 30-minute grid
    const shortest = Math.min(...config.services.map((service) => service.durationMin));
    if (config.booking.slotStepMinutes > shortest) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `slotStepMinutes (${config.booking.slotStepMinutes}) is longer than the shortest service (${shortest} min)`,
        path: ['booking', 'slotStepMinutes'],
      });
    }

    // at most one of each singleton asset kind
    const singletonKinds = ['icon', 'maskable', 'apple-touch', 'hero', 'logo'] as const;
    for (const kind of singletonKinds) {
      const matches = config.assets.filter((asset) => asset.kind === kind);
      if (matches.length > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `only one "${kind}" asset is allowed`,
          path: ['assets'],
        });
      }
    }
  });

export type BusinessConfig = z.input<typeof businessConfigSchema>;
export type BusinessConfigParsed = z.output<typeof businessConfigSchema>;
export type ServiceConfig = BusinessConfigParsed['services'][number];
export type ResourceConfig = BusinessConfigParsed['resources'][number];
export type AssetConfig = BusinessConfigParsed['assets'][number];

/** Resolve the price of a service to integer minor units. */
export function priceToCents(service: { priceCents?: number; price?: number }): number {
  if (typeof service.priceCents === 'number') {
    return Math.round(service.priceCents);
  }
  if (typeof service.price === 'number') {
    return Math.round(service.price * 100);
  }
  throw new Error('a service must declare either priceCents or price');
}

/** The published shape sent to `public.publish_tenant_config`. */
export function toPublishedConfig(config: BusinessConfigParsed) {
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
    assets: config.assets.map((asset) => ({
      kind: asset.kind,
      alt: asset.alt ?? null,
      sortOrder: asset.sortOrder,
    })),
  };
}
