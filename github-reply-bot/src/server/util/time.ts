const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseHHmm(value: string): number | null {
  const match = HHMM.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function minutesInTimeZone(date: Date, timeZone: string): number | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 'NaN');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 'NaN');
    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
    return (hour % 24) * 60 + minute;
  } catch {
    return null;
  }
}

/**
 * Quiet hours are inclusive of the start and exclusive of the end. Windows that
 * wrap midnight (e.g. 22:00-08:00) are supported; start === end means "off".
 */
export function isQuietHours(date: Date, start: string, end: string, timeZone: string): boolean {
  const startMinutes = parseHHmm(start);
  const endMinutes = parseHHmm(end);
  const nowMinutes = minutesInTimeZone(date, timeZone);
  if (startMinutes === null || endMinutes === null || nowMinutes === null) return false;
  if (startMinutes === endMinutes) return false;
  if (startMinutes < endMinutes) return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

export function startOfLocalDay(date: Date): Date {
  const copy = new Date(date.getTime());
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function hoursAgo(date: Date, hours: number): Date {
  return new Date(date.getTime() - hours * 60 * 60 * 1000);
}
