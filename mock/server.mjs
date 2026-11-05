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
import { registerReports, withReason } from './reports.mjs';
import { TRACKER, trackerAgent, trackerCampaign } from './rows-seed.mjs';
import { registerOrchestration } from './orchestration.mjs';
import { PEOPLE, auditRequest, auditView, AUDIT_COLUMNS, securityView, saveSecurity, testSso, newScimToken, deleteContact, isDeleted, supplierView } from './wave4.mjs';
import { accessView, accessCreate, accessUpdate, accessRemove, accessActorFor, accessMe, setPreview, previewBlock, previewShape, seesCampaign, claimCampaign } from './access.mjs';
import { liveCalls, liveAction, BUYER_LIST, telephonyView, testCarrier, connectCarrier, disconnectCarrier, saveSlots, copilotAnswer, COPILOT_SUGGESTIONS } from './wave3.mjs';
import { qaScorecard, saveQa, testsView, runTests, scenariosFromCalls, versionsView, saveDraft, publishDraft, setSplit, memoryOf } from './wave2.mjs';
import { dncScan, dncView, dncAdd, dncRemove, dncSettings, onDnc, alertsView, saveAlerts, resumeCampaign, handlingOf, saveHandling, rerunAnswers, diagnosticsOf } from './wave1.mjs';
import { CONNECTORS, testConnection, suggestMapping, buildCalls, markCalled, callsCsv, writeBackPreview, nextRuns as dsNextRuns, getSetup, saveSetup, defaultSetup, runsOf, addRun, webhookUrl, hasSetup, FILTER_OPS, SOURCE_COLUMNS } from './data-sources.mjs';
import { decideStatus, resultFromAnswers, scopeRows, buildReport, rowsInBox, exportTable, agentChoices, normalisePhone, callingReport, personOutcome, checkOutcomeChange, neighbours, ANSWERED_REASONS, filterRows, logFilters, campaignSummaries, filterCampaigns, followUpRows, followUpAction,
  statsByAgent, unitsFor, campaignStats, columnValues, followChecklist, FOLLOW_COLUMNS, tasksSummary, actionNeeded, actionAct, ACTION_COLUMNS, agentStats, unitLabel, flatValues, campaignColumns,
  setAgentMetrics, allCountryRules, setCountryRule, resetCountryRule, registerCheck, countriesOf, retryPreview, checkUploadRow, uploadNote, agentTips, RETRY_SCHEDULES, retryRules, retryRuleOf, retryGaps, retryPlan, defaultRetryRule, callSteps, sendMessage, presentSheet, buildDummyRow, cleanRetryRule } from './calling-report.mjs';
/** Number columns of a row's upload, for counting by POs, items and other per-agent stats. */
const numbersOf = (ctx) => Object.fromEntries(Object.entries(ctx || {}).filter(([, v]) => v !== '' && v != null && typeof v !== 'object' && !isNaN(Number(v))).map(([k, v]) => [k, Number(v)]));

const PORT = Number(process.env.CLARIX_API_PORT || 8081);
const CAS_PORT = Number(process.env.CLARIX_CAS_PORT || 9000);
const GENBI_PORT = Number(process.env.CLARIX_GENBI_PORT || 8000);
const ECHO_URL = process.env.ECHO_URL || 'http://localhost:8090';
const APP_HOME = '/dashboard/overview';
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
  executions.push(withReason(exec));
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
  claimCampaign(sheet.id); sheets.push(sheet);
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
  let list = executions.filter((e) => (!templateId || e.templateId === templateId) && seesCampaign(e.batchId));
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
const permissions = PERMISSION_KEYS.map((key, i) => ({ id: `perm_${i + 1}`, key, displayName: key.split(':').map((s) => s.replace(/-/g, ' ')).join(' / '), description: '', category: key.split(':')[0].toUpperCase(), createdAt: plus(firstBatchAt, -30 * 86400000), updatedAt: plus(firstBatchAt, -30 * 86400000) }));
const modules = [
  { id: 'mod_workflows', name: 'workflows', displayName: 'Workflows', description: 'Agents, sheets and call logs', permissions: PERMISSION_KEYS.filter((k) => k.startsWith('workflows')), enabled: true },
  { id: 'mod_genbi', name: 'genbi', displayName: 'GenBI', description: 'Ask questions of your data', permissions: ['genbi:menuvisibility'], enabled: true },
  { id: 'mod_admin', name: 'admin', displayName: 'Admin', description: 'Permissions and modules', permissions: PERMISSION_KEYS.filter((k) => /^(permissions|modules|manage)/.test(k)), enabled: true },
].map((m) => ({ ...m, updatedBy: USER, updatedAt: plus(firstBatchAt, -30 * 86400000) }));
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
  // CSV with quoted cells: "5000101, 5000102" stays one cell.
  const text = file.content.toString('utf8').replace(/^﻿/, ''); const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cell.trim()); cell = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell.trim()); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

