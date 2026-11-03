// Wave 2 (same file in Echo and Clarix): quality checks on real calls (AI QA), persona tests before going live,
// prompt versions with a diff and an A/B split, and contact memory across calls. Demo data only: scores, test
// transcripts and memory are worked out from the mock calls, not from a model. See the persona audit doc, Wave 2.
import { onDnc } from './wave1.mjs';

const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const nowIso = () => new Date().toISOString();
const ten = (p) => String(p ?? '').replace(/\D/g, '').slice(-10);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }) : '—');
const mine = (rows, agent, label) => rows.filter((r) => r.agent_key === agent || (label && r.agent === label));

// ── Versions: draft and published prompts, a diff, and an A/B split ──
const PROMPT_V3 = [
  'You are Saniya from {{brand}}, calling {{contact_name}} about PO {{po_numbers}}.',
  "Greet in the supplier's language; switch to Hindi if they do.",
  'Ask whether each PO is accepted and the dispatch date for each line.',
  'If they are busy, ask for a callback time and end politely.',
  'Never promise payment dates or prices.',
].join('\n');
const PROMPT_V4 = [
  'You are Saniya from {{brand}}, calling {{contact_name}} about PO {{po_numbers}}.',
  'Say the PO number in your first sentence.',
  "Greet in the supplier's language; switch to Hindi if they do.",
  'Ask about every PO in {{po_numbers}} one at a time, and read back each dispatch date.',
  'If they are busy, ask for a callback time and end politely.',
  'If they say not to call again, confirm once and end the call.',
  'Never promise payment dates or prices.',
].join('\n');
const versions = new Map(); // agent -> { list: [...], split: { on, a, b, b_pct } }
function seedVersions(agent, by = 'ops.buyer1@example.com') {
  if (versions.has(agent)) return versions.get(agent);
  const v = {
    list: [
      { v: 2, status: 'old', at: '2026-10-20T06:00:00.000Z', by, note: 'First live version', prompt: PROMPT_V3.split('\n').slice(0, 3).join('\n'), settings: { preset: 'Balanced', voice: 'Saniya · Hindi-English', max_minutes: 6 }, fixes: [] },
      { v: 3, status: 'published', at: '2026-10-28T09:30:00.000Z', by, note: 'Callback and pricing rules', prompt: PROMPT_V3, settings: { preset: 'Balanced', voice: 'Saniya · Hindi-English', max_minutes: 6 }, fixes: [] },
      { v: 4, status: 'draft', at: '2026-11-02T11:15:00.000Z', by, note: 'Ask every PO, read back dates, honour "don\'t call"', prompt: PROMPT_V4, settings: { preset: 'Fast', voice: 'Saniya · Hindi-English', max_minutes: 6 }, fixes: ['all_pos', 'read_back', 'dnc'] },
    ],
    split: { on: false, a: 3, b: 4, b_pct: 20 },
  };
  versions.set(agent, v); return v;
}
/** Line diff (longest common subsequence): [{ type: 'same' | 'add' | 'del', text }]. */
export function diffLines(a = '', b = '') {
  const x = String(a).split('\n'), y = String(b).split('\n'); const m = x.length, n = y.length;
  const L = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < m && j < n) { if (x[i] === y[j]) { out.push({ type: 'same', text: x[i] }); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push({ type: 'del', text: x[i++] }); else out.push({ type: 'add', text: y[j++] }); }
  while (i < m) out.push({ type: 'del', text: x[i++] }); while (j < n) out.push({ type: 'add', text: y[j++] });
  return out;
}
const versionOfCall = (agent, id) => { const v = seedVersions(agent); const pub = v.list.find((x) => x.status === 'published'); if (!v.split.on) return pub; return hash('ab' + id) % 100 < v.split.b_pct ? v.list.find((x) => x.v === v.split.b) || pub : v.list.find((x) => x.v === v.split.a) || pub; };

