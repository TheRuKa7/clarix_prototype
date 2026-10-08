// Local stand-in for the Clarix backend (:8081), CAS (:9000) and GenBI (:8000), so the
// live Clarix UI runs unchanged. Built from the same synthetic scenario.json as the Echo
// mock, so Clarix rows and Echo contacts are the same calls with the same ids.
//
// It copies live behaviour on purpose (Phase 0):
// - Exchange only reports connected calls, with {referenceId, status}, so every other row
//   stays IN_PROGRESS and gets a STATUS_SYNC event every 30 minutes for ever.
// - Completed Exchange rows carry no transcript, duration or captured fields.
// - "Answered %" and "commitments" are computed exactly like the live backend.
//
// When the Echo mock is running (ECHO_URL, default http://localhost:8090), a sheet uploaded
// here is handed to it and Echo posts the two field webhook back, as live.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { writeXlsx, readXlsx } from './xlsx.mjs';
import { planAttempts, rowTiming, reOutcome } from './ozonetel.mjs';
import { OUTCOMES } from './outcome.mjs';
import { registerReports } from './reports.mjs';
import { registerOrchestration } from './orchestration.mjs';

const PORT = Number(process.env.CLARIX_API_PORT || 8081);
const CAS_PORT = Number(process.env.CLARIX_CAS_PORT || 9000);
const GENBI_PORT = Number(process.env.CLARIX_GENBI_PORT || 8000);
const ECHO_URL = process.env.ECHO_URL || 'http://localhost:8090';
const APP_HOME = '/workflows/sheets';
const ORG = 'org_moglix';
const USER = 'admin@example.com';
const SYNC_MS = 30 * 60000;

// ── Scenario, shifted to now (same rules as the Echo mock) ───────────────────
const raw = JSON.parse(readFileSync(new URL('./scenario.json', import.meta.url), 'utf8'));
// Whole days only, so the Echo and Clarix mocks agree whenever each was started.
const SHIFT = Math.floor((Date.now() - Date.parse(raw.anchor)) / 86400000) * 86400000;
const DAY_SHIFT = Math.round(SHIFT / 86400000);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DMY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const dmy = (d) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
function shift(v) {
  if (Array.isArray(v)) return v.map(shift);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shift(x)]));
  if (typeof v === 'string' && ISO.test(v)) return new Date(Date.parse(v) + SHIFT).toISOString();
  if (typeof v === 'string' && DAY_SHIFT && DMY.test(v)) {
    const [, d, m, y] = v.match(DMY);
    return dmy(new Date(Date.UTC(+y, +m - 1, +d) + DAY_SHIFT * 86400000));
  }
  return v;
}
const S = shift(raw);
// target: Echo behaves as PRD-ECHO-11 says (every row gets a final status, full payload).
// live: today's behaviour (only connected calls come back, with two fields).
const MODE = process.env.MOCK_BEHAVIOUR === 'live' ? 'live' : 'target';
/** Clarix workflow state derived from Echo's call status (PRD-ECHO-11 section 14). */
const WORKFLOW_OF = (cs) => ['SCHEDULED', 'QUEUED', 'CALLING', 'IN_PROGRESS', 'RETRY_SCHEDULED'].includes(cs) ? 'IN_PROGRESS' : cs === 'COMPLETED' ? 'COMPLETED' : cs === 'CANCELLED' ? 'CANCELLED' : 'FAILED';

// ── Helpers ──────────────────────────────────────────────────────────────────
const hex24 = () => randomBytes(12).toString('hex');
const nowIso = () => new Date().toISOString();
const plus = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
const convIdOf = (execId) => execId.slice(0, 22) + 'cc';
const dataType = (t) => (t === 'boolean' ? 'BOOLEAN' : t === 'number' ? 'NUMBER' : t === 'date' ? 'DATE' : 'STRING');
const agentByKey = (k) => S.agents.find((a) => a.key === k);
const callById = (id) => S.calls.find((c) => c.call_id === id);
const FINISHED = ['COMPLETED', 'FAILED', 'CANCELLED', 'STOPPED'];

// ── Templates ────────────────────────────────────────────────────────────────
function templateFrom(t, agent, extra = {}) {
  const contactKeys = new Set(['contact_name', 'contact_phone', 'contact_email', 'phone_number']);
  return {
    id: t.id, templateKey: t.key, name: t.name, description: extra.description || '', orgId: ORG,
    callProviderKey: extra.provider || 'exchange', providerAgentId: agent.key,
    providerAgentSpec: { voice: agent.voice || 'Aoede', language: 'hi-IN', direction: 'OUTBOUND', lastPublishedAt: agent.created_at },
    defaultChannelType: 'CALL', status: extra.status || 'ACTIVE', triggerEventTypes: [extra.event || 'PO_PENDING_ACCEPTANCE'],
    contactExtractionConfig: { phoneJsonPath: '$.contact_phone', nameJsonPath: '$.contact_name', emailJsonPath: '$.contact_email' },
    contextMappings: agent.input_variables.filter((v) => !contactKeys.has(v.key)).map((v) => ({ fieldName: v.key, jsonPath: `$.${v.key}`, required: true, dataType: dataType(v.type) })),
    requiredFields: agent.output_variables.map((v) => ({ fieldKey: v.key, fieldLabel: v.label || v.key, dataType: dataType(v.type), required: !!v.required, showOnDashboard: v.type === 'enum' || v.type === 'boolean', extractionHint: v.description || '' })),
    steps: [{ stepId: 'step_1', description: 'Call the supplier', action: { actionType: 'TRIGGER_CALL', channelType: 'CALL', providerAgentId: agent.key } }],
    maxRetries: 3, retryDelayMinutes: 30, createdBy: USER, createdAt: extra.createdAt, updatedAt: extra.createdAt,
  };
}
const firstBatchAt = S.batches.reduce((m, b) => (b.createdAt < m ? b.createdAt : m), S.batches[0].createdAt);
const templates = [
  templateFrom(S.templates.po, agentByKey(S.templates.po.agent), { description: 'Calls suppliers about purchase orders waiting for acceptance and dispatch dates.', createdAt: plus(firstBatchAt, -3 * 86400000) }),
  templateFrom(S.templates.rfx, agentByKey(S.templates.rfx.agent), { description: 'Reminds suppliers to submit quotes for open RFQs.', event: 'RFX_QUOTE_PENDING', createdAt: plus(firstBatchAt, -2 * 86400000) }),
];
// An older Voxera template, deactivated when the flow moved to Exchange. Its runs still show,
// with the richer data Voxera used to send (transcript, duration, captured fields).
const VOXERA_TEMPLATE_ID = '6a9e2c41b7d0f35e81c4a902';
templates.push({
  ...templateFrom({ id: VOXERA_TEMPLATE_ID, key: 'VOXERA_POST_PO_ACCEPTANCE', name: 'Post PO Acceptance (Voxera)' }, agentByKey(S.templates.po.agent),
    { provider: 'voxera', status: 'DRAFT', description: 'Earlier version of the Post PO flow on Voxera.', createdAt: plus(firstBatchAt, -20 * 86400000) }),
  providerAgentId: 'voxera-post-po-v2',
});

// ── Sheets, executions, conversations ────────────────────────────────────────
const sheets = [];
const executions = [];
const conversations = new Map();
const extraEvents = new Map(); // execId -> events appended by actions

