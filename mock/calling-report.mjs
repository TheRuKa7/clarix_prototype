// Calling report, definitions v1 (30 Oct 2026): Calling-Report-Logic.md and PRD-Call-Outcome-and-Funnel.md.
// One status per uploaded row, decided once when the call ends, and every dashboard number worked out from
// those stored statuses. The Echo and Clarix mocks share this file: keep the two copies identical.

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
  const weigh = (rs) => (unit ? rs.flatMap((r) => { const w = Math.max(0, Math.round(Number(r.units?.[unit]) || 0)); return w ? Array(w).fill(r) : []; }) : rs);
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
export function filterRows(rows, { q = '', cols = {} } = {}) {
  const term = String(q || '').trim().toLowerCase(); const want = Object.entries(cols || {}).filter(([, v]) => (Array.isArray(v) ? v.length : String(v ?? '').trim()));
  if (!term && !want.length) return rows;
  const hit = (r) => COLUMNS.some(([k]) => cellText(r, k).toLowerCase().includes(term))
    || [...Object.values(r.inputs || {}), ...Object.values(r.answers || {})].some((v) => String(v ?? '').toLowerCase().includes(term));
  return rows.filter((r) => (!term || hit(r))
    && want.every(([k, v]) => (Array.isArray(v) ? v.includes(cellText(r, k)) : cellText(r, k).toLowerCase().includes(String(v).trim().toLowerCase()))));
}
/** Reads ?q= and ?filters= (JSON of column: text) from a request. */
export function logFilters(q) { let cols = {}; try { cols = JSON.parse(q.get('filters') || '{}'); } catch { /* ignore bad filters */ } return { q: q.get('q') || '', cols }; }