// ── Quality (AI QA): sample answered calls and grade them on checks ──
export const BUILTIN_CHECKS = [
  { key: 'made_up', label: 'No made-up facts', hint: 'Said nothing that is not in the row or the call', rate: 6 },
  { key: 'all_pos', label: 'Asked about every PO', hint: 'Every PO in the row came up', rate: 18 },
  { key: 'read_back', label: 'Read back the dates', hint: 'Repeated each promised date to confirm it', rate: 22 },
  { key: 'interruptions', label: 'Did not talk over the supplier', hint: 'No overlapping speech', rate: 12 },
  { key: 'language', label: "Matched the supplier's language", hint: 'Switched to Hindi when the supplier did', rate: 5 },
  { key: 'polite_close', label: 'Closed politely', hint: 'Thanked and said what happens next', rate: 8 },
];
const qa = new Map(); // agent -> config
const defaultQa = () => ({ sample_pct: 40, min_seconds: 15, checks: BUILTIN_CHECKS.map((c) => ({ key: c.key, on: true })), custom: [{ id: 'c1', text: 'Asked for the dispatch date of each delayed line', on: true }] });
export const qaConfig = (agent) => qa.get(agent) || defaultQa();
export function saveQa(agent, b = {}) {
  const d = defaultQa();
  const cfg = { sample_pct: Math.min(100, Math.max(5, Number(b.sample_pct) || d.sample_pct)), min_seconds: Math.min(120, Math.max(0, Number(b.min_seconds) || 0)),
    checks: BUILTIN_CHECKS.map((c) => ({ key: c.key, on: (b.checks || []).find((x) => x.key === c.key)?.on !== false })),
    custom: (b.custom || []).filter((c) => String(c.text || '').trim()).slice(0, 10).map((c, i) => ({ id: String(c.id || `c${Date.now()}${i}`), text: String(c.text).trim().slice(0, 160), on: c.on !== false })) };
  qa.set(agent, cfg); return cfg;
}
function failText(key, r) {
  const pos = String(r.inputs?.po_numbers || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    made_up: 'Said a dispatch date the supplier never gave', all_pos: pos.length > 1 ? `Asked about ${pos.length - 1} of ${pos.length} POs (missed ${pos[pos.length - 1]})` : 'Never named the PO',
    read_back: 'Did not read back the promised date', interruptions: 'Talked over the supplier twice', language: 'Stayed in English after the supplier spoke Hindi', polite_close: 'Ended without saying what happens next',
  }[key] || 'Failed';
}
/** Grades one call on the agent's checks: [{ key, label, pass, why }]. A version that fixes a check halves its failures. */
function gradeCall(agent, r, cfg) {
  const ver = versionOfCall(agent, r.id); const out = [];
  for (const c of BUILTIN_CHECKS) {
    if (!cfg.checks.find((x) => x.key === c.key)?.on) continue;
    let rate = c.rate; if ((ver?.fixes || []).includes(c.key)) rate = Math.round(rate / 2); if (c.key === 'all_pos' && (Number(r.duration_seconds) || 0) < 40) rate += 15;
    const pass = hash(r.id + c.key) % 100 >= rate; out.push({ key: c.key, label: c.label, pass, why: pass ? '' : failText(c.key, r) });
  }
  for (const c of cfg.custom.filter((x) => x.on)) { const pass = hash(r.id + c.id) % 100 >= 15; out.push({ key: c.id, label: c.text, pass, why: pass ? '' : `Did not: ${c.text.toLowerCase()}` }); }
  return { version: ver?.v, checks: out };
}
export function qaScorecard(rows, agent, label) {
  const cfg = qaConfig(agent);
  const eligible = mine(rows, agent, label).filter((r) => r.call_status === 'Answered' && (Number(r.duration_seconds) || 0) >= cfg.min_seconds);
  let sampled = eligible.filter((r) => hash('qa' + r.id) % 100 < cfg.sample_pct); if (sampled.length < Math.min(3, eligible.length)) sampled = eligible.slice(0, 3);
  const graded = sampled.map((r) => { const g = gradeCall(agent, r, cfg); const passed = g.checks.filter((c) => c.pass).length; return { id: r.id, caller: r.caller_name || r.phone, phone: r.phone, date: r.call_date, version: g.version, score: g.checks.length ? Math.round((100 * passed) / g.checks.length) : 100, fails: g.checks.filter((c) => !c.pass) }; });
  const keys = [...BUILTIN_CHECKS.filter((c) => cfg.checks.find((x) => x.key === c.key)?.on).map((c) => ({ key: c.key, label: c.label, hint: c.hint })), ...cfg.custom.filter((c) => c.on).map((c) => ({ key: c.id, label: c.text, hint: 'Your own check' }))];
  const byCheck = keys.map((k) => { const fails = graded.filter((g) => g.fails.some((f) => f.key === k.key)).length; return { ...k, pass_rate: graded.length ? Math.round((100 * (graded.length - fails)) / graded.length) : null, fails }; });
  return { config: cfg, builtin: BUILTIN_CHECKS, eligible: eligible.length, sampled: graded.length, score: graded.length ? Math.round(graded.reduce((s, g) => s + g.score, 0) / graded.length) : null,
    by_check: byCheck, calls: graded.sort((a, b) => a.score - b.score).slice(0, 15) };
}