// Dial history from Echo (Ozonetel fields as sent, Echo's mapping, ring and talk time), PRD-ECHO-11.
function dialFields(log) {
  if (!log || !log.length) return {};
  const t = rowTiming(log);
  const last = log[log.length - 1];
  return {
    attemptNumber: log.length, ringSeconds: t.ring_seconds, hangupBy: t.hangup_by, lastAttemptAt: t.last_attempt_at,
    providerStatus: { Status: last.provider.Status, DialStatus: last.provider.DialStatus, CustomerStatus: last.provider.CustomerStatus, HangupBy: last.provider.HangupBy, monitorUCID: last.provider.monitorUCID },
    attemptLog: log.map((a) => ({ attempt: a.attempt, startedAt: a.started_at, ringSeconds: a.ring_seconds, talkSeconds: a.stream?.connected ? a.talk_seconds : 0,
      callStatus: a.mapped.status.toUpperCase(), callResult: a.mapped.result ? a.mapped.result.toUpperCase() : null, callReason: a.mapped.reason ? a.mapped.reason.toUpperCase() : null,
      outcome: a.outcome, anomalies: a.mapped.anomalies, provider: { Status: a.provider.Status, DialStatus: a.provider.DialStatus, CustomerStatus: a.provider.CustomerStatus, HangupBy: a.provider.HangupBy } })),
  };
}
function addExecution({ id, template, batch, row, status, submittedAt, completedAt, duration, extracted, provider = 'exchange', conv = {} }) {
  const exec = {
    id, templateId: template.id, triggerEventId: null, name: row.name, orgId: ORG, sourceSystem: 'CSV',
    triggerMethod: 'CSV_UPLOAD', triggeredBy: batch.uploadedBy, status, activeChannelType: 'CALL',
    resolvedContact: { name: row.name, phone: row.phone, email: row.email || null, entityType: 'SUPPLIER', entityId: row.supplier_id || null },
    context: { ...(row.context || {}), contact_name: row.name, contact_phone: row.phone, contact_email: row.email || '' },
    extractedFields: extracted, enrichmentInputs: {}, currentStepId: 'step_1', currentStepRetryCount: 0,
    activeConversationId: convIdOf(id), failureReason: status === 'FAILED' ? conv.failureReason || 'Call not connected' : null,
    completedBy: FINISHED.includes(status) ? 'SYSTEM' : null,
    createdAt: batch.createdAt, startedAt: submittedAt, updatedAt: completedAt || submittedAt, completedAt: completedAt || null,
    callDurationSeconds: duration ?? null, batchId: batch.id, providerCallId: id, batchSubmittedAt: submittedAt,
    providerKey: provider,
    callStatus: conv.callStatus ?? null, callResult: conv.callResult ?? null, callReason: conv.callReason ?? null,
    attemptNumber: conv.attempts ?? null, maxAttempts: conv.callStatus ? 3 : null, nextAttemptAt: conv.nextAttemptAt ?? null,
    // Echo's one word outcome and its group (PRD-ECHO-19); Clarix only mirrors them.
    outcome: conv.outcome ?? null, outcomeGroup: conv.outcome ? OUTCOMES[conv.outcome]?.group ?? null : null,
    ...dialFields(conv.attemptLog),
  };
  executions.push(exec);
  conversations.set(exec.activeConversationId, {
    id: exec.activeConversationId, workflowExecutionId: id, orgId: ORG, stepId: 'step_1', channelType: 'CALL',
    status: conv.status || (status === 'COMPLETED' ? 'COMPLETED' : status === 'IN_PROGRESS' ? 'INITIATED' : 'FAILED'),
    providerKey: provider, providerSessionId: id, contact: { ...exec.resolvedContact },
    audioUrl: conv.audioUrl || (duration ? `/api/v1/conversations/${exec.activeConversationId}/audio` : null), transcriptUrl: null, transcriptText: conv.transcriptText || null,
    durationSeconds: duration ?? null, cost: conv.cost ?? null, extractedFields: extracted,
    postCallIntelligence: conv.postCallIntelligence || null,
    providerRequestPayload: { agent_name: template.providerAgentId, batch_name: batch.id, call_id: id, phone_number: row.phone },
    providerWebhookPayload: conv.webhook || (status === 'COMPLETED' ? { referenceId: id, status: 'COMPLETED' } : null),
    startedAt: submittedAt, endedAt: completedAt || null, createdAt: submittedAt, updatedAt: completedAt || submittedAt,
  });
  return exec;
}

for (const b of S.batches) {
  const template = templates.find((t) => t.id === b.templateId);
  const failedRows = [];
  const sheet = {
    id: b.id, orgId: ORG, templateId: b.templateId, templateName: b.templateName, eventType: template.triggerEventTypes[0],
    sourceSystem: 'CSV', originalFilename: b.file, fileUrl: null, uploadedBy: b.uploadedBy, total: b.rows.length,
    triggered: 0, failed: 0, failedRows, createdAt: b.createdAt,
  };
  b.rows.forEach((row, i) => {
    if (row.status === 'input_validation_failed') { failedRows.push({ row: i + 2, reason: 'Missing required field' }); return; }
    const call = row.call_id ? callById(row.call_id) : null;
    const done = row.status === 'captured' || row.status === 'disconnected_early';
    const submittedAt = row.dispatched_at || plus(b.createdAt, 20000);
    if (MODE === 'target' && row.final) {
      const f = row.final;
      const cs = f.status.toUpperCase();
      // Same seed as the Echo mock, so both products show the same dials for this row.
      const attemptLog = planAttempts({ seed: `${b.campaignId}:${row.primary_id}`, final: f, dispatchedAt: row.dispatched_at || b.createdAt });
      const lastA = attemptLog[attemptLog.length - 1];
      if (call && lastA?.stream) {
        lastA.talk_seconds = Math.round(call.duration_seconds);
        lastA.stream.agent_finished = (call.events || []).some((e) => e.kind === 'TOOL_CALL' && e.tool === 'submit_call_outputs');
        reOutcome(lastA);
      }
      const inFlight = f.status === 'retry_scheduled' ? 'will_retry' : null;
      const notDialled = !attemptLog.length ? (f.reason === 'duplicate_row' ? 'repeated_number' : f.status === 'cancelled' ? 'stopped' : 'bad_data') : null;
      const outcome = inFlight || notDialled || lastA?.outcome || null;
      const outputsHere = row.outputs && Object.keys(row.outputs).length ? row.outputs : null;
      const mappedReason = lastA?.mapped?.reason ? lastA.mapped.reason.toUpperCase() : null;
      const mappedResult = lastA?.mapped?.result ? lastA.mapped.result.toUpperCase() : null;
      const status = WORKFLOW_OF(cs);
      const endAt = call?.ended_at || plus(submittedAt, (4 + (row.row % 9)) * 60000 * (f.attempts || 1));
      const outputs = row.outputs && Object.keys(row.outputs).length ? row.outputs : null;
      addExecution({
        id: row.primary_id, template, batch: b, row, status, submittedAt,
        completedAt: status === 'IN_PROGRESS' ? null : endAt, duration: call ? Math.round(call.duration_seconds) : null, extracted: outputs,
        conv: {
          callStatus: cs, callResult: cs === 'COMPLETED' ? mappedResult || (f.result ? f.result.toUpperCase() : null) : null,
          callReason: cs === 'COMPLETED' ? null : mappedReason || (f.reason ? f.reason.toUpperCase() : null),
          outcome,
          attempts: attemptLog.length, attemptLog, nextAttemptAt: f.status === 'retry_scheduled' ? plus(nowIso(), f.next_attempt_in_min * 60000) : null,
          status: status === 'COMPLETED' ? 'COMPLETED' : status === 'IN_PROGRESS' ? 'INITIATED' : f.status === 'busy' ? 'BUSY' : f.status === 'no_answer' ? 'NO_ANSWER' : 'FAILED',
          failureReason: status === 'FAILED' ? `${cs.replace(/_/g, ' ').toLowerCase()}${f.reason ? ` (${f.reason.replace(/_/g, ' ')})` : ''}` : null,
          transcriptText: call ? call.events.filter((e) => e.kind.endsWith('_TURN')).map((e) => `${e.kind === 'AGENT_TURN' ? 'Agent' : 'Customer'}: ${e.text}`).join('\n') : null,
          webhook: { referenceId: row.primary_id, call_status: cs, call_result: f.result?.toUpperCase() || null, call_reason: f.reason?.toUpperCase() || null, attempt_number: f.attempts || 1, outputs: outputs || {} },
        },
      });
      return;
    }
    addExecution({
      id: row.primary_id, template, batch: b, row, status: done ? 'COMPLETED' : 'IN_PROGRESS',
      submittedAt, completedAt: done ? call?.ended_at || row.captured_at : null,
      duration: null, extracted: done ? {} : null,
    });
  });
  sheet.failed = failedRows.length;
  sheet.triggered = sheet.total - sheet.failed;
  sheets.push(sheet);
}

