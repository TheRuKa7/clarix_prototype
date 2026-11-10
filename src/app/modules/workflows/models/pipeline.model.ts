/** A rule inside a lane or drop group. Numeric operators (LT, LTE, GT, GTE) compare numbers. */
export interface PipelineRule { field: string; operator: string; value: string }
/** One spec takes a source to calls and back: ingest, clean, route, enrich, reshape, project, write back. */
export interface PipelineSpec {
  id: string;
  name: string;
  case: string;
  source: { kind: 'sheet' | 'webhook' | 'rest' | 'sql'; label: string; sheets: string[]; sample?: string };
  clean: {
    types: Record<string, 'id' | 'date' | 'phone' | 'number' | 'text'>;
    derive: { key: string; fn: string; of?: string | string[]; label?: string }[];
    drop: { label: string; rules: PipelineRule[] }[];
  };
  lanes: PipelineLane[];
  unmatched: { action: 'leave' | 'route' };
  updatedAt?: string;
}
export interface PipelineLane {
  id: string;
  name: string;
  agent: string;
  /** Any group may match; inside a group every rule must. Empty means every row. */
  when: { rules: PipelineRule[] }[];
  enrich?: { lookup: string; by: Record<string, string>; take?: Record<string, string>; list?: string; only_blank?: boolean }[];
  reshape: {
    mode: 'one' | 'fan_out' | 'fan_in';
    item?: Record<string, string>; dedupe?: string[]; merge?: Record<string, string>;
    group_by?: string[]; max_rows?: number; aggregates?: { key: string; fn: string; of?: string }[]; lines?: { key: string; format: string };
  };
  project: { input: string; from: string; spoken: boolean }[];
  outputs?: Record<string, string[]>;
  writeback?: { key: string[]; to: string };
}
export interface PipelineSummary { id: string; name: string; case: string; source: string; lanes: number; updatedAt: string }
export interface PipelineCall {
  call_id: string; lane: string; lane_name: string; agent: string; phone: string; part: string;
  inputs: { input: string; value: string | number; spoken: boolean }[];
  row_ids: string[]; source: Record<string, string>[];
}
export interface PipelineSetAside { stage: string; lane: string; row_id: string; reason: string; row: Record<string, unknown> }
export interface PipelineRun {
  id: string; name: string; source: string; ranAt: string; columns: string[];
  funnel: { key: string; label: string; value: number; note: string }[];
  fixes: { what: string; rows: number }[];
  dropped: { reason: string; rows: number }[];
  unmatched: number;
  lanes: { id: string; name: string; agent: string; rows: number; ready: number; contacts: number; reshape: string; calls: number; set_aside: number; rule: string }[];
  lookups: { lookup: string; label: string; call: string; kind: string; requests: number; cached: number; empty: number }[];
  quarantine: PipelineSetAside[];
  calls: PipelineCall[];
  results: {
    calls: number; rows: number;
    lanes: { name: string; to: string; key: string[]; calls: number; rows: number }[];
    outcomes: { value: string; calls: number }[];
    sample: ({ row_id: string; call_id: string; lane: string; key: Record<string, string> } & Record<string, unknown>)[];
  } | null;
}