// ── Tests: persona simulations run against a version before it goes live ──
const PERSONAS = [
  { id: 'p1', name: 'Cooperative supplier', who: 'Accepts both POs, gives dispatch dates', expect: 'Success: Accepted', lang: 'en' },
  { id: 'p2', name: 'Busy, asks for a callback', who: '"I am driving, call me after 4"', expect: 'Success: Callback requested', lang: 'en' },
  { id: 'p3', name: 'Hinglish switcher', who: 'Starts in English, moves to Hindi halfway', expect: 'Success: Accepted', lang: 'hi' },
  { id: 'p4', name: 'Price dispute', who: 'Refuses until the price is revised', expect: 'Success: Follow-up required', lang: 'en' },
  { id: 'p5', name: 'Wrong number', who: '"No supplier here, wrong number"', expect: 'Wrong number', lang: 'en' },
  { id: 'p6', name: 'Says "don\'t call me"', who: 'Asks to stop the calls', expect: 'Not interested · added to do-not-call', lang: 'en' },
  { id: 'p7', name: 'Partial delivery', who: 'One PO delayed by a week, one on time', expect: 'Success: Partial', lang: 'en' },
  { id: 'p8', name: 'Interrupts a lot', who: 'Talks over the agent, short answers', expect: 'Success: Accepted', lang: 'en' },
];
const tests = new Map(); // agent -> { scenarios, runs: [] }
const testsOf = (agent) => tests.get(agent) || tests.set(agent, { scenarios: PERSONAS.map((p) => ({ ...p, source: 'persona' })), runs: [] }).get(agent);
const LINES = {
  p1: [['Agent', 'Hello, this is Saniya from Moglix about PO 5000101 and 5000102. Is this a good time?'], ['Supplier', 'Yes, tell me.'], ['Agent', 'Are both POs accepted, and when will they dispatch?'], ['Supplier', 'Both accepted. 101 goes on the 6th, 102 on the 8th.'], ['Agent', 'So 5000101 on 6 November and 5000102 on 8 November. Thank you, I will update the team.']],
  p2: [['Agent', 'Hello, Saniya from Moglix about PO 5000101.'], ['Supplier', 'I am driving, call me after 4.'], ['Agent', 'Of course. I will call you after 4 pm today. Drive safe.']],
  p3: [['Agent', 'Hello, Saniya from Moglix about PO 5000101.'], ['Supplier', 'Haan bolo, kya hua?'], ['Agent', 'Ji, kya PO accept ho gaya hai aur dispatch kab hoga?'], ['Supplier', 'Accept hai, Monday ko nikal jayega.'], ['Agent', 'Theek hai, Monday 9 November. Dhanyavaad!']],
  p4: [['Agent', 'Hello, Saniya from Moglix about PO 5000101.'], ['Supplier', 'The rate is old, I cannot supply at this price.'], ['Agent', 'I understand. I cannot change prices, but I will ask the buyer to call you about the rate today.']],
  p5: [['Agent', 'Hello, is this Mehta Fasteners?'], ['Supplier', 'No, wrong number.'], ['Agent', 'Sorry for the trouble. Have a good day.']],
  p6: [['Agent', 'Hello, Saniya from Moglix about PO 5000101.'], ['Supplier', "Please don't call this number again."], ['Agent', 'Understood, you will not get more calls from us. Thank you.']],
  p7: [['Agent', 'Hello, Saniya from Moglix about PO 5000101 and 5000102.'], ['Supplier', '101 is fine, 102 will be late by a week.'], ['Agent', 'So 5000101 on time, and 5000102 around 13 November. I will note the delay.']],
  p8: [['Agent', 'Hello, Saniya from—'], ['Supplier', 'Yes yes, PO? Accepted.'], ['Agent', 'Thank you. And the dispatch date?'], ['Supplier', 'Friday.'], ['Agent', 'Friday 6 November, noted.']],
};
/** Runs the chosen scenarios against a version. Pass/fail depends on the version's fixes, so a better draft scores better. */
export function runTests(agent, ids = [], version = null) {
  const t = testsOf(agent); const vs = seedVersions(agent); const ver = vs.list.find((x) => x.v === Number(version)) || vs.list.find((x) => x.status === 'published');
  const pick = t.scenarios.filter((s) => !ids.length || ids.includes(s.id));
  const results = pick.map((s) => {
    let pass = true, got = s.expect, why = '';
    if (s.id === 'p6' && !(ver.fixes || []).includes('dnc')) { pass = false; got = 'Not interested'; why = 'Kept explaining the PO after being asked to stop; the number was not added to the do-not-call list.'; }
    else if (s.id === 'p7' && !(ver.fixes || []).includes('read_back')) { pass = false; got = 'Success: Accepted'; why = 'Recorded both POs as on time; never read back the delayed date.'; }
    else if (s.id === 'p8' && hash(agent + ver.v) % 3 === 0) { pass = false; got = 'Success: Accepted'; why = 'Missed the dispatch date while being interrupted.'; }
    else if (s.source === 'call' && !(ver.fixes || []).includes('all_pos')) { pass = false; got = s.got_before || 'Same as the real call'; why = 'Same mistake as the real call.'; }
    const lines = LINES[s.id] || [['Agent', 'Hello, Saniya from Moglix about your PO.'], ['Supplier', s.who], ['Agent', 'Thank you, I will note that.']];
    return { id: s.id, name: s.name, expect: s.expect, got, pass, why, seconds: 20 + (hash(s.id + ver.v) % 70), transcript: lines.map(([who, text]) => ({ who, text })) };
  });
  const run = { at: nowIso(), version: ver.v, passed: results.filter((r) => r.pass).length, total: results.length, results };
  t.runs.unshift(run); t.runs = t.runs.slice(0, 5); return run;
}
/** New scenarios from real calls that failed quality checks: the same supplier situation, replayed. */
export function scenariosFromCalls(rows, agent, label) {
  const t = testsOf(agent); const sc = qaScorecard(rows, agent, label); let added = 0;
  for (const c of sc.calls.filter((x) => x.fails.length).slice(0, 3)) {
    const id = 'call-' + c.id; if (t.scenarios.some((s) => s.id === id)) continue;
    t.scenarios.push({ id, name: `From a real call: ${c.caller}`, who: c.fails.map((f) => f.why).join('; '), expect: 'Pass every quality check', lang: 'en', source: 'call', call_id: c.id, got_before: c.fails[0]?.why }); added++;
  }
  return { added, scenarios: t.scenarios };
}
export const testsView = (agent) => { const t = testsOf(agent); const vs = seedVersions(agent); return { scenarios: t.scenarios, last: t.runs[0] || null, runs: t.runs.map((r) => ({ at: r.at, version: r.version, passed: r.passed, total: r.total })), versions: vs.list.map((v) => ({ v: v.v, status: v.status })) }; };