// Older Voxera batch: 6 rows, all completed (live shows 100% answered), with the data Voxera used to return.
{
  const voxTemplate = templates.find((t) => t.id === VOXERA_TEMPLATE_ID);
  const donor = S.batches.find((b) => b.rows.length >= 20) || S.batches[0];
  const createdAt = plus(firstBatchAt, -11 * 86400000);
  const batch = { id: '6a8f10d2c54b7e93a1f06b3d', uploadedBy: S.operators[0], createdAt };
  const rows = donor.rows.slice(0, 6);
  sheets.push({ id: batch.id, orgId: ORG, templateId: voxTemplate.id, templateName: voxTemplate.name, eventType: voxTemplate.triggerEventTypes[0], sourceSystem: 'CSV', originalFilename: 'post_po_pending_week38.xlsx', fileUrl: null, uploadedBy: batch.uploadedBy, total: rows.length, triggered: rows.length, failed: 0, failedRows: [], createdAt });
  const outcomes = [
    ['COMPLETED', { status: 'Acknowledged for PO Acceptance', po_acceptance_intent: 'ACCEPTED', eta_confirmation_received: true }, 142, 'Supplier accepted the PO and shared a dispatch date.', 'positive'],
    ['COMPLETED', { status: 'Call Back required by Ops', po_acceptance_intent: 'WILL_ACCEPT', callback_time: '16:00' }, 58, 'Supplier asked for a call back after checking the portal.', 'neutral'],
    ['COMPLETED', { status: 'Call Back required by Ops', po_acceptance_intent: 'WILL_ACCEPT', callback_time: '11:00' }, 41, 'Supplier was driving and asked for a call back.', 'neutral'],
    ['COMPLETED', { status: 'PO Copy/ Mail Not Received', po_acceptance_intent: 'PENDING_QUERY' }, 96, 'Supplier had not received the PO copy.', 'neutral'],
    ['COMPLETED', { status: 'Acknowledged for PO Acceptance', po_acceptance_intent: 'ACCEPTED' }, 88, 'Supplier accepted the PO; dispatch date to follow by email.', 'positive'],
    ['COMPLETED', { status: 'ETA Available/ Shared', po_acceptance_intent: 'ACCEPTED', eta_confirmation_received: true }, 171, 'Supplier confirmed acceptance and dispatch timeline.', 'positive'],
  ];
  rows.forEach((row, i) => {
    const [status, fields, dur, summary, sentiment, convStatus] = outcomes[i];
    const id = `6a8f10d2c54b7e93a1f0${String(i).padStart(4, '0')}`;
    const submittedAt = plus(createdAt, 30000 + i * 45000);
    const completedAt = plus(submittedAt, ((dur || 25) + 8) * 1000);
    const first = (row.name || '').split(' ')[0];
    addExecution({
      id, template: voxTemplate, batch, row: { ...row, primary_id: id }, status, submittedAt, completedAt, duration: dur, extracted: fields, provider: 'voxera',
      conv: status === 'COMPLETED' ? {
        transcriptText: `Agent: Namaste ${first} ji, main Saniya bol rahi hoon, purchase order ke baare mein.\nCustomer: Haan boliye.\nAgent: ${summary}\nCustomer: Theek hai.\nAgent: Dhanyavaad, aapka din shubh ho.`,
        postCallIntelligence: { summary: { mom: [summary], resolution: fields.status, pending_items: fields.callback_time ? [`Call back at ${fields.callback_time}`] : [] }, intent: 'PO follow-up', sentiment, satisfaction_score: { rating: sentiment === 'positive' ? 4 : 3, confidence: 0.7, reasoning: 'Cooperative supplier' }, REQUIRED_DATA: fields },
        cost: Math.round(dur * 0.9) / 100, webhook: { status: 'completed', duration: dur, collected_fields: fields },
      } : { status: convStatus, failureReason: convStatus === 'BUSY' ? 'Customer busy' : 'No answer', webhook: { status: convStatus.toLowerCase() } },
    });
  });
}

