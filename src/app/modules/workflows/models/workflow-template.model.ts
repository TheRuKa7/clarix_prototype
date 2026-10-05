export enum WorkflowStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
}

export enum ChannelType {
  CALL = 'CALL',
  WHATSAPP = 'WHATSAPP',
  CHAT = 'CHAT',
  EMAIL = 'EMAIL',
}

/**
 * Channels wired up end-to-end today, and the only ones offered as a workflow's default channel
 * or as an executions filter. The rest stay in {@link ChannelType} because the backend still
 * models them and step actions can still target them — add them here as they go live.
 */
export const SUPPORTED_CHANNELS: readonly ChannelType[] = [ChannelType.CALL];

export enum FieldDataType {
  STRING = 'STRING',
  BOOLEAN = 'BOOLEAN',
  NUMBER = 'NUMBER',
  DATE = 'DATE',
}

export enum ConditionOperator {
  EQUALS = 'EQUALS',
  NOT_EQUALS = 'NOT_EQUALS',
  CONTAINS = 'CONTAINS',
  NOT_CONTAINS = 'NOT_CONTAINS',
  IS_NULL = 'IS_NULL',
  IS_NOT_NULL = 'IS_NOT_NULL',
  IN = 'IN',
  NOT_IN = 'NOT_IN',
}

export enum ActionType {
  TRIGGER_CALL = 'TRIGGER_CALL',
  TRIGGER_WHATSAPP = 'TRIGGER_WHATSAPP',
  TRIGGER_CHAT = 'TRIGGER_CHAT',
  COMPLETE_WORKFLOW = 'COMPLETE_WORKFLOW',
  FAIL_WORKFLOW = 'FAIL_WORKFLOW',
  ESCALATE = 'ESCALATE',
  JUMP_TO_STEP = 'JUMP_TO_STEP',
  WAIT_AND_RETRY = 'WAIT_AND_RETRY',
  TRIGGER_CHILD_WORKFLOW = 'TRIGGER_CHILD_WORKFLOW',
}

export interface StepCondition {
  field: string;
  operator: ConditionOperator;
  value?: unknown;
}

export interface StepAction {
  actionType: ActionType;
  channelType?: ChannelType;
  questionTemplate?: string;
  fieldsToExtract?: string[];
  jumpToStepId?: string;
  childWorkflowTemplateId?: string;
  /** Agent/group id within the call provider for this step — overrides the template's default. */
  providerAgentId?: string;
  /** Additional provider-specific metadata (e.g. Voxera's voice/language). */
  providerParams?: Record<string, unknown>;
}

export interface WorkflowStep {
  stepId: string;
  description?: string;
  conditions?: StepCondition[];
  action: StepAction;
  onSuccessStepId?: string;
  onFailureStepId?: string;
  maxRetries?: number;
  retryDelayMinutes?: number;
}

export interface RequiredField {
  fieldKey: string;
  fieldLabel: string;
  dataType: FieldDataType;
  required: boolean;
  /** Whether this field is charted on the executions dashboard. Defaults to true. */
  showOnDashboard?: boolean;
  extractionHint?: string;
}

export type AgendaOverflowPolicy =
  | 'FOLLOW_UP_CALL_NEXT_BAND'
  | 'FOLLOW_UP_CALL_CONTINUE_ORDER'
  | 'DEFER_NEXT_CAMPAIGN';

export interface AgendaBand {
  name: string;
  rule?: string;
  matchRules: StepCondition[];
}

/**
 * Build > Orchestration > Call agenda settings. Optional and inert on every template until the
 * (separately gated) multi-line grouping engine reads it — see the backend field's javadoc.
 */
export interface CallAgendaConfig {
  bands: AgendaBand[];
  groupByKey?: string;
  maxLinesPerCall: number;
  checkInAfterLine: number;
  hardStopDuration?: string;
  overflowPolicy?: AgendaOverflowPolicy;
  reAskOnMismatch: boolean;
  capCommitmentAtOpenQuantity: boolean;
}

