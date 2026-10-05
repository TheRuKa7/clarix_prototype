// Ozonetel call results for the local mocks, and Echo's mapping of them (PRD-ECHO-11).
//
// Every dial attempt gets what Ozonetel would really send on the campaign callback URL
// (Status, DialStatus, CustomerStatus, HangupBy, times and durations) plus what Echo's own
// media stream saw. mapAttempt() turns that into Echo's call status, reason or call result,
// exactly as PRD-ECHO-11 sections 6 to 8 say. The same file is copied into the Clarix mock
// so both products show the same numbers for the same row.
//
// Generation is deterministic per row (seeded by the row id), so a restart shows the same data.
// outcome.mjs turns the same fields into provider neutral dial facts and one outcome word (PRD-ECHO-19).
import { dialFacts, outcomeOf } from './outcome.mjs';

// ── Seeded random ────────────────────────────────────────────────────────────
export function rng(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const between = (r, a, b) => a + Math.floor(r() * (b - a + 1));

// ── What can happen on one dial ──────────────────────────────────────────────
// kind -> Ozonetel callback fields (values as Ozonetel documents them, spelling included)
const PROVIDER = {
  answered:           { Status: 'Answered',    DialStatus: 'answered',       CustomerStatus: 'answered' },
  ring_out:           { Status: 'NotAnswered', DialStatus: 'not_answered',   CustomerStatus: 'ring' },
  no_response:        { Status: 'NotAnswered', DialStatus: 'not_answered',   CustomerStatus: 'NoResponse' },
  normal_unspecified: { Status: 'NotAnswered', DialStatus: 'NormalUnspecified', CustomerStatus: 'NormalUnspecified' },
  busy:               { Status: 'NotAnswered', DialStatus: 'not_answered',   CustomerStatus: 'Busy' },
  subscriber_absent:  { Status: 'NotAnswered', DialStatus: 'not_answered',   CustomerStatus: 'SubcriberAbsent' },
  no_route:           { Status: 'NotAnswered', DialStatus: 'not_answered',   CustomerStatus: 'NoRouteDestination' },
  invalid_format:     { Status: 'NotAnswered', DialStatus: 'invalid_number', CustomerStatus: 'InvalidNumberFormat' },
  invalid_number:     { Status: 'NotAnswered', DialStatus: 'invalid_number', CustomerStatus: 'InvalidNumber' },
  congestion:         { Status: 'NotAnswered', DialStatus: 'exception',      CustomerStatus: 'Congestion' },
  exception:          { Status: 'NotAnswered', DialStatus: 'exception',      CustomerStatus: 'exception' },
  isd_disabled:       { Status: 'NotAnswered', DialStatus: 'not_answered',   CustomerStatus: 'ISDDisabled' },
};

// A simulated attempt outcome: provider kind plus what Echo's stream saw when answered.
// result is only for answered calls: conversation | no_response | disconnected_early | voicemail | technical_drop
export function simulate({ kind, result = null, seed, startedAt, did = '08000000101', ucidBase = 4071590 }) {
  const r = rng(`${seed}:${kind}:${result}`);
  const answered = kind === 'answered';
  const ring = answered ? between(r, 4, 18) : kind === 'ring_out' || kind === 'no_response' ? between(r, 28, 45) : kind === 'busy' ? between(r, 1, 4) : between(r, 0, 3);
  let stream = null, talk = 0, hangupBy = 'SystemHangup';
  if (answered) {
    if (result === 'technical_drop') { talk = between(r, 3, 9); hangupBy = 'SystemHangup'; }
    else {
      const shape = {
        conversation: { agent: between(r, 5, 11), caller: between(r, 4, 10), speech: between(r, 25, 140), by: r() < 0.7 ? 'AgentHangup' : 'UserHangup' },
        no_response: { agent: between(r, 1, 3), caller: 0, speech: 0, by: r() < 0.5 ? 'UserHangup' : 'AgentHangup' },
        disconnected_early: { agent: between(r, 1, 2), caller: 1, speech: between(r, 1, 4), by: 'UserHangup' },
        voicemail: { agent: 1, caller: 1, speech: between(r, 6, 15), by: 'SystemHangup' },
      }[result || 'conversation'];
      // No reply: picked up and dropped within a few seconds (under the 5 s cut-off).
      talk = result === 'no_response' ? between(r, 1, 4) : shape.agent * between(r, 5, 9) + shape.speech;
      stream = { connected: true, agent_turns: shape.agent, caller_turns: shape.caller, caller_speech_seconds: shape.speech, voicemail_detected: result === 'voicemail', agent_finished: result === 'conversation' };
      hangupBy = shape.by;
    }
  }
  const start = new Date(startedAt);
  const answerAt = new Date(start.getTime() + ring * 1000);
  const end = new Date(answerAt.getTime() + talk * 1000);
  const ucid = `${ucidBase}${between(r, 10000000, 99999999)}`;
  const provider = {
    monitorUCID: ucid, UUI: seed, Did: did, CampaignName: '', Type: 'IVR', CallerID: did,
    ...PROVIDER[kind],
    HangupBy: hangupBy,
    StartTime: local(start), AnswerTime: answered ? local(answerAt) : '', EndTime: local(end),
    TimeToAnswer: answered ? hms(ring) : '00:00:00', Duration: hms(ring + talk), CallDuration: hms(talk),
    // Only from Fetch CDR Details (arrives later, 2 requests a minute)
    TalkTime: hms(talk), CustomerRingTime: hms(ring),
  };
  return { provider, stream, started_at: start.toISOString(), ended_at: end.toISOString(), ring_seconds: ring, talk_seconds: talk };
}

// ── Echo's mapping (PRD-ECHO-11 section 7, first match wins) ─────────────────
const eq = (a, ...b) => b.some((x) => String(a || '').trim().toLowerCase() === x.toLowerCase());
export function mapAttempt(a) {
  const p = a.provider || {}, s = a.stream;
  const anomalies = [];
  let out;
  if (s?.connected) {
    if (eq(p.Status, 'NotAnswered')) anomalies.push('PROVIDER_SAYS_NOT_ANSWERED');
    out = { status: 'completed', result: callResult(s) };
  } else if (eq(p.Status, 'Answered')) { out = { status: 'completed', result: 'technical_drop', reason: 'bot_not_connected' }; anomalies.push('BOT_NOT_CONNECTED'); }
  else if (eq(p.CustomerStatus, 'Busy')) out = { status: 'busy', reason: 'destination_busy' };
  else if (eq(p.CustomerStatus, 'InvalidNumberFormat')) out = { status: 'invalid_number', reason: 'invalid_format' };
  else if (eq(p.CustomerStatus, 'InvalidNumber') || eq(p.DialStatus, 'invalid_number')) out = { status: 'invalid_number', reason: 'invalid_number' };
  else if (eq(p.CustomerStatus, 'SubcriberAbsent', 'SubscriberAbsent')) out = { status: 'unreachable', reason: 'subscriber_absent' };
  else if (eq(p.CustomerStatus, 'NoRouteDestination')) out = { status: 'unreachable', reason: 'no_route' };
  else if (eq(p.CustomerStatus, 'Congestion')) out = { status: 'failed', reason: 'congestion' };
  else if (eq(p.CustomerStatus, 'exception') || eq(p.DialStatus, 'exception')) out = { status: 'failed', reason: 'provider_exception' };
  else if (eq(p.CustomerStatus, 'ISDDisabled')) out = { status: 'failed', reason: 'isd_disabled' };
  // Rules 14 and 15: only explicit signals; never inferred from patterns.
  else if (eq(p.CustomerStatus, 'DND', 'Blocked', 'NumberBlocked')) out = { status: 'blocked', reason: eq(p.CustomerStatus, 'DND') ? 'dnd' : 'provider_block' };
  else if (eq(p.CustomerStatus, 'Rejected', 'Declined', 'CallRejected')) out = { status: 'rejected', reason: 'declined' };
  else if (eq(p.CustomerStatus, 'NoResponse')) out = { status: 'no_answer', reason: 'no_response' };
  else if (eq(p.CustomerStatus, 'ring', 'Dialing') && eq(p.Status, 'NotAnswered')) out = { status: 'no_answer', reason: 'rang_out' };
  else if (eq(p.CustomerStatus, 'NormalUnspecified') && eq(p.Status, 'NotAnswered')) out = { status: 'no_answer', reason: 'normal_unspecified' };
  // DialStatus not_answered only counts when CustomerStatus is empty or says the same: an unknown
  // CustomerStatus must not be hidden behind the less specific DialStatus (never map unknown to No Answer).
  else if (eq(p.CustomerStatus, 'not_answered') || (eq(p.DialStatus, 'not_answered') && !String(p.CustomerStatus || '').trim())) out = { status: 'no_answer', reason: 'not_answered' };
  else { out = { status: 'failed', reason: 'unknown_provider_status' }; anomalies.push(`UNKNOWN_PROVIDER_VALUE Status=${p.Status ?? ''} DialStatus=${p.DialStatus ?? ''} CustomerStatus=${p.CustomerStatus ?? ''}`); }
  // Section 8: duration never creates a status; flag conflicts only.
  if (!s?.connected && eq(p.Status, 'NotAnswered') && secs(p.TalkTime) > 0) anomalies.push('PROVIDER_DATA_CONFLICT');
  return { result: null, reason: null, ...out, anomalies };
}
// Section 6.1, from Echo's own stream
function callResult(s) {
  if (s.voicemail_detected) return 'voicemail';
  if (!s.caller_turns || !s.caller_speech_seconds) return 'no_response';
  if (s.agent_turns <= 2) return 'disconnected_early';
  return 'conversation';
}

// ── Retries (section 10) ─────────────────────────────────────────────────────
export const RETRY = { max_attempts: 3, retry_on: ['no_answer', 'busy', 'unreachable', 'failed'], never_reasons: ['isd_disabled', 'data_validation_failed', 'unknown_provider_status'], retry_on_result: ['no_response', 'disconnected_early', 'voicemail', 'technical_drop'] };
export function shouldRetry(mapped, attemptNo, cfg = RETRY) {
  if (attemptNo >= cfg.max_attempts) return false;
  if (mapped.status === 'completed') return cfg.retry_on_result.includes(mapped.result);
  return cfg.retry_on.includes(mapped.status) && !cfg.never_reasons.includes(mapped.reason);
}
// Final row state from its attempts
export function settle(attempts, cfg = RETRY) {
  const last = attempts[attempts.length - 1];
  if (!last) return { status: 'queued' };
  const m = last.mapped;
  const retryable = shouldRetry(m, attempts.length, { ...cfg, max_attempts: Infinity });
  if (attempts.length >= cfg.max_attempts && retryable && !(m.status === 'completed')) {
    return { status: 'retry_exhausted', reason: m.reason, last_attempt_status: m.status, last_attempt_reason: m.reason };
  }
  return { status: m.status, call_result: m.result || null, reason: m.reason || null };
}

// ── Plan attempts for a seeded row, from its intended final state ────────────
// Reason -> provider kind for the attempt that settles the row
const KIND_OF = {
  no_answer: 'ring_out', rang_out: 'ring_out', no_response: 'no_response', normal_unspecified: 'normal_unspecified', not_answered: 'ring_out',
  destination_busy: 'busy', busy: 'busy', subscriber_absent: 'subscriber_absent', no_route: 'no_route',
  invalid_format: 'invalid_format', invalid_number: 'invalid_number', congestion: 'congestion', provider_exception: 'exception', isd_disabled: 'isd_disabled',
};
export function planAttempts({ seed, final, dispatchedAt, did }) {
  if (!final || ['cancelled', 'input_validation_failed'].includes(final.status) || ['data_validation_failed', 'duplicate_row'].includes(final.reason)) return [];
  const n = Math.max(1, final.attempts || 1);
  const r = rng(seed);
  const out = [];
  let t = Date.parse(dispatchedAt || new Date().toISOString());
  for (let i = 1; i <= n; i++) {
    const lastOne = i === n;
    let kind, result = null;
    if (!lastOne || final.status === 'retry_scheduled') kind = ['ring_out', 'no_response', 'busy', 'normal_unspecified'][between(r, 0, 3)];
    else if (final.status === 'completed') { kind = 'answered'; result = final.result || 'conversation'; }
    else if (final.status === 'retry_exhausted') kind = KIND_OF[final.reason] || 'ring_out';
    else kind = KIND_OF[final.reason] || KIND_OF[final.status] || 'ring_out';
    // retry_scheduled: the final entry is the planned next attempt, not an attempt
    if (final.status === 'retry_scheduled' && lastOne) kind = KIND_OF[final.reason] || 'ring_out';
    const sim = simulate({ kind, result, seed: `${seed}#${i}`, startedAt: new Date(t).toISOString(), did });
    out.push(record(i, sim));
    t += 60 * 60000 + between(r, 0, 20) * 60000; // retry interval 60 min in the plan
  }
  return out;
}
export function record(n, sim) {
  const a = { attempt: n, started_at: sim.started_at, ended_at: sim.ended_at, ring_seconds: sim.ring_seconds, talk_seconds: sim.talk_seconds,
    provider_name: 'ozonetel', provider: sim.provider, stream: sim.stream, mapped: mapAttempt(sim) };
  return reOutcome(a);
}
/** (Re)compute the provider neutral facts and outcome of one dial, after any change to its stream. */
export function reOutcome(a) {
  a.facts = dialFacts(a.provider_name || 'ozonetel', a.provider, a.stream);
  a.outcome = outcomeOf(a.facts);
  return a;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function local(d) { // Ozonetel sends account local time (IST) without a zone
  const x = new Date(d.getTime() + 330 * 60000);
  return x.toISOString().slice(0, 19).replace('T', ' ');
}
function hms(s) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return [h, m, x].map((v) => String(v).padStart(2, '0')).join(':'); }
export function secs(t) { const [h, m, s] = String(t || '0:0:0').split(':').map(Number); return (h || 0) * 3600 + (m || 0) * 60 + (s || 0); }

// Row summary fields shown in both products
export function rowTiming(attempts) {
  const answered = attempts.filter((a) => a.stream?.connected || /answered/i.test(a.provider?.Status) && !/not/i.test(a.provider?.Status));
  const last = attempts[attempts.length - 1];
  return {
    attempts: attempts.length,
    talk_seconds: attempts.reduce((n, a) => n + (a.stream?.connected ? a.talk_seconds : 0), 0),
    ring_seconds: last ? last.ring_seconds : null,
    last_attempt_at: last ? last.started_at : null,
    hangup_by: last?.provider?.HangupBy || null,
    answered_attempts: answered.length,
  };
}
