// Reports, follow ups and report schedules for the local Clarix mock (prototype of the reporting work).
//
// Clarix only mirrors Echo: every number here is counted from the call status Echo sent for each row.
// Report: dialled, reached, completed and follow ups, split by agent, campaign, day or any column of the uploaded file.
// Follow ups: rows that calling alone cannot settle (blocked, wrong number, rejected, every try used). An owner takes each one.
// Schedules: the report sent by email on a timetable, as a picture, a PDF and a spreadsheet.
import { randomBytes } from 'node:crypto';
import { writeWorkbook } from './xlsx.mjs';
import { OUTCOMES } from './outcome.mjs';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const FOLLOW_REASONS = {
  blocked: { label: 'Blocked', help: 'The number or its network refuses our calls (DND or an explicit block). Calling again will not help until the contact allows the number.' },
  wrong_number: { label: 'Wrong number', help: 'The number does not exist or is not valid. It needs a corrected number.' },
  rejected: { label: 'Rejected', help: 'The contact declined the call. A person should reach out before the agent calls again.' },
  no_more_tries: { label: 'No more tries', help: 'Every allowed try was used and the contact was never reached.' },
  never_reached: { label: 'Not reached on 2+ days', help: 'The contact was tried on two or more separate days and never picked up. The number may be wrong, dead or blocking the calls.' },
};
export function followReason(e) {
  if (e.callStatus === 'RETRY_EXHAUSTED') return 'no_more_tries';
  return FOLLOW_REASONS[e.outcome] ? e.outcome : null;
}


/**
 * Answers summary for one agent, built from the agent's own answer fields. Nothing is assumed about the use case:
 * a choice or yes/no field becomes counts per value, a number field becomes a total and an average, free text is left out.
 * defs: [{ key, label, type: 'choice' | 'number', unit }]; records: one object of answers per call (or per row).
 */
