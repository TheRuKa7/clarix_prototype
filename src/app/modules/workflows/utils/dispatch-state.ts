import { WorkflowExecution } from '../models/workflow-template.model';

export type DispatchState = 'queued' | 'sent' | 'not-sent';

/**
 * Whether an execution's call has actually been sent to the provider yet, distinct from its
 * workflow `status` — a batch-capable provider (e.g. Exchange) queues a row locally and only
 * dispatches it once the whole CSV upload's batch is flushed, so `IN_PROGRESS` alone doesn't mean
 * "sent". Returns null when the row hasn't reached a call step at all (e.g. still UPCOMING, or a
 * non-call channel that never got a providerCallId).
 */
export function dispatchState(execution: WorkflowExecution): DispatchState | null {
  if (execution.providerCallId) return 'sent';
  switch (execution.status) {
    case 'IN_PROGRESS':
    case 'WAITING':
      return 'queued';
    case 'FAILED':
    case 'CANCELLED':
    case 'STOPPED':
      return 'not-sent';
    default:
      return null;
  }
}

/** Correlation id to trace this call in the provider's own dashboard/logs. */
export function dispatchTraceRef(execution: WorkflowExecution): string {
  return execution.batchId || execution.providerCallId || execution.id;
}

export function dispatchTooltip(execution: WorkflowExecution, formatDateTime: (v?: string) => string): string {
  const state = dispatchState(execution);
  const ref = dispatchTraceRef(execution);
  if (state === 'sent') {
    const at = execution.batchSubmittedAt ? formatDateTime(execution.batchSubmittedAt) : 'unknown time';
    return `Sent to provider at ${at} — trace ref: ${ref}`;
  }
  if (state === 'queued') {
    return `Queued locally, not yet sent to the call provider — trace ref: ${ref}`;
  }
  if (state === 'not-sent') {
    return 'Never reached the call provider (failed before dispatch)';
  }
  return '';
}