// ── Events (the debug timeline) ──────────────────────────────────────────────
function eventsOf(e) {
  const out = [];
  const ev = (eventType, status, at, extra = {}) => out.push({ id: `${e.id}-${out.length}`, workflowExecutionId: e.id, conversationId: e.activeConversationId, orgId: ORG, eventType, status, requestPayload: null, responsePayload: null, errorMessage: null, retryAttempt: 0, performedBy: null, createdAt: at, ...extra });
  ev('WORKFLOW_TRIGGERED', 'SUCCESS', e.createdAt, { performedBy: e.triggeredBy });
  ev('CALL_INITIATED', e.status === 'FAILED' && e.providerKey === 'exchange' ? 'FAILED' : 'SUCCESS', e.batchSubmittedAt);
  if (e.providerKey === 'exchange') ev('WAITING_FOR_WEBHOOK', 'PENDING', e.batchSubmittedAt);
  const end = e.completedAt ? Date.parse(e.completedAt) : Date.now();
  if (e.providerKey === 'exchange' && MODE === 'live') {
    let n = 0;
    for (let t = Date.parse(e.batchSubmittedAt) + SYNC_MS; t < end; t += SYNC_MS) {
      n += 1;
      ev('STATUS_SYNC', 'SUCCESS', new Date(t).toISOString(), { requestPayload: { source: 'SCHEDULER', callId: e.id }, responsePayload: { requestId: e.id, outcome: 'PENDING' }, retryAttempt: n });
    }
  }
  if (MODE === 'target' && e.callStatus === 'RETRY_SCHEDULED') {
    ev('WEBHOOK_RECEIVED', 'SUCCESS', plus(e.batchSubmittedAt, 90000), { requestPayload: conversations.get(e.activeConversationId)?.providerWebhookPayload });
    ev('RETRY_SCHEDULED', 'PENDING', plus(e.batchSubmittedAt, 90000), { responsePayload: { nextAttemptAt: e.nextAttemptAt, attempt: e.attemptNumber } });
  }
  if (e.completedAt) {
    const conv = conversations.get(e.activeConversationId);
    ev('WEBHOOK_RECEIVED', 'SUCCESS', e.completedAt, { requestPayload: conv?.providerWebhookPayload || { referenceId: e.id, status: 'COMPLETED' } });
    if (e.extractedFields && Object.keys(e.extractedFields).length) ev('FIELD_EXTRACTED', 'SUCCESS', e.completedAt, { responsePayload: e.extractedFields });
    ev(e.status === 'COMPLETED' ? 'WORKFLOW_COMPLETED' : e.status === 'STOPPED' ? 'CALL_STOPPED' : 'WORKFLOW_FAILED', e.status === 'COMPLETED' || e.status === 'STOPPED' ? 'SUCCESS' : 'FAILED', e.completedAt, { errorMessage: e.failureReason });
  }
  return [...out, ...(extraEvents.get(e.id) || [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
const statusSyncCount = (e) => eventsOf(e).filter((x) => x.eventType === 'STATUS_SYNC').length;
const withSync = (e) => ({ ...e, statusSyncCount: statusSyncCount(e) });

function finishExecution(e, status, extra = {}) {
  Object.assign(e, { status, completedAt: nowIso(), updatedAt: nowIso(), completedBy: extra.by || 'SYSTEM', ...extra.fields });
  const conv = conversations.get(e.activeConversationId);
  if (conv) Object.assign(conv, { status: status === 'COMPLETED' ? 'COMPLETED' : 'FAILED', endedAt: e.completedAt, updatedAt: e.completedAt, ...(extra.conv || {}) });
}

// ── Queries ──────────────────────────────────────────────────────────────────
function filterExecutions(q, templateId) {
  let list = executions.filter((e) => !templateId || e.templateId === templateId);
  if (q.get('status')) list = list.filter((e) => e.status === q.get('status'));
  if (q.get('channelType')) list = list.filter((e) => e.activeChannelType === q.get('channelType'));
  if (q.get('batchId')) list = list.filter((e) => e.batchId === q.get('batchId'));
  if (q.get('from')) list = list.filter((e) => e.createdAt >= new Date(q.get('from')).toISOString());
  if (q.get('to')) list = list.filter((e) => e.createdAt <= new Date(q.get('to')).toISOString());
  if (q.get('phone')) list = list.filter((e) => (e.resolvedContact.phone || '').includes(q.get('phone').replace(/\D/g, '')));
  const term = (q.get('search') || '').toLowerCase();
  if (term) list = list.filter((e) => [e.id, e.name, e.resolvedContact.phone, e.resolvedContact.email].some((v) => String(v || '').toLowerCase().includes(term)));
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}
const page = (list, q) => {
  const p = Number(q.get('page') || 0), size = Number(q.get('size') || 20);
  return list.slice(p * size, p * size + size);
};
function templateView(t) {
  const runs = executions.filter((e) => e.templateId === t.id);
  const last = runs.reduce((m, e) => (!m || e.createdAt > m ? e.createdAt : m), null);
  return { ...t, executionCount: runs.length, lastRunAt: last, completedCount: runs.filter((e) => e.status === 'COMPLETED').length, failedCount: runs.filter((e) => e.status === 'FAILED').length, cancelledCount: runs.filter((e) => e.status === 'CANCELLED').length };
}
function sheetView(s) {
  const counts = {};
  const groups = {};
  const mine = executions.filter((e) => e.batchId === s.id);
  for (const e of mine) {
    counts[e.status] = (counts[e.status] || 0) + 1;
    const g = e.outcomeGroup || (e.status === 'COMPLETED' ? 'reached' : e.status === 'IN_PROGRESS' ? 'in_progress' : e.status === 'STOPPED' || e.status === 'CANCELLED' ? 'not_dialled' : 'not_reached');
    groups[g] = (groups[g] || 0) + 1;
  }
  // Run time: first dial to the end of the last call (still growing while calls are open).
  const starts = mine.map((e) => Date.parse((e.attemptLog?.[0]?.startedAt) || e.batchSubmittedAt || e.startedAt)).filter(Number.isFinite);
  const ends = mine.map((e) => Date.parse(e.completedAt || '')).filter(Number.isFinite);
  const open = mine.some((e) => e.status === 'IN_PROGRESS');
  const first = starts.length ? Math.min(...starts) : null;
  const last = open ? Date.now() : ends.length ? Math.max(...ends) : null;
  return { ...s, statusCounts: counts, outcomeGroups: groups, inProgressCount: counts.IN_PROGRESS || 0,
    firstDialAt: first ? new Date(first).toISOString() : null, lastCallEndAt: last && !open ? new Date(last).toISOString() : null, runSeconds: first && last ? Math.max(0, Math.round((last - first) / 1000)) : null };
}
function orgSummary() {
  const count = (st) => executions.filter((e) => e.status === st).length;
  const completed = count('COMPLETED');
  const finished = completed + count('FAILED') + count('CANCELLED') + count('STOPPED');
  const running = new Set(executions.filter((e) => e.status === 'IN_PROGRESS' && e.batchId).map((e) => e.batchId)).size;
  return {
    agentsLive: templates.filter((t) => t.status === 'ACTIVE').length, campaignsRunning: running,
    // Placed = Echo dialled it at least once (has a dial in its log); queued, cancelled and invalid rows are not calls.
    callsPlaced: executions.filter((e) => (e.attemptLog?.length || 0) > 0 || (!e.callStatus && e.status !== 'IN_PROGRESS' && e.status !== 'CANCELLED' && e.status !== 'STOPPED')).length,
    answeredPct: finished ? Math.round((completed * 100) / finished) : 0,
    // Live heuristic: a completed run whose extractedFields exists, even when it is empty.
    commitments: executions.filter((e) => e.status === 'COMPLETED' && e.extractedFields != null).length,
    activeBatches: running, callsCompleted: completed, pendingCallbacks: count('WAITING'),
  };
}
const DURATION_BINS = [[0, '0–10s'], [10, '10–30s'], [30, '30–60s'], [60, '1–2m'], [120, '2–5m'], [300, '5m+']];
function templateDashboard(t, q) {
  let list = executions.filter((e) => e.templateId === t.id);
  if (q.get('batchId')) list = list.filter((e) => e.batchId === q.get('batchId'));
  const from = q.get('from') ? new Date(q.get('from')) : null, to = q.get('to') ? new Date(q.get('to')) : null;
  if (from) list = list.filter((e) => new Date(e.createdAt) >= from);
  if (to) list = list.filter((e) => new Date(e.createdAt) <= to);
  const n = (f) => list.filter(f).length;
  const total = list.length, completed = n((e) => e.status === 'COMPLETED');
  const durs = list.filter((e) => e.completedAt).map((e) => Date.parse(e.completedAt) - Date.parse(e.createdAt));
  const group = (key) => Object.entries(list.reduce((m, e) => { const k = key(e) ?? null; m[k] = (m[k] || 0) + 1; return m; }, {})).map(([key, count]) => ({ key: key === 'null' ? null : key, count }));
  const days = from && to ? (to - from) / 86400000 : 0;
  const granularity = days > 180 ? 'MONTH' : days > 30 ? 'WEEK' : 'DAY';
  const byDay = {};
  for (const e of list) {
    const k = e.createdAt.slice(0, 10);
    byDay[k] ||= { date: k, created: 0, completed: 0, failed: 0 };
    byDay[k].created += 1; if (e.status === 'COMPLETED') byDay[k].completed += 1; if (e.status === 'FAILED') byDay[k].failed += 1;
  }
  const start = from || (list.length ? new Date(list.reduce((m, e) => (e.createdAt < m ? e.createdAt : m), list[0].createdAt)) : new Date());
  const stop = to || new Date();
  const buckets = [];
  for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())); d <= stop; d = new Date(d.getTime() + 86400000)) {
    const k = d.toISOString().slice(0, 10);
    buckets.push(byDay[k] || { date: k, created: 0, completed: 0, failed: 0 });
  }
  const withDur = list.filter((e) => e.callDurationSeconds != null);
  const fieldBreakdowns = t.requiredFields.filter((f) => f.showOnDashboard).map((f) => {
    const answered = list.filter((e) => e.extractedFields && e.extractedFields[f.fieldKey] != null);
    if (!answered.length) return null;
    const dist = Object.entries(answered.reduce((m, e) => { const k = String(e.extractedFields[f.fieldKey]); m[k] = (m[k] || 0) + 1; return m; }, {})).map(([key, count]) => ({ key, count }));
    return { fieldKey: f.fieldKey, fieldLabel: f.fieldLabel, dataType: f.dataType, totalAnswered: answered.length, totalUnanswered: total - answered.length, distribution: dist };
  }).filter(Boolean);
  return {
    kpis: {
      totalExecutions: total, completed, failed: n((e) => e.status === 'FAILED'), inProgress: n((e) => e.status === 'IN_PROGRESS' || e.status === 'ACTIVE'),
      waiting: n((e) => e.status === 'WAITING'), cancelled: n((e) => e.status === 'CANCELLED'),
      completionRate: total ? completed / total : 0, avgDurationMs: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null,
      reachableContactRate: total ? n((e) => e.resolvedContact.phone || e.resolvedContact.email) / total : 0,
    },
    statusBreakdown: group((e) => e.status),
    channelBreakdown: group((e) => e.activeChannelType),
    durationBuckets: DURATION_BINS.map(([lo, key], i) => ({ key, count: withDur.filter((e) => e.callDurationSeconds >= lo && (i === DURATION_BINS.length - 1 || e.callDurationSeconds < DURATION_BINS[i + 1][0])).length })),
    timeSeries: { granularity, buckets },
    fieldBreakdowns,
  };
}
function orgDashboard() {
  const convs = [...conversations.values()];
  const total = convs.length, answered = convs.filter((c) => c.status === 'COMPLETED').length;
  const abandoned = convs.filter((c) => c.status === 'FAILED').length;
  const pct = (a, b) => (b ? Math.round((a * 1000) / b) / 10 : 0);
  const withDur = convs.filter((c) => c.durationSeconds != null);
  const aht = withDur.length ? Math.round(withDur.reduce((s, c) => s + c.durationSeconds, 0) / withDur.length) : null;
  const queued = executions.filter((e) => e.status === 'IN_PROGRESS').length;
  const oldest = executions.filter((e) => e.status === 'IN_PROGRESS').reduce((m, e) => Math.min(m, Date.parse(e.startedAt)), Date.now());
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yest = new Date(today.getTime() - 86400000);
  const volume = [];
  for (const [day, base] of [['today', today], ['yesterday', yest]]) {
    for (let h = 0; h < 24; h++) {
      const a = base.getTime() + h * 3600000;
      volume.push({ hour: h, day, count: convs.filter((c) => { const t = Date.parse(c.createdAt); return t >= a && t < a + 3600000; }).length });
    }
  }
  const tCount = volume.filter((v) => v.day === 'today').reduce((s, v) => s + v.count, 0);
  const yCount = volume.filter((v) => v.day === 'yesterday').reduce((s, v) => s + v.count, 0);
  const statusGroups = Object.entries(convs.reduce((m, c) => { m[c.status] = (m[c.status] || 0) + 1; return m; }, {})).map(([status, count]) => ({ status, count }));
  const connectionRate = pct(answered, total), abandonRate = pct(abandoned, total);
  return {
    topKpis: { numberOfWorkflows: templates.filter((t) => t.status === 'ACTIVE').length, activeCalls: convs.filter((c) => c.status === 'IN_PROGRESS' || c.status === 'INITIATED').length, callsInQueue: queued },
    callAnalytics: { totalCalls: total, answeredCalls: answered, answerRate: connectionRate, connectionRate, abandonRate, slaPerformance: connectionRate, avgHandlingTimeSec: aht, avgWaitTimeSec: null },
    callDistribution: statusGroups,
    direction: [{ direction: 'OUTBOUND', count: total }],
    trends: { today: tCount, yesterday: yCount, difference: tCount - yCount, growthRate: yCount ? Math.round(((tCount - yCount) * 1000) / yCount) / 10 : 0 },
    volumeChart: volume,
    performance: { slaPerformance: connectionRate, connectionRate, abandonRate, avgHandlingTimeSec: aht, avgWaitTimeSec: null, queuedCalls: queued, longestQueueSec: queued ? Math.round((Date.now() - oldest) / 1000) : 0, efficiencyScore: Math.round(connectionRate * (1 - abandonRate / 100)) },
  };
}

// ── Reference lists ──────────────────────────────────────────────────────────
const PERMISSION_KEYS = ['genbi:menuvisibility', 'manage-permissions:menuvisibility', 'modules:add', 'modules:delete', 'modules:edit', 'modules:read', 'permissions:add', 'permissions:delete', 'permissions:edit', 'permissions:read', 'workflows:executions:debug', 'workflows:menuvisibility', 'workflows:template:create', 'workflows:template:edit', 'workflows:template:read', 'workflows:template:status-change', 'workflows:executions:read'];
const permissions = PERMISSION_KEYS.map((key, i) => ({ id: `perm_${i + 1}`, key, displayName: key.split(':').map((s) => s.replace(/-/g, ' ')).join(' / '), description: '', category: key.split(':')[0].toUpperCase(), createdAt: plus(firstBatchAt, -30 * 86400000) }));
const modules = [
  { id: 'mod_workflows', name: 'workflows', displayName: 'Workflows', description: 'Agents, sheets and call logs', permissions: PERMISSION_KEYS.filter((k) => k.startsWith('workflows')), enabled: true },
  { id: 'mod_genbi', name: 'genbi', displayName: 'GenBI', description: 'Ask questions of your data', permissions: ['genbi:menuvisibility'], enabled: true },
  { id: 'mod_admin', name: 'admin', displayName: 'Admin', description: 'Permissions and modules', permissions: PERMISSION_KEYS.filter((k) => /^(permissions|modules|manage)/.test(k)), enabled: true },
];
const PROVIDERS = [{ key: 'exchange', displayName: 'Echo', type: 'EXCHANGE' }, { key: 'voxera', displayName: 'Voxera', type: 'VOXERA' }];

// ── Uploads ──────────────────────────────────────────────────────────────────
function multipart(req, buf) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(req.headers['content-type'] || '');
  if (!m) return {};
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const out = {};
  let start = buf.indexOf(boundary);
  while (start !== -1) {
    const next = buf.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    const part = buf.slice(start + boundary.length + 2, next - 2);
    const sep = part.indexOf('\r\n\r\n');
    const head = part.slice(0, sep).toString('utf8');
    const name = /name="([^"]+)"/.exec(head)?.[1];
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    const content = part.slice(sep + 4);
    if (name) out[name] = filename !== undefined ? { filename, content } : content.toString('utf8');
    start = next;
  }
  return out;
}
function readSheet(file) {
  if (/\.xlsx?$|\.xlsm$/i.test(file.filename)) return readXlsx(file.content);
  return file.content.toString('utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '').trim()));
}

async function dispatchToEcho(template, sheet, rows) {
  const payload = { batchId: sheet.id, name: `${template.name}_${sheet.id}`, agent: template.providerAgentId, rows };
  try {
    const r = await fetch(`${ECHO_URL}/__mock/clarix-batch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (r.ok) return true;
  } catch { /* Echo mock not running */ }
  // Stand-alone: about half connect a few seconds later; the rest stay In Progress, as live.
  rows.forEach((row, i) => setTimeout(() => {
    const r = Math.random();
    if (MODE === 'live') { if (r < 0.5) exchangeWebhook({ referenceId: row.primary_id, status: 'COMPLETED' }); return; }
    const cs = r < 0.55 ? 'COMPLETED' : r < 0.75 ? 'NO_ANSWER' : r < 0.88 ? 'BUSY' : 'UNREACHABLE';
    exchangeWebhook({ referenceId: row.primary_id, version: Date.now(), call_status: cs, call_result: cs === 'COMPLETED' ? (r < 0.4 ? 'CONVERSATION' : 'DISCONNECTED_EARLY') : null, call_reason: cs === 'COMPLETED' ? null : cs === 'BUSY' ? 'DESTINATION_BUSY' : cs === 'UNREACHABLE' ? 'SUBSCRIBER_ABSENT' : 'NO_ANSWER', attempt_number: 1, max_attempts: 3, outputs: {}, talk_seconds: cs === 'COMPLETED' ? 40 + Math.round(r * 100) : null });
  }, 8000 + i * 2500));
  return false;
}
function exchangeWebhook(body) {
  const e = executions.find((x) => x.id === body.referenceId);
  if (!e) return false;
  if (!body.call_status) {
    // Live Exchange: two fields, connected calls only.
    if (e.status !== 'IN_PROGRESS') return false;
    finishExecution(e, 'COMPLETED', { fields: { extractedFields: {} }, conv: { providerWebhookPayload: { referenceId: body.referenceId, status: body.status } } });
    return true;
  }
  // Target contract: apply Echo's status as sent; ignore anything older than what we hold.
  if (e.echoVersion && body.version && body.version < e.echoVersion) return false;
  const cs = body.call_status;
  const status = WORKFLOW_OF(cs);
  Object.assign(e, {
    echoVersion: body.version || Date.now(), callStatus: cs, callResult: body.call_result || null, callReason: body.call_reason || null,
    attemptNumber: body.attempt_number || 1, maxAttempts: body.max_attempts || 3, nextAttemptAt: body.next_attempt_at || null,
    callDurationSeconds: body.talk_seconds ?? e.callDurationSeconds, updatedAt: nowIso(),
    ringSeconds: body.ring_seconds ?? e.ringSeconds ?? null, hangupBy: body.hangup_by ?? e.hangupBy ?? null, lastAttemptAt: body.last_attempt_at ?? e.lastAttemptAt ?? null,
    providerStatus: body.provider ?? e.providerStatus ?? null, lastAttemptStatus: body.last_attempt_status ?? null, lastAttemptReason: body.last_attempt_reason ?? null,
  });
  if (body.outcome) Object.assign(e, { outcome: body.outcome, outcomeGroup: body.outcome_group || OUTCOMES[body.outcome]?.group || null });
  // Echo owns the campaign status; Clarix stores the latest one it sent and never works it out itself.
  const sheetOf = sheets.find((s) => s.id === e.batchId);
  if (sheetOf && body.campaign_status && (!sheetOf.echoVersion || (body.version || 0) >= sheetOf.echoVersion)) Object.assign(sheetOf, { campaignStatus: body.campaign_status, echoVersion: body.version || Date.now() });
  // Echo sends the whole dial history with every event; keep the latest copy.
  if (Array.isArray(body.attempt_log)) e.attemptLog = body.attempt_log;
  const conv = conversations.get(e.activeConversationId);
  if (conv) conv.providerWebhookPayload = body;
  const list = extraEvents.get(e.id) || [];
  list.push({ id: `${e.id}-w${list.length}`, workflowExecutionId: e.id, conversationId: e.activeConversationId, orgId: ORG, eventType: 'WEBHOOK_RECEIVED', status: 'SUCCESS', requestPayload: body, responsePayload: null, errorMessage: null, retryAttempt: (body.attempt_number || 1) - 1, performedBy: null, createdAt: nowIso() });
  extraEvents.set(e.id, list);
  if (status === 'IN_PROGRESS') { e.status = 'IN_PROGRESS'; if (conv) conv.status = cs === 'CALLING' ? 'INITIATED' : 'IN_PROGRESS'; return true; }
  const outputs = body.outputs && Object.keys(body.outputs).length ? body.outputs : null;
  finishExecution(e, status, {
    fields: { extractedFields: outputs, failureReason: status === 'FAILED' ? `${cs.replace(/_/g, ' ').toLowerCase()}${body.call_reason ? ` (${body.call_reason.replace(/_/g, ' ').toLowerCase()})` : ''}` : null },
    conv: { durationSeconds: body.talk_seconds ?? null, extractedFields: outputs },
  });
  return true;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const cors = (req) => ({ 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'Authorization, Content-Type, countryId', 'Access-Control-Expose-Headers': 'Content-Disposition' });
const routes = [];
const on = (method, pattern, fn, opts = {}) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn, ...opts });
let R = null;
const send = (status, body) => { R.res.writeHead(status, { ...cors(R.req), 'Content-Type': 'application/json' }); R.res.end(JSON.stringify(body)); };
const ok = (data, totalElements) => send(200, { status: true, message: 'Success', data, ...(totalElements !== undefined ? { totalElements } : {}) });
const fail = (code, message) => send(code, { status: false, message, code, data: null });
const file = (buf, type, name) => { R.res.writeHead(200, { ...cors(R.req), 'Content-Type': type, 'Content-Length': buf.length, 'Content-Disposition': `attachment; filename="${name}"` }); R.res.end(buf); };
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const execOr404 = (id) => executions.find((e) => e.id === id) || (fail(404, `Execution not found: ${id}`), null);

// Follow ups demo data: a few not reached rows end as Blocked, Rejected or with every try used (same idea as the Echo mock).
if (MODE === 'target') {
  const pool = executions.filter((e) => ['no_answer', 'busy', 'unreachable'].includes(e.outcome) && e.status !== 'IN_PROGRESS');
  const set = (e, outcome, cust) => { const last = (e.attemptLog || []).slice(-1)[0]; if (last) { last.outcome = outcome; Object.assign(last.provider || {}, { Status: 'NotAnswered', CustomerStatus: cust, DialStatus: 'not_answered' }); } Object.assign(e, { outcome, outcomeGroup: 'not_reached', callStatus: outcome.toUpperCase() }); };
  pool.slice(0, 4).forEach((e) => set(e, 'blocked', 'DND'));
  pool.slice(4, 6).forEach((e) => set(e, 'rejected', 'Rejected'));
  pool.slice(6).filter((e) => (e.attemptLog || []).length >= 3).slice(0, 5).forEach((e) => { e.callStatus = 'RETRY_EXHAUSTED'; });
  // Input layer demo data: a few rows carry the kind of mistakes real uploads have.
  executions.forEach((e, i) => { const x = e.context; if (!x) return;
    if (x.target_dispatch_date && i % 7 === 2) { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(x.target_dispatch_date); if (m && Number(m[1]) > 12) x.target_dispatch_date = `${m[2]}/${m[1]}/${m[3]}`; }
    if (x.plant_name && i % 17 === 4) x.plant_name = e.name || x.plant_name;
    if (x.item_details && i % 13 === 5) x.item_details = String(x.item_details).slice(0, 4); });
  if (pool[0]) pool[0].followUp = { state: 'open', reason: 'blocked', owner: S.operators[0], notes: [{ text: 'Called from my phone. They will save our number and allow calls from tomorrow.', by: S.operators[0], at: new Date(Date.now() - 3 * 3600000).toISOString() }] };
}
registerReports({ on, ok, fail, file, executions, sheets, templates, nowIso, me: () => USER,
  owners: [USER, ...S.operators].filter((v, i, l) => l.indexOf(v) === i).map((email) => ({ email })),
  // Call again from Follow ups: Clarix asks Echo to dial the row again; here the row simply goes back to waiting.
  redial: (e) => Object.assign(e, { status: 'IN_PROGRESS', outcome: 'waiting', outcomeGroup: 'in_progress', callStatus: 'QUEUED', completedAt: null, updatedAt: nowIso() }) });

// Auth and permissions
on('GET', '/api/v1/auth/me/permissions', () => ok(PERMISSION_KEYS));
on('POST', '/api/v1/auth/me/permissions/refresh', () => ok(PERMISSION_KEYS));
on('GET', '/api/v1/auth/modules-access', () => ok(modules.map((m) => ({ module: m.name, enabled: true }))));
on('GET', '/api/v1/admin/permissions', ({ q }) => { const list = permissions.filter((p) => !q.get('category') || p.category === q.get('category')); ok(page(list, q), list.length); });
on('GET', '/api/v1/admin/permissions/categories', () => ok([...new Set(permissions.map((p) => p.category))]));
on('GET', '/api/v1/admin/modules', ({ q }) => ok(page(modules, q), modules.length));

// Executions
on('GET', '/api/v1/workflows', ({ q }) => { const l = filterExecutions(q); ok(page(l, q).map(withSync), l.length); });
on('GET', '/api/v1/workflows/dashboard/org-summary', () => ok(orgSummary()));
on('GET', '/api/v1/workflows/dashboard/:tid', ({ p, q }) => { const t = templates.find((x) => x.id === p.tid); t ? ok(templateDashboard(t, q)) : fail(404, 'Template not found'); });
on('GET', '/api/v1/workflows/by-template/:tid/report', ({ p, q }) => {
  const t = templates.find((x) => x.id === p.tid); if (!t) return fail(404, 'Template not found');
  const fields = t.requiredFields.map((f) => f.fieldKey);
  const rows = [['Execution Id', 'Name', 'Phone', 'Email', 'Status', 'Channel', 'Created At', 'Completed At', 'Call Duration', ...fields],
    ...filterExecutions(q, t.id).map((e) => [e.id, e.name, e.resolvedContact.phone, e.resolvedContact.email || '', e.status, e.activeChannelType, e.createdAt, e.completedAt || '', e.callDurationSeconds ?? '', ...fields.map((k) => e.extractedFields?.[k] ?? '')])];
  file(writeXlsx(rows, 'Report'), XLSX, `${t.templateKey}_report.xlsx`);
});
on('GET', '/api/v1/workflows/by-template/:tid', ({ p, q }) => { const l = filterExecutions(q, p.tid); ok(page(l, q).map(withSync), l.length); });
on('GET', '/api/v1/workflows/sheets', ({ q }) => {
  let l = sheets.map(sheetView);
  if (q.get('templateId')) l = l.filter((s) => s.templateId === q.get('templateId'));
  if (q.get('uploadedBy')) l = l.filter((s) => s.uploadedBy === q.get('uploadedBy'));
  if (q.get('from')) l = l.filter((s) => s.createdAt >= new Date(q.get('from')).toISOString());
  if (q.get('to')) l = l.filter((s) => s.createdAt <= new Date(q.get('to')).toISOString());
  l.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  ok(page(l, q), l.length);
});
on('GET', '/api/v1/workflows/sheets/:id', ({ p }) => { const s = sheets.find((x) => x.id === p.id); s ? ok(sheetView(s)) : fail(404, `Sheet not found: ${p.id}`); });
on('POST', '/api/v1/workflows/sheets/:id/stop', async ({ p }) => {
  const mine = R;
  try {
    const r = await fetch(`${ECHO_URL}/__mock/clarix-stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchId: p.id }) });
    if (r.ok) { const j = await r.json(); R = mine; return ok(j.stopped); }
  } catch { /* Echo mock not running */ }
  R = mine;
  const live = executions.filter((e) => e.batchId === p.id && e.status === 'IN_PROGRESS');
  live.forEach((e) => finishExecution(e, 'STOPPED', { by: USER }));
  ok(live.length);
});
registerOrchestration({ on, ok, fail, multipart, readSheet, templates, sheets, batches: S.batches, agentByKey, nowIso });
on('GET', '/api/v1/workflows/reports', ({ q }) => ok([], 0));
on('POST', '/api/v1/workflows/trigger/bulk', async ({ req, raw }) => {
  const form = multipart(req, raw);
  const t = templates.find((x) => x.id === form.templateId);
  if (!t) return fail(400, 'Template not found');
  if (!form.file?.content) return fail(400, 'No file received');
  let rows;
  try { rows = readSheet(form.file); } catch { return fail(400, 'Could not read the file'); }
  const [headers, ...data] = rows;
  const map = JSON.parse(form.columnMapping || '{}');
  const col = (h) => (h ? headers.findIndex((x) => x.trim().toLowerCase() === String(h).trim().toLowerCase()) : -1);
  const sheet = { id: hex24(), orgId: ORG, templateId: t.id, templateName: t.name, eventType: form.eventType || t.triggerEventTypes[0], sourceSystem: 'CSV', originalFilename: form.file.filename, fileUrl: null, uploadedBy: USER, total: data.length, triggered: 0, failed: 0, failedRows: [], createdAt: nowIso() };
  const results = [], toEcho = [];
  data.forEach((r, i) => {
    const get = (h) => { const k = col(h); return k >= 0 ? String(r[k] ?? '').trim() : ''; };
    const phone = get(map.contact?.phone).replace(/\D/g, '').slice(-10);
    const context = Object.fromEntries(Object.entries(map.fields || {}).map(([k, h]) => [k, get(h)]));
    const missing = t.contextMappings.filter((m) => m.required && !context[m.fieldName]).map((m) => m.fieldName);
    const reason = phone.length !== 10 ? 'Invalid phone number' : missing.length ? `Missing required field(s): ${missing.join(', ')}` : '';
    if (reason) { sheet.failedRows.push({ row: i + 2, reason }); results.push({ row: i + 2, status: 'FAILED', reason }); return; }
    const row = { primary_id: hex24(), name: get(map.contact?.name) || `Row ${i + 2}`, phone, email: get(map.contact?.email), context };
    addExecution({ id: row.primary_id, template: t, batch: sheet, row, status: 'IN_PROGRESS', submittedAt: nowIso(), completedAt: null, duration: null, extracted: null, conv: MODE === 'target' ? { callStatus: 'QUEUED', attempts: 0 } : {} });
    toEcho.push(row);
    results.push({ row: i + 2, status: 'ACCEPTED', reason: '' });
  });
  sheet.failed = sheet.failedRows.length; sheet.triggered = toEcho.length;
  if (toEcho.length) sheets.push(sheet);
  const mine = R; // another request may run while we wait on the Echo mock
  if (toEcho.length) await dispatchToEcho(t, sheet, toEcho);
  R = mine;
  ok({ sessionId: sheet.id, total: sheet.total, triggered: sheet.triggered, failed: sheet.failed, failedRows: sheet.failedRows, rows: results });
});
on('GET', '/api/v1/workflows/:id', ({ p }) => { const e = execOr404(p.id); if (e) ok(withSync(e)); });
on('GET', '/api/v1/workflows/:id/events', ({ p }) => { const e = execOr404(p.id); if (e) ok(eventsOf(e)); });
on('POST', '/api/v1/workflows/:id/sync-status', ({ p }) => {
  const e = execOr404(p.id); if (!e) return;
  if (e.status !== 'IN_PROGRESS') return fail(400, `No active call to sync for execution ${e.id}`);
  const list = extraEvents.get(e.id) || [];
  list.push({ id: `${e.id}-m${list.length}`, workflowExecutionId: e.id, conversationId: e.activeConversationId, orgId: ORG, eventType: 'STATUS_SYNC', status: 'SUCCESS', requestPayload: { source: 'MANUAL', callId: e.id }, responsePayload: { requestId: e.id, outcome: 'PENDING' }, errorMessage: null, retryAttempt: statusSyncCount(e) + 1, performedBy: USER, createdAt: nowIso() });
  extraEvents.set(e.id, list);
  ok(withSync(e));
});
on('POST', '/api/v1/workflows/:id/stop', ({ p }) => { const e = execOr404(p.id); if (!e) return; if (e.status !== 'IN_PROGRESS') return fail(400, 'Only in-progress calls can be stopped'); finishExecution(e, 'STOPPED', { by: USER }); ok(e); });
on('POST', '/api/v1/workflows/:id/cancel', ({ p }) => { const e = execOr404(p.id); if (!e) return; if (e.status !== 'UPCOMING') return fail(400, 'Only upcoming runs can be cancelled'); finishExecution(e, 'CANCELLED', { by: USER }); ok(e); });
on('POST', '/api/v1/workflows/:id/execute-now', ({ p }) => { const e = execOr404(p.id); if (!e) return; if (e.status !== 'UPCOMING') return fail(400, 'Only upcoming runs can be started'); Object.assign(e, { status: 'IN_PROGRESS', startedAt: nowIso(), batchSubmittedAt: nowIso() }); ok(e); });
on('PATCH', '/api/v1/workflows/:id/schedule', ({ p, body }) => { const e = execOr404(p.id); if (!e) return; Object.assign(e, { scheduledAt: body.scheduledAt, updatedAt: nowIso() }); ok(e); });

