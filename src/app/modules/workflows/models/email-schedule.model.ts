export type ScheduleType = 'RECURRING' | 'ONCE';
export type EmailScheduleRunStatus = 'SUCCESS' | 'NO_DATA' | 'FAILED';

export type DataWindowType =
  | 'ALL'
  | 'LAST_HOURS'
  | 'LAST_DAYS'
  | 'LAST_WEEKS'
  | 'LAST_MONTHS'
  | 'TODAY'
  | 'PREVIOUS_DAY'
  | 'WEEK_TO_DATE'
  | 'PREVIOUS_WEEK'
  | 'MONTH_TO_DATE'
  | 'PREVIOUS_MONTH';

export interface ReportDataWindow {
  type: DataWindowType;
  value: number;
}

export interface EmailSchedule {
  id: string;
  name?: string;
  enabled: boolean;
  scheduleType: ScheduleType;
  cron?: string;
  runAt?: string;
  timezone?: string;
  summary?: string;
  recipientsTo: string[];
  recipientsCc?: string[];
  subject: string;
  body?: string;
  singleThread: boolean;
  dataWindow?: ReportDataWindow;
  lastRunAt?: string;
  lastRunStatus?: EmailScheduleRunStatus;
  lastError?: string;
  nextRunAt?: string;
  createdBy?: string;
  createdAt?: string;
}

export interface EmailScheduleRequest {
  name?: string;
  scheduleType: ScheduleType;
  cron?: string;
  runAt?: string;
  timezone?: string;
  summary?: string;
  recipientsTo: string[];
  recipientsCc?: string[];
  subject: string;
  body?: string;
  singleThread: boolean;
  dataWindow?: ReportDataWindow;
}

export interface UpcomingSend {
  scheduleId: string;
  name?: string;
  summary?: string;
  at: string;
}

/** Data-range presets for the schedule modal. `rolling` types take an N (value). */
export const DATA_WINDOW_PRESETS: {
  type: DataWindowType;
  label: string;
  rolling?: boolean;
  unit?: string;
}[] = [
  { type: 'ALL', label: 'All time' },
  { type: 'TODAY', label: 'Today (so far)' },
  { type: 'PREVIOUS_DAY', label: 'Yesterday' },
  { type: 'WEEK_TO_DATE', label: 'This week (so far)' },
  { type: 'PREVIOUS_WEEK', label: 'Previous week' },
  { type: 'MONTH_TO_DATE', label: 'This month (so far)' },
  { type: 'PREVIOUS_MONTH', label: 'Previous month' },
  { type: 'LAST_HOURS', label: 'Last N hours', rolling: true, unit: 'hours' },
  { type: 'LAST_DAYS', label: 'Last N days', rolling: true, unit: 'days' },
  { type: 'LAST_WEEKS', label: 'Last N weeks', rolling: true, unit: 'weeks' },
  { type: 'LAST_MONTHS', label: 'Last N months', rolling: true, unit: 'months' },
];
