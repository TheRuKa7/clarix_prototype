/**
 * One entry in an execution's append-only audit log (backend: workflow_events).
 * Drives the debug timeline on the execution detail page.
 */
export interface WorkflowEventModel {
  id: string;
  workflowExecutionId?: string;
  conversationId?: string;
  orgId?: string;
  /** e.g. CALL_INITIATED, WEBHOOK_RECEIVED, STATUS_SYNC, RETRY_SCHEDULED, WORKFLOW_COMPLETED */
  eventType: string;
  /** PENDING | SUCCESS | FAILED | RETRYING */
  status: string;
  /** Outbound payload sent to the call provider (present on request-side events). */
  requestPayload?: Record<string, unknown> | null;
  /** Inbound webhook / API-poll payload from the call provider (present on response-side events). */
  responsePayload?: Record<string, unknown> | null;
  errorMessage?: string | null;
  retryAttempt?: number;
  /** Who performed the action, for user-initiated events (trigger, stop, manual sync). */
  performedBy?: string | null;
  createdAt?: string;
}
