/**
 * Echo's outcome words (PRD-ECHO-19). Echo works them out from any telephony provider's
 * result plus ring and talk time; Clarix only shows them, with the same words and groups.
 */
export type OutcomeGroup = 'reached' | 'not_reached' | 'failed' | 'in_progress' | 'not_dialled';

/**
 * CALL STATUS, exactly as Echo defines it (PRD-ECHO-19): one per call, worked out from the
 * telephony service status for the dial plus what the agent heard. Clarix only shows it.
 * [label, group, meaning, exact rule, tried again by default]
 */
const WORDS: Record<string, [string, OutcomeGroup, string, string, boolean]> = {
  waiting: ['Waiting', 'in_progress', 'In the queue, not dialled yet', 'Not sent to the telephony service yet', false],
  calling: ['Calling', 'in_progress', 'The number is ringing', 'Dial placed; no result from the telephony service yet', false],
  on_call: ['On call', 'in_progress', 'Talking to the agent now', 'Telephony status Answered and the agent audio is live', false],
  will_retry: ['Will retry', 'in_progress', 'Not reached yet; the next dial is booked', 'Last dial ended in a status set to try again, and tries are left', false],
  completed: ['Completed', 'reached', 'Picked up, talked, and the agent finished', 'Telephony status Answered · talk time 5 s or more · caller spoke · agent finished (answers sent, or hung up by Agent)', false],
  caller_hung_up: ['Caller hung up', 'reached', 'Talked, then hung up before the agent finished', 'Telephony status Answered · talk time 5 s or more · caller spoke · hung up by User before the agent finished', true],
  no_reply: ['No reply', 'reached', 'Picked up, but under 5 s or the caller never spoke', 'Telephony status Answered · talk time under 5 s, or no caller speech', true],
  voicemail: ['Voicemail', 'reached', 'A voicemail or answering machine picked up', 'Telephony status Answered · answering machine greeting detected', true],
  no_answer: ['No answer', 'not_reached', 'Rang, nobody picked up', 'Telephony status NotAnswered · customer status ring, Dialing, NoResponse, not_answered or NormalUnspecified', true],
  busy: ['Busy', 'not_reached', 'Line busy or the call was declined', 'Telephony status NotAnswered · customer status Busy', true],
  unreachable: ['Unreachable', 'not_reached', 'Switched off, out of coverage or no route', 'Telephony status NotAnswered · customer status SubcriberAbsent or NoRouteDestination', true],
  wrong_number: ['Wrong number', 'not_reached', 'The number does not exist', 'Customer status InvalidNumber or InvalidNumberFormat, or dial status invalid_number', false],
  blocked: ['Blocked', 'not_reached', 'DND or barred by the network', 'Customer status DND or an explicit block from the provider (never guessed from patterns)', false],
  rejected: ['Rejected', 'not_reached', 'The person or network declined the call', 'An explicit decline from the provider (Ozonetel sends none today)', false],
  network_error: ['Network error', 'failed', 'The network or provider failed; safe to retry', 'Customer status Congestion, ISDDisabled or exception, or dial status exception. Any value not listed here is logged as unknown and not tried again', true],
  call_dropped: ['Call dropped', 'failed', 'Picked up, but the line or agent dropped; safe to retry', 'Telephony status Answered · agent audio never joined, or hung up by System mid call', true],
  bad_data: ['Bad data', 'not_dialled', 'Failed the data check; not dialled', 'Not sent to the telephony service', false],
  repeated_number: ['Repeated number', 'not_dialled', 'Same number earlier in the sheet', 'Not sent to the telephony service', false],
  stopped: ['Stopped', 'not_dialled', 'Stopped before it was dialled', 'Not sent to the telephony service', false],
  expired: ['Expired', 'not_dialled', 'Calling window closed before dialling', 'Not sent to the telephony service', false],
};

export const GROUPS: { key: OutcomeGroup; label: string }[] = [
  { key: 'reached', label: 'Reached' },
  { key: 'not_reached', label: 'Not reached' },
  { key: 'failed', label: 'Failed' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'not_dialled', label: 'Not dialled' },
];

export interface OutcomeWord { key: string; label: string; group: OutcomeGroup; tone: 'ok' | 'warn' | 'bad' | 'live' | 'muted'; help: string; rule: string; retry: boolean }

export function outcomeWord(key: string | null | undefined): OutcomeWord | null {
  const w = key ? WORDS[key] : undefined;
  if (!w) return null;
  const tone = key === 'completed' ? 'ok' : w[1] === 'reached' ? 'warn' : w[1] === 'not_reached' ? 'bad' : w[1] === 'failed' ? 'warn' : w[1] === 'in_progress' ? 'live' : 'muted';
  return { key: key!, label: w[0], group: w[1], tone, help: w[2], rule: w[3], retry: w[4] };
}


/** Seconds as "m:ss", or "2 h 15 min" / "1 d 3 h" once long. */
export function runTime(s: number | null | undefined): string {
  if (s === null || s === undefined) return '—';
  if (s < 3600) return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  const h = Math.floor(s / 3600);
  return h >= 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${h} h ${Math.round((s % 3600) / 60)} min`;
}

/** Every call status in rule order, for the reference and filters. */
export const CALL_STATUSES: OutcomeWord[] = Object.keys(WORDS).map((k) => outcomeWord(k)!);

/** What the telephony service sent for the last dial, in one short line. */
export function telephonyLine(p: { Status?: string; CustomerStatus?: string; HangupBy?: string } | null | undefined): string {
  if (!p?.Status) return '';
  const same = (x?: string) => String(x || '').toLowerCase() === String(p.Status).toLowerCase();
  const parts = [p.Status, p.CustomerStatus && !same(p.CustomerStatus) ? p.CustomerStatus : '', p.Status === 'Answered' ? p.HangupBy || '' : ''].filter(Boolean);
  return `Telephony: ${parts.join(' · ')}`;
}

/** Hover text for a call status: what it means and exactly how it is worked out. */
export function statusHover(key: string | null | undefined): string {
  const w = outcomeWord(key);
  return w ? `${w.label}: ${w.help}.\nHow: ${w.rule}.${w.retry ? '\nTried again by default.' : ''}` : '';
}

/** Campaign statuses, the same words as Echo; each follows only from its call statuses. */
export const CAMPAIGN_STATUSES: { key: string; label: string; cls: string; rule: string }[] = [
  { key: 'idle', label: 'Ready', cls: 'idle', rule: 'Uploaded; no call placed yet' },
  { key: 'live', label: 'Running', cls: 'live', rule: 'At least one call is Waiting, Calling, On call or Will retry' },
  { key: 'done', label: 'Completed', cls: 'done', rule: 'Every call has a final call status' },
  { key: 'partial', label: 'Partially completed', cls: 'partial', rule: 'Stopped while some calls were never dialled (call status Stopped)' },
  { key: 'stopped', label: 'Cancelled', cls: 'stopped', rule: 'Stopped before any call was dialled' },
  { key: 'paused', label: 'Paused', cls: 'paused', rule: 'Held in Echo; calls not yet placed wait until it is resumed' },
  { key: 'failed', label: 'Failed', cls: 'failed', rule: 'The campaign itself failed in Echo (for example its calling flow was turned off); not individual call failures' },
];
export function campaignRule(cls: string): string { return CAMPAIGN_STATUSES.find((c) => c.cls === cls)?.rule || ''; }