// Conversations
on('GET', '/api/v1/conversations/:id', ({ p }) => { const c = conversations.get(p.id); c ? ok(c) : fail(404, `Conversation not found: ${p.id}`); });
on('GET', '/api/v1/conversations/:id/transcript', ({ p }) => {
  const c = conversations.get(p.id); if (!c?.transcriptText) return fail(404, 'No transcript for this conversation');
  R.res.writeHead(200, { ...cors(R.req), 'Content-Type': 'text/plain; charset=utf-8' }); R.res.end(c.transcriptText);
});
on('GET', '/api/v1/conversations/:id/audio', ({ p }) => {
  const c = conversations.get(p.id); if (!c?.durationSeconds) return fail(404, 'No recording for this conversation');
  file(wav(c.durationSeconds), 'audio/wav', `${p.id}.wav`);
});

// Dashboards
on('GET', '/api/v1/dashboard', () => ok(orgDashboard()));

// Templates
on('GET', '/api/v1/workflow-templates', ({ q }) => {
  let l = templates.map(templateView);
  if (q.get('status')) l = l.filter((t) => t.status === q.get('status'));
  const term = (q.get('search') || '').toLowerCase();
  if (term) l = l.filter((t) => [t.name, t.templateKey, t.description].some((v) => String(v || '').toLowerCase().includes(term)));
  ok(page(l, q), l.length);
});
on('GET', '/api/v1/workflow-templates/stats', () => ok({ total: templates.length, active: templates.filter((t) => t.status === 'ACTIVE').length, draft: templates.filter((t) => t.status === 'DRAFT').length, totalSteps: templates.reduce((s, t) => s + t.steps.length, 0) }));
on('POST', '/api/v1/workflow-templates', ({ body }) => {
  if (templates.some((t) => t.templateKey === body.templateKey)) return fail(409, `Template key already exists: ${body.templateKey}`);
  const t = { ...body, id: hex24(), orgId: ORG, status: 'DRAFT', createdBy: USER, createdAt: nowIso(), updatedAt: nowIso() };
  templates.push(t); ok(templateView(t));
});
on('GET', '/api/v1/workflow-templates/:id', ({ p }) => { const t = templates.find((x) => x.id === p.id); t ? ok(templateView(t)) : fail(404, 'Template not found'); });
on('PUT', '/api/v1/workflow-templates/:id', ({ p, body }) => { const t = templates.find((x) => x.id === p.id); if (!t) return fail(404, 'Template not found'); Object.assign(t, body, { id: t.id, orgId: ORG, updatedAt: nowIso() }); ok(templateView(t)); });
on('DELETE', '/api/v1/workflow-templates/:id', ({ p }) => { const i = templates.findIndex((x) => x.id === p.id); if (i >= 0) templates.splice(i, 1); ok(null); });
on('PATCH', '/api/v1/workflow-templates/:id/activate', ({ p }) => { const t = templates.find((x) => x.id === p.id); if (!t) return fail(404, 'Template not found'); t.status = 'ACTIVE'; ok(templateView(t)); });
on('PATCH', '/api/v1/workflow-templates/:id/deactivate', ({ p }) => { const t = templates.find((x) => x.id === p.id); if (!t) return fail(404, 'Template not found'); t.status = 'DRAFT'; ok(templateView(t)); });
on('GET', '/api/v1/workflow-templates/:id/agent-schema', ({ p }) => {
  const t = templates.find((x) => x.id === p.id); const rec = t && agentRecords.get(t.providerAgentId);
  if (!rec) return fail(404, 'Agent not found for this template');
  ok(rec);
});

