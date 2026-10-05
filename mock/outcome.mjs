// Provider neutral call outcomes (PRD-ECHO-19 section 3).
//
// raw provider fields -> adapter -> dial facts (same for every provider) -> outcome (one plain word).
// Adding a telephony provider means one adapter; the outcome rules never change.
// The same file is copied into the Clarix mock so both products read outcomes alike.

const low = (v) => String(v ?? '').trim().toLowerCase();
const sec = (t) => { if (typeof t === 'number') return t; const [h, m, s] = String(t || '0:0:0').split(':').map(Number); return (h || 0) * 3600 + (m || 0) * 60 + (s || 0); };

// ── Line results when nobody picked up (section 3.2) ─────────────────────────
// Q.850 cause codes: every SIP trunk and most providers expose one.
const Q850 = { 1: 'wrong_number', 28: 'wrong_number', 3: 'unreachable', 20: 'unreachable', 27: 'unreachable', 17: 'busy', 21: 'busy',
  18: 'no_answer', 19: 'no_answer', 16: 'no_answer', 31: 'no_answer', 55: 'blocked', 57: 'blocked' };
export function fromQ850(code) { return Q850[Number(code)] || 'network_error'; }

function ozonetelLine(p) {
  const c = low(p.CustomerStatus), d = low(p.DialStatus);
  if (c === 'busy') return 'busy';
  if (c === 'invalidnumber' || c === 'invalidnumberformat' || d === 'invalid_number') return 'wrong_number';
  if (c === 'subcriberabsent' || c === 'subscriberabsent' || c === 'noroutedestination') return 'unreachable';
  if (c === 'dnd' || c === 'blocked' || c === 'numberblocked') return 'blocked';
  if (c === 'rejected' || c === 'declined' || c === 'callrejected') return 'rejected';
  if (c === 'isddisabled' || c === 'congestion' || c === 'exception' || d === 'exception') return 'network_error';
  if (['ring', 'dialing', 'noresponse', 'not_answered', 'normalunspecified'].includes(c) || (!c && d === 'not_answered')) return 'no_answer';
  // Unknown value: a failure, logged by the status layer (UNKNOWN_PROVIDER_VALUE), never No answer.
  return 'network_error';
}
const hangup = (h) => { const v = low(h).replace(/\s+/g, ''); return v === 'userhangup' ? 'caller' : v === 'agenthangup' ? 'agent' : v ? 'network' : null; };

// ── Adapters: provider fields -> dial facts ──────────────────────────────────
export const ADAPTERS = {
  ozonetel: (p) => ({
    picked_up: low(p.Status) === 'answered',
    line_result: low(p.Status) === 'answered' ? null : ozonetelLine(p),
    ring_seconds: sec(p.CustomerRingTime || p.TimeToAnswer), talk_seconds: sec(p.TalkTime || p.CallDuration), ended_by: hangup(p.HangupBy),
  }),
  exotel: (p) => {
    const s = low(p.Status || p.DialCallStatus);
    return { picked_up: s === 'completed', line_result: s === 'completed' ? null : s === 'busy' ? 'busy' : s === 'no-answer' ? 'no_answer' : p.SipCode ? fromSip(p.SipCode) : 'network_error',
      ring_seconds: null, talk_seconds: Number(p.DialCallDuration || p.ConversationDuration || 0), ended_by: null };
  },
  twilio: (p) => {
    const s = low(p.CallStatus);
    return { picked_up: s === 'completed' || s === 'in-progress', line_result: s === 'completed' ? null : s === 'busy' ? 'busy' : s === 'no-answer' ? 'no_answer' : p.SipResponseCode ? fromSip(p.SipResponseCode) : 'network_error',
      ring_seconds: null, talk_seconds: Number(p.CallDuration || 0), ended_by: null };
  },
  plivo: (p) => ({ picked_up: low(p.CallStatus) === 'completed' && Number(p.BillDuration) > 0, line_result: Number(p.BillDuration) > 0 ? null : p.HangupCauseCode ? fromQ850(p.HangupCauseCode) : 'network_error',
    ring_seconds: null, talk_seconds: Number(p.Duration || 0), ended_by: low(p.HangupSource) === 'callee' ? 'caller' : null }),
  sip: (p) => ({ picked_up: Number(p.cause) === 16 && Number(p.billsec) > 0, line_result: Number(p.billsec) > 0 ? null : fromQ850(p.cause), ring_seconds: null, talk_seconds: Number(p.billsec || 0), ended_by: null }),
};
function fromSip(code) { const c = Number(code); return c === 486 || c === 600 ? 'busy' : c === 404 || c === 484 ? 'wrong_number' : c === 480 ? 'unreachable' : c === 603 ? 'rejected' : c === 403 ? 'blocked' : c === 408 ? 'no_answer' : 'network_error'; }