export interface ContactExtractionConfig {
  phoneJsonPath?: string;
  emailJsonPath?: string;
  nameJsonPath?: string;
  fallbackPhone?: string;
}

export interface ContextMapping {
  fieldName: string;
  jsonPath: string;
  required: boolean;
  /** Declared value type, used by the report filter editor. Missing on legacy templates = STRING. */
  dataType?: FieldDataType;
}

export interface ReportFieldMapping {
  header: string;
  fieldName: string;
  /** Declared value type, used by the report filter editor. Missing on legacy templates = STRING. */
  dataType?: FieldDataType;
}

/**
 * Wires a Data Function into the template. Applied at spawn time to derive
 * context/contact values the trigger didn't supply (e.g. supplier_id -> phone).
 * Keys default to the execution context; the "contact." prefix targets the
 * resolved contact (contact.phone, contact.name, contact.email, contact.fallbackPhone).
 */
export interface EnrichmentBinding {
  dataFunctionId: string;
  /** function input param name -> context/contact source key */
  inputBindings: Record<string, string>;
  /** function output name -> context/contact target key */
  outputBindings: Record<string, string>;
  required: boolean;
  /** When true, output-mapped fields also keep their own sheet column — a row supplies the value
   *  directly OR the lookup key, never both. When false, they're always derived from the lookup. */
  acceptInputs?: boolean;
}

export interface ReportFieldRename {
  oldFieldName: string;
  newFieldName: string;
}

/**
 * Per-section allowlist of columns to include in the executions CSV report.
 * A null/missing list means "include every available column in that section"
 * so legacy templates keep their current report shape.
 *
 * `columnOrder` is a cross-section ordering of namespaced column ids
 * ("detail:", "contact:", "context:", "dfInput:", "outcome:", "reportField:") that overrides
 * the default report column order; null/missing means "use default order".
 */
export interface ReportColumnSelection {
  contact?: string[];
  executionDetails?: string[];
  contextParams?: string[];
  /** Allowlist of Data Function enrichment input source keys (e.g. "supplier_id"). */
  enrichmentInputs?: string[];
  executionOutcome?: string[];
  /** Ordered, namespaced column ids overriding the default report column order. */
  columnOrder?: string[];
  /** Custom CSV header per column, keyed by namespaced column id (e.g. "detail:status"). */
  headerOverrides?: Record<string, string>;
}

export const REPORT_CONTACT_KEYS = ['name', 'phone', 'email'] as const;
export const REPORT_EXECUTION_DETAIL_KEYS = [
  'executionId',
  'name',
  'status',
  'channel',
  'createdAt',
  'completedAt',
  'callDuration',
  'sentiment',
  'summary',
] as const;

export type ReportContactKey = (typeof REPORT_CONTACT_KEYS)[number];
export type ReportExecutionDetailKey = (typeof REPORT_EXECUTION_DETAIL_KEYS)[number];

/** A call-provider profile configured under `clarix.call-providers` — feeds the provider dropdown. */
export interface CallProvider {
  key: string;
  displayName: string;
  type: 'VOXERA' | 'EXCHANGE';
}

/**
 * Fallback display names for known provider keys, used when `GET /api/v1/call-providers` hasn't
 * loaded yet (or failed) so the UI never shows the raw lowercase config key (e.g. "exchange").
 */
export const CALL_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  voxera: 'Voxera',
  exchange: 'Echo',
};

/** One entry in an Exchange campaign's declared input/output field schema. */
export interface ExchangeCampaignField {
  name: string;
  type: string;
}

/** One row of `GET /api/v1/call-providers/{key}/campaigns` — enough for a campaign picker. */
export interface ExchangeCampaignSummary {
  id: string;
  name: string;
  description?: string;
}

/**
 * `GET /api/v1/call-providers/{key}/campaigns/{campaignId}` — the input field names here are what
 * `WorkflowTemplate.agentFieldBindings` map execution-context values onto.
 */