// Call providers
on('GET', '/api/v1/call-providers', () => ok(PROVIDERS));
on('GET', '/api/v1/call-providers/:key/campaigns', ({ p }) => ok(p.key === 'exchange' ? [...new Map([...S.agents.map((a) => [a.key, a]), ...[...agentRecords.values()].map((r) => [r.agentId, { key: r.agentId, label: r.agentName, description: r.description }])]).values()].map((a) => ({ id: a.key, name: a.label, description: a.description || '' })) : []));
on('GET', '/api/v1/call-providers/:key/campaigns/:cid', ({ p }) => {
  const a = agentByKey(p.cid); if (!a) return fail(404, 'Campaign not found');
  ok({ id: a.key, name: a.label, description: a.description || '', inputFields: a.input_variables.map((v) => ({ name: v.key, type: v.type })), outputFields: a.output_variables.map((v) => ({ name: v.key, type: v.type })) });
});

// Build pages with nothing configured yet
on('GET', '/api/v1/transformation-catalog', () => ok([]));
on('GET', '/api/v1/admin/data-functions', ({ q }) => ok([], 0));

// ── Agents pushed by Echo (target: on every save) ────────────────────────────
const agentRecords = new Map();
for (const a of S.agents) {
  agentRecords.set(a.key, {
    agentId: a.key, agentName: a.label, description: a.description || '', voice: a.voice || 'Aoede', direction: 'outbound',
    ozonetelCampaign: a.ozonetel_campaign || '', syncedAt: a.synced_at || a.updated_at || a.created_at,
    inputFields: a.input_variables.map((v) => ({ key: v.key, type: v.type, required: true, label: v.key, shareOnCall: v.share_on_call !== false })),
    outputFields: a.output_variables.map((v) => ({ key: v.key, type: v.type, required: !!v.required, label: v.label, description: v.description, options: v.options })),
  });
}
function applyAgentToTemplate(t, rec) {
  if (!t || !rec) return;
  const contactKeys = new Set(['contact_name', 'contact_phone', 'contact_email', 'phone_number']);
  const prevMap = new Map((t.contextMappings || []).map((m) => [m.fieldName, m]));
  t.name = rec.agentName || t.name;
  t.description = rec.description ?? t.description;
  t.providerAgentSpec = { ...(t.providerAgentSpec || {}), voice: rec.voice, direction: rec.direction, lastPublishedAt: rec.syncedAt };
  t.contextMappings = rec.inputFields.filter((f) => !contactKeys.has(f.key)).map((f) => prevMap.get(f.key) || { fieldName: f.key, jsonPath: `$.${f.key}`, required: true, dataType: dataType(f.type) });
  const prevReq = new Map((t.requiredFields || []).map((r) => [r.fieldKey, r]));
  t.requiredFields = rec.outputFields.map((f) => ({ ...(prevReq.get(f.key) || { required: !!f.required, showOnDashboard: f.type === 'enum' || f.type === 'boolean' }), fieldKey: f.key, fieldLabel: f.label || f.key, dataType: dataType(f.type), extractionHint: f.description || '' }));
  t.updatedAt = nowIso();
}
on('POST', '/public/webhooks/exchange/agents', ({ body }) => {
  if (!body.id) return fail(400, 'Agent push is missing id');
  if (body.deleted) {
    agentRecords.delete(body.id);
    const hit = templates.filter((t) => t.providerAgentId === body.id);
    hit.forEach((t) => Object.assign(t, { status: 'ARCHIVED', archivedReason: 'Agent deleted in Echo', updatedAt: nowIso() }));
    return ok({ archived: hit.length });
  }
  const rec = {
    agentId: body.id, agentName: body.name, description: body.description || '', voice: body.voice || '', direction: body.direction || 'outbound',
    ozonetelCampaign: body.ozonetel_campaign || '', syncedAt: nowIso(),
    inputFields: (body.input_fields || []).map((f) => ({ key: f.key, type: f.type, required: f.required !== false, label: f.label || f.key, shareOnCall: f.share_on_call !== false })),
    outputFields: (body.output_fields || []).map((f) => ({ key: f.key, type: f.type, required: !!f.required, label: f.label || f.key, description: f.description, options: f.options })),
  };
  agentRecords.set(body.id, rec);
  const mapped = templates.filter((t) => t.providerAgentId === body.id);
  if (mapped.length) mapped.forEach((t) => applyAgentToTemplate(t, rec));
  else {
    const t = templateFrom({ id: hex24(), key: `EXCHANGE_${body.id.toUpperCase()}`, name: body.name }, agentByKey(body.id) || { key: body.id, voice: body.voice, created_at: nowIso(), input_variables: [], output_variables: [] }, { status: 'DRAFT', createdAt: nowIso() });
    applyAgentToTemplate(t, rec);
    templates.push(t);
  }
  ok({ stored: true, templates: mapped.length || 1 });
}, { open: true });

