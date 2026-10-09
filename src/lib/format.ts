/**
 * Every date and every amount on screen is rendered in the studio's timezone
 * and currency. The interface and the AI assistant share these helpers, which
 * is how the two can never report a different period for the same data.
 */
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import { ru } from 'date-fns/locale';

export function formatMoney(
  cents: number,
  currency: string,
  locale = 'ru-RU',
  options: { withDecimals?: boolean } = {},
): string {
  const fractionDigits = options.withDecimals ? 2 : 0;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(fractionDigits)} ${currency}`;
  }
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    return restHours === 0 ? `${days} сут` : `${days} сут ${restHours} ч`;
  }
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

/** "пт, 9 октября · 14:30" in the studio timezone. */
export function formatInstant(iso: string, timezone: string, pattern = 'EEE, d MMMM · HH:mm'): string {
  try {
    return formatInTimeZone(new Date(iso), timezone, pattern, { locale: ru });
  } catch {
    return iso;
  }
}

export function formatTime(iso: string, timezone: string): string {
  return formatInstant(iso, timezone, 'HH:mm');
}

export function formatDay(iso: string, timezone: string): string {
  return formatInstant(iso, timezone, 'd MMMM, EEE');
}

/** `YYYY-MM-DD` as seen in the studio timezone. */
export function toLocalIsoDate(iso: string, timezone: string): string {
  return formatInTimeZone(new Date(iso), timezone, 'yyyy-MM-dd');
}

export function todayInZone(timezone: string): string {
  return formatInTimeZone(new Date(), timezone, 'yyyy-MM-dd');
}

export function addDaysToIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function minutesSinceMidnight(iso: string, timezone: string): number {
  const zoned = toZonedTime(new Date(iso), timezone);
  return zoned.getHours() * 60 + zoned.getMinutes();
}

const WEEKDAY_NAMES: Record<number, string> = {
  1: 'Понедельник',
  2: 'Вторник',
  3: 'Среда',
  4: 'Четверг',
  5: 'Пятница',
  6: 'Суббота',
  7: 'Воскресенье',
};

export function weekdayName(weekday: number): string {
  return WEEKDAY_NAMES[weekday] ?? String(weekday);
}

/** Short label for a booking status, plus the tone the UI should use. */
export function statusLabel(status: string): { label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' } {
  switch (status) {
    case 'confirmed':
      return { label: 'Подтверждена', tone: 'good' };
    case 'pending':
      return { label: 'Ожидает подтверждения', tone: 'warn' };
    case 'in_progress':
      return { label: 'В работе', tone: 'warn' };
    case 'completed':
      return { label: 'Выполнена', tone: 'good' };
    case 'cancelled':
      return { label: 'Отменена', tone: 'bad' };
    case 'no_show':
      return { label: 'Не приехал', tone: 'bad' };
    default:
      return { label: status, tone: 'neutral' };
  }
}

/** Number of nights a multi-day service spans, for a honest duration label. */
export function spansNights(durationMin: number): number {
  return Math.max(0, Math.ceil(durationMin / 1440) - 1);
}
