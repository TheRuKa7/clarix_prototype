// Wave 1 (same file in Echo and Clarix): the workspace do-not-call list, alerts that pause campaigns, each agent's
// call handling (answer guardrail, phone menus, speech), re-running answers on past calls, and call diagnostics.
// Demo data only: nothing is sent or dialled. See docs/Echo-Clarix-Persona-Competitor-Audit-2026-11-03.md, Wave 1.

const ten = (p) => String(p ?? '').replace(/\D/g, '').slice(-10);
const nowIso = () => new Date().toISOString();
/** A stable number from a string, for demo values that do not change between loads. */
const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

// ── Do-not-call list: one per workspace, used by every agent, upload and data source run ──
const dnc = new Map(); // phone (10 digits) -> { phone, name, reason, source: 'auto' | 'manual', at, by, call_id }
const dncRemoved = [];
export const dncSettings = { auto: true, phrases: ["don't call", 'do not call', 'stop calling', 'remove my number', 'never call'] };
const PHRASE = () => new RegExp(dncSettings.phrases.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
let seeded = false;
/** Adds people who asked not to be called (in a summary or an answer), once. The demo also seeds one example. */
export function dncScan(rows = []) {
  if (dncSettings.auto) {
    const re = PHRASE();
    for (const r of rows) {
      const text = [r.summary, ...Object.values(r.answers || {})].join(' ');
      const p = ten(r.phone); if (p.length === 10 && re.test(text) && !dnc.has(p)) dnc.set(p, { phone: p, name: r.caller_name || '', reason: 'Asked not to be called again on the call', source: 'auto', at: r.call_date || nowIso(), by: 'Echo', call_id: r.id });
    }
  }
  if (!seeded) {
    seeded = true;
    const ex = rows.find((r) => r.call_status === 'Answered' && /not given time|left before/i.test(r.status_reason || '') && ten(r.phone).length === 10);
    if (ex && !dnc.has(ten(ex.phone))) dnc.set(ten(ex.phone), { phone: ten(ex.phone), name: ex.caller_name || '', reason: 'Said: "Please don\'t call this number again"', source: 'auto', at: ex.call_date || nowIso(), by: 'Echo', call_id: ex.id });
    dnc.set('9876500011', { phone: '9876500011', name: 'Shree Balaji Traders', reason: 'Asked by email to stop calls (ticket 4182)', source: 'manual', at: '2026-10-28T06:30:00.000Z', by: 'ops.buyer1@example.com', call_id: null });
  }
}
export const onDnc = (phone) => dnc.get(ten(phone)) || null;
export function dncList(q = '') { const t = String(q).trim().toLowerCase(); return [...dnc.values()].filter((d) => !t || `${d.phone} ${d.name} ${d.reason}`.toLowerCase().includes(t)).sort((a, b) => String(b.at).localeCompare(String(a.at))); }
export function dncAdd({ phone, name = '', reason = '' } = {}, by = 'you') {
  const p = ten(phone); if (p.length !== 10) return { error: 'Enter a 10-digit number' };
  if (!String(reason).trim()) return { error: 'Say why this number should not be called' };
  const d = { phone: p, name: String(name).trim(), reason: String(reason).trim().slice(0, 200), source: 'manual', at: nowIso(), by, call_id: null }; dnc.set(p, d); return { ok: d };
}
export function dncRemove(phone, reason = '', by = 'you') {
  const p = ten(phone); const d = dnc.get(p); if (!d) return { error: 'That number is not on the list' };
  if (!String(reason).trim()) return { error: 'Say why calls are allowed again (for the audit trail)' };
  dnc.delete(p); dncRemoved.unshift({ ...d, removed_at: nowIso(), removed_by: by, removed_reason: String(reason).trim() }); return { ok: true };
}
export const dncView = (q) => ({ list: dncList(q), removed: dncRemoved.slice(0, 10), settings: dncSettings });

// ── Alerts: watch running campaigns; notify, and pause when a rule says so ──
export const ALERT_METRICS = [
  { key: 'failure_rate', label: 'Failure rate', unit: '%', dir: 'above', hint: 'Calls that did not connect (no answer, silent, system issue) among the last N dialled' },
  { key: 'connect_rate', label: 'Connect rate', unit: '%', dir: 'below', hint: 'Calls picked up among the last N dialled' },
  { key: 'system_issues', label: 'System issues', unit: 'calls', dir: 'above', hint: 'Calls lost to the line or our side among the last N dialled' },
  { key: 'credits', label: 'Credits left', unit: 'credits', dir: 'below', hint: 'The workspace balance' },
];
let alertRules = [
  { id: 'a1', on: true, metric: 'failure_rate', threshold: 50, window: 20, action: 'pause', channels: ['email', 'slack'] },
  { id: 'a2', on: true, metric: 'connect_rate', threshold: 30, window: 20, action: 'notify', channels: ['email'] },
  { id: 'a3', on: true, metric: 'credits', threshold: 2000, window: 0, action: 'pause', channels: ['email', 'slack'] },
];
export const CREDITS = { balance: 12400 };
const paused = new Map(); // campaign_id -> { reason, at, rule_id }
const live = new Map(); // campaign_id -> the running campaign's numbers now, over its last 20 dialled calls
const resumed = new Map(); // campaign_id -> rows dialled when resumed (a rule re-trips only on new calls)
const events = [];
const DIALLED = (r) => r.call_status && !['Bad data', 'Internal test call', 'In progress', 'Not planned'].includes(r.call_status);
function metricOf(rule, rows) {
  if (rule.metric === 'credits') return CREDITS.balance;
  const last = rows.filter(DIALLED).sort((a, b) => String(b.call_date).localeCompare(String(a.call_date))).slice(0, rule.window || 20);
  if (last.length < Math.min(5, rule.window || 20)) return null;
  const n = (f) => last.filter(f).length;
  if (rule.metric === 'failure_rate') return Math.round((100 * n((r) => ['Not picked', 'No reply', 'System issue'].includes(r.call_status))) / last.length);
  if (rule.metric === 'connect_rate') return Math.round((100 * n((r) => r.call_status === 'Answered')) / last.length);
  if (rule.metric === 'system_issues') return n((r) => r.call_status === 'System issue');
  return null;
}
const breached = (rule, v) => v != null && ((ALERT_METRICS.find((m) => m.key === rule.metric)?.dir === 'below') ? v < rule.threshold : v > rule.threshold);
const said = (rule, v) => { const m = ALERT_METRICS.find((x) => x.key === rule.metric); return `${m.label} ${v}${m.unit === '%' ? '%' : ' ' + m.unit} ${m.dir === 'below' ? 'below' : 'above'} ${rule.threshold}${m.unit === '%' ? '%' : ''}${rule.window && rule.metric !== 'credits' ? ` over the last ${rule.window} calls` : ''}`; };
/** byCampaign: Map(id -> { name, rows, running }). Updates paused campaigns and the event log; returns nothing. */
export function checkAlerts(byCampaign) {
  for (const [id, c] of byCampaign) {
    if (c.running) live.set(id, { campaign_id: id, campaign: c.name, dialled: c.rows.filter(DIALLED).length, ...Object.fromEntries(['failure_rate', 'connect_rate', 'system_issues'].map((k) => [k, metricOf({ metric: k, window: 20 }, c.rows)])) });
    else live.delete(id);
    if (!c.running || paused.has(id)) continue;
    const dialled = c.rows.filter(DIALLED).length; if (resumed.has(id) && dialled <= resumed.get(id)) continue;
    for (const rule of alertRules.filter((r) => r.on)) {
      const v = metricOf(rule, c.rows); if (!breached(rule, v)) continue;
      const key = `${id}:${rule.id}`; if (events.some((e) => e.key === key && !e.cleared)) continue;
      const msg = said(rule, v);
      events.unshift({ key, at: nowIso(), campaign_id: id, campaign: c.name, rule_id: rule.id, message: msg, action: rule.action === 'pause' ? 'Paused the campaign and told the owner' : 'Told the owner', channels: rule.channels, cleared: false });
      if (rule.action === 'pause') { paused.set(id, { reason: msg, at: nowIso(), rule_id: rule.id }); break; }
    }
  }
}
export const pausedOf = (id) => paused.get(id) || null;
export function resumeCampaign(id, dialledNow = 0) { const p = paused.get(id); if (!p) return false; paused.delete(id); resumed.set(id, dialledNow); for (const e of events) if (e.campaign_id === id) e.cleared = true; return true; }
export const alertsView = () => ({ rules: alertRules, metrics: ALERT_METRICS, events: events.slice(0, 20), credits: CREDITS.balance, live: [...live.values()], paused: [...paused.entries()].map(([id, p]) => ({ campaign_id: id, ...p })) });
export function saveAlerts(list = []) {
  const ok = new Set(ALERT_METRICS.map((m) => m.key));
  alertRules = (Array.isArray(list) ? list : []).filter((r) => ok.has(r.metric)).slice(0, 12).map((r, i) => ({
    id: String(r.id || `a${Date.now()}${i}`), on: r.on !== false, metric: r.metric, threshold: Math.max(0, Number(r.threshold) || 0), window: r.metric === 'credits' ? 0 : Math.min(200, Math.max(10, Number(r.window) || 20)),
    action: r.action === 'pause' ? 'pause' : 'notify', channels: (r.channels || []).filter((c) => ['email', 'slack'].includes(c)),
  }));
  return alertsView();
}

// ── Call handling per agent: answer guardrail, phone menus (IVR), speech ──
const handling = new Map();
export const defaultHandling = () => ({
  guardrail: { on: true, min_seconds: 5, need_speech: true },
  ivr: { on: true, action: 'press', hint: 'Purchase or accounts', digits: '', wait_seconds: 20 },
  memory: { on: true, days: 30 },
  speech: { boost: ['Moglix', 'PO', 'GRN', '{{plant_name}}', '{{contact_name}}'], pronounce: [{ word: 'Moglix', say: 'Mog-lix' }, { word: 'PO', say: 'P O' }, { word: 'GRN', say: 'G R N' }, { word: 'Hindustan Zinc', say: 'Hin-doo-staan Zinc' }] },
});
export const handlingOf = (agent) => ({ ...defaultHandling(), ...(handling.get(agent) || {}) });
export function saveHandling(agent, b = {}) {
  const d = defaultHandling(); const g = b.guardrail || d.guardrail; const v = b.ivr || d.ivr; const s = b.speech || d.speech; const m = b.memory || d.memory;
  const h = {
    guardrail: { on: g.on !== false, min_seconds: Math.min(60, Math.max(1, Number(g.min_seconds) || 5)), need_speech: g.need_speech !== false },
    ivr: { on: v.on !== false, action: ['press', 'wait', 'hangup'].includes(v.action) ? v.action : 'press', hint: String(v.hint || '').slice(0, 80), digits: String(v.digits || '').replace(/[^0-9*#,]/g, '').slice(0, 12), wait_seconds: Math.min(90, Math.max(5, Number(v.wait_seconds) || 20)) },
    memory: { on: m.on !== false, days: Math.min(365, Math.max(1, Number(m.days) || 30)) },
    speech: { boost: [...new Set((s.boost || []).map((w) => String(w).trim()).filter(Boolean))].slice(0, 100), pronounce: (s.pronounce || []).filter((p) => String(p.word || '').trim() && String(p.say || '').trim()).slice(0, 100).map((p) => ({ word: String(p.word).trim(), say: String(p.say).trim() })) },
  };
  handling.set(agent, h); return h;
}

// ── Answer guardrail and re-running answers on past calls ──
const reran = new Map(); // row id -> { at, result }
const talk = (r) => Number(r.duration_seconds) || 0;
const hasAnswers = (r) => Object.values(r.answers || {}).some((v) => String(v ?? '').trim());
/** What a re-run would do to each row under its agent's guardrail; records it. rows are the calls in view. */
export function rerunAnswers(rows = [], by = 'you') {
  const out = { total: rows.length, filled: 0, cleared: 0, unchanged: 0, skipped_not_connected: 0, examples: [] };
  for (const r of rows) {
    const g = handlingOf(r.agent_key || r.agent).guardrail; let result;
    if (r.call_status !== 'Answered') { result = 'skipped'; out.skipped_not_connected++; }
    else if (g.on && talk(r) < g.min_seconds) { result = hasAnswers(r) ? 'cleared' : 'unchanged'; if (result === 'cleared') out.cleared++; else out.unchanged++; }
    else if (!hasAnswers(r)) { result = 'filled'; out.filled++; }
    else { result = 'unchanged'; out.unchanged++; }
    reran.set(r.id, { at: nowIso(), by, result });
    if (result === 'filled' || result === 'cleared') out.examples.length < 5 && out.examples.push({ id: r.id, caller: r.caller_name || r.phone, result, seconds: talk(r) });
  }
  return out;
}
export const rerunOf = (id) => reran.get(id) || null;

// ── Diagnostics for one call: dials, per-turn latency, tool calls, phone menu, why it ended ──
export function diagnosticsOf(d) {
  if (!d) return null;
  const h = hash(d.id); const hd = handlingOf(d.agent_key || d.agent); const answered = d.call_status === 'Answered';
  const turns = (d.transcript || []).filter((t) => /agent|bot|assistant/i.test(t.who)).slice(0, 12).map((t, i) => {
    const s = hash(d.id + i); const listen = 110 + (s % 170), think = 280 + ((s >>> 5) % 720), speak = 140 + ((s >>> 11) % 210);
    return { n: i + 1, text: String(t.text || '').slice(0, 90), listen_ms: listen, think_ms: think, speak_ms: speak, total_ms: listen + think + speak, interrupted: (s >>> 3) % 9 === 0 };
  });
  const tot = turns.map((t) => t.total_ms).sort((a, b) => a - b); const pct = (p) => (tot.length ? tot[Math.min(tot.length - 1, Math.floor((p / 100) * tot.length))] : null);
  const po = (d.inputs || []).find((i) => /po_number|po_numbers/.test(i.key))?.value?.split(',')[0]?.trim();
  const tools = answered ? [
    { name: 'lookup_po', at: '0:04', args: { po_number: po || '—' }, status: 200, ms: 140 + (h % 220), result: po ? `PO ${po}: open, 2 lines` : 'no PO in the row' },
    ...(hasAnswers({ answers: Object.fromEntries((d.answers || []).map((a) => [a.key, a.value])) }) ? [{ name: 'save_answers', at: 'end', args: Object.fromEntries((d.answers || []).filter((a) => a.value).slice(0, 4).map((a) => [a.key, a.value])), status: 200, ms: 60 + (h % 90), result: 'Saved' }] : []),
  ] : [];
  const ivr = answered && hd.ivr.on && h % 4 === 0 ? { at: '0:03', detected: 'Phone menu: "Press 1 for sales, 2 for purchase, 3 for accounts"', action: hd.ivr.action === 'press' ? `Pressed ${hd.ivr.digits || '2'} (${hd.ivr.hint || 'purchase'})` : hd.ivr.action === 'wait' ? 'Waited for a person' : 'Hung up', after_ms: 2400 + (h % 1800) } : null;
  const ended = {
    'Not picked': ['no_answer', 'Rang out with no answer'], 'No reply': ['silence_timeout', 'Line connected but nobody spoke for 10 s'], 'System issue': ['dial_failed', `Carrier error SIP ${[480, 503, 486][h % 3]}`],
    Voicemail: ['voicemail_reached', 'Answering machine detected'], DND: ['blocked', 'Number is on DND or blocked the caller ID'], Answered: [(h % 3) ? 'caller_hung_up' : 'agent_ended_call', (h % 3) ? 'The supplier hung up' : 'The agent closed the call after its goal'],
  }[d.call_status] || ['in_progress', 'Not finished yet'];
  const g = hd.guardrail; const secs = Number(d.duration_seconds) || 0;
  const guard = !answered ? 'No answers: the call did not connect' : g.on && secs < g.min_seconds ? `Answers not saved: call under ${g.min_seconds} s (answer guardrail)` : 'Answers saved';
  return {
    summary: { p50_ms: pct(50), p90_ms: pct(90), turns: turns.length, interruptions: turns.filter((t) => t.interrupted).length, slow_turns: turns.filter((t) => t.total_ms > 1200).length },
    turns, tools, ivr, ended: { code: ended[0], text: ended[1] }, guardrail: guard, rerun: rerunOf(d.id),
    dials: (d.dials || []).map((x) => ({ n: x.n, at: x.at, ring_seconds: x.ring_seconds, talk_seconds: x.talk_seconds, result: x.result, provider: x.provider, sip: x.result && /fail|issue|error/i.test(x.result) ? [480, 503, 486][hash(d.id + x.n) % 3] : 200 })),
    dnc: onDnc(d.phone),
  };
}
