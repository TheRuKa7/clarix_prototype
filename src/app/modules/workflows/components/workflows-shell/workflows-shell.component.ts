import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterModule } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { filter, map, startWith } from 'rxjs/operators';
import { ThemeService } from '../../../../services/theme.service';
import { WORKFLOW_NAV, WorkflowMode } from '../../models/workflow-nav.model';

@Component({
  selector: 'app-workflows-shell',
  imports: [CommonModule, RouterModule, LucideAngularModule],
  templateUrl: './workflows-shell.component.html',
  styleUrl: './workflows-shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowsShellComponent {
  protected readonly themeService = inject(ThemeService);
  private readonly router = inject(Router);

  /** Current URL as a signal, so mode/active-nav react to router navigation without a subscription. */
  protected readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url)
    ),
    { initialValue: this.router.url }
  );

  /**
   * Reports lives outside the `/workflows/build/**` path for now (it predates this redesign and
   * keeps its existing routes), but it's a Build-mode concern per its nav placement, so it's
   * special-cased here rather than moved.
   */
  protected readonly mode = computed<WorkflowMode>(() =>
    this.url().startsWith('/workflows/build') || this.url().startsWith('/workflows/reports')
      ? 'build'
      : 'run'
  );

  protected readonly navItems = computed(() => WORKFLOW_NAV[this.mode()]);

  protected readonly isDark = computed(() => this.themeService.colorScheme() === 'dark');

  /**
   * Switches mode by opening that mode's first page the user is allowed into. The old
   * version always opened the first page, so a user without access to it saw the
   * switch do nothing.
   */
  async setMode(mode: WorkflowMode): Promise<void> {
    if (mode === this.mode()) return;
    for (const item of WORKFLOW_NAV[mode]) {
      if (await this.router.navigateByUrl(item.route)) return;
    }
  }

  toggleTheme(): void {
    this.themeService.setColorScheme(this.isDark() ? 'light' : 'dark');
  }

  isActive(route: string): boolean {
    const current = this.url().split('?')[0];
    return current === route || current.startsWith(route + '/');
  }
}
