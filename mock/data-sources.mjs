// Agent data sources (same file in Echo and Clarix): connect an ERP, CRM, database, API or webhook once,
// then each run reads rows, filters them, groups lines into calls and starts a campaign. Demo data only:
// nothing here reaches a real system. See docs/Agent-Data-Sources-Journey-2026-11-03.md.

const F = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });
/** The connector catalog: what each asks for, and the object it reads. */
export const CONNECTORS = [
  { key: 'sap', group: 'ERP', name: 'SAP S/4HANA', how: 'OData API', fields: [F('host', 'Server URL', 'url', { placeholder: 'https://my-s4.example.com' }), F('client', 'Client', 'text', { placeholder: '100' }), F('user', 'Technical user'), F('secret', 'Password', 'secret')], objects: ['Open PO lines (A_PurchaseOrderItem)', 'Supplier invoices due'] },
  { key: 'oracle', group: 'ERP', name: 'Oracle ERP Cloud', how: 'REST API', fields: [F('host', 'Instance URL', 'url', { placeholder: 'https://abc.fa.ocs.oraclecloud.com' }), F('user', 'Integration user'), F('secret', 'Password', 'secret')], objects: ['Open PO schedules', 'Receipts pending'] },
  { key: 'dynamics', group: 'ERP', name: 'Microsoft Dynamics 365', how: 'Dataverse API', fields: [F('host', 'Environment URL', 'url', { placeholder: 'https://org.crm.dynamics.com' }), F('client_id', 'App (client) ID'), F('secret', 'Client secret', 'secret')], objects: ['Purchase order lines', 'Vendor payments'] },
  { key: 'zoho', group: 'ERP', name: 'Zoho Books', how: 'OAuth', oauth: true, fields: [F('org', 'Organisation ID')], objects: ['Purchase orders', 'Bills due'] },
  { key: 'salesforce', group: 'CRM', name: 'Salesforce', how: 'OAuth', oauth: true, fields: [F('host', 'My Domain URL', 'url', { placeholder: 'https://acme.my.salesforce.com' })], objects: ['Report: Open orders by supplier', 'List view: Leads to call'] },
  { key: 'hubspot', group: 'CRM', name: 'HubSpot', how: 'OAuth', oauth: true, fields: [], objects: ['Contacts list: Renewals due', 'Deals in stage: Follow up'] },
  { key: 'postgres', group: 'Database', name: 'PostgreSQL', how: 'Read-only user', fields: [F('host', 'Host', 'text', { placeholder: 'db.example.com' }), F('port', 'Port', 'number', { placeholder: '5432' }), F('database', 'Database'), F('user', 'User'), F('secret', 'Password', 'secret')], objects: ['public.open_po_lines', 'Saved query: overdue_lines'], query: true },
  { key: 'mysql', group: 'Database', name: 'MySQL', how: 'Read-only user', fields: [F('host', 'Host'), F('port', 'Port', 'number', { placeholder: '3306' }), F('database', 'Database'), F('user', 'User'), F('secret', 'Password', 'secret')], objects: ['open_po_lines', 'Saved query: overdue_lines'], query: true },
  { key: 'mssql', group: 'Database', name: 'SQL Server', how: 'Read-only user', fields: [F('host', 'Server'), F('database', 'Database'), F('user', 'User'), F('secret', 'Password', 'secret')], objects: ['dbo.OpenPoLines', 'Saved query: overdue_lines'], query: true },
  { key: 'gsheets', group: 'Files', name: 'Google Sheets', how: 'OAuth', oauth: true, fields: [F('url', 'Sheet link', 'url', { placeholder: 'https://docs.google.com/spreadsheets/d/…' })], objects: ['Tab: Open lines'] },
  { key: 'sftp', group: 'Files', name: 'SFTP (CSV drop)', how: 'Key or password', fields: [F('host', 'Host'), F('path', 'Folder', 'text', { placeholder: '/outbound/po' }), F('user', 'User'), F('secret', 'Password or key', 'secret')], objects: ['Newest CSV in the folder'] },
  { key: 'api', group: 'Developer', name: 'REST API', how: 'We fetch', fields: [F('url', 'GET URL', 'url', { placeholder: 'https://api.example.com/open-lines' }), F('header', 'Auth header name', 'text', { placeholder: 'Authorization' }), F('secret', 'Header value', 'secret'), F('path', 'Rows are at (JSON path)', 'text', { placeholder: 'data.items' })], objects: ['The URL above'] },
  { key: 'webhook', group: 'Developer', name: 'Webhook', how: 'You push', fields: [], objects: ['Events you send'], push: true },
];
export const connectorOf = (k) => CONNECTORS.find((c) => c.key === k);

