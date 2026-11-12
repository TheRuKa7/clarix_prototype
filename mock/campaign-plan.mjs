// Planning for the New campaign modal: which slots are free for a country, and when a campaign should be done.
// Keep this file identical in the Echo and Clarix mocks.
import { countryRule, fitSlot } from './calling-report.mjs';

const SLOT_MIN = 30;
/** Lines (caller numbers) the workspace dials from. Two agents on the same line cannot call at the same time. */
const LINES = ['+91 80 4718 2290', '+91 22 6190 4410'];
const IST_MIN = 330;
const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
const two = (n) => String(n).padStart(2, '0');
const clock = (ms) => { const d = new Date(ms); return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`; };

/** Campaigns started or scheduled from the modal: { line, label, startMs, endMs }. */
export const bookings = [];
/** Campaigns waiting for their start time: { at, run }. */
export const pendingStarts = [];

export const lineOf = (agents, key) => LINES[Math.max(0, agents.findIndex((a) => a.key === key)) % LINES.length];

/** The other agents that share this agent's line are busy for a block each day (demo stand-in for their real schedules). */
function neighbourBookings(agents, key, nowMs) {
  const line = lineOf(agents, key); const ist = new Date(nowMs + IST_MIN * 60000); const out = [];
  agents.forEach((o, i) => {
    if (o.key === key || LINES[i % LINES.length] !== line) return;
    for (let d = 0; d < 14; d += 1) {
      const midnight = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + d) - IST_MIN * 60000; const from = 10 + (i % 3) * 2;
      out.push({ line, label: o.label, startMs: midnight + from * 3600000, endMs: midnight + (from + 1.5) * 3600000 });
    }
  });
  return out;
}

/** Half-hour slots on one local date in a country: inside its calling hours, each free or taken on the agent's line. */
export function slotsFor({ agents, agent, country, date, nowMs = Date.now() }) {
  const c = countryRule(country); const off = c.offset_min * 60000;
  const today = new Date(nowMs + off).toISOString().slice(0, 10); const ymd = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : today;
  const midnight = Date.parse(`${ymd}T00:00:00Z`) - off; const wd = new Date(midnight + off).getUTCDay(); const d = c.days[wd];
  const holiday = c.holidays.find((h) => h.date === ymd);
  const base = { country: c.code, name: c.name, tz_label: c.tz_label, law: c.law, date: ymd, today, line: lineOf(agents, agent), hours: d.on ? { from: d.from, to: d.to } : null, slots: [] };
  if (ymd < today) return { ...base, closed: 'That date has passed.' };
  if (!d.on) return { ...base, closed: `${c.name} does not allow calls on this day.` };
  if (holiday) return { ...base, closed: `Public holiday in ${c.name}: ${holiday.name}.` };
  const busy = [...neighbourBookings(agents, agent, nowMs), ...bookings.filter((b) => b.line === base.line && b.endMs > nowMs)];
  for (let m = hm(d.from); m + SLOT_MIN <= hm(d.to); m += SLOT_MIN) {
    const at = midnight + m * 60000; if (at <= nowMs) continue;
    const hit = busy.find((b) => b.startMs < at + SLOT_MIN * 60000 && b.endMs > at);
    const utcDay = (Date.parse(new Date(at).toISOString().slice(0, 10)) - Date.parse(ymd)) / 86400000;
    base.slots.push({ at: new Date(at).toISOString(), local: clock(at + off), utc: clock(at), utc_day: utcDay, status: hit ? 'taken' : 'free', by: hit?.label || '' });
  }
  return base.slots.length ? { ...base, closed: '' } : { ...base, closed: 'No slots left today. Pick another date.' };
}

/** When a campaign of `calls` starting at startMs should be done, and when to look at it. Calling hours of the country are respected. */
export function estimateRun(calls, startMs, country) {
  const c = countryRule(country); const off = c.offset_min * 60000; const rule = { from: '00:00', to: '23:59' };
  let t = fitSlot(startMs, rule, c).at; const begin = t; let left = Math.ceil(Math.max(0, calls) / 4) * 2; const total = left;
  for (let i = 0; i < 80 && left > 0; i += 1) {
    t = fitSlot(t, rule, c).at; const local = new Date(t + off); const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
    const room = Math.max(1, hm(c.days[local.getUTCDay()].to) - mins); const use = Math.min(room, left); left -= use; t += use * 60000;
  }
  const checkBack = Math.ceil((t + 10 * 60000) / 300000) * 300000;
  return { calls, starts_at: new Date(begin).toISOString(), ends_at: new Date(t).toISOString(), check_back_at: new Date(checkBack).toISOString(), duration_min: total,
    spans_days: new Date(begin + off).toISOString().slice(0, 10) !== new Date(t + off).toISOString().slice(0, 10), country: c.code, tz_label: c.tz_label, offset_min: c.offset_min };
}

/**
 * Plans a start from the modal: books the line and says whether the campaign waits. `when` is 'now' or an ISO time.
 * Returns { later, est } or { error }.
 */
export function planStart({ agents, agent, label, calls, when, country, nowMs = Date.now() }) {
  const startMs = !when || when === 'now' ? nowMs : Date.parse(when);
  if (!Number.isFinite(startMs)) return { error: 'Pick a valid start time' };
  if (startMs > nowMs + 60000) {
    const free = slotsFor({ agents, agent, country, date: new Date(startMs + countryRule(country).offset_min * 60000).toISOString().slice(0, 10), nowMs });
    const hit = free.slots.find((s) => Date.parse(s.at) === startMs);
    if (!hit) return { error: 'That time is not an open slot for this country' };
    if (hit.status === 'taken') return { error: `That slot is in use on ${free.line}${hit.by ? ` by ${hit.by}` : ''}` };
  }
  const est = estimateRun(calls, startMs, country);
  bookings.push({ line: lineOf(agents, agent), label, startMs: Date.parse(est.starts_at), endMs: Date.parse(est.ends_at) });
  return { later: startMs > nowMs + 60000, est };
}

/** Starts every waiting campaign whose time has come. */
export async function releaseDue(nowMs = Date.now()) {
  for (const p of [...pendingStarts]) {
    if (p.at > nowMs) continue;
    pendingStarts.splice(pendingStarts.indexOf(p), 1); await p.run();
  }
}
