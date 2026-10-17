// Wall-clock helpers for the profile's time zone (daylight saving included), so a run's date and
// schedule match the day and time the person sees on their own clock.
import { getProfile } from './profile.mjs';

const formats = new Map();
function partsIn(date, timeZone) {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    formats.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(date).map(({ type, value }) => [type, Number(value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute };
}

const pad = (value) => String(value).padStart(2, '0');

// Today's date (YYYY-MM-DD) in the profile's time zone.
export function localDate(now = new Date(), timeZone = getProfile().timeZone) {
  const { year, month, day } = partsIn(now, timeZone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

// The moment a wall-clock time happens in a time zone.
export function zonedTime({ year, month, day, hour, minute }, timeZone) {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  for (let pass = 0; pass < 3; pass++) {
    const seen = partsIn(new Date(guess), timeZone);
    const diff = wanted - Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

// The civil date `offset` days from `now`'s local date, with its weekday (0 = Sunday).
export function shiftedDay(now, offset, timeZone) {
  const { year, month, day } = partsIn(now, timeZone);
  const civil = new Date(Date.UTC(year, month - 1, day + offset));
  return { year: civil.getUTCFullYear(), month: civil.getUTCMonth() + 1, day: civil.getUTCDate(), weekday: civil.getUTCDay(), date: civil.toISOString().slice(0, 10) };
}
