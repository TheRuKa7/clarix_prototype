// Pipelines for the local Clarix mock: one spec (ClarixPipelineSpec) takes any source to calls and back.
//
//   1 Ingest   one or more sheets, an API or a webhook, turned into plain rows that remember where they came from
//   2 Clean    types (ids stay text, dates become YYYY-MM-DD, phones +91…), derived columns, drop rules
//   3 Route    lanes, first match wins; each lane is one agent
//   4 Enrich   lookups by a key (plant id, supplier id), cached per key; rows still without a phone are set aside
//   5 Reshape  one row one call, one row many calls (unnest a list, remove repeats) or many rows one call (group)
//   6 Project  each call's inputs for its agent, spoken or kept internal, plus the source rows it stands for
//   7 Explode  one call's answers written back to every source row it stands for
//
// Every row carries _row_id; every call carries _row_ids, so an answer always finds its way back.
import { ruleMatches } from './orchestration.mjs';

const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const pick = (arr, seed) => arr[hash(seed) % arr.length];
const TODAY = '2026-11-06';
const dayMs = 86400000;

// ── Cleaning ──────────────────────────────────────────────────────────────────
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, m, d) => (y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : '');
export function toDate(v) {
  if (blank(v)) return { value: '' };
  const s = String(v).trim();
  if (/^\d{5}(\.\d+)?$/.test(s)) { const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * dayMs); return { value: d.toISOString().slice(0, 10), fixed: 'Excel date number' }; }
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/); if (m) return { value: iso(+m[1], +m[2], +m[3]) || null };
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/); if (m) return { value: iso(+m[3], +m[2], +m[1]) || null, fixed: 'day-month-year' };
  m = s.match(/^(\d{1,2})[ -]([a-z]{3})[a-z]*[\s,-]+(\d{4})$/i); if (m && MONTHS[m[2].toLowerCase()]) return { value: iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]), fixed: 'written month' };
  return { value: null };
}
export function toPhone(v) {
  if (blank(v)) return { value: '' };
  let d = String(v).replace(/[^\d+]/g, ''); if (d.startsWith('+91')) d = d.slice(3); else if (d.startsWith('0091')) d = d.slice(4); else if (d.length === 12 && d.startsWith('91')) d = d.slice(2); else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  const raw = String(v).replace(/\D/g, '');
  return /^[6-9]\d{9}$/.test(d) ? { value: `+91${d}`, fixed: raw.length > 10 && !raw.startsWith('91') ? 'leading 0 removed' : undefined } : { value: null };
}
export function toId(v) {
  if (blank(v)) return { value: '' };
  const s = String(v).trim();
  // A long number saved as a number in Excel arrives as 1.9E+17: the last digits are gone and cannot be guessed.
  if (/^\d(\.\d+)?e\+?\d+$/i.test(s)) return { value: null, why: 'saved by Excel as a number (1.9E+17), so the last digits are lost' };
  if (/^\d+\.0+$/.test(s)) return { value: s.replace(/\.0+$/, ''), fixed: 'trailing .0' };
  return { value: s };
}
const CASTS = { id: toId, date: toDate, phone: toPhone, number: (v) => (blank(v) ? { value: '' } : Number.isFinite(Number(String(v).replace(/,/g, ''))) ? { value: Number(String(v).replace(/,/g, '')) } : { value: null }), text: (v) => ({ value: blank(v) ? '' : String(v).trim().replace(/\s+/g, ' ') }) };
const TYPE_WORD = { id: 'id', date: 'date', phone: 'phone number', number: 'number', text: 'text' };

function derive(rule, row) {
  const v = (k) => row[k];
  switch (rule.fn) {
    case 'days_until': { const d = v(rule.of); return blank(d) ? '' : Math.round((Date.parse(d) - Date.parse(TODAY)) / dayMs); }
    case 'concat': return (rule.of || []).map(v).filter((x) => !blank(x)).join(rule.sep ?? ' ');
    case 'lower': return String(v(rule.of) ?? '').toLowerCase();
    case 'const': return rule.value;
    default: return '';
  }
}
// A lane matches when any of its groups matches; inside a group every rule must match.
const NUM_OPS = { LT: (a, b) => a < b, LTE: (a, b) => a <= b, GT: (a, b) => a > b, GTE: (a, b) => a >= b };
export function ruleOk(rule, row) {
  if (NUM_OPS[rule.operator]) { const a = Number(row[rule.field]); return rule.field && !blank(row[rule.field]) && Number.isFinite(a) && NUM_OPS[rule.operator](a, Number(rule.value)); }
  return ruleMatches(rule, row);
}
const groupOk = (g, row) => (g.rules || []).every((r) => ruleOk(r, row));
const OP_WORD = { EQUALS: 'is', NOT_EQUALS: 'is not', CONTAINS: 'contains', NOT_CONTAINS: 'does not contain', IN: 'is one of', NOT_IN: 'is none of', IS_NULL: 'is empty', IS_NOT_NULL: 'is filled', LT: '<', LTE: '≤', GT: '>', GTE: '≥' };
export const whenOk = (when, row) => !when?.length || when.some((g) => groupOk(g, row));

