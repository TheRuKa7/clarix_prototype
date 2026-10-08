// Orchestration (routing) for the local Clarix mock.
//
// One upload, split by rules into routes; each route sends its rows to one agent. A row goes to the first route it
// matches. Clarix only decides which agent gets which rows: how rows become calls (grouping, rows per call) is the
// agent's own plan in Echo, shown here read only. Nothing is assumed about the file: columns and values come from
// a sample file (a recent upload, or one the user uploads to test with).
import { randomBytes } from 'node:crypto';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const listOf = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
export function ruleMatches(rule, row) {
  if (!rule.field) return true; // an unfinished rule does not block anything
  const cell = row[rule.field]; const a = String(cell ?? '').trim().toLowerCase(); const b = String(rule.value ?? '').trim().toLowerCase();
  switch (rule.operator) {
    case 'EQUALS': return a === b;
    case 'NOT_EQUALS': return a !== b;
    case 'CONTAINS': return b !== '' && a.includes(b);
    case 'NOT_CONTAINS': return b === '' || !a.includes(b);
    case 'IS_NULL': return blank(cell);
    case 'IS_NOT_NULL': return !blank(cell);
    case 'IN': return listOf(rule.value).includes(a);
    case 'NOT_IN': return !listOf(rule.value).includes(a);
    default: return false;
  }
}