async function dispatchToEcho(template, sheet, rows) {
  const payload = { batchId: sheet.id, name: `${template.name}_${sheet.id}`, agent: template.providerAgentId, rows, fileName: sheet.originalFilename, uploadedBy: sheet.uploadedBy };
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
// Preview as (Team and access): lists drop other teams' campaigns and Viewers get masked numbers.
const send = (status, body) => { R.res.writeHead(status, { ...cors(R.req), 'Content-Type': 'application/json' }); R.res.end(JSON.stringify(previewShape(body))); };
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
// ── A team sheet whose rows share calls (the same data as the Echo mock, from the same seed file) ──
// Clarix never groups. Echo sends, for every row: the call it was on, its place in that call, its row state and its answers.
{
  const ROW_STATES = { rejected: 'Rejected', skipped: 'Skipped', waiting: 'Waiting', answered: 'Answered', partly: 'Partly answered', not_covered: 'Not covered', not_reached: 'Not reached' };
  const agent = trackerAgent(plus(nowIso(), -2 * 86400000)); const { campaign, calls } = trackerCampaign(nowIso());
  const template = templateFrom({ id: TRACKER.templateId, key: TRACKER.templateKey, name: 'Order tracker follow up' }, agent,
    { description: 'Calls each vendor once about all of its open order lines and brings back an answer for every line.', event: 'ORDER_FOLLOW_UP', createdAt: plus(campaign.created_at, -2 * 86400000) });
  template.rowsShareCalls = true; templates.push(template);
  const batch = { id: TRACKER.batch, uploadedBy: S.operators[0], createdAt: campaign.created_at };
  const total = campaign.contacts.reduce((n, x) => n + x.items.length, 0) + (campaign.skipped_rows || []).length;
  sheets.push({ id: batch.id, orgId: ORG, templateId: template.id, templateName: template.name, eventType: template.triggerEventTypes[0], sourceSystem: 'CSV', originalFilename: TRACKER.file, fileUrl: null,
    uploadedBy: batch.uploadedBy, total, triggered: total, failed: 0, failedRows: [], createdAt: batch.createdAt, rowsShareCalls: true,
    skippedRows: (campaign.skipped_rows || []).map((r) => ({ row: r.row, say: `${r.values.item}, ${r.values.open_qty} open`, reason: r.reason, contact: r.contact })) });
  const rowId = (n) => `6ac0ffee5eed00a1b2${String(100000 + n).slice(1)}c`;
  for (const x of campaign.contacts) {
    const lastA = (x.attempts_detail || []).slice(-1)[0]; const call = calls.find((k) => k.call_id === x.call_id);
    const o = x.status === 'retry_scheduled' ? 'will_retry' : lastA?.outcome || 'waiting'; const g = OUTCOMES[o]?.group;
    const talked = (x.attempts_detail || []).some((t) => t.stream?.connected);
    const cs = x.status === 'completed' ? 'COMPLETED' : x.status === 'retry_scheduled' ? 'RETRY_SCHEDULED' : x.status === 'retry_exhausted' ? 'RETRY_EXHAUSTED' : String(x.status).toUpperCase();
    const status = WORKFLOW_OF(cs); const answers = Array.isArray(x.outputs?.rows) ? x.outputs.rows : [];
    for (const it of x.items) {
      const ans = answers.find((a) => Number(a.row) === it.n); const got = ans && ans.line_status !== 'not_covered' ? ans : null;
      const state = got ? 'answered' : talked && g !== 'not_reached' ? 'not_covered' : g === 'in_progress' ? 'waiting' : 'not_reached';
      const fields = got ? Object.fromEntries(Object.entries(got).filter(([k, v]) => k !== 'row' && v !== '' && v != null)) : null;
      addExecution({ id: rowId(it.row), template, batch, row: { name: x.name, phone: x.phone, context: { ...x.context, ...it.values, rows: undefined, row_count: undefined } }, status,
        submittedAt: x.dispatched_at, completedAt: status === 'IN_PROGRESS' ? null : call?.ended_at || lastA?.ended_at || null, duration: call ? Math.round(call.duration_seconds) : null, extracted: fields,
        conv: { callStatus: cs, callResult: x.call_result ? x.call_result.toUpperCase() : null, callReason: lastA?.mapped?.reason ? lastA.mapped.reason.toUpperCase() : null, outcome: o, attempts: (x.attempts_detail || []).length,
          attemptLog: x.attempts_detail || [], nextAttemptAt: x.next_attempt_at || null,
          transcriptText: call ? call.events.filter((e) => e.kind.endsWith('_TURN')).map((e) => `${e.kind === 'AGENT_TURN' ? 'Agent' : 'Customer'}: ${e.text}`).join('\n') : null } });
      const dur = call?.duration_seconds || 0;
      Object.assign(executions[executions.length - 1], { sheetRow: it.row, rowState: state, rowStateLabel: ROW_STATES[state], sayAs: `${it.values.item}, ${it.values.open_qty} open`, lastTime: it.last || null,
        savedSecond: got && dur ? Math.round(dur * (0.2 + (0.7 * it.n) / (x.items.length + 0.5))) : null,
        // The call this row was on, as Echo reports it. Rows of one contact share it.
        echoCall: { key: x.primary_id, id: x.call_id || null, position: it.n, rows: x.items.length, part: x.part, parts: x.parts, label: x.parts > 1 ? `call ${x.part} of ${x.parts}` : '', contact: x.name, phone: x.phone } });
    }
  }
}
executions.forEach(withReason);
/**
 * Echo reads the transcript once when a caller talked and hung up before the agent saved anything, and sends what it
 * could keep. The mock applies the same rule as the Echo mock, so both prototypes show the same rows.
 */
function fillFromTranscripts() {
  for (const e of executions) {
    if ((e.extractedFields && Object.keys(e.extractedFields).length) || e.outcome !== 'caller_hung_up') continue;
    const said = String(conversations.get(e.activeConversationId)?.transcriptText || '').split('\n').map((l) => l.trim()).filter((l) => /^(user|caller|customer|supplier|contact)\b/i.test(l));
    const text = (templates.find((t) => t.id === e.templateId)?.requiredFields || []).find((f) => /remark|note|summary|comment/i.test(f.fieldKey));
    if (said.length < 2 || !text || [...String(e.id)].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 2) continue;
    e.extractedFields = { [text.fieldKey]: `Caller said: "${said.slice(-1)[0].replace(/^[^:]*:\s*/, '')}"` }; e.answersSource = 'transcript';
  }
}
fillFromTranscripts();
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
on('GET', '/api/v1/admin/modules', ({ q }) => { const term = (q.get('search') || '').toLowerCase(); const l = modules.filter((m) => !term || [m.name, m.displayName].some((v) => String(v).toLowerCase().includes(term))); ok(page(l, q), l.length); });
on('POST', '/api/v1/admin/permissions', ({ body }) => {
  if (!body.key) return fail(400, 'Key is required');
  if (permissions.some((x) => x.key === body.key)) return fail(409, `Permission already exists: ${body.key}`);
  const x = { id: `perm_${hex24().slice(0, 8)}`, key: body.key, displayName: body.displayName || body.key, description: body.description || '', category: body.category || body.key.split(':')[0].toUpperCase(), createdAt: nowIso(), updatedAt: nowIso() };
  permissions.push(x); ok(x);
});
on('GET', '/api/v1/admin/permissions/:id', ({ p }) => { const x = permissions.find((y) => y.id === p.id); x ? ok(x) : fail(404, 'Permission not found'); });
on('PUT', '/api/v1/admin/permissions/:id', ({ p, body }) => { const x = permissions.find((y) => y.id === p.id); if (!x) return fail(404, 'Permission not found'); Object.assign(x, body, { id: x.id, updatedAt: nowIso() }); ok(x); });
on('DELETE', '/api/v1/admin/permissions/:id', ({ p }) => { const i = permissions.findIndex((y) => y.id === p.id); if (i >= 0) permissions.splice(i, 1); ok(null); });
on('POST', '/api/v1/admin/modules', ({ body }) => { const m = { id: `mod_${hex24().slice(0, 8)}`, enabled: true, permissions: [], ...body, createdAt: nowIso(), updatedAt: nowIso(), updatedBy: USER }; modules.push(m); ok(m); });
on('GET', '/api/v1/admin/modules/:id', ({ p }) => { const m = modules.find((y) => y.id === p.id); m ? ok(m) : fail(404, 'Module not found'); });
on('PUT', '/api/v1/admin/modules/:id', ({ p, body }) => { const m = modules.find((y) => y.id === p.id); if (!m) return fail(404, 'Module not found'); Object.assign(m, body, { id: m.id, updatedAt: nowIso(), updatedBy: USER }); ok(m); });
on('PATCH', '/api/v1/admin/modules/:id/enabled', ({ p, q }) => { const m = modules.find((y) => y.id === p.id); if (!m) return fail(404, 'Module not found'); Object.assign(m, { enabled: q.get('enabled') === 'true', updatedAt: nowIso(), updatedBy: USER }); ok(m); });
on('DELETE', '/api/v1/admin/modules/:id', ({ p }) => { const i = modules.findIndex((y) => y.id === p.id); if (i >= 0) modules.splice(i, 1); ok(null); });

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
  let l = sheets.filter((x) => seesCampaign(x.id)).map(sheetView);
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

// ── Overview and Call Logs (live Clarix, Oct 2026): Echo's 12 call status buckets plus Bad data ──
const BUCKETS = ['completed', 'caller_hung_up', 'no_reply', 'voicemail', 'no_answer', 'busy', 'unreachable', 'wrong_number', 'blocked', 'rejected', 'call_dropped', 'network_error'];
const BUCKET_LABEL = { completed: 'Completed', caller_hung_up: 'Caller hung up', no_reply: 'No reply', voicemail: 'Voicemail', no_answer: 'Not picked', busy: 'Busy/Callback Requested',
  unreachable: 'Unreachable', wrong_number: 'Wrong number', blocked: 'Blocked', rejected: 'Rejected', call_dropped: 'Call dropped', network_error: 'Network error', bad_data: 'Bad data', unresolved: 'Not yet classified' };
const STATUS_REASON = { completed: 'The agent finished the conversation', caller_hung_up: 'The caller hung up before the agent finished',
  no_reply: 'The call was picked up but the caller never spoke', voicemail: 'Voicemail or a recorded message answered', no_answer: 'It rang but nobody answered',
  busy: 'The line was busy', unreachable: 'The number was switched off or out of reach', wrong_number: 'The number is invalid', blocked: 'The number is blocked',
  rejected: 'The caller rejected the call', call_dropped: 'The call connected but the agent audio never went out',
  network_error: 'An unrecognised provider response (flagged for review) (InterWorkingUnspecified)', bad_data: 'Missing or invalid data in the sheet', unresolved: '' };
const GROUP_OF = { completed: 'reached', caller_hung_up: 'reached', no_reply: 'reached', voicemail: 'reached', call_dropped: 'reached', wrong_number: 'reached',
  no_answer: 'not_reached', busy: 'not_reached', unreachable: 'not_reached', blocked: 'not_reached', rejected: 'not_reached', network_error: 'failed' };
const NOT_DIALLED = new Set(['bad_data', 'repeated_number', 'stopped']);
const bucketOf = (e) => { const o = e.outcome || (e.status === 'COMPLETED' ? 'completed' : null); return BUCKETS.includes(o) ? o : 'unresolved'; };
const dialled = (e) => !NOT_DIALLED.has(e.outcome) && ((e.attemptLog?.length || 0) > 0 || (!e.callStatus && e.status === 'COMPLETED'));
const turnsOf = (e) => String(conversations.get(e.activeConversationId)?.transcriptText || '').split('\n').filter((l) => l.trim()).length;
function voiceRow(e) {
  const t = templates.find((x) => x.id === e.templateId); const s = sheets.find((x) => x.id === e.batchId);
  const key = bucketOf(e); const out = e.extractedFields || {}; const last = (e.attemptLog || []).slice(-1)[0];
  const conv = conversations.get(e.activeConversationId);
  const said = Object.entries(out).filter(([, v]) => v !== '' && v != null && typeof v !== 'object').slice(0, 3).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join('; ');
  return { call_id: e.id, primary_id: e.id, campaign_id: e.batchId, call_time: last?.startedAt || e.batchSubmittedAt || e.createdAt,
    agent: t?.name || '', campaign: s?.originalFilename || '', uploaded_by: e.triggeredBy || '', caller_name: e.name || '', phone: e.resolvedContact?.phone || '', email: e.resolvedContact?.email || '',
    summary: conv?.postCallIntelligence?.summary?.mom?.[0] || said, status: BUCKET_LABEL[key], status_key: key, status_reason: STATUS_REASON[key] || '',
    callback_at: out.callback_date || out.callback_time ? [out.callback_date, out.callback_time].filter(Boolean).join(' ') : null,
    duration_seconds: e.callDurationSeconds ?? null, retries: Math.max(0, (e.attemptLog?.length || e.attemptNumber || 1) - 1),
    goal_reached: Object.keys(out).length ? 'Yes' : 'No' };
}
const inScope = (e, q) => (!q.get('from') || e.createdAt >= new Date(q.get('from')).toISOString()) && (!q.get('to') || e.createdAt <= new Date(q.get('to')).toISOString()) && (!q.get('templateId') || e.templateId === q.get('templateId'));
/** Period, status chips and column filters, as Overview and Call Logs send them (from, to, status, filters, templateId). */
function voiceScope(q, skipCol) {
  const statuses = (q.get('status') || '').split(',').filter(Boolean);
  let filters = {}; try { filters = JSON.parse(q.get('filters') || '{}'); } catch { /* ignore bad filters */ }
  return executions.filter((e) => dialled(e) && inScope(e, q)).map(voiceRow).filter((r) => (!statuses.length || statuses.includes(r.status_key))
    && Object.entries(filters).every(([col, f]) => {
      if (col === skipCol || !f) return true; const v = r[col];
      if (f.in) return f.in.includes(v == null ? '' : String(v));
      if (f.contains) return String(v ?? '').toLowerCase().includes(String(f.contains).toLowerCase());
      if (f.from || f.to) { const t = Date.parse(v); return !!t && (!f.from || t >= Date.parse(f.from)) && (!f.to || t <= Date.parse(f.to) + 86399999); }
      if (f.min != null || f.max != null) return v != null && (f.min == null || v >= f.min) && (f.max == null || v <= f.max);
      return true;
    })).sort((a, b) => Date.parse(b.call_time) - Date.parse(a.call_time));
}
function callStatus(rows, badData = 0) {
  const m = { attempted: rows.length, unresolved: 0, bad_data: badData }; for (const k of BUCKETS) m[k] = 0;
  for (const r of rows) m[r.status_key] = (m[r.status_key] || 0) + 1;
  return m;
}
const badDataIn = (q, sheetId) => sheets.filter((s) => (!sheetId || s.id === sheetId) && (!q || ((!q.get('from') || s.createdAt >= new Date(q.get('from')).toISOString()) && (!q.get('templateId') || s.templateId === q.get('templateId')))))
  .reduce((n, s) => n + (s.failedRows?.length || 0), 0) + executions.filter((e) => e.outcome === 'bad_data' && (!sheetId || e.batchId === sheetId) && (!q || inScope(e, q))).length;
function voiceMetrics(q) {
  const list = executions.filter((e) => inScope(e, q));
  const inSheets = sheets.filter((s) => (!q.get('from') || s.createdAt >= new Date(q.get('from')).toISOString()) && (!q.get('templateId') || s.templateId === q.get('templateId')));
  const planned = inSheets.reduce((n, s) => n + (s.total || 0), 0);
  const gated = inSheets.reduce((n, s) => n + (s.failedRows?.length || 0), 0) + list.filter((e) => NOT_DIALLED.has(e.outcome)).length;
  const dial = list.filter(dialled);
  const reached = dial.filter((e) => GROUP_OF[bucketOf(e)] === 'reached' || (!e.callStatus && e.status === 'COMPLETED'));
  const completed = reached.filter((e) => e.status !== 'IN_PROGRESS');
  const conversation = completed.filter((e) => bucketOf(e) === 'completed');
  const achieved = conversation.filter((e) => e.extractedFields && Object.keys(e.extractedFields).length).length;
  const attempts = dial.reduce((n, e) => n + (e.attemptLog?.length || 1), 0);
  const withDur = list.filter((e) => e.callDurationSeconds != null);
  const turns = withDur.reduce((n, e) => n + turnsOf(e), 0);
  const rate = (a, b) => (b ? a / b : 0);
  return {
    funnel: {
      planned, campaigns: inSheets.length, will_dial: planned - gated, gated,
      attempted: dial.length, connected: reached.length, connected_rate: rate(reached.length, dial.length), completed: completed.length,
      achieved, achieved_rate: rate(achieved, conversation.length), inconclusive: conversation.length - achieved, inconclusive_rate: rate(conversation.length - achieved, conversation.length),
      callbacks_open: list.filter((e) => e.extractedFields?.callback_time || e.extractedFields?.callback_date).length,
      tech_failures: list.filter((e) => e.outcome === 'call_dropped').length,
      attempts, attempts_per_call: dial.length ? Math.round((attempts / dial.length) * 10) / 10 : 0,
      talk_seconds: withDur.reduce((n, e) => n + e.callDurationSeconds, 0), open: list.filter((e) => e.status === 'IN_PROGRESS').length,
    },
    call_status: callStatus(voiceScope(q), badDataIn(q)),
    active_calls: list.filter((e) => e.status === 'IN_PROGRESS' && ['CALLING', 'IN_PROGRESS'].includes(e.callStatus)).length,
    avg_duration_seconds: withDur.length ? Math.round((withDur.reduce((n, e) => n + e.callDurationSeconds, 0) / withDur.length) * 10) / 10 : 0,
    avg_turns_per_call: withDur.length ? Math.round((turns / withDur.length) * 10) / 10 : 0,
    total_tokens: turns * 380, total_turns: turns, total_calls: withDur.length,
  };
}
const CALL_LOG_COLUMNS = [['call_time', 'Call Date'], ['agent', 'Agent'], ['campaign', 'Campaign'], ['uploaded_by', 'Uploaded by'], ['caller_name', 'Caller Name'], ['phone', 'Phone'], ['email', 'Email'],
  ['summary', 'Call Summary'], ['status', 'Call Status'], ['status_reason', 'Status Reason'], ['callback_at', 'Call back'], ['duration_seconds', 'Duration'], ['retries', 'Retries'], ['goal_reached', 'Goal Reached']];
// ── Calling report (Calling-Report-Logic.md v1). Echo decides each row's status; the mock mirrors the same rules. ──
// Phones the workspace treats as internal tests. Demo seed: the admin's one-row trial upload (logic doc section 2, row 1).
const TEST_NUMBERS = new Set((S.batches || []).filter((b) => b.uploadedBy === 'demo.admin@example.com' && b.rows.length === 1).slice(0, 1).map((b) => normalisePhone(b.rows[0].phone)));
const DND_LINE = new Set(['unreachable', 'blocked', 'rejected', 'network_error']);
function executionFacts(e) {
  const o = e.outcome || (e.status === 'COMPLETED' ? 'completed' : e.status === 'IN_PROGRESS' ? 'waiting' : ['STOPPED', 'CANCELLED'].includes(e.status) ? 'stopped' : 'network_error');
  const said = String(conversations.get(e.activeConversationId)?.transcriptText || '');
  return {
    isTest: TEST_NUMBERS.has(normalisePhone(e.resolvedContact?.phone)),
    badData: o === 'bad_data' ? 'Failed the upload check' : o === 'repeated_number' ? 'Same phone number as an earlier row' : null,
    stopped: o === 'stopped' || o === 'expired', inProgress: ['waiting', 'calling', 'on_call', 'will_retry'].includes(o) || e.status === 'IN_PROGRESS',
    // Open question Q1: a busy tone counts as not picked (No answer) until PM decides otherwise.
    line: o === 'no_answer' || o === 'busy' ? 'no_answer' : DND_LINE.has(o) ? 'dnd' : o === 'voicemail' ? 'voicemail' : 'picked',
    talkSeconds: e.callDurationSeconds || 0, spoke: /^(customer|caller|user|supplier):/im.test(said) || ['completed', 'caller_hung_up', 'wrong_number'].includes(o) && !said,
    audioFailed: o === 'call_dropped', result: o === 'wrong_number' ? 'wrong_number' : resultFromAnswers(e.extractedFields, e.id),
  };
}
function callingRow(e) {
  const facts = executionFacts(e); const key = `${e.status}|${e.outcome}|${(e.attemptLog || []).length}|${facts.isTest}`;
  // Decided once when the row is final; kept with the execution (plan D7).
  if (!e.report || e.report.key !== key) e.report = { key, ...decideStatus(facts), decided_at: nowIso() };
  const t = templates.find((x) => x.id === e.templateId); const s = sheets.find((x) => x.id === e.batchId);
  const last = (e.attemptLog || []).slice(-1)[0]; const out = e.extractedFields || {}; const conv = conversations.get(e.activeConversationId);
  const said = Object.entries(out).filter(([, v]) => v !== '' && v != null && typeof v !== 'object').slice(0, 3).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join('; ');
  const d = personOutcome(e.report, e.outcome_override);
  return { id: e.id, call_id: e.id, campaign_id: e.batchId, call_date: last?.startedAt || (e.report.call_status === 'Bad data' ? null : e.batchSubmittedAt || e.createdAt), uploaded_at: s?.createdAt || e.createdAt,
    agent: t?.name || '', agent_key: e.templateId, campaign: s?.originalFilename || '', uploaded_by: e.triggeredBy || s?.uploadedBy || '',
    caller_name: e.name || '', phone: e.resolvedContact?.phone || '', email: e.resolvedContact?.email || '', summary: conv?.postCallIntelligence?.summary?.mom?.[0] || said,
    call_status: d.call_status, status_reason: d.status_reason, goal_reached: d.goal_reached, test_status: e.report.test_status, test_goal: e.report.test_goal,
    outcome_source: d.outcome_source, changed_by: d.changed_by, changed_at: d.changed_at, change_note: d.change_note, review_status_reason: d.review_status_reason,
    callback_at: out.callback_date || out.callback_time ? [out.callback_date, out.callback_time].filter(Boolean).join(' ') : null,
    duration_seconds: e.callDurationSeconds ?? null, retries: Math.max(0, (e.attemptLog?.length || 1) - 1), units: numbersOf(e.context),
    // The row as uploaded, and what the agent saved: the campaign page shows both as columns.
    inputs: flatValues(e.context), answers: flatValues(out) };
}
function callingRows() {
  const rows = executions.filter((e) => seesCampaign(e.batchId)).map(callingRow);
  // Rows that failed the upload check never became executions: they still count as uploaded, Bad data.
  for (const s of sheets) {
    const t = templates.find((x) => x.id === s.templateId);
    (s.failedRows || []).forEach((f, i) => rows.push({ id: `${s.id}:bad:${f.row ?? i}`, call_id: null, campaign_id: s.id, call_date: null, uploaded_at: s.createdAt, agent: t?.name || s.templateName || '', agent_key: s.templateId,
      campaign: s.originalFilename || '', uploaded_by: s.uploadedBy || '', caller_name: '', phone: '', email: '', summary: '', ...decideStatus({ badData: f.reason || 'Failed the upload check' }), callback_at: null, duration_seconds: null, retries: 0 }));
  }
  return rows;
}
function callingScope(q) {
  const days = Number(q.get('days') || 0);
  return { from: q.get('from') || (days ? new Date(Date.now() - days * 86400000).toISOString() : null), to: q.get('to') || null,
    agents: (q.get('agents') || '').split(',').filter(Boolean), includeTests: q.get('include_tests') === '1', campaign: q.get('campaign') || '', unit: q.get('unit') || '' };
}
const clarixAgentsMeta = () => templates.map((t) => ({ key: t.id, label: t.name, numberFields: (t.contextMappings || []).filter((m) => m.dataType === 'NUMBER').map((m) => m.fieldName),
  columns: (t.contextMappings || []).map((m) => ({ field: m.fieldName, type: String(m.dataType || '').toLowerCase() })) }));
on('GET', '/api/v1/reports/calling', ({ q }) => {
  // The call log's search and column filters scope the whole report, so a multi-select pick changes the funnel too.
  const all = filterRows(callingRows(), logFilters(q)); const sc = callingScope(q);
  const agentsAll = agentChoices(all, sc);
  ok(callingReport(all, sc, { workspace: 'Moglix', agentsAll, unitsAvailable: unitsFor(scopeRows(all, { ...sc, agents: [] }), clarixAgentsMeta()) }));
});
// One call page: every call list opens this, by report row id (the execution id, or "sheet:bad:row" for rejected rows).
function callDetail(id) {
  const rows = callingRows(); const row = rows.find((r) => r.id === id); if (!row) return null;
  const e = executions.find((x) => x.id === row.call_id); const conv = e ? conversations.get(e.activeConversationId) : null;
  const t = templates.find((x) => x.id === row.agent_key); const labels = new Map((t?.requiredFields || []).map((f) => [f.fieldKey, f.fieldLabel]));
  const turns = String(conv?.transcriptText || '').split('\n').map((l) => /^([^:]{2,20}):\s*(.*)$/.exec(l.trim())).filter(Boolean)
    .map((m) => ({ who: /^agent/i.test(m[1]) ? 'Agent' : 'Caller', text: m[2], at: null }));
  return { ...row, ...neighbours(rows, row), dials_count: e?.attemptLog?.length || (e?.callDurationSeconds ? 1 : 0),
    answers: Object.entries(e?.extractedFields || {}).filter(([, v]) => v !== '' && v != null).map(([k, v]) => ({ key: k, label: labels.get(k) || k.replace(/_/g, ' '), value: typeof v === 'object' ? JSON.stringify(v) : String(v) })),
    inputs: Object.entries(e?.context || {}).filter(([, v]) => v !== '' && v != null && typeof v !== 'object').map(([k, v]) => ({ key: k, value: String(v) })),
    transcript: turns, has_audio: !!conv?.durationSeconds, audio_path: conv?.durationSeconds ? `/api/v1/conversations/${conv.id}/audio` : null,
    dials: (e?.attemptLog || []).map((a, i) => ({ n: i + 1, at: a.startedAt, ring_seconds: a.ringSeconds ?? null, talk_seconds: a.talkSeconds ?? null,
      result: a.outcome ? (OUTCOMES[a.outcome]?.label || a.outcome) : a.callStatus || '', provider: a.provider ? [a.provider.Status, a.provider.DialStatus, a.provider.CustomerStatus].filter(Boolean).join(' · ') : '' })),
    timeline: e ? eventsOf(e).map((v) => ({ at: v.createdAt, type: v.eventType.replace(/_/g, ' ').toLowerCase(), status: v.status, detail: v.errorMessage || '' })) : [],
    outcome_options: ANSWERED_REASONS, product: 'clarix' };
}
// ── Shared screens (phase 3): campaigns, follow ups, new campaign. Same paths and shapes as the Echo mock. ──
const campaignScope = (q) => ({ from: q.get('from') || null, to: q.get('to') || null, state: q.get('state') || 'all', q: q.get('q') || '' });
on('GET', '/api/v1/reports/calling/campaigns', ({ q }) => {
  const all = callingRows(); const metas = statsByAgent(clarixAgentsMeta());
  const list = filterCampaigns(campaignSummaries(all), campaignScope(q)).map((c) => ({ ...c, stats: campaignStats(all.filter((r) => r.campaign_id === c.campaign_id), metas.find((m) => m.agent === c.agent_key)?.stats || []) }));
  const skip = Number(q.get('skip') || 0), limit = Number(q.get('limit') || 20);
  ok({ rows: list.slice(skip, skip + limit), total: list.length, running: list.filter((c) => c.status === 'Running').length });
});
on('GET', '/api/v1/reports/calling/campaigns/:id', ({ p }) => {
  const rows = callingRows(); const c = campaignSummaries(rows).find((x) => x.campaign_id === p.id);
  c ? ok({ ...c, columns: campaignColumns(rows.filter((r) => r.campaign_id === p.id)) }) : fail(404, 'Campaign not found');
});
on('POST', '/api/v1/reports/calling/campaigns/:id/stop', ({ p }) => {
  const live = executions.filter((e) => e.batchId === p.id && e.status === 'IN_PROGRESS'); live.forEach((e) => finishExecution(e, 'STOPPED', { by: USER })); ok({ stopped: live.length });
});
on('GET', '/api/v1/reports/calling/follow-ups', ({ q }) => ok(followUpRows(scopeRows(callingRows(), callingScope(q)), q.get('tab') || 'callback', q.get('show') || 'open')));
on('POST', '/api/v1/reports/calling/follow-ups/:id', ({ p, body }) => ok(followUpAction(p.id, body?.action || 'open', USER)));
// New campaign: pick an agent, get its template, check the file, start.
const newCampaignAgents = () => templates.filter((t) => t.status === 'ACTIVE').map((t) => ({ key: t.id, label: t.name, inputs: ['contact_name', 'contact_phone', 'contact_email', ...(t.contextMappings || []).map((m) => m.fieldName)] }));
on('GET', '/api/v1/reports/calling/new-campaign/agents', () => ok(newCampaignAgents()));
on('GET', '/api/v1/reports/calling/new-campaign/template.xlsx', ({ q }) => {
  const a = newCampaignAgents().find((x) => x.key === q.get('agent')); if (!a) return fail(404, 'Agent not found'); file(writeXlsx([a.inputs], 'Contacts'), XLSX, `${a.label.replace(/[^A-Za-z0-9]+/g, '_')}_template.xlsx`);
});
function newCampaignRows(t, form) {
  const [headers, ...data] = readSheet(form.file); const col = (k) => headers.findIndex((h) => String(h).trim().toLowerCase().replace(/[^a-z0-9]/g, '') === k.replace(/_/g, ''));
  const keys = ['contact_name', 'contact_phone', 'contact_email', ...(t.contextMappings || []).map((m) => m.fieldName)]; const seen = new Set();
  const rows = data.filter((r) => r.some((v) => String(v ?? '').trim())).map((r, i) => {
    const get = (k) => { const c = col(k); return c >= 0 ? String(r[c] ?? '').trim() : ''; }; const phone = get('contact_phone').replace(/\D/g, '').slice(-10);
    // The upload check fixes what it can (extra commas, stray quotes), warns on a PO listed twice, and stops only rows it cannot call.
    const check = checkUploadRow({ contact_name: get('contact_name'), contact_phone: get('contact_phone'), contact_email: get('contact_email'), ...Object.fromEntries((t.contextMappings || []).map((m) => [m.fieldName, get(m.fieldName)])) }); const context = check.ctx;
    if (check.is_dummy) return { row: i + 2, name: get('contact_name') || `Row ${i + 2}`, phone, raw_phone: get('contact_phone'), email: get('contact_email'), context, bad: null, check };
    const missing = (t.contextMappings || []).filter((m) => m.required && !context[m.fieldName]).map((m) => m.fieldName);
    const bad = phone.length !== 10 ? `contact_phone "${get('contact_phone')}" is not a valid number` : missing.length ? `Missing ${missing.join(', ')}` : check.error ? check.error.note : seen.has(phone) ? 'Same phone number as an earlier row' : null; seen.add(phone);
    const reg = bad ? null : registerCheck(get('contact_phone')).hit; const dn = bad ? null : onDnc(get('contact_phone'));
    const blocked = dn ? `On your do-not-call list: ${dn.reason}` : reg?.action === 'block' ? reg.note : null;
    if (reg && !blocked) check.warnings.push({ kind: 'register', field: 'contact_phone', note: reg.note });
    if (blocked) return { row: i + 2, name: get('contact_name') || `Row ${i + 2}`, phone, raw_phone: get('contact_phone'), email: get('contact_email'), context, bad: blocked, check: { ...check, error: { kind: 'register', field: 'contact_phone', note: blocked } } };
    if (bad && !check.error) check.error = { kind: phone.length !== 10 ? 'phone' : 'other', field: '', note: bad };
    return { row: i + 2, name: get('contact_name') || `Row ${i + 2}`, phone, raw_phone: get('contact_phone'), email: get('contact_email'), context, bad, check };
  });
  return { headers, keys, rows, matched: keys.filter((k) => col(k) >= 0), missing: keys.filter((k) => col(k) < 0) };
}
function sheetFor(t, r, filename, injectDummy = true) {
  const live = r.rows.filter((x) => !x.check?.is_dummy);
  const bad = live.filter((x) => x.bad).map((x) => ({ row: x.row, reason: x.bad }));
  const tests = live.filter((x) => !x.bad && TEST_NUMBERS.has(normalisePhone(x.phone))).length;
  const columns = r.keys.map((k) => ({ key: k, label: k }));
  const cellOf = (x) => Object.fromEntries(r.keys.map((k) => [k, k === 'contact_name' ? x.name : k === 'contact_phone' ? (x.raw_phone || x.phone) : k === 'contact_email' ? (x.email || '') : String(x.context?.[k] ?? '')]));
  const items = r.rows.map((x) => ({ row: x.row, is_dummy: !!x.check?.is_dummy, bad: x.check?.is_dummy ? null : x.bad, test: !x.bad && !x.check?.is_dummy && TEST_NUMBERS.has(normalisePhone(x.phone)), check: x.check, cells: cellOf(x) }));
  if (injectDummy && !items.some((i) => i.is_dummy)) {
    const cells = buildDummyRow(r.keys);
    items.unshift({ row: 0, cells, check: checkUploadRow(cells), is_dummy: true, bad: null, test: false });
  }
  return { file: filename, rows: live.length, will_dial: live.length - bad.length - tests, calls: live.length - bad.length, bad, tests, dummies: r.rows.length - live.length,
    matched: r.matched, missing: r.missing, columns, headers: r.headers,
    fixed: live.filter((x) => x.check?.fixes.length && !x.bad).map((x) => ({ row: x.row, notes: x.check.fixes.map((f) => f.note) })),
    warnings: live.filter((x) => x.check?.warnings.length && !x.bad).map((x) => ({ row: x.row, notes: x.check.warnings.map((f) => f.note) })),
    note: uploadNote(t.name, live.map((x) => x.check), live.length), countries: countriesOf(live.map((x) => x.raw_phone || x.phone)),
    ...presentSheet(items) };
}
on('POST', '/api/v1/reports/calling/new-campaign/check', ({ q, req, raw }) => {
  const t = templates.find((x) => x.id === q.get('agent')); if (!t) return fail(400, 'Pick an agent'); const form = multipart(req, raw); if (!form.file?.content) return fail(400, 'Choose a file');
  let r; try { r = newCampaignRows(t, form); } catch { return fail(400, 'Could not read that spreadsheet'); }
  ok(sheetFor(t, r, form.file.filename));
});
on('POST', '/api/v1/reports/calling/new-campaign/recheck', ({ q, body }) => {
  const t = templates.find((x) => x.id === q.get('agent')); if (!t) return fail(400, 'Pick an agent');
  const agent = newCampaignAgents().find((x) => x.key === t.id); const keys = agent?.inputs || ['contact_name', 'contact_phone'];
  const data = Array.isArray(body?.rows) ? body.rows : [];
  const csv = [keys.join(','), ...data.map((row) => keys.map((k) => { const c = String(row?.cells?.[k] ?? ''); return /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c; }).join(','))].join('\n');
  const form = { file: { filename: 'edited.csv', content: Buffer.from(csv, 'utf8') } };
  let r; try { r = newCampaignRows(t, form); } catch { return fail(400, 'Could not read those rows'); }
  ok(sheetFor(t, r, 'edited.csv', false));
});
// Calling rules per country (Settings): hours by weekday, rest days, holidays, the do-not-call register. Retries obey them.
on('GET', '/api/v1/reports/calling/calling-rules', () => ok({ countries: allCountryRules() }));
on('PUT', '/api/v1/reports/calling/calling-rules/:code', ({ p, body }) => { const r = setCountryRule(p.code, body); r ? ok(r) : fail(404, 'Unknown country'); });
on('POST', '/api/v1/reports/calling/calling-rules/:code/reset', ({ p }) => ok(resetCountryRule(p.code)));
on('POST', '/api/v1/reports/calling/retry-rules/preview', ({ body }) => ok(retryPreview(cleanRule(body?.rule), String(body?.country || 'IN'), null, body?.start_hour)));

on('GET', '/api/v1/reports/calling/new-campaign/tips', ({ q }) => { const t = templates.find((x) => x.id === q.get('agent')); t ? ok(agentTips(t.name, newCampaignAgents().find((x) => x.key === t.id)?.inputs ?? [])) : fail(404, 'Agent not found'); });
// Retry rules per agent: how often and when a row that was not reached is called again.
const cleanRule = (b) => cleanRetryRule(b);
on('GET', '/api/v1/reports/calling/retry-rules', () => ok({ schedules: RETRY_SCHEDULES, agents: templates.map((t) => { const rule = retryRuleOf(t.id); return { agent: t.id, label: t.name, rule, gaps: retryGaps(rule) }; }) }));
on('PUT', '/api/v1/reports/calling/retry-rules/:agent', ({ p, body }) => { if (!templates.some((t) => t.id === p.agent)) return fail(404, 'Agent not found'); const rule = cleanRule(body); retryRules.set(p.agent, rule);
  ok({ agent: p.agent, rule, gaps: retryGaps(rule), example: retryPlan(rule, new Date().toISOString()) }); });
on('POST', '/api/v1/reports/calling/new-campaign/start', async ({ q, req, raw }) => {
  const t = templates.find((x) => x.id === q.get('agent')); if (!t) return fail(400, 'Pick an agent'); const form = multipart(req, raw); if (!form.file?.content) return fail(400, 'Choose a file');
  let r; try { r = newCampaignRows(t, form); } catch { return fail(400, 'Could not read that spreadsheet'); }
  const sheet = { id: hex24(), orgId: ORG, templateId: t.id, templateName: t.name, eventType: t.triggerEventTypes?.[0], sourceSystem: 'CSV', originalFilename: form.file.filename, fileUrl: null, uploadedBy: USER,
    total: r.rows.length, triggered: 0, failed: 0, failedRows: r.rows.filter((x) => x.bad).map((x) => ({ row: x.row, reason: x.bad })), createdAt: nowIso() };
  const good = r.rows.filter((x) => !x.bad && !x.check?.is_dummy).map((x) => ({ primary_id: hex24(), name: x.name, phone: x.phone, email: x.email, context: x.context }));
  good.forEach((row) => addExecution({ id: row.primary_id, template: t, batch: sheet, row, status: 'IN_PROGRESS', submittedAt: nowIso(), completedAt: null, duration: null, extracted: null, conv: { callStatus: 'QUEUED', attempts: 0 } }));
  sheet.failed = sheet.failedRows.length; sheet.triggered = good.length; claimCampaign(sheet.id); sheets.push(sheet);
  const mine = R; if (good.length) await dispatchToEcho(t, sheet, good); R = mine;
  ok({ campaign_id: sheet.id, dialled: good.length });
});
async function dsStart(t, csv, filename) {
  const form = { file: { filename, content: Buffer.from(csv, 'utf8') } }; const r = newCampaignRows(t, form);
  const sheet = { id: hex24(), orgId: ORG, templateId: t.id, templateName: t.name, eventType: t.triggerEventTypes?.[0], sourceSystem: 'DATA_SOURCE', originalFilename: filename.replace(/\.csv$/, ''), fileUrl: null, uploadedBy: USER,
    total: r.rows.length, triggered: 0, failed: 0, failedRows: r.rows.filter((x) => x.bad).map((x) => ({ row: x.row, reason: x.bad })), createdAt: nowIso() };
  const good = r.rows.filter((x) => !x.bad && !x.check?.is_dummy).map((x) => ({ primary_id: hex24(), name: x.name, phone: x.phone, email: x.email, context: x.context }));
  good.forEach((row) => addExecution({ id: row.primary_id, template: t, batch: sheet, row, status: 'IN_PROGRESS', submittedAt: nowIso(), completedAt: null, duration: null, extracted: null, conv: { callStatus: 'QUEUED', attempts: 0 } }));
  sheet.failed = sheet.failedRows.length; sheet.triggered = good.length; claimCampaign(sheet.id); sheets.push(sheet);
  const mine = R; if (good.length) await dispatchToEcho(t, sheet, good); R = mine;
  return { campaign_id: sheet.id, dialled: good.length };
}
// ── Agent data sources: connect a system, pick rows, group lines into calls, schedule runs (demo data) ──
const dsView = (a) => { const inputs = ['contact_name', 'contact_phone', 'contact_email', ...(a.contextMappings || []).map((m) => m.fieldName)]; const setup = getSetup(a.id, inputs) || defaultSetup(inputs);
  return { agent: a.id, label: a.name, inputs, outputs: (a.requiredFields || []).map((f) => f.fieldKey), setup, saved: hasSetup(a.id), runs: runsOf(a.id), next_runs: dsNextRuns(setup.schedule),
    connector_name: (CONNECTORS.find((c) => c.key === setup.connector) || {}).name || '', webhook_url: webhookUrl('https://hooks.clarix.example', a.id), filter_ops: FILTER_OPS, columns: SOURCE_COLUMNS() }; };
on('GET', '/api/v1/reports/calling/data-sources/catalog', (ctx) => ok({ connectors: CONNECTORS }));
on('GET', '/api/v1/reports/calling/data-sources/:agent', (ctx) => { const a = templates.find((t) => t.id === ctx.p.agent); a ? ok(dsView(a)) : fail(404, 'Agent not found'); });
on('PUT', '/api/v1/reports/calling/data-sources/:agent', (ctx) => { const a = templates.find((t) => t.id === ctx.p.agent); if (!a) return fail(404, 'Agent not found'); saveSetup(a.id, ctx.body || {}); ok(dsView(a)); });
on('POST', '/api/v1/reports/calling/data-sources/test', (ctx) => ok(testConnection(ctx.body || {})));
on('POST', '/api/v1/reports/calling/data-sources/:agent/preview', (ctx) => { const a = templates.find((t) => t.id === ctx.p.agent); if (!a) return fail(404, 'Agent not found');
  const cfg = ctx.body || {}; const b = buildCalls(a.id, cfg, ['contact_name', 'contact_phone', 'contact_email', ...(a.contextMappings || []).map((m) => m.fieldName)]); ok({ ...b, total_calls: b.calls.length, calls: b.calls.slice(0, 6), write_back: writeBackPreview(cfg, b.calls), next_runs: dsNextRuns(cfg.schedule) }); });
on('POST', '/api/v1/reports/calling/data-sources/:agent/run', async (ctx) => { const a = templates.find((t) => t.id === ctx.p.agent); if (!a) return fail(404, 'Agent not found');
  const cfg = getSetup(a.id, ['contact_name', 'contact_phone', 'contact_email', ...(a.contextMappings || []).map((m) => m.fieldName)]); if (!cfg?.connector) return fail(400, 'Connect a data source first');
  const b = buildCalls(a.id, cfg, ['contact_name', 'contact_phone', 'contact_email', ...(a.contextMappings || []).map((m) => m.fieldName)]); if (!b.calls.length) { addRun(a.id, { by: ctx.body?.by || 'Run now', read: b.read, after_filters: b.after_filters, calls: 0, status: 'Nothing to call' }); return ok({ campaign_id: null, dialled: 0, ...b, calls: [] }); }
  const name = `${(CONNECTORS.find((c) => c.key === cfg.connector) || {}).name || 'Source'} run ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}.csv`;
  const r = await dsStart(a, callsCsv(['contact_name', 'contact_phone', 'contact_email', ...(a.contextMappings || []).map((m) => m.fieldName)], b.calls), name); markCalled(a.id, b.calls);
  addRun(a.id, { by: ctx.body?.by || 'Run now', read: b.read, after_filters: b.after_filters, calls: b.calls.length, campaign_id: r.campaign_id, status: 'Started' });
  ok({ ...r, read: b.read, after_filters: b.after_filters, calls: b.calls.length }); });
const ME = () => USER;
// ── Wave 1: do-not-call list, alerts and pausing, call handling, re-running answers, call diagnostics ──
on('GET', '/api/v1/reports/calling/dnc', (ctx) => { dncScan(callingRows()); ok(dncView(ctx.q.get("q") || "")); });
on('POST', '/api/v1/reports/calling/dnc', (ctx) => { const r = dncAdd(ctx.body || {}, ME()); r.error ? fail(400, r.error) : ok(dncView("")); });
on('POST', '/api/v1/reports/calling/dnc/remove', (ctx) => { const r = dncRemove(ctx.body?.phone, ctx.body?.reason, ME()); r.error ? fail(400, r.error) : ok(dncView("")); });
on('PUT', '/api/v1/reports/calling/dnc/settings', (ctx) => { dncSettings.auto = ctx.body?.auto !== false; ok(dncView("")); });
on('GET', '/api/v1/reports/calling/alerts', (ctx) => { campaignSummaries(callingRows()); ok(alertsView()); });
on('PUT', '/api/v1/reports/calling/alerts', (ctx) => { saveAlerts(ctx.body?.rules); campaignSummaries(callingRows()); ok(alertsView()); });
on('POST', '/api/v1/reports/calling/campaigns/:id/resume', (ctx) => { const mine = callingRows().filter((r) => r.campaign_id === ctx.p.id && r.call_status && !['Bad data', 'Internal test call', 'In progress'].includes(r.call_status));
  resumeCampaign(ctx.p.id, mine.length) ? ok({ resumed: true }) : fail(400, 'This campaign is not paused'); });
on('GET', '/api/v1/reports/calling/call-handling/:agent', (ctx) => { const a = templates.find((t) => t.id === ctx.p.agent); a ? ok({ agent: ctx.p.agent, label: a.name, inputs: ['contact_name', 'contact_phone', 'contact_email', ...(a.contextMappings || []).map((m) => m.fieldName)], handling: handlingOf(ctx.p.agent) }) : fail(404, 'Agent not found'); });
on('PUT', '/api/v1/reports/calling/call-handling/:agent', (ctx) => { const a = templates.find((t) => t.id === ctx.p.agent); if (!a) return fail(404, 'Agent not found'); saveHandling(ctx.p.agent, ctx.body || {}); ok({ agent: ctx.p.agent, label: a.name, inputs: ['contact_name', 'contact_phone', 'contact_email', ...(a.contextMappings || []).map((m) => m.fieldName)], handling: handlingOf(ctx.p.agent) }); });
on('POST', '/api/v1/reports/calling/calls/rerun', (ctx) => { const q = ctx.q; const list = filterRows(rowsInBox(scopeRows(callingRows(), callingScope(ctx.q)), q.get('box') || 'uploaded'), logFilters(q)); ok(rerunAnswers(list, ME())); });
on('GET', '/api/v1/reports/calling/call/:id/diagnostics', (ctx) => { const d = callDetail(ctx.p.id); const row = callingRows().find((r) => r.id === ctx.p.id); d ? ok(diagnosticsOf({ ...d, agent_key: row?.agent_key })) : fail(404, 'Call not found'); });

// ── Wave 2: quality checks, persona tests, versions and the A/B split, contact memory ──
on('GET', '/api/v1/reports/calling/quality/:agent', (ctx) => { const a = templates.find((t) => t.id === ctx.p.agent); a ? ok(qaScorecard(callingRows(), ctx.p.agent, a.name)) : fail(404, 'Agent not found'); });
on('PUT', '/api/v1/reports/calling/quality/:agent', (ctx) => { const a = templates.find((t) => t.id === ctx.p.agent); if (!a) return fail(404, 'Agent not found'); saveQa(ctx.p.agent, ctx.body || {}); ok(qaScorecard(callingRows(), ctx.p.agent, a.name)); });
on('GET', '/api/v1/reports/calling/tests/:agent', (ctx) => ok(testsView(ctx.p.agent)));
on('POST', '/api/v1/reports/calling/tests/:agent/run', (ctx) => ok(runTests(ctx.p.agent, ctx.body?.ids || [], ctx.body?.version)));
on('POST', '/api/v1/reports/calling/tests/:agent/from-calls', (ctx) => { const a = templates.find((t) => t.id === ctx.p.agent); if (!a) return fail(404, 'Agent not found'); const r = scenariosFromCalls(callingRows(), ctx.p.agent, a.name); ok({ ...testsView(ctx.p.agent), added: r.added }); });
on('GET', '/api/v1/reports/calling/versions/:agent', (ctx) => { const a = templates.find((t) => t.id === ctx.p.agent); a ? ok(versionsView(callingRows(), ctx.p.agent, a.name)) : fail(404, 'Agent not found'); });
on('PUT', '/api/v1/reports/calling/versions/:agent/draft', (ctx) => { const a = templates.find((t) => t.id === ctx.p.agent); if (!a) return fail(404, 'Agent not found'); saveDraft(ctx.p.agent, ctx.body || {}, ME()); ok(versionsView(callingRows(), ctx.p.agent, a.name)); });
on('POST', '/api/v1/reports/calling/versions/:agent/publish', (ctx) => { const a = templates.find((t) => t.id === ctx.p.agent); if (!a) return fail(404, 'Agent not found'); const r = publishDraft(ctx.p.agent, ME()); r.error ? fail(400, r.error) : ok(versionsView(callingRows(), ctx.p.agent, a.name)); });
on('PUT', '/api/v1/reports/calling/versions/:agent/split', (ctx) => { const a = templates.find((t) => t.id === ctx.p.agent); if (!a) return fail(404, 'Agent not found'); const r = setSplit(ctx.p.agent, ctx.body || {}); r.error ? fail(400, r.error) : ok(versionsView(callingRows(), ctx.p.agent, a.name)); });
on('GET', '/api/v1/reports/calling/call/:id/memory', (ctx) => { const row = callingRows().find((r) => r.id === ctx.p.id); row ? ok(memoryOf(callingRows(), row, handlingOf(row.agent_key || row.agent).memory?.on !== false)) : fail(404, 'Call not found'); });

// ── Wave 3: live calls, the telephony hub and slots, the copilot ──
on('GET', '/api/v1/reports/calling/live', (ctx) => ok({ calls: liveCalls(callingRows()), buyers: BUYER_LIST }));
on('POST', '/api/v1/reports/calling/live/:id/:action', (ctx) => { const r = liveAction(callingRows(), ctx.p.id, ctx.p.action, ctx.body || {}, ME()); r.error ? fail(400, r.error) : ok({ ...r, calls: liveCalls(callingRows()) }); });
on('GET', '/api/v1/reports/calling/telephony', (ctx) => ok(telephonyView(callingRows())));
on('POST', '/api/v1/reports/calling/telephony/test', (ctx) => ok(testCarrier(ctx.body || {})));
on('POST', '/api/v1/reports/calling/telephony/connect', (ctx) => { const r = connectCarrier(ctx.body || {}); r.error ? fail(400, r.error) : ok(telephonyView(callingRows())); });
on('POST', '/api/v1/reports/calling/telephony/:key/disconnect', (ctx) => { const r = disconnectCarrier(ctx.p.key); r.error ? fail(400, r.error) : ok(telephonyView(callingRows())); });
on('PUT', '/api/v1/reports/calling/telephony/slots', (ctx) => { saveSlots(ctx.body || {}); ok(telephonyView(callingRows())); });
on('POST', '/api/v1/reports/calling/copilot', (ctx) => { const q = ctx.q; const list = filterRows(rowsInBox(scopeRows(callingRows(), callingScope(ctx.q)), q.get('box') || 'uploaded'), logFilters(q)); ok({ ...copilotAnswer(list, ctx.body?.q), suggestions: COPILOT_SUGGESTIONS }); });

// ── Enterprise shell: bulk Action needed, Supplier 360, security center, audit log ──
on('POST', '/api/v1/reports/calling/follow-ups/actions/bulk', (ctx) => { const b = ctx.body || {}; const ids = Array.isArray(b.ids) ? b.ids.slice(0, 500) : []; if (!ids.length) return fail(400, 'Pick at least one row');
  for (const id of ids) { const r = actionAct(id, b, ME()); if (r.error) return fail(400, r.error); } ok({ ok: ids.length }); });
on('GET', '/api/v1/reports/calling/supplier/:phone', (ctx) => { const all = scopeRows(callingRows(), callingScope(ctx.q)); if (isDeleted(ctx.p.phone)) return fail(404, 'This contact was deleted');
  const acts = ['you', 'agent'].flatMap((lane) => actionNeeded(all, { lane, q: String(ctx.p.phone).replace(/\D/g, '').slice(-10), me: ME() }).rows);
  const v = supplierView(all, ctx.p.phone, acts); v ? ok(v) : fail(404, 'No calls to this number'); });
on('GET', '/api/v1/reports/calling/security', (ctx) => ok({ ...securityView(), people: PEOPLE }));
// Team and access: org, sub-orgs, teams, people and roles. ?as= previews the screen as another person.
const accessAs = (q) => q.get('as') || accessActorFor(USER);
const accessReply = (ctx, r) => (r.error ? fail(400, r.error) : ok({ ...accessView(accessAs(ctx.q)), note: r.note || '' }));
on('GET', '/api/v1/reports/calling/access/me', (ctx) => ok(accessMe(ctx.req.headers['x-preview-as'], accessActorFor(USER))));
on('GET', '/api/v1/reports/calling/access', (ctx) => ok(accessView(accessAs(ctx.q))));
on('POST', '/api/v1/reports/calling/access/:kind', (ctx) => accessReply(ctx, accessCreate(ctx.p.kind, ctx.body || {}, accessAs(ctx.q))));
on('PUT', '/api/v1/reports/calling/access/:kind/:id', (ctx) => accessReply(ctx, accessUpdate(ctx.p.kind, ctx.p.id, ctx.body || {}, accessAs(ctx.q))));
on('DELETE', '/api/v1/reports/calling/access/:kind/:id', (ctx) => accessReply(ctx, accessRemove(ctx.p.kind, ctx.p.id, accessAs(ctx.q))));
on('PUT', '/api/v1/reports/calling/security', (ctx) => ok(saveSecurity(ctx.body || {})));
on('POST', '/api/v1/reports/calling/security/sso/test', (ctx) => ok(testSso(ctx.body || {})));
on('POST', '/api/v1/reports/calling/security/scim/token', (ctx) => ok(newScimToken()));
on('POST', '/api/v1/reports/calling/security/delete-contact', (ctx) => { const r = deleteContact(callingRows(), ctx.body || {}); r.error ? fail(400, r.error) : ok(r); });
const auditOpts = (q) => ({ q: q.get('q') || '', who: q.get('who') || 'all', area: q.get('area') || 'all', days: q.get('days') || 0 });
on('GET', '/api/v1/reports/calling/audit', (ctx) => ok(auditView(auditOpts(ctx.q))));
on('GET', '/api/v1/reports/calling/audit/export.xlsx', (ctx) => { const d = auditView(auditOpts(ctx.q)); const when = (v) => new Date(v).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' });
  file(writeXlsx([AUDIT_COLUMNS.map(([, l]) => l), ...d.rows.map((e) => AUDIT_COLUMNS.map(([k]) => (k === "at" ? when(e.at) : e[k] ?? "")))], "Audit log"), XLSX, 'audit-log.xlsx'); });

// ── Action needed: what a person must do, beside what the agent will call again (lane, type, owner, search) ──
const anOpts = (q) => ({ lane: q.get('lane') || 'you', group: q.get('group') || 'all', kind: q.get('kind') || 'all', owner: q.get('owner') || 'all', q: q.get('q') || '', me: ME() });
on('GET', '/api/v1/reports/calling/follow-ups/actions', (ctx) => ok(actionNeeded(scopeRows(callingRows(), callingScope(ctx.q)), anOpts(ctx.q))));
on('POST', '/api/v1/reports/calling/follow-ups/actions/:id', (ctx) => { const r = actionAct(ctx.p.id, ctx.body || {}, ME()); r.error ? fail(400, r.error) : ok(r); });
on('GET', '/api/v1/reports/calling/follow-ups/actions/export.xlsx', (ctx) => {
  const o = anOpts(ctx.q); const d = actionNeeded(scopeRows(callingRows(), callingScope(ctx.q)), o); const g = Object.fromEntries(d.groups.map((x) => [x.key, x.label]));
  const lanes = { you: 'Action needed', agent: 'With the agent', done: 'Closed' }; const when = (v) => (v ? new Date(v).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }) : '');
  const cell = (r, k) => (k === 'lane' ? lanes[r.lane] : k === 'group' ? g[r.group] : k === 'closed' ? ({ done: 'Done', dismissed: 'Rejected' }[r.closed] || '') : k === 'last_call' || k === 'next_at' || k === 'since' ? when(r[k]) : r[k] ?? '');
  file(writeXlsx([ACTION_COLUMNS.map(([, l]) => l), ...d.rows.map((r) => ACTION_COLUMNS.map(([k]) => cell(r, k)))], "Action needed"), XLSX, `action-needed-${o.lane}.xlsx`);
});
on('GET', '/api/v1/reports/calling/call/:id', ({ p }) => { const d = callDetail(p.id); d ? ok(d) : fail(404, 'Call not found'); });
// Next steps on the call page: the retry plan and WhatsApp / email messages (the demo records them, it does not send).
on('GET', '/api/v1/reports/calling/call/:id/steps', ({ p }) => { const row = callingRows().find((r) => r.id === p.id); row ? ok(callSteps(row)) : fail(404, 'Call not found'); });
on('POST', '/api/v1/reports/calling/call/:id/messages', ({ p, body }) => { const row = callingRows().find((r) => r.id === p.id); if (!row) return fail(404, 'Call not found');
  if (!String(body?.text || '').trim()) return fail(400, 'Write a message first'); sendMessage(row, body, USER); ok(callSteps(row)); });
