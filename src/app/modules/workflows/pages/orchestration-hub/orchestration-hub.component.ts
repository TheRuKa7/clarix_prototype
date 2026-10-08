import { ChangeDetectionStrategy, Component } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { OrchestrationLanesComponent } from '../orchestration-lanes/orchestration-lanes.component';

/**
 * Build > Orchestration. One upload, split by rules into routes, each sending its rows to one agent.
 * One page: the routes and their result on a real file. How rows become calls (grouping, rows per call)
 * is each agent's own plan in Echo, shown read only on its route, so there is no call agenda to set here.
 */
@Component({
  selector: 'app-orchestration-hub',
  imports: [LucideAngularModule, OrchestrationLanesComponent],
  templateUrl: './orchestration-hub.component.html',
  styleUrl: './orchestration-hub.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrchestrationHubComponent {}