export interface ExchangeCampaignDetail extends ExchangeCampaignSummary {
  inputFields: ExchangeCampaignField[];
  outputFields: ExchangeCampaignField[];
}

/**
 * One entry in an Exchange agent's declared input/output field schema, as pushed by the
 * agent-sync webhook — a different shape from `ExchangeCampaignField` (the real live
 * campaign-catalog API's field type), which this is not related to.
 */
export interface AgentFieldSpec {
  key: string;
  type: string;
  required?: boolean;
  label?: string;
  description?: string;
  options?: string[];
  shareOnCall?: boolean;
}

/**
 * `GET /api/v1/workflow-templates/{id}/agent-schema` — the current locally-stored schema of the
 * Exchange agent a template is routed to (never a live Exchange call). Powers the "Input Fields"
 * tab's fallback render and the "Agent Fields" tab's "Sync from agent" action.
 */
export interface AgentSchema {
  agentId: string;
  agentName?: string;
  /** Basic details pushed by Echo with the agent (optional on older backends). */
  description?: string;
  voice?: string;
  direction?: string;
  ozonetelCampaign?: string;
  /** When Clarix last received this agent from Echo. */
  syncedAt?: string;
  inputFields: AgentFieldSpec[];
  outputFields: AgentFieldSpec[];
}

/**
 * Descriptive metadata about the provider agent — shown read-only-styled on the Basic tab.
 * Entered manually for now; meant to be back-filled from Exchange agent sync later, once the
 * agent document carries this data.
 */
export interface ProviderAgentSpec {
  voice?: string;
  language?: string;
  direction?: string;
  model?: string;
  callingWindow?: string;
  endpoint?: string;
  lastPublishedAt?: string;
}

export interface WorkflowTemplate {
  id: string;
  templateKey: string;
  name: string;
  description?: string;
  orgId: string;
  /** Which configured call provider (see CallProvider) handles calls for this workflow. */
  callProviderKey?: string;
  /** Voxera: its workflow-group id. Exchange: its agent id. */
  providerAgentId: string;
  providerAgentSpec?: ProviderAgentSpec;
  /** Exchange only: agent input field name -> execution-context source key. */
  agentFieldBindings?: Record<string, string>;
  defaultChannelType: ChannelType;
  status: WorkflowStatus;
  triggerEventTypes: string[];
  triggerFilters?: StepCondition[];
  contactExtractionConfig?: ContactExtractionConfig;
  contextMappings?: ContextMapping[];
  reportFields?: ReportFieldMapping[];
  reportColumns?: ReportColumnSelection;
  requiredFields: RequiredField[];
  enrichments?: EnrichmentBinding[];
  callAgendaConfig?: CallAgendaConfig;
  steps: WorkflowStep[];
  maxRetries: number;
  retryDelayMinutes: number;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  executionCount?: number;
  lastRunAt?: string;
  /** Terminal-status counts, populated on list responses only. In-flight runs are in neither. */
  completedCount?: number;
  failedCount?: number;
  cancelledCount?: number;
}

export interface WorkflowTemplateRequest {
  templateKey: string;
  name: string;
  description?: string;
  defaultChannelType: ChannelType;
  callProviderKey?: string;
  providerAgentId: string;
  providerAgentSpec?: ProviderAgentSpec;
  agentFieldBindings?: Record<string, string>;
  triggerEventTypes: string[];
  triggerFilters?: StepCondition[];
  contactExtractionConfig?: ContactExtractionConfig;
  contextMappings?: ContextMapping[];
  reportFields?: ReportFieldMapping[];
  reportColumns?: ReportColumnSelection;
  reportFieldRenames?: ReportFieldRename[];
  requiredFields: RequiredField[];
  enrichments?: EnrichmentBinding[];
  callAgendaConfig?: CallAgendaConfig;
  steps: WorkflowStep[];
  maxRetries: number;
  retryDelayMinutes: number;
}

