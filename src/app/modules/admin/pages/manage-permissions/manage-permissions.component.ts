import { CommonModule } from '@angular/common';
import { ConfirmDialogService } from '../../../../shared/ui/confirm-dialog/confirm-dialog.service';
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  FormBuilder,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { Subject } from 'rxjs';
import { debounceTime, finalize, takeUntil } from 'rxjs/operators';
import { HasPermissionDirective } from '../../../../core/permissions/directives/has-permission.directive';
import { PermissionsService } from '../../../../core/permissions/services/permissions.service';
import {
  ModuleEntity,
  ModuleRequest,
  Permission,
  PermissionRequest,
} from '../../models/permission.model';
import { ModuleApiService } from '../../services/module.service';
import { PermissionApiService } from '../../services/permission.service';

type Tab = 'permissions' | 'modules';

@Component({
  selector: 'app-manage-permissions',
  imports: [CommonModule, FormsModule, ReactiveFormsModule, LucideAngularModule, HasPermissionDirective],
  templateUrl: './manage-permissions.component.html',
  styleUrl: './manage-permissions.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ManagePermissionsComponent implements OnInit, OnDestroy {
  private readonly permissionsApi = inject(PermissionApiService);
  private readonly modulesApi = inject(ModuleApiService);
  private readonly permissionsService = inject(PermissionsService);
  private readonly fb = inject(FormBuilder);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly destroy$ = new Subject<void>();
  private readonly searchInput$ = new Subject<void>();

  protected readonly tab = signal<Tab>('permissions');

  // --- Permissions state ---
  protected readonly permissionsLoading = signal(false);
  protected readonly permissions = signal<Permission[]>([]);
  protected readonly permissionsTotal = signal(0);
  protected readonly permissionsPage = signal(0);
  protected readonly permissionsPageSize = signal(25);
  protected readonly permissionsTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.permissionsTotal() / this.permissionsPageSize()))
  );
  protected readonly permissionsRangeFrom = computed(() =>
    this.permissionsTotal() === 0 ? 0 : this.permissionsPage() * this.permissionsPageSize() + 1
  );
  protected readonly permissionsRangeTo = computed(() =>
    Math.min(this.permissionsTotal(), (this.permissionsPage() + 1) * this.permissionsPageSize())
  );
  protected readonly categories = signal<string[]>([]);
  protected permissionSearch = '';
  protected permissionCategory = '';

  protected readonly editingPermission = signal<Permission | null>(null);
  protected readonly showPermissionForm = signal(false);
  protected readonly permissionForm: FormGroup = this.fb.nonNullable.group({
    key: this.fb.nonNullable.control('', [
      Validators.required,
      Validators.pattern(/^[a-z0-9_-]+(?::[a-z0-9_-]+)+$/),
    ]),
    displayName: this.fb.nonNullable.control('', [Validators.required, Validators.maxLength(120)]),
    description: this.fb.nonNullable.control(''),
    category: this.fb.nonNullable.control('', [Validators.required]),
  });

  // --- Modules state ---
  protected readonly modulesLoading = signal(false);
  protected readonly modules = signal<ModuleEntity[]>([]);
  protected readonly modulesTotal = signal(0);
  protected moduleSearch = '';

  protected readonly editingModule = signal<ModuleEntity | null>(null);
  protected readonly showModuleForm = signal(false);
  protected readonly moduleForm: FormGroup = this.fb.nonNullable.group({
    name: this.fb.nonNullable.control('', [
      Validators.required,
      Validators.pattern(/^[A-Za-z0-9_-]+$/),
    ]),
    displayName: this.fb.nonNullable.control('', [Validators.required, Validators.maxLength(120)]),
    description: this.fb.nonNullable.control(''),
    permissions: this.fb.nonNullable.control<string[]>([]),
  });

  // Available permission keys (loaded once for the module-edit picker).
  protected readonly allPermissions = signal<Permission[]>([]);

  protected readonly errorMessage = signal<string | null>(null);
  protected readonly saving = signal(false);

  ngOnInit(): void {
    this.searchInput$
      .pipe(takeUntil(this.destroy$), debounceTime(300))
      .subscribe(() => {
        this.permissionsPage.set(0);
        this.tab() === 'permissions' ? this.loadPermissions() : this.loadModules();
      });

    this.loadPermissions();
    this.loadAllPermissions();
    this.loadCategories();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  switchTab(t: Tab): void {
    this.tab.set(t);
    this.errorMessage.set(null);
    if (t === 'modules' && this.modules().length === 0) this.loadModules();
  }

  onSearchChange(): void {
    this.searchInput$.next();
  }

  // ---------- Permissions ----------

  loadPermissions(): void {
    this.permissionsLoading.set(true);
    this.permissionsApi
      .list({
        page: this.permissionsPage(),
        size: this.permissionsPageSize(),
        search: this.permissionSearch,
        category: this.permissionCategory,
      })
      .pipe(takeUntil(this.destroy$), finalize(() => this.permissionsLoading.set(false)))
      .subscribe({
        next: ({ items, total }) => {
          this.permissions.set(items);
          this.permissionsTotal.set(total);
        },
        error: msg => this.errorMessage.set(String(msg)),
      });
  }

  private loadAllPermissions(): void {
    this.permissionsApi
      .list({ size: 500 })
      .pipe(takeUntil(this.destroy$))
      .subscribe({ next: ({ items }) => this.allPermissions.set(items) });
  }

  private loadCategories(): void {
    this.permissionsApi
      .listCategories()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: items => this.categories.set(items),
        error: () => this.categories.set([]),
      });
  }

  goToPermissionsPage(page: number): void {
    const max = this.permissionsTotalPages() - 1;
    const next = Math.max(0, Math.min(max, page));
    if (next === this.permissionsPage()) return;
    this.permissionsPage.set(next);
    this.loadPermissions();
  }

  changePermissionsPageSize(size: number): void {
    this.permissionsPageSize.set(size);
    this.permissionsPage.set(0);
    this.loadPermissions();
  }

  openCreatePermission(): void {
    this.editingPermission.set(null);
    this.permissionForm.reset({ key: '', displayName: '', description: '', category: '' });
    this.showPermissionForm.set(true);
    this.errorMessage.set(null);
  }

  openEditPermission(p: Permission): void {
    this.editingPermission.set(p);
    this.permissionForm.reset({
      key: p.key,
      displayName: p.displayName,
      description: p.description ?? '',
      category: p.category,
    });
    this.showPermissionForm.set(true);
    this.errorMessage.set(null);
  }

  closePermissionForm(): void {
    this.showPermissionForm.set(false);
    this.editingPermission.set(null);
  }

  savePermission(): void {
    if (this.permissionForm.invalid) {
      this.permissionForm.markAllAsTouched();
      return;
    }
    const payload = this.permissionForm.getRawValue() as PermissionRequest;
    const editing = this.editingPermission();
    this.saving.set(true);
    const obs = editing
      ? this.permissionsApi.update(editing.id, payload)
      : this.permissionsApi.create(payload);
    obs
      .pipe(takeUntil(this.destroy$), finalize(() => this.saving.set(false)))
      .subscribe({
        next: () => {
          this.closePermissionForm();
          this.loadPermissions();
          this.loadAllPermissions();
          this.loadCategories();
        },
        error: msg => this.errorMessage.set(String(msg)),
      });
  }

  async deletePermission(p: Permission): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Delete permission',
      message: `Delete permission "${p.key}"? This is only allowed if no module references it.`,
      confirmText: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    this.permissionsApi.delete(p.id).pipe(takeUntil(this.destroy$)).subscribe({
      next: () => {
        this.loadPermissions();
        this.loadAllPermissions();
        this.loadCategories();
      },
      error: msg => this.errorMessage.set(String(msg)),
    });
  }

  // ---------- Modules ----------

  loadModules(): void {
    this.modulesLoading.set(true);
    this.modulesApi
      .list({ size: 100, search: this.moduleSearch })
      .pipe(takeUntil(this.destroy$), finalize(() => this.modulesLoading.set(false)))
      .subscribe({
        next: ({ items, total }) => {
          this.modules.set(items);
          this.modulesTotal.set(total);
        },
        error: msg => this.errorMessage.set(String(msg)),
      });
  }

  openCreateModule(): void {
    this.editingModule.set(null);
    this.moduleForm.reset({ name: '', displayName: '', description: '', permissions: [] });
    this.showModuleForm.set(true);
    this.errorMessage.set(null);
  }

  openEditModule(m: ModuleEntity): void {
    this.editingModule.set(m);
    this.moduleForm.reset({
      name: m.name,
      displayName: m.displayName,
      description: m.description ?? '',
      permissions: [...(m.permissions ?? [])],
    });
    this.showModuleForm.set(true);
    this.errorMessage.set(null);
  }

  closeModuleForm(): void {
    this.showModuleForm.set(false);
    this.editingModule.set(null);
  }

  togglePermissionOnModule(key: string, checked: boolean): void {
    const control = this.moduleForm.get('permissions') as FormControl<string[]>;
    const current = new Set(control.value);
    if (checked) current.add(key); else current.delete(key);
    control.setValue(Array.from(current));
  }

  isPermissionOnModule(key: string): boolean {
    const list = (this.moduleForm.get('permissions') as FormControl<string[]>).value;
    return list.includes(key);
  }

  toggleAllPermissions(checked: boolean): void {
    const control = this.moduleForm.get('permissions') as FormControl<string[]>;
    control.setValue(checked ? this.allPermissions().map(p => p.key) : []);
  }

  toggleCategoryPermissions(category: string, checked: boolean): void {
    const control = this.moduleForm.get('permissions') as FormControl<string[]>;
    const current = new Set(control.value);
    const keysInCategory = this.allPermissions()
      .filter(p => p.category === category)
      .map(p => p.key);
    for (const k of keysInCategory) {
      if (checked) current.add(k); else current.delete(k);
    }
    control.setValue(Array.from(current));
  }

  selectionState(perms: Permission[]): 'all' | 'none' | 'some' {
    if (perms.length === 0) return 'none';
    const selected = (this.moduleForm.get('permissions') as FormControl<string[]>).value;
    const set = new Set(selected);
    let hit = 0;
    for (const p of perms) if (set.has(p.key)) hit++;
    if (hit === 0) return 'none';
    if (hit === perms.length) return 'all';
    return 'some';
  }

  selectedPermissionCount(): number {
    const value = (this.moduleForm.get('permissions') as FormControl<string[]>).value;
    return value?.length ?? 0;
  }

  saveModule(): void {
    if (this.moduleForm.invalid) {
      this.moduleForm.markAllAsTouched();
      return;
    }
    const payload = this.moduleForm.getRawValue() as ModuleRequest;
    const editing = this.editingModule();
    this.saving.set(true);
    const obs = editing
      ? this.modulesApi.update(editing.id, payload)
      : this.modulesApi.create(payload);
    obs
      .pipe(takeUntil(this.destroy$), finalize(() => this.saving.set(false)))
      .subscribe({
        next: () => {
          this.closeModuleForm();
          this.loadModules();
          this.permissionsService.refresh().subscribe();
        },
        error: msg => this.errorMessage.set(String(msg)),
      });
  }

  isModuleEnabled(m: ModuleEntity): boolean {
    return m.enabled !== false;
  }

  toggleModuleEnabled(m: ModuleEntity, enabled: boolean): void {
    const previous = this.modules();
    this.modules.set(previous.map(x => x.id === m.id ? { ...x, enabled } : x));
    this.modulesApi.setEnabled(m.id, enabled).pipe(takeUntil(this.destroy$)).subscribe({
      next: updated => {
        this.modules.set(this.modules().map(x => x.id === updated.id ? updated : x));
        this.permissionsService.refresh().subscribe();
      },
      error: msg => {
        this.modules.set(previous);
        this.errorMessage.set(String(msg));
      },
    });
  }

  async deleteModule(m: ModuleEntity): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Delete module',
      message: `Delete module "${m.name}"?`,
      confirmText: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    this.modulesApi.delete(m.id).pipe(takeUntil(this.destroy$)).subscribe({
      next: () => {
        this.loadModules();
        this.permissionsService.refresh().subscribe();
      },
      error: msg => this.errorMessage.set(String(msg)),
    });
  }

  permissionsByCategory(perms: Permission[]): Array<{ category: string; items: Permission[] }> {
    const map = new Map<string, Permission[]>();
    for (const p of perms) {
      if (!map.has(p.category)) map.set(p.category, []);
      map.get(p.category)!.push(p);
    }
    return Array.from(map.entries())
      .map(([category, items]) => ({ category, items: [...items].sort((a, b) => a.key.localeCompare(b.key)) }))
      .sort((a, b) => a.category.localeCompare(b.category));
  }

  formatDate(dateStr?: string): string {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  }
}