// ── Shared screens (phase 3): campaigns list, follow ups ──────────────────────
/** One line per campaign, from its rows: the same funnel counts as the dashboard, and a status. */
export function campaignSummaries(rows) {
  const by = new Map();
  for (const r of rows) { if (!r.campaign_id || r.campaign_id === 'console') continue; (by.get(r.campaign_id) || by.set(r.campaign_id, []).get(r.campaign_id)).push(r); }
  return [...by.entries()].map(([id, mine]) => {
    const n = (k) => mine.filter(BOX[k]).length; const an = n('answered'), su = n('success'), open = n('in_progress'), stopped = n('stopped');
    const first = mine.reduce((m, r) => (!m || (r.uploaded_at && r.uploaded_at < m) ? r.uploaded_at : m), null);
    const status = open ? 'Running' : n('planned') === 0 ? 'Failed' : stopped ? 'Stopped' : 'Completed';
    return { campaign_id: id, campaign: mine[0].campaign, agent: mine[0].agent, agent_key: mine[0].agent_key, uploaded_by: mine[0].uploaded_by || '', created_at: first,
      uploaded: mine.length, planned: n('planned'), picked_up: n('picked_up'), answered: an, success: su, success_rate: pct(su, an), not_finished: open, bad_data: n('bad_data'), status };
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
    && (state === 'all' || (state === 'running' ? c.status === 'Running' : c.status !== 'Running'))
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
/** agent key -> [{ field, label }] the workspace chose; absent means "every number column of the agent's upload". */
export const agentStats = new Map();
/** agents: [{ key, label, numberFields: [] }] -> each agent's stats, defaulting to its number columns. */
export function statsByAgent(agents) {
  return agents.map((a) => ({ agent: a.key, label: a.label, fields: a.numberFields.map((f) => ({ field: f, label: unitLabel(f) })),
    stats: agentStats.get(a.key) || a.numberFields.map((f) => ({ field: f, label: unitLabel(f) })) }));
}
/** The stats offered in "Count by" for the agents in rows: union of their chosen stats. */
export function unitsFor(rows, agents) {
  const keys = new Set(rows.map((r) => r.agent_key)); const out = new Map();
  for (const a of statsByAgent(agents.filter((x) => keys.has(x.key)))) for (const st of a.stats) if (!out.has(st.field)) out.set(st.field, st);
  return [...out.values()];
}
/** A campaign's custom stats: total, answered (covered) and accepted, per stat of its agent. */
export function campaignStats(rows, stats) {
  return stats.map((st) => {
    const sum = (rs) => rs.reduce((n, r) => n + (Number(r.units?.[st.field]) || 0), 0);
    return { field: st.field, label: st.label, total: sum(rows.filter(BOX.planned)), covered: sum(rows.filter(BOX.answered)), accepted: sum(rows.filter(BOX.accepted)) };
  });
}

/** Distinct values of one column (with the other filters on), for the multi-select column filter. */
export function columnValues(rows, column) {
  const m = new Map(); for (const r of rows) { const v = cellText(r, column); m.set(v, (m.get(v) || 0) + 1); }
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
  return 'Follow up on the answer';
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

/** The dashboard's small box: open follow ups and the work still running. */
export function tasksSummary(rows) {
  const f = followChecklist(rows); const camps = campaignSummaries(rows);
  return { follow_ups: f.counts.open, callbacks: f.counts.callback, follow_up_required: f.counts.follow_up, running_campaigns: camps.filter((c) => c.status === 'Running').length, not_finished: rows.filter(BOX.in_progress).length };
}

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
  return { ctx: out, fixes, warnings, error };
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
  tips.push('One supplier contact per row, with a 10-digit mobile. Our own numbers are counted as internal tests, not called as suppliers.');
  return { title: `Before you fill ${agentLabel}'s template`, lines: tips, source: 'From this agent\'s template (demo stand-in for the AI note).' };
}

// ── Retry rules per agent (ideas doc 2.3) ─────────────────────────────────────
export const RETRY_SCHEDULES = [{ key: 'linear', label: 'Linear' }, { key: 'increasing', label: 'Linear increasing' }, { key: 'doubling', label: 'Doubling' }];
export const defaultRetryRule = () => ({ schedule: 'increasing', base_minutes: 30, retries: 5, from: '10:00', to: '18:00', skip_sunday: true, avoid_lunch: true });
/** agent key -> rule. Unset agents use the default. */
export const retryRules = new Map();
export const retryRuleOf = (agent) => ({ ...defaultRetryRule(), ...(retryRules.get(agent) || {}) });
/** Minutes between retries: linear b, b, b…; increasing b, 2b, 3b…; doubling b, 2b, 4b… */
export function retryGaps(rule) {
  const b = Math.max(1, Number(rule.base_minutes) || 30); const n = Math.min(10, Math.max(0, Number(rule.retries) || 0));
  return Array.from({ length: n }, (_, i) => (rule.schedule === 'linear' ? b : rule.schedule === 'doubling' ? b * 2 ** i : b * (i + 1)));
}
/** Retry times after a call at startIso (`done` retries already made), each moved into calling hours (IST): not before from, not after to, not 13–14 h, not Sunday. */
export function retryPlan(rule, startIso, done = 0) {
  const IST = 330 * 60000; const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
  const open = hm(rule.from || '10:00'), close = hm(rule.to || '18:00');
  const fit = (ms) => {
    for (let guard = 0; guard < 14; guard += 1) {
      const local = new Date(ms + IST); const mins = local.getUTCHours() * 60 + local.getUTCMinutes(); const dayStart = ms - mins * 60000 - local.getUTCSeconds() * 1000 - local.getUTCMilliseconds();
      if (rule.skip_sunday && local.getUTCDay() === 0) { ms = dayStart + 86400000 + open * 60000; continue; }
      if (mins < open) { ms = dayStart + open * 60000; continue; }
      if (mins >= close) { ms = dayStart + 86400000 + open * 60000; continue; }
      if (rule.avoid_lunch && mins >= 780 && mins < 840) { ms = dayStart + 840 * 60000; continue; }
      return ms;
    }
    return ms;
  };
  let t = Date.parse(startIso) || Date.now(); const out = [];
  for (const g of retryGaps(rule).slice(done)) { t = fit(t + g * 60000); out.push(new Date(t).toISOString()); }
  return out;
}

// ── Next steps on the call page: retries and WhatsApp / email (ideas doc section 2) ──
export const DEMO_CALLER_ID = '+91 80 4718 2290';
/** Messages sent from call pages: row id -> [{ channel, key, text, at, by }]. The demo does not really send them. */
export const sentMessages = new Map();
const poOf = (r) => { const i = r.inputs || {}; const k = Object.keys(i).find(isPoKey) || Object.keys(i).find((x) => /order/i.test(x)); return k ? i[k] : ''; };
const firstName = (r) => String(r.caller_name || '').trim().split(/\s+/)[0] || 'there';
/** Which statuses get another call, and from when. */
function retryFor(r) {
  const s = r.call_status, why = r.status_reason;
  if (['Not picked', 'Voicemail', 'No reply', 'System issue'].includes(s)) return { label: s === 'Voicemail' ? 'Voicemail: call again the next working day, same time' : 'Not reached: call again', next_day: s === 'Voicemail' };
  if (s === 'DND') return { label: 'DND: two more tries, then ask the supplier to unblock the number', cap: 2 };
  if (s === 'Answered' && ['Agent not given time to speak', 'Left before answering'].includes(why)) return { label: 'Cut short: call again with a shorter opening (name, Moglix, PO number)' };
  if (s === 'Answered' && why === 'Success: Partial') return { label: 'Partial: call again for full confirmation if the supplier does not confirm on WhatsApp', cap: 1 };
  if (s === 'Answered' && why === 'Success: Callback requested') return { label: 'Callback: call at the agreed time (2 hours later if none was saved)', callback: true };
  return null;
}
/** Suggested messages for a call, by its status. Each: { key, channel, title, text }. */
export function messageSuggestions(r, nextAt) {
  const po = poOf(r); const ref = po ? `PO ${po}` : 'your pending Moglix PO'; const hi = `Hi ${firstName(r)}`; const at = nextAt ? new Date(nextAt).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : 'later today';
  const s = r.call_status, why = r.status_reason; const out = [];
  const both = (key, title, wa, mail) => { out.push({ key, channel: 'whatsapp', title, text: wa }); out.push({ key, channel: 'email', title, text: mail }); };
  if (s === 'DND') both('unblock', 'Ask to unblock and save the number', `${hi}, Moglix procurement calls you from ${DEMO_CALLER_ID} about ${ref}. Please save this number (contact card attached) and unblock it. Reply CALL to get a call now.`, `Subject: Please save our number: Moglix procurement\n\n${hi},\n\nWe call from ${DEMO_CALLER_ID} about ${ref}. Our calls are not reaching you; please save this number (contact card attached) and unblock it if it was blocked.\n\nOr reply to this email with your update.\n\nMoglix procurement`);
  else if (s === 'Not picked' || s === 'No reply' || s === 'System issue') both('heads_up', 'Tell them when we will call', `${hi}, Saniya from Moglix tried to reach you about ${ref}. We will call again ${at} from ${DEMO_CALLER_ID} (please save it). Reply ACCEPT if the PO is accepted, or CALL for a call now.`, `Subject: ${ref}: we will call you ${at}\n\n${hi},\n\nWe tried to call you about ${ref}. We will call again ${at} from ${DEMO_CALLER_ID}; please save the number.\n\nIf the PO is already accepted, just reply "accepted".\n\nMoglix procurement`);
  else if (s === 'Voicemail') both('voicemail', 'Same as the voicemail', `${hi}, we left you a voicemail about ${ref}. We will call again ${at}. Reply ACCEPT, or CALL to get a call now.`, `Subject: ${ref}: voicemail from Moglix\n\n${hi},\n\nWe left you a voicemail about ${ref} and will call again ${at}. Reply to this email with your update if that is easier.\n\nMoglix procurement`);
  else if (why === 'Agent not given time to speak' || why === 'Left before answering') both('cut_short', 'Ask for the update by message', `${hi}, Moglix here about ${ref} (details attached). Can you accept it? Reply ACCEPT, NEED COPY, or a time that suits you for a 1-minute call.`, `Subject: ${ref}: can you accept it?\n\n${hi},\n\nWe called about ${ref}; the PO details are attached. Please reply with:\n- Accepted, and the dispatch date, or\n- what you need from us, or\n- a time for a 1-minute call.\n\nMoglix procurement`);
  else if (why === 'Success: Follow-up required') both('follow_up', 'Send the PO and say the team will follow up', `${hi}, as discussed, here are the details of ${ref} (PDF attached) and the portal link. Our team will follow up by ${at}. Reply ACCEPTED once done.`, `Subject: ${ref}: details as discussed\n\n${hi},\n\nAs discussed on the call, the PO copy is attached and the portal link is below. Our team will follow up by ${at}.\n\nPortal: [supplier portal link]\n\nMoglix procurement`);
  else if (why === 'Success: Callback requested') both('callback', 'Confirm the callback time', `${hi}, as you asked, we will call you back ${r.callback_at || at} about ${ref}. Reply with another time if that does not suit you.`, `Subject: ${ref}: we will call you back\n\n${hi},\n\nAs you asked, we will call you back ${r.callback_at || at} about ${ref}. Reply with another time if that does not suit you.\n\nMoglix procurement`);
  else if (why === 'Success: Partial') both('confirm', 'Ask for full confirmation', `${hi}, please confirm what we noted for ${ref}: ${Object.entries(r.answers || {}).slice(0, 3).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ') || 'acceptance and dispatch date'}. Reply YES, or send the right details.`, `Subject: ${ref}: please confirm\n\n${hi},\n\nPlease confirm what we noted on the call for ${ref}. Reply YES, or send the right details.\n\nMoglix procurement`);
  else if (why === 'Success: Accepted') out.push({ key: 'thanks', channel: 'whatsapp', title: 'Thank and confirm', text: `${hi}, thanks for accepting ${ref}. We have noted it. Reply here for anything about this PO.` });
  else if (why === 'Wrong number') out.push({ key: 'fix_contact', channel: 'email', title: 'Ask the uploader to fix the contact', text: `Subject: Wrong contact for ${ref}\n\nThe number ${r.phone} for ${r.caller_name || 'this supplier'} is wrong or no longer handles POs. Please update the supplier contact and re-upload the row.` });
  return out;
}
/** The call page's next steps: the retry plan from the agent's rule, the suggested messages and what was already sent. */
export function callSteps(r) {
  const rule = retryRuleOf(r.agent_key || r.agent); const rt = retryFor(r);
  let plan = [];
  if (rt) {
    const from = rt.callback ? (Date.parse(r.callback_at || '') ? new Date(Date.parse(r.callback_at)).toISOString() : new Date(Date.parse(r.call_date || '') + 2 * 3600000 || Date.now()).toISOString()) : r.call_date || new Date().toISOString();
    const done = Math.min(Number(r.retries) || 0, rule.retries);
    if (rt.callback) plan = [from];
    else if (rt.next_day) plan = retryPlan({ ...rule, schedule: 'linear', base_minutes: 24 * 60, retries: 1 }, from);
    else plan = retryPlan(rule, from, done).slice(0, rt.cap || undefined);
  }
  return { rule, schedules: RETRY_SCHEDULES, retry: rt ? { label: rt.label, plan, left: plan.length } : null,
    messages: messageSuggestions(r, plan[0]), sent: sentMessages.get(r.id) || [], caller_id: DEMO_CALLER_ID };
}
export function sendMessage(r, { channel, key, text }, by) {
  const list = sentMessages.get(r.id) || []; list.push({ channel: channel === 'email' ? 'email' : 'whatsapp', key: key || '', text: String(text || '').slice(0, 2000), at: new Date().toISOString(), by, to: channel === 'email' ? r.email || '(no email on file)' : r.phone });
  sentMessages.set(r.id, list); return list;
}