export interface BaseResponse<T = unknown> {
  status: boolean;
  message: string;
  code?: number;
  data?: T;
  totalElements?: number;
}

export interface WorkflowTemplateStats {
  total: number;
  active: number;
  draft: number;
  totalSteps: number;
}

export interface BulkTriggerFailedRow {
  row: number;
  reason: string;
}

export interface BulkTriggerRowResult {
  row: number;
  status: 'ACCEPTED' | 'FAILED';
  reason: string;
}

export interface BulkTriggerResult {
  sessionId?: string;
  total: number;
  triggered: number;
  failed: number;
  failedRows: BulkTriggerFailedRow[];
  rows?: BulkTriggerRowResult[];
}

export interface ResolvedContact {
  name?: string;
  phone?: string;
  email?: string;
  fallbackPhone?: string;
  entityType?: string;
  entityId?: string;
}

export interface WorkflowExecution {
  id: string;
  templateId: string;
  triggerEventId?: string;
  name?: string;
  orgId: string;
  /** System/service responsible for the trigger, e.g. "SCM"/"Finance"/"EOC" or "Clarix". */
  sourceSystem?: string;
  /** How the workflow was triggered. */
  triggerMethod?: 'KAFKA_EVENT' | 'API_CALL' | 'CSV_UPLOAD';
  /** User responsible for the trigger (email for CSV/API; publisher-supplied for Kafka). */
  triggeredBy?: string;
  status: string;
  activeChannelType?: string;
  resolvedContact?: ResolvedContact;
  context?: Record<string, unknown>;
  extractedFields?: Record<string, unknown>;
  /** Raw Data Function enrichment input values supplied on the trigger, keyed by source key. */
  enrichmentInputs?: Record<string, unknown>;
  currentStepId?: string;
  currentStepRetryCount?: number;
  nextTriggerAt?: string;
  activeConversationId?: string;
  failureReason?: string;
  completedBy?: string;
  createdAt?: string;
  scheduledAt?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  /** Actual call/conversation length in seconds (latest conversation). Null for non-call channels. */
  callDurationSeconds?: number;
  /** Groups every row of one CSV upload together; null for a single API/Kafka-triggered call. */
  batchId?: string;
  /** Set once the call is actually POSTed to the provider — null means still queued locally. */
  providerCallId?: string;
  /** When {@link providerCallId} was set — the moment this row was actually dispatched. */
  batchSubmittedAt?: string;
  /** Echo's normalized call status, result and reason (PRD-ECHO-11). Shown as sent; never re-derived here. */
  callStatus?: string | null;
  callResult?: string | null;
  callReason?: string | null;
  attemptNumber?: number | null;
  maxAttempts?: number | null;
  nextAttemptAt?: string | null;
  /** Ozonetel timing and hang up side of the latest dial, and every dial so far (from Echo). */
  ringSeconds?: number | null;
  hangupBy?: string | null;
  lastAttemptAt?: string | null;
  lastAttemptStatus?: string | null;
  lastAttemptReason?: string | null;
  providerStatus?: { Status?: string; DialStatus?: string; CustomerStatus?: string; HangupBy?: string; monitorUCID?: string } | null;
  attemptLog?: DialAttempt[] | null;
  /** Echo's call status and its group (PRD-ECHO-19); Clarix only shows them. */
  outcome?: string | null;
  outcomeGroup?: string | null;
}

/** One dial of a row: what Ozonetel sent and the status Echo gave it (PRD-ECHO-11 sections 7 and 8). */
export interface DialAttempt {
  attempt: number;
  startedAt: string;
  ringSeconds: number | null;
  talkSeconds: number;
  callStatus: string;
  callResult: string | null;
  callReason: string | null;
  anomalies: string[];
  outcome?: string | null;
  provider: { Status?: string; DialStatus?: string; CustomerStatus?: string; HangupBy?: string };
}
