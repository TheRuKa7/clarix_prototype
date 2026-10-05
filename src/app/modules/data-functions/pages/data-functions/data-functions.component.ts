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
  FormArray,
  FormBuilder,
  FormGroup,
  FormsModule,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { Subject } from 'rxjs';
import { debounceTime, finalize, takeUntil } from 'rxjs/operators';
import {
  DataFunction,
  DataFunctionRequest,
  DataFunctionTestResult,
  DataFunctionType,
  FIELD_DATA_TYPES,
  FieldDataType,
  HTTP_METHODS,
} from '../../models/data-function.model';
import { DataFunctionService } from '../../services/data-function.service';

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

@Component({
  selector: 'app-data-functions',
  imports: [CommonModule, FormsModule, ReactiveFormsModule, LucideAngularModule],
  templateUrl: './data-functions.component.html',
  styleUrl: './data-functions.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DataFunctionsComponent implements OnInit, OnDestroy {
  private readonly api = inject(DataFunctionService);
  private readonly fb = inject(FormBuilder);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly destroy$ = new Subject<void>();
  private readonly searchInput$ = new Subject<void>();

  protected readonly dataTypes = FIELD_DATA_TYPES;
  protected readonly httpMethods = HTTP_METHODS;

  // ---- Listing state ----
  protected readonly loading = signal(false);
  protected readonly functions = signal<DataFunction[]>([]);
  protected readonly total = signal(0);
  protected search = '';

  // ---- Form state ----
  protected readonly showForm = signal(false);
  protected readonly editing = signal<DataFunction | null>(null);
  protected readonly saving = signal(false);
  protected readonly errorMessage = signal<string | null>(null);

  protected readonly form: FormGroup = this.fb.nonNullable.group({
    name: this.fb.nonNullable.control('', [
      Validators.required,
      Validators.pattern(/^[A-Za-z0-9_-]+$/),
    ]),
    description: this.fb.nonNullable.control(''),
    enabled: this.fb.nonNullable.control(true),
    type: this.fb.nonNullable.control<DataFunctionType>('SQL'),
    parameters: this.fb.array([]),
    outputs: this.fb.array([]),
    sqlQuery: this.fb.nonNullable.control(''),
    restMethod: this.fb.nonNullable.control('GET'),
    restUrl: this.fb.nonNullable.control(''),
    restBody: this.fb.nonNullable.control(''),
    restHeaders: this.fb.array([]),
    restQueryParams: this.fb.array([]),
  });

  protected readonly currentType = signal<DataFunctionType>('SQL');

  // ---- Validation + smart param detection ----
  /** True once the user has attempted a save; gates the error summary so a fresh form isn't noisy. */
  protected readonly submitted = signal(false);
  /** Param names referenced by the SQL (:name) / REST ({name}) config. Recomputed on form changes. */
  protected readonly referencedParams = signal<string[]>([]);
  /** Declared input param names. Recomputed on form changes. */
  protected readonly declaredInputNames = signal<string[]>([]);

  /** Referenced in the query/request but not declared as inputs. */
  protected readonly missingParams = computed<string[]>(() => {
    const declared = new Set(this.declaredInputNames());
    return this.referencedParams().filter(p => !declared.has(p));
  });
  /** Declared as inputs but never referenced. */
  protected readonly unusedParams = computed<string[]>(() => {
    const referenced = new Set(this.referencedParams());
    return this.declaredInputNames().filter(p => p && !referenced.has(p));
  });

  /** Human-readable validation problems; empty means the form can be saved. */
  protected readonly validationErrors = signal<string[]>([]);
  protected readonly canSave = computed(() => this.validationErrors().length === 0);

  // ---- Dry-run state ----
  protected readonly testForm: FormGroup = this.fb.group({ inputs: this.fb.array([]) });
  protected readonly testing = signal(false);
  protected readonly testResult = signal<DataFunctionTestResult | null>(null);

  ngOnInit(): void {
    this.searchInput$
      .pipe(takeUntil(this.destroy$), debounceTime(300))
      .subscribe(() => this.load());

    this.form.get('type')!.valueChanges
      .pipe(takeUntil(this.destroy$))
      .subscribe(t => this.currentType.set(t as DataFunctionType));

    // Re-derive param detection + validation on any form change.
    this.form.valueChanges
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.recomputeDerived());

    this.load();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ---- FormArray accessors ----
  get parameters(): FormArray { return this.form.get('parameters') as FormArray; }
  get outputs(): FormArray { return this.form.get('outputs') as FormArray; }
  get restHeaders(): FormArray { return this.form.get('restHeaders') as FormArray; }
  get restQueryParams(): FormArray { return this.form.get('restQueryParams') as FormArray; }
  get testInputs(): FormArray { return this.testForm.get('inputs') as FormArray; }

  protected paramGroup(p?: { name?: string; dataType?: FieldDataType; required?: boolean; description?: string }): FormGroup {
    return this.fb.nonNullable.group({
      name: this.fb.nonNullable.control(p?.name ?? '', [Validators.required]),
      dataType: this.fb.nonNullable.control<FieldDataType>(p?.dataType ?? 'STRING'),
      required: this.fb.nonNullable.control(p?.required ?? true),
      description: this.fb.nonNullable.control(p?.description ?? ''),
    });
  }

  protected outputGroup(o?: { name?: string; dataType?: FieldDataType; sourceColumn?: string; jsonPath?: string }): FormGroup {
    return this.fb.nonNullable.group({
      name: this.fb.nonNullable.control(o?.name ?? '', [Validators.required]),
      dataType: this.fb.nonNullable.control<FieldDataType>(o?.dataType ?? 'STRING'),
      sourceColumn: this.fb.nonNullable.control(o?.sourceColumn ?? ''),
      jsonPath: this.fb.nonNullable.control(o?.jsonPath ?? ''),
    });
  }

  protected kvGroup(key = '', value = ''): FormGroup {
    return this.fb.nonNullable.group({
      key: this.fb.nonNullable.control(key),
      value: this.fb.nonNullable.control(value),
    });
  }

  addParam(): void { this.parameters.push(this.paramGroup()); }
  removeParam(i: number): void { this.parameters.removeAt(i); }
  addOutput(): void { this.outputs.push(this.outputGroup()); }
  removeOutput(i: number): void { this.outputs.removeAt(i); }
  addHeader(): void { this.restHeaders.push(this.kvGroup()); }
  removeHeader(i: number): void { this.restHeaders.removeAt(i); }
  addQueryParam(): void { this.restQueryParams.push(this.kvGroup()); }
  removeQueryParam(i: number): void { this.restQueryParams.removeAt(i); }

  /** Add a single detected-but-undeclared param as an input. */
  addMissingParam(name: string): void {
    this.parameters.push(this.paramGroup({ name }));
  }

  /** Declare every detected-but-undeclared param at once. */
  addAllMissingParams(): void {
    for (const name of this.missingParams()) this.parameters.push(this.paramGroup({ name }));
  }

  // ---- Smart detection + validation (recomputed on every form change) ----
  private recomputeDerived(): void {
    const type = this.form.get('type')!.value as DataFunctionType;

    const declared = (this.parameters.getRawValue() as Array<{ name: string }>)
      .map(p => (p.name ?? '').trim()).filter(Boolean);
    this.declaredInputNames.set(unique(declared));

    let referenced: string[];
    if (type === 'SQL') {
      referenced = this.extractColonParams(this.form.get('sqlQuery')!.value);
    } else {
      const texts: string[] = [
        this.form.get('restUrl')!.value,
        this.form.get('restBody')!.value,
        ...(this.restHeaders.getRawValue() as Array<{ value: string }>).map(h => h.value),
        ...(this.restQueryParams.getRawValue() as Array<{ value: string }>).map(q => q.value),
      ];
      referenced = this.extractBraceParams(texts.join('\n'));
    }
    this.referencedParams.set(unique(referenced));

    this.validationErrors.set(this.computeValidationErrors());
  }

  private extractColonParams(sql: string | null): string[] {
    if (!sql) return [];
    const out: string[] = [];
    const re = /:([A-Za-z_][A-Za-z0-9_]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) out.push(m[1]);
    return out;
  }

  private extractBraceParams(text: string | null): string[] {
    if (!text) return [];
    const out: string[] = [];
    const re = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    return out;
  }

  private computeValidationErrors(): string[] {
    const errors: string[] = [];
    const v = this.form.getRawValue();

    if (!v.name?.trim()) errors.push('Name is required');
    else if (!/^[A-Za-z0-9_-]+$/.test(v.name)) errors.push('Name may only contain letters, numbers, _ and -');

    const params = v.parameters as Array<{ name: string }>;
    if (params.length === 0) errors.push('Add at least one input parameter');
    params.forEach((p, i) => { if (!p.name?.trim()) errors.push(`Input #${i + 1} needs a name`); });
    this.duplicates(params.map(p => p.name)).forEach(d => errors.push(`Duplicate input name: ${d}`));

    const outputs = v.outputs as Array<{ name: string; jsonPath: string }>;
    if (outputs.length === 0) errors.push('Add at least one output value');
    outputs.forEach((o, i) => { if (!o.name?.trim()) errors.push(`Output #${i + 1} needs a name`); });
    this.duplicates(outputs.map(o => o.name)).forEach(d => errors.push(`Duplicate output name: ${d}`));

    if (v.type === 'SQL') {
      if (!v.sqlQuery?.trim()) errors.push('SQL query is required');
    } else {
      if (!v.restUrl?.trim()) errors.push('REST URL is required');
      outputs.forEach((o, i) => { if (!o.jsonPath?.trim()) errors.push(`Output #${i + 1} needs a JSON path`); });
    }
    return errors;
  }

  private duplicates(names: string[]): string[] {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const raw of names) {
      const n = (raw ?? '').trim();
      if (!n) continue;
      if (seen.has(n)) dupes.add(n);
      seen.add(n);
    }
    return Array.from(dupes);
  }

  // ---- Listing ----
  load(): void {
    this.loading.set(true);
    this.api
      .list({ size: 100, search: this.search })
      .pipe(takeUntil(this.destroy$), finalize(() => this.loading.set(false)))
      .subscribe({
        next: ({ items, total }) => { this.functions.set(items); this.total.set(total); },
        error: msg => this.errorMessage.set(String(msg)),
      });
  }

  onSearchChange(): void { this.searchInput$.next(); }

  // ---- Create / edit ----
  openCreate(): void {
    this.editing.set(null);
    this.resetForm();
    this.form.patchValue({ name: '', description: '', enabled: true, type: 'SQL', sqlQuery: '', restMethod: 'GET', restUrl: '', restBody: '' });
    this.addParam();
    this.addOutput();
    this.currentType.set('SQL');
    this.submitted.set(false);
    this.errorMessage.set(null);
    this.testResult.set(null);
    this.recomputeDerived();
    this.showForm.set(true);
  }

  openEdit(fn: DataFunction): void {
    this.editing.set(fn);
    this.resetForm();
    this.form.patchValue({
      name: fn.name,
      description: fn.description ?? '',
      enabled: fn.enabled,
      type: fn.type,
      sqlQuery: fn.sqlConfig?.query ?? '',
      restMethod: fn.restConfig?.method ?? 'GET',
      restUrl: fn.restConfig?.url ?? '',
      restBody: fn.restConfig?.bodyTemplate ?? '',
    });
    (fn.parameters ?? []).forEach(p => this.parameters.push(this.paramGroup(p)));
    (fn.outputs ?? []).forEach(o => this.outputs.push(this.outputGroup(o)));
    Object.entries(fn.restConfig?.headers ?? {}).forEach(([k, v]) => this.restHeaders.push(this.kvGroup(k, v)));
    Object.entries(fn.restConfig?.queryParams ?? {}).forEach(([k, v]) => this.restQueryParams.push(this.kvGroup(k, v)));
    this.currentType.set(fn.type);
    this.submitted.set(false);
    this.errorMessage.set(null);
    this.testResult.set(null);
    this.rebuildTestInputs();
    this.recomputeDerived();
    this.showForm.set(true);
  }

  closeForm(): void {
    this.showForm.set(false);
    this.editing.set(null);
  }

  private resetForm(): void {
    this.parameters.clear();
    this.outputs.clear();
    this.restHeaders.clear();
    this.restQueryParams.clear();
    this.testInputs.clear();
    this.form.reset({ name: '', description: '', enabled: true, type: 'SQL', sqlQuery: '', restMethod: 'GET', restUrl: '', restBody: '' });
  }

  private buildRequest(): DataFunctionRequest {
    const v = this.form.getRawValue();
    const req: DataFunctionRequest = {
      name: v.name,
      description: v.description || undefined,
      enabled: v.enabled,
      type: v.type,
      parameters: (v.parameters as any[]).map(p => ({
        name: p.name, dataType: p.dataType, required: p.required, description: p.description || undefined,
      })),
      outputs: (v.outputs as any[]).map(o => ({
        name: o.name,
        dataType: o.dataType,
        sourceColumn: v.type === 'SQL' ? (o.sourceColumn || undefined) : undefined,
        jsonPath: v.type === 'REST' ? (o.jsonPath || undefined) : undefined,
      })),
    };
    if (v.type === 'SQL') {
      req.sqlConfig = { query: v.sqlQuery };
    } else {
      req.restConfig = {
        method: v.restMethod,
        url: v.restUrl,
        headers: this.kvToRecord(v.restHeaders),
        queryParams: this.kvToRecord(v.restQueryParams),
        bodyTemplate: v.restBody || undefined,
      };
    }
    return req;
  }

  private kvToRecord(rows: { key: string; value: string }[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of rows) {
      if (r.key?.trim()) out[r.key.trim()] = r.value ?? '';
    }
    return out;
  }

  save(): void {
    this.submitted.set(true);
    this.recomputeDerived();
    if (!this.canSave()) {
      this.form.markAllAsTouched();
      this.errorMessage.set('Please fix the highlighted fields below.');
      return;
    }
    const payload = this.buildRequest();
    const editing = this.editing();
    this.saving.set(true);
    this.errorMessage.set(null);
    const obs = editing ? this.api.update(editing.id, payload) : this.api.create(payload);
    obs.pipe(takeUntil(this.destroy$), finalize(() => this.saving.set(false)))
      .subscribe({
        next: saved => {
          this.editing.set(saved);
          this.rebuildTestInputs();
          this.load();
          if (!editing) {
            // Keep the form open after first save so the author can dry-run it.
            this.errorMessage.set(null);
          }
        },
        error: msg => this.errorMessage.set(String(msg)),
      });
  }

  toggleEnabled(fn: DataFunction, enabled: boolean): void {
    const previous = this.functions();
    this.functions.set(previous.map(x => x.id === fn.id ? { ...x, enabled } : x));
    this.api.setEnabled(fn.id, enabled).pipe(takeUntil(this.destroy$)).subscribe({
      next: updated => this.functions.set(this.functions().map(x => x.id === updated.id ? updated : x)),
      error: msg => { this.functions.set(previous); this.errorMessage.set(String(msg)); },
    });
  }

  async remove(fn: DataFunction): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Delete data function',
      message: `Delete data function "${fn.name}"?`,
      confirmText: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    this.api.delete(fn.id).pipe(takeUntil(this.destroy$)).subscribe({
      next: () => this.load(),
      error: msg => this.errorMessage.set(String(msg)),
    });
  }

  // ---- Dry-run ----
  protected readonly canTest = computed(() => this.editing() !== null);

  rebuildTestInputs(): void {
    this.testInputs.clear();
    for (const ctrl of this.parameters.controls) {
      const name = ctrl.get('name')!.value as string;
      this.testInputs.push(this.fb.nonNullable.group({
        name: this.fb.nonNullable.control(name),
        value: this.fb.nonNullable.control(''),
      }));
    }
  }

  runTest(): void {
    const fn = this.editing();
    if (!fn) return;
    const inputs: Record<string, unknown> = {};
    for (const row of this.testInputs.getRawValue() as { name: string; value: string }[]) {
      if (row.name) inputs[row.name] = row.value;
    }
    this.testing.set(true);
    this.testResult.set(null);
    this.api.test(fn.id, inputs)
      .pipe(takeUntil(this.destroy$), finalize(() => this.testing.set(false)))
      .subscribe({
        next: r => this.testResult.set(r),
        error: msg => this.testResult.set({ success: false, message: String(msg), durationMs: 0 }),
      });
  }

  prettyJson(value: unknown): string {
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }

  formatDate(dateStr?: string): string {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
}
