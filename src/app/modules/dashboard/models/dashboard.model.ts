export interface TopKpis {
  numberOfWorkflows: number;
  activeCalls: number;
  callsInQueue: number;
}

export interface CallAnalytics {
  totalCalls: number;
  answeredCalls: number;
  answerRate: number;
  connectionRate: number;
  abandonRate: number;
  slaPerformance: number;
  avgHandlingTimeSec: number | null;
  avgWaitTimeSec: number | null;
}

export interface CallDistributionItem {
  status: string;
  count: number;
}

export interface DirectionItem {
  direction: string;
  count: number;
}

export interface Trends {
  today: number;
  yesterday: number;
  difference: number;
  growthRate: number;
}

export interface VolumeChartItem {
  hour: number;
  day: 'today' | 'yesterday';
  count: number;
}

export interface Performance {
  slaPerformance: number;
  connectionRate: number;
  abandonRate: number;
  avgHandlingTimeSec: number | null;
  avgWaitTimeSec: number | null;
  queuedCalls: number;
  longestQueueSec: number;
  efficiencyScore: number;
}

export interface DashboardData {
  topKpis: TopKpis;
  callAnalytics: CallAnalytics;
  callDistribution: CallDistributionItem[];
  direction: DirectionItem[];
  trends: Trends;
  volumeChart: VolumeChartItem[];
  performance: Performance;
}

export interface HourlyBar {
  hour: number;
  today: number;
  yesterday: number;
}

export interface BaseResponse<T = unknown> {
  data: T;
  status: boolean;
  message?: string;
  totalElements?: number;
}
