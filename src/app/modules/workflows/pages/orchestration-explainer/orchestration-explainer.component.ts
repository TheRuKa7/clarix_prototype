import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component } from '@angular/core';

interface BoundaryCard {
  who: 'Clarix' | 'Voice provider';
  when: string;
  items: string[];
}

const BOUNDARY: BoundaryCard[] = [
  {
    who: 'Clarix',
    when: 'Before the call',
    items: [
      'Group open lines by supplier',
      'Sort into priority bands',
      'Cut into calls of at most N lines',
      'Attach per-line context and a quantity cap',
    ],
  },
  {
    who: 'Voice provider',
    when: 'During the call',
    items: [
      'One persona, one media session',
      'Walks the agenda line by line',
      'Check-in and hard stop enforced locally',
      'Barge-in and noise handled at the edge',
    ],
  },
  {
    who: 'Clarix',
    when: 'After the call',
    items: [
      'Extract fields from the transcript',
      'Assign one of the 11 outcomes per line',
      'Reconcile quantities',
      'Write back and build the report',
    ],
  },
];

/** Build > Orchestration > Who does what — a static explainer, zero state, zero backend. */
@Component({
  selector: 'app-orchestration-explainer',
  imports: [CommonModule],
  templateUrl: './orchestration-explainer.component.html',
  styleUrl: './orchestration-explainer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OrchestrationExplainerComponent {
  protected readonly boundary = BOUNDARY;
}