export function summariseAnswers(defs, recordsOf) {
  const out = [];
  for (const d of defs) {
    const vals = recordsOf(d).map((r) => r?.[d.key]).filter((v) => v !== undefined && v !== null && v !== '');
    if (!vals.length) continue;
    if (d.type === 'number') {
      const n = vals.map(Number).filter(Number.isFinite); if (!n.length) continue;
      const sum = n.reduce((a, b) => a + b, 0);
      out.push({ key: d.key, label: d.label, type: 'number', unit: d.unit, answered: n.length, sum: Math.round(sum * 100) / 100, avg: Math.round((sum / n.length) * 10) / 10, min: Math.min(...n), max: Math.max(...n) });
    } else {
      const m = new Map(); for (const v of vals) { const k = v === true ? 'Yes' : v === false ? 'No' : String(v); m.set(k, (m.get(k) || 0) + 1); }
      // A choice has a handful of values. A field with a different value on almost every call is text, whatever its type says.
      if (m.size > 12 || (m.size > 6 && m.size > vals.length / 2)) continue;
      const values = [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
      out.push({ key: d.key, label: d.label, type: 'choice', unit: d.unit, answered: vals.length, values });
    }
  }
  return out;
}
export const fieldLabel = (k) => { const s = String(k).replace(/_\d+$/, '').replace(/_/g, ' ').trim(); return s ? s[0].toUpperCase() + s.slice(1) : s; };

/**
 * Input checks from the field type, never from the use case. rows: [{ values, rejected }] of one upload;
 * fields: [{ key, type }] with type text, number, date, phone or choice. Returns the problems found with row counts.
 */
export function checkInput(uploads, fieldsOf) {
  const problems = new Map(); let total = 0, rejected = 0, warned = 0;
  const hit = (set, label, field, kind, i) => { const k = `${kind}|${label}|${field}`; if (!problems.has(k)) problems.set(k, { label, field, kind, rows: 0 }); problems.get(k).rows++; set.add(i); };
  const dateShape = (v) => { const m = /^(\d{1,4})[/-](\d{1,2})[/-](\d{1,4})$/.exec(String(v).trim()); if (!m) return null; const [a, b] = [Number(m[1]), Number(m[2])]; return m[1].length === 4 ? 'year first' : b > 12 ? 'month first' : a > 12 ? 'day first' : 'either'; };
  for (const up of uploads) {
    const rows = up.rows; const fields = fieldsOf(up); const bad = new Set(); const warn = new Set(); total += rows.length;
    rows.forEach((r, i) => { if (r.rejected) hit(bad, r.rejected, '', 'reject', i); });
    for (const f of fields) {
      const vals = rows.map((r) => (r.values?.[f.key] === undefined || r.values[f.key] === null ? '' : String(r.values[f.key]).trim()));
      const filled = vals.filter(Boolean); if (!filled.length) continue;
      if (f.type === 'date') {
        const shapes = vals.map((v) => (v ? dateShape(v) : 'blank')); const sure = shapes.filter((s) => s === 'month first' || s === 'day first');
        const main = sure.filter((s) => s === 'day first').length >= sure.filter((s) => s === 'month first').length ? 'day first' : 'month first';
        shapes.forEach((s, i) => { if (rows[i].rejected || s === 'blank') return; if (s === null) hit(warn, 'Not a date', f.key, 'warn', i); else if ((s === 'month first' || s === 'day first') && s !== main) hit(warn, `Date written ${s}; the rest of the file is ${main}`, f.key, 'warn', i); });
      } else if (f.type === 'number') {
        vals.forEach((v, i) => { if (v && !rows[i].rejected && isNaN(Number(v.replace(/,/g, '')))) hit(warn, 'Not a number', f.key, 'warn', i); });
      } else if (f.type !== 'phone') {
        const count = new Map(); filled.forEach((v) => count.set(v, (count.get(v) || 0) + 1));
        // A column whose values normally repeat: a value seen once is probably in the wrong column or misspelt.
        const repeating = [...count.values()].filter((n) => n >= 3).reduce((a, b) => a + b, 0);
        if (count.size <= 12 && repeating / filled.length >= 0.7) vals.forEach((v, i) => { if (v && !rows[i].rejected && count.get(v) === 1) hit(warn, 'One off value in a column that normally repeats', f.key, 'warn', i); });
        const lens = filled.map((v) => v.length).sort((a, b) => a - b); const med = lens[Math.floor(lens.length / 2)];
        if (med >= 16) vals.forEach((v, i) => { if (v && !rows[i].rejected && v.length < med / 4) hit(warn, 'Much shorter than the rest of the column', f.key, 'warn', i); });
      }
    }
    const seen = new Map(); rows.forEach((r, i) => { if (r.rejected || !r.contact) return; if (seen.has(r.contact) && !up.grouped) hit(warn, 'Same contact on more than one row', '', 'warn', i); else seen.set(r.contact, i); });
    rejected += bad.size; warned += [...warn].filter((i) => !bad.has(i)).length;
  }
  return { rows: total, rejected, warned, clean: total - rejected - warned, problems: [...problems.values()].sort((a, b) => (a.kind === b.kind ? b.rows - a.rows : a.kind === 'reject' ? -1 : 1)) };
}
/** Why a picked up call did not finish: one fixed list for every agent. */
export const WHY = { call_later: 'Asked to call later', wrong_person: 'Wrong person', no_trust: 'Did not trust the call', cannot_hear: 'Could not hear', machine: 'Machine answered', hung_up: 'Hung up early', silent: 'Picked up and stayed silent' };
const pick = (seed, list) => { let h = 0; for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return list[h % list.length]; };
/** outcome: Echo's call status word. The agent records the reason on the call; the mock derives one from the status. */
export function whyOf(outcome, seed, callbackAsked) {
  if (callbackAsked) return 'call_later';
  if (outcome === 'voicemail') return 'machine';
  if (outcome === 'no_reply') return 'silent';
  if (outcome === 'call_dropped') return 'cannot_hear';
  if (outcome === 'caller_hung_up') return pick(seed, ['hung_up', 'hung_up', 'no_trust', 'wrong_person', 'call_later']);
  return null;
}
const fieldType = (t) => (/number|integer|decimal/i.test(t) ? 'number' : /date/i.test(t) ? 'date' : /phone/i.test(t) ? 'phone' : /enum|choice/i.test(t) ? 'choice' : 'text');

export function registerReports({ on, ok, fail, file, executions, sheets, templates, owners, nowIso, redial, me }) {
  const inWindow = (q) => {
    const from = Date.now() - Number(q.get('days') || 30) * 86400000;
    return executions.filter((e) => Date.parse(e.createdAt) >= from && (!q.get('batchId') || e.batchId === q.get('batchId')) && (!q.get('agent') || e.templateId === q.get('agent')));
  };
  const lastDial = (e) => (e.attemptLog || []).slice(-1)[0];
  const dayOf = (e) => (lastDial(e)?.startedAt || e.batchSubmittedAt || e.createdAt).slice(0, 10);
  const groupOf = (e) => e.outcomeGroup || (e.status === 'COMPLETED' ? 'reached' : e.status === 'IN_PROGRESS' ? 'in_progress' : e.status === 'STOPPED' || e.status === 'CANCELLED' ? 'not_dialled' : 'not_reached');
  const blank = () => ({ contacts: 0, dialled: 0, reached: 0, completed: 0, not_reached: 0, failed: 0, in_progress: 0, not_dialled: 0, follow_up: 0, talk_seconds: 0 });
  const add = (m, e) => {
    const g = groupOf(e);
    m.contacts++; if ((e.attemptLog || []).length || ['reached', 'not_reached', 'failed'].includes(g)) m.dialled++;
    if (g === 'reached') m.reached++; if (e.outcome === 'completed' || (!e.outcome && e.status === 'COMPLETED')) m.completed++;
    if (g === 'not_reached') m.not_reached++; if (g === 'failed') m.failed++; if (g === 'in_progress') m.in_progress++; if (g === 'not_dialled') m.not_dialled++;
    if (reasonFor(e, add.never || new Set()) && e.followUp?.state !== 'done') m.follow_up++;
    m.talk_seconds += (e.attemptLog || []).reduce((n, a) => n + (a.talkSeconds || 0), 0);
    return m;
  };
  const SKIP = new Set(['contact_name', 'contact_phone', 'contact_email']);
  const columnsOf = (list) => {
    const seen = {};
    for (const e of list) for (const [k, v] of Object.entries(e.context || {})) { if (SKIP.has(k) || v == null || typeof v === 'object') continue; (seen[k] ||= new Set()).add(String(v)); }
    // Names, not numbers, dates, ids or long text: a value must repeat and read like a label.
    const label = (v) => v.length <= 40 && !/^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}/.test(v) && (v.replace(/\D/g, '').length / Math.max(v.length, 1)) < 0.4;
    return Object.entries(seen).filter(([, s]) => s.size >= 2 && s.size <= 8 && list.length / s.size >= 6 && [...s].every(label)).map(([key, s]) => ({ key, label: key.replace(/_/g, ' '), values: [...s].sort() }));
  };
  const sheetName = (id) => { const s = sheets.find((x) => x.id === id); return s ? (s.originalFilename || s.templateName || id) : id; };
  const agentName = (id) => templates.find((t) => t.id === id)?.name || id;
  /** Answer fields of one agent setup: the fields its builder marked to show on dashboards. */
  const answersOf = (templateId, list) => {
    const t = templates.find((x) => x.id === templateId); if (!t) return [];
    // A number field is added up; a field its builder marked for dashboards (choices, yes or no) is counted per value.
    const kind = (f) => (/number|integer|decimal/i.test(f.dataType) ? 'number' : f.showOnDashboard ? 'choice' : null);
    const defs = (t.requiredFields || []).filter(kind).map((f) => ({ key: f.fieldKey, label: f.fieldLabel && f.fieldLabel !== f.fieldKey ? f.fieldLabel : fieldLabel(f.fieldKey), type: kind(f), unit: 'calls' }));
    const records = list.map((e) => e.extractedFields).filter((x) => x && Object.keys(x).length);
    return summariseAnswers(defs, () => records);
  };
  const reachedPhones = () => new Set(executions.filter((e) => groupOf(e) === 'reached').map((e) => e.resolvedContact?.phone));
  const neverReached = () => { const days = new Map(); const ok = reachedPhones();
    for (const e of executions) { const p = e.resolvedContact?.phone; if (!p || !(e.attemptLog || []).length || groupOf(e) === 'reached') continue; (days.get(p) || days.set(p, new Set()).get(p)).add(dayOf(e)); }
    return new Set([...days].filter(([p, d]) => d.size >= 2 && !ok.has(p)).map(([p]) => p)); };
  const reasonFor = (e, never) => followReason(e) || (never.has(e.resolvedContact?.phone) && groupOf(e) === 'not_reached' ? 'never_reached' : null);
  const inputOf = (list) => { const by = new Map(); for (const e of list) (by.get(e.batchId) || by.set(e.batchId, []).get(e.batchId)).push(e);
    const ups = [...by].map(([id, rows]) => { const s = sheets.find((x) => x.id === id); const t = templates.find((x) => x.id === rows[0].templateId);
      return { t, grouped: false, rows: [...rows.map((e) => ({ values: e.context || {}, rejected: null, contact: e.resolvedContact?.phone })), ...(s?.failedRows || []).map((f) => ({ values: {}, rejected: f.reason || 'Failed the upload check', contact: '' }))] }; });
    return checkInput(ups, (up) => (up.t?.contextMappings || []).map((m) => ({ key: m.fieldName, type: fieldType(m.dataType) }))); };
  const whyFor = (list) => { const m = {}; let base = 0;
    for (const e of list) { if (groupOf(e) !== 'reached' || e.outcome === 'completed' || !e.outcome) continue; base++; const k = whyOf(e.outcome, e.id, !!(e.extractedFields?.callback_time || e.extractedFields?.callback_date)); if (k) m[k] = (m[k] || 0) + 1; }
    return { base, reasons: Object.entries(m).map(([key, count]) => ({ key, label: WHY[key], count })).sort((a, b) => b.count - a.count) }; };
  function summary(q) {
    const list = inWindow(q); const by = q.get('by') || 'agent'; const only = q.get('value') || '';
    const keyOf = (e) => by === 'campaign' ? [e.batchId, sheetName(e.batchId)] : by === 'agent' ? [e.templateId, agentName(e.templateId)] : by === 'day' ? [dayOf(e), dayOf(e)] : [String(e.context?.[by] ?? ''), String(e.context?.[by] ?? '') || 'Not given'];
    add.never = neverReached();
    const groups = new Map(); const days = new Map(); const total = blank(); const outcomes = {};
    for (const e of list) {
      const [k, label] = keyOf(e); if (only && k !== only) continue;
      if (!groups.has(k)) groups.set(k, { key: k, label, ...blank() }); add(groups.get(k), e); add(total, e);
      const d = dayOf(e); if (!days.has(d)) days.set(d, { day: d, ...blank() }); add(days.get(d), e);
      const o = e.outcome || (e.status === 'COMPLETED' ? 'completed' : e.status === 'IN_PROGRESS' ? 'waiting' : 'no_answer'); outcomes[o] = (outcomes[o] || 0) + 1;
    }
    const rows = [...groups.values()].sort((a, b) => by === 'day' ? b.key.localeCompare(a.key) : b.dialled - a.dialled || a.label.localeCompare(b.label));
    return { by, days: Number(q.get('days') || 30), generated_at: nowIso(), total, rows, trend: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
      by_outcome: Object.entries(outcomes).map(([key, count]) => ({ key, label: OUTCOMES[key]?.label || key, group: OUTCOMES[key]?.group || 'failed', count })).sort((a, b) => b.count - a.count),
      columns: columnsOf(list), campaigns: new Set(list.map((e) => e.batchId)).size,
      input: inputOf(only ? [] : list), why: whyFor(list), rows_line: null,
      agent: q.get('agent') || '', agents: [...new Set(executions.map((e) => e.templateId))].map((key) => ({ key, label: agentName(key) })).sort((a, b) => a.label.localeCompare(b.label)), answers: q.get('agent') ? answersOf(q.get('agent'), list) : [], active_calls: list.filter((e) => e.outcome === 'calling' || e.outcome === 'on_call').length };
  }
  on('GET', '/api/v1/reports/summary', ({ q }) => ok(summary(q)));

  // ── Follow ups ────────────────────────────────────────────────────────────
  function followRows() {
    const out = []; const never = neverReached();
    for (const e of executions) {
      const reason = reasonFor(e, never); if (!reason && !e.followUp) continue;
      const f = e.followUp || {}; const last = lastDial(e);
      out.push({ id: e.id, batchId: e.batchId, templateId: e.templateId, campaign_name: sheetName(e.batchId), agent: agentName(e.templateId), name: e.resolvedContact?.name || e.name, phone: e.resolvedContact?.phone || '',
        reason: f.reason || reason, reason_label: FOLLOW_REASONS[f.reason || reason]?.label || '', status: OUTCOMES[e.outcome]?.label || '', dials: (e.attemptLog || []).length,
        since: last?.startedAt || e.completedAt || e.createdAt, telephony: last?.provider ? { Status: last.provider.Status, CustomerStatus: last.provider.CustomerStatus, DialStatus: last.provider.DialStatus } : null,
        state: f.state || 'open', owner: f.owner || '', notes: f.notes || [], closed_as: f.closed_as || '', old_phone: f.old_phone || '', context: e.context || {} });
    }
    return out.sort((a, b) => Date.parse(b.since) - Date.parse(a.since));
  }
  on('GET', '/api/v1/follow-ups', ({ q }) => {
    const all = followRows(); const open = all.filter((r) => r.state === 'open'); const want = q.get('state') || 'open';
    ok({ rows: all.filter((r) => r.state === want), counts: { open: open.length, done: all.length - open.length, by_reason: open.reduce((m, r) => { m[r.reason] = (m[r.reason] || 0) + 1; return m; }, {}) }, reasons: FOLLOW_REASONS, owners });
  });
  const find = (id) => executions.find((e) => e.id === id);
  on('PATCH', '/api/v1/follow-ups/:id', ({ p, body }) => {
    const e = find(p.id); if (!e) return fail(404, 'Row not found');
    const f = (e.followUp ||= { state: 'open', reason: followReason(e), notes: [] }); f.notes ||= [];
    if ('owner' in body) f.owner = String(body.owner || '');
    if (body.note) f.notes.push({ text: String(body.note).slice(0, 500), by: me(), at: nowIso() });
    if (body.phone && String(body.phone) !== e.resolvedContact.phone) { f.old_phone = e.resolvedContact.phone; e.resolvedContact.phone = String(body.phone).replace(/\D/g, '').slice(-10); e.context.contact_phone = e.resolvedContact.phone; f.notes.push({ text: `Number changed from ${f.old_phone} to ${e.resolvedContact.phone}`, by: me(), at: nowIso(), system: true }); }
    if (body.state === 'done') Object.assign(f, { state: 'done', closed_as: body.closed_as || 'No call needed', closed_at: nowIso() });
    if (body.state === 'open') Object.assign(f, { state: 'open', closed_as: '' });
    ok({ ok: true });
  });
  on('POST', '/api/v1/follow-ups/:id/call-again', ({ p }) => {
    const e = find(p.id); if (!e) return fail(404, 'Row not found');
    const f = (e.followUp ||= { state: 'open', reason: followReason(e), notes: [] }); f.notes ||= [];
    f.notes.push({ text: 'Sent back to the agent to call again', by: me(), at: nowIso(), system: true });
    Object.assign(f, { state: 'done', closed_as: 'Called again', closed_at: nowIso() });
    redial(e); ok({ ok: true });
  });

  // ── Report schedules ──────────────────────────────────────────────────────
  const schedules = [
    { id: 'rs_daily', name: 'End of day calling report', every: 'day', weekdays: [1, 2, 3, 4, 5], time: '18:30', days: 1, by: 'campaign', value: '', recipients: ['ops.lead@example.com', 'scm.head@example.com'], formats: ['image', 'excel'], include_follow_ups: true, on: true, last_sent_at: new Date(Date.now() - 18 * 3600000).toISOString(), created_by: 'admin@example.com' },
    { id: 'rs_weekly', name: 'Weekly summary', every: 'week', weekdays: [1], time: '08:30', days: 7, by: 'agent', value: '', recipients: ['business.head@example.com'], formats: ['pdf', 'excel'], include_follow_ups: false, on: true, last_sent_at: null, created_by: 'admin@example.com' },
  ];
  const clean = (b, old = {}) => ({
    name: String(b.name ?? old.name ?? '').trim().slice(0, 80), every: b.every === 'week' ? 'week' : b.every === 'day' ? 'day' : old.every || 'day',
    weekdays: Array.isArray(b.weekdays) ? b.weekdays.map(Number).filter((n) => n >= 0 && n <= 6) : old.weekdays || [1, 2, 3, 4, 5],
    time: /^\d{2}:\d{2}$/.test(b.time || '') ? b.time : old.time || '18:30', days: [1, 7, 30].includes(Number(b.days)) ? Number(b.days) : old.days || 1,
    by: String(b.by ?? old.by ?? 'agent'), value: String(b.value ?? old.value ?? ''), agent: String(b.agent ?? old.agent ?? ''),
    recipients: (Array.isArray(b.recipients) ? b.recipients : old.recipients || []).map((e) => String(e).trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)).slice(0, 25),
    formats: (Array.isArray(b.formats) ? b.formats : old.formats || ['image']).filter((f) => ['image', 'pdf', 'excel'].includes(f)),
    include_follow_ups: 'include_follow_ups' in b ? !!b.include_follow_ups : old.include_follow_ups ?? true, on: 'on' in b ? !!b.on : old.on ?? true,
  });
  const check = (s) => !s.name ? 'Give the report a name' : !s.recipients.length ? 'Add at least one email address' : !s.formats.length ? 'Pick at least one format' : !s.weekdays.length ? 'Pick at least one day' : '';
  on('GET', '/api/v1/report-schedules', () => ok(schedules));
  on('POST', '/api/v1/report-schedules', ({ body }) => { const s = clean(body); const err = check(s); if (err) return fail(400, err); const made = { id: `rs_${randomBytes(4).toString('hex')}`, ...s, last_sent_at: null, created_by: me() }; schedules.push(made); ok(made); });
  on('PATCH', '/api/v1/report-schedules/:id', ({ p, body }) => { const s = schedules.find((x) => x.id === p.id); if (!s) return fail(404, 'Report not found'); const next = clean(body, s); const err = check(next); if (err) return fail(400, err); Object.assign(s, next); ok(s); });
  on('DELETE', '/api/v1/report-schedules/:id', ({ p }) => { const i = schedules.findIndex((x) => x.id === p.id); if (i >= 0) schedules.splice(i, 1); ok({}); });
  on('POST', '/api/v1/report-schedules/:id/send-now', ({ p }) => { const s = schedules.find((x) => x.id === p.id); if (!s) return fail(404, 'Report not found'); s.last_sent_at = nowIso(); ok({ sent_to: s.recipients, at: s.last_sent_at }); });

  // ── Spreadsheet: one workbook, five tabs ──────────────────────────────────
  on('GET', '/api/v1/reports/export.xlsx', ({ q }) => {
    const s = summary(q); const list = inWindow(q); const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
    const cols = ['Contacts', 'Dialled', 'Reached', 'Reached %', 'Completed', 'Completed %', 'Not reached', 'Failed', 'In progress', 'Needs follow up', 'Talk minutes'];
    const line = (m) => [m.contacts, m.dialled, m.reached, pct(m.reached, m.dialled), m.completed, pct(m.completed, m.reached), m.not_reached, m.failed, m.in_progress, m.follow_up, Math.round(m.talk_seconds / 60)];
    const byLabel = s.by === 'campaign' ? 'Campaign' : s.by === 'agent' ? 'Agent' : s.by === 'day' ? 'Day' : s.by.replace(/_/g, ' ');
    const follow = followRows().filter((r) => r.state === 'open');
    file(writeWorkbook([
      { name: 'Summary', rows: [['Period', `Last ${s.days} day${s.days === 1 ? '' : 's'}`], ['Made at', s.generated_at], ['Campaigns', s.campaigns], ...cols.map((c, i) => [c, line(s.total)[i]]), [], ['Call status', 'Contacts'], ...s.by_outcome.map((o) => [o.label, o.count])] },
      { name: `By ${byLabel}`.slice(0, 31), rows: [[byLabel, ...cols], ...s.rows.map((r) => [r.label, ...line(r)])] },
      { name: 'By day', rows: [['Day', ...cols], ...s.trend.map((r) => [r.day, ...line(r)])] },
      ...(s.answers.length ? [{ name: 'Answers', rows: [['Answer', 'Value', 'Count', 'Out of'], ...s.answers.flatMap((a) => a.type === 'number' ? [[a.label, 'Total', a.sum, a.answered], [a.label, 'Average', a.avg, a.answered]] : a.values.map((v) => [a.label, v.value, v.count, a.answered]))] }] : []),
      { name: 'Input problems', rows: [['Problem', 'Field', 'Rows', 'Result'], ...s.input.problems.map((p) => [p.label, p.field, p.rows, p.kind === 'reject' ? 'Rejected' : 'Warning'])] },
      ...(s.why.reasons.length ? [{ name: 'Why not finished', rows: [['Reason', 'Calls'], ...s.why.reasons.map((r) => [r.label, r.count])] }] : []),
      { name: 'Needs follow up', rows: [['Contact', 'Number', 'Campaign', 'Why', 'Dials', 'Since', 'Owner', 'Last note'], ...follow.map((r) => [r.name || '', r.phone, r.campaign_name, r.reason_label, r.dials, r.since, r.owner, r.notes.filter((n) => !n.system).slice(-1)[0]?.text || ''])] },
      { name: 'All contacts', rows: [['Campaign', 'Agent', 'Contact', 'Number', 'Call status', 'Group', 'Dials', 'Last dial at', 'Talk seconds', 'Telephony status', 'Telephony customer status', 'Telephony dial status', 'Row id'],
        ...list.map((e) => { const last = lastDial(e); return [sheetName(e.batchId), agentName(e.templateId), e.resolvedContact?.name || '', e.resolvedContact?.phone || '', OUTCOMES[e.outcome]?.label || e.status, groupOf(e), (e.attemptLog || []).length, last?.startedAt || '', last?.talkSeconds || 0, last?.provider?.Status || '', last?.provider?.CustomerStatus || '', last?.provider?.DialStatus || '', e.id]; })] },
    ]), XLSX, `calling-report-${new Date().toISOString().slice(0, 10)}.xlsx`);
  });
}
