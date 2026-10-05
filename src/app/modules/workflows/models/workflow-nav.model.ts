export type WorkflowMode = 'run' | 'build';

export interface WorkflowNavItem {
  label: string;
  route: string;
  icon: string;
}

/**
 * Static nav config for the Run/Build workspace shell. Run is the operator's day-to-day surface;
 * Build is where agents, data lookups, and multi-agent routing get configured. Campaign Detail is a
 * drill-in from Campaigns, not a nav item of its own.
 */
export const WORKFLOW_NAV: Record<WorkflowMode, WorkflowNavItem[]> = {
  run: [
    { label: 'Agents', route: '/workflows/agents', icon: 'bot' },
    { label: 'Campaigns', route: '/workflows/campaigns', icon: 'phone-call' },
    { label: 'Call Logs', route: '/workflows/calls', icon: 'phone-outgoing' },
  ],
  build: [
    { label: 'Agent setup', route: '/workflows/build/agents', icon: 'settings-2' },
    { label: 'Data', route: '/workflows/build/data', icon: 'database' },
    { label: 'Orchestration', route: '/workflows/build/orchestration', icon: 'shuffle' },
    { label: 'Reports', route: '/workflows/reports', icon: 'file-text' },
  ],
};
