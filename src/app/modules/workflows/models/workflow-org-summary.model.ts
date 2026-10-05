/**
 * Org-wide numbers behind Run > Agents' metric strip and Run > Campaigns' KPI cards.
 * `answeredPct`/`commitments` are backend-documented heuristics — see WorkflowOrgSummaryResponse.
 */
export interface WorkflowOrgSummary {
  agentsLive: number;
  campaignsRunning: number;
  callsPlaced: number;
  answeredPct: number;
  commitments: number;
  activeBatches: number;
  callsCompleted: number;
  pendingCallbacks: number;
}

export const EMPTY_ORG_SUMMARY: WorkflowOrgSummary = {
  agentsLive: 0,
  campaignsRunning: 0,
  callsPlaced: 0,
  answeredPct: 0,
  commitments: 0,
  activeBatches: 0,
  callsCompleted: 0,
  pendingCallbacks: 0,
};