// ── The demo dataset: open PO lines, the same for every connector ────────────
const day = (n) => { const d = new Date(Date.now() + 5.5 * 3600e3); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const SUPPLIERS = [
  ['Shree Ganesh Bearings', '9810011001'], ['Mehta Fasteners', '9810011002'], ['Kaveri Gaskets', '9810011003'], ['Patel Hydraulics', '9810011004'],
  ['Om Sai Industrial Supplies', '9810011005'], ['Lotus Lubricants', '9810011006'], ['Everest Cables', '9810011007'], ['Sunrise Valves', '9810011008'],
];
const ITEMS = [['BRG-6205', 'Bearing 6205 ZZ', 'pcs'], ['FST-M12', 'Hex bolt M12 x 50', 'pcs'], ['GSK-150', 'Spiral wound gasket 150#', 'pcs'], ['HYD-HS12', 'Hydraulic hose 1/2"', 'm'],
  ['VLV-BL25', 'Ball valve 1"', 'pcs'], ['LUB-EP2', 'EP2 grease 18 kg', 'buckets'], ['CBL-4C16', '4 core 16 sqmm cable', 'm'], ['BRG-6308', 'Bearing 6308 2RS', 'pcs']];
const STATUSES = ['Open', 'Open', 'Open', 'Partially received', 'Open', 'Closed'];
let DATA = null;
export function sourceRows() {
  if (DATA) return DATA;
  const out = []; let n = 0;
  SUPPLIERS.forEach(([name, phone], s) => {
    const pos = 1 + (s % 3);
    for (let p = 0; p < pos; p++) {
      const po = String(4500120000 + s * 10 + p); const lines = 1 + ((s + p) % 4);
      for (let l = 0; l < lines; l++) {
        const it = ITEMS[(s + p + l) % ITEMS.length]; const qty = 10 * (1 + ((s * 7 + l * 3) % 9)); const st = STATUSES[(s + p + l) % STATUSES.length];
        const pending = st === 'Closed' ? 0 : st === 'Partially received' ? Math.round(qty / 2) : qty;
        out.push({ po_line_id: `${po}-${String((l + 1) * 10).padStart(5, '0')}`, po_number: po, po_date: day(-14 - s), supplier_name: name, supplier_mobile: phone,
          supplier_email: `orders@${name.toLowerCase().replace(/[^a-z]+/g, '')}.example`, item_code: it[0], item_name: it[1], ordered_qty: qty, pending_qty: pending, uom: it[2],
          promised_date: day(((s + l + p) % 9) - 4), status: st, plant: ['Pune', 'Chennai', 'Manesar'][(s + p) % 3], line_value_inr: qty * (120 + ((s + l) % 5) * 85),
          line_summary: `${it[1]} x ${pending || qty} ${it[2]}` });
        n++;
      }
    }
  });
  DATA = out; return out;
}
export const SOURCE_COLUMNS = () => Object.keys(sourceRows()[0]).map((k) => ({ key: k, label: k.replace(/_/g, ' '), type: /date/.test(k) ? 'date' : /qty|value/.test(k) ? 'number' : 'text', sample: String(sourceRows()[0][k]) }));

// ── Connection test: a visible checklist, failing at the step a real one would ──
const pause = (ms) => ms;
/** conn: { connector, fields, object }. A value containing "fail" fails sign-in; an empty required field stops at step 1. */
export function testConnection(conn = {}) {
  const c = connectorOf(conn.connector); if (!c) return { ok: false, steps: [{ key: 'pick', label: 'Pick a connector', ok: false, detail: 'Choose where the rows come from.' }] };
  const fields = conn.fields || {}; const steps = [];
  const add = (key, label, ok, detail, ms) => { steps.push({ key, label, ok, detail, ms: pause(ms) }); return ok; };
  if (c.push) {
    add('url', 'Webhook address created', true, 'Send POST requests with a JSON body to this address.', 5);
    const got = !!conn.test_event;
    if (!add('event', 'Test event received', got, got ? `Received ${conn.test_event.rows} row${conn.test_event.rows === 1 ? '' : 's'} at ${conn.test_event.at}.` : 'Waiting: send a test event from your system, or use "Send test event".', 0)) return { ok: false, steps };
    add('signature', 'Signature checked', true, 'The X-Echo-Signature header matches the signing secret.', 3);
    add('fields', 'Fields found', true, `${SOURCE_COLUMNS().length} fields in each row.`, 2);
    add('phones', 'Phone numbers look callable', true, 'Every sample row has a 10-digit mobile number.', 2);
    return { ok: true, steps, columns: SOURCE_COLUMNS(), sample: sourceRows().slice(0, 20) };
  }
  const optional = new Set(['port', 'path', 'client', 'header']);
  const missing = c.fields.find((f) => !optional.has(f.key) && !String(fields[f.key] ?? '').trim() && !(f.type === 'secret' && conn.has_secret));
  const host = String(fields.host || fields.url || '').toLowerCase();
  if (!add('reach', c.oauth ? 'Account connected' : 'Server reached', !missing && (!c.oauth || conn.authorised !== false), missing ? `Fill in "${missing.label}".` : c.oauth ? `Signed in to ${c.name} with read access.` : `Reached ${host || 'the server'} over TLS 1.3 in 84 ms.`, 84)) return { ok: false, steps };
  const failSignIn = Object.values(fields).some((v) => /fail/i.test(String(v)));
  if (!add('auth', 'Signed in', !failSignIn, failSignIn ? 'The server refused the user and password. Check them, and that the user is not locked.' : 'Signed in as a read-only user.', 120)) return { ok: false, steps };
  if (!add('read', 'Permission to read', true, `Can read "${conn.object || c.objects[0]}".`, 40)) return { ok: false, steps };
  add('query', c.query ? 'Query ran' : 'Rows fetched', true, `${sourceRows().length} rows in 0.4 s.`, 400);
  add('fields', 'Columns found', true, `${SOURCE_COLUMNS().length} columns: ${SOURCE_COLUMNS().slice(0, 4).map((x) => x.key).join(', ')}…`, 2);
  add('phones', 'Phone numbers look callable', true, 'supplier_mobile has a 10-digit mobile number in every row.', 2);
  return { ok: true, steps, columns: SOURCE_COLUMNS(), sample: sourceRows().slice(0, 20) };
}

// ── Field mapping: each agent input from a source column, matched by name ─────
/** Inputs that are a count of the call's lines when no column fills them: po_count, item_count, line_count. */
export function countOf(input) { return /^po_?(count|total)$|^(no_of_)?pos$/i.test(input) ? 'po' : /^(item|line)s?_?(count|total)$|^no_of_(items|lines)$/i.test(input) ? 'line' : ''; }
const SYNONYMS = { contact_phone: ['supplier_mobile', 'phone', 'mobile'], contact_name: ['supplier_name', 'vendor', 'name'], contact_email: ['supplier_email', 'email'],
  po_numbers: ['po_number'], po_number: ['po_number'], po_no: ['po_number'], item_details: ['line_summary', 'item_name'], item_codes: ['item_code'], plant_name: ['plant'], items: ['line_summary'], item_names: ['item_name'], supplier_name: ['supplier_name'],
  delivery_date: ['promised_date'], promised_date: ['promised_date'], due_date: ['promised_date'], quantity: ['pending_qty'], pending_qty: ['pending_qty'], plant: ['plant'], po_date: ['po_date'] };
/** inputs: agent input keys -> [{ input, column, sure }] */
export function suggestMapping(inputs) {
  const cols = SOURCE_COLUMNS().map((c) => c.key);
  return inputs.map((input) => {
    const want = SYNONYMS[input] || []; let column = want.find((w) => cols.includes(w)) || '';
    let sure = column ? 'high' : '';
    // Otherwise the column sharing the most meaningful words; generic words (name, date, count…) alone never match.
    if (!column && !countOf(input)) {
      const generic = new Set(['name', 'date', 'count', 'id', 'no', 'number', 'numbers', 'details', 'contact', 'value']);
      const words = input.toLowerCase().split('_').map((w) => w.replace(/s$/, '')).filter((w) => w.length > 2 && !generic.has(w));
      const best = cols.map((c) => ({ c, n: words.filter((w) => c.includes(w)).length })).sort((a, b) => b.n - a.n)[0];
      if (best?.n) { column = best.c; sure = 'medium'; }
    }
    return { input, column, sure };
  });
}

// ── Filters: row conditions with relative dates ──────────────────────────────
export const FILTER_OPS = [['is', 'is'], ['isnot', 'is not'], ['contains', 'contains'], ['gt', 'greater than'], ['lt', 'less than'],
  ['due', 'on or before today +'], ['overdue', 'before today'], ['since', 'on or after today −'], ['blank', 'is blank'], ['notblank', 'is not blank']];
function rowMatches(r, { field, op, value }) {
  const v = r[field]; const s = String(v ?? '').trim(); const x = String(value ?? '').trim();
  switch (op) {
    case 'is': return x.split(',').map((y) => y.trim().toLowerCase()).includes(s.toLowerCase());
    case 'isnot': return !x.split(',').map((y) => y.trim().toLowerCase()).includes(s.toLowerCase());
    case 'contains': return s.toLowerCase().includes(x.toLowerCase());
    case 'gt': return Number(v) > Number(x);
    case 'lt': return Number(v) < Number(x);
    case 'due': return !!s && s <= day(Number(x) || 0);
    case 'overdue': return !!s && s < day(0);
    case 'since': return !!s && s >= day(-(Number(x) || 0));
    case 'blank': return !s;
    case 'notblank': return !!s;
    default: return true;
  }
}

// ── Already called: a unique key and a quiet period ──────────────────────────
const called = new Map(); // agent -> Map(key -> ISO time)
const calledFor = (agent) => called.get(agent) || called.set(agent, new Map()).get(agent);

/** Rows -> calls. config: { mapping: [{ input, column }], filters, group: { mode, by, max_lines, order }, dedupe: { key, days } } */
export function buildCalls(agent, config = {}, inputs = []) {
  const all = sourceRows(); const filters = (config.filters || []).filter((f) => f.field && f.op);
  const kept = all.filter((r) => filters.every((f) => rowMatches(r, f)));
  const dd = config.dedupe || {}; const seen = calledFor(agent); const quiet = (Number(dd.days) || 0) * 864e5;
  const recent = (r) => dd.key && seen.has(String(r[dd.key])) && Date.now() - Date.parse(seen.get(String(r[dd.key]))) < quiet;
  const fresh = kept.filter((r) => !recent(r)); const skippedRecent = kept.length - fresh.length;
  const map = new Map((config.mapping || []).filter((m) => m.column).map((m) => [m.input, m.column]));
  const phoneCol = map.get('contact_phone');
  const noPhone = phoneCol ? fresh.filter((r) => String(r[phoneCol] ?? '').replace(/\D/g, '').length < 10) : fresh;
  const callable = fresh.filter((r) => !noPhone.includes(r));
  const g = config.group || { mode: 'row' };
  const order = g.order || ''; const sorted = order ? [...callable].sort((a, b) => String(a[order]).localeCompare(String(b[order]), undefined, { numeric: true })) : callable;
  const groups = [];
  if (g.mode === 'group' && (g.by || []).length) {
    const by = new Map(); for (const r of sorted) { const k = g.by.map((f) => r[f]).join(' · '); (by.get(k) || by.set(k, []).get(k)).push(r); }
    const cap = Math.max(1, Number(g.max_lines) || 8);
    for (const [k, rows] of by) for (let i = 0; i < rows.length; i += cap) groups.push({ key: k, rows: rows.slice(i, i + cap), part: i / cap + 1, parts: Math.ceil(rows.length / cap) });
  } else for (const r of sorted) groups.push({ key: String(r[dd.key || 'po_line_id'] ?? ''), rows: [r], part: 1, parts: 1 });
  const listy = (input) => /details|items|lines|numbers|names|codes|list/i.test(input);
  const calls = groups.map((gr) => {
    const vals = {};
    for (const input of inputs) {
      const col = map.get(input);
      if (!col) { const k = countOf(input); vals[input] = k === 'po' ? String(new Set(gr.rows.map((r) => r.po_number)).size) : k === 'line' ? String(gr.rows.length) : ''; continue; }
      const uniq = [...new Set(gr.rows.map((r) => String(r[col] ?? '')).filter(Boolean))];
      vals[input] = gr.rows.length === 1 || !listy(input) ? uniq[0] ?? '' : uniq.join(/details|items|lines/i.test(input) ? '; ' : ', ');
    }
    if (inputs.includes('line_count') || g.mode === 'group') vals.line_count = String(gr.rows.length);
    return { key: gr.key, part: gr.part, parts: gr.parts, lines: gr.rows.length, phone: phoneCol ? String(gr.rows[0][phoneCol]) : '', inputs: vals, row_keys: gr.rows.map((r) => r[dd.key || 'po_line_id']) };
  });
  return { read: all.length, after_filters: kept.length, skipped_recent: skippedRecent, no_phone: noPhone.length, calls };
}
export function markCalled(agent, calls, keyField) { const seen = calledFor(agent); const at = new Date().toISOString(); for (const c of calls) for (const k of c.row_keys) seen.set(String(k), at); }
/** The calls as a CSV the existing upload path reads: the agent's inputs as headers. */
export function callsCsv(inputs, calls) {
  const q = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [inputs.map(q).join(','), ...calls.map((c) => inputs.map((k) => q(c.inputs[k])).join(','))].join('\n');
}

// ── Write-back: a dry run of the first updates ───────────────────────────────
export function writeBackPreview(config = {}, calls = []) {
  const wb = config.write_back || {}; const maps = (wb.mapping || []).filter((m) => m.output && m.field);
  if (!wb.mode || wb.mode === 'off' || !maps.length) return [];
  const sample = { line_status: 'confirmed', promised_date: day(3), delay_reason: 'Raw material late', supplier_remarks: 'Will dispatch Friday', call_outcome: 'Accepted' };
  return calls.slice(0, 5).flatMap((c) => c.row_keys.slice(0, 2).map((k) => ({ key: k, set: Object.fromEntries(maps.map((m) => [m.field, sample[m.output] ?? `‹${m.output}›`])) }))).slice(0, 5);
}

// ── Schedule: next runs in IST ───────────────────────────────────────────────
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** schedule: { on, cadence: 'once' | 'daily' | 'weekdays' | 'days', days: [0-6], time: 'HH:MM', start: 'YYYY-MM-DD', end?: 'YYYY-MM-DD' } */
export function nextRuns(s = {}, n = 5) {
  if (!s.on || !s.time) return [];
  const [hh, mm] = s.time.split(':').map(Number); const out = []; const now = Date.now();
  const start = s.start || day(0);
  for (let i = 0; i < 400 && out.length < n; i++) {
    const d = new Date(`${start}T00:00:00+05:30`); d.setTime(d.getTime() + i * 864e5);
    const ymd = new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10); if (s.end && ymd > s.end) break;
    const wd = new Date(`${ymd}T12:00:00+05:30`).getUTCDay();
    const okDay = s.cadence === 'once' ? i === 0 : s.cadence === 'weekdays' ? wd >= 1 && wd <= 5 : s.cadence === 'days' ? (s.days || []).includes(wd) : true;
    const at = Date.parse(`${ymd}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`);
    if (okDay && at > now) out.push({ at: new Date(at).toISOString(), label: `${WD[wd]} ${new Date(at).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })}, ${s.time} IST` });
    if (s.cadence === 'once') break;
  }
  return out;
}

