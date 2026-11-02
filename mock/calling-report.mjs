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
const NOT_PICKED = new Set(['Not picked', 'DND', 'Voicemail']);
export const BOX = {
  uploaded: () => true,
  test: isStatus('Internal test call'),
  bad_data: isStatus('Bad data'),
  stopped: isStatus('Stopped'),
  planned: (r) => !PLANNED_OUT.has(r.call_status),
  not_picked_up: (r) => NOT_PICKED.has(r.call_status),
  picked_up: (r) => !PLANNED_OUT.has(r.call_status) && !NOT_PICKED.has(r.call_status),
  no_answer: isStatus('Not picked'),
  dnd: isStatus('DND'),
  voicemail: isStatus('Voicemail'),
  answered: isStatus('Answered'),
  silent: isStatus('No reply'),
  system_issue: isStatus('System issue'),
  in_progress: isStatus('In progress'),
  success: isSuccess,
  accepted: isReason('Success: Accepted'),
  partial: isReason('Success: Partial'),
  follow_up: isReason('Success: Follow-up required'),
  callback: isReason('Success: Callback requested'),
  not_successful: (r) => r.call_status === 'Answered' && !isSuccess(r),
  not_given_time: isReason('Agent not given time to speak'),
  left: isReason('Left before answering'),
  wrong_number: isReason('Wrong number'),
  goal_yes: (r) => r.goal_reached === 'Yes',
  goal_no: (r) => r.goal_reached === 'No',
  goal_na: (r) => r.goal_reached === 'N/A' && r.call_status !== 'Internal test call',
};

/** With "Include test calls" on, a test row counts as the status it would otherwise have. */
const asBusiness = (r) => (r.call_status === 'Internal test call' && r.test_status ? { ...r, call_status: r.test_status, goal_reached: r.test_goal ?? r.goal_reached, is_test: true } : r);

/** Rows in the period and agents asked for. Rows with no call date (bad data) count by their upload date. */
export function scopeRows(rows, { from, to, agents = [], includeTests = false } = {}) {
  const lo = from ? Date.parse(from) : -Infinity; const hi = to ? Date.parse(to) : Infinity;
  return rows.filter((r) => { const t = Date.parse(r.call_date || r.uploaded_at || ''); return (!Number.isFinite(t) || (t >= lo && t <= hi)) && (!agents.length || agents.includes(r.agent_key || r.agent)); })
    .map((r) => (includeTests ? asBusiness(r) : r));
}

const pct = (a, b) => (b ? a / b : 0);
const line = (rows, key, label, extra = {}) => ({ key, label, count: rows.filter(BOX[key]).length, ...extra });