/** Dial facts: the provider's view plus what Echo's own audio stream heard. */
export function dialFacts(provider, raw, stream) {
  const f = (ADAPTERS[provider] || ADAPTERS.sip)(raw || {});
  const joined = !!stream?.connected;
  return {
    ...f,
    // Echo's audio wins: if we heard the caller, the line was picked up, whatever the provider said.
    picked_up: f.picked_up || joined,
    line_result: f.picked_up || joined ? null : f.line_result,
    agent_joined: joined,
    caller_spoke_seconds: stream?.caller_speech_seconds ?? 0,
    caller_turns: stream?.caller_turns ?? 0,
    agent_turns: stream?.agent_turns ?? 0,
    voicemail_heard: !!stream?.voicemail_detected,
    // Finished: the agent sent its answers or ended the call itself after talking.
    agent_finished: !!stream?.agent_finished || (joined && f.ended_by === 'agent' && (stream?.caller_turns ?? 0) > 0),
    provider_disagrees: !f.picked_up && joined,
  };
}

// ── Outcome rules (section 3.3, first match wins) ────────────────────────────
/** Answered calls shorter than this many seconds of talk time are No reply (Settings, Telephony). */
let NO_REPLY_UNDER = 5;
export function setNoReplyUnder(n) { NO_REPLY_UNDER = Math.max(1, Number(n) || 5); }
export function outcomeOf(f) {
  if (!f.picked_up) return f.line_result || 'network_error';
  if (!f.agent_joined) return 'call_dropped';
  if (f.voicemail_heard) return 'voicemail';
  // No reply: Echo's own audio says the caller never spoke. TalkTime under the cut-off (5 s by default) only
  // confirms it when the agent also did not finish; duration alone never sets a status.
  if (f.caller_spoke_seconds < 1 || !f.caller_turns) return 'no_reply';
  if ((f.talk_seconds ?? 0) < NO_REPLY_UNDER && !f.agent_finished) return 'no_reply';
  if (f.agent_finished) return 'completed';
  if (f.ended_by === 'caller') return 'caller_hung_up';
  return 'call_dropped';
}

// ── Words and groups (section 3.4) ───────────────────────────────────────────
export const OUTCOMES = {
  completed: { label: 'Completed', group: 'reached' },
  caller_hung_up: { label: 'Caller hung up', group: 'reached' },
  no_reply: { label: 'No reply', group: 'reached' },
  voicemail: { label: 'Voicemail', group: 'reached' },
  no_answer: { label: 'No answer', group: 'not_reached' },
  busy: { label: 'Busy', group: 'not_reached' },
  unreachable: { label: 'Unreachable', group: 'not_reached' },
  wrong_number: { label: 'Wrong number', group: 'not_reached' },
  blocked: { label: 'Blocked', group: 'not_reached' },
  rejected: { label: 'Rejected', group: 'not_reached' },
  network_error: { label: 'Network error', group: 'failed' },
  call_dropped: { label: 'Call dropped', group: 'failed' },
  bad_data: { label: 'Bad data', group: 'not_dialled' },
  repeated_number: { label: 'Repeated number', group: 'not_dialled' },
  stopped: { label: 'Stopped', group: 'not_dialled' },
  expired: { label: 'Expired', group: 'not_dialled' },
  waiting: { label: 'Waiting', group: 'in_progress' },
  calling: { label: 'Calling', group: 'in_progress' },
  on_call: { label: 'On call', group: 'in_progress' },
  will_retry: { label: 'Will retry', group: 'in_progress' },
};

// ── Retries (section 3.6) ────────────────────────────────────────────────────
export const DEFAULT_RETRY = { tries: 3, gap_minutes: 60, on: ['no_answer', 'busy', 'unreachable', 'network_error', 'call_dropped', 'no_reply', 'voicemail', 'caller_hung_up'] };
export function retryAgain(outcome, dialsSoFar, cfg = DEFAULT_RETRY) {
  return dialsSoFar < (cfg.tries || 1) && (cfg.on || []).includes(outcome);
}

/** Contact level outcome from its dials and state. */
export function contactOutcome(row) {
  const s = row.status;
  if (row.reason === 'duplicate_row') return 'repeated_number';
  if (s === 'input_validation_failed' || row.reason === 'data_validation_failed') return 'bad_data';
  if (s === 'cancelled') return row.reason === 'not_dialled_expired' ? 'expired' : 'stopped';
  if (s === 'pending' || s === 'queued' || s === 'dialled' || s === 'scheduled') return 'waiting';
  if (s === 'calling') return 'calling';
  if (s === 'in_progress') return 'on_call';
  if (s === 'retry_scheduled') return 'will_retry';
  const last = (row.attempts_detail || []).slice(-1)[0];
  if (last?.outcome) return last.outcome;
  // Rows from before dial facts existed: read the older status words.
  const RES = { conversation: 'completed', no_response: 'no_reply', disconnected_early: 'caller_hung_up', voicemail: 'voicemail', technical_drop: 'call_dropped' };
  const OLD = { captured: 'completed', no_outputs: 'completed', disconnected_early: 'caller_hung_up', no_answer: 'no_answer', busy: 'busy', rejected: 'busy',
    blocked: 'blocked', invalid_number: 'wrong_number', unreachable: 'unreachable', failed: 'network_error', retry_exhausted: 'no_answer' };
  if (s === 'completed') return RES[row.call_result] || 'completed';
  return OLD[s] || 'network_error';
}
