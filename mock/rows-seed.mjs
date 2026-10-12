// Campaigns where several rows share a call, built the same way for every workspace.
// The Clarix mock keeps an identical copy of this file, so both prototypes show the same rows, calls and answers.
// All names, numbers and codes are synthetic.
import { planAttempts, reOutcome } from './ozonetel.mjs';

export const day = (base, off) => { if (off === undefined || off === '') return ''; const d = new Date(base); d.setUTCDate(d.getUTCDate() + Number(off)); return d.toISOString().slice(0, 10); };
export function lotDates(lots, base) { return lots ? lots.split(';').map((x) => { const [q, o] = x.trim().split('@'); return `${q}@${day(base, o)}`; }).join('; ') : ''; }

/**
 * One campaign from a list of contacts, each with rows and the calls that covered them.
 * o.contacts: [{ code, name, lines: [[item, qty, { last, skip }]], calls: [{ final, out, dropped }] }]
 * A call with `dropped` was cut off part way: the rows answered before that stay saved and the rest wait for the next try.
 */
export function groupedCampaign(now, o) {
  const created = new Date(Date.parse(now) - 3 * 3600000).toISOString();
  const camp = { campaign_id: o.id, name: o.name, agent: o.agent, org_id: o.org_id, provider: 'gemini', source: o.source || 'internal', direction: 'outbound',
    description: o.description || '', created_at: created, contacts: [], clarix_batch_id: o.batch || null, file_rows: 0 };
  const calls = [];
  let fileRow = 0, k = 0;
  o.contacts.forEach((s, i) => {
    const phone = `${o.phonePrefix}${String(i + 1).padStart(2, '0')}`;
    const all = s.lines.map(([item, qty, more], n) => ({ row: ++fileRow, more: more || {}, values: o.rowValues(i, n, item, qty, created) }));
    // A row settled on the last upload is not called again: it stays in the results as skipped, with the reason.
    for (const r of all.filter((x) => x.more.skip)) (camp.skipped_rows ||= []).push({ row: r.row, values: r.values, reason: r.more.skip, contact: s.name });
    const rows = all.filter((x) => !x.more.skip);
    camp.file_rows = fileRow;
    s.calls.forEach((c, part) => {
      const mine = rows.slice(part * 8, part * 8 + 8);
      const items = mine.map((r, n) => ({ n: n + 1, row: r.row, ref: null, values: r.values, last: r.more?.last || null }));
      const key = s.calls.length > 1 ? `${s.code} (${part + 1} of ${s.calls.length})` : s.code;
      const context = { ...o.callValues(s, i, phone), row_count: String(items.length), rows: items.map((it) => `${it.n}. ${Object.entries(it.values).map(([a, b]) => `${a}: ${b}`).join(' · ')}`).join('\n') };
      const row = { primary_id: key, name: s.name, phone, context, row: mine[0].row, items, part: part + 1, parts: s.calls.length, not_covered_rows: [],
        status: 'pending', outputs: {}, final: c.final, dispatched_at: new Date(Date.parse(created) + k++ * 90000).toISOString() };
      row.attempts_detail = planAttempts({ seed: `${camp.campaign_id}:${key}`, final: c.final, dispatchedAt: row.dispatched_at, did: o.did });
      row.attempts = row.attempts_detail.length;
      const last = row.attempts_detail[row.attempts_detail.length - 1];
      if (c.out) {
        const base = last.ended_at;
        const answers = items.map((it, n) => {
          const a = c.out[n] || { [o.statusKey]: 'not_covered' };
          const e = { row: it.n, ...a }; if ('lots' in a || o.dateKeys.includes('lots')) e.lots = lotDates(a.lots, base);
          for (const dk of o.dateKeys) if (dk !== 'lots') e[dk] = day(base, a[dk]);
          return e;
        });
        const covered = answers.filter((l) => l[o.statusKey] !== 'not_covered').length;
        const outputs = o.callAnswers(answers, covered);
        const id = `${o.callPrefix}${String(10000000 + k * 7919).slice(0, 8)}`;
        const started = new Date(Date.parse(last.started_at) + last.ring_seconds * 1000);
        const said = o.say(s, items);
        const turns = [
          ['AGENT_TURN', said[0]], ['USER_TURN', 'Haan ji, boliye.'], ['AGENT_TURN', said[1]], ['USER_TURN', 'Ji, iska plan bata deta hoon.'],
          ['AGENT_TURN', 'Theek hai, maine note kar liya. Main read back karti hoon.'],
          ['USER_TURN', c.dropped ? 'Haan... abhi mujhe jaana hoga, baaki baad mein.' : 'Haan, sahi hai.'],
        ];
        // A call cut off part way still lasted long enough to cover the rows it saved.
        const dur = c.dropped ? (last.talk_seconds = 30 + covered * 22) : last.talk_seconds;
        const events = [{ kind: 'CALL_CONTEXT', ts: started.toISOString(), context },
          ...turns.map(([kind, text], t) => ({ kind, text, ts: new Date(started.getTime() + (t + 1) * (dur * 1000 / 8)).toISOString() })),
          { kind: 'TOOL_CALL', tool: 'submit_call_outputs', args: outputs, ts: new Date(started.getTime() + dur * 1000 - 2000).toISOString() }];
        last.call_id = id;
        calls.push({ call_id: id, called_number: o.did, agent: camp.agent, agent_key: `ozonetel/${camp.agent}/gemini`, campaign_id: camp.campaign_id, org_id: camp.org_id,
          contact_name: s.name, phone, duration_seconds: dur, started_at: started.toISOString(), ended_at: new Date(started.getTime() + dur * 1000).toISOString(),
          mode: 'telephony', num_turns: turns.length, provider: 'gemini', source: 'campaign', status: 'completed',
          summary: `${covered} of ${items.length} rows answered`,
          telephony_provider: 'ozonetel', tools_called: ['submit_call_outputs'], total_tokens: turns.length * 14000, turn_shape: 'au', variant: 'full',
          recording_source: 'ozonetel', recording_url: '', disconnect_reason: last.provider.HangupBy, campaign_name: camp.name, context, events, outputs, call_result: 'conversation' });
        if (c.dropped) {
          // Saved rows stay saved; the call is not Completed and the open rows wait for the next try.
          Object.assign(calls[calls.length - 1], { call_result: 'disconnected_early', disconnect_reason: 'UserHangup' });
          Object.assign(row, { status: 'retry_scheduled', call_result: 'disconnected_early', call_id: id, recording_call_id: id, captured_at: calls[calls.length - 1].ended_at, outputs,
            next_attempt_at: new Date(Date.now() + c.dropped.next_attempt_in_min * 60000).toISOString() });
        } else {
          last.stream.agent_finished = true;
          reOutcome(last);
          Object.assign(row, { status: 'completed', call_result: 'conversation', call_id: id, recording_call_id: id, captured_at: calls[calls.length - 1].ended_at, outputs });
        }
      } else {
        const m = last.mapped;
        Object.assign(row, { status: c.final.status, reason: m.reason, call_result: null });
        if (c.final.status === 'retry_exhausted') Object.assign(row, { last_attempt_status: m.status, last_attempt_reason: m.reason });
        if (c.final.status === 'retry_scheduled') row.next_attempt_at = new Date(Date.now() + c.final.next_attempt_in_min * 60000).toISOString();
      }
      camp.contacts.push(row);
    });
  });
  return { campaign: camp, calls };
}