// Echo mock pairing: Exchange's completion webhook (two fields live, full payload in target mode).
on('POST', '/__mock/exchange-webhook', ({ body }) => ok(exchangeWebhook(body)), { open: true });

// Local sign-in: seeds the session the app restores from IndexedDB, then opens the app.
// Reached through the dev server proxy so it runs on the app's own origin.
on('GET', '/__local/signin', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = Date.now() + 30 * 86400000;
  const session = {
    user: { userId: USER, microsoftId: 'local', email: USER, name: 'Local Admin', displayName: 'Local Admin', photoUrl: null, roles: ['ADMIN'], permissions: [], countries: [{ idCountry: 356, name: 'India', countryCode: 91, idSubsidiary: 1, subsidiary: 'Local', idCurrency: 1, currency: 'INR', idTaxType: 1, taxType: 'GST' }] },
    tokens: { microsoftToken: 'local', casToken: `${b64({ alg: 'none' })}.${b64({ sub: USER, exp: Math.floor(exp / 1000) })}.local`, expiresAt: exp },
    savedAt: Date.now(),
  };
  const html = `<!doctype html><meta charset="utf-8"><title>Local sign in</title>
<body style="font:14px system-ui;padding:40px">Signing in locally…<script>
const s=${JSON.stringify(session)};const r=indexedDB.open('clarix-db',1);
r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('auth'))r.result.createObjectStore('auth')};
r.onsuccess=()=>{const tx=r.result.transaction('auth','readwrite');tx.objectStore('auth').put(s,'session');tx.oncomplete=()=>location.replace(${JSON.stringify(APP_HOME)})};
r.onerror=()=>document.body.textContent='Could not open IndexedDB: '+r.error;
</script>`;
  R.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); R.res.end(html);
}, { open: true });

