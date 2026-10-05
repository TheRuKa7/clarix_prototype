export type FieldDataType = 'STRING' | 'BOOLEAN' | 'NUMBER' | 'DATE' | 'JSON';

export interface DashboardKpis {
  totalExecutions: number;
  completed: number;
  failed: number;
  inProgress: number;
  waiting: number;
  cancelled: number;
  completionRate: number;
  avgDurationMs: number | null;
  reachableContactRate: number;
}

export interface DashboardBucketCount {
  key: string | null;
  count: number;
}

export interface DashboardTimeBucket {
  date: string;
  created: number;
  completed: number;
  failed: number;
}

export interface DashboardTimeSeries {
  granularity: 'DAY' | 'WEEK' | 'MONTH';
  buckets: DashboardTimeBucket[];
}

export interface DashboardFieldBreakdown {
  fieldKey: string;
  fieldLabel: string;
  dataType: FieldDataType;
  totalAnswered: number;
  totalUnanswered: number;
  distribution: DashboardBucketCount[];
}

export interface WorkflowDashboardData {
  kpis: DashboardKpis;
  statusBreakdown: DashboardBucketCount[];
  /** Still returned by the API; no longer charted, since calls are the only channel in use. */
  channelBreakdown: DashboardBucketCount[];
  /** Call-length histogram, full ordered bin set including empty bins. */
  durationBuckets: DashboardBucketCount[];
  timeSeries: DashboardTimeSeries;
  fieldBreakdowns: DashboardFieldBreakdown[];
}
