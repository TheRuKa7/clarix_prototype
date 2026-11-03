// Wave 3 (same file in Echo and Clarix): live calls (listen, take over, warm transfer), the telephony hub
// (carriers, caller IDs, concurrency slots), a copilot that answers questions about calls, and any-time topics.
// Demo data only: live calls replay a script on the clock, carriers are not contacted, the copilot reads the mock calls.
import { BOX } from './calling-report.mjs';
import { dncAdd } from './wave1.mjs';

const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const nowIso = () => new Date().toISOString();

// ── Live calls ──
const SCRIPTS = [
  { mood: 'calm', lines: [['agent', 'Namaste, main Saniya, Moglix purchase team se. PO {po} ke baare mein baat karni thi.'], ['supplier', 'Haan boliye.'], ['agent', 'Kya PO accept ho gaya hai, aur dispatch kab tak hoga?'], ['supplier', 'Accept hai. Material Friday ko nikal jayega.'], ['agent', 'Theek hai, Friday 6 November. Kya invoice bhi saath mein aayega?'], ['supplier', 'Haan, invoice saath mein.'], ['agent', 'Bahut dhanyavaad. Main team ko update kar deti hoon.']] },
  { mood: 'dispute', lines: [['agent', 'Hello, this is Saniya from Moglix about PO {po}.'], ['supplier', 'Again? I told your buyer the rate is wrong.'], ['agent', 'I understand. Can you tell me which line has the wrong rate?'], ['supplier', 'All the bearing lines. Raw material went up 12 percent.'], ['agent', 'I cannot change prices myself. I can bring in the buyer now, if you have two minutes.'], ['supplier', 'Fine, but quickly.']], flag: 'Price dispute: the supplier wants a revised rate. A buyer should take this.' },
  { mood: 'busy', lines: [['agent', 'Hello, Saniya from Moglix about PO {po}. Is this a good time?'], ['supplier', 'I am in a meeting. Call me after 4.'], ['agent', 'Of course. I will call you after 4 pm today.']] },
];
const live = new Map(); // id -> { started, script, state, by, transfer }
const BUYERS = [{ key: 'buyer1', name: 'Rahul Mehra (Buyer, MRO)', phone: '+91 98200 11223' }, { key: 'buyer2', name: 'Priya Nair (Category lead)', phone: '+91 98200 44556' }, { key: 'ops', name: 'Ops desk', phone: '+91 80 4718 2200' }];
/** The calls running now: unfinished rows, or the latest answered ones replayed when none are open (demo). */
export function liveCalls(rows) {
  let open = rows.filter(BOX.in_progress).slice(0, 4);
  if (open.length < 2) open = [...open, ...rows.filter((r) => r.call_status === 'Answered').sort((a, b) => String(b.call_date).localeCompare(String(a.call_date))).slice(0, 3 - open.length)];
  const now = Date.now();
  return open.map((r) => {
    let s = live.get(r.id);
    if (!s) { s = { started: now - (8 + (hash(r.id) % 25)) * 1000, script: SCRIPTS[hash(r.id) % SCRIPTS.length], state: 'ai', by: null, transfer: null }; live.set(r.id, s); }
    const elapsed = Math.round((now - s.started) / 1000); const po = String(r.inputs?.po_numbers || r.inputs?.po_number || '4500120000').split(',')[0].trim();
    const shown = s.script.lines.slice(0, Math.min(s.script.lines.length, 1 + Math.floor(elapsed / 6))).map(([who, text], i) => ({ who: who === 'agent' ? (s.state === 'human' && i >= s.script.lines.length - 1 ? 'You' : 'Agent') : 'Supplier', text: text.replace('{po}', po), at: i * 6 }));
    const done = s.state === 'ended' || (s.state === 'ai' && elapsed > s.script.lines.length * 6 + 20);
    return { id: r.id, po, caller: r.caller_name || r.phone, phone: r.phone, campaign: r.campaign, agent: r.agent, started_at: new Date(s.started).toISOString(), elapsed, state: done ? 'ended' : s.state,
      mood: s.script.mood, flag: s.script.flag || null, transcript: shown, transfer: s.transfer, listening: s.by };
  }).filter((c) => c.state !== 'ended' || live.get(c.id)?.state === 'ended');
}
export const BUYER_LIST = BUYERS;
export function liveAction(rows, id, action, body = {}, by = 'you') {
  const c = liveCalls(rows).find((x) => x.id === id); const s = live.get(id); if (!c || !s) return { error: 'That call is no longer live' };
  if (action === 'listen') { s.by = by; return { ok: 'Listening: you hear both sides; they cannot hear you.' }; }
  if (action === 'takeover') { s.state = 'human'; s.by = by; return { ok: 'You are on the call. The agent stopped speaking and keeps taking notes.' }; }
  if (action === 'transfer') {
    const to = BUYERS.find((b) => b.key === body.to) || BUYERS[0];
    const brief = String(body.brief || '').trim() || `${c.caller}, PO ${c.po}: ${c.flag ? c.flag.replace(/\.$/, '') : 'needs a person'}. Last said: "${c.transcript.filter((l) => l.who === 'Supplier').slice(-1)[0]?.text || ''}"`.slice(0, 240);
    s.state = 'transferred'; s.transfer = { to: to.name, phone: to.phone, brief, at: nowIso() };
    return { ok: `Ringing ${to.name}. They hear a 10-second brief before the supplier joins: "${brief}"` };
  }
  if (action === 'end') { s.state = 'ended'; return { ok: 'Call ended.' }; }
  if (action === 'dnc') { s.state = 'ended'; dncAdd({ phone: c.phone, name: c.caller, reason: 'Asked on a live call not to be called again' }, by); return { ok: 'Call ended and the number added to the do-not-call list.' }; }
  return { error: 'Unknown action' };
}