function wav(seconds) {
  const rate = 8000, n = Math.round(rate * Math.min(Math.max(seconds || 6, 3), 600));
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { const t = i / rate; buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 200 * t) * 1500 * (Math.floor(t / 1.4) % 2 ? 0.2 : 1)), 44 + i * 2); }
  return buf;
}

function handler(req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors(req)); return res.end(); }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
  R = { req, res };
  if (!route) return fail(404, `No mock for ${req.method} ${url.pathname}`);
  if (!route.open && !/^Bearer .+/.test(req.headers.authorization || '')) return fail(401, 'Unauthorized');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks);
    let body = {};
    if ((req.headers['content-type'] || '').includes('application/json') && raw.length) {
      try { body = JSON.parse(raw.toString('utf8')); } catch { R = { req, res }; return fail(400, 'Bad JSON'); }
    }
    const p = Object.fromEntries(Object.entries(route.re.exec(url.pathname).groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
    R = { req, res };
    try { await route.fn({ req, res, q: url.searchParams, p, body, raw }); }
    catch (e) { console.error(e); R = { req, res }; fail(500, e.message); }
  });
}

// CAS is only called by the Microsoft sign-in; GenBI has no sample data. Both answer
// politely so nothing hangs.
function casHandler(req, res) {
  const h = cors(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, h); return res.end(); }
  res.writeHead(501, { ...h, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 501, message: 'Microsoft sign in is not available locally. Open /__local/signin instead.', success: false }));
}
function genbiHandler(req, res) {
  const h = cors(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, h); return res.end(); }
  const path = new URL(req.url, 'http://x').pathname;
  const body = /\/stats$/.test(path) ? {} : /\/health\/check$/.test(path) ? { status: 'ok' } : [];
  res.writeHead(200, { ...h, 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
}
// The public demo runs this file in a service worker (mock/browser) and calls the handlers directly.
if (!globalThis.__CLARIX_DEMO__) {
  http.createServer(handler).listen(PORT, () => console.log(`[clarix-mock] api on http://localhost:${PORT}`));
  http.createServer(casHandler).listen(CAS_PORT, () => console.log(`[clarix-mock] cas on http://localhost:${CAS_PORT}`));
  http.createServer(genbiHandler).listen(GENBI_PORT, () => console.log(`[clarix-mock] genbi on http://localhost:${GENBI_PORT}`));
  console.log(`[clarix-mock] ${MODE} mode. ${templates.length} templates, ${sheets.length} sheets, ${executions.length} executions. Sign in: http://localhost:4310/__local/signin`);
}
export { handler, casHandler, genbiHandler };
