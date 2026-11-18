/**
 * Returns the ISO 8601 week string for a local calendar date (e.g. '2026-W47').
 * Complies with ISO week-numbering rules where Monday is day 1 and Week 1 contains Jan 4.
 */
export function isoWeekLabel(localDate: { year: number; month: number; day: number }): string {
  const target = new Date(Date.UTC(localDate.year, localDate.month - 1, localDate.day));
  // ISO day of week: 1 = Mon, ..., 7 = Sun
  const dayNr = ((target.getUTCDay() + 6) % 7) + 1;
  // Nearest Thursday is target + (4 - dayNr)
  target.setUTCDate(target.getUTCDate() + (4 - dayNr));
  const isoYear = target.getUTCFullYear();
  const firstJan = new Date(Date.UTC(isoYear, 0, 1));
  const dayDiff = Math.floor((target.getTime() - firstJan.getTime()) / 86_400_000);
  const weekNr = Math.floor(dayDiff / 7) + 1;
  return `${isoYear}-W${String(weekNr).padStart(2, '0')}`;
}

/**
 * Returns the schedule slot label in UTC format: 'sYYYYMMDDTHHmmZ' (e.g. 's20261120T0900Z').
 */
export function scheduleSlotLabel(slot: Date): string {
  const y = slot.getUTCFullYear();
  const m = String(slot.getUTCMonth() + 1).padStart(2, '0');
  const d = String(slot.getUTCDate()).padStart(2, '0');
  const h = String(slot.getUTCHours()).padStart(2, '0');
  const mi = String(slot.getUTCMinutes()).padStart(2, '0');
  return `s${y}${m}${d}T${h}${mi}Z`;
}

/**
 * Renders a deduplication key from a template and placeholder variables.
 * Allowed placeholders: {postType}, {eventId}, {slot}, {date}, {week}.
 * Throws RangeError on unknown placeholder.
 */
export function renderDedupeKey(
  template: string,
  vars: { postType: string; eventId: string; slot: string; date: string; week: string },
): string {
  return template.replace(/\{([^}]*)\}/g, (_match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      return (vars as Record<string, string>)[name]!;
    }
    throw new RangeError(`Unknown deduplication placeholder: {${name}}`);
  });
}
