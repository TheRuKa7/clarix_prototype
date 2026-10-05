import { Routes } from '@angular/router';
import { LayoutComponent } from './components/layout.component';
import { authGuard } from './core/auth/guards/auth.guard';
import { permissionGuard } from './core/permissions/guards/permission.guard';
import { ManagePermissionsComponent } from './modules/admin/pages/manage-permissions/manage-permissions.component';
import { DashboardLayoutComponent } from './modules/dashboard/components/dashboard-layout/dashboard-layout.component';
import { DashboardOverviewComponent } from './modules/dashboard/pages/dashboard-overview/dashboard-overview.component';
import { WorkflowExecutionDetailComponent } from './modules/workflows/pages/workflow-execution-detail/workflow-execution-detail.component';
import { WorkflowExecutionsComponent } from './modules/workflows/pages/workflow-executions/workflow-executions.component';
import { WorkflowTemplatesComponent } from './modules/workflows/pages/workflow-templates.component';
import { WorkflowsLayoutComponent } from './modules/workflows/workflows-layout.component';
import { ExecutionReportsComponent } from './modules/workflows/pages/execution-reports/execution-reports.component';
import { ExecutionReportFormComponent } from './modules/workflows/pages/execution-report-form/execution-report-form.component';
import { ExecutionSheetsComponent } from './modules/workflows/pages/execution-sheets/execution-sheets.component';
import { RunAgentsComponent } from './modules/workflows/pages/run-agents/run-agents.component';
import { CampaignDetailComponent } from './modules/workflows/pages/campaign-detail/campaign-detail.component';
import { CallLogsComponent } from './modules/workflows/pages/call-logs/call-logs.component';
import { DataHubComponent } from './modules/workflows/pages/data-hub/data-hub.component';
import { OrchestrationHubComponent } from './modules/workflows/pages/orchestration-hub/orchestration-hub.component';
import { LoginComponent } from './pages/login.component';

export const routes: Routes = [
  {
    path: 'login',
    component: LoginComponent,
    title: 'Login to Clarix | Enterprise AI Orchestration Platform'
  },
  {
    path: '',
    component: LayoutComponent,
    canActivate: [authGuard],
    children: [
      {
        path: 'dashboard',
        component: DashboardLayoutComponent,
        children: [
          {
            path: '',
            redirectTo: 'overview',
            pathMatch: 'full'
          },
          {
            path: 'overview',
            component: DashboardOverviewComponent
          }
        ]
      },
      {
        path: 'workflows',
        component: WorkflowsLayoutComponent,
        canActivate: [permissionGuard('workflows:menuvisibility')],
        children: [
          // Run > Agents is the new landing page for the module.
          {
            path: '',
            redirectTo: 'agents',
            pathMatch: 'full'
          },
          {
            path: 'agents',
            component: RunAgentsComponent,
            title: 'Agents | Clarix',
            canActivate: [permissionGuard('workflows:template:read')]
          },
          {
            path: 'campaigns',
            component: ExecutionSheetsComponent,
            title: 'Campaigns | Clarix'
          },
          {
            path: 'campaigns/:batchId',
            component: CampaignDetailComponent,
            title: 'Campaign | Clarix'
          },
          {
            path: 'calls',
            component: CallLogsComponent,
            title: 'Call Logs | Clarix'
          },
          {
            path: 'sheets',
            redirectTo: 'campaigns',
            pathMatch: 'full'
          },
          // Old "Templates" path kept as a redirect for existing bookmarks/links.
          {
            path: 'templates',
            redirectTo: '/workflows/build/agents',
            pathMatch: 'full'
          },
          {
            path: 'templates/:templateId/executions',
            component: WorkflowExecutionsComponent,
            title: 'Workflow Executions | Clarix',
            canActivate: [permissionGuard("workflows:executions:read")]
          },
          {
            path: 'templates/:templateId/executions/:executionId',
            component: WorkflowExecutionDetailComponent,
            title: 'Execution Details | Clarix'
          },
          // Build > Agents — same component/editor as before ("Templates"), reachable from the new nav.
          {
            path: 'build/agents',
            component: WorkflowTemplatesComponent,
            title: 'Agent setup | Clarix',
            canActivate: [permissionGuard("workflows:template:read")]
          },
          {
            path: 'build/data',
            component: DataHubComponent,
            title: 'Data | Clarix'
          },
          {
            path: 'build/orchestration',
            component: OrchestrationHubComponent,
            title: 'Orchestration | Clarix'
          },
          {
            path: 'reports',
            component: ExecutionReportsComponent,
            title: 'Execution Reports | Clarix'
          },
          {
            path: 'reports/new',
            component: ExecutionReportFormComponent,
            title: 'New Report | Clarix'
          },
          {
            path: 'reports/:id/edit',
            component: ExecutionReportFormComponent,
            title: 'Edit Report | Clarix'
          }
        ]
      },
      {
        path: 'admin/permissions',
        component: ManagePermissionsComponent,
        canActivate: [permissionGuard('manage-permissions:menuvisibility')],
        title: 'Manage Permissions | Clarix'
      },
      // Enrichments now live under Build > Data; kept as a redirect for existing bookmarks/links.
      {
        path: 'admin/data-functions',
        redirectTo: '/workflows/build/data',
        pathMatch: 'full'
      },
      // GenBI is no longer part of Clarix; old links land on the dashboard.
      { path: 'genbi', redirectTo: '/dashboard/overview', pathMatch: 'prefix' },
      {
        // Operators start in Run (CLX-064): the call centre dashboard is not the home page.
        path: '',
        redirectTo: '/workflows/campaigns',
        pathMatch: 'full'
      },
    ]
  },
  // Old or mistyped links land on Campaigns instead of a blank page (CLX-063).
  { path: '**', redirectTo: '/workflows/campaigns' }
];