on('PATCH', '/api/v1/reports/calling/call/:id/outcome', ({ p, body }) => {
  const row = callingRows().find((r) => r.id === p.id); if (!row) return fail(404, 'Call not found');
  const err = checkOutcomeChange(row, body); if (err) return fail(400, err);
  const e = executions.find((x) => x.id === row.call_id); if (!e) return fail(400, 'This row has no call');
  e.outcome_override = { status_reason: body.status_reason, note: String(body.note || '').slice(0, 500), by: USER, at: nowIso() };
  ok(callDetail(p.id));
});
// ── Custom stats per agent, column values, follow-up checklist, tasks (same in Echo and Clarix) ──
on('GET', '/api/v1/reports/calling/agent-stats', ({ q }) => ok(statsByAgent(clarixAgentsMeta())));
on('PUT', '/api/v1/reports/calling/agent-stats/:agent', ({ p, body }) => {
  const a = (clarixAgentsMeta()).find((x) => x.key === p.agent); if (!a) return fail(404, 'Agent not found');
  setAgentMetrics(a, body?.stats);
  ok(statsByAgent([a])[0]);
});
on('GET', '/api/v1/reports/calling/calls/values', ({ q }) => {
  const column = q.get('column') || ''; const f = logFilters(q); delete f.cols[column];
  ok({ values: columnValues(filterRows(rowsInBox(scopeRows(callingRows(), callingScope(q)), q.get('box') || 'uploaded'), f), column, q.get('vq') || '') });
});
on('GET', '/api/v1/reports/calling/follow-ups/checklist', ({ q }) => ok(followChecklist(scopeRows(callingRows(), callingScope(q)), q.get('show') || 'open', q.get('kind') || 'all')));
on('GET', '/api/v1/reports/calling/follow-ups/export.xlsx', ({ q }) => {
  const list = followChecklist(scopeRows(callingRows(), callingScope(q)), q.get('show') || 'open', q.get('kind') || 'all').rows;
  const cell = (r, k) => (k === 'call_date' ? (r.call_date ? new Date(r.call_date).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }) : '') : r[k] ?? '');
  file(writeXlsx([[...FOLLOW_COLUMNS.map(([, l]) => l), 'Done'], ...list.map((r) => [...FOLLOW_COLUMNS.map(([k]) => cell(r, k)), r.follow.state === 'done' ? 'Yes' : 'No'])], 'Follow ups'), XLSX, 'follow-ups.xlsx');
});
on('GET', '/api/v1/reports/calling/tasks', ({ q }) => ok(tasksSummary(scopeRows(callingRows(), callingScope(q)))));
// Workspace test numbers: calls to these count only on the "Internal test calls" line.
on('GET', '/api/v1/reports/calling/test-numbers', () => ok({ numbers: [...TEST_NUMBERS] }));
on('PUT', '/api/v1/reports/calling/test-numbers', ({ body }) => {
  const list = [...new Set((Array.isArray(body?.numbers) ? body.numbers : []).map(normalisePhone).filter((p) => p.length === 10))];
  TEST_NUMBERS.clear(); list.forEach((p) => TEST_NUMBERS.add(p)); ok({ numbers: list });
});
on('GET', '/api/v1/reports/calling/calls', ({ q }) => {
  const rows = filterRows(rowsInBox(scopeRows(callingRows(), callingScope(q)), q.get('box') || 'uploaded'), logFilters(q));
  const skip = Number(q.get('skip') || 0); const limit = Number(q.get('limit') || 25);
  ok({ rows: rows.slice(skip, skip + limit), total: rows.length });
});
on('GET', '/api/v1/reports/calling/export.xlsx', ({ q }) => {
  const sc = callingScope(q); const rows = filterRows(rowsInBox(scopeRows(callingRows(), sc), q.get('box') || 'uploaded'), logFilters(q));
  // A campaign's export adds its sheet's columns and the agent's answers.
  const cols = sc.campaign ? campaignColumns(rows) : { inputs: [], answers: [] }; const extra = [...cols.inputs, ...cols.answers].map((c) => [c.key, c.label]);
  file(writeXlsx(exportTable(rows, 'Asia/Kolkata', extra), 'Calls'), XLSX, `calling-report-${nowIso().slice(0, 10)}.xlsx`);
});
on('GET', '/api/v1/dashboard/voice', ({ q }) => ok(voiceMetrics(q)));
on('GET', '/api/v1/dashboard/voice/calls', ({ q }) => {
  const rows = voiceScope(q); const skip = Number(q.get('skip') || 0); const limit = Number(q.get('limit') || 50);
  ok({ rows: rows.slice(skip, skip + limit), total: rows.length, truncated: rows.length > 5000, row_cap: 5000 });
});
on('GET', '/api/v1/dashboard/voice/calls/values', ({ q }) => {
  const col = q.get('column') || ''; const counts = new Map();
  for (const r of voiceScope(q, col)) { const v = r[col] == null ? '' : String(r[col]); counts.set(v, (counts.get(v) || 0) + 1); }
  const values = [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  ok({ values: values.slice(0, 500), truncated: values.length > 500 });
});
on('GET', '/api/v1/dashboard/voice/calls.xlsx', ({ q }) => {
  file(writeXlsx([CALL_LOG_COLUMNS.map(([, l]) => l), ...voiceScope(q).map((r) => CALL_LOG_COLUMNS.map(([k]) => r[k] ?? ''))], 'Call log'), XLSX, 'call-log.xlsx');
});

// Campaign page: Echo's view of the batch (contacts, answers and call status), as Clarix relays it.
on('GET', '/api/v1/workflows/sheets/:id/campaign', ({ p }) => {
  const s = sheets.find((x) => x.id === p.id); if (!s) return fail(404, `Sheet not found: ${p.id}`);
  const t = templates.find((x) => x.id === s.templateId); const mine = executions.filter((e) => e.batchId === s.id);
  const groupOf = (e) => (NOT_DIALLED.has(e.outcome) ? 'not_dialed' : e.status === 'IN_PROGRESS' ? 'in_progress' : GROUP_OF[bucketOf(e)] || (e.status === 'COMPLETED' ? 'reached' : 'not_dialed'));
  const tel = (e) => (NOT_DIALLED.has(e.outcome) || e.outcome === 'will_retry' ? e.outcome : e.status === 'IN_PROGRESS' ? (e.attemptLog?.length ? 'calling' : 'waiting') : bucketOf(e) === 'completed' ? 'complete' : bucketOf(e) === 'unresolved' ? '' : bucketOf(e));
  ok({
    campaign: { campaign_id: s.id, provider: t?.callProviderKey === 'voxera' ? 'Voxera' : 'Echo', schema: { label: t?.name || s.templateName, output_variables: (t?.requiredFields || []).map((f) => ({ key: f.fieldKey, label: f.fieldLabel })) } },
    contacts: { contacts: mine.map((e) => ({ primary_id: e.id, telephony_status: tel(e), progress_group: groupOf(e), attempts: e.attemptLog?.length || (dialled(e) ? 1 : 0),
      contact_no_more_tries: e.callStatus === 'RETRY_EXHAUSTED', next_retry_at: e.nextAttemptAt || null, duration_seconds: e.callDurationSeconds ?? null,
      dialled_at: (e.attemptLog || []).slice(-1)[0]?.startedAt || (dialled(e) ? e.batchSubmittedAt : null), validation_error: e.outcome === 'bad_data' ? STATUS_REASON.bad_data : '' })) },
    responses: { responses: mine.map((e) => ({ primary_id: e.id, status: e.extractedFields && Object.keys(e.extractedFields).length ? 'captured' : e.status === 'IN_PROGRESS' ? 'pending' : 'no_answers',
      outputs: e.extractedFields || {}, attempts: e.attemptLog?.length || 0, progress_group: groupOf(e) })) },
    metrics: { call_status: callStatus(mine.filter(dialled).map(voiceRow), badDataIn(null, s.id)) },
  });
});
on('GET', '/api/v1/workflows/sheets/:id/results.xlsx', ({ p }) => {
  const s = sheets.find((x) => x.id === p.id); if (!s) return fail(404, `Sheet not found: ${p.id}`);
  const t = templates.find((x) => x.id === s.templateId); const fields = (t?.requiredFields || []).map((f) => f.fieldKey);
  const rows = [['Execution Id', 'Name', 'Phone', 'Call Status', 'Status Reason', 'Dials', 'Talk (s)', ...(t?.requiredFields || []).map((f) => f.fieldLabel)],
    ...executions.filter((e) => e.batchId === s.id).map((e) => { const r = voiceRow(e); return [e.id, e.name, r.phone, NOT_DIALLED.has(e.outcome) ? BUCKET_LABEL.bad_data : r.status, r.status_reason, e.attemptLog?.length || 0, e.callDurationSeconds ?? '', ...fields.map((k) => e.extractedFields?.[k] ?? '')]; })];
  file(writeXlsx(rows, 'Results'), XLSX, `${(s.originalFilename || 'campaign').replace(/\.\w+$/, '')}_results.xlsx`);
});

// Execution Reports: saved views of one agent's calls, with e-mail schedules.
const reports = [];
const reportCsv = (r) => {
  const t = templates.find((x) => x.id === r.templateId); const fields = (t?.requiredFields || []).map((f) => f.fieldKey);
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [['Execution Id', 'Name', 'Phone', 'Email', 'Status', 'Channel', 'Created At', 'Completed At', 'Call Duration', ...(t?.requiredFields || []).map((f) => f.fieldLabel)],
    ...executions.filter((e) => e.templateId === r.templateId).map((e) => [e.id, e.name, e.resolvedContact.phone, e.resolvedContact.email || '', e.status, e.activeChannelType, e.createdAt, e.completedAt || '', e.callDurationSeconds ?? '', ...fields.map((k) => e.extractedFields?.[k] ?? '')])];
  return Buffer.from('﻿' + rows.map((x) => x.map(esc).join(',')).join('\r\n'), 'utf8');
};
const nextRuns = (sch, count) => {
  if (!sch.enabled) return [];
  if (sch.scheduleType === 'ONCE') return sch.runAt && Date.parse(sch.runAt) > Date.now() ? [{ scheduleId: sch.id, at: sch.runAt }] : [];
  // Five field cron, or six with seconds first (Spring); only the minute and hour are read.
  const parts = String(sch.cron || '0 9 * * *').trim().split(/\s+/); const [min, hour] = parts.length >= 6 ? parts.slice(1, 3) : parts.slice(0, 2);
  const out = []; const d = new Date(); d.setSeconds(0, 0); d.setHours(Number(hour) || 9, Number(min) || 0);
  while (out.length < count) { if (d.getTime() > Date.now()) out.push({ scheduleId: sch.id, at: d.toISOString() }); d.setDate(d.getDate() + 1); }
  return out;
};
const newSchedule = (b) => ({ id: hex24(), scheduleType: b.scheduleType || 'RECURRING', cron: b.cron || null, runAt: b.runAt || null, summary: b.summary || '', recipientsTo: b.recipientsTo || [], recipientsCc: b.recipientsCc || [],
  subject: b.subject || '', body: b.body || '', singleThread: !!b.singleThread, dataWindow: b.dataWindow || { type: 'LAST_DAYS', value: 1 }, enabled: true, createdBy: USER, createdAt: nowIso(), updatedAt: nowIso(), lastRunAt: null });
for (const [t, title, description, schedule] of [
  [templates[0], 'Daily PO acceptance status', 'Every Post PO call from the last day, with the supplier answers.', { scheduleType: 'RECURRING', cron: '0 9 * * *', summary: 'Every day at 09:00', recipientsTo: [USER], subject: 'PO acceptance calls: daily report', dataWindow: { type: 'PREVIOUS_DAY', value: 1 } }],
  [templates[1], 'RFQ reminders this week', '', null],
]) {
  if (!t) continue;
  reports.push({ id: hex24(), templateId: t.id, title, description, reportColumns: undefined, filters: [], preferredDateFormat: 'dd MMM yyyy, hh:mm a', createdBy: USER,
    createdAt: plus(firstBatchAt, -86400000), updatedAt: plus(firstBatchAt, -86400000), emailSchedules: schedule ? [newSchedule(schedule)] : [] });
}
const reportOr404 = (id) => reports.find((r) => r.id === id) || (fail(404, `Report not found: ${id}`), null);
on('GET', '/api/v1/workflows/reports', ({ q }) => { const l = reports.filter((r) => !q.get('templateId') || r.templateId === q.get('templateId')).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); ok(page(l, q), l.length); });
on('POST', '/api/v1/workflows/reports', ({ body }) => {
  if (!body.templateId || !String(body.title || '').trim()) return fail(400, 'Template and title are required');
  const r = { id: hex24(), templateId: body.templateId, title: String(body.title).trim(), description: body.description || '', reportColumns: body.reportColumns, filters: body.filters || [], preferredDateFormat: body.preferredDateFormat, createdBy: USER, createdAt: nowIso(), updatedAt: nowIso(), emailSchedules: [] };
  reports.push(r); ok(r);
});
on('GET', '/api/v1/workflows/reports/:id/download', ({ p }) => { const r = reportOr404(p.id); if (r) file(reportCsv(r), 'text/csv; charset=utf-8', `${r.title}.csv`); });
on('GET', '/api/v1/workflows/reports/:id/schedules/upcoming', ({ p, q }) => { const r = reportOr404(p.id); if (!r) return; const n = Number(q.get('count') || 10); ok(r.emailSchedules.flatMap((s) => nextRuns(s, n)).sort((a, b) => a.at.localeCompare(b.at)).slice(0, n)); });
on('POST', '/api/v1/workflows/reports/:id/schedules', ({ p, body }) => { const r = reportOr404(p.id); if (!r) return; const s = newSchedule(body); r.emailSchedules.push(s); ok(s); });
on('PUT', '/api/v1/workflows/reports/:id/schedules/:sid', ({ p, body }) => { const r = reportOr404(p.id); if (!r) return; const s = r.emailSchedules.find((x) => x.id === p.sid); if (!s) return fail(404, 'Schedule not found'); Object.assign(s, body, { id: s.id, updatedAt: nowIso() }); ok(s); });
on('DELETE', '/api/v1/workflows/reports/:id/schedules/:sid', ({ p }) => { const r = reportOr404(p.id); if (!r) return; r.emailSchedules = r.emailSchedules.filter((x) => x.id !== p.sid); ok(null); });
on('PATCH', '/api/v1/workflows/reports/:id/schedules/:sid/enabled', ({ p, q }) => { const r = reportOr404(p.id); if (!r) return; const s = r.emailSchedules.find((x) => x.id === p.sid); if (!s) return fail(404, 'Schedule not found'); s.enabled = q.get('enabled') === 'true'; ok(s); });
// Local mock: "Send now" records the run; no e-mail leaves the machine.
on('POST', '/api/v1/workflows/reports/:id/schedules/:sid/run-now', ({ p }) => { const r = reportOr404(p.id); if (!r) return; const s = r.emailSchedules.find((x) => x.id === p.sid); if (!s) return fail(404, 'Schedule not found'); s.lastRunAt = nowIso(); ok(null); });
on('GET', '/api/v1/workflows/reports/:id', ({ p }) => { const r = reportOr404(p.id); if (r) ok(r); });
on('PUT', '/api/v1/workflows/reports/:id', ({ p, body }) => { const r = reportOr404(p.id); if (!r) return; Object.assign(r, { templateId: body.templateId ?? r.templateId, title: String(body.title ?? r.title).trim(), description: body.description ?? '', reportColumns: body.reportColumns, filters: body.filters ?? r.filters, preferredDateFormat: body.preferredDateFormat ?? r.preferredDateFormat, updatedAt: nowIso() }); ok(r); });
on('DELETE', '/api/v1/workflows/reports/:id', ({ p }) => { const i = reports.findIndex((x) => x.id === p.id); if (i >= 0) reports.splice(i, 1); ok(null); });
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
  if (toEcho.length) claimCampaign(sheet.id); sheets.push(sheet);
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
// Data functions (Build > Data > Enrichments). Two examples; Test answers from sample values, nothing is queried.
const dataFunctions = [
  { id: hex24(), name: 'supplier_contact_by_id', description: 'Supplier id to the contact phone and e-mail on the vendor master.', enabled: true, type: 'SQL',
    parameters: [{ name: 'supplier_id', dataType: 'STRING', required: true }], outputs: [{ name: 'contact_phone', dataType: 'STRING', sourceColumn: 'phone' }, { name: 'contact_email', dataType: 'STRING', sourceColumn: 'email' }],
    sqlConfig: { query: 'SELECT phone, email FROM vendor_master WHERE supplier_id = :supplier_id' }, createdAt: plus(firstBatchAt, -9 * 86400000), updatedAt: plus(firstBatchAt, -9 * 86400000) },
  { id: hex24(), name: 'po_status_lookup', description: 'Latest PO status from the ERP.', enabled: false, type: 'REST',
    parameters: [{ name: 'po_number', dataType: 'STRING', required: true }], outputs: [{ name: 'po_status', dataType: 'STRING', jsonPath: '$.status' }, { name: 'po_value', dataType: 'NUMBER', jsonPath: '$.value' }],
    restConfig: { method: 'GET', url: 'https://erp.internal/api/po/{po_number}', headers: {}, queryParams: {}, bodyTemplate: undefined }, createdAt: plus(firstBatchAt, -6 * 86400000), updatedAt: plus(firstBatchAt, -2 * 86400000) },
];
const dfOr404 = (id) => dataFunctions.find((x) => x.id === id) || (fail(404, `Data function not found: ${id}`), null);
const dfFrom = (b) => ({ name: b.name, description: b.description || '', enabled: b.enabled !== false, type: b.type || 'SQL', parameters: b.parameters || [], outputs: b.outputs || [], sqlConfig: b.sqlConfig, restConfig: b.restConfig });
on('GET', '/api/v1/admin/data-functions', ({ q }) => { const term = (q.get('search') || '').toLowerCase(); const l = dataFunctions.filter((x) => !term || [x.name, x.description].some((v) => String(v || '').toLowerCase().includes(term))); ok(page(l, q), l.length); });
on('POST', '/api/v1/admin/data-functions', ({ body }) => {
  if (!body.name) return fail(400, 'Name is required');
  if (dataFunctions.some((x) => x.name === body.name)) return fail(409, `A data function named ${body.name} already exists`);
  const x = { id: hex24(), ...dfFrom(body), createdAt: nowIso(), updatedAt: nowIso() }; dataFunctions.push(x); ok(x);
});
on('GET', '/api/v1/admin/data-functions/:id', ({ p }) => { const x = dfOr404(p.id); if (x) ok(x); });
on('PUT', '/api/v1/admin/data-functions/:id', ({ p, body }) => { const x = dfOr404(p.id); if (!x) return; Object.assign(x, dfFrom(body), { updatedAt: nowIso() }); ok(x); });
on('PATCH', '/api/v1/admin/data-functions/:id/enabled', ({ p, q }) => { const x = dfOr404(p.id); if (!x) return; x.enabled = q.get('enabled') === 'true'; x.updatedAt = nowIso(); ok(x); });
on('DELETE', '/api/v1/admin/data-functions/:id', ({ p }) => { const i = dataFunctions.findIndex((x) => x.id === p.id); if (i >= 0) dataFunctions.splice(i, 1); ok(null); });
on('POST', '/api/v1/admin/data-functions/:id/test', ({ p, body }) => {
  const x = dfOr404(p.id); if (!x) return;
  const missing = x.parameters.filter((m) => m.required && !String(body.inputs?.[m.name] ?? '').trim()).map((m) => m.name);
  if (missing.length) return ok({ success: false, message: `Missing input: ${missing.join(', ')}`, durationMs: 3 });
  const sample = (o) => (o.dataType === 'NUMBER' ? 125000 : o.dataType === 'BOOLEAN' ? true : /phone/.test(o.name) ? '9876543210' : /email/.test(o.name) ? 'supplier@example.com' : `sample ${o.name}`);
  ok({ success: true, message: 'Local mock: sample values, nothing was queried.', durationMs: 41, outputs: Object.fromEntries(x.outputs.map((o) => [o.name, sample(o)])) });
});

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
  // Preview as: the person picked in Team and access. Requests they could not make are refused here.
  setPreview(req.headers['x-preview-as'], accessActorFor(USER));
  const blocked = route.open ? '' : previewBlock(req.method, url.pathname);
  if (blocked) return fail(403, blocked);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks);
    let body = {};
    if ((req.headers['content-type'] || '').includes('application/json') && raw.length) {
      try { body = JSON.parse(raw.toString('utf8')); } catch { R = { req, res }; return fail(400, 'Bad JSON'); }
    }
    try { auditRequest(req.method, url.pathname, body, USER); } catch { /* never block a request on the log */ }
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