// ── Lookups (enrichment) ──────────────────────────────────────────────────────
// Stand-ins for a customer's own APIs and SQL functions. Real ones are Data functions (Build > Data).
const FIRST = ['Sanjeev', 'Ritika', 'Avinash', 'Megha', 'Rohit', 'Farhan', 'Kavita', 'Imran', 'Pooja', 'Vikram', 'Neelam', 'Arjun'];
const LAST = ['Kumar', 'Sharma', 'Telrandhe', 'Iyer', 'Gupta', 'Shaikh', 'Nair', 'Bansal', 'Reddy', 'Joshi'];
const phoneFor = (seed) => `${pick(['98', '97', '95', '88', '70', '63'], seed)}${String(hash(seed + 'p') % 100000000).padStart(8, '0')}`;
export const LOOKUPS = {
  eoc_plant_details: {
    label: 'EOC plant details', kind: 'REST', call: 'GET /account/plant/getDetails/{plantId}', params: ['plantId'], returns_list: 'plantCustomerPocDtoList',
    run: ({ plantId }) => {
      if (String(plantId).endsWith('7')) return { kamName: '', plantCustomerPocDtoList: [] }; // a plant with nobody on record
      const n = 2 + (hash(plantId) % 3); const people = Array.from({ length: 1 + (hash(plantId + 'x') % 2) + 1 }, (_, i) => ({ name: `${pick(FIRST, plantId + i)} ${pick(LAST, plantId + 'l' + i)}`, phone: phoneFor(plantId + i), email: `${pick(FIRST, plantId + i).toLowerCase()}@plant${plantId}.in` }));
      const roles = ['PRIMARY_CUSTOMER_POC', 'CUSTOMER_CPO', 'CUSTOMER_PURCHASER', 'CUSTOMER_FINANCE'];
      // The same person often holds several roles: those become one call.
      return { kamName: pick(['Avinash', 'Megha', 'Rohit'], plantId), cityState: pick(['Mathura, Uttar Pradesh', 'Pune, Maharashtra', 'Hosur, Tamil Nadu', 'Sanand, Gujarat'], plantId),
        plantCustomerPocDtoList: Array.from({ length: n }, (_, i) => ({ ...people[i % people.length], pocType: roles[i] })) };
    },
  },
  supplier_details_lookup: {
    label: 'Supplier master lookup', kind: 'SQL', call: 'supplier_details_lookup(:supplier_id)', params: ['supplier_id'],
    run: ({ supplier_id }) => (String(supplier_id).endsWith('3') ? {} : { contact_name: `${pick(FIRST, supplier_id)} ${pick(LAST, supplier_id + 'l')}`, contact_phone: phoneFor(supplier_id), contact_email: `orders@supplier${supplier_id}.com` }),
  },
};

