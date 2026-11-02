import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { CALL_STATUSES, CAMPAIGN_STATUSES, GROUPS } from '../../utils/outcome';

/** "Statuses": campaign and call statuses, what each means and exactly how it is worked out (Echo decides; Clarix shows). */
@Component({
  selector: 'app-call-status-reference',
  imports: [LucideAngularModule],
  templateUrl: './call-status-reference.component.html',
  styleUrl: './call-status-reference.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'open.set(false)' },
})
export class CallStatusReferenceComponent {
  readonly label = input('Call statuses');
  readonly highlight = input('');
  protected readonly open = signal(false);
  protected readonly campaigns = CAMPAIGN_STATUSES;
  protected readonly groups = [GROUPS[3], GROUPS[0], GROUPS[1], GROUPS[2], GROUPS[4]];
  protected byGroup(g: string) { return CALL_STATUSES.filter((s) => s.group === g); }
}