export function registerOrchestration({ on, ok, fail, multipart, readSheet, templates, sheets, batches, agentByKey, nowIso }) {
  const samples = new Map(); // id -> { id, name, rows: [{col: value}], uploaded }
  const fromBatch = (s) => { const b = batches.find((x) => x.id === s.id); return b ? b.rows.map((r) => ({ contact_name: r.name, contact_phone: r.phone, contact_email: r.email || '', supplier_id: r.supplier_id || '', ...(r.context || {}) })) : []; };
  const recent = () => sheets.filter((s) => batches.some((b) => b.id === s.id)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 6).map((s) => ({ id: `sheet:${s.id}`, name: s.originalFilename || s.templateName, rows: s.total, uploaded: false }));
  const sampleOf = (id) => { if (samples.has(id)) return samples.get(id); if (String(id).startsWith('sheet:')) { const s = sheets.find((x) => `sheet:${x.id}` === id); if (s) return { id, name: s.originalFilename || s.templateName, rows: fromBatch(s), uploaded: false }; } return null; };
  const describe = (s) => {
    const cols = [...new Set(s.rows.flatMap((r) => Object.keys(r)))];
    return { id: s.id, name: s.name, rows: s.rows.length, uploaded: !!s.uploaded, columns: cols.map((name) => {
      const count = new Map(); let blanks = 0;
      for (const r of s.rows) { if (blank(r[name])) { blanks++; continue; } const v = String(r[name]).trim(); count.set(v, (count.get(v) || 0) + 1); }
      // Values are offered to pick from only when the column repeats; ids, dates and free text are typed instead.
      const values = count.size <= 30 ? [...count.entries()].sort((a, b) => b[1] - a[1]).map(([value, rows]) => ({ value, rows })) : [];
      return { name, distinct: count.size, blanks, values };
    }) };
  };
  on('GET', '/api/v1/workflows/orchestration/samples', () => ok([...[...samples.values()].map((s) => ({ id: s.id, name: s.name, rows: s.rows.length, uploaded: true })), ...recent()]));
  on('GET', '/api/v1/workflows/orchestration/samples/:id', ({ p }) => { const s = sampleOf(p.id); s ? ok(describe(s)) : fail(404, 'File not found'); });
  on('POST', '/api/v1/workflows/orchestration/samples', ({ req, raw }) => {
    const form = multipart(req, raw); const file = form.file; if (!file?.filename) return fail(400, 'Choose a file');
    const table = readSheet(file); if (table.length < 2) return fail(400, 'The file needs a header row and at least one row');
    const head = table[0].map((h) => String(h).trim()); const rows = table.slice(1).filter((r) => r.some((c) => !blank(c))).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
    const s = { id: `up_${randomBytes(4).toString('hex')}`, name: file.filename, rows, uploaded: true }; samples.set(s.id, s); ok(describe(s));
  });

  // How the route's agent turns rows into calls: read from the agent's own setup in Echo, never set here.
  const planOf = (t) => {
    const a = t && agentByKey(t.providerAgentId); const plan = a?.input_plan;
    const inputs = [...(t?.contextMappings || []).filter((m) => m.required).map((m) => m.fieldName), 'contact_phone'];
    if (plan?.mode === 'group' && plan.group_by) return { grouped: true, groupBy: plan.group_by, maxRows: Number(plan.max_rows) || 8, text: `One call per ${plan.group_by.replace(/_/g, ' ')}, up to ${Number(plan.max_rows) || 8} rows a call`, inputs };
    return { grouped: false, groupBy: '', maxRows: 1, text: 'One call per row', inputs };
  };
  function preview(def, s) {
    const cols = [...new Set(s.rows.flatMap((r) => Object.keys(r)))]; const byNorm = new Map(cols.map((c) => [norm(c), c]));
    const lanes = (def.lanes || []).map((l, i) => ({ ...l, i, rows: [] })); const unmatched = [];
    for (const r of s.rows) { const hit = lanes.find((l) => (l.filterRules || []).every((rule) => ruleMatches(rule, r))); (hit ? hit.rows : unmatched).push(r); }
    const result = (name, rows, templateId, i) => {
      const t = templates.find((x) => x.id === templateId); const plan = planOf(t);
      const phoneCol = byNorm.get('contactphone') || byNorm.get('phonenumber') || byNorm.get('phone'); const groupCol = plan.grouped ? byNorm.get(norm(plan.groupBy)) : phoneCol;
      const groups = new Map(); for (const r of rows) { const k = groupCol ? String(r[groupCol] ?? '').trim() || `row${groups.size}` : `row${groups.size}`; groups.set(k, (groups.get(k) || 0) + 1); }
      const calls = plan.grouped ? [...groups.values()].reduce((n, c) => n + Math.ceil(c / plan.maxRows), 0) : rows.length;
      return { index: i, name, rows: rows.length, agent: t?.name || '', agentSet: !!t, plan: t ? plan.text : '', contacts: groups.size, calls,
        missing: t ? plan.inputs.filter((k) => !byNorm.has(norm(k))) : [], unusedRules: [] };
    };
    const out = lanes.map((l) => result(l.name, l.rows, l.targetTemplateId, l.i));
    // Rules that point at a column the file does not have never match: say so instead of showing a silent zero.
    lanes.forEach((l, i) => { out[i].unusedRules = (l.filterRules || []).filter((rule) => rule.field && !cols.includes(rule.field)).map((rule) => rule.field); });
    const rest = def.unmatched?.action === 'route' ? result('Everything else', unmatched, def.unmatched.targetTemplateId, -1) : { index: -1, name: 'Everything else', rows: unmatched.length, agent: '', agentSet: false, plan: '', contacts: 0, calls: 0, missing: [], unusedRules: [] };
    return { file: s.name, total: s.rows.length, routes: out, rest: { ...rest, leftOut: def.unmatched?.action !== 'route' }, routed: s.rows.length - (def.unmatched?.action === 'route' ? 0 : unmatched.length) };
  }
  on('POST', '/api/v1/workflows/orchestration/preview', ({ body }) => { const s = sampleOf(body.sampleId); if (!s) return fail(404, 'File not found'); ok(preview(body.definition || {}, s)); });

  // Saved orchestrations
  const defs = [];
  const clean = (b, old = {}) => ({ name: String(b.name ?? old.name ?? '').trim().slice(0, 80) || 'Untitled', updatedAt: nowIso(),
    lanes: (Array.isArray(b.lanes) ? b.lanes : old.lanes || []).map((l, i) => ({ laneId: l.laneId || `lane_${randomBytes(3).toString('hex')}`, name: String(l.name || `Route ${i + 1}`).slice(0, 60), order: i, filterRules: (l.filterRules || []).map((r) => ({ field: r.field || '', operator: r.operator || 'EQUALS', value: r.value ?? '' })), targetTemplateId: l.targetTemplateId || undefined })),
    unmatched: { action: b.unmatched?.action === 'route' ? 'route' : 'leave', targetTemplateId: b.unmatched?.targetTemplateId || undefined } });
  on('GET', '/api/v1/workflows/orchestration', () => ok(defs));
  on('POST', '/api/v1/workflows/orchestration', ({ body }) => { const d = { id: `orc_${randomBytes(4).toString('hex')}`, createdAt: nowIso(), ...clean(body) }; defs.push(d); ok(d); });
  on('GET', '/api/v1/workflows/orchestration/:id', ({ p }) => { const d = defs.find((x) => x.id === p.id); d ? ok(d) : fail(404, 'Not found'); });
  on('PUT', '/api/v1/workflows/orchestration/:id', ({ p, body }) => { const d = defs.find((x) => x.id === p.id); if (!d) return fail(404, 'Not found'); Object.assign(d, clean(body, d)); ok(d); });
  on('DELETE', '/api/v1/workflows/orchestration/:id', ({ p }) => { const i = defs.findIndex((x) => x.id === p.id); if (i >= 0) defs.splice(i, 1); ok({}); });

  // One example built from the newest upload's own columns, so the page opens on something real.
  const first = recent()[0] && sampleOf(recent()[0].id);
  if (first) {
    const d = describe(first); const col = d.columns.filter((c) => c.values.length >= 2 && c.values.length <= 8 && !/phone|email|name$/i.test(c.name)).sort((a, b) => a.values.length - b.values.length)[0];
    const active = templates.filter((t) => t.status === 'ACTIVE');
    if (col && active.length) defs.push({ id: 'orc_example', createdAt: nowIso(), ...clean({ name: 'Example: split one upload', lanes: [
      { name: `${col.name.replace(/_/g, ' ')} is ${col.values[0].value}`, filterRules: [{ field: col.name, operator: 'EQUALS', value: col.values[0].value }], targetTemplateId: active[0].id },
      { name: `${col.name.replace(/_/g, ' ')} is ${col.values[1].value}`, filterRules: [{ field: col.name, operator: 'EQUALS', value: col.values[1].value }], targetTemplateId: (active[1] || active[0]).id }] }) });
  }
}