/** The whole report for already scoped rows (scopeRows). Rates are unrounded; the page rounds them. */
export function buildReport(rows, { workspace = '', from = null, to = null, timeZone = 'Asia/Kolkata', includeTests = false, agentsAll = [] } = {}) {
  const n = (k) => rows.filter(BOX[k]).length;
  const planned = rows.filter(BOX.planned); const answered = rows.filter(BOX.answered);
  const talk = answered.reduce((s, r) => s + (Number(r.duration_seconds) || 0), 0);
  const uploaded = rows.length; const pl = planned.length; const pu = n('picked_up'); const an = answered.length; const su = n('success');
  const box = (key, step, label, total, lines) => ({ key, step, label, total, lines: lines.map((l) => ({ ...l, share: pct(l.count, l.of ?? total) })) });
  const notPicked = n('not_picked_up'); const notSucc = n('not_successful');
  const funnel = [
    box('uploaded', 1, 'Uploaded', uploaded, [line(rows, 'planned', 'Planned to call', { strong: true }), line(rows, 'bad_data', 'Bad data'), line(rows, 'test', 'Internal test calls'),
      ...(n('stopped') ? [line(rows, 'stopped', 'Stopped before dialling')] : [])]),
    box('planned', 2, 'Planned to call', pl, [line(rows, 'picked_up', 'Picked up', { strong: true }), line(rows, 'not_picked_up', 'Not picked up', { strong: true }),
      line(rows, 'no_answer', 'No answer', { sub: true, of: notPicked }), line(rows, 'dnd', 'DND / blocked', { sub: true, of: notPicked }), line(rows, 'voicemail', 'Voicemail', { sub: true, of: notPicked })]),
    box('picked_up', 3, 'Picked up', pu, [line(rows, 'answered', 'Answered', { strong: true }), line(rows, 'silent', 'Silent'), line(rows, 'system_issue', 'System issue'),
      ...(n('in_progress') ? [line(rows, 'in_progress', 'In progress')] : [])]),
    box('answered', 4, 'Answered', an, [line(rows, 'success', 'Success', { strong: true, good: true }),
      line(rows, 'accepted', 'Accepted', { sub: true, of: su }), line(rows, 'partial', 'Partial', { sub: true, of: su }), line(rows, 'follow_up', 'Follow-up required', { sub: true, of: su }), line(rows, 'callback', 'Callback requested', { sub: true, of: su }),
      line(rows, 'not_successful', 'Not successful', { strong: true }),
      line(rows, 'not_given_time', 'Agent not given time to speak', { sub: true, of: notSucc }), line(rows, 'left', 'Left before answering', { sub: true, of: notSucc }), line(rows, 'wrong_number', 'Wrong number', { sub: true, of: notSucc })]),
  ];
  const byAgent = [...new Set(planned.map((r) => r.agent))].sort().map((agent) => {
    const mine = rows.filter((r) => r.agent === agent); const a = mine.filter(BOX.answered); const s = mine.filter(BOX.success).length;
    const t = a.reduce((x, r) => x + (Number(r.duration_seconds) || 0), 0);
    return { agent, agent_key: mine[0]?.agent_key || agent, planned: mine.filter(BOX.planned).length, picked_up: mine.filter(BOX.picked_up).length, answered: a.length, success: s, success_rate: pct(s, a.length), avg_talk_seconds: a.length ? t / a.length : 0 };
  });
  // Every box must equal the sum of the boxes under it (logic doc section 3); a gap is shown, never hidden.
  const checks = [
    ['Uploaded', uploaded, pl + n('bad_data') + n('test') + n('stopped')],
    ['Planned to call', pl, pu + notPicked],
    ['Not picked up', notPicked, n('no_answer') + n('dnd') + n('voicemail')],
    ['Picked up', pu, an + n('silent') + n('system_issue') + n('in_progress')],
    ['Answered', an, su + notSucc],
    ['Success', su, n('accepted') + n('partial') + n('follow_up') + n('callback')],
    ['Not successful', notSucc, n('not_given_time') + n('left') + n('wrong_number')],
  ];
  const gaps = checks.filter(([, a, b]) => a !== b).map(([box, expected, got]) => ({ box, expected, got }));
  return {
    generated_at: new Date().toISOString(), time_zone: timeZone, definitions_version: DEFINITIONS_VERSION, workspace, from, to, tests_included: includeTests,
    headline: { uploaded, campaigns: new Set(rows.map((r) => r.campaign_id || r.campaign)).size, planned: pl, picked_up: pu, answered: an, success: su,
      planned_share: pct(pl, uploaded), picked_up_share: pct(pu, pl), answered_share: pct(an, pu), success_rate: pct(su, an) },
    stats: { dials: planned.reduce((s, r) => s + 1 + (Number(r.retries) || 0), 0), avg_talk_seconds: an ? talk / an : 0, total_talk_seconds: talk, in_progress: n('in_progress') },
    funnel, by_agent: byAgent,
    success_field: { yes: n('goal_yes'), no: n('goal_no'), na: n('goal_na') },
    sum_check: { ok: !gaps.length, gaps },
    agents: agentsAll,
  };
}

/** Rows behind one box, newest call first, for the drill-down lists. */
export function rowsInBox(rows, key) {
  const pick = BOX[key] || BOX.uploaded;
  return rows.filter(pick).sort((a, b) => Date.parse(b.call_date || b.uploaded_at || 0) - Date.parse(a.call_date || a.uploaded_at || 0));
}

/** The export: the 14 columns, Duration as m:ss, dates in the workspace time zone. */
export function exportTable(rows, timeZone = 'Asia/Kolkata') {
  const when = (v) => (v ? new Date(v).toLocaleString('en-GB', { timeZone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '');
  const mmss = (s) => (s == null || s === '' ? '' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
  return [COLUMNS.map(([, l]) => l), ...rows.map((r) => COLUMNS.map(([k]) => (k === 'call_date' ? when(r.call_date) : k === 'duration_seconds' ? mmss(r.duration_seconds) : r[k] ?? '')))];
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
