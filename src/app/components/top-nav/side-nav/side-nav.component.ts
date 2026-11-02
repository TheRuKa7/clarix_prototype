import { ChangeDetectionStrategy, Component, computed, inject, model, resource, signal, effect } from '@angular/core';
import { RouterModule } from '@angular/router';
import { LucideAngularModule } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../../core/auth/services/auth.service';
import { MicrosoftGraphService } from '../../../core/auth/services/microsoft-graph.service';
import { PermissionsService } from '../../../core/permissions/services/permissions.service';
import { ThemeService } from '../../../services/theme.service';
import { NAV_GROUPS, NavItem } from '../app-modules';

/**
 * Side bar for every Clarix page. Closed it shows icons only; hover or keyboard
 * focus opens it over the page; the round handle halfway down pins it open
 * (the page moves over) or closes it at once. On phones it is a drawer.
 */
@Component({
  selector: 'app-side-nav',
  imports: [RouterModule, LucideAngularModule],
  templateUrl: './side-nav.component.html',
  styleUrl: './side-nav.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'closeAll()' },
})
export class SideNavComponent {
  protected readonly auth = inject(AuthService);
  private readonly permissions = inject(PermissionsService);
  private readonly graph = inject(MicrosoftGraphService);
  /** Pinned open; the layout moves the page over when true. */
  readonly pinned = model(false);
  /** Phone drawer, opened from the header menu button. */
  readonly drawer = model(false);
  protected readonly hovered = signal(false);
  private suppress = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  protected readonly open = computed(() => this.pinned() || this.hovered() || this.drawer());

  constructor() {
    // Phone drawer: focus the current page link when it opens, so keyboard and screen reader users land inside it.
    effect(() => {
      if (!this.drawer()) return;
      setTimeout(() => (document.querySelector<HTMLElement>('.sn.drawer .sn-link.active') || document.querySelector<HTMLElement>('.sn.drawer .sn-link'))?.focus(), 60);
    });
  }

  protected readonly groups = computed(() =>
    NAV_GROUPS.map((g) => ({ label: g.label, items: g.items.filter((i) => this.allowed(i)) })).filter((g) => g.items.length)
  );
  protected readonly avatar = resource({
    params: () => this.auth.authState().tokens?.microsoftToken ?? null,
    loader: ({ params: token }) => (token ? firstValueFrom(this.graph.getProfilePhotoUrl(token)) : Promise.resolve(null)),
  });
  protected readonly initials = computed(() =>
    (this.auth.getCurrentUser()?.name ?? '').split(' ').slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?'
  );

  private allowed(i: NavItem): boolean { return !i.requiresAnyPermission?.length || this.permissions.hasAny(...i.requiresAnyPermission); }
  protected hoverIn(): void {
    if (this.suppress || this.pinned()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.hovered.set(true), 90);
  }
  protected hoverOut(): void { clearTimeout(this.timer); this.hovered.set(false); this.suppress = false; }
  protected focusOut(e: FocusEvent): void { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) this.hoverOut(); }
  protected toggle(e: Event): void {
    e.stopPropagation();
    if (this.drawer()) { this.drawer.set(false); return; }
    if (this.open()) { this.pinned.set(false); this.hovered.set(false); this.suppress = true; } else { this.pinned.set(true); }
  }
  protected picked(): void { this.drawer.set(false); this.hovered.set(false); }
  protected closeAll(): void { this.drawer.set(false); this.hovered.set(false); }
  // Theme: same as system, light or dark; the theme service remembers the choice and sets the class on <html>.
  private readonly theme = inject(ThemeService);
  protected readonly themeIcon = computed(() => ({ system: 'monitor', light: 'sun', dark: 'moon' })[this.theme.colorScheme()]);
  protected readonly themeLabel = computed(() => ({ system: 'same as system', light: 'light', dark: 'dark' })[this.theme.colorScheme()]);
  protected cycleTheme(): void { this.theme.setColorScheme(({ system: 'light', light: 'dark', dark: 'system' } as const)[this.theme.colorScheme()]); }
  protected signOut(): void { this.auth.logout(); }
}
