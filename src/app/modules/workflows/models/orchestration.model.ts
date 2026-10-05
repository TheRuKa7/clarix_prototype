import { StepCondition } from './workflow-template.model';

export interface Lane {
  laneId?: string;
  name: string;
  order: number;
  filterRules: StepCondition[];
  sortField?: string;
  groupByKey?: string;
  targetTemplateId?: string;
}

export interface OrchestrationDefinition {
  id: string;
  orgId?: string;
  name: string;
  lanes: Lane[];
  createdAt?: string;
  updatedAt?: string;
}

export interface OrchestrationDefinitionRequest {
  name: string;
  lanes: Lane[];
}

export type LaneMatchLevel = 'EXACT' | 'GUESS' | 'NONE';

export interface LaneFieldMatch {
  fieldKey: string;
  required: boolean;
  level: LaneMatchLevel;
  matchedColumn?: string;
}

export interface LanePreviewResult {
  laneId: string;
  laneName: string;
  targetTemplateId?: string;
  targetTemplateName?: string;
  matches: LaneFieldMatch[];
}
