/**
 * server/core/dates.mjs — date/time utilities for Romania timezone.
 */

export const TIMEZONE = 'Europe/Bucharest';

/**
 * Current date/time (UTC-based Date object, same instant as Date.now()).
 * Use formatDateRo() to display in Romanian locale.
 */
export function nowRomania() {
  return new Date();
}

/**
 * Format a Date as 'DD.MM.YYYY HH:mm' in Europe/Bucharest timezone.
 */
export function formatDateRo(date) {
  if (!(date instanceof Date)) date = new Date(date);
  const fmt = new Intl.DateTimeFormat('ro-RO', {
    timeZone: TIMEZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  // Intl returns e.g. "09.04.2026, 14:35" — normalize to "DD.MM.YYYY HH:mm"
  const parts = fmt.formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`;
}

/**
 * Returns true if the given date is in the past.
 */
export function isExpired(date) {
  return new Date(date) < new Date();
}

/**
 * Add n minutes to a date and return a new Date.
 */
export function addMinutes(date, n) {
  return new Date(new Date(date).getTime() + n * 60 * 1000);
}

/**
 * Add n hours to a date and return a new Date.
 */
export function addHours(date, n) {
  return new Date(new Date(date).getTime() + n * 60 * 60 * 1000);
}