// ── Samples: the three PRD cases, with the mess real files have ──────────────
const PLANTS = ['Strolar Mounting Systems', 'Bamnoli Castings', 'Vision Safety Gear', 'Hosur Polymers', 'Sanand Wires', 'Kirti Fasteners', 'Shree Forge', 'Alpine Pumps'];
const SUPPLIERS = [['102897', 'Apex Safety Gear'], ['3054', 'Everest Cables'], ['63547', 'Orbit Packaging'], ['82787', 'Surya Pumps and Valves'], ['41203', 'Kiran Tools'], ['55810', 'Lata Industrial'], ['77012', 'Blue Star Bearings'], ['90233', 'Raj Electricals']];
const ITEMS = [['OSG 3130 4 Flute End Mill', 'pcs'], ['Safety Shoe S3 Size 9', 'pair'], ['FRLS Cable 4 sq mm', 'm'], ['Ball Valve 2 inch', 'pcs'], ['Nitrile Gloves L', 'box'], ['Hex Bolt M12x50', 'pcs'], ['Corrugated Box 5 ply', 'pcs'], ['Bearing 6205 ZZ', 'pcs']];
function omtRows() {
  const plants = ['Pune Plant', 'Hosur Plant', 'Sanand Plant'];
  const out = { 'Acceptance call': [], 'Next 15 days CDD call': [], 'Lead Time calling': [] };
  let spo = 5000, item = 0;
  for (const [si, [sid, sname]] of SUPPLIERS.entries()) for (const plant of plants) {
    const pos = 1 + (hash(sid + plant) % 3);
    for (let p = 0; p < pos; p++) { spo++; const lines = 1 + (hash(sid + plant + p) % 5);
      for (let l = 0; l < lines; l++) { item++;
        const [desc, uom] = pick(ITEMS, sid + p + l); const seed = `${sid}${plant}${p}${l}`;
        const status = pick(['ACCEPTANCE_PENDING', 'ACCEPTED', 'ACCEPTED', 'PACKED', 'ACCEPTED'], seed);
        const cddIn = (hash(seed + 'c') % 40) - 3; const cdd = new Date(Date.parse(TODAY) + cddIn * dayMs).toISOString().slice(0, 10);
        const tab = status === 'ACCEPTANCE_PENDING' ? 'Acceptance call' : cddIn <= 15 ? 'Next 15 days CDD call' : 'Lead Time calling';
        const r = { spo_id: String(spo), spo_item_id: String(100000 + item), item_ref: `1900002525${String(item).padStart(8, '0')}`, supplier_id: sid, supplier_name: sname, Plant_Name: plant,
          MSN_Description: desc, PO_Pending_Qty: String(5 + (hash(seed + 'q') % 200)), uom, PO_Item_Status_Value: status, omt_status: status === 'PACKED' ? 'READY' : 'OPEN', omt_remark: '', Supplier_PO_Date: '', Pickup_Scheduled_Date: '', final_cdd: cdd, sourcer_name: pick(['zeeshan.j', 'priya.m', 'arun.k'], sid), Team_Name: pick(['North', 'West', 'South'], plant) };
        // What real exports look like: Excel date numbers, written dates, ids that became numbers, rows not to call.
        const poDay = Date.parse(TODAY) - (10 + (hash(seed) % 50)) * dayMs; const d = new Date(poDay);
        r.Supplier_PO_Date = item % 4 === 0 ? String(Math.round(poDay / dayMs + 25569)) : item % 4 === 1 ? `${d.getUTCDate()}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}-${d.getUTCFullYear()}` : d.toISOString().slice(0, 10);
        r.Pickup_Scheduled_Date = new Date(Date.parse(cdd) - 2 * dayMs).toISOString().slice(0, 10);
        if (item % 11 === 0) r.omt_remark = 'Schedule order; no need to call.';
        if (item === 7) r.item_ref = '1.90000252500000E+17';
        if (item % 13 === 0) r.PO_Pending_Qty = `${r.PO_Pending_Qty}.0`;
        out[tab].push(r); } }
  }
  return out;
}
const kycRows = () => ({ Plants: PLANTS.map((n, i) => ({ plantId: String(28670 + i), plantName: `${n} Pvt. Ltd.`, kycStatus: String([1, 2, 5, 3, 1, 2, 5, 1][i]) })) });
const rfxRows = () => ({ 'RFX events': Array.from({ length: 10 }, (_, i) => { const [sid, sname] = SUPPLIERS[i % SUPPLIERS.length]; const ok = i % 4 !== 2;
  return { rfq_event_number: `RFQ-26-${4100 + i}`, pr_number: `PR${880100 + i}`, rfq_event_header: pick(['Safety gear annual rate contract', 'Cable drums for Sanand line', 'Bearings for conveyor overhaul', 'Packaging material Q1'], 'h' + i), buyer_org: pick(['Moglix Pune', 'Moglix Hosur'], 'o' + i), buyer: pick(['Neha Kapoor', 'Arun Kumar'], 'b' + i), category: pick(['MRO', 'Electrical', 'Packaging'], 'c' + i),
    portal_name: pick(['Ariba', 'SAP', 'EOC'], 'p' + i), supplier_id: sid, supplier_name: sname, contact_person: ok ? `${pick(FIRST, sid)} ${pick(LAST, sid)}` : '', contact_phone: ok ? (i % 3 === 0 ? `0${phoneFor(sid)}` : phoneFor(sid)) : '', contact_email: ok ? `sales@supplier${sid}.com` : '', event_timing: `${8 + (i % 5)}-Nov-2026 17:00` }; }) });

