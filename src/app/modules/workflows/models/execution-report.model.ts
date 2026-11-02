import { FieldDataType, ReportColumnSelection } from './workflow-template.model';
import { EmailSchedule } from './email-schedule.model';

/** Mirrors the backend com.moglix.clarix.constants.FilterOperator. */
export enum FilterOperator {
  EQUALS = 'EQUALS',
  NOT_EQUALS = 'NOT_EQUALS',
  IN = 'IN',
  NOT_IN = 'NOT_IN',
  CONTAINS = 'CONTAINS',
  GT = 'GT',
  GTE = 'GTE',
  LT = 'LT',
  LTE = 'LTE',
  BETWEEN = 'BETWEEN',
  BEFORE = 'BEFORE',
  AFTER = 'AFTER',
  IS_TRUE = 'IS_TRUE',
  IS_FALSE = 'IS_FALSE',
  IS_EMPTY = 'IS_EMPTY',
  IS_NOT_EMPTY = 'IS_NOT_EMPTY',
}

/** One filter condition on an execution report. */
export interface ReportFilter {
  columnId: string;
  dataType: FieldDataType;
  operator: FilterOperator;
  values: string[];
}

/**
 * The default date pattern, mirroring WorkflowReportServiceImpl.DEFAULT_DATE_FORMAT.
 * Renders "08 Jul 2026, 11:45 AM".
 */
export const DEFAULT_REPORT_DATE_FORMAT = 'dd MMM yyyy, hh:mm a';

/**
 * Date patterns offered for a report, each labelled by how 8 July 2026 11:45 renders — a bare
 * pattern like "dd-MM-yyyy" tells the reader far less than the date itself. The value is the
 * java.time pattern stored on the report and handed straight to the CSV builder.
 */
export const REPORT_DATE_FORMAT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'dd MMM yyyy, hh:mm a', label: '08 Jul 2026, 11:45 AM' },
  { value: 'dd MMM yyyy HH:mm', label: '08 Jul 2026 11:45' },
  { value: 'dd-MM-yyyy HH:mm:ss', label: '08-07-2026 11:45:00' },
  { value: 'dd/MM/yyyy HH:mm:ss', label: '08/07/2026 11:45:00' },
  { value: 'dd-MM-yyyy hh:mm:ss a', label: '08-07-2026 11:45:00 AM' },
  { value: 'dd-MM-yyyy', label: '08-07-2026' },
  { value: 'MM-dd-yyyy HH:mm:ss', label: '07-08-2026 11:45:00' },
  { value: 'yyyy-MM-dd HH:mm:ss', label: '2026-07-08 11:45:00' },
];

/** A saved execution report. */
export interface ExecutionReport {
  id: string;
  orgId?: string;
  templateId: string;
  title: string;
  description?: string;
  reportColumns?: ReportColumnSelection;
  filters?: ReportFilter[];
  /** java.time pattern every date cell renders with. Missing means the default. */
  preferredDateFormat?: string;
  emailSchedules?: EmailSchedule[];
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Create/update payload. */
export interface ExecutionReportRequest {
  templateId: string;
  title: string;
  description?: string;
  reportColumns?: ReportColumnSelection;
  filters?: ReportFilter[];
  preferredDateFormat?: string;
}
