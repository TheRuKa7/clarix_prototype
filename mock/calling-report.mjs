// Calling report, definitions v1 (30 Oct 2026): Calling-Report-Logic.md and PRD-Call-Outcome-and-Funnel.md.
// One status per uploaded row, decided once when the call ends, and every dashboard number worked out from
// those stored statuses. The Echo and Clarix mocks share this file: keep the two copies identical.

import { dncScan, onDnc, checkAlerts, pausedOf } from './wave1.mjs';

export const DEFINITIONS_VERSION = 'v1 · 30 Oct 2026';
/** A picked-up call shorter than this is "Agent not given time to speak" (a workspace setting). */
export const SHORT_CALL_SECONDS = 15;

/** The 14 export columns, in order. */
export const COLUMNS = [
  ['call_date', 'Call Date'], ['agent', 'Agent name'], ['campaign', 'Campaign name'], ['uploaded_by', 'Uploaded by'], ['caller_name', 'Caller Name'],
  ['phone', 'Phone'], ['email', 'Email'], ['summary', 'Call Summary'], ['call_status', 'Call Status'], ['status_reason', 'Status Reason'],
  ['callback_at', 'Call back date and time'], ['duration_seconds', 'Duration'], ['retries', 'Retries'], ['goal_reached', 'Goal Reached'],
];

/**
 * Logic doc section 2: checks in order, the first that matches wins.
 * f: { isTest, badData (the check's message), stopped, inProgress, line ('no_answer' | 'dnd' | 'voicemail' | 'picked'),
 *      talkSeconds, spoke, audioFailed, result ('callback' | 'accepted' | 'partial' | 'follow_up' | 'left' | 'wrong_number' | null) }
 * Returns { call_status, status_reason, goal_reached, test_status }.
 */
export function decideStatus(f) {
  if (f.isTest) {
    const as = decideStatus({ ...f, isTest: false });
    return { call_status: 'Internal test call', status_reason: as.status_reason, goal_reached: 'N/A', test_status: as.call_status, test_goal: as.goal_reached };
  }
  const s = (call_status, status_reason, goal_reached = 'N/A') => ({ call_status, status_reason, goal_reached });
  if (f.badData) return s('Bad data', f.badData);
  // Not in the logic doc's table: rows the user stopped before they were dialled, and rows still being dialled.
  if (f.stopped) return s('Stopped', 'Stopped before dialling');
  if (f.inProgress) return s('In progress', 'Still being dialled');
  if (f.line === 'no_answer') return s('Not picked', 'No answer');
  if (f.line === 'dnd') return s('DND', 'DND');
  if (f.line === 'voicemail') return s('Voicemail', 'Voicemail');
  const short = (f.talkSeconds || 0) < SHORT_CALL_SECONDS;
  if (short && (!f.spoke || f.audioFailed)) return s('Answered', 'Agent not given time to speak', 'No');
  if (!f.spoke) return s('No reply', 'Silent');
  if (f.audioFailed) return s('System issue', 'System issue');
  if (f.result === 'callback') return s('Answered', 'Success: Callback requested', 'Yes');
  if (f.result === 'accepted') return s('Answered', 'Success: Accepted', 'Yes');
  if (f.result === 'partial') return s('Answered', 'Success: Partial', 'Yes');
  if (f.result === 'follow_up') return s('Answered', 'Success: Follow-up required', 'Yes');
  if (f.result === 'wrong_number') return s('Answered', 'Wrong number', 'No');
  return s('Answered', short ? 'Agent not given time to speak' : 'Left before answering', 'No');
}

// ── Which rows sit in which box ───────────────────────────────────────────────
const isStatus = (st) => (r) => r.call_status === st;
const isReason = (re) => (r) => r.call_status === 'Answered' && r.status_reason === re;
const isSuccess = (r) => r.call_status === 'Answered' && String(r.status_reason).startsWith('Success');
const PLANNED_OUT = new Set(['Bad data', 'Internal test call', 'Stopped']);
// Rows still being dialled (waiting, on a call, or waiting for a retry) have no result yet: they sit under Planned as
// "Not finished", never under Picked up, and stay out of every rate until they end.
const UNFINISHED = 'In progress';
const NOT_PICKED = new Set(['Not picked', 'DND', 'Voicemail']);
export const BOX = {
  uploaded: () => true,
  test: isStatus('Internal test call'),
  bad_data: isStatus('Bad data'),
  stopped: isStatus('Stopped'),
  planned: (r) => !PLANNED_OUT.has(r.call_status),
  not_picked_up: (r) => NOT_PICKED.has(r.call_status),
  picked_up: (r) => !PLANNED_OUT.has(r.call_status) && !NOT_PICKED.has(r.call_status) && r.call_status !== UNFINISHED,
  finished: (r) => !PLANNED_OUT.has(r.call_status) && r.call_status !== UNFINISHED,
  no_answer: isStatus('Not picked'),
  dnd: isStatus('DND'),
  voicemail: isStatus('Voicemail'),
  answered: isStatus('Answered'),
  silent: isStatus('No reply'),
  system_issue: isStatus('System issue'),
  in_progress: isStatus(UNFINISHED),
  success: isSuccess,
  accepted: isReason('Success: Accepted'),
  partial: isReason('Success: Partial'),
  follow_up: isReason('Success: Follow-up required'),
  callback: isReason('Success: Callback requested'),
  not_successful: (r) => r.call_status === 'Answered' && !isSuccess(r),
  not_given_time: isReason('Agent not given time to speak'),
  left: isReason('Left before answering'),
  wrong_number: isReason('Wrong number'),
  // Group boxes for the call status bar.
  no_conversation: (r) => r.call_status === 'No reply' || r.call_status === 'System issue',
  not_planned: (r) => PLANNED_OUT.has(r.call_status),
  goal_yes: (r) => r.goal_reached === 'Yes',
  goal_no: (r) => r.goal_reached === 'No',
  goal_na: (r) => r.goal_reached === 'N/A' && r.call_status !== 'Internal test call',
};

/** With "Include test calls" on, a test row counts as the status it would otherwise have. */
const asBusiness = (r) => (r.call_status === 'Internal test call' && r.test_status ? { ...r, call_status: r.test_status, goal_reached: r.test_goal ?? r.goal_reached, is_test: true } : r);

/** Rows in the period and agents asked for. Rows with no call date (bad data) count by their upload date. */
export function scopeRows(rows, { from, to, agents = [], includeTests = false, campaign = '' } = {}) {
  const lo = from ? Date.parse(from) : -Infinity; const hi = to ? Date.parse(to) : Infinity;
  return rows.filter((r) => { const t = Date.parse(r.call_date || r.uploaded_at || ''); return (!Number.isFinite(t) || (t >= lo && t <= hi)) && (!agents.length || agents.includes(r.agent_key || r.agent)) && (!campaign || r.campaign_id === campaign); })
    .map((r) => (includeTests ? asBusiness(r) : r));
}

const pct = (a, b) => (b ? a / b : null);
const line = (rows, key, label, extra = {}) => ({ key, label, count: rows.filter(BOX[key]).length, ...extra });

/** The whole report for already scoped rows (scopeRows). Rates are unrounded; the page rounds them. */
export function buildReport(rows, { workspace = '', from = null, to = null, timeZone = 'Asia/Kolkata', includeTests = false, agentsAll = [] } = {}) {
  const n = (k) => rows.filter(BOX[k]).length;
  const planned = rows.filter(BOX.planned); const answered = rows.filter(BOX.answered);
  const talk = answered.reduce((s, r) => s + (Number(r.duration_seconds) || 0), 0);
  const uploaded = rows.length; const pl = planned.length; const pu = n('picked_up'); const an = answered.length; const su = n('success');
  const box = (key, step, label, total, lines) => ({ key, step, label, total, lines: lines.map((l) => ({ ...l, share: pct(l.count, l.of ?? total) })) });
  const notPicked = n('not_picked_up'); const notSucc = n('not_successful'); const open = n('in_progress'); const settled = pl - open;
  const funnel = [
    box('uploaded', 1, 'Uploaded', uploaded, [line(rows, 'planned', 'Planned to call', { strong: true }), line(rows, 'bad_data', 'Bad data'), line(rows, 'test', 'Internal test calls'),
      ...(n('stopped') ? [line(rows, 'stopped', 'Stopped before dialling')] : [])]),
    // Picked up and Not picked up are shares of finished rows; Not finished is a share of all planned rows.
    box('planned', 2, 'Planned to call', pl, [line(rows, 'picked_up', 'Picked up', { strong: true, of: settled }), line(rows, 'not_picked_up', 'Not picked up', { strong: true, of: settled }),
      line(rows, 'no_answer', 'No answer', { sub: true, of: notPicked }), line(rows, 'dnd', 'DND / blocked', { sub: true, of: notPicked }), line(rows, 'voicemail', 'Voicemail', { sub: true, of: notPicked }),
      ...(open ? [line(rows, 'in_progress', 'Not finished', { strong: true })] : [])]),
    box('picked_up', 3, 'Picked up', pu, [line(rows, 'answered', 'Answered', { strong: true }), line(rows, 'silent', 'Silent'), line(rows, 'system_issue', 'System issue')]),
    box('answered', 4, 'Answered', an, [line(rows, 'success', 'Success', { strong: true, good: true }),
      line(rows, 'accepted', 'Accepted', { sub: true, of: su }), line(rows, 'partial', 'Partial', { sub: true, of: su }), line(rows, 'follow_up', 'Follow-up required', { sub: true, of: su }), line(rows, 'callback', 'Callback requested', { sub: true, of: su }),
      line(rows, 'not_successful', 'Not successful', { strong: true }),
      line(rows, 'not_given_time', 'Agent not given time to speak', { sub: true, of: notSucc }), line(rows, 'left', 'Left before answering', { sub: true, of: notSucc }), line(rows, 'wrong_number', 'Wrong number', { sub: true, of: notSucc })]),
  ];
  const byAgent = [...new Set(planned.map((r) => r.agent))].sort().map((agent) => {
    const mine = rows.filter((r) => r.agent === agent); const a = mine.filter(BOX.answered); const s = mine.filter(BOX.success).length;
    const t = a.reduce((x, r) => x + (Number(r.duration_seconds) || 0), 0);
    return { agent, agent_key: mine[0]?.agent_key || agent, planned: mine.filter(BOX.planned).length, picked_up: mine.filter(BOX.picked_up).length, not_finished: mine.filter(BOX.in_progress).length, answered: a.length, success: s, success_rate: pct(s, a.length), avg_talk_seconds: a.length ? t / a.length : null };
  });
  // Every box must equal the sum of the boxes under it (logic doc section 3); a gap is shown, never hidden.
  const checks = [
    ['Uploaded', uploaded, pl + n('bad_data') + n('test') + n('stopped')],
    ['Planned to call', pl, pu + notPicked + open],
    ['Not picked up', notPicked, n('no_answer') + n('dnd') + n('voicemail')],
    ['Picked up', pu, an + n('silent') + n('system_issue')],
    ['Answered', an, su + notSucc],
    ['Success', su, n('accepted') + n('partial') + n('follow_up') + n('callback')],
    ['Not successful', notSucc, n('not_given_time') + n('left') + n('wrong_number')],
  ];
  const gaps = checks.filter(([, a, b]) => a !== b).map(([box, expected, got]) => ({ box, expected, got }));
  return {
    generated_at: new Date().toISOString(), time_zone: timeZone, definitions_version: DEFINITIONS_VERSION, workspace, from, to, tests_included: includeTests,
    headline: { uploaded, campaigns: new Set(rows.map((r) => r.campaign_id || r.campaign)).size, planned: pl, picked_up: pu, answered: an, success: su,
      planned_share: pct(pl, uploaded), picked_up_share: pct(pu, settled), finished: settled, not_finished: open, answered_share: pct(an, pu), success_rate: pct(su, an) },
    stats: { dials: planned.reduce((s, r) => s + 1 + (Number(r.retries) || 0), 0), avg_talk_seconds: an ? talk / an : 0, total_talk_seconds: talk, in_progress: open },
    funnel, by_agent: byAgent,
    success_field: { yes: n('goal_yes'), no: n('goal_no'), na: n('goal_na') },
    sum_check: { ok: !gaps.length, gaps },
    agents: agentsAll,
    trend: trendOf(rows, { from, to, timeZone }),
  };
}