// ── Telephony hub: carriers, caller IDs, slots ──
export const CARRIERS = [
  { key: 'ozonetel', name: 'Ozonetel', region: 'India', fields: [['api_key', 'API key', 'secret'], ['user', 'User name', 'text'], ['campaign', 'Campaign name', 'text']] },
  { key: 'exotel', name: 'Exotel', region: 'India', fields: [['sid', 'Account SID', 'text'], ['token', 'API token', 'secret'], ['subdomain', 'Subdomain', 'text']] },
  { key: 'tata', name: 'Tata Tele Business', region: 'India', fields: [['account', 'Account ID', 'text'], ['token', 'API token', 'secret']] },
  { key: 'plivo', name: 'Plivo', region: 'Global', fields: [['auth_id', 'Auth ID', 'text'], ['token', 'Auth token', 'secret']] },
  { key: 'twilio', name: 'Twilio', region: 'Global', fields: [['sid', 'Account SID', 'text'], ['token', 'Auth token', 'secret']] },
  { key: 'sip', name: 'SIP trunk (your own)', region: 'Any', fields: [['host', 'SIP host', 'text'], ['user', 'User', 'text'], ['secret', 'Password', 'secret']] },
];
const tel = {
  carriers: [{ key: 'ozonetel', name: 'Ozonetel', status: 'connected', channels: 30, numbers: ['+91 80 4718 2290', '+91 80 4718 2291', '+91 80 4718 2292'], since: '2026-09-12T05:30:00.000Z' }],
  rotate: true, slots: new Map(), // campaign_id -> slots
};
export function telephonyView(rows) {
  const total = tel.carriers.filter((c) => c.status === 'connected').reduce((s, c) => s + c.channels, 0);
  const byC = new Map(); for (const r of rows) if (r.campaign_id && r.campaign_id !== 'console') (byC.get(r.campaign_id) || byC.set(r.campaign_id, []).get(r.campaign_id)).push(r);
  const running = [...byC.entries()].filter(([, list]) => list.some(BOX.in_progress)).map(([id, list]) => {
    const queued = list.filter(BOX.in_progress).length; const slots = tel.slots.get(id) ?? Math.min(10, Math.max(2, queued));
    return { campaign_id: id, campaign: list[0].campaign, agent: list[0].agent, slots, in_use: Math.min(slots, Math.max(1, Math.round(queued / 3))), queued, minutes_left: Math.ceil((queued * 2.5) / Math.max(1, slots)) };
  });
  const assigned = running.reduce((s, c) => s + c.slots, 0);
  return { carriers: tel.carriers, catalog: CARRIERS.map(({ key, name, region, fields }) => ({ key, name, region, fields: fields.map(([k, l, t]) => ({ key: k, label: l, type: t })) })), rotate: tel.rotate,
    total, assigned, free: Math.max(0, total - assigned), running, numbers: tel.carriers.flatMap((c) => c.numbers.map((n) => ({ number: n, carrier: c.name }))) };
}
export function testCarrier(b = {}) {
  const c = CARRIERS.find((x) => x.key === b.carrier); if (!c) return { ok: false, steps: [{ label: 'Pick a carrier', ok: false, detail: '' }] };
  const f = b.fields || {}; const missing = c.fields.find(([k]) => !String(f[k] || '').trim()); const steps = [];
  steps.push({ label: 'Details filled in', ok: !missing, detail: missing ? `Fill in "${missing[1]}".` : 'All fields present.' }); if (missing) return { ok: false, steps };
  const fail = Object.values(f).some((v) => /fail/i.test(String(v)));
  steps.push({ label: 'Signed in to ' + c.name, ok: !fail, detail: fail ? `${c.name} refused the credentials. Check the key or token, and that the account is active.` : 'Credentials accepted.' }); if (fail) return { ok: false, steps };
  steps.push({ label: 'Numbers found', ok: true, detail: '2 numbers with outbound calling: +91 22 6100 4410, +91 22 6100 4411' });
  steps.push({ label: 'Channels', ok: true, detail: '20 concurrent channels on this account' });
  steps.push({ label: 'Test call', ok: true, detail: 'Rang the test number and played a 5-second message (demo).' });
  return { ok: true, steps, channels: 20, numbers: ['+91 22 6100 4410', '+91 22 6100 4411'] };
}
export function connectCarrier(b = {}) {
  const t = testCarrier(b); if (!t.ok) return { error: 'The test did not pass' };
  const c = CARRIERS.find((x) => x.key === b.carrier); tel.carriers = tel.carriers.filter((x) => x.key !== c.key);
  tel.carriers.push({ key: c.key, name: c.name, status: 'connected', channels: t.channels, numbers: t.numbers, since: nowIso() }); return { ok: true };
}
export function disconnectCarrier(key) { const before = tel.carriers.length; tel.carriers = tel.carriers.filter((x) => x.key !== key); return before !== tel.carriers.length ? { ok: true } : { error: 'Not connected' }; }
export function saveSlots(b = {}) { tel.rotate = b.rotate !== false; for (const [id, n] of Object.entries(b.slots || {})) tel.slots.set(id, Math.min(200, Math.max(1, Number(n) || 1))); return { ok: true }; }