// ── Versions view, edits, publishing and the split ──
export function versionsView(rows, agent, label) {
  const vs = seedVersions(agent); const pub = vs.list.find((x) => x.status === 'published'); const draft = vs.list.find((x) => x.status === 'draft');
  const all = mine(rows, agent, label).filter((r) => r.call_status && !['Bad data', 'Internal test call', 'In progress'].includes(r.call_status));
  const arm = (v) => {
    const list = all.filter((r) => versionOfCall(agent, r.id)?.v === v); const ans = list.filter((r) => r.call_status === 'Answered'); const ok = ans.filter((r) => String(r.status_reason).startsWith('Success'));
    const cfg = qaConfig(agent); const graded = ans.filter((r) => (Number(r.duration_seconds) || 0) >= cfg.min_seconds).map((r) => { const g = gradeCall(agent, r, cfg); return g.checks.length ? (100 * g.checks.filter((c) => c.pass).length) / g.checks.length : 100; });
    return { v, calls: list.length, answered_pct: list.length ? Math.round((100 * ans.length) / list.length) : null, success_pct: ans.length ? Math.round((100 * ok.length) / ans.length) : null, qa: graded.length ? Math.round(graded.reduce((s, x) => s + x, 0) / graded.length) : null, enough: list.length >= 30 };
  };
  return { list: vs.list.map(({ fixes, ...v }) => v).sort((a, b) => b.v - a.v), published: pub?.v ?? null, draft: draft?.v ?? null, split: vs.split,
    diff: pub && draft ? { from: pub.v, to: draft.v, prompt: diffLines(pub.prompt, draft.prompt), settings: Object.keys({ ...pub.settings, ...draft.settings }).filter((k) => pub.settings[k] !== draft.settings[k]).map((k) => ({ key: k, from: pub.settings[k], to: draft.settings[k] })) } : null,
    arms: vs.split.on ? [arm(vs.split.a), arm(vs.split.b)] : [arm(pub?.v)] };
}
export function saveDraft(agent, { prompt, note } = {}, by = 'you') {
  const vs = seedVersions(agent); let d = vs.list.find((x) => x.status === 'draft');
  if (!d) { const pub = vs.list.find((x) => x.status === 'published'); d = { ...structuredClone(pub), v: Math.max(...vs.list.map((x) => x.v)) + 1, status: 'draft', fixes: [] }; vs.list.push(d); }
  if (prompt != null) d.prompt = String(prompt).slice(0, 6000); if (note != null) d.note = String(note).slice(0, 120); d.at = nowIso(); d.by = by;
  // A draft that asks for every PO or reads back dates fixes those checks, in the demo's grading.
  d.fixes = [/every PO|each PO|one at a time/i.test(d.prompt) && 'all_pos', /read back/i.test(d.prompt) && 'read_back', /not to call|don't call|do not call/i.test(d.prompt) && 'dnc'].filter(Boolean);
  return d;
}
export function publishDraft(agent, by = 'you') {
  const vs = seedVersions(agent); const d = vs.list.find((x) => x.status === 'draft'); if (!d) return { error: 'There is no draft to publish' };
  for (const v of vs.list) if (v.status === 'published') v.status = 'old';
  d.status = 'published'; d.at = nowIso(); d.by = by; vs.split.on = false; return { ok: d.v };
}
export function setSplit(agent, b = {}) {
  const vs = seedVersions(agent); const pub = vs.list.find((x) => x.status === 'published'); const draft = vs.list.find((x) => x.status === 'draft');
  if (b.on && !draft) return { error: 'Make a draft first: the split compares the published version with a draft' };
  vs.split = { on: !!b.on, a: pub?.v, b: draft?.v ?? vs.split.b, b_pct: Math.min(50, Math.max(5, Number(b.b_pct) || 20)) }; return { ok: true };
}

// ── Contact memory: what the agent knows from earlier calls to the same number ──
export function memoryOf(rows, row, on = true) {
  if (!row) return null;
  if (!on) return { on: false, lines: [], variable: '', calls: 0 };
  const p = ten(row.phone);
  const past = rows.filter((r) => ten(r.phone) === p && r.id !== row.id && r.call_date && (!row.call_date || r.call_date < row.call_date)).sort((a, b) => String(b.call_date).localeCompare(String(a.call_date)));
  const lines = [];
  if (!past.length) lines.push('First call to this number: nothing to remember yet.');
  else {
    const results = [...new Set(past.map((r) => r.status_reason || r.call_status))].slice(0, 3);
    lines.push(`Called ${past.length} time${past.length === 1 ? '' : 's'} before, last on ${day(past[0].call_date)}: ${results.join('; ')}.`);
    const done = past.filter((r) => String(r.status_reason).startsWith('Success: Accepted'));
    if (done.length) lines.push(`Already confirmed: PO ${[...new Set(done.map((r) => String(r.inputs?.po_numbers || '').split(',')[0].trim()).filter(Boolean))].join(', ') || 'from an earlier sheet'}. Do not ask again.`);
    const promised = past.map((r) => Object.entries(r.answers || {}).find(([k, v]) => /date|dispatch|delivery/i.test(k) && v)).find(Boolean);
    if (promised) lines.push(`Earlier promise: ${promised[0].replace(/_/g, ' ')} ${promised[1]}.`);
    const cb = past.find((r) => r.callback_at); if (cb) lines.push(`Asked for calls around ${new Date(cb.callback_at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}.`);
    if (past.some((r) => /not given time|left before/i.test(r.status_reason || ''))) lines.push('Has hung up early before: open with the PO number straight away.');
  }
  if (hash(p) % 3 === 0) lines.push('Prefers Hindi.');
  const dn = onDnc(row.phone); if (dn) lines.unshift(`On the do-not-call list: ${dn.reason}.`);
  return { on: true, calls: past.length, lines, variable: lines.join(' '), last: past.slice(0, 4).map((r) => ({ id: r.id, date: r.call_date, result: r.status_reason || r.call_status, campaign: r.campaign })) };
}
