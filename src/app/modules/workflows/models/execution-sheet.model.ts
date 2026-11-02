export interface ExecutionSheetFailedRow {
  row: number;
  reason: string;
}

/** An uploaded bulk-trigger CSV sheet (backend: bulk_trigger_sessions). Its id = batchId. */
export interface ExecutionSheet {
  id: string;
  orgId?: string;
  templateId?: string;
  templateName?: string;
  eventType?: string;
  sourceSystem?: string;
  originalFilename?: string;
  fileUrl?: string;
  uploadedBy?: string;
  total: number;
  triggered: number;
  failed: number;
  failedRows?: ExecutionSheetFailedRow[];
  createdAt?: string;
  /** Number of this batch's executions currently IN_PROGRESS; drives the bulk "Stop calls" button. */
  inProgressCount?: number;
  /** Live execution counts keyed by WorkflowStatus name (COMPLETED, IN_PROGRESS, FAILED, …). */
  statusCounts?: Record<string, number>;
  /** Echo's campaign status, as sent with every update (Echo is the source of truth). */
  campaignStatus?: string | null;
  /** Calls per Echo outcome group (reached, not_reached, failed, in_progress, not_dialled). */
  outcomeGroups?: Record<string, number>;
  /** First dial to the end of the last call; grows while calls are open. */
  firstDialAt?: string | null;
  lastCallEndAt?: string | null;
  runSeconds?: number | null;
}