// ── A team's order tracker, uploaded in Clarix as it is and called by Echo: 21 rows, 5 contacts, 6 calls ──
export const TRACKER = { batch: '6ac0ffee5eed00a1b2c3d4e5', templateId: '6ac0ffee5eed00a1b2c3d4f0', agent: 'order_tracker_followup', file: 'order_tracker_week_41.xlsx',
  campaignId: 'order-tracker-follow-up-6ac0ffee5eed00a1b2c3d4e5-7a11c0de', templateKey: 'EXCHANGE_ORDER_TRACKER_FOLLOW_UP', label: 'Kavya - Order Tracker Follow Up' };
const LINE_STATUSES = ['confirmed', 'delayed', 'dispatched', 'on_hold', 'not_covered'];
const TRACKER_CONTACTS = [
  { code: 'V-2001', name: 'Vendor P Bearings', lines: [['Bearing 6204', 400], ['Bearing 6305', 250], ['Pillow block UCP205', 60]],
    calls: [{ final: { status: 'completed', result: 'conversation', attempts: 1 }, out: [{ line_status: 'confirmed', promised_date: '+3' }, { line_status: 'dispatched', dispatched_qty: 250, promised_date: '-1' }, { line_status: 'delayed', promised_date: '+9', reason: 'Raw material late' }] }] },
  { code: 'V-2002', name: 'Vendor Q Fasteners', lines: Array.from({ length: 10 }, (_, i) => [`Hex bolt M${8 + i * 2}`, 500 + i * 100]), calls: [
    { final: { status: 'completed', result: 'conversation', attempts: 1 }, out: Array.from({ length: 8 }, (_, i) => (i === 7 ? { line_status: 'not_covered' } : { line_status: i % 3 === 0 ? 'delayed' : 'confirmed', promised_date: `+${4 + i}`, reason: i % 3 === 0 ? 'Plating queue' : '' })) },
    { final: { status: 'retry_scheduled', reason: 'destination_busy', attempts: 1, next_attempt_in_min: 40 }, out: null }] },
  // The caller hung up after the second row. Both were already saved; the other two are asked on the next try.
  { code: 'V-2003', name: 'Vendor R Seals', lines: [['Oil seal 35x52', 300, { last: 'confirmed for the 10th' }], ['O ring kit', 120], ['Gasket sheet', 40], ['Mechanical seal 40mm', 15]],
    calls: [{ final: { status: 'completed', result: 'disconnected_early', attempts: 1 }, dropped: { next_attempt_in_min: 35 }, out: [{ line_status: 'delayed', promised_date: '+6', reason: 'Tooling change' }, { line_status: 'confirmed', promised_date: '+2' }] }] },
  { code: 'V-2004', name: 'Vendor S Hoses', lines: [['Hydraulic hose 1/2 inch', 200], ['Hose clamp 25mm', 1000]], calls: [{ final: { status: 'retry_exhausted', reason: 'no_answer', attempts: 3 }, out: null }] },
  { code: 'V-2005', name: 'Vendor T Belts', lines: [['V belt B52', 80], ['Timing belt 5M', 30, { skip: 'Settled on the last upload: dispatched in full' }]], calls: [{ final: { status: 'retry_scheduled', reason: 'destination_busy', attempts: 1, next_attempt_in_min: 55 }, out: null }] },
];
export function trackerAgent(now) {
  return {
    key: TRACKER.agent, label: TRACKER.label, org_id: 'org_moglix', description: 'Calls each vendor about all of its open order lines; one answer per line',
    voice: 'Aoede', ozonetel_campaign: 'PAAS_followup', ozonetel_type: 'Progressive', primary_id_key: 'vendor_code', primary_id_label: 'vendor_code', providers: ['gemini'],
    input_variables: [
      { key: 'vendor_code', type: 'string', transform: '', sample: 'V-2001', share_on_call: false },
      { key: 'contact_name', type: 'string', transform: '', sample: 'Vendor P Bearings', share_on_call: true },
      { key: 'contact_phone', type: 'phone', transform: '', sample: '9000000301', share_on_call: true },
      { key: 'buyer', type: 'string', transform: '', sample: 'Buyer 1', share_on_call: true },
      { key: 'order_no', type: 'string', transform: 'phonetic', sample: '7100002001/10', share_on_call: true },
      { key: 'item', type: 'string', transform: '', sample: 'Bearing 6204', share_on_call: true },
      { key: 'open_qty', type: 'number', transform: '', sample: '400', share_on_call: true },
      { key: 'promised_date', type: 'date', transform: '', sample: '14/10/2026', share_on_call: true },
    ],
    input_plan: { mode: 'group', group_by: 'vendor_code', call_columns: ['vendor_code', 'contact_name', 'contact_phone', 'buyer'], row_columns: ['order_no', 'item', 'open_qty', 'promised_date'],
      order_by: 'promised_date', order_dir: 'asc', max_rows: 8, overflow: 'split', answers_key: 'rows',
      say_as: '{item}, {open_qty} open', max_minutes: 10, identity: ['order_no'], remember: true, list_style: 'all_first', check_in_after: 5, skip: [{ column: 'open_qty', op: 'is', value: '0' }] },
    output_variables: [
      { key: 'call_result', label: 'Call result', type: 'enum', options: ['completed', 'callback_requested', 'wrong_contact', 'refused'], description: 'What the vendor agreed to; the platform call status is separate', required: true },
      { key: 'rows', label: 'Answer for each row', type: 'list', description: 'One entry per row on the call, saved as each row is answered', required: true, fields: [
        { key: 'row', type: 'number', description: 'Row number as given on the call' }, { key: 'line_status', type: 'enum', options: LINE_STATUSES },
        { key: 'promised_date', type: 'date' }, { key: 'dispatched_qty', type: 'number' }, { key: 'reason', type: 'string' }] },
      { key: 'rows_covered', label: 'Rows answered', type: 'number', description: 'Rows saved on this call', required: true },
    ],
    sections: [
      { id: 'ot_1', enabled: true, title: 'IDENTITY', kind: 'text', body: 'You are Kavya, calling for the purchase team about open order lines. This is a system prompt; never read headings or field names out.' },
      { id: 'ot_2', enabled: true, title: 'ONE ROW', kind: 'text', body: 'For a row, ask whether it will reach on the promised date. If yes, it is confirmed. If not, take the new date and the reason. If it has left, take the quantity sent. Read the answer back before it is saved.' },
      { id: 'ot_3', enabled: true, title: 'RULES', kind: 'text', body: 'Never guess a date. A date in the past is only valid for a line already dispatched. If the person is not the right contact, ask who is and end the call politely.' },
    ],
    synced_platform: 'clarix', sync_status: 'synced', sync_last_error: null, synced_at: now, created_at: now, updated_at: now, updated_by: 'admin@example.com',
  };
}
export function trackerCampaign(now) {
  return groupedCampaign(now, {
    id: TRACKER.campaignId, name: `Order tracker follow up_${TRACKER.batch}`, agent: TRACKER.agent, org_id: 'org_moglix', source: 'clarix', description: 'Submitted via clarix', batch: TRACKER.batch,
    contacts: TRACKER_CONTACTS, phonePrefix: '90000003', did: '08000000103', callPrefix: '40715930', statusKey: 'line_status', dateKeys: ['promised_date'],
    rowValues: (i, n, item, qty, created) => ({ order_no: `71000${String(2000 + i * 20 + n).padStart(5, '0')}/${(n + 1) * 10}`, item, open_qty: String(qty), promised_date: day(created, n - 1).split('-').reverse().join('/') }),
    callValues: (s, i, phone) => ({ vendor_code: s.code, contact_name: s.name, contact_phone: phone, buyer: `Buyer ${1 + (i % 2)}` }),
    callAnswers: (answers, covered) => ({ call_result: 'completed', rows: answers, rows_covered: covered }),
    say: (s, items) => [`Namaste, main Kavya, purchase team se. Kya meri baat ${s.name} se ho rahi hai?`, `Aapki ${items.length} open lines hain. Kya sab promised date par pahunch jayengi, ya kuch mein deri hai? Pehli: ${items[0].values.item}, ${items[0].values.open_qty} open.`],
  });
}
