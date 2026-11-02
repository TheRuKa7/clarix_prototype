import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The Echo mark, shown wherever Clarix hands work to Echo, with the same motion as in Echo
 * (Echo Motion Kit): still, intro (draws once), loader (arcs pulse) and live (rings while calls run).
 */
@Component({
  selector: 'app-echo-mark',
  templateUrl: './echo-mark.component.html',
  styleUrl: './echo-mark.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': "'em em-' + mode() + (tile() ? '' : ' em-bare')",
    '[style.width.px]': 'size()',
    '[style.height.px]': 'size()',
    'aria-hidden': 'true',
  },
})
export class EchoMarkComponent {
  readonly size = input(32);
  readonly mode = input<'still' | 'intro' | 'loader' | 'live'>('still');
  readonly tile = input(true);
}