// ── Saved setups and runs, per agent ─────────────────────────────────────────
const setups = new Map(); const runs = new Map();
export function defaultSetup(inputs) {
  return { connector: '', fields: {}, object: '', has_secret: false, tested: false, mapping: suggestMapping(inputs).map(({ input, column }) => ({ input, column })),
    filters: [{ field: 'status', op: 'isnot', value: 'Closed' }, { field: 'pending_qty', op: 'gt', value: '0' }, { field: 'promised_date', op: 'due', value: '3' }],
    group: { mode: 'group', by: ['supplier_mobile'], max_lines: 8, order: 'promised_date' }, dedupe: { key: 'po_line_id', days: 2 },
    write_back: { mode: 'off', mapping: [] }, schedule: { on: false, cadence: 'weekdays', days: [1, 2, 3, 4, 5], time: '10:00', start: day(0), end: '' } };
}
/** The setup as saved: secrets are never sent back, only whether one is stored. */
export function getSetup(agent, inputs) { const s = setups.get(agent); if (!s) return null; const { fields = {}, ...rest } = s; return { ...rest, fields: Object.fromEntries(Object.entries(fields).filter(([k]) => !/secret/.test(k))), has_secret: !!fields.secret || rest.has_secret }; }
export function saveSetup(agent, body = {}) {
  const prev = setups.get(agent) || {}; const fields = { ...(body.fields || {}) };
  if (!fields.secret && prev.fields?.secret) fields.secret = prev.fields.secret;
  const s = { ...prev, ...body, fields, saved_at: new Date().toISOString() }; setups.set(agent, s); return s;
}
export const runsOf = (agent) => runs.get(agent) || [];
export function addRun(agent, run) { runs.set(agent, [{ at: new Date().toISOString(), ...run }, ...runsOf(agent)].slice(0, 10)); }
export const webhookUrl = (base, agent) => `${base}/hooks/${agent.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${(agent.length * 7919).toString(36)}`;
export const hasSetup = (agent) => !!setups.get(agent)?.connector;