const SPECS = [
  { id: 'kyc', name: 'Plant KYC verification', case: '1 row to many calls',
    source: { kind: 'sheet', label: 'plant_kyc_list.xlsx', sheets: ['Plants'], sample: 'kyc' },
    clean: { types: { plantId: 'id', plantName: 'text', kycStatus: 'text' }, derive: [], drop: [{ label: 'KYC already done', rules: [{ field: 'kycStatus', operator: 'NOT_IN', value: '1,2,5' }] }] },
    lanes: [{ id: 'meera', name: 'KYC check', agent: 'Meera · Plant KYC', when: [],
      enrich: [{ lookup: 'eoc_plant_details', by: { plantId: 'plantId' }, take: { kam_name: 'kamName', city_state: 'cityState' }, list: 'plantCustomerPocDtoList' }],
      reshape: { mode: 'fan_out', item: { contact_name: 'name', contact_phone: 'phone', contact_email: 'email', poc_type: 'pocType' }, dedupe: ['plantId', 'contact_phone'], merge: { poc_type: 'concat_distinct' } },
      project: [{ input: 'plant_id', from: 'plantId', spoken: false }, { input: 'plant_name', from: 'plantName', spoken: true }, { input: 'contact_name', from: 'contact_name', spoken: true }, { input: 'contact_phone', from: 'contact_phone', spoken: true }, { input: 'contact_email', from: 'contact_email', spoken: true }, { input: 'poc_type', from: 'poc_type', spoken: false }, { input: 'city_state', from: 'city_state', spoken: true }, { input: 'kam_name', from: 'kam_name', spoken: true }],
      outputs: { kyc_verification_status: ['VERIFIED', 'VERIFIED', 'VERIFIED', 'UPDATED_DETAILS', 'LEFT_COMPANY', 'CALLBACK_REQUESTED', 'NO_RESPONSE'] },
      writeback: { key: ['plantId', 'poc_type'], to: 'EOC plant POC (PATCH /account/plant/poc)' } }],
    unmatched: { action: 'leave' } },
  { id: 'omt', name: 'PAN India OMT post-PO', case: 'Many rows to 1 call',
    source: { kind: 'sheet', label: 'PAN_India_Enterprise_OMT_report.xlsx', sheets: ['Acceptance call', 'Next 15 days CDD call', 'Lead Time calling'], sample: 'omt' },
    clean: { types: { spo_id: 'id', spo_item_id: 'id', item_ref: 'id', supplier_id: 'id', PO_Pending_Qty: 'number', Supplier_PO_Date: 'date', Pickup_Scheduled_Date: 'date', final_cdd: 'date' },
      derive: [{ key: 'days_to_cdd', fn: 'days_until', of: 'final_cdd', label: 'Days to CDD' }],
      drop: [{ label: 'Remark says no need to call', rules: [{ field: 'omt_remark', operator: 'CONTAINS', value: 'no need to call' }] }] },
    lanes: [
      { id: 'acc', name: '01 Acceptance', agent: 'Saaniya · PO acceptance', when: [{ rules: [{ field: 'PO_Item_Status_Value', operator: 'EQUALS', value: 'ACCEPTANCE_PENDING' }] }] },
      { id: 'ready', name: '04 Material ready', agent: 'Roma · Material ready', when: [{ rules: [{ field: 'omt_status', operator: 'EQUALS', value: 'READY' }] }] },
      { id: 'cdd', name: '02 CDD within 15 days', agent: 'Saaniya · CDD follow-up', when: [{ rules: [{ field: 'days_to_cdd', operator: 'LTE', value: '15' }] }] },
      { id: 'lead', name: '03 Lead time', agent: 'Roma · Lead time', when: [{ rules: [{ field: 'days_to_cdd', operator: 'GT', value: '15' }] }] },
    ].map((l) => ({ ...l,
      enrich: [{ lookup: 'supplier_details_lookup', by: { supplier_id: 'supplier_id' }, take: { contact_name: 'contact_name', contact_phone: 'contact_phone', contact_email: 'contact_email' } }],
      reshape: { mode: 'fan_in', group_by: ['supplier_id', 'Plant_Name'], max_rows: 10,
        aggregates: [{ key: 'po_count', fn: 'count_distinct', of: 'spo_id' }, { key: 'item_count', fn: 'count' }, { key: 'target_dispatch_date', fn: 'min', of: 'Pickup_Scheduled_Date' }, { key: 'po_date', fn: 'min', of: 'Supplier_PO_Date' }],
        lines: { key: 'lines_block', format: '{MSN_Description} · {PO_Pending_Qty} {uom} · PO {spo_id}' } },
      project: [{ input: 'supplier_id', from: 'supplier_id', spoken: false }, { input: 'supplier_name', from: 'supplier_name', spoken: true }, { input: 'plant_name', from: 'Plant_Name', spoken: true }, { input: 'contact_name', from: 'contact_name', spoken: true }, { input: 'contact_phone', from: 'contact_phone', spoken: true }, { input: 'po_count', from: 'po_count', spoken: true }, { input: 'item_count', from: 'item_count', spoken: true }, { input: 'target_dispatch_date', from: 'target_dispatch_date', spoken: true }, { input: 'po_date', from: 'po_date', spoken: true }, { input: 'lines_block', from: 'lines_block', spoken: true }],
      outputs: { outcome: ['CONFIRMED', 'CONFIRMED', 'NEW_DATE_GIVEN', 'QUERY_PENDING', 'CALLBACK_REQUESTED', 'NO_RESPONSE'] },
      writeback: { key: ['spo_item_id'], to: 'OMT sheet and business export (14 columns)' } })),
    unmatched: { action: 'leave' } },
  { id: 'rfx', name: 'Pre-PO RFX reminders', case: '1 row to 1 call',
    source: { kind: 'webhook', label: 'Ariba / SAP / EOC RFX events', sheets: ['RFX events'], sample: 'rfx' },
    clean: { types: { contact_phone: 'phone', supplier_id: 'id', event_timing: 'text' }, derive: [], drop: [] },
    lanes: [{ id: 'neha', name: 'RFX reminder', agent: 'Neha · Pre-PO RFX', when: [],
      enrich: [{ lookup: 'supplier_details_lookup', by: { supplier_id: 'supplier_id' }, take: { contact_person: 'contact_name', contact_phone: 'contact_phone', contact_email: 'contact_email' }, only_blank: true }],
      reshape: { mode: 'one' },
      project: ['contact_person', 'contact_email', 'buyer_org', 'rfq_event_number', 'pr_number', 'rfq_event_header', 'event_timing', 'buyer', 'category', 'supplier_name', 'portal_name'].map((k) => ({ input: k, from: k, spoken: true }))
        .concat([{ input: 'contact_phone', from: 'contact_phone', spoken: false }, { input: 'supplier_id', from: 'supplier_id', spoken: false }]),
      outputs: { rfx_status: ['WILL_QUOTE', 'WILL_QUOTE', 'NEEDS_EXTENSION', 'NOT_INTERESTED', 'NO_RESPONSE'] },
      writeback: { key: ['rfq_event_number', 'supplier_id'], to: 'Webhook to the RFX portal' } }],
    unmatched: { action: 'leave' } },
];
const SAMPLE_DATA = { kyc: kycRows, omt: omtRows, rfx: rfxRows };