// ── Trend and the previous period ─────────────────────────────────────────────
const ymdIn = (ms, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const mondayOf = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); const wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; return addDays(ymd, -wd); };
const isoWeek = (monday) => { const [y, m, d] = addDays(monday, 3).split('-').map(Number); const t = Date.UTC(y, m - 1, d); return Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7); };
const shortDay = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }); };

/**
 * Logic doc section 7: the same formulas per ISO week (Monday to Sunday) in the workspace time zone, or per day when the
 * period is two weeks or less. Planned rows only, by call date. A week cut by the period is marked partial.
 */
export function trendOf(rows, { from = null, to = null, timeZone = 'Asia/Kolkata' } = {}) {
  const dated = rows.filter((r) => BOX.planned(r) && r.call_date);
  if (!dated.length) return { unit: 'day', buckets: [] };
  const times = dated.map((r) => Date.parse(r.call_date));
  const first = ymdIn(from ? Date.parse(from) : Math.min(...times), timeZone); const last = ymdIn(to ? Date.parse(to) : Math.max(...times), timeZone);
  const days = Math.round((Date.parse(last) - Date.parse(first)) / 86400000) + 1; const unit = days > 14 ? 'week' : 'day';
  const keyOf = (ymd) => (unit === 'week' ? mondayOf(ymd) : ymd);
  const buckets = new Map();
  for (let k = keyOf(first); k <= last; k = addDays(k, unit === 'week' ? 7 : 1)) {
    const end = unit === 'week' ? addDays(k, 6) : k;
    buckets.set(k, { key: k, label: unit === 'week' ? `W${isoWeek(k)} · ${shortDay(k)}–${shortDay(end)}` : shortDay(k), partial: unit === 'week' && (k < first || end > last), rows: [] });
  }
  for (const r of dated) buckets.get(keyOf(ymdIn(Date.parse(r.call_date), timeZone)))?.rows.push(r);
  return { unit, buckets: [...buckets.values()].map(({ rows: b, ...x }) => {
    const n = (k) => b.filter(BOX[k]).length; const pl = b.length, fin = b.filter(BOX.finished).length, pu = n('picked_up'), an = n('answered'), su = n('success');
    return { ...x, planned: pl, picked_up: pu, answered: an, success: su, picked_up_share: pct(pu, fin), answered_share: pct(an, pu), success_rate: pct(su, an) };
  }) };
}

/** The period just before [from, to], the same length. */
export function previousRange(from, to) {
  const a = Date.parse(from), b = Date.parse(to); return { from: new Date(a - (b - a) - 1).toISOString(), to: new Date(a - 1).toISOString() };
}

/** The report for a scope, plus the headline of the period before it for the change shown on each rate. */
export function callingReport(allRows, scope, opts = {}) {
  const to = scope.to || new Date().toISOString(); const unit = scope.unit || '';
  // Count by a per-agent stat (POs, items): each row counts as many times as its upload says; talk time and dials stay per call.
  const weigh = (rs) => (unit ? rs.flatMap((r) => { const w = Math.max(0, Math.round(metricValue(r, unit))); return w ? Array(w).fill(r) : []; }) : rs);
  const callsRows = scopeRows(allRows, { ...scope, to });
  const rep = buildReport(weigh(callsRows), { ...opts, from: scope.from, to, includeTests: scope.includeTests });
  if (unit) { const plain = buildReport(callsRows, { ...opts, from: scope.from, to, includeTests: scope.includeTests }); rep.stats = plain.stats; }
  rep.unit = unit; rep.units_available = opts.unitsAvailable || [];
  if (scope.from) {
    const p = previousRange(scope.from, to); const h = buildReport(weigh(scopeRows(allRows, { ...scope, ...p })), { ...opts, ...p, includeTests: scope.includeTests }).headline;
    rep.previous = { ...p, planned: h.planned, picked_up: h.picked_up, answered: h.answered, success: h.success, picked_up_share: h.picked_up_share, answered_share: h.answered_share, success_rate: h.success_rate };
  }
  return rep;
}

/** Rows behind one box, newest call first, for the drill-down lists. */
export function rowsInBox(rows, key) {
  const pick = BOX[key] || BOX.uploaded;
  return rows.filter(pick).sort((a, b) => Date.parse(b.call_date || b.uploaded_at || 0) - Date.parse(a.call_date || a.uploaded_at || 0));
}

