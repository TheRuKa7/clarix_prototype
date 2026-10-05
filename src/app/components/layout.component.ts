import { Component, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { filter, map, startWith } from 'rxjs/operators';
import { ThemeService } from '../services/theme.service';
import { ToastContainerComponent } from '../core/notifications/toast-container/toast-container.component';
import { SideNavComponent } from './top-nav/side-nav/side-nav.component';
import { navFor } from './top-nav/app-modules';
import { installDialogKeys } from '../core/a11y/dialog-keys';

const PIN_KEY = 'clarix.sidebar.pinned';

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive, LucideAngularModule, ToastContainerComponent, SideNavComponent],
  templateUrl: './layout.component.html',
  styleUrl: './layout.component.scss'
})
export class LayoutComponent {
  protected readonly themeService = inject(ThemeService);
  private readonly router = inject(Router);
  private readonly url = toSignal(
    this.router.events.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd), map((e) => e.urlAfterRedirects), startWith(this.router.url)),
    { initialValue: this.router.url }
  );
  /** Side bar pinned open (remembered) and the phone drawer. */
  protected readonly pinned = signal(this.readPin());
  protected readonly drawer = signal(false);
  protected readonly here = computed(() => navFor(this.url()));
  protected readonly tabs = computed(() => this.here()?.tabs ?? []);
  protected readonly isDark = computed(() => this.themeService.colorScheme() === 'dark');

  constructor() {
    effect(() => { try { localStorage.setItem(PIN_KEY, this.pinned() ? '1' : '0'); } catch { /* private mode */ } });
    // Every dialog: focus moves in and stays, Esc closes, focus returns.
    installDialogKeys('[role="dialog"]', '[class*="backdrop"], [class*="overlay"]');
  }
  protected toggleTheme(): void { this.themeService.setColorScheme(this.isDark() ? 'light' : 'dark'); }
  private readPin(): boolean { try { return localStorage.getItem(PIN_KEY) === '1'; } catch { return false; } }
}
