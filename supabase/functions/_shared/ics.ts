/**
 * Pure iCalendar (RFC 5545) builders.
 *
 * There are no Deno and no network APIs here, so every function can be unit
 * tested with a plain test runner. All output uses CRLF line endings and
 * 75-octet line folding.
 */

export interface IcsEvent {
  /** Stable identity for the event (derived from the booking id). */
  uid: string;
  startsAt: string | Date;
  /** DTEND, exclusive. */
  endsAt: string | Date;
  summary: string;
  description?: string;
  location?: string;
  /** When true the event is emitted as a cancellation. */
  cancelled?: boolean;
  /** DTSTAMP; defaults to "now" when omitted. */
  stamp?: string | Date;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Format a date as an iCalendar UTC timestamp: `YYYYMMDDTHHMMSSZ`. */
export function toIcsUtc(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`toIcsUtc: invalid date ${String(value)}`);
  }
  return (
    `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}` +
    `T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`
  );
}

/** Escape a text value for safe use inside an iCalendar content line. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold one content line to at most 75 octets per physical line, inserting a
 * CRLF and a single leading space. Iteration is by code point, so a multi-byte
 * UTF-8 character is never split across a fold boundary.
 */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  const limit = 75;
  if (encoder.encode(line).length <= limit) {
    return line;
  }

  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  // The first physical line has no leading space; every continuation adds one,
  // which reduces that line's usable content to 74 octets.
  let capacity = limit;

  for (const char of line) {
    const charBytes = encoder.encode(char).length;
    if (current !== '' && currentBytes + charBytes > capacity) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
      capacity = limit - 1;
    }
    current += char;
    currentBytes += charBytes;
  }
  chunks.push(current);

  return chunks.join('\r\n ');
}

/** Build a complete VCALENDAR containing a single VEVENT. */
export function buildIcs(event: IcsEvent): string {
  const cancelled = event.cancelled === true;
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Booking PWA//Booking//RU',
    'CALSCALE:GREGORIAN',
    `METHOD:${cancelled ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(event.uid)}`,
    `DTSTAMP:${toIcsUtc(event.stamp ?? new Date())}`,
    `DTSTART:${toIcsUtc(event.startsAt)}`,
    `DTEND:${toIcsUtc(event.endsAt)}`,
    `SUMMARY:${escapeIcsText(event.summary)}`,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    `SEQUENCE:${cancelled ? 1 : 0}`,
  ];

  if (event.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  }
  if (event.location) {
    lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');

  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}