// ── The run ───────────────────────────────────────────────────────────────────
const fill = (fmt, r) => fmt.replace(/\{(\w+)\}/g, (_, k) => (blank(r[k]) ? '' : String(r[k])));
function aggregate(fn, rows, of) {
  const vals = of ? rows.map((r) => r[of]).filter((v) => !blank(v)) : rows;
  switch (fn) {
    case 'count': return rows.length;
    case 'count_distinct': return new Set(vals.map(String)).size;
    case 'sum': return vals.reduce((n, v) => n + Number(v || 0), 0);
    case 'min': return vals.length ? vals.map(String).sort()[0] : '';
    case 'max': return vals.length ? vals.map(String).sort().at(-1) : '';
    case 'list': return [...new Set(vals.map(String))].join(', ');
    default: return '';
  }
}

export function runPipeline(spec, sheets) {
  const quarantine = []; const fixes = new Map(); const note = (what) => fixes.set(what, (fixes.get(what) || 0) + 1);
  const setAside = (stage, row, reason, lane = '') => quarantine.push({ stage, lane, row_id: row._row_id, reason, row: Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('_')).slice(0, 8)) });

  // 1 Ingest: every sheet becomes rows that remember their sheet and line.
  const ingested = []; const perSheet = [];
  for (const name of spec.source.sheets) { const rows = sheets[name] || []; perSheet.push({ sheet: name, rows: rows.length });
    rows.forEach((r, i) => ingested.push({ ...r, _sheet: name, _line: i + 2, _row_id: `${name.slice(0, 3).toUpperCase()}-${i + 2}` })); }
  const columns = [...new Set(ingested.flatMap((r) => Object.keys(r).filter((k) => !k.startsWith('_'))))];

  // 2 Clean: cast types, derive, drop.
  const cleaned = []; const dropped = [];
  for (const raw of ingested) {
    const r = { ...raw }; let bad = '';
    for (const [col, type] of Object.entries(spec.clean.types || {})) {
      if (!(col in r)) continue; const res = CASTS[type](r[col]);
      if (res.value === null) { bad = `${col} "${raw[col]}" is not a valid ${TYPE_WORD[type]}${res.why ? `: ${res.why}` : ''}`; break; }
      if (res.fixed) note(`${col}: ${res.fixed}`); r[col] = res.value;
    }
    if (bad) { setAside('Clean', r, bad); continue; }
    for (const d of spec.clean.derive || []) r[d.key] = derive(d, r);
    const drop = (spec.clean.drop || []).find((d) => (d.rules || []).every((rule) => ruleOk(rule, r)));
    if (drop) { dropped.push({ row_id: r._row_id, reason: drop.label }); continue; }
    cleaned.push(r);
  }
  const droppedBy = Object.entries(dropped.reduce((a, d) => ((a[d.reason] = (a[d.reason] || 0) + 1), a), {})).map(([reason, rows]) => ({ reason, rows }));

  // 3 Route: the first lane whose rules match takes the row.
  const lanes = spec.lanes.map((l) => ({ spec: l, rows: [] })); const unmatched = [];
  for (const r of cleaned) { const hit = lanes.find((l) => whenOk(l.spec.when, r)); (hit ? hit.rows : unmatched).push(r); }

  const cache = new Map(); const lookupStats = {}; const calls = []; const laneOut = [];
  for (const lane of lanes) {
    const L = lane.spec; let rows = lane.rows; const q0 = quarantine.length;
    // 4 Enrich: one lookup per distinct key, however many rows share it.
    for (const e of L.enrich || []) {
      const fn = LOOKUPS[e.lookup]; const st = (lookupStats[e.lookup] ||= { lookup: e.lookup, label: fn.label, call: fn.call, kind: fn.kind, requests: 0, cached: 0, empty: 0 });
      const next = [];
      for (const r of rows) {
        if (e.only_blank && Object.keys(e.take || {}).every((k) => !blank(r[k]))) { next.push(r); continue; }
        const args = Object.fromEntries(Object.entries(e.by).map(([p, col]) => [p, r[col]]));
        const key = `${e.lookup}:${JSON.stringify(args)}`; let res = cache.get(key);
        if (res) st.cached++; else { res = fn.run(args); cache.set(key, res); st.requests++; if (!Object.keys(res).length) st.empty++; }
        const out = { ...r }; for (const [col, path] of Object.entries(e.take || {})) if (blank(out[col]) || !e.only_blank) out[col] = res[path] ?? out[col] ?? '';
        if (e.list) out._list = res[e.list] || [];
        next.push(out);
      }
      rows = next;
    }
    // 5 Reshape into calls.
    const R = L.reshape || { mode: 'one' }; let units = []; let ready = 0; let contacts = 0;
    if (R.mode === 'fan_out') {
      const flat = [];
      for (const r of rows) { if (!r._list?.length) { setAside('Enrich', r, 'The lookup found nobody to call for this row', L.name); continue; }
        for (const it of r._list) { const x = { ...r }; delete x._list; for (const [col, path] of Object.entries(R.item)) x[col] = it[path] ?? ''; x.contact_phone = toPhone(x.contact_phone).value || ''; flat.push(x); } }
      const by = new Map();
      for (const x of flat) { if (blank(x.contact_phone)) { setAside('Enrich', x, 'No valid phone number for this contact', L.name); continue; }
        const k = R.dedupe.map((c) => x[c]).join('|'); const u = by.get(k);
        if (!u) by.set(k, { fields: { ...x }, rows: [x], merged: Object.fromEntries(Object.keys(R.merge || {}).map((c) => [c, [x[c]]])) });
        else { u.rows.push(x); for (const c of Object.keys(R.merge || {})) u.merged[c].push(x[c]); } }
      ready = new Set(flat.map((x) => x._row_id)).size; contacts = flat.length;
      units = [...by.values()].map((u) => { for (const c of Object.keys(R.merge || {})) u.fields[c] = [...new Set(u.merged[c].filter(Boolean))].join(', '); return { fields: u.fields, rows: u.rows }; });
    } else {
      const okRows = [];
      for (const r of rows) { const p = toPhone(r.contact_phone).value; if (!p) { setAside('Enrich', r, blank(r.contact_phone) ? 'Still no phone number after the lookup' : `contact_phone "${r.contact_phone}" is not a valid phone number`, L.name); continue; } okRows.push({ ...r, contact_phone: p }); }
      ready = okRows.length;
      if (R.mode === 'fan_in') {
        const by = new Map(); for (const r of okRows) { const k = R.group_by.map((c) => r[c]).join('|'); (by.get(k) || by.set(k, []).get(k)).push(r); }
        for (const group of by.values()) for (let i = 0; i < group.length; i += R.max_rows || group.length) {
          const part = group.slice(i, i + (R.max_rows || group.length)); const f = { ...part[0] };
          for (const a of R.aggregates || []) f[a.key] = aggregate(a.fn, part, a.of);
          if (R.lines) f[R.lines.key] = part.map((r, n) => `${n + 1}. ${fill(R.lines.format, r)}`).join('\n');
          units.push({ fields: f, rows: part, part: group.length > (R.max_rows || group.length) ? `${Math.floor(i / R.max_rows) + 1} of ${Math.ceil(group.length / R.max_rows)}` : '' });
        }
      } else units = okRows.map((r) => ({ fields: r, rows: [r] }));
    }
    // 6 Project: what the agent is given, and what it may say.
    let laneCalls = 0;
    for (const u of units) {
      const inputs = (L.project || []).map((m) => ({ input: m.input, value: u.fields[m.from] ?? '', spoken: m.spoken }));
      const missing = inputs.filter((x) => blank(x.value) && x.input !== 'contact_email').map((x) => x.input);
      if (missing.length) { setAside('Project', u.fields, `Missing input${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`, L.name); continue; }
      laneCalls++;
      calls.push({ call_id: `${L.id}-${String(laneCalls).padStart(3, '0')}`, lane: L.id, lane_name: L.name, agent: L.agent, phone: u.fields.contact_phone, part: u.part || '',
        inputs, row_ids: u.rows.map((r) => r._row_id), source: u.rows.map((r) => Object.fromEntries((L.writeback?.key || []).map((k) => [k, r[k]]))) });
    }
    laneOut.push({ id: L.id, name: L.name, agent: L.agent, rows: lane.rows.length, ready, contacts, reshape: R.mode, calls: laneCalls, set_aside: quarantine.length - q0,
      rule: (L.when || []).map((g) => (g.rules || []).map((r) => `${r.field} ${OP_WORD[r.operator] || r.operator} ${r.value}`.trim()).join(' and ')).join(' or ') || 'Every row' });
  }

  const rowsToCall = laneOut.reduce((n, l) => n + l.ready, 0); const contacts = laneOut.reduce((n, l) => n + l.contacts, 0);
  const asideLater = quarantine.filter((q) => q.stage !== 'Clean').length;
  return {
    id: spec.id, name: spec.name, columns,
    funnel: [
      { key: 'ingest', label: 'Rows read', value: ingested.length, note: perSheet.map((s) => `${s.sheet} ${s.rows}`).join(' · ') },
      { key: 'clean', label: 'Clean', value: cleaned.length, note: `${quarantine.filter((q) => q.stage === 'Clean').length} set aside · ${dropped.length} dropped by rule` },
      { key: 'route', label: 'Routed to an agent', value: cleaned.length - unmatched.length, note: `${lanes.length} lane${lanes.length === 1 ? '' : 's'} · ${unmatched.length} matched none` },
      { key: 'enrich', label: 'Ready to call', value: rowsToCall, note: `${contacts ? `${contacts} contacts found · ` : ''}${asideLater} set aside` },
      { key: 'calls', label: 'Calls', value: calls.length, note: !calls.length || !rowsToCall ? '' : calls.length === rowsToCall ? 'one call per row' : calls.length > rowsToCall ? `${(calls.length / rowsToCall).toFixed(1)} calls per row, repeats removed` : `${(rowsToCall / calls.length).toFixed(1)} rows per call` },
    ],
    fixes: [...fixes.entries()].map(([what, rows]) => ({ what, rows })), dropped: droppedBy, unmatched: unmatched.length,
    lanes: laneOut, lookups: Object.values(lookupStats), quarantine, calls,
  };
}

