import { ExecutionSheet } from '../models/execution-sheet.model';

/** Rolled-up campaign progress for one sheet, derived from its per-status execution counts. */
export interface CampaignProgress {
  total: number;
  completed: number;
  inProgress: number;
  failed: number;
  stopped: number;
  pctCompleted: number;
  pctInProgress: number;
  pctStopped: number;
  pctFailed: number;
  /** Echo's campaign status as sent (READY, RUNNING, PAUSED, COMPLETED, PARTIALLY_COMPLETED, CANCELLED, FAILED). */
  echoStatus?: string | null;
}

/**
 * Shared status-bucket rollup for a {@link ExecutionSheet}'s `statusCounts` — used by both the
 * Execution Trigger Sheets table and the Campaigns table so "in progress" means the same thing in
 * both places.
 */
/** One plain status for a campaign, from its progress. Never "Completed" while calls are still open. */
const ECHO_STATES: Record<string, { label: string; cls: 'live' | 'done' | 'partial' | 'stopped' | 'idle' | 'paused' | 'failed' }> = {
  READY: { label: 'Ready', cls: 'idle' }, RUNNING: { label: 'Running', cls: 'live' }, PAUSED: { label: 'Paused', cls: 'paused' },
  COMPLETED: { label: 'Completed', cls: 'done' }, PARTIALLY_COMPLETED: { label: 'Partially completed', cls: 'partial' },
  CANCELLED: { label: 'Cancelled', cls: 'stopped' }, FAILED: { label: 'Failed', cls: 'failed' },
};
/** Echo is the source of truth: its campaign status wins. The roll-up below only covers campaigns Echo has not reported on yet. */
export function campaignState(c: CampaignProgress | undefined): { label: string; cls: 'live' | 'done' | 'partial' | 'stopped' | 'idle' | 'paused' | 'failed' } {
  const echo = c?.echoStatus ? ECHO_STATES[String(c.echoStatus).toUpperCase()] : undefined;
  if (echo) return echo;
  if (!c || c.total === 0) return { label: 'Ready', cls: 'idle' };
  if (c.inProgress > 0) return { label: 'Running', cls: 'live' };
  if (c.stopped > 0 && c.completed + c.failed > 0) return { label: 'Partially completed', cls: 'partial' };
  if (c.stopped > 0) return { label: 'Stopped', cls: 'stopped' };
  return { label: 'Completed', cls: 'done' };
}

export function buildCampaignProgress(sheet: ExecutionSheet): CampaignProgress {
  const c = sheet.statusCounts ?? {};
  const get = (k: string): number => c[k] ?? 0;
  const completed = get('COMPLETED');
  // Not-yet-done work (queued, on a call, or waiting to retry) all reads as "in progress".
  const inProgress = get('IN_PROGRESS') + get('ACTIVE') + get('UPCOMING') + get('WAITING');
  const failed = get('FAILED');
  const stopped = get('STOPPED') + get('CANCELLED');
  const total = completed + inProgress + failed + stopped;
  const pct = (n: number): number => (total ? (n / total) * 100 : 0);
  return {
    total,
    completed,
    inProgress,
    failed,
    stopped,
    pctCompleted: pct(completed),
    pctInProgress: pct(inProgress),
    pctStopped: pct(stopped),
    pctFailed: pct(failed),
    echoStatus: sheet.campaignStatus ?? null,
  };
}
