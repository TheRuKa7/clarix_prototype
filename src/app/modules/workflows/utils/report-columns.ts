import {
  FieldDataType,
  REPORT_CONTACT_KEYS,
  WorkflowTemplate,
} from '../models/workflow-template.model';
import { FilterOperator } from '../models/execution-report.model';
import {
  DataFunction,
  FieldDataType as DataFunctionDataType,
} from '../../data-functions/models/data-function.model';
import { resolveTriggerInputs } from './trigger-inputs';

/** One report column with the metadata the selector + filters UI need. */
export interface ReportColumnMeta {
  /** Namespaced id, shared byte-for-byte with the backend (e.g. "detail:status"). */
  id: string;
  label: string;
  section: string;
  dataType: FieldDataType;
  /** False for conversation-derived columns that can't be filtered in Mongo. */
  filterable: boolean;
  /** Known enum value set (drives multi-select value lists in the filter editor). */
  enumKind?: 'status' | 'channel';
}

const CONTACT_LABELS: Record<string, string> = {
  name: 'Contact Name',
  phone: 'Contact Phone',
  email: 'Contact Email',
};

const DETAIL_META: Record<
  string,
  { label: string; dataType: FieldDataType; filterable: boolean; enumKind?: 'status' | 'channel' }
> = {
  executionId: { label: 'Execution Id', dataType: FieldDataType.STRING, filterable: true },
  name: { label: 'Name', dataType: FieldDataType.STRING, filterable: true },
  status: { label: 'Status', dataType: FieldDataType.STRING, filterable: true, enumKind: 'status' },
  channel: { label: 'Channel', dataType: FieldDataType.STRING, filterable: true, enumKind: 'channel' },
  createdAt: { label: 'Created At', dataType: FieldDataType.DATE, filterable: true },
  completedAt: { label: 'Completed At', dataType: FieldDataType.DATE, filterable: true },
  // Rendered as "1 min 59 seconds" in the CSV, not raw seconds.
  callDuration: { label: 'Call Duration', dataType: FieldDataType.NUMBER, filterable: false },
  sentiment: { label: 'Sentiment', dataType: FieldDataType.STRING, filterable: false },
  summary: { label: 'Summary', dataType: FieldDataType.STRING, filterable: false },
  priority: { label: 'Priority', dataType: FieldDataType.STRING, filterable: false },
  issueResolved: { label: 'Issue Resolved', dataType: FieldDataType.BOOLEAN, filterable: false },
  callPurpose: { label: 'Call Purpose', dataType: FieldDataType.STRING, filterable: false },
  issueCategory: { label: 'Issue Category', dataType: FieldDataType.STRING, filterable: false },
  suggestedIssue: { label: 'Suggested Issue', dataType: FieldDataType.STRING, filterable: false },
};

/**
 * Data Functions declare a JSON type the report filter editor has no operators for; it filters
 * such values as opaque strings. Every other DF type maps 1:1 onto a report column type.
 */
function fromDataFunctionType(type: DataFunctionDataType | undefined): FieldDataType {
  switch (type) {
    case 'NUMBER':
      return FieldDataType.NUMBER;
    case 'BOOLEAN':
      return FieldDataType.BOOLEAN;
    case 'DATE':
      return FieldDataType.DATE;
    default:
      return FieldDataType.STRING;
  }
}

interface EnrichmentTypes {
  /** Trigger-supplied enrichment input source key -> type of the function param it feeds. */
  inputs: Map<string, FieldDataType>;
  /** Enrichment output target key -> declared type of the function output that produces it. */
  outputs: Map<string, FieldDataType>;
}

/**
 * Types carried by a template's Data Function bindings. A value produced or consumed by a
 * function is coerced to the function's declared type at spawn time, so that declaration — not
 * anything on the template — is what the stored value's type actually is.
 */
function enrichmentTypes(template: WorkflowTemplate, dataFunctions: DataFunction[]): EnrichmentTypes {
  const byId = new Map(dataFunctions.map((f) => [f.id, f]));
  const inputs = new Map<string, FieldDataType>();
  const outputs = new Map<string, FieldDataType>();

  for (const binding of template.enrichments ?? []) {
    const fn = byId.get(binding.dataFunctionId);
    if (!fn) continue;

    const paramTypes = new Map((fn.parameters ?? []).map((p) => [p.name, p.dataType]));
    for (const [param, source] of Object.entries(binding.inputBindings ?? {})) {
      // First binding wins: a source key feeding two functions can only have one type.
      if (source && !inputs.has(source)) inputs.set(source, fromDataFunctionType(paramTypes.get(param)));
    }

    const outputTypes = new Map((fn.outputs ?? []).map((o) => [o.name, o.dataType]));
    for (const [output, target] of Object.entries(binding.outputBindings ?? {})) {
      if (target && !outputs.has(target)) outputs.set(target, fromDataFunctionType(outputTypes.get(output)));
    }
  }
  return { inputs, outputs };
}

/**
 * Canonical report columns for a template, in the same order the backend CSV builder emits them.
 * Single source of column truth for both the column selector and the filter editor.
 *
 * `dataFunctions` supplies the declared types of enrichment inputs and outputs; pass the org's
 * functions to type those columns, or omit it and they fall back to STRING.
 */