// ── Copilot: answers questions about the calls in view, with numbers and a next step ──
const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);
const hasAnswers = (r) => Object.values(r.answers || {}).some((v) => String(v ?? '').trim());
export const COPILOT_SUGGESTIONS = ['Why do some answered calls have empty answers?', 'Why were calls not successful?', 'Who should we call back today?', 'Which agent does best?', 'When do suppliers pick up most?', 'Summarise these calls'];
export function copilotAnswer(rows, q = '') {
  const t = String(q).toLowerCase(); const ans = rows.filter((r) => r.call_status === 'Answered'); const based = `Based on ${rows.length} call${rows.length === 1 ? '' : 's'} in view.`;
  if (/empty|blank|null|missing answer|no answer/.test(t) && /answer/.test(t)) {
    const empty = ans.filter((r) => !hasAnswers(r)); const short = empty.filter((r) => (Number(r.duration_seconds) || 0) < 15);
    const reasons = Object.entries(empty.reduce((m, r) => ((m[r.status_reason] = (m[r.status_reason] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).slice(0, 3);
    return { text: `${empty.length} of ${ans.length} answered calls have no answers saved. ${short.length} of them were under 15 seconds: the supplier hung up before the agent could ask.`,
      bullets: [...reasons.map(([k, n]) => `${n} × ${k}`), short.length ? 'Turn on the answer guardrail so short calls never save made-up answers, then re-run answers on the rest.' : 'Re-run answers on these calls with the current answer list.'],
      actions: [{ label: 'Re-run answers on the calls in view', kind: 'rerun' }, { label: 'Show answered calls', kind: 'box', key: 'answered', name: 'Answered' }], based };
  }
  if (/not success|fail|reject|why.*(lost|not)/.test(t)) {
    const bad = ans.filter((r) => !String(r.status_reason).startsWith('Success'));
    const reasons = Object.entries(bad.reduce((m, r) => ((m[r.status_reason] = (m[r.status_reason] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
    const top = reasons[0];
    return { text: top ? `${bad.length} answered calls were not successful. The biggest reason is "${top[0]}" (${top[1]}, ${pct(top[1], bad.length)}%).` : 'No answered call was unsuccessful in this view.',
      bullets: [...reasons.slice(0, 4).map(([k, n]) => `${n} × ${k}`), /not given time|left before/i.test(top?.[0] || '') ? 'Open with the PO number in the first sentence (draft v4 does this) and retry these with the "Hung up early" rule.' : 'Look at these calls in Quality to see which checks fail most.'],
      actions: [{ label: 'Show the not successful calls', kind: 'box', key: 'not_successful', name: 'Not successful' }], based };
  }
  if (/call ?back|today|follow/.test(t)) {
    const cb = rows.filter((r) => r.callback_at).sort((a, b) => String(a.callback_at).localeCompare(String(b.callback_at)));
    return { text: `${cb.length} supplier${cb.length === 1 ? '' : 's'} asked for a callback.`, bullets: cb.slice(0, 6).map((r) => `${r.caller_name || r.phone}: ${new Date(r.callback_at).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} · ${r.campaign}`),
      actions: [{ label: 'Show callback requests', kind: 'box', key: 'callback', name: 'Callback requested' }], based, calls: cb.slice(0, 6).map((r) => ({ id: r.id, label: r.caller_name || r.phone })) };
  }
  if (/agent|best|compare/.test(t)) {
    const by = new Map(); for (const r of rows) { const a = by.get(r.agent) || by.set(r.agent, { n: 0, ans: 0, ok: 0 }).get(r.agent); a.n++; if (r.call_status === 'Answered') { a.ans++; if (String(r.status_reason).startsWith('Success')) a.ok++; } }
    const list = [...by.entries()].filter(([, v]) => v.ans >= 3).sort((a, b) => pct(b[1].ok, b[1].ans) - pct(a[1].ok, a[1].ans));
    return { text: list.length ? `${list[0][0]} has the best success rate: ${pct(list[0][1].ok, list[0][1].ans)}% of answered calls.` : 'Not enough answered calls per agent to compare.', bullets: list.slice(0, 5).map(([k, v]) => `${k}: ${pct(v.ok, v.ans)}% success of ${v.ans} answered (${v.n} calls)`), actions: [], based };
  }
  if (/when|time|hour|pick ?up/.test(t)) {
    const by = new Map(); for (const r of rows.filter((x) => x.call_date && x.call_status && !['Bad data', 'Internal test call', 'In progress'].includes(x.call_status))) { const h = Number(new Date(r.call_date).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false })); const b = by.get(h) || by.set(h, { n: 0, up: 0 }).get(h); b.n++; if (r.call_status === 'Answered') b.up++; }
    const list = [...by.entries()].filter(([, v]) => v.n >= 3).sort((a, b) => pct(b[1].up, b[1].n) - pct(a[1].up, a[1].n));
    return { text: list.length ? `Suppliers pick up most between ${list[0][0]}:00 and ${list[0][0] + 1}:00 IST (${pct(list[0][1].up, list[0][1].n)}%).` : 'Not enough calls per hour to say.', bullets: list.slice(0, 5).map(([h, v]) => `${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00: ${pct(v.up, v.n)}% picked up of ${v.n}`), actions: [], based };
  }
  const ok = ans.filter((r) => String(r.status_reason).startsWith('Success')).length;
  return { text: `${rows.length} calls: ${ans.length} answered (${pct(ans.length, rows.length)}%), ${ok} successful (${pct(ok, ans.length)}% of answered).`,
    bullets: [`${rows.filter((r) => r.call_status === 'Not picked').length} not picked up`, `${rows.filter(BOX.in_progress).length} still being called`, `${rows.filter((r) => r.callback_at).length} callbacks asked`], actions: [{ label: 'Show successful calls', kind: 'box', key: 'success', name: 'Success' }], based };
}

// Any-time topics are part of each agent's call handling: see wave1.mjs (handling.anytime).