/** The export: the 14 columns, Duration as m:ss, dates in the workspace time zone. */
export function exportTable(rows, timeZone = 'Asia/Kolkata', extra = []) {
  const when = (v) => (v ? new Date(v).toLocaleString('en-GB', { timeZone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '');
  const mmss = (s) => (s == null || s === '' ? '' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
  return [[...COLUMNS.map(([, l]) => l), ...extra.map(([, l]) => l)],
    ...rows.map((r) => [...COLUMNS.map(([k]) => (k === 'call_date' ? when(r.call_date) : k === 'duration_seconds' ? mmss(r.duration_seconds) : r[k] ?? '')), ...extra.map(([k]) => cellText(r, k, timeZone))])];
}

/** Mock stand-in for the review step: what the caller's answers say about the goal. Decided from the saved answers. */
export function resultFromAnswers(outputs, seed = '') {
  const o = outputs || {}; const vals = Object.entries(o).filter(([, v]) => v !== '' && v != null);
  if (!vals.length) return 'left';
  if (o.callback_time || o.callback_date) return 'callback';
  const text = vals.map(([k, v]) => `${k}=${v}`).join(' ').toLowerCase();
  if (/wrong number|wrong_number/.test(text)) return 'wrong_number';
  const yes = /accept|submitted|confirmed|committed|will_accept|eta available/.test(text) || vals.some(([k, v]) => v === true && /accept|submit|commit|aligned/.test(k));
  // About one accepted call in twelve has a saved detail the caller never said (an agent fault): Partial.
  const fault = [...String(seed)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 12 === 0;
  if (yes) return fault ? 'partial' : 'accepted';
  return 'follow_up';
}

/**
 * The agent filter's choices: agents with planned calls in the period (ignoring the agent filter itself), each with
 * that count, by display name. Agents already picked stay listed, so they can be taken off.
 */
export function agentChoices(allRows, scope = {}) {
  const rows = scopeRows(allRows, { ...scope, agents: [] }).filter(BOX.planned);
  const human = (s) => (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(s) ? s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : s);
  const m = new Map();
  for (const r of rows) { const k = r.agent_key || r.agent; const x = m.get(k) || { key: k, label: human(r.agent || k), count: 0 }; x.count += 1; m.set(k, x); }
  for (const k of scope.agents || []) if (!m.has(k)) { const r = allRows.find((x) => (x.agent_key || x.agent) === k); m.set(k, { key: k, label: human(r?.agent || k), count: 0 }); }
  return [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Phone numbers as stored for test matching: the last 10 digits. */
export const normalisePhone = (p) => String(p || '').replace(/\D/g, '').slice(-10);

// ── One call page (phase 2) ───────────────────────────────────────────────────
/** The outcomes a person can pick for an answered call (PRD Flow B). */
export const ANSWERED_REASONS = ['Success: Accepted', 'Success: Partial', 'Success: Follow-up required', 'Success: Callback requested', 'Agent not given time to speak', 'Left before answering', 'Wrong number'];

/** A person's change always wins over the review, and is kept with who, when and why. */
export function personOutcome(decided, o) {
  if (!o) return { ...decided, outcome_source: 'review' };
  return { ...decided, call_status: 'Answered', status_reason: o.status_reason, goal_reached: o.status_reason.startsWith('Success') ? 'Yes' : 'No',
    outcome_source: 'person', changed_by: o.by || '', changed_at: o.at || null, change_note: o.note || '', review_status_reason: decided.status_reason };
}

/** Checks a requested change: only answered calls get an outcome, and only from the list. */
export function checkOutcomeChange(row, body) {
  if ((row.test_status || row.call_status) !== 'Answered') return 'Only answered calls have an outcome to change.';
  if (!ANSWERED_REASONS.includes(body?.status_reason)) return 'Pick an outcome from the list.';
  return null;
}

/** The calls before and after this one in its campaign, for Previous and Next on the call page. */
export function neighbours(rows, row) {
  const same = rows.filter((r) => r.campaign_id === row.campaign_id); const i = same.findIndex((r) => r.id === row.id);
  return { prev_id: i > 0 ? same[i - 1].id : null, next_id: i >= 0 && i < same.length - 1 ? same[i + 1].id : null, position: i + 1, of: same.length };
}

// ── Call log search and column filters ───────────────────────────────────────
/** What a cell reads as on screen and in the export, so "2 Nov" or "1:05" finds what people see. */
function cellText(r, k, timeZone = 'Asia/Kolkata') {
  if (k.startsWith('in:')) return String(r.inputs?.[k.slice(3)] ?? '');
  if (k.startsWith('out:')) return String(r.answers?.[k.slice(4)] ?? '');
  const v = r[k];
  if (k === 'call_date') return v ? new Date(v).toLocaleString('en-GB', { timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  if (k === 'duration_seconds') return v == null ? '' : `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, '0')}`;
  return String(v ?? '');
}
/** Search across every column, and "contains" per column (case does not matter). The export uses the same filters. */
/** A number to compare: duration in seconds, else the cell as a number (NaN when it is not one). */
function numOf(r, k) {
  if (k === 'duration_seconds') return r[k] == null ? NaN : Number(r[k]);
  const t = cellText(r, k).replace(/,/g, '').trim(); return t === '' ? NaN : Number(t);
}
/** One column condition { op, a, b }. Numbers: gt, lt, eq, between. Dates (yyyy-mm-dd, IST): on, after, before, range. Text: contains, not, is, starts. Any: blank, notblank. */
export function matchCondition(r, k, { op, a, b } = {}) {
  if (op === 'blank') return !cellText(r, k).trim();
  if (op === 'notblank') return !!cellText(r, k).trim();
  if (['gt', 'lt', 'eq', 'between'].includes(op)) {
    const n = numOf(r, k); const x = Number(a), y = Number(b); if (Number.isNaN(n)) return false;
    return op === 'gt' ? n > x : op === 'lt' ? n < x : op === 'eq' ? n === x : n >= Math.min(x, y) && n <= Math.max(x, y);
  }
  if (['on', 'after', 'before', 'range'].includes(op)) {
    if (!r[k]) return false; const day = new Date(r[k]).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const lo = a < b ? a : b, hi = a < b ? b : a;
    return op === 'on' ? day === a : op === 'after' ? day >= a : op === 'before' ? day <= a : day >= lo && day <= hi;
  }
  const t = cellText(r, k).toLowerCase(), s = String(a ?? '').trim().toLowerCase();
  return op === 'not' ? !t.includes(s) : op === 'is' ? t === s : op === 'starts' ? t.startsWith(s) : t.includes(s);
}
const isCond = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
export function filterRows(rows, { q = '', cols = {} } = {}) {
  const term = String(q || '').trim().toLowerCase(); const want = Object.entries(cols || {}).filter(([, v]) => (Array.isArray(v) ? v.length : isCond(v) ? !!v.op : String(v ?? '').trim()));
  if (!term && !want.length) return rows;
  const hit = (r) => COLUMNS.some(([k]) => cellText(r, k).toLowerCase().includes(term))
    || [...Object.values(r.inputs || {}), ...Object.values(r.answers || {})].some((v) => String(v ?? '').toLowerCase().includes(term));
  return rows.filter((r) => (!term || hit(r))
    && want.every(([k, v]) => (Array.isArray(v) ? v.includes(cellText(r, k)) : isCond(v) ? matchCondition(r, k, v) : cellText(r, k).toLowerCase().includes(String(v).trim().toLowerCase()))));
}
/** Reads ?q= and ?filters= (JSON of column: text) from a request. */
export function logFilters(q) { let cols = {}; try { cols = JSON.parse(q.get('filters') || '{}'); } catch { /* ignore bad filters */ } return { q: q.get('q') || '', cols }; }

// ── Shared screens (phase 3): campaigns list, follow ups ──────────────────────
/** One line per campaign, from its rows: the same funnel counts as the dashboard, and a status. */
export function campaignSummaries(rows) {
  const by = new Map();
  for (const r of rows) { if (!r.campaign_id || r.campaign_id === 'console') continue; (by.get(r.campaign_id) || by.set(r.campaign_id, []).get(r.campaign_id)).push(r); }
  dncScan(rows);
  checkAlerts(new Map([...by.entries()].map(([id, mine]) => [id, { name: mine[0].campaign, rows: mine, running: mine.some(BOX.in_progress) }])));
  return [...by.entries()].map(([id, mine]) => {
    const n = (k) => mine.filter(BOX[k]).length; const an = n('answered'), su = n('success'), open = n('in_progress'), stopped = n('stopped');
    const first = mine.reduce((m, r) => (!m || (r.uploaded_at && r.uploaded_at < m) ? r.uploaded_at : m), null);
    const hold = open ? pausedOf(id) : null;
    const status = hold ? 'Paused' : open ? 'Running' : n('planned') === 0 ? 'Failed' : stopped ? 'Stopped' : 'Completed';
    return { campaign_id: id, campaign: mine[0].campaign, agent: mine[0].agent, agent_key: mine[0].agent_key, uploaded_by: mine[0].uploaded_by || '', created_at: first,
      uploaded: mine.length, planned: n('planned'), picked_up: n('picked_up'), answered: an, success: su, success_rate: pct(su, an), not_finished: open, bad_data: n('bad_data'), status, paused: hold };
  }).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}
/** "po_numbers" -> "PO numbers": a sheet or answer key as a column header. */
export function columnLabel(key) {
  const s = String(key).replace(/[_-]+/g, ' ').trim().replace(/\b(po|id|sku|gst|eta|rfx|rfq|uom|qty)\b/gi, (w) => w.toUpperCase());
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** The columns one campaign carries: its sheet's (in:) and the agent's answers (out:), in first-seen order. */
export function campaignColumns(rows) {
  const ins = new Set(), outs = new Set();
  // The sheet's own contact columns repeat Caller and Phone, so they are left out.
  const contact = /^(contact[ _]?)?(name|phone|mobile|email|number)$/i;
  for (const r of rows) { Object.keys(r.inputs || {}).filter((k) => !contact.test(k)).forEach((k) => ins.add(k)); Object.keys(r.answers || {}).forEach((k) => outs.add(k)); }
  return { inputs: [...ins].map((k) => ({ key: `in:${k}`, label: columnLabel(k) })), answers: [...outs].map((k) => ({ key: `out:${k}`, label: columnLabel(k) })) };
}
/** Flat text values of an object (the upload's context or the agent's answers), for the inputs/answers of a row. */
export function flatValues(o) {
  return Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== '' && v != null && typeof v !== 'object').map(([k, v]) => [k, typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)]));
}

/** Campaigns created in the period, by state (all, running, finished) and search (file, agent or uploader). */
export function filterCampaigns(list, { from = null, to = null, state = 'all', q = '' } = {}) {
  const lo = from ? Date.parse(from) : -Infinity, hi = to ? Date.parse(to) : Infinity; const term = String(q).trim().toLowerCase();
  return list.filter((c) => { const t = Date.parse(c.created_at || ''); return (!Number.isFinite(t) || (t >= lo && t <= hi))
    && (state === 'all' || (state === 'running' ? ['Running', 'Paused'].includes(c.status) : !['Running', 'Paused'].includes(c.status)))
    && (!term || [c.campaign, c.agent, c.uploaded_by].some((v) => String(v || '').toLowerCase().includes(term))); });
}

/** Follow-up work a person does in the mock: done, reopened, or sent back for a call. Kept by row id. */
export const followState = new Map();
const FOLLOW_TABS = { callback: 'callback', follow_up: 'follow_up' };
/** Callbacks requested, or answers the team must act on, with each row's follow-up state. */
export function followUpRows(rows, tab = 'callback', show = 'open') {
  const list = rowsInBox(rows, FOLLOW_TABS[tab] || 'callback').map((r) => ({ ...r, follow: followState.get(r.id) || { state: 'open' } }));
  return { rows: list.filter((r) => (show === 'all' ? true : show === 'done' ? r.follow.state === 'done' : r.follow.state !== 'done')),
    counts: { callback: rowsInBox(rows, 'callback').filter((r) => (followState.get(r.id)?.state || 'open') !== 'done').length, follow_up: rowsInBox(rows, 'follow_up').filter((r) => (followState.get(r.id)?.state || 'open') !== 'done').length } };
}
export function followUpAction(id, action, by) {
  const at = new Date().toISOString();
  const next = action === 'done' ? { state: 'done', by, at } : action === 'call_again' ? { state: 'queued', by, at } : { state: 'open', by, at };
  followState.set(id, next); return next;
}

// ── Custom stats per agent (POs, items, …) ────────────────────────────────────
/** Readable names for the usual count columns; anything else reads as its column name. */
const UNIT_LABELS = { po_count: 'POs', item_count: 'Items', po_value: 'PO value', rfx_count: 'RFQs', line_count: 'Lines' };
export const unitLabel = (field) => UNIT_LABELS[field] || field.replace(/_count$/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
// ── Agent metrics: what an agent's campaigns can be counted in, beside calls ──
/** How a metric counts its column on each row: add up the numbers, count the list entries, or count rows that have a value. */
export const METRIC_HOWS = [
  { key: 'sum', label: 'Add up the numbers', example: '"1, 2" counts 3' },
  { key: 'entries', label: 'Count the entries', example: '"2044120, 2044121" counts 2' },
  { key: 'rows', label: 'Count rows that have it', example: 'any value counts 1' },
];
const SPLIT = /\s*[,;\n]\s*/;
/** A metric's key, as the report asks for it: "sum:item_count". */
export const metricKey = (m) => `${m.how}:${m.field}`;
/** One row's value for a metric key, from the row's sheet values (inputs). An old plain field name means "sum". */
export function metricValue(r, key) {
  const [how, field] = String(key).includes(':') ? String(key).split(':') : ['sum', String(key)];
  const v = String(r.inputs?.[field] ?? r.units?.[field] ?? '').trim(); if (!v) return 0;
  const parts = v.split(SPLIT).filter(Boolean);
  if (how === 'entries') return parts.length;
  if (how === 'rows') return 1;
  return parts.reduce((n, p) => n + (Number(p.replace(/[^\d.-]/g, '')) || 0), 0);
}
/** How a column looks in an agent's sheet, to suggest how to count it. */
function suggestHow(field, type) {
  if (type === 'number' || /count|qty|quantity|value|amount|total/i.test(field)) return 'sum';
  if (/numbers|_nos?$|ids$|list|details|items/i.test(field)) return 'entries';
  return 'rows';
}
/** agent key -> [{ field, how, label }] the workspace set; absent means one "sum" metric per number column. */
export const agentStats = new Map();
/** agents: [{ key, label, numberFields, columns: [{ field, type }] }] -> each agent's columns and metrics. */
export function statsByAgent(agents) {
  return agents.map((a) => {
    const columns = (a.columns || a.numberFields.map((f) => ({ field: f, type: 'number' }))).map((c) => ({ field: c.field, label: c.field.replace(/_/g, ' '), suggest: suggestHow(c.field, c.type) }));
    const stats = (agentStats.get(a.key) || a.numberFields.map((f) => ({ field: f, how: 'sum', label: unitLabel(f) }))).map((m) => ({ ...m, key: metricKey(m) }));
    return { agent: a.key, label: a.label, columns, hows: METRIC_HOWS, fields: columns.map((c) => ({ field: c.field, label: c.label })), stats };
  });
}
/** Saves an agent's metrics: only its own columns and known ways of counting; names kept short. */
export function setAgentMetrics(agent, list) {
  const cols = new Set((agent.columns || []).map((c) => c.field).concat(agent.numberFields || []));
  const clean = (Array.isArray(list) ? list : []).filter((m) => cols.has(m.field) && METRIC_HOWS.some((h) => h.key === (m.how || 'sum')))
    .map((m) => ({ field: m.field, how: m.how || 'sum', label: String(m.label || unitLabel(m.field)).trim().slice(0, 30) || unitLabel(m.field) }));
  agentStats.set(agent.key, [...new Map(clean.map((m) => [metricKey(m), m])).values()].slice(0, 20));
}
/** The metrics offered in "Count in" for the agents in rows (a campaign has one agent). */
export function unitsFor(rows, agents) {
  const keys = new Set(rows.map((r) => r.agent_key)); const out = new Map();
  for (const a of statsByAgent(agents.filter((x) => keys.has(x.key)))) for (const st of a.stats) if (!out.has(st.key)) out.set(st.key, { field: st.key, label: st.label, how: st.how, column: st.field });
  return [...out.values()];
}
/** A campaign's metrics: total, answered (covered) and accepted, per metric of its agent. */
export function campaignStats(rows, stats) {
  return stats.map((st) => {
    const sum = (rs) => rs.reduce((n, r) => n + metricValue(r, st.key || metricKey(st)), 0);
    return { field: st.field, label: st.label, total: sum(rows.filter(BOX.planned)), covered: sum(rows.filter(BOX.answered)), accepted: sum(rows.filter(BOX.accepted)) };
  });
}

/** Distinct values of one column (with the other filters on), for the multi-select column filter. */
export function columnValues(rows, column, search = '') {
  const term = String(search || '').trim().toLowerCase();
  const m = new Map(); for (const r of rows) { const v = cellText(r, column); if (!term || v.toLowerCase().includes(term)) m.set(v, (m.get(v) || 0) + 1); }
  return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).slice(0, 200);
}

// ── Follow ups as a checklist ─────────────────────────────────────────────────
/** What the owner has to do, in one line, from the outcome and what the caller said. */
export function followTask(r) {
  const s = `${r.summary || ''} ${r.status_reason || ''}`.toLowerCase();
  if (r.status_reason === 'Success: Callback requested') return r.callback_at ? `Call back on ${r.callback_at}` : 'Call back: agree a day and time';
  if (/reject|price|rate|revised/.test(s)) return 'Talk to the buyer: PO rejected or price issue';
  if (/cannot supply|unavailab|not able to supply/.test(s)) return 'Find another supplier: cannot supply';
  if (/mail|email|copy|whatsapp|po number|details/.test(s)) return 'Send the PO details, then confirm acceptance';
  if (/portal|check|update/.test(s)) return 'Confirm acceptance after the supplier checks the portal';
  if (/contact|left the company|person/.test(s)) return 'Get the right contact and call again';
  // Order tracking answers: say what to chase, with the date the supplier gave.
  const promised = /promised date:?\s*([\d-]+)/.exec(s)?.[1];
  if (/delayed|late|hold/.test(s)) return promised ? `Chase the delayed line: promised ${promised}` : 'Chase the delayed line';
  if (/dispatched|shipped/.test(s)) return 'Confirm the dispatch reached the plant';
  if (/will_accept|will accept|eta/.test(s)) return 'Confirm the PO is accepted on the portal';
  if (/haan|caller said/.test(s)) return 'Listen to the call and decide the next step';
  return 'Read the answer and decide the next step';
}
/** Every open (or done) follow-up: callbacks and answers to act on, with task, owner (who uploaded the sheet) and caller. */
export function followChecklist(rows, show = 'open', kind = 'all') {
  const pick = (k) => rowsInBox(rows, k).map((r) => ({ ...r, kind: k === 'callback' ? 'Callback' : 'Follow-up', task: followTask(r), owner: r.uploaded_by || '—', follow: followState.get(r.id) || { state: 'open' } }));
  const all = [...pick('callback'), ...pick('follow_up')].sort((a, b) => String(b.call_date).localeCompare(String(a.call_date)));
  const open = all.filter((r) => r.follow.state !== 'done');
  const list = all.filter((r) => (kind === 'all' || r.kind === (kind === 'callback' ? 'Callback' : 'Follow-up')) && (show === 'all' || (show === 'done' ? r.follow.state === 'done' : r.follow.state !== 'done')));
  return { rows: list, counts: { open: open.length, callback: open.filter((r) => r.kind === 'Callback').length, follow_up: open.filter((r) => r.kind === 'Follow-up').length, done: all.length - open.length } };
}
export const FOLLOW_COLUMNS = [['caller_name', 'Caller'], ['phone', 'Phone'], ['email', 'Email'], ['kind', 'Type'], ['task', 'Action task'], ['summary', 'Summary'], ['owner', 'Owner'], ['agent', 'Agent'], ['campaign', 'Campaign'], ['callback_at', 'Call back'], ['call_date', 'Last call']];

/** The dashboard's small box: what needs a person, what the agent will call again, and the work still running. */
export function tasksSummary(rows) {
  const a = actionNeeded(rows); const camps = campaignSummaries(rows);
  return { follow_ups: a.counts.you, queued: a.counts.agent, callbacks: a.counts.by_group.you.callback || 0, follow_up_required: a.counts.by_group.you.follow_up || 0,
    running_campaigns: camps.filter((c) => ['Running', 'Paused'].includes(c.status)).length, not_finished: rows.filter(BOX.in_progress).length };
}

// ── Action needed: one list of what a person must do, beside what the agent will call again ──
// Lanes: "you" (manual), "agent" (queued for the agent: retries, callbacks, first calls), "done".
// Groups: fix_data (not planned: bad data), not_reached (no answer / voicemail / silent / DND / system, retries used up),
// not_successful (answered but not successful: wrong number, hung up early on every try), follow_up (follow-up required, partial),
// callback (callback asked: queued with the agent, or needs a person when no time was given or it was missed).
export const ACTION_GROUPS = [
  { key: 'fix_data', label: 'Fix the data', hint: 'Not planned: the row could not be called' },
  { key: 'not_reached', label: 'Not reached', hint: 'No answer, voicemail, silent or blocked after every try' },
  { key: 'not_successful', label: 'Not successful', hint: 'Answered, but the call could not do its job' },
  { key: 'follow_up', label: 'Follow-up required', hint: 'The supplier answered; a person acts on it' },
  { key: 'callback', label: 'Callback', hint: 'The supplier asked to be called back' },
  { key: 'first_call', label: 'First call', hint: 'Not called yet in a running campaign' },
];
const DAY_MS = 864e5;
const fmtAt = (ms) => new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
/** One row of the list, before a person's own changes. */
function actionOf(r) {
  const st = callSteps(r); const now = Date.now(); const tries = Number(r.retries) || 0;
  const plan = (st.retry?.plan || []).map((x) => Date.parse(x)).filter(Boolean);
  // The next attempt still ahead; a planned time already gone means the agent calls at its next free slot.
  const next = plan.length ? (plan.find((t) => t > now) || now) : null; const triesTotal = tries + 1 + plan.length;
  const nextText = (t) => (t <= now + 60000 ? 'at its next free slot' : fmtAt(t));
  const base = { id: r.id, caller: r.caller_name || r.phone, phone: r.phone, email: r.email || '', campaign: r.campaign, agent: r.agent, owner: r.uploaded_by || '—', last_call: r.call_date || null,
    status: r.call_status, reason: r.status_reason || r.call_status, summary: r.summary || '', tries: `${tries + 1} of ${triesTotal}`, next_at: null, row: r };
  if (st.dnc) return null; // On the do-not-call list: nothing more to do.
  const s = r.call_status, why = r.status_reason || '';
  if (s === 'Bad data') return { ...base, lane: 'you', group: 'fix_data', task: `Fix the row: ${why || 'it failed the upload check'}`, action: 'fix', tries: '0', why: 'Not planned: the agent cannot call this row' };
  if (BOX.in_progress(r)) return { ...base, lane: 'agent', group: 'first_call', task: 'Waiting for its first call', action: 'none', why: 'In a running campaign', next_at: null };
  if (why === 'Success: Accepted' || s === 'Internal test call' || s === 'Stopped') return null;
  if (why === 'Success: Callback requested') {
    const at = Date.parse(r.callback_at || '') || null;
    if (at && at > now - DAY_MS) return { ...base, lane: 'agent', group: 'callback', task: at > now ? `Agent calls back ${fmtAt(st.retry?.plan?.[0] ? Date.parse(st.retry.plan[0]) : at)}, as asked` : 'Agent calls back at the next free slot: the agreed time is due', action: 'none', why: 'Callback asked', next_at: new Date(Math.max(at, now)).toISOString() };
    return { ...base, lane: 'you', group: 'callback', task: at ? `Missed callback: they asked for ${fmtAt(at)}. Call them or book a new time` : 'They asked for a callback but gave no time: agree one', action: 'requeue', why: 'Callback asked' };
  }
  if (why === 'Success: Follow-up required') return { ...base, lane: 'you', group: 'follow_up', task: followTask(r), action: 'done', why: 'Follow-up required' };
  if (why === 'Success: Partial') {
    if (next) return { ...base, lane: 'agent', group: 'follow_up', task: `Agent calls again ${nextText(next)} for the rest of the POs`, action: 'none', why: 'Partial answer', next_at: new Date(next).toISOString() };
    return { ...base, lane: 'you', group: 'follow_up', task: 'Get the remaining POs confirmed', action: 'done', why: 'Partial answer' };
  }
  if (why === 'Wrong number') return { ...base, lane: 'you', group: 'not_successful', task: `Find the right number for ${base.caller}`, action: 'fix', why: 'Wrong number' };
  const early = s === 'Answered' && /not given time|left before/i.test(why);
  if (s === 'Answered' && !early) return { ...base, lane: 'you', group: 'not_successful', task: 'Listen to the call and decide the next step', action: 'done', why };
  // Not picked up, or hung up early: the agent retries while tries are left; after that a person takes over.
  const group = early ? 'not_successful' : 'not_reached';
  if (next) return { ...base, lane: 'agent', group, task: `Agent tries again ${nextText(next)} (try ${tries + 2} of ${triesTotal})`, action: 'none', why, next_at: new Date(next).toISOString() };
  const how = s === 'DND' ? 'The number blocks unknown callers: send the WhatsApp with our contact card, or call from your phone'
    : early ? 'Hung up early on every try: call from your phone or send the PO details on WhatsApp'
    : `Not reached after ${tries + 1} call${tries ? 's' : ''}: try WhatsApp or email, call from your phone, or ask the buyer for another number`;
  return { ...base, lane: 'you', group, task: how, action: 'requeue', why };
}
/** The list for one lane, with counts, filtered by group, owner and text. */
export function actionNeeded(rows, { lane = 'you', group = 'all', owner = 'all', q = '' } = {}) {
  dncScan(rows); // numbers on the do-not-call list drop out of both lists
  const now = Date.now(); const all = [];
  for (const r of rows) {
    const a = actionOf(r); if (!a) continue; const f = followState.get(r.id);
    if (f?.state === 'done') { all.push({ ...a, lane: 'done', done_by: f.by, done_at: f.at, task: a.task }); continue; }
    if (f?.state === 'mine' && a.lane === 'agent') { all.push({ ...a, lane: 'you', task: 'You took this over from the agent: reach them yourself, then mark it done', action: 'requeue', taken_by: f.by }); continue; }
    if (f?.state === 'queued' && a.lane === 'you') { all.push({ ...a, lane: 'agent', task: `Sent back to the agent by ${f.by}${f.fix ? ` with ${f.fix}` : ''}: calls ${fmtAt(Date.parse(f.next_at))}`, next_at: f.next_at, action: 'none' }); continue; }
    all.push(a);
  }
  const counts = { you: 0, agent: 0, done: 0, by_group: { you: {}, agent: {}, done: {} } };
  for (const a of all) { counts[a.lane]++; counts.by_group[a.lane][a.group] = (counts.by_group[a.lane][a.group] || 0) + 1; }
  const t = String(q).trim().toLowerCase();
  const list = all.filter((a) => a.lane === lane && (group === 'all' || a.group === group) && (owner === 'all' || a.owner === owner)
    && (!t || [a.caller, a.phone, a.campaign, a.task, a.reason, a.summary].join(' ').toLowerCase().includes(t)));
  const order = Object.fromEntries(ACTION_GROUPS.map((g, i) => [g.key, i]));
  list.sort((a, b) => (lane === 'agent' ? String(a.next_at || '9').localeCompare(String(b.next_at || '9')) : (order[a.group] - order[b.group]) || String(b.last_call).localeCompare(String(a.last_call))));
  return { rows: list.map(({ row, ...a }) => a), counts, groups: ACTION_GROUPS, owners: [...new Set(all.map((a) => a.owner))].filter((o) => o !== '—').sort(), now: new Date(now).toISOString() };
}
/** A person's action on one row: done, reopen, take it from the agent, send it back to the agent (optionally with a fix). */
export function actionAct(id, { action, fix = '' } = {}, by = 'you') {
  const at = new Date().toISOString();
  if (action === 'done') followState.set(id, { state: 'done', by, at });
  else if (action === 'reopen') followState.delete(id);
  else if (action === 'take') followState.set(id, { state: 'mine', by, at });
  else if (action === 'requeue') followState.set(id, { state: 'queued', by, at, fix: String(fix || '').trim().slice(0, 80), next_at: new Date(Date.now() + 30 * 60000).toISOString() });
  else return { error: 'Unknown action' };
  return { ok: true };
}
export const ACTION_COLUMNS = [['lane', 'List'], ['group', 'Type'], ['task', 'What to do'], ['why', 'Why'], ['caller', 'Caller'], ['phone', 'Phone'], ['email', 'Email'], ['campaign', 'Campaign'], ['agent', 'Agent'],
  ['owner', 'Owner'], ['last_call', 'Last call'], ['next_at', 'Next call'], ['tries', 'Tries'], ['summary', 'Call summary']];

// ── Upload check (ideas doc 2.1): fix what can be fixed, warn on doubtful, reject only what cannot be called ──
const LIST_SPLIT = /\s*[,;]\s*/;
const isPoKey = (k) => /(^|_)(po|order)(_?(no|number|numbers|nos|id|ids))?s?$/i.test(k) || /po_?numbers?/i.test(k);
const isDateKey = (k) => /date/i.test(k);
/** A date the sheet could mean: DD/MM/YYYY, DD-MM-YYYY or YYYY-MM-DD, a real day between 2000 and 2100. */
export function validDate(v) {
  const s = String(v).trim(); let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s); let y, mo, d;
  if (m) { d = +m[1]; mo = +m[2]; y = +m[3]; } else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) { y = +m[1]; mo = +m[2]; d = +m[3]; } else return false;
  const t = new Date(Date.UTC(y, mo - 1, d)); return y >= 2000 && y <= 2100 && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
/**
 * One uploaded row. Fixes: "quot;" and HTML entities removed, empty list entries (an extra comma) dropped. Warnings: a PO listed
 * twice (asked once). Repeated counts such as item_count "1, 1" are fine. Error (not dialled): a date that is not a real date.
 * Returns { ctx (fixed), fixes: [{ kind, field, note }], warnings: [...], error: null | { kind, field, note } }.
 */
export function checkUploadRow(ctx) {
  const out = { ...ctx }; const fixes = [], warnings = []; let error = null;
  const nameVal = String(ctx?.contact_name || ctx?.supplier_name || ctx?.name || '').trim();
  const phoneDigits = String(ctx?.contact_phone || ctx?.phone || '').replace(/\D/g, '').slice(-10);
  const is_dummy = /^\[?sample|dummy row|example supplier/i.test(nameVal) || phoneDigits === '9999900000';
  if (is_dummy) {
    return {
      ctx: out,
      fixes: [],
      warnings: [],
      error: null,
      is_dummy: true,
      best_practice: 'Sample dummy row for format reference — no call will be placed. You can remove it before uploading or leave it as-is.',
    };
  }
  for (const [k, raw] of Object.entries(ctx || {})) {
    if (raw == null || typeof raw === 'object') continue;
    let v = String(raw);
    const clean = v.replace(/&(quot|amp|apos|#39);/g, (m) => ({ '&quot;': '"', '&amp;': '&', '&apos;': "'", '&#39;': "'" })[m]).replace(/(^|[^&])quot;/g, '$1').replace(/"/g, '').trim();
    if (clean !== v.trim()) { fixes.push({ kind: 'entities', field: k, note: `Removed stray quote marks in ${k}` }); v = clean; }
    if (LIST_SPLIT.test(v)) {
      const parts = v.split(LIST_SPLIT);
      if (parts.some((p) => p === '')) { fixes.push({ kind: 'empty_entry', field: k, note: `Removed an empty entry (extra comma) in ${k}` }); v = parts.filter((p) => p !== '').join(', '); }
      const list = v.split(LIST_SPLIT);
      if (isPoKey(k)) { const dup = list.filter((p, i) => list.indexOf(p) !== i); if (dup.length) { warnings.push({ kind: 'po_twice', field: k, note: `PO ${[...new Set(dup)].join(', ')} is listed twice in ${k}; it will be asked once` }); v = [...new Set(list)].join(', '); } }
      else if (/count|qty|quantity/i.test(k) && list.some((p, i) => list.indexOf(p) !== i)) fixes.push({ kind: 'repeated_counts', field: k, note: `Repeated counts in ${k} ("${v}") are fine: accepted as they are` });
    }
    if (isDateKey(k) && v !== '' && !error) { const bad = v.split(LIST_SPLIT).find((p) => p && !validDate(p)); if (bad) error = { kind: 'bad_date', field: k, note: `${k} is not a valid date ("${bad}")` }; }
    out[k] = v;
  }
  let best_practice = 'Row passes all format checks.';
  if (error?.kind === 'bad_date') best_practice = `Best practice: Use DD/MM/YYYY with a real calendar date between 2000 and 2100 (e.g. 28/10/2026) in ${error.field}.`;
  else if (warnings.some((w) => w.kind === 'po_twice')) best_practice = 'Best practice: List each PO number once per row; duplicate POs are automatically deduplicated on the call.';
  else if (fixes.some((f) => f.kind === 'empty_entry' || f.kind === 'entities')) best_practice = 'Best practice: Put commas only between values (no trailing comma) and paste plain text (Ctrl+Shift+V).';
  else if (fixes.some((f) => f.kind === 'repeated_counts')) best_practice = 'Best practice: Repeated item counts like "1, 1" across multiple POs are valid and accepted.';
  return { ctx: out, fixes, warnings, error, is_dummy: false, best_practice };
}
/** Builds a sample dummy row for an agent's template columns (never dialled, removable on screen). */
export function buildDummyRow(inputs = []) {
  const sample = {
    contact_name: '[SAMPLE DUMMY ROW — DO NOT CALL]',
    contact_phone: '9999900000',
    contact_email: 'sample.vendor@example.com',
    plant_name: 'Moglix - Hindustan Zinc Account Udaipur',
    po_count: '2',
    po_numbers: '2040001, 2040002',
    item_count: '1, 1',
    item_details: 'BEARING SKF 6205, VALVE PN16 DN20',
    po_date: '28/10/2026',
    target_dispatch_date: '15/11/2026',
    supplier_id: '100001',
  };
  return Object.fromEntries(inputs.map((k) => [k, sample[k] ?? (isDateKey(k) ? '28/10/2026' : /phone|mobile/i.test(k) ? '9999900000' : /count|qty/i.test(k) ? '1' : `Sample ${k}`)]));
}
/** On-screen sheet rows: status, the issue, and what to do. Dummy rows are never dialled. */
export function presentSheet(items) {
  const sheet_rows = (items || []).map((it) => {
    const check = it.check || {};
    const dummy = !!(it.is_dummy || check.is_dummy);
    let status = 'ok';
    let issue = '';
    if (dummy) { status = 'dummy'; issue = 'Sample dummy row — not called. Remove it with one click, or leave it.'; }
    else if (it.bad) { status = 'bad'; issue = String(it.bad); }
    else if (it.test) { status = 'test'; issue = 'Internal test number — counted separately, not dialled as a supplier.'; }
    else if (check.warnings?.length) { status = 'warn'; issue = check.warnings.map((w) => w.note).join('; '); }
    else if (check.fixes?.length) { status = 'fixed'; issue = check.fixes.map((f) => f.note).join('; '); }
    const practice = check.best_practice
      || (status === 'bad' && /phone|number/i.test(issue) ? 'Best practice: use the supplier contact\'s 10-digit mobile, digits only.' : '')
      || (status === 'bad' ? 'Best practice: fix this value, or continue. This row will not be called.' : 'Row passes all format checks.');
    return { row: it.row, is_dummy: dummy, cells: it.cells || {}, status, issue, best_practice: practice };
  });
  return { sheet_rows };
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/**
 * The best-practice note for one agent after a check (demo stand-in for the AI note): what failed or was fixed in this sheet,
 * and the one habit that would avoid it next time. checks: [{ row, fixes, warnings, error }].
 */
export function uploadNote(agentLabel, checks, total) {
  const count = (list, kind) => checks.filter((c) => c[list]?.some?.((x) => x.kind === kind) || c[list]?.kind === kind).length;
  const lines = [];
  const rep = count('fixes', 'repeated_counts'); if (rep) lines.push(`${plural(rep, 'row')} ${rep === 1 ? 'repeats' : 'repeat'} a count (for example item_count "1, 1"). That is correct for several POs with the same count, and they are accepted. The old check rejected these.`);
  const empty = count('fixes', 'empty_entry'); if (empty) lines.push(`${plural(empty, 'row')} had a comma at the end of a list. Fixed for you; next time put commas only between values.`);
  const ent = count('fixes', 'entities'); if (ent) lines.push(`${plural(ent, 'row')} had stray quote marks (quot;) copied from the ERP export. Fixed for you; paste values only (Ctrl+Shift+V) to avoid them.`);
  const twice = count('warnings', 'po_twice'); if (twice) lines.push(`${plural(twice, 'row')} ${twice === 1 ? 'lists' : 'list'} the same PO twice. Each PO is asked once; check the export for duplicate lines.`);
  const dates = count('error', 'bad_date'); if (dates) lines.push(`${plural(dates, 'row')} ${dates === 1 ? 'has' : 'have'} a date that is not a real date, and will not be called. Use DD/MM/YYYY, and check the year.`);
  const regBlocked = checks.filter((c) => c.error?.kind === 'register').length; const regWarned = count('warnings', 'register');
  if (regBlocked) lines.push(`${plural(regBlocked, 'row')} ${regBlocked === 1 ? 'is' : 'are'} on the country's do-not-call register and will not be called (Settings › Calling rules).`);
  if (regWarned) lines.push(`${plural(regWarned, 'row')} ${regWarned === 1 ? 'is' : 'are'} on a do-not-call register where service calls are allowed: make sure this campaign is about their orders, not a sales pitch.`);
  const phone = checks.filter((c) => c.error?.kind === 'phone').length; if (phone) lines.push(`${plural(phone, 'row')} ${phone === 1 ? 'has' : 'have'} no valid 10-digit phone number. Use the supplier contact's mobile, digits only.`);
  if (!lines.length) lines.push('This sheet is clean. Keep dates as DD/MM/YYYY and lists comma-separated with no comma at the end.');
  const fixed = checks.filter((c) => c.fixes.length && !c.error).length; const stopped = checks.filter((c) => c.error).length;
  return { title: `Note for ${agentLabel}`, summary: `${plural(total, 'row')} checked: ${fixed} fixed automatically, ${stopped} cannot be called.`, lines, source: 'Written from this sheet\'s check (demo stand-in for the AI note).' };
}
/** Tips shown when an agent is picked, from its template's columns (demo stand-in for the AI note). */
export function agentTips(agentLabel, inputs) {
  const tips = [];
  const dates = inputs.filter(isDateKey); if (dates.length) tips.push(`Dates (${dates.join(', ')}) as DD/MM/YYYY. A date that is not a real day stops the row.`);
  const lists = inputs.filter((k) => isPoKey(k) || /count|details|items/i.test(k)); if (lists.length) tips.push(`Several POs in one row are fine: separate values in ${lists.join(', ')} with commas, no comma at the end, the same order in each column.`);
  if (inputs.includes('contact_phone')) tips.push("contact_phone is required on every row: the supplier's 10-digit mobile. It is the number called, and it ties each call to this row's POs and items in the reports.");
  tips.push('One supplier contact per row. Our own numbers are counted as internal tests, not called as suppliers.');
  return { title: `Before you fill ${agentLabel}'s template`, lines: tips, source: 'From this agent\'s template (demo stand-in for the AI note).' };
}

// ── Retry rules per agent & Branded Caller ID (ideas doc 2.2–2.6) ────────────
export const RETRY_SCHEDULES = [{ key: 'linear', label: 'Linear' }, { key: 'increasing', label: 'Linear increasing' }, { key: 'doubling', label: 'Doubling' }];
export const BRANDING_PROVIDERS = [
  { key: 'truecaller', label: 'Truecaller Verified Business', badge: 'Green Verified Badge + Logo' },
  { key: 'cnam', label: 'Operator CNAM / TRAI CNAP', badge: 'Network Caller Name Display' },
  { key: 'hiya', label: 'Hiya Connect / First Orion (STIR/SHAKEN)', badge: 'Carrier Branded Call + Reason' },
  { key: 'google_apple', label: 'Google Verified Calls & Apple BusinessCaller ID', badge: 'OS Dialer Brand + Call Reason' },
];
export const defaultRetryRule = () => ({
  schedule: 'increasing',
  base_minutes: 30,
  retries: 5,
  from: '10:00',
  to: '18:00',
  skip_sunday: true,
  avoid_saturday: true,
  avoid_lunch: true,
  prefer_prime_slots: true,
  retry_silent: true,
  retry_system_issue: true,
  retry_cut_short: true,
  voicemail_drop: true,
  dnd_unblock_after: 2,
  callback_cta: true,
  caller_id: '+91 80 4718 2290',
  branded_name: 'Moglix Procurement',
  call_reason: 'Purchase Order Follow-up',
  branding_providers: ['truecaller', 'cnam', 'hiya', 'google_apple'],
  stop_on_goal: true,
  by_result: defaultByResult(),
});
/** What to do after each call result: retry (how many times, which gap, which message) or stop. gap null = the schedule's gaps. */
export const RESULT_KEYS = [
  { key: 'no_answer', label: 'No answer', match: (r) => r.call_status === 'Not picked' },
  { key: 'voicemail', label: 'Voicemail', match: (r) => r.call_status === 'Voicemail' },
  { key: 'silent', label: 'Silent line', match: (r) => r.call_status === 'No reply' },
  { key: 'system', label: 'System issue', match: (r) => r.call_status === 'System issue' },
  { key: 'dnd', label: 'DND / blocked', match: (r) => r.call_status === 'DND' },
  { key: 'cut_short', label: 'Hung up early', match: (r) => r.call_status === 'Answered' && /not given time|left before/i.test(r.status_reason || '') },
  { key: 'partial', label: 'Partial answer', match: (r) => r.status_reason === 'Success: Partial' },
  { key: 'callback', label: 'Callback asked', match: (r) => r.status_reason === 'Success: Callback requested' },
];
export function defaultByResult() {
  return {
    no_answer: { act: 'retry', tries: 5, gap: null, message: 'whatsapp' }, voicemail: { act: 'retry', tries: 2, gap: 1440, message: 'both' },
    silent: { act: 'retry', tries: 3, gap: 15, message: 'none' }, system: { act: 'retry', tries: 3, gap: 10, message: 'none' },
    dnd: { act: 'retry', tries: 2, gap: null, message: 'both' }, cut_short: { act: 'retry', tries: 2, gap: null, message: 'whatsapp' },
    partial: { act: 'retry', tries: 1, gap: 240, message: 'whatsapp' }, callback: { act: 'callback', tries: 1, gap: null, message: 'none' },
  };
}
export const resultKeyOf = (r) => RESULT_KEYS.find((k) => k.match(r))?.key || null;
/** agent key -> rule. Unset agents use the default. */
export const retryRules = new Map();
export const retryRuleOf = (agent) => ({ ...defaultRetryRule(), ...(retryRules.get(agent) || {}) });
/** Minutes between retries: linear b, b, b…; increasing b, 2b, 3b…; doubling b, 2b, 4b… */
export function retryGaps(rule) {
  const b = Math.max(1, Number(rule.base_minutes) || 30); const n = Math.min(10, Math.max(0, Number(rule.retries) || 0));
  return Array.from({ length: n }, (_, i) => (rule.schedule === 'linear' ? b : rule.schedule === 'doubling' ? b * 2 ** i : b * (i + 1)));
}
/** Builds a downloadable .vcf contact card for the workspace's branded caller ID. */
export function buildVcard(rule = defaultRetryRule()) {
  const name = rule.branded_name || 'Moglix Procurement';
  const tel = rule.caller_id || DEMO_CALLER_ID;
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${name}`,
    `ORG:${name};Supply Chain & Procurement`,
    `TEL;TYPE=WORK,VOICE:${tel}`,
    'EMAIL;TYPE=WORK:procurement@moglix.com',
    `NOTE:Official ${name} Line (Truecaller Business & Operator CNAM Verified) — Save & unblock for PO updates.`,
    'END:VCARD',
  ].join('\r\n');
}
/** Keeps a saved retry rule inside the product's limits, including branded caller ID. */
export function cleanRetryRule(b) {
  const d = defaultRetryRule(); const r = { ...d, ...(b || {}) };
  const keys = BRANDING_PROVIDERS.map((p) => p.key);
  const providers = Array.isArray(r.branding_providers) ? [...new Set(r.branding_providers.filter((k) => keys.includes(k)))] : d.branding_providers;
  const on = (v, fallback) => (v === undefined || v === null ? fallback : !!v);
  return {
    schedule: RETRY_SCHEDULES.some((s) => s.key === r.schedule) ? r.schedule : d.schedule,
    base_minutes: Math.min(1440, Math.max(1, Number(r.base_minutes) || d.base_minutes)),
    retries: Math.min(10, Math.max(0, Number(r.retries) || 0)),
    from: /^\d{2}:\d{2}$/.test(r.from) ? r.from : d.from,
    to: /^\d{2}:\d{2}$/.test(r.to) ? r.to : d.to,
    skip_sunday: !!r.skip_sunday,
    avoid_saturday: on(r.avoid_saturday, d.avoid_saturday),
    avoid_lunch: !!r.avoid_lunch,
    prefer_prime_slots: on(r.prefer_prime_slots, d.prefer_prime_slots),
    retry_silent: on(r.retry_silent, d.retry_silent),
    retry_system_issue: on(r.retry_system_issue, d.retry_system_issue),
    retry_cut_short: on(r.retry_cut_short, d.retry_cut_short),
    voicemail_drop: on(r.voicemail_drop, d.voicemail_drop),
    dnd_unblock_after: Math.min(5, Math.max(1, Number(r.dnd_unblock_after) || d.dnd_unblock_after)),
    callback_cta: on(r.callback_cta, d.callback_cta),
    caller_id: String(r.caller_id || d.caller_id).slice(0, 24),
    branded_name: String(r.branded_name || d.branded_name).slice(0, 60),
    call_reason: String(r.call_reason || d.call_reason).slice(0, 80),
    branding_providers: providers.length ? providers : d.branding_providers,
    stop_on_goal: on(r.stop_on_goal, d.stop_on_goal),
    by_result: Object.fromEntries(RESULT_KEYS.map(({ key }) => {
      const x = { ...d.by_result[key], ...((r.by_result || {})[key] || {}) };
      return [key, { act: ['retry', 'stop', 'callback'].includes(x.act) ? x.act : 'retry', tries: Math.min(10, Math.max(0, Number(x.tries) || 0)),
        gap: x.gap == null || x.gap === '' ? null : Math.min(2880, Math.max(5, Number(x.gap) || 30)), message: ['none', 'whatsapp', 'both'].includes(x.message) ? x.message : 'none' }];
    })),
  };
}
// ── Calling rules per country: when a number may be called at all ────────────
// Presets are a starting point drawn from each country's telemarketing rules; the workspace edits them in Settings.
// Holidays are examples for the next months; the product would load each country's official list.
const wk = (from, to, on = [1, 2, 3, 4, 5, 6, 0], sat = null) => [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day: d, on: on.includes(d), from: d === 6 && sat ? sat[0] : from, to: d === 6 && sat ? sat[1] : to }));
export const COUNTRY_PRESETS = [
  { code: 'IN', name: 'India', prefix: '91', offset_min: 330, tz_label: 'IST (UTC+05:30)', days: wk('09:00', '21:00'),
    holidays: [{ date: '2026-11-24', name: 'Guru Nanak Jayanti' }, { date: '2026-12-25', name: 'Christmas' }, { date: '2027-01-26', name: 'Republic Day' }, { date: '2027-03-22', name: 'Holi' }],
    register: { name: 'NCPR (TRAI National Customer Preference Register)', check: true, action: 'warn' },
    law: 'TRAI allows commercial calls 9 am to 9 pm. PO follow-ups to a supplier are service calls; promotional calls to an NCPR number are not allowed.' },
  { code: 'US', name: 'United States', prefix: '1', offset_min: -300, tz_label: 'US Eastern (UTC−05:00); each number\'s own time zone in production', days: wk('08:00', '21:00'),
    holidays: [{ date: '2026-11-26', name: 'Thanksgiving' }, { date: '2026-12-25', name: 'Christmas' }, { date: '2027-01-01', name: 'New Year\'s Day' }, { date: '2027-01-18', name: 'Martin Luther King Jr. Day' }],
    register: { name: 'National Do Not Call Registry', check: true, action: 'warn' },
    law: 'TCPA: calls only 8 am to 9 pm in the called person\'s time zone. Business-to-business calls are mostly exempt from the registry; consumer numbers on it must not be called for sales.' },
  { code: 'AE', name: 'United Arab Emirates', prefix: '971', offset_min: 240, tz_label: 'GST (UTC+04:00)', days: wk('09:00', '18:00', [1, 2, 3, 4, 5]),
    holidays: [{ date: '2026-12-02', name: 'National Day' }, { date: '2026-12-03', name: 'National Day holiday' }, { date: '2027-01-01', name: 'New Year\'s Day' }, { date: '2027-03-10', name: 'Eid al-Fitr (expected)' }],
    register: { name: 'DNCR (TDRA Do Not Call Register)', check: true, action: 'block' },
    law: 'TDRA rules: marketing calls 9 am to 6 pm only, never to numbers on the DNCR. The weekend is Saturday and Sunday.' },
  { code: 'GB', name: 'United Kingdom', prefix: '44', offset_min: 0, tz_label: 'GMT (UTC+00:00)', days: wk('08:00', '21:00', [1, 2, 3, 4, 5, 6]),
    holidays: [{ date: '2026-12-25', name: 'Christmas Day' }, { date: '2026-12-28', name: 'Boxing Day (substitute)' }, { date: '2027-01-01', name: 'New Year\'s Day' }, { date: '2027-03-26', name: 'Good Friday' }],
    register: { name: 'TPS and CTPS (Telephone Preference Service, Corporate TPS for businesses)', check: true, action: 'block' },
    law: 'PECR: no unsolicited sales calls to numbers on the TPS or CTPS. Calls to existing suppliers about their orders are service calls.' },
  { code: 'DE', name: 'Germany (EU)', prefix: '49', offset_min: 60, tz_label: 'CET (UTC+01:00)', days: wk('09:00', '20:00', [1, 2, 3, 4, 5]),
    holidays: [{ date: '2026-12-25', name: 'Christmas Day' }, { date: '2026-12-26', name: 'Second Day of Christmas' }, { date: '2027-01-01', name: 'New Year\'s Day' }, { date: '2027-03-26', name: 'Good Friday' }],
    register: { name: 'Robinson list (voluntary)', check: true, action: 'warn' },
    law: 'UWG and GDPR: business calls need at least presumed consent; record the lawful basis and honour objections at once. Sundays and public holidays are quiet days.' },
  { code: 'AU', name: 'Australia', prefix: '61', offset_min: 660, tz_label: 'AEDT, Sydney (UTC+11:00)', days: wk('09:00', '20:00', [1, 2, 3, 4, 5, 6], ['09:00', '17:00']),
    holidays: [{ date: '2026-12-25', name: 'Christmas Day' }, { date: '2026-12-28', name: 'Boxing Day (substitute)' }, { date: '2027-01-01', name: 'New Year\'s Day' }, { date: '2027-01-26', name: 'Australia Day' }],
    register: { name: 'Do Not Call Register (ACMA)', check: true, action: 'block' },
    law: 'Telemarketing Standard: weekdays 9 am to 8 pm, Saturday 9 am to 5 pm, never on Sunday or a national public holiday.' },
];
/** The workspace's edited rules: country code -> rule. Absent means the preset. */
export const countryRules = new Map();
const copy = (x) => JSON.parse(JSON.stringify(x));
export const countryRule = (code) => copy(countryRules.get(code) || COUNTRY_PRESETS.find((c) => c.code === code) || COUNTRY_PRESETS[0]);
export const allCountryRules = () => COUNTRY_PRESETS.map((c) => ({ ...countryRule(c.code), edited: countryRules.has(c.code) }));
/** Saves a country's rules: well-formed days, dates and register settings only. */
export function setCountryRule(code, body) {
  const base = COUNTRY_PRESETS.find((c) => c.code === code); if (!base) return null;
  const hhmm = (v, d) => (/^\d{2}:\d{2}$/.test(String(v)) ? String(v) : d);
  const days = base.days.map((d) => { const b = (body?.days || []).find((x) => Number(x.day) === d.day) || d; return { day: d.day, on: !!b.on, from: hhmm(b.from, d.from), to: hhmm(b.to, d.to) }; });
  const holidays = (Array.isArray(body?.holidays) ? body.holidays : base.holidays).filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h.date)).map((h) => ({ date: h.date, name: String(h.name || 'Holiday').slice(0, 60) }))
    .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 60);
  const register = { ...base.register, check: body?.register ? !!body.register.check : base.register.check, action: body?.register?.action === 'block' ? 'block' : body?.register?.action === 'warn' ? 'warn' : base.register.action };
  countryRules.set(code, { ...base, days, holidays, register }); return countryRule(code);
}
export const resetCountryRule = (code) => { countryRules.delete(code); return countryRule(code); };
/** A number's country, from its dialling code; a plain 10-digit number is Indian (the workspace's home country). */
export function countryOf(phone) {
  const raw = String(phone || '').trim(); const d = raw.replace(/\D/g, '');
  if (raw.startsWith('+') || d.length > 10) { const c = [...COUNTRY_PRESETS].sort((a, b) => b.prefix.length - a.prefix.length).find((x) => d.startsWith(x.prefix)); if (c) return c.code; }
  return 'IN';
}
/** Demo stand-in for a register lookup: about one number in twenty-five is on the country's register. */
export function onRegister(phone) { const d = String(phone || '').replace(/\D/g, ''); return d.length >= 8 && ['13', '47', '88', '29'].includes(d.slice(-2)); }
const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
/**
 * The first moment at or after ms when a number in `country` may be called under the agent's rule: a calling day that is not a
 * holiday, inside both the country's hours for that weekday and the agent's own hours, and outside 1-2 pm if the agent avoids lunch.
 * Returns { at, moved: [reasons it was moved] }.
 */
export function fitSlot(ms, rule, country) {
  const c = typeof country === 'string' ? countryRule(country) : country; const off = c.offset_min * 60000; const moved = new Set();
  const hol = new Set(c.holidays.map((h) => h.date));
  for (let guard = 0; guard < 40; guard += 1) {
    const local = new Date(ms + off); const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
    const dayStart = ms - mins * 60000 - local.getUTCSeconds() * 1000 - local.getUTCMilliseconds(); const next = dayStart + 86400000;
    const ymd = local.toISOString().slice(0, 10); const wd = local.getUTCDay(); const d = c.days[wd];
    if (!d.on || (rule.skip_sunday && wd === 0)) { moved.add(!d.on ? `not a calling day in ${c.name}` : 'no calls on Sunday (agent rule)'); ms = next; continue; }
    if (rule.avoid_saturday && wd === 6) { moved.add('avoid Saturday (agent rule)'); ms = next; continue; }
    if (hol.has(ymd)) { moved.add(`holiday: ${c.holidays.find((h) => h.date === ymd).name}`); ms = next; continue; }
    const open = Math.max(hm(d.from), hm(rule.from || '00:00')), close = Math.min(hm(d.to), hm(rule.to || '23:59'));
    if (open >= close) { moved.add('no overlap between the country\'s and the agent\'s hours'); ms = next; continue; }
    if (mins < open) { if (mins > 0 || guard > 0) moved.add('before calling hours'); ms = dayStart + open * 60000; continue; }
    if (mins >= close) { moved.add('after calling hours'); ms = next; continue; }
    if (rule.avoid_lunch && mins >= 780 && mins < 840 && close > 840) { moved.add('avoid 1–2 pm lunch'); ms = dayStart + 840 * 60000; continue; }
    if (rule.prefer_prime_slots) {
      if (mins < 600 && close > 600) { moved.add('preferred slot 10 am–12 pm'); ms = dayStart + 600 * 60000; continue; }
      if (mins >= 720 && mins < 840 && close > 840) { moved.add('preferred slot 2 pm–5 pm (avoids 1–2 pm)'); ms = dayStart + 840 * 60000; continue; }
      if (mins >= 1020) { moved.add('preferred slot 10 am–12 pm next working day'); ms = next; continue; }
    }
    if (moved.has('after calling hours')) moved.delete('before calling hours');
    return { at: ms, moved: [...moved] };
  }
  return { at: ms, moved: [...moved] };
}
/** Retry times after a call at startIso (`done` retries already made), each moved into the country's and the agent's calling hours. */
export function retryPlan(rule, startIso, done = 0, country = 'IN') {
  let t = Date.parse(startIso) || Date.now(); const out = [];
  for (const g of retryGaps(rule).slice(done)) { t = fitSlot(t + g * 60000, rule, country).at; out.push(new Date(t).toISOString()); }
  return out;
}
/** The upload check's register lookup for one row: { country, hit: null | { action, note } }. */
export function registerCheck(phone) {
  const code = countryOf(phone); const c = countryRule(code);
  if (!c.register.check || !onRegister(phone)) return { country: code, hit: null };
  return { country: code, hit: { action: c.register.action, note: c.register.action === 'block' ? `On the ${c.register.name}: not called` : `On the ${c.register.name}: check this is a service call, not a sales call` } };
}
/** How many rows of a sheet fall in each country. */
export function countriesOf(phones) {
  const n = new Map(); for (const p of phones) { const k = countryOf(p); n.set(k, (n.get(k) || 0) + 1); }
  return [...n.entries()].map(([code, rows]) => ({ code, name: countryRule(code).name, rows })).sort((a, b) => b.rows - a.rows);
}
/** Example retry times, with why each was moved, for the New campaign preview. */
export function retryPreview(rule, country = 'IN', startIso = null, startHour = 10) {
  const c = countryRule(country); const off = c.offset_min * 60000;
  // Missed at startHour local time on the next calling day.
  const h = Math.min(22, Math.max(0, Number(startHour) || 10)); const hh = `${String(h).padStart(2, '0')}:00`;
  const now = Date.now(); const local = new Date(now + off); const atLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), h, 0) - off;
  const start = startIso ? Date.parse(startIso) : fitSlot(atLocal, { ...rule, from: hh }, c).at;
  let t = start; const times = [];
  for (const g of retryGaps(rule)) { const f = fitSlot(t + g * 60000, rule, c); t = f.at; times.push({ at: new Date(t).toISOString(), local: new Date(t + off).toISOString().slice(0, 16).replace('T', ' '), moved: f.moved }); }
  return { country: c.code, name: c.name, tz_label: c.tz_label, start: new Date(start + off).toISOString().slice(0, 16).replace('T', ' '), times };
}

// ── Next steps on the call page: retries and WhatsApp / email (ideas doc section 2) ──
export const DEMO_CALLER_ID = '+91 80 4718 2290';
/** Messages sent from call pages: row id -> [{ channel, key, text, at, by }]. The demo does not really send them. */
export const sentMessages = new Map();
const poOf = (r) => { const i = r.inputs || {}; const k = Object.keys(i).find(isPoKey) || Object.keys(i).find((x) => /order/i.test(x)); return k ? i[k] : ''; };
const poDetailsText = (r) => {
  const i = r.inputs || {};
  const po = poOf(r) || '2044120';
  const items = i.item_details || i.items || 'Mechanical / Electrical PO items';
  const count = i.item_count || i.po_count || '1';
  const dispatch = i.target_dispatch_date || i.po_date || '';
  const plant = i.plant_name ? ` (${i.plant_name})` : '';
  return `PO ${po}${plant} · ${count} item(s): ${items}${dispatch ? ` · Target dispatch: ${dispatch}` : ''}`;
};
const firstName = (r) => String(r.caller_name || '').trim().split(/\s+/)[0] || 'there';
/** Which statuses get another call, and from when. */
function retryFor(r, rule = defaultRetryRule()) {
  const s = r.call_status, why = r.status_reason;
  if (s === 'Not picked') return { label: 'No answer: retry on schedule in preferred 10–12 / 2–5 pm slots (avoids 1–2 pm & Saturdays), plus WhatsApp & email with callback CTA' };
  if (s === 'Voicemail') return { label: 'Voicemail detected: left spoken message with all PO details + sent WhatsApp & email follow-up; retry next working day in prime slot', next_day: true };
  if (s === 'No reply' && rule.retry_silent !== false) return { label: 'Silent (No reply): 4s audio check ("Hello, can you hear me?") -> 10s hang-up -> automatically enters retry flow', fast_gap: 15 };
  if (s === 'System issue' && rule.retry_system_issue !== false) return { label: 'System issue: ops alerted with Call ID & SIP code -> automatically enters priority retry flow', fast_gap: 10 };
  if (s === 'DND') return { label: `DND / blocked: after ${rule.dnd_unblock_after || 2} DND results, send WhatsApp & email with vCard ("${rule.branded_name || 'Moglix Procurement'}") and "Tap to get a call now" CTA`, cap: Number(rule.dnd_unblock_after) || 2 };
  if (s === 'Answered' && (why === 'Agent not given time to speak' || why === 'Left before answering') && rule.retry_cut_short !== false) {
    return { label: 'Agent not given time to speak (<15s): goes to retry flow with fast-hook opening ("Hi [Name], Saniya from Moglix about PO [No]: can you accept it today?")' };
  }
  if (s === 'Answered' && why === 'Success: Partial') return { label: 'Partial: call again for full confirmation if the supplier does not confirm on WhatsApp', cap: 1 };
  if (s === 'Answered' && why === 'Success: Callback requested') return { label: 'Callback: call at the agreed time (2 hours later in prime slot if none was saved)', callback: true };
  return null;
}
/** Suggested messages for a call, by its status. Each: { key, channel, title, text, attach_vcard, callback_cta }. */
export function messageSuggestions(r, nextAt, rule = defaultRetryRule()) {
  const po = poOf(r); const ref = po ? `PO ${po}` : 'your pending Moglix PO'; const details = poDetailsText(r);
  const brand = rule.branded_name || 'Moglix Procurement'; const did = rule.caller_id || DEMO_CALLER_ID;
  const hi = `Hi ${firstName(r)}`; const at = nextAt ? new Date(nextAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : 'in the next 10–12 / 2–5 pm slot';
  const ctaLink = `https://echo.moglix.com/callback/${encodeURIComponent(r.id || 'po')}`;
  const s = r.call_status, why = r.status_reason; const out = [];
  const both = (key, title, wa, mail, extra = {}) => {
    out.push({ key, channel: 'whatsapp', title, text: wa, ...extra });
    out.push({ key, channel: 'email', title, text: mail, ...extra });
  };
  if (s === 'DND') {
    both(
      'unblock',
      `Ask to unblock (after ${rule.dnd_unblock_after || 2} DND results) + vCard + Call Now CTA`,
      `${hi}, Moglix calls you from ${did} (${brand} · Truecaller & CNAM Verified) about your POs (${details}). Please save this number (vCard attached) and unblock it. Tap to get a call now: ${ctaLink}`,
      `Subject: Please save & unblock ${brand} (${did}) — ${ref}\n\n${hi},\n\nMoglix calls you from ${did} (${brand}) about your POs:\n• ${details}\n\nOur calls are being blocked by DND/spam filters. Please save the attached contact card (${brand}.vcf) and unblock ${did}.\n\n[Tap to get a call now]: ${ctaLink}\n\n${brand}`,
      { attach_vcard: true, callback_cta: true }
    );
  } else if (s === 'Not picked' || s === 'No reply' || s === 'System issue') {
    both(
      'heads_up',
      'PO details + next prime-slot call + Request a Callback CTA',
      `${hi}, ${brand} tried to reach you from ${did} about ${details}. We will call again ${at} (or save ${did} via attached vCard). Reply ACCEPT if accepted, or tap to request a callback now: ${ctaLink}`,
      `Subject: ${ref} — PO Details & Request a Callback (${brand})\n\n${hi},\n\nWe tried to reach you from ${did} (${brand}) regarding:\n• ${details}\n\nWe will call again ${at} (within 10 am–12 pm / 2 pm–5 pm prime hours).\n• Tap to request an immediate callback: ${ctaLink}\n• Or reply ACCEPT with your dispatch date.\n\n${brand}`,
      { attach_vcard: true, callback_cta: true }
    );
  } else if (s === 'Voicemail') {
    both(
      'voicemail',
      'Voicemail follow-up with all PO details + Callback CTA',
      `${hi}, we just left a voicemail on your number from ${did} (${brand}) with full details for ${details}. We will follow up ${at}. Reply ACCEPT, or tap to get a call now: ${ctaLink}`,
      `Subject: Voicemail & Full PO Details — ${ref} (${brand})\n\n${hi},\n\nWe reached your voicemail and left a message regarding:\n• ${details}\n• Caller ID: ${did} (${brand})\n\nPlease review and accept on the portal, reply to this email, or tap to trigger a callback now: ${ctaLink}\n\n${brand}`,
      { attach_vcard: true, callback_cta: true }
    );
  } else if (why === 'Agent not given time to speak' || why === 'Left before answering') {
    both(
      'cut_short',
      'Fast-hook follow-up with PO details + 1-min Callback CTA',
      `${hi}, ${brand} here about ${details}. Our call was cut short — we will retry ${at} with a quick 30-second check. Reply ACCEPT, or tap to get a call now: ${ctaLink}`,
      `Subject: Quick confirmation needed for ${ref} (${brand})\n\n${hi},\n\nWe called from ${did} (${brand}) regarding:\n• ${details}\n\nOur call ended before we could share the PO number. Please reply ACCEPTED with your dispatch date, or tap for a 1-minute callback now: ${ctaLink}\n\n${brand}`,
      { attach_vcard: true, callback_cta: true }
    );
  } else if (why === 'Success: Follow-up required') {
    both(
      'follow_up',
      'Send the PO details and confirm team follow-up',
      `${hi}, as discussed, here are the full details of ${details} (PDF attached) and the portal link. Our team will follow up by ${at}. Reply ACCEPTED once done.`,
      `Subject: ${ref}: PO details as discussed\n\n${hi},\n\nAs discussed on the call, here are the details:\n• ${details}\n\nThe PO copy is attached and our team will follow up by ${at}.\n\n${brand}`
    );
  } else if (why === 'Success: Callback requested') {
    both(
      'callback',
      'Confirm the booked callback time',
      `${hi}, as requested, ${brand} (${did}) will call you back ${r.callback_at || at} about ${details}. Tap to call now instead: ${ctaLink}`,
      `Subject: ${ref}: Callback scheduled for ${r.callback_at || at}\n\n${hi},\n\nAs requested, we will call you back ${r.callback_at || at} from ${did} (${brand}) regarding:\n• ${details}\n\n${brand}`,
      { callback_cta: true }
    );
  } else if (why === 'Success: Partial') {
    both(
      'confirm',
      'Ask for full confirmation',
      `${hi}, please confirm what we noted for ${details}: ${Object.entries(r.answers || {}).slice(0, 3).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ') || 'acceptance and dispatch date'}. Reply YES, or send the right details.`,
      `Subject: ${ref}: please confirm\n\n${hi},\n\nPlease confirm what we noted on the call for ${details}. Reply YES, or send the right details.\n\n${brand}`
    );
  } else if (why === 'Success: Accepted') {
    out.push({ key: 'thanks', channel: 'whatsapp', title: 'Thank and confirm', text: `${hi}, thanks for accepting ${details}. We have noted it. Reply here for anything about this PO.` });
  } else if (why === 'Wrong number') {
    out.push({ key: 'fix_contact', channel: 'email', title: 'Ask the uploader to fix the contact', text: `Subject: Wrong contact for ${ref}\n\nThe number ${r.phone} for ${r.caller_name || 'this supplier'} is wrong or no longer handles POs. Please update the supplier contact and re-upload the row.` });
  }
  return out;
}
/** The call page's next steps: the retry plan from the agent's rule, the suggested messages and what was already sent. */
export function callSteps(r) {
  const rule = retryRuleOf(r.agent_key || r.agent); let rt = retryFor(r, rule); const country = countryOf(r.phone); const c = countryRule(country);
  const rk = resultKeyOf(r); const br = rk ? (rule.by_result || defaultByResult())[rk] : null; const dnc = onDnc(r.phone);
  let plan = [];
  if (rt) {
    const from = rt.callback ? (Date.parse(r.callback_at || '') ? new Date(Date.parse(r.callback_at)).toISOString() : new Date(Date.parse(r.call_date || '') + 2 * 3600000 || Date.now()).toISOString()) : r.call_date || new Date().toISOString();
    const done = Math.min(Number(r.retries) || 0, rule.retries);
    if (rt.callback) plan = [new Date(fitSlot(Date.parse(from), rule, country).at).toISOString()];
    else if (rt.next_day) plan = retryPlan({ ...rule, schedule: 'linear', base_minutes: 24 * 60, retries: 1 }, from, 0, country);
    else if (rt.fast_gap) plan = [new Date(fitSlot((Date.parse(from) || Date.now()) + rt.fast_gap * 60000, rule, country).at).toISOString(), ...retryPlan(rule, from, done + 1, country)];
    else plan = retryPlan(rule, from, done, country).slice(0, rt.cap || undefined);
  }
  if (rt && br && !rt.callback) {
    const done = Number(r.retries) || 0;
    if (br.act === 'stop') { plan = []; rt = { label: `${RESULT_KEYS.find((k) => k.key === rk).label}: no more calls (the agent's rule for this result)` }; }
    else if (br.gap) plan = retryPlan({ ...rule, schedule: 'linear', base_minutes: br.gap, retries: br.tries }, r.call_date || new Date().toISOString(), Math.min(done, br.tries), country);
    else plan = plan.slice(0, Math.max(0, br.tries - done));
  }
  if (dnc) { plan = []; rt = { label: `On your do-not-call list (${dnc.reason}): no more calls` }; }
  const today = c.days[new Date(Date.now() + c.offset_min * 60000).getUTCDay()];
  const details = poDetailsText(r);
  const voicemail_script = r.call_status === 'Voicemail'
    ? `"Hello ${firstName(r)}, this is ${r.agent || 'Saniya'} calling from ${rule.branded_name || 'Moglix Procurement'} on ${rule.caller_id || DEMO_CALLER_ID} regarding ${details}. We have also sent all PO details on WhatsApp and email. Please accept the PO on the portal or tap the callback link to speak with us right away. Thank you."`
    : null;
  const fast_hook_script = r.status_reason === 'Agent not given time to speak' || r.status_reason === 'Left before answering'
    ? `"Hi ${firstName(r)}, ${r.agent || 'Saniya'} from ${rule.branded_name || 'Moglix Procurement'} about ${details}: can you accept it on the portal today?"`
    : null;
  return {
    rule,
    schedules: RETRY_SCHEDULES,
    branding_providers: BRANDING_PROVIDERS,
    branded_caller: {
      number: rule.caller_id || DEMO_CALLER_ID,
      name: rule.branded_name || 'Moglix Procurement',
      call_reason: rule.call_reason || 'Purchase Order Follow-up',
      providers: BRANDING_PROVIDERS.filter((p) => (rule.branding_providers || ['truecaller', 'cnam', 'hiya', 'google_apple']).includes(p.key)),
    },
    vcard: buildVcard(rule),
    voicemail_script,
    fast_hook_script,
    retry: rt ? { label: rt.label, plan, left: plan.length } : null,
    result_rule: br && rk ? { key: rk, label: RESULT_KEYS.find((k) => k.key === rk).label, ...br } : null,
    dnc,
    country: { code: c.code, name: c.name, tz_label: c.tz_label, hours_today: today.on ? `${today.from}–${today.to}` : 'no calls today', register: c.register.name,
      on_register: c.register.check && onRegister(r.phone), register_action: c.register.action },
    messages: messageSuggestions(r, plan[0], rule),
    sent: sentMessages.get(r.id) || [],
    caller_id: rule.caller_id || DEMO_CALLER_ID,
  };
}
export function sendMessage(r, { channel, key, text }, by) {
  const list = sentMessages.get(r.id) || []; list.push({ channel: channel === 'email' ? 'email' : 'whatsapp', key: key || '', text: String(text || '').slice(0, 2000), at: new Date().toISOString(), by, to: channel === 'email' ? r.email || '(no email on file)' : r.phone });
  sentMessages.set(r.id, list); return list;
}
