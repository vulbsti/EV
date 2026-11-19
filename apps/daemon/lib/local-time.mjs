/**
 * The person's own time. The page reports the browser's time zone (setting
 * "timeZone"); every time EV tells the person, or reads itself in its prompt,
 * is in that zone. Until a page has reported one, times are UTC and say so.
 * One person per daemon, so the zone is held here once.
 */

let zone = null;

const valid = (tz) => {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch { return false; }
};

/** Sets the zone (an IANA name such as "Asia/Kolkata"); anything else falls back to UTC. Returns what is in force. */
export function useTimeZone(tz) { zone = valid(tz) ? tz : null; return zone; }

/** The zone in force, or null for UTC. */
export function timeZone() { return zone; }

const parts = (at, options) => Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: zone ?? "UTC", hourCycle: "h23", ...options }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
const day = (at) => { const p = parts(at, { year: "numeric", month: "2-digit", day: "2-digit" }); return `${p.year}-${p.month}-${p.day}`; };

/** A time to tell the person: "15:50", "tomorrow 09:10" or "Sat 22 Nov 09:10"; with " UTC" when their zone is not known. */
export function clock(at, now = Date.now()) {
  const p = parts(at, { hour: "2-digit", minute: "2-digit" });
  const hm = `${p.hour}:${p.minute}${zone ? "" : " UTC"}`;
  if (day(at) === day(now)) return hm;
  if (day(at) === day(Number(now) + 86_400_000)) return `tomorrow ${hm}`;
  const d = parts(at, { weekday: "short", day: "numeric", month: "short" });
  return `${d.weekday} ${d.day} ${d.month} ${hm}`;
}

/** The person's date as YYYY-MM-DD. */
export const localDate = (at = Date.now()) => day(at);

/** How many ms the zone is ahead of UTC at a moment. */
function offset(at) {
  const p = parts(at, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(new Date(at).getTime() / 1000) * 1000;
}

/** The instant a YYYY-MM-DD day starts, or (end true) its last second, in the person's zone. */
export function dayEdge(date, { end = false } = {}) {
  const wall = Date.parse(`${date}T${end ? "23:59:59" : "00:00:00"}.000Z`);
  if (Number.isNaN(wall)) return null;
  return new Date(wall - offset(wall - offset(wall))).toISOString();
}

/** The line that tells EV what day and time it is for the person. */
export function nowLine(now = new Date()) {
  const date = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: zone ?? "UTC" }).format(now);
  const p = parts(now, { hour: "2-digit", minute: "2-digit" });
  return zone
    ? `Today is ${date}; the time is ${p.hour}:${p.minute} where the person is (${zone}).`
    : `Today is ${date}; the time is ${p.hour}:${p.minute} UTC (the person's time zone is not known yet).`;
}

/** A timestamp for EV's prompt, "YYYY-MM-DD HH:MM", in the person's zone (the prompt's first line names it). */
export function stamp(at) { const p = parts(at, { hour: "2-digit", minute: "2-digit" }); return `${day(at)} ${p.hour}:${p.minute}`; }