// 7 Explode: pretend every call has finished and write its answers back to each row it stands for.
export function explode(spec, run) {
  const rows = []; const tally = {};
  for (const c of run.calls) {
    const L = spec.lanes.find((l) => l.id === c.lane); const answers = Object.fromEntries(Object.entries(L.outputs || {}).map(([k, opts]) => [k, pick(opts, c.call_id + k)]));
    const first = Object.values(answers)[0]; tally[first] = (tally[first] || 0) + 1;
    c.source.forEach((src, i) => rows.push({ row_id: c.row_ids[i], call_id: c.call_id, lane: c.lane_name, key: src, ...answers }));
  }
  const lanes = spec.lanes.map((l) => ({ name: l.name, to: l.writeback?.to || '', key: l.writeback?.key || [], calls: run.calls.filter((c) => c.lane === l.id).length, rows: rows.filter((r) => r.lane === l.name).length }));
  return { calls: run.calls.length, rows: rows.length, lanes, outcomes: Object.entries(tally).map(([value, calls]) => ({ value, calls })).sort((a, b) => b.calls - a.calls), sample: rows.slice(0, 60) };
}

export function registerPipelines({ on, ok, fail, multipart, readSheet, nowIso }) {
  const specs = SPECS.map((s) => ({ ...structuredClone(s), updatedAt: nowIso() }));
  const uploads = new Map(); // spec id -> { name, sheets }
  const sheetsOf = (s) => uploads.get(s.id)?.sheets || SAMPLE_DATA[s.source.sample]?.() || {};
  const summary = (s) => ({ id: s.id, name: s.name, case: s.case, source: uploads.get(s.id)?.name || s.source.label, lanes: s.lanes.length, updatedAt: s.updatedAt });
  on('GET', '/api/v1/workflows/pipelines', () => ok(specs.map(summary)));
  on('GET', '/api/v1/workflows/pipelines/lookups', () => ok(Object.entries(LOOKUPS).map(([id, l]) => ({ id, label: l.label, kind: l.kind, call: l.call, params: l.params, returns_list: l.returns_list || '' }))));
  on('GET', '/api/v1/workflows/pipelines/:id', ({ p }) => { const s = specs.find((x) => x.id === p.id); s ? ok(s) : fail(404, 'Pipeline not found'); });
  on('PUT', '/api/v1/workflows/pipelines/:id', ({ p, body }) => {
    const s = specs.find((x) => x.id === p.id); if (!s) return fail(404, 'Pipeline not found');
    if (!Array.isArray(body?.lanes) || !body?.source || !body?.clean) return fail(400, 'A pipeline needs source, clean and lanes');
    Object.assign(s, structuredClone(body), { id: s.id, updatedAt: nowIso() }); ok(s);
  });
  // Runs the spec in the body when given, so an unsaved edit can be tried first.
  on('POST', '/api/v1/workflows/pipelines/:id/run', ({ p, body }) => {
    const s = specs.find((x) => x.id === p.id); if (!s) return fail(404, 'Pipeline not found');
    const spec = body?.spec?.lanes ? body.spec : s;
    try { const run = runPipeline(spec, sheetsOf(s)); ok({ ...run, source: uploads.get(s.id)?.name || s.source.label, ranAt: nowIso(), results: body?.results ? explode(spec, run) : null }); }
    catch (e) { fail(400, `The pipeline could not run: ${e.message}`); }
  });
  // Try the pipeline on your own file: each tab of the workbook is offered under the spec's sheet names, in order.
  on('POST', '/api/v1/workflows/pipelines/:id/source', ({ p, req, raw }) => {
    const s = specs.find((x) => x.id === p.id); if (!s) return fail(404, 'Pipeline not found');
    const form = multipart(req, raw); if (!form.file?.filename) return fail(400, 'Choose a file');
    const table = readSheet(form.file); if (table.length < 2) return fail(400, 'The file needs a header row and at least one row');
    const head = table[0].map((h) => String(h).trim()); const rows = table.slice(1).filter((r) => r.some((c) => !blank(c))).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
    uploads.set(s.id, { name: form.file.filename, sheets: { [s.source.sheets[0]]: rows } }); ok(summary(s));
  });
  on('DELETE', '/api/v1/workflows/pipelines/:id/source', ({ p }) => { uploads.delete(p.id); const s = specs.find((x) => x.id === p.id); s ? ok(summary(s)) : fail(404, 'Pipeline not found'); });
}
