import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { OrchestrationLanesComponent } from '../orchestration-lanes/orchestration-lanes.component';
import { CallAgendaSettingsComponent } from '../call-agenda-settings/call-agenda-settings.component';
import { OrchestrationExplainerComponent } from '../orchestration-explainer/orchestration-explainer.component';

type OrchestrationTab = 'lanes' | 'agenda' | 'boundary';

/**
 * Build > Orchestration — one large upload, split by rules into lanes, each feeding a different
 * agent. Config-only in this phase: none of these three tabs are wired into live CSV ingest yet.
 */
@Component({
  selector: 'app-orchestration-hub',
  imports: [CommonModule, OrchestrationLanesComponent, CallAgendaSettingsComponent, OrchestrationExplainerComponent],
  templateUrl: './orchestration-hub.component.html',
  styleUrl: './orchestration-hub.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrchestrationHubComponent {
  protected readonly activeTab = signal<OrchestrationTab>('lanes');

  setTab(tab: OrchestrationTab): void {
    this.activeTab.set(tab);
  }
}