export function deriveReportColumns(
  template: WorkflowTemplate,
  dataFunctions: DataFunction[] = []
): ReportColumnMeta[] {
  const cols: ReportColumnMeta[] = [];
  const dfTypes = enrichmentTypes(template, dataFunctions);
  const detailCol = (key: string): ReportColumnMeta => {
    const d = DETAIL_META[key];
    return {
      id: `detail:${key}`,
      label: d.label,
      section: 'Execution Details',
      dataType: d.dataType,
      filterable: d.filterable,
      enumKind: d.enumKind,
    };
  };

  cols.push(detailCol('executionId'), detailCol('name'));
  for (const k of REPORT_CONTACT_KEYS) {
    // Name/phone/email are always stored as strings, whatever produced them.
    cols.push({
      id: `contact:${k}`,
      label: CONTACT_LABELS[k],
      section: 'Contact',
      dataType: FieldDataType.STRING,
      filterable: true,
    });
  }
  for (const k of ['status', 'channel', 'createdAt', 'completedAt', 'callDuration', 'sentiment', 'summary',
    'priority', 'issueResolved', 'callPurpose', 'issueCategory', 'suggestedIssue']) {
    cols.push(detailCol(k));
  }
  for (const cm of template.contextMappings ?? []) {
    const name = cm.fieldName?.trim();
    if (name) {
      // An enrichment that writes this key coerces the value to its output type, overriding
      // whatever the mapping declares.
      const dataType = dfTypes.outputs.get(name) ?? cm.dataType ?? FieldDataType.STRING;
      cols.push({ id: `context:${name}`, label: name, section: 'Context Params', dataType, filterable: true });
    }
  }
  for (const inp of resolveTriggerInputs(template).enrichmentInputs) {
    cols.push({
      id: `dfInput:${inp.key}`,
      label: inp.key,
      section: 'Data Function Inputs',
      dataType: dfTypes.inputs.get(inp.key) ?? FieldDataType.STRING,
      filterable: true,
    });
  }
  for (const rf of template.requiredFields ?? []) {
    const key = rf.fieldKey?.trim();
    if (key) {
      cols.push({
        id: `outcome:${key}`,
        label: rf.fieldLabel?.trim() || key,
        section: 'Execution Outcome',
        dataType: rf.dataType ?? FieldDataType.STRING,
        filterable: true,
      });
    }
  }
  for (const rfm of template.reportFields ?? []) {
    const name = rfm.fieldName?.trim();
    if (name) {
      cols.push({
        id: `reportField:${name}`,
        label: rfm.header?.trim() || name,
        section: 'Additional Fields',
        dataType: rfm.dataType ?? FieldDataType.STRING,
        filterable: true,
      });
    }
  }
  return cols;
}

/** Report-field columns are always included by the backend; they can't be toggled off. */
export function isAlwaysIncluded(columnId: string): boolean {
  return columnId.startsWith('reportField:');
}

/** Number of values an operator needs: 0 (unary), 2 (between), or 1. */
export function operatorArity(op: FilterOperator): 0 | 1 | 2 {
  switch (op) {
    case FilterOperator.IS_TRUE:
    case FilterOperator.IS_FALSE:
    case FilterOperator.IS_EMPTY:
    case FilterOperator.IS_NOT_EMPTY:
      return 0;
    case FilterOperator.BETWEEN:
      return 2;
    default:
      return 1;
  }
}

/** Operators accept a list of values (rendered as a multi-value editor). */
export function operatorIsMulti(op: FilterOperator): boolean {
  return op === FilterOperator.IN || op === FilterOperator.NOT_IN;
}

/** Operators valid for a given column data type. */
export function operatorsFor(dataType: FieldDataType): FilterOperator[] {
  switch (dataType) {
    case FieldDataType.NUMBER:
      return [
        FilterOperator.EQUALS, FilterOperator.NOT_EQUALS,
        FilterOperator.GT, FilterOperator.GTE, FilterOperator.LT, FilterOperator.LTE,
        FilterOperator.BETWEEN, FilterOperator.IS_EMPTY, FilterOperator.IS_NOT_EMPTY,
      ];
    case FieldDataType.DATE:
      return [
        FilterOperator.BEFORE, FilterOperator.AFTER, FilterOperator.BETWEEN,
        FilterOperator.IS_EMPTY, FilterOperator.IS_NOT_EMPTY,
      ];
    case FieldDataType.BOOLEAN:
      return [FilterOperator.IS_TRUE, FilterOperator.IS_FALSE];
    default: // STRING (and enum columns)
      return [
        FilterOperator.EQUALS, FilterOperator.NOT_EQUALS,
        FilterOperator.IN, FilterOperator.NOT_IN, FilterOperator.CONTAINS,
        FilterOperator.IS_EMPTY, FilterOperator.IS_NOT_EMPTY,
      ];
  }
}

/** Known enum value sets for the status/channel filter multi-selects. */
export const WORKFLOW_STATUS_VALUES = [
  'DRAFT', 'UPCOMING', 'ACTIVE', 'IN_PROGRESS', 'WAITING', 'COMPLETED', 'FAILED', 'PAUSED', 'CANCELLED',
];
export const CHANNEL_TYPE_VALUES = ['CALL', 'WHATSAPP', 'CHAT', 'EMAIL'];

/** Human labels for operators in the dropdown. */
export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  [FilterOperator.EQUALS]: 'equals',
  [FilterOperator.NOT_EQUALS]: 'not equals',
  [FilterOperator.IN]: 'in',
  [FilterOperator.NOT_IN]: 'not in',
  [FilterOperator.CONTAINS]: 'contains',
  [FilterOperator.GT]: '>',
  [FilterOperator.GTE]: '≥',
  [FilterOperator.LT]: '<',
  [FilterOperator.LTE]: '≤',
  [FilterOperator.BETWEEN]: 'between',
  [FilterOperator.BEFORE]: 'before',
  [FilterOperator.AFTER]: 'after',
  [FilterOperator.IS_TRUE]: 'is true',
  [FilterOperator.IS_FALSE]: 'is false',
  [FilterOperator.IS_EMPTY]: 'is empty',
  [FilterOperator.IS_NOT_EMPTY]: 'is not empty',
};
