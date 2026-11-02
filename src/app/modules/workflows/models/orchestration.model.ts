import { StepCondition } from './workflow-template.model';

/** One route: rows that match every rule go to one agent. How those rows become calls is the agent's own plan in Echo. */
export interface Lane {
  laneId?: string;
  name: string;
  order: number;
  filterRules: StepCondition[];
  targetTemplateId?: string;
}

/** What happens to rows that match no route: left out of the campaign, or sent to one agent. */
export interface UnmatchedRule { action: 'leave' | 'route'; targetTemplateId?: string }

export interface OrchestrationDefinition {
  id: string;
  orgId?: string;
  name: string;
  lanes: Lane[];
  unmatched?: UnmatchedRule;
  createdAt?: string;
  updatedAt?: string;
}

export interface OrchestrationDefinitionRequest {
  name: string;
  lanes: Lane[];
  unmatched?: UnmatchedRule;
}

/** A file to build and test rules against: a recent upload, or one uploaded here. */
export interface SampleFile { id: string; name: string; rows: number; uploaded: boolean }
export interface SampleColumn { name: string; distinct: number; blanks: number; values: { value: string; rows: number }[] }
export interface SampleDetail extends SampleFile { columns: SampleColumn[] }

export interface RoutePreview {
  index: number;
  name: string;
  rows: number;
  agent: string;
  agentSet: boolean;
  /** The agent's own plan for turning rows into calls, as set in Echo. */
  plan: string;
  contacts: number;
  calls: number;
  /** Inputs the agent needs that the file has no column for. */
  missing: string[];
  /** Columns named in rules that the file does not have. */
  unusedRules: string[];
  leftOut?: boolean;
}
export interface OrchestrationPreview { file: string; total: number; routed: number; routes: RoutePreview[]; rest: RoutePreview }
