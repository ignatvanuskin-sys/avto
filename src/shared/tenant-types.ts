/**
 * Shapes returned by the database RPCs and the Edge Functions.
 *
 * They mirror `supabase/migrations/0009_rpc_booking.sql` and
 * `0010_rpc_owner.sql`; keeping them in one file makes a server/client
 * mismatch obvious instead of silent.
 */

export interface TenantBoot {
  slug: string;
  basePath: string;
  name: string;
  locale: string;
  timezone: string;
  currency: string;
  accentColor: string;
  accentForeground: string;
  themeColor: string;
  configUrl: string;
  serviceWorkerUrl: string;
  serviceWorkerScope: string;
  configHash: string;
}

export interface PublicService {
  key: string;
  name: string;
  description: string | null;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  priceCents: number;
  currency: string;
  category: string | null;
  imageUrl: string | null;
  spansDays: boolean;
  resourceKind: string;
}

export interface PublicAsset {
  kind: string;
  url: string | null;
  alt: string | null;
}

export interface PublicHours {
  weekday: number;
  opensAt: string;
  closesAt: string;
  isClosed: boolean;
}

export interface PublicTenantProfile {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  description: string | null;
  status: 'preview' | 'live' | 'suspended';
  timezone: string;
  locale: string;
  currency: string;
  accentColor: string;
  accentForeground: string;
  contactPhone: string | null;
  contactEmail: string | null;
  contactWhatsapp: string | null;
  contactTelegram: string | null;
  address: string | null;
  mapUrl: string | null;
  booking: {
    leadMinutes: number;
    horizonDays: number;
    slotStepMinutes: number;
    minCancelNoticeMinutes: number;
  };
  ai: { enabled: boolean };
  assets: PublicAsset[];
  services: PublicService[];
  resources: Array<{ key: string; name: string; kind: string }>;
  hours: PublicHours[];
}

export interface AvailabilitySlot {
  slot_start: string;
  slot_resource_id: string;
  slot_resource_name: string;
}

export interface BookingSummary {
  bookingId: string;
  displayNumber: number;
  tenantSlug: string;
  serviceKey: string;
  serviceName: string;
  resourceId?: string;
  startsAt: string;
  endsAt: string;
  priceCents: number;
  currency: string;
  status: BookingStatus;
  timezone: string;
  replayed?: boolean;
  previousStartsAt?: string;
}

export type BookingStatus =
  | 'pending'
  | 'confirmed'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export interface BookingPayment {
  id: string;
  amountCents: number;
  currency: string;
  method: string;
  status: string;
  paidAt: string | null;
}

export interface BookingView {
  bookingId: string;
  displayNumber: number;
  tenantSlug: string;
  tenantName: string;
  timezone: string;
  currency: string;
  status: BookingStatus;
  startsAt: string;
  endsAt: string;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  serviceKey: string;
  serviceName: string;
  resourceName: string;
  priceCents: number;
  customerName: string;
  customerPhone: string;
  customerComment: string | null;
  minCancelNoticeMinutes: number;
  canReschedule: boolean;
  canCancel: boolean;
  payments: BookingPayment[];
}

export interface OwnerTenantContext {
  tenantId: string;
  slug: string;
  name: string;
  role: 'owner' | 'manager' | 'master' | 'viewer';
  status: 'preview' | 'live' | 'suspended';
  timezone: string;
  currency: string;
  accentColor: string;
}

export interface OwnerStats {
  period: { from: string; to: string; timezone: string };
  visits: number;
  completedOrders: number;
  noShowOrders: number;
  cancelledOrders: number;
  receivedPaymentsCents: number;
  refundedPaymentsCents: number;
  completedValueCents: number;
  outstandingCents: number;
  scheduledValueCents: number;
  scheduledNote: string;
  capacity: { bookedMinutes: number; availableMinutes: number; utilization: number };
  currency: string;
}

export interface OwnerBookingRow {
  id: string;
  display_number: number;
  starts_at: string;
  ends_at: string;
  status: BookingStatus;
  price_cents: number;
  currency: string;
  service_name: string;
  resource_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  is_demo: boolean;
}

export interface OwnerOccupancyRow {
  id: string;
  resource_id: string;
  resource_name: string | null;
  kind: 'booking' | 'block';
  block_reason: string | null;
  period: string;
  starts_at: string;
  ends_at: string;
}

export interface NotificationJobRow {
  id: string;
  kind: string;
  channel: string;
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'dead';
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  run_after: string;
  sent_at: string | null;
}

export interface AiUsageRow {
  window_start: string;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
}

/** Uniform result of an Edge Function call. */
export type ApiResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; code: string; message: string; status: number };
