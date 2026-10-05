import { WorkflowExecution } from '../models/workflow-template.model';

/**
 * How one call reads on screen. Echo is the source of truth (PRD-ECHO-11): when a
 * run carries Echo's callStatus, that is what shows, with its result or reason.
 * Older runs only have Clarix's workflow status, which is shown in plain words.
 */
export interface CallStatusView {
  label: string;
  detail: string;
  tone: 'ok' | 'warn' | 'bad' | 'live' | 'muted';
}

const ECHO: Record<string, [string, CallStatusView['tone']]> = {
  SCHEDULED: ['Scheduled', 'muted'],
  QUEUED: ['Queued', 'live'],
  CALLING: ['Calling', 'live'],
  IN_PROGRESS: ['On the call', 'live'],
  RETRY_SCHEDULED: ['Retry scheduled', 'live'],
  COMPLETED: ['Completed', 'ok'],
  NO_ANSWER: ['No answer', 'bad'],
  BUSY: ['Busy', 'bad'],
  REJECTED: ['Rejected', 'bad'],
  BLOCKED: ['Blocked', 'bad'],
  INVALID_NUMBER: ['Invalid number', 'bad'],
  UNREACHABLE: ['Unreachable', 'bad'],
  FAILED: ['Failed', 'bad'],
  CANCELLED: ['Cancelled', 'muted'],
  RETRY_EXHAUSTED: ['Retry exhausted', 'bad'],
};
const RESULT: Record<string, string> = {
  CONVERSATION: 'Conversation',
  NO_RESPONSE: 'No response',
  DISCONNECTED_EARLY: 'Hung up early',
  VOICEMAIL: 'Voicemail',
  TECHNICAL_DROP: 'Technical drop',
};
const REASON: Record<string, string> = {
  NO_ANSWER: 'rang, no answer',
  NO_RESPONSE: 'rang, no answer',
  RANG_OUT: 'rang out, not picked up',
  NOT_ANSWERED: 'not answered',
  NORMAL_UNSPECIFIED: 'call cleared by network',
  ISD_DISABLED: 'international dialling disabled',
  PROVIDER_EXCEPTION: 'telephony error',
  INVALID_NUMBER: 'number does not exist',
  BOT_NOT_CONNECTED: 'answered but the agent never connected',
  UNKNOWN_PROVIDER_STATUS: 'unknown telephony result',
  NOT_DIALLED_EXPIRED: 'expired before dialling',
  DESTINATION_BUSY: 'line busy',
  SUBSCRIBER_ABSENT: 'switched off or out of coverage',
  NO_ROUTE: 'no route to number',
  CONGESTION: 'network congestion',
  INVALID_FORMAT: 'number format is wrong',
  DATA_VALIDATION_FAILED: 'data check failed',
  DUPLICATE_ROW: 'repeated number in the sheet',
  NOT_DIALLED_STOPPED: 'campaign stopped before dialling',
  NO_PROVIDER_RESULT: 'no result from the telephony provider',
};
const CLARIX: Record<string, [string, CallStatusView['tone']]> = {
  UPCOMING: ['Scheduled', 'muted'],
  ACTIVE: ['Queued', 'live'],
  IN_PROGRESS: ['In progress', 'live'],
  WAITING: ['Waiting for call back', 'live'],
  COMPLETED: ['Completed', 'ok'],
  FAILED: ['Failed', 'bad'],
  CANCELLED: ['Cancelled', 'muted'],
  STOPPED: ['Stopped', 'muted'],
  PAUSED: ['Paused', 'muted'],
};

export function callStatusView(e: Pick<WorkflowExecution, 'status' | 'callStatus' | 'callResult' | 'callReason' | 'attemptNumber' | 'maxAttempts' | 'failureReason'> & { lastAttemptReason?: string | null }): CallStatusView {
  if (e.callStatus) {
    const [label, tone0] = ECHO[e.callStatus] ?? [pretty(e.callStatus), 'muted'];
    const result = e.callResult ? RESULT[e.callResult] ?? pretty(e.callResult) : '';
    let reason = e.callReason ? REASON[e.callReason] ?? pretty(e.callReason).toLowerCase() : '';
    if (e.callStatus === 'RETRY_EXHAUSTED' || e.callStatus === 'RETRY_SCHEDULED') reason = reason ? `last dial: ${reason}` : '';
    const attempts = '';
    const tone = e.callStatus === 'COMPLETED' && e.callResult && e.callResult !== 'CONVERSATION' ? 'warn' : tone0;
    return { label, detail: [result || reason, attempts].filter(Boolean).join(' · '), tone };
  }
  const [label, tone] = CLARIX[e.status] ?? [pretty(e.status), 'muted'];
  return { label, detail: e.status === 'FAILED' ? e.failureReason ?? '' : '', tone };
}

export function reasonText(r: string | null | undefined): string { return r ? REASON[r] ?? pretty(r).toLowerCase() : ''; }
export function resultText(r: string | null | undefined): string { return r ? RESULT[r] ?? pretty(r) : ''; }
export function statusText(s: string | null | undefined): string { return s ? (ECHO[s]?.[0] ?? pretty(s)) : ''; }
export function hangupText(h: string | null | undefined): string {
  const v = String(h || '').replace(/\s+/g, '').toLowerCase();
  return v === 'userhangup' ? 'Caller' : v === 'agenthangup' ? 'Agent' : v === 'systemhangup' ? 'System' : h || '—';
}
/** Seconds as m:ss. */
export function mss(s: number | null | undefined): string {
  if (s === null || s === undefined) return '—';
  const n = Math.round(s);
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

function pretty(v: string): string {
  const s = v.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Seconds in words for lists: 173 becomes "2m 53s", 40 becomes "40s". */
export function durationText(s: number | null | undefined): string {
  if (!s) return '—';
  const n = Math.round(s), m = Math.floor(n / 60), r = n % 60;
  return m ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`;
}
