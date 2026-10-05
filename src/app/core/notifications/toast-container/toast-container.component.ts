import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';
import { ToastService } from '../toast.service';

@Component({
  selector: 'app-toast-container',
  imports: [LucideAngularModule],
  templateUrl: './toast-container.component.html',
  styleUrl: './toast-container.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToastContainerComponent {
  protected readonly toastService = inject(ToastService);

  protected iconFor(type: 'success' | 'error' | 'info' | 'warning'): string {
    switch (type) {
      case 'success': return 'check-circle';
      case 'error':   return 'alert-circle';
      case 'warning': return 'alert-triangle';
      default:        return 'info';
    }
  }
}
