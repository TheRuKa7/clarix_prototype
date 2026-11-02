import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { ConfirmDialogService } from './confirm-dialog.service';

/**
 * Global confirmation dialog host. Mount once at the app root:
 *   <app-confirm-dialog />
 *
 * It renders whenever {@link ConfirmDialogService.ask} is called and resolves that call's promise
 * when the user picks an option. Escape or a backdrop click counts as cancel.
 */
@Component({
  selector: 'app-confirm-dialog',
  imports: [LucideAngularModule],
  templateUrl: './confirm-dialog.component.html',
  styleUrl: './confirm-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown.escape)': 'onEscape()',
  },
})
export class ConfirmDialogComponent {
  private readonly service = inject(ConfirmDialogService);
  protected readonly request = this.service.request;

  protected confirm(): void {
    this.service.resolve(true);
  }

  protected cancel(): void {
    this.service.resolve(false);
  }

  protected onEscape(): void {
    if (this.request()) this.service.resolve(false);
  }
}
