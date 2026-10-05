import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
  input,
  output,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  effect,
} from '@angular/core';
import {
  FormBuilder,
  FormArray,
  FormGroup,
  Validators,
  ReactiveFormsModule,
} from '@angular/forms';
import { CommonModule } from '@angular/common';
import { DragDropModule, CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import { LucideAngularModule } from 'lucide-angular';
import { Subject, timeout } from 'rxjs';
import { takeUntil, finalize } from 'rxjs/operators';
import { WorkflowTemplateService } from '../services/workflow-template.service';
import { CallProviderService } from '../services/call-provider.service';
import {
  WorkflowTemplate,
  WorkflowTemplateRequest,
  WorkflowStep,
  StepAction,
  StepCondition,
  ChannelType,
  SUPPORTED_CHANNELS,
  FieldDataType,
  ActionType,
  ConditionOperator,
  ContextMapping,
  ReportFieldMapping,
  ReportColumnSelection,
  REPORT_CONTACT_KEYS,
  REPORT_EXECUTION_DETAIL_KEYS,
  ReportContactKey,
  ReportExecutionDetailKey,
  EnrichmentBinding,
  CallProvider,
  CALL_PROVIDER_DISPLAY_NAMES,
  AgentSchema,
  AgentFieldSpec,
} from '../models/workflow-template.model';
import { resolveTriggerInputs, ContactKey, CONTACT_PREFIX } from '../utils/trigger-inputs';
import { DataFunction, DataFunctionOutput } from '../../data-functions/models/data-function.model';
import { DataFunctionService } from '../../data-functions/services/data-function.service';

const SPECIAL_STEP_IDS = ['COMPLETE', 'FAIL', 'ESCALATE'] as const;

/** A report column in the drag-to-order list: stable id, display header, and its source section. */
interface ReportColumnRef {
  id: string;
  label: string;
  section: string;
}

@Component({
  selector: 'app-workflow-template-form',
  imports: [CommonModule, ReactiveFormsModule, LucideAngularModule, DragDropModule],
  templateUrl: './workflow-template-form.component.html',
  styleUrl: './workflow-template-form.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowTemplateFormComponent implements OnInit, OnDestroy {
  private readonly fb = inject(FormBuilder);
  private readonly templateService = inject(WorkflowTemplateService);
  private readonly dataFunctionService = inject(DataFunctionService);
  private readonly callProviderService = inject(CallProviderService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly destroy$ = new Subject<void>();

  /** Catalog of data functions available for enrichment bindings. */
  protected readonly dataFunctions = signal<DataFunction[]>([]);

  /** Call providers configured on the backend (see clarix.call-providers) — feeds the dropdown. */
  protected readonly callProviders = signal<CallProvider[]>([]);

  readonly template = input<WorkflowTemplate | null>(null);
  readonly saved = output<void>();
  readonly cancelled = output<void>();

  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly activeTab = signal<'basic' | 'input' | 'report'>('basic');

  /** The locally-stored schema of the Exchange agent this template is routed to, if any. */
  protected readonly agentSchema = signal<AgentSchema | null>(null);
  protected readonly agentSchemaLoading = signal(false);
  /** One line on how this setup compares with the Echo agent after the last sync. */
  protected readonly syncSummary = signal('');

  readonly ChannelType = ChannelType;
  readonly FieldDataType = FieldDataType;
  readonly ActionType = ActionType;
  readonly ConditionOperator = ConditionOperator;

  /** Step actions may still target any channel (a TRIGGER_WHATSAPP step needs WhatsApp). */
  readonly channelOptions = Object.values(ChannelType);
  readonly fieldDataTypeOptions = Object.values(FieldDataType);

  /** Only live channels are offered as a workflow's default. */
  protected readonly defaultChannelOptions: ChannelType[] = [...SUPPORTED_CHANNELS];
  readonly actionTypeOptions = Object.values(ActionType);
  readonly conditionOperatorOptions = Object.values(ConditionOperator);
  readonly specialStepIds = SPECIAL_STEP_IDS;
  readonly providerLanguageOptions = ['hindi', 'english', 'hinglish'];
  readonly providerVoiceOptions = ['Ferris', 'Aria', 'Nova', 'Echo'];

  /* ─── Customize Report column selection ─── */

  readonly contactColumnOptions: ReadonlyArray<{ key: ReportContactKey; label: string }> = [
    { key: 'name', label: 'Contact Name' },
    { key: 'phone', label: 'Contact Phone' },
    { key: 'email', label: 'Contact Email' },
  ];

  readonly executionDetailColumnOptions: ReadonlyArray<{ key: ReportExecutionDetailKey; label: string }> = [
    { key: 'executionId', label: 'Execution Id' },
    { key: 'name', label: 'Name' },
    { key: 'status', label: 'Status' },
    { key: 'channel', label: 'Channel' },
    { key: 'createdAt', label: 'Created At' },
    { key: 'completedAt', label: 'Completed At' },
    { key: 'callDuration', label: 'Call Duration (s)' },
    { key: 'sentiment', label: 'Sentiment' },
    { key: 'summary', label: 'Summary' },
  ];

  // Selection signals. Treated as authoritative inside the form; null = "not yet
  // customized" so the report should include every column in that section.
  private readonly selectedContact = signal<Set<ReportContactKey> | null>(null);
  private readonly selectedExecutionDetails = signal<Set<ReportExecutionDetailKey> | null>(null);
  private readonly selectedContextParams = signal<Set<string> | null>(null);
  private readonly selectedEnrichmentInputs = signal<Set<string> | null>(null);
  private readonly selectedExecutionOutcome = signal<Set<string> | null>(null);

  // Cross-section column ordering (namespaced ids). null = default order.
  private readonly manualColumnOrder = signal<string[] | null>(null);

  // Custom CSV header per column id (overrides the default header). Empty map = no overrides.
  private readonly columnHeaderOverrides = signal<Map<string, string>>(new Map());

  // Bumped on any form change so the report-column computeds (which read from the
  // context/required-field/enrichment/report-field FormArrays) stay live.
  private readonly reportInputsRevision = signal(0);

  form!: FormGroup;

  private readonly populateEffect = effect(() => {
    const t = this.template();
    if (t && this.form) {
      this.populateForm(t);
    }
  });

  ngOnInit(): void {
    this.buildForm();
    // Keep report-column computeds live as context params / required fields / enrichments /
    // report fields are added, removed, or renamed.
    this.form.valueChanges
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.reportInputsRevision.update((v) => v + 1));
    this.loadDataFunctions();
    this.loadCallProviders();
    const t = this.template();
    if (t) {
      this.populateForm(t);
    }
  }

  private loadDataFunctions(): void {
    this.dataFunctionService
      .list({ size: 200 })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        // Degrade gracefully: a workflow editor without data-functions:read still
        // sees the section, just with an empty catalog.
        next: ({ items }) => this.dataFunctions.set(items),
        error: () => this.dataFunctions.set([]),
      });
  }

  private loadCallProviders(): void {
    this.callProviderService
      .list()
      .pipe(takeUntil(this.destroy$))
      .subscribe((providers) => this.callProviders.set(providers));
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private buildForm(): void {
    this.form = this.fb.group({
      templateKey: ['', [Validators.required, Validators.pattern(/^[A-Z0-9_]+$/)]],
      name: ['', Validators.required],
      description: [''],
      defaultChannelType: [ChannelType.CALL, Validators.required],
      callProviderKey: [''],
      providerAgentId: ['', Validators.required],
      providerAgentSpec: this.fb.group({
        voice: [''],
        language: [''],
        direction: [''],
        model: [''],
        callingWindow: [''],
        endpoint: [''],
        lastPublishedAt: [''],
      }),
      triggerEventTypesRaw: ['', Validators.required],
      maxRetries: [3, [Validators.required, Validators.min(0), Validators.max(10)]],
      retryDelayMinutes: [30, [Validators.required, Validators.min(1)]],
      requiredFields: this.fb.array([]),
      contextMappings: this.fb.array([]),
      agentFieldBindings: this.fb.array([]),
      enrichments: this.fb.array([]),
      reportFields: this.fb.array([]),
      steps: this.fb.array([]),
      contactPhone: [''],
      contactEmail: [''],
      contactName: [''],
    });
  }

  private populateForm(t: WorkflowTemplate): void {
    this.form.patchValue({
      templateKey: t.templateKey,
      name: t.name,
      description: t.description ?? '',
      defaultChannelType: t.defaultChannelType,
      callProviderKey: t.callProviderKey ?? '',
      providerAgentId: t.providerAgentId ?? '',
      providerAgentSpec: {
        voice: t.providerAgentSpec?.voice ?? '',
        language: t.providerAgentSpec?.language ?? '',
        direction: t.providerAgentSpec?.direction ?? '',
        model: t.providerAgentSpec?.model ?? '',
        callingWindow: t.providerAgentSpec?.callingWindow ?? '',
        endpoint: t.providerAgentSpec?.endpoint ?? '',
        lastPublishedAt: t.providerAgentSpec?.lastPublishedAt ?? '',
      },
      triggerEventTypesRaw: t.triggerEventTypes.join(', '),
      maxRetries: t.maxRetries,
      retryDelayMinutes: t.retryDelayMinutes,
      contactPhone: t.contactExtractionConfig?.phoneJsonPath ?? '',
      contactEmail: t.contactExtractionConfig?.emailJsonPath ?? '',
      contactName: t.contactExtractionConfig?.nameJsonPath ?? '',
    });

    this.requiredFields.clear();
    (t.requiredFields ?? []).forEach((f) => this.addRequiredField(f));

    this.contextMappings.clear();
    (t.contextMappings ?? []).forEach((m) => this.addContextMapping(m));

    this.agentBindings.clear();
    Object.entries(t.agentFieldBindings ?? {}).forEach(([field, source]) =>
      this.addAgentBinding(field, source)
    );
    this.agentSchema.set(null);
    if (t.callProviderKey === 'exchange' && t.id) {
      this.loadAgentSchema(t.id);
    }

    this.enrichments.clear();
    (t.enrichments ?? []).forEach((e) => this.addEnrichment(e));

    this.reportFields.clear();
    this.pendingReportRemovals.set(new Set());
    (t.reportFields ?? []).forEach((m) => this.addReportField(m, true));

    this.hydrateReportColumns(t.reportColumns);

    this.steps.clear();
    (t.steps ?? []).forEach((s) => this.addStep(s));
  }

  /* ─── Required Fields FormArray ─── */

  get requiredFields(): FormArray {
    return this.form.get('requiredFields') as FormArray;
  }

  addRequiredField(value?: Partial<WorkflowTemplate['requiredFields'][0]>): void {
    this.requiredFields.push(
      this.fb.group({
        fieldKey: [value?.fieldKey ?? '', Validators.required],
        fieldLabel: [value?.fieldLabel ?? '', Validators.required],
        dataType: [value?.dataType ?? FieldDataType.STRING, Validators.required],
        required: [value?.required ?? true],
        showOnDashboard: [value?.showOnDashboard ?? true],
        extractionHint: [value?.extractionHint ?? ''],
      })
    );
  }

  removeRequiredField(index: number): void {
    this.requiredFields.removeAt(index);
  }

  /* ─── Context Mappings FormArray ─── */

  get contextMappings(): FormArray {
    return this.form.get('contextMappings') as FormArray;
  }

  addContextMapping(value?: Partial<ContextMapping>): void {
    this.contextMappings.push(
      this.fb.group({
        fieldName: [value?.fieldName ?? '', Validators.required],
        jsonPath: [value?.jsonPath ?? '', Validators.required],
        required: [value?.required ?? false],
        dataType: [value?.dataType ?? FieldDataType.STRING, Validators.required],
      })
    );
  }

  removeContextMapping(index: number): void {
    this.contextMappings.removeAt(index);
  }

  /* ─── Exchange: agent-derived Input Fields / Agent Fields ─── */

  /**
   * True once the admin has picked Exchange as this template's call provider — gates the
   * "Input Fields"/"Agent Fields" tabs (Exchange-only) vs. the plain "Required Fields" tab
   * (Voxera, and any future provider with no agent-field concept).
   */
  protected readonly isExchangeTemplate = computed(() => {
    this.reportInputsRevision(); // form.valueChanges already bumps this, including callProviderKey
    return this.form?.get('callProviderKey')?.value === 'exchange';
  });

  /** "TEMPLATE_KEY · Provider Display Name" — mirrors the header subtitle in the design. */
  protected readonly headerSubtitle = computed(() => {
    this.reportInputsRevision();
    const key = String(this.form?.get('templateKey')?.value ?? '').trim();
    const providerKey = this.form?.get('callProviderKey')?.value;
    const providerName = providerKey
      ? (this.callProviders().find((p) => p.key === providerKey)?.displayName ??
        CALL_PROVIDER_DISPLAY_NAMES[providerKey] ??
        providerKey)
      : 'Default (Voxera)';
    return key ? `${key} · ${providerName}` : providerName;
  });

  /** Display name for the locked Call Provider field on Exchange-synced templates. */
  protected readonly callProviderDisplayName = computed(() => {
    this.reportInputsRevision();
    const providerKey = this.form?.get('callProviderKey')?.value;
    return (
      this.callProviders().find((p) => p.key === providerKey)?.displayName ??
      CALL_PROVIDER_DISPLAY_NAMES[providerKey] ??
      providerKey ??
      ''
    );
  });

  get agentBindings(): FormArray {
    return this.form.get('agentFieldBindings') as FormArray;
  }

  addAgentBinding(agentField: string, sourceKey?: string): void {
    this.agentBindings.push(
      this.fb.group({
        agentField: [agentField],
        sourceKey: [sourceKey ?? agentField],
      })
    );
  }

  /**
   * Known aliases for the three contact-identity fields an Exchange agent's own input schema may
   * declare under its own naming. A heuristic (not a server-declared mapping) — extend if a real
   * agent uses a key not listed here.
   */
  private static readonly CONTACT_FIELD_ALIASES: Record<ContactKey, string[]> = {
    phone: ['phone', 'contact_phone', 'mobile', 'phone_number', 'contact_number'],
    name: ['name', 'contact_name', 'customer_name', 'contact_person'],
    email: ['email', 'contact_email'],
  };

  /** Whether an Exchange agent input parameter is one of the three contact-identity fields. */
  protected contactFieldKind(agentField: string): ContactKey | null {
    const key = agentField.trim().toLowerCase();
    for (const kind of ['phone', 'name', 'email'] as ContactKey[]) {
      if (WorkflowTemplateFormComponent.CONTACT_FIELD_ALIASES[kind].includes(key)) return kind;
    }
    return null;
  }

  protected agentFieldSpec(agentField: string | null | undefined): AgentFieldSpec | undefined {
    return this.agentSchema()?.inputFields?.find((f) => f.key === agentField);
  }

  /** Common short acronyms kept fully uppercase by {@link sheetColumnLabel} (e.g. "po" -> "PO"). */
  private static readonly TITLE_CASE_ACRONYMS = new Set([
    'po', 'eta', 'ai', 'id', 'sku', 'gst', 'pan', 'url', 'sms',
  ]);

  /** "po_count" -> "PO Count", "plant_name" -> "Plant Name" — the sample sheet's column header. */
  protected sheetColumnLabel(agentField: string): string {
    return agentField
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map((word) => {
        const lower = word.toLowerCase();
        return WorkflowTemplateFormComponent.TITLE_CASE_ACRONYMS.has(lower)
          ? lower.toUpperCase()
          : lower.charAt(0).toUpperCase() + lower.slice(1);
      })
      .join(' ');
  }

  /**
   * The Data Function currently supplying an Exchange agent input parameter, if any — computed
   * from the enrichments already configured below, not a separate per-row selection. Contact-kind
   * fields (phone/name/email) match an enrichment output targeting `contact.<kind>`; every other
   * field matches one targeting its own key directly (same convention `agentFieldBindings` uses).
   */
  protected enrichmentSourceFor(agentField: string | null | undefined): string | null {
    if (!agentField) return null;
    this.reportInputsRevision();
    const kind = this.contactFieldKind(agentField);
    const targetKey = kind ? `${CONTACT_PREFIX}${kind}` : agentField;
    for (const g of this.enrichments.controls as FormGroup[]) {
      const outputs = g.get('outputs') as FormArray;
      const matched = outputs.controls.some(
        (r) => String(r.get('target')?.value ?? '').trim() === targetKey
      );
      if (matched) {
        const fn = this.dataFunctions().find((f) => f.id === g.get('dataFunctionId')?.value);
        return fn?.name ?? 'a data enrichment';
      }
    }
    return null;
  }

  /** Whether an Exchange agent input parameter is currently mapped to a CSV upload column. */
  protected isAgentFieldFromSheet(agentField: string | null | undefined): boolean {
    if (!agentField) return false;
    this.reportInputsRevision();
    return this.contextMappings.controls.some((c) => c.get('fieldName')?.value === agentField);
  }

  protected agentFieldStatus(
    agentField: string | null | undefined,
    required: boolean | undefined
  ): 'resolved' | 'missing' | 'skipped' {
    const resolved = !!this.enrichmentSourceFor(agentField) || this.isAgentFieldFromSheet(agentField);
    if (resolved) return 'resolved';
    return required ? 'missing' : 'skipped';
  }

  private contactControlName(kind: ContactKey): 'contactPhone' | 'contactName' | 'contactEmail' {
    return kind === 'phone' ? 'contactPhone' : kind === 'name' ? 'contactName' : 'contactEmail';
  }

  /**
   * Toggles whether an Exchange agent input parameter is collected via the uploaded sheet — the
   * only interactive choice left on the merged Input Parameters table (the "or fetched by an
   * enrichment" side is purely derived, see {@link enrichmentSourceFor}). Keeps `contextMappings`,
   * `agentFieldBindings`, and — for phone/name/email — `contactExtractionConfig` all in sync under
   * one same-named key, so there is nothing left to type manually.
   */
  protected onAgentFieldSheetToggle(agentField: string | null | undefined, fromSheet: boolean): void {
    if (!agentField) return;
    const spec = this.agentFieldSpec(agentField);
    const kind = this.contactFieldKind(agentField);

    const binding = this.agentBindings.controls.find((c) => c.get('agentField')?.value === agentField);
    binding?.get('sourceKey')?.setValue(agentField);

    const existingIndex = this.contextMappings.controls.findIndex(
      (c) => c.get('fieldName')?.value === agentField
    );

    if (fromSheet) {
      if (existingIndex === -1) {
        this.addContextMapping({
          fieldName: agentField,
          jsonPath: `$.${agentField}`,
          required: !!spec?.required,
          dataType: this.mapExchangeFieldType(spec?.type),
        });
      }
      if (kind) {
        this.form.get(this.contactControlName(kind))?.setValue(`$.${agentField}`);
      }
    } else {
      if (existingIndex !== -1) {
        this.contextMappings.removeAt(existingIndex);
      }
      if (kind) {
        this.form.get(this.contactControlName(kind))?.setValue('');
      }
    }
  }

  /** Exchange's declared field-type strings -> Clarix's FieldDataType; mirrors the backend mapper. */
  private mapExchangeFieldType(exchangeType: string | undefined): FieldDataType {
    switch ((exchangeType ?? '').toLowerCase()) {
      case 'boolean':
      case 'bool':
        return FieldDataType.BOOLEAN;
      case 'number':
      case 'integer':
      case 'int':
      case 'float':
      case 'double':
        return FieldDataType.NUMBER;
      case 'date':
      case 'datetime':
      case 'timestamp':
        return FieldDataType.DATE;
      default:
        return FieldDataType.STRING;
    }
  }

  private loadAgentSchema(templateId: string): void {
    this.agentSchemaLoading.set(true);
    this.templateService
      .getAgentSchema(templateId)
      .pipe(takeUntil(this.destroy$), finalize(() => this.agentSchemaLoading.set(false)))
      .subscribe((schema) => {
        this.agentSchema.set(schema);
        this.mergeAgentSchema(schema);
        this.cdr.markForCheck();
      });
  }

  /** Re-reads the agent from Echo and applies it (see mergeAgentSchema). */
  syncFromAgent(): void {
    const id = this.template()?.id;
    if (id) {
      this.loadAgentSchema(id);
    }
  }

  /**
   * Makes this setup match the Echo agent, which owns it: basic details, the input
   * fields the sheet must supply and the answers the report shows. New fields are
   * added, renamed or retyped ones are updated and fields Echo removed are dropped.
   * Where each input comes from (sheet column or data lookup) is kept.
   */
  private mergeAgentSchema(schema: AgentSchema | null): void {
    if (!schema) return;
    let added = 0;
    let updated = 0;
    let removed = 0;

    // Basic: read only here, owned by Echo.
    const basic: Record<string, string | undefined> = { name: schema.agentName, description: schema.description };
    for (const [k, v] of Object.entries(basic)) {
      const c = this.form.get(k);
      if (v !== undefined && c && c.value !== v) { c.setValue(v); updated++; }
    }
    const spec = this.form.get('providerAgentSpec');
    if (spec) {
      if (schema.voice !== undefined && spec.get('voice')?.value !== schema.voice) { spec.get('voice')?.setValue(schema.voice); updated++; }
      if (schema.direction !== undefined && spec.get('direction')?.value !== schema.direction) { spec.get('direction')?.setValue(schema.direction); updated++; }
    }

    // Inputs.
    const inputKeys = new Set((schema.inputFields ?? []).map((f) => f.key).filter(Boolean));
    for (let i = this.agentBindings.length - 1; i >= 0; i--) {
      const key = String(this.agentBindings.at(i).get('agentField')?.value ?? '');
      if (key && !inputKeys.has(key)) { this.agentBindings.removeAt(i); removed++; }
    }
    const existingBindings = new Set(this.agentBindings.controls.map((c) => String(c.get('agentField')?.value ?? '')));
    (schema.inputFields ?? []).forEach((f: AgentFieldSpec) => {
      if (!f.key) return;
      if (!existingBindings.has(f.key)) { this.addAgentBinding(f.key, f.key); added++; }
      // Every agent field defaults into the sheet so it isn't silently dropped, unless an
      // enrichment already supplies it, or the admin has already picked a sheet source for it.
      if (!this.enrichmentSourceFor(f.key) && !this.isAgentFieldFromSheet(f.key)) {
        this.onAgentFieldSheetToggle(f.key, true);
      }
    });

    // Outputs (the answers).
    const outputs = new Map((schema.outputFields ?? []).filter((f) => f.key).map((f) => [f.key, f] as const));
    for (let i = this.requiredFields.length - 1; i >= 0; i--) {
      const g = this.requiredFields.at(i);
      const key = String(g.get('fieldKey')?.value ?? '');
      const f = outputs.get(key);
      if (!f) { this.requiredFields.removeAt(i); removed++; continue; }
      const label = f.label && f.label.trim() ? f.label : f.key;
      const type = this.mapExchangeFieldType(f.type);
      if (g.get('fieldLabel')?.value !== label || g.get('dataType')?.value !== type) {
        g.patchValue({ fieldLabel: label, dataType: type });
        updated++;
      }
      outputs.delete(key);
    }
    for (const f of outputs.values()) {
      this.addRequiredField({
        fieldKey: f.key,
        fieldLabel: f.label && f.label.trim() ? f.label : f.key,
        dataType: this.mapExchangeFieldType(f.type),
        required: false,
        showOnDashboard: true,
        extractionHint: 'Reported by the Echo agent after the call.',
      });
      added++;
    }

    const when = schema.syncedAt ? new Date(schema.syncedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    this.syncSummary.set(
      added + updated + removed
        ? `Updated from Echo: ${[added && `${added} added`, updated && `${updated} changed`, removed && `${removed} removed`].filter(Boolean).join(', ')}. Save to keep.`
        : `In sync with Echo${when ? ` · last change received ${when}` : ''}.`
    );
  }

  /* ─── Data Function Enrichments FormArray ─── */

  get enrichments(): FormArray {
    return this.form.get('enrichments') as FormArray;
  }

  enrichmentInputs(index: number): FormArray {
    return (this.enrichments.at(index) as FormGroup).get('inputs') as FormArray;
  }

  enrichmentOutputs(index: number): FormArray {
    return (this.enrichments.at(index) as FormGroup).get('outputs') as FormArray;
  }

  addEnrichment(value?: EnrichmentBinding): void {
    const group = this.fb.group({
      dataFunctionId: [value?.dataFunctionId ?? '', Validators.required],
      required: [value?.required ?? true],
      acceptInputs: [value?.acceptInputs ?? false],
      inputs: this.fb.array([]),
      outputs: this.fb.array([]),
    });
    const inputs = group.get('inputs') as FormArray;
    const outputs = group.get('outputs') as FormArray;
    Object.entries(value?.inputBindings ?? {}).forEach(([param, source]) =>
      inputs.push(this.fb.group({ param: [param], source: [source] }))
    );
    Object.entries(value?.outputBindings ?? {}).forEach(([output, target]) =>
      outputs.push(this.fb.group({ output: [output], target: [target] }))
    );
    this.enrichments.push(group);
  }

  removeEnrichment(index: number): void {
    this.enrichments.removeAt(index);
  }

  /**
   * "Accept Inputs" toggle: when turned on, every field this enrichment currently supplies also
   * gets added back into the sheet (a row may then give the value directly OR the lookup key, but
   * not both — enforced by the backend's row validation); when turned off, those sheet mappings are
   * removed again so the field goes back to being purely enrichment-derived. Reuses
   * {@link onAgentFieldSheetToggle} so contact-kind side effects (contactExtractionConfig) stay in sync.
   */
  protected onEnrichmentAcceptInputsToggle(index: number, accept: boolean): void {
    const targets = new Set(
      this.enrichmentOutputs(index).controls
        .map((c) => String(c.get('target')?.value ?? '').trim())
        .filter(Boolean)
    );
    this.agentBindings.controls
      .map((c) => String(c.get('agentField')?.value ?? ''))
      .filter((agentField) => agentField && targets.has(this.agentFieldToTargetKey(agentField)))
      .forEach((agentField) => this.onAgentFieldSheetToggle(agentField, accept));
  }

  /**
   * Rebuild the input rows from the newly-selected function's own declared parameters — always
   * all of them, keyed by the parameter's own name ("keyed by supplier_id"), not user-editable.
   * Output rows are NOT auto-populated: which fields to fetch, and which agent param each maps to,
   * is an explicit per-row choice made via "+ Add field" (see {@link addEnrichmentOutputField}).
   */
  onEnrichmentFunctionChange(index: number): void {
    const group = this.enrichments.at(index) as FormGroup;
    const fn = this.dataFunctions().find((f) => f.id === group.get('dataFunctionId')!.value);
    const inputs = group.get('inputs') as FormArray;
    const outputs = group.get('outputs') as FormArray;
    inputs.clear();
    outputs.clear();
    if (fn) {
      (fn.parameters ?? []).forEach((p) =>
        inputs.push(this.fb.group({ param: [p.name], source: [p.name] }))
      );
    }
  }

  enrichmentFunction(index: number): DataFunction | undefined {
    const id = (this.enrichments.at(index) as FormGroup).get('dataFunctionId')!.value;
    return this.dataFunctions().find((f) => f.id === id);
  }

  /** Removes one fetched-field row — the function itself may still declare it, just unused here. */
  removeEnrichmentOutput(index: number, k: number): void {
    this.enrichmentOutputs(index).removeAt(k);
  }

  /** The function's own declared outputs not currently listed under "Fetch these fields". */
  availableEnrichmentOutputs(index: number): DataFunctionOutput[] {
    const fn = this.enrichmentFunction(index);
    if (!fn) return [];
    const used = new Set(
      this.enrichmentOutputs(index).controls.map((c) => c.get('output')?.value)
    );
    return (fn.outputs ?? []).filter((o) => !used.has(o.name));
  }

  /** Adds a fetched-field row for one of the function's outputs — target starts unmapped, chosen
   *  next via the row's own "map to agent param" dropdown ({@link agentParamTargetOptions}). */
  addEnrichmentOutputField(index: number, outputName: string): void {
    if (!outputName) return;
    this.enrichmentOutputs(index).push(this.fb.group({ output: [outputName], target: [''] }));
  }

  /** Turns an agent's own input field key into the string an enrichment output's `target` must
   *  equal to resolve it (see {@link enrichmentSourceFor}) — contact-alias fields (phone/name/email)
   *  resolve through the `contact.<kind>` prefix, everything else maps to its own key directly. */
  private agentFieldToTargetKey(agentField: string): string {
    const kind = this.contactFieldKind(agentField);
    return kind ? `${CONTACT_PREFIX}${kind}` : agentField;
  }

  /** Clarix-side contact slot with no corresponding agent-declared input field. */
  private static readonly FALLBACK_PHONE_TARGET = `${CONTACT_PREFIX}fallbackPhone`;

  /** Options for a fetched field's "map to agent param" dropdown — every input parameter the
   *  synced agent itself declares, plus the one Clarix-only contact slot that isn't one of them. */
  protected agentParamTargetOptions(): { value: string; label: string }[] {
    const fields = this.agentSchema()?.inputFields ?? [];
    const options = fields.map((f) => ({ value: this.agentFieldToTargetKey(f.key), label: f.key }));
    options.push({ value: WorkflowTemplateFormComponent.FALLBACK_PHONE_TARGET, label: 'Fallback phone' });
    return options;
  }

  /* ─── Report Fields FormArray ─── */

  get reportFields(): FormArray {
    return this.form.get('reportFields') as FormArray;
  }

  reportFieldAt(index: number): FormGroup {
    return this.reportFields.at(index) as FormGroup;
  }

  addReportField(value?: Partial<ReportFieldMapping>, fromServer = false): void {
    const initialFieldName = value?.fieldName ?? this.toCamelCase(value?.header ?? '');
    this.reportFields.push(
      this.fb.group({
        header: [value?.header ?? '', Validators.required],
        dataType: [value?.dataType ?? FieldDataType.STRING, Validators.required],
        // Derived from the header (no UI input); camelCase storage key for the report.
        fieldName: [
          initialFieldName,
          [Validators.required, Validators.pattern(/^[a-z][a-zA-Z0-9]*$/)],
        ],
        // Snapshot of the fieldName as it was loaded from the server. Empty for new rows.
        // Used to compute renames on submit and to know whether to warn on delete.
        originalFieldName: [fromServer ? initialFieldName : ''],
      })
    );
  }

  /** Row indexes the user has requested to remove but not yet confirmed. */
  protected readonly pendingReportRemovals = signal<ReadonlySet<number>>(new Set());

  /** First click on trash: warn if the row was loaded from the server (has data); else remove immediately. */
  removeReportField(index: number): void {
    const original = String(this.reportFieldAt(index).get('originalFieldName')?.value ?? '').trim();
    if (!original) {
      this.reportFields.removeAt(index);
      return;
    }
    this.pendingReportRemovals.update((prev) => {
      const next = new Set(prev);
      next.add(index);
      return next;
    });
  }

  isReportRemovalPending(index: number): boolean {
    return this.pendingReportRemovals().has(index);
  }

  confirmRemoveReportField(index: number): void {
    this.reportFields.removeAt(index);
    this.pendingReportRemovals.update((prev) => {
      // Indexes after `index` all shift down by one; rebuild the set accordingly.
      const next = new Set<number>();
      for (const i of prev) {
        if (i === index) continue;
        next.add(i > index ? i - 1 : i);
      }
      return next;
    });
  }

  cancelRemoveReportField(index: number): void {
    this.pendingReportRemovals.update((prev) => {
      if (!prev.has(index)) return prev;
      const next = new Set(prev);
      next.delete(index);
      return next;
    });
  }

  /** Keep the derived camelCase fieldName in sync with the header the user types. */
  onReportHeaderInput(index: number): void {
    const group = this.reportFieldAt(index);
    const header = String(group.get('header')?.value ?? '');
    group.get('fieldName')?.setValue(this.toCamelCase(header));
  }

  /** Reads the header row of a sample CSV and appends a report field per new header. */
  pickHeadersFromCsv(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = ''; // allow re-selecting the same file
    if (!file) return;
    void this.importHeadersFromCsv(file);
  }

  private async importHeadersFromCsv(file: File): Promise<void> {
    try {
      const slice = file.slice(0, Math.min(file.size, 64 * 1024));
      const text = await slice.text();
      const headers = this.parseCsvHeaderLine(text);
      if (headers.length === 0) {
        this.errorMessage.set('Could not detect any column headers in the selected file.');
        return;
      }
      const existing = new Set(
        this.reportFields.controls.map((c) =>
          String(c.get('header')?.value ?? '').trim().toLowerCase()
        )
      );
      for (const header of headers) {
        if (existing.has(header.toLowerCase())) continue;
        this.addReportField({ header });
        existing.add(header.toLowerCase());
      }
      this.errorMessage.set(null);
    } catch {
      this.errorMessage.set('Failed to read the CSV file.');
    } finally {
      // File read resolves after the change event's CD pass; force re-render under OnPush.
      this.cdr.markForCheck();
    }
  }

  private parseCsvHeaderLine(text: string): string[] {
    const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const nlIdx = stripped.search(/\r\n|\n|\r/);
    const line = nlIdx === -1 ? stripped : stripped.slice(0, nlIdx);

    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result.filter((h) => h.length > 0);
  }

  private toCamelCase(input: string): string {
    const words = input
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (words.length === 0) return '';
    return words
      .map((w, i) =>
        i === 0
          ? w.charAt(0).toLowerCase() + w.slice(1)
          : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
      )
      .join('')
      .replace(/^[0-9]+/, '');
  }

  /* ─── Customize Report column selection ─── */

  /** Live list of context-param column ids derived from the contextMappings form array. */
  protected readonly contextParamColumnOptions = computed(() => {
    this.reportInputsRevision(); // recompute as context mappings are added/removed/renamed
    return this.contextMappings.controls
      .map((c) => String(c.get('fieldName')?.value ?? '').trim())
      .filter(Boolean);
  });

  /** Live list of execution-outcome column ids (required field keys + labels). */
  protected readonly executionOutcomeColumnOptions = computed(() => {
    this.reportInputsRevision(); // recompute as required fields are added/removed/renamed
    return this.requiredFields.controls
      .map((c) => ({
        key: String(c.get('fieldKey')?.value ?? '').trim(),
        label: String(c.get('fieldLabel')?.value ?? '').trim(),
      }))
      .filter((o) => o.key.length > 0);
  });

  /**
   * Live list of Data Function input source keys (e.g. "supplier_id") the trigger must supply,
   * derived from the enrichments + context-mapping form arrays. Reuses resolveTriggerInputs so
   * the same exclusions (chained/contact/context-param inputs) apply as elsewhere.
   */
  protected readonly enrichmentInputColumnOptions = computed<string[]>(() => {
    this.reportInputsRevision();
    const enrichments: EnrichmentBinding[] = this.enrichments.controls.map((g) => {
      const grp = g as FormGroup;
      const inputs = (grp.get('inputs') as FormArray).controls;
      const outputs = (grp.get('outputs') as FormArray).controls;
      return {
        dataFunctionId: String(grp.get('dataFunctionId')?.value ?? ''),
        required: !!grp.get('required')?.value,
        acceptInputs: !!grp.get('acceptInputs')?.value,
        inputBindings: Object.fromEntries(
          inputs
            .map((r): [string, string] => [
              String(r.get('param')?.value ?? '').trim(),
              String(r.get('source')?.value ?? '').trim(),
            ])
            .filter(([p, s]) => p && s)
        ),
        outputBindings: Object.fromEntries(
          outputs
            .map((r): [string, string] => [
              String(r.get('output')?.value ?? '').trim(),
              String(r.get('target')?.value ?? '').trim(),
            ])
            .filter(([o, t]) => o && t)
        ),
      };
    });
    const contextMappings: ContextMapping[] = this.contextMappings.controls
      .map((c) => ({
        fieldName: String((c as FormGroup).get('fieldName')?.value ?? '').trim(),
        jsonPath: '',
        required: false,
      }))
      .filter((m) => m.fieldName);
    const pseudoTemplate = { enrichments, contextMappings } as unknown as WorkflowTemplate;
    return resolveTriggerInputs(pseudoTemplate).enrichmentInputs.map((i) => i.key);
  });

  /**
   * All currently-enabled report columns as {id,label}, in the canonical default order the
   * backend report builder uses. IDs are namespaced identically to the backend so a saved
   * columnOrder resolves consistently on both sides.
   */
  protected readonly enabledColumns = computed<ReportColumnRef[]>(() => {
    const cols: ReportColumnRef[] = [];
    const contactSel = this.selectedContact();
    const detailSel = this.selectedExecutionDetails();
    const isContact = (k: ReportContactKey) => (contactSel === null ? true : contactSel.has(k));
    const isDetail = (k: ReportExecutionDetailKey) => (detailSel === null ? true : detailSel.has(k));
    const detailLabel = new Map(this.executionDetailColumnOptions.map((o) => [o.key, o.label]));
    const contactLabel = new Map(this.contactColumnOptions.map((o) => [o.key, o.label]));

    for (const k of ['executionId', 'name'] as ReportExecutionDetailKey[]) {
      if (isDetail(k)) cols.push({ id: `detail:${k}`, label: detailLabel.get(k) ?? k, section: 'Execution Details' });
    }
    for (const k of REPORT_CONTACT_KEYS) {
      if (isContact(k)) cols.push({ id: `contact:${k}`, label: contactLabel.get(k) ?? k, section: 'Contact' });
    }
    for (const k of [
      'status',
      'channel',
      'createdAt',
      'completedAt',
      'callDuration',
      'sentiment',
      'summary',
    ] as ReportExecutionDetailKey[]) {
      if (isDetail(k)) cols.push({ id: `detail:${k}`, label: detailLabel.get(k) ?? k, section: 'Execution Details' });
    }
    const ctxSel = this.selectedContextParams();
    for (const name of this.contextParamColumnOptions()) {
      if (ctxSel === null || ctxSel.has(name)) {
        cols.push({ id: `context:${name}`, label: name, section: 'Context Params' });
      }
    }
    const dfSel = this.selectedEnrichmentInputs();
    for (const key of this.enrichmentInputColumnOptions()) {
      if (dfSel === null || dfSel.has(key)) {
        cols.push({ id: `dfInput:${key}`, label: key, section: 'Data Function Inputs' });
      }
    }
    const outSel = this.selectedExecutionOutcome();
    for (const o of this.executionOutcomeColumnOptions()) {
      if (outSel === null || outSel.has(o.key)) {
        cols.push({ id: `outcome:${o.key}`, label: o.label || o.key, section: 'Execution Outcome' });
      }
    }
    for (const ctrl of this.reportFields.controls) {
      const fn = String(ctrl.get('fieldName')?.value ?? '').trim();
      const header = String(ctrl.get('header')?.value ?? '').trim();
      if (fn) cols.push({ id: `reportField:${fn}`, label: header || fn, section: 'Additional Fields' });
    }
    return cols;
  });

  /**
   * enabledColumns reordered by the user's manualColumnOrder: known ids first in saved order,
   * then any newly-enabled column appended in default order. null order = default order.
   */
  protected readonly orderedColumns = computed<ReportColumnRef[]>(() => {
    const enabled = this.enabledColumns();
    const order = this.manualColumnOrder();
    if (!order || order.length === 0) return enabled;
    const byId = new Map(enabled.map((c) => [c.id, c]));
    const result: ReportColumnRef[] = [];
    for (const id of order) {
      const c = byId.get(id);
      if (c) {
        result.push(c);
        byId.delete(id);
      }
    }
    for (const c of byId.values()) result.push(c);
    return result;
  });

  isContactColumnSelected(key: ReportContactKey): boolean {
    const sel = this.selectedContact();
    return sel === null ? true : sel.has(key);
  }

  isExecutionDetailColumnSelected(key: ReportExecutionDetailKey): boolean {
    const sel = this.selectedExecutionDetails();
    return sel === null ? true : sel.has(key);
  }

  isContextParamColumnSelected(key: string): boolean {
    const sel = this.selectedContextParams();
    return sel === null ? true : sel.has(key);
  }

  isEnrichmentInputColumnSelected(key: string): boolean {
    const sel = this.selectedEnrichmentInputs();
    return sel === null ? true : sel.has(key);
  }

  isExecutionOutcomeColumnSelected(key: string): boolean {
    const sel = this.selectedExecutionOutcome();
    return sel === null ? true : sel.has(key);
  }

  toggleContactColumn(key: ReportContactKey, checked: boolean): void {
    this.selectedContact.update((prev) =>
      this.toggleInSet(prev, REPORT_CONTACT_KEYS as readonly ReportContactKey[], key, checked)
    );
  }

  toggleExecutionDetailColumn(key: ReportExecutionDetailKey, checked: boolean): void {
    this.selectedExecutionDetails.update((prev) =>
      this.toggleInSet(
        prev,
        REPORT_EXECUTION_DETAIL_KEYS as readonly ReportExecutionDetailKey[],
        key,
        checked
      )
    );
  }

  toggleContextParamColumn(key: string, checked: boolean): void {
    this.selectedContextParams.update((prev) =>
      this.toggleInSet(prev, this.contextParamColumnOptions(), key, checked)
    );
  }

  toggleEnrichmentInputColumn(key: string, checked: boolean): void {
    this.selectedEnrichmentInputs.update((prev) =>
      this.toggleInSet(prev, this.enrichmentInputColumnOptions(), key, checked)
    );
  }

  /** Drag-reorder the flat column-order list; first drag materializes the manual order. */
  dropColumn(event: CdkDragDrop<ReportColumnRef[]>): void {
    const ids = this.orderedColumns().map((c) => c.id);
    moveItemInArray(ids, event.previousIndex, event.currentIndex);
    this.manualColumnOrder.set(ids);
  }

  /** The header this column will get in the CSV: the user's override, else the default. */
  effectiveHeader(col: ReportColumnRef): string {
    return this.columnHeaderOverrides().get(col.id) ?? col.label;
  }

  /** Rename a column's CSV header. Blank or unchanged-from-default clears the override. */
  setColumnHeader(id: string, defaultLabel: string, value: string): void {
    const trimmed = value.trim();
    this.columnHeaderOverrides.update((prev) => {
      const next = new Map(prev);
      if (!trimmed || trimmed === defaultLabel) next.delete(id);
      else next.set(id, trimmed);
      return next;
    });
  }

  /** Effective headers (lowercased) that appear on more than one enabled column. */
  private readonly duplicateHeaderKeys = computed<Set<string>>(() => {
    const overrides = this.columnHeaderOverrides();
    const counts = new Map<string, number>();
    for (const col of this.orderedColumns()) {
      const key = (overrides.get(col.id) ?? col.label).trim().toLowerCase();
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const dupes = new Set<string>();
    for (const [key, n] of counts) if (n > 1) dupes.add(key);
    return dupes;
  });

  /** True when another enabled column resolves to the same CSV header. */
  isDuplicateHeader(col: ReportColumnRef): boolean {
    return this.duplicateHeaderKeys().has(this.effectiveHeader(col).trim().toLowerCase());
  }

  toggleExecutionOutcomeColumn(key: string, checked: boolean): void {
    const all = this.executionOutcomeColumnOptions().map((o) => o.key);
    this.selectedExecutionOutcome.update((prev) => this.toggleInSet(prev, all, key, checked));
  }

  /** Materialize null → full set on first toggle, then add/remove key. */
  private toggleInSet<T extends string>(
    prev: Set<T> | null,
    all: readonly T[],
    key: T,
    checked: boolean
  ): Set<T> {
    const next = new Set<T>(prev === null ? all : prev);
    if (checked) next.add(key);
    else next.delete(key);
    return next;
  }

  private hydrateReportColumns(saved: ReportColumnSelection | undefined): void {
    // null/undefined ⇒ "include all" semantics. Keep signals null until user toggles.
    this.selectedContact.set(
      saved?.contact ? new Set(saved.contact as ReportContactKey[]) : null
    );
    this.selectedExecutionDetails.set(
      saved?.executionDetails ? new Set(saved.executionDetails as ReportExecutionDetailKey[]) : null
    );
    this.selectedContextParams.set(saved?.contextParams ? new Set(saved.contextParams) : null);
    this.selectedEnrichmentInputs.set(
      saved?.enrichmentInputs ? new Set(saved.enrichmentInputs) : null
    );
    this.selectedExecutionOutcome.set(
      saved?.executionOutcome ? new Set(saved.executionOutcome) : null
    );
    this.manualColumnOrder.set(
      saved?.columnOrder && saved.columnOrder.length ? [...saved.columnOrder] : null
    );
    this.columnHeaderOverrides.set(
      saved?.headerOverrides ? new Map(Object.entries(saved.headerOverrides)) : new Map()
    );
  }

  /** Build the request payload. Sections that are still null (never toggled) are omitted entirely. */
  private buildReportColumnsPayload(): ReportColumnSelection | undefined {
    const contact = this.selectedContact();
    const details = this.selectedExecutionDetails();
    const context = this.selectedContextParams();
    const enrichmentInputs = this.selectedEnrichmentInputs();
    const outcome = this.selectedExecutionOutcome();
    const columnOrder = this.manualColumnOrder();
    const headerOverrides = this.columnHeaderOverrides();
    if (
      contact === null &&
      details === null &&
      context === null &&
      enrichmentInputs === null &&
      outcome === null &&
      columnOrder === null &&
      headerOverrides.size === 0
    ) {
      return undefined;
    }
    const payload: ReportColumnSelection = {};
    if (contact !== null) payload.contact = Array.from(contact);
    if (details !== null) payload.executionDetails = Array.from(details);
    if (context !== null) {
      const available = new Set(this.contextParamColumnOptions());
      payload.contextParams = Array.from(context).filter((k) => available.has(k));
    }
    if (enrichmentInputs !== null) {
      const available = new Set(this.enrichmentInputColumnOptions());
      payload.enrichmentInputs = Array.from(enrichmentInputs).filter((k) => available.has(k));
    }
    if (outcome !== null) {
      const available = new Set(this.executionOutcomeColumnOptions().map((o) => o.key));
      payload.executionOutcome = Array.from(outcome).filter((k) => available.has(k));
    }
    if (columnOrder !== null) {
      // Persist the current resolved order (drops stale ids, includes newly-enabled columns).
      payload.columnOrder = this.orderedColumns().map((c) => c.id);
    }
    if (headerOverrides.size > 0) {
      // Keep only overrides for columns that are still enabled.
      const enabledIds = new Set(this.enabledColumns().map((c) => c.id));
      const obj: Record<string, string> = {};
      for (const [id, header] of headerOverrides) {
        if (enabledIds.has(id)) obj[id] = header;
      }
      if (Object.keys(obj).length > 0) payload.headerOverrides = obj;
    }
    return payload;
  }

  /** Omits the block entirely once every field is blank, rather than sending an all-empty object. */
  private buildProviderAgentSpecPayload(
    raw: Record<string, string> | undefined
  ): WorkflowTemplateRequest['providerAgentSpec'] {
    if (!raw) return undefined;
    const entries = Object.entries(raw).filter(([, value]) => String(value ?? '').trim());
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries.map(([key, value]) => [key, String(value).trim()]));
  }

  /**
   * Builds the agentFieldBindings map from the Agent Fields "Input Parameters" rows. A field
   * resolved by an enrichment always takes the enrichment's own target as its source key — e.g.
   * "contact.name" for contact_name — rather than the row's stored self-mapped default, so the
   * engine reads the value from where it's actually written (see
   * WorkflowEnrichmentService#writeTarget) instead of a plain context key that's never set.
   */
  private buildAgentFieldBindingsPayload(): Record<string, string> | undefined {
    const rows = this.agentBindings.controls
      .map((c) => {
        const agentField = String(c.get('agentField')?.value ?? '').trim();
        const enriched = this.enrichmentSourceFor(agentField);
        const sourceKey = enriched
          ? this.agentFieldToTargetKey(agentField)
          : String(c.get('sourceKey')?.value ?? '').trim();
        return { agentField, sourceKey };
      })
      .filter((r) => r.agentField && r.sourceKey);
    if (rows.length === 0) return undefined;
    return Object.fromEntries(rows.map((r) => [r.agentField, r.sourceKey]));
  }

  /** fieldNames must be unique across report-field rows. */
  protected readonly duplicateReportFieldNames = (): boolean => {
    const seen = new Set<string>();
    for (const ctrl of this.reportFields.controls) {
      const name = String(ctrl.get('fieldName')?.value ?? '').trim();
      if (!name) continue;
      if (seen.has(name)) return true;
      seen.add(name);
    }
    return false;
  };

  /* ─── Steps FormArray ─── */

  get steps(): FormArray {
    return this.form.get('steps') as FormArray;
  }

  stepAt(index: number): FormGroup {
    return this.steps.at(index) as FormGroup;
  }

  actionGroup(stepIndex: number): FormGroup {
    return this.stepAt(stepIndex).get('action') as FormGroup;
  }

  conditionsArray(stepIndex: number): FormArray {
    return this.stepAt(stepIndex).get('conditions') as FormArray;
  }

  providerParamsGroup(stepIndex: number): FormGroup {
    return this.actionGroup(stepIndex).get('providerParams') as FormGroup;
  }

  addStep(value?: Partial<WorkflowStep>): void {
    const action = value?.action;
    const nextIndex = this.steps.length + 1;
    this.steps.push(
      this.fb.group({
        stepId: [value?.stepId ?? `step_${nextIndex}`, Validators.required],
        description: [value?.description ?? ''],
        conditions: this.fb.array(
          (value?.conditions ?? []).map((c) => this.buildConditionGroup(c))
        ),
        action: this.fb.group({
          actionType: [action?.actionType ?? ActionType.TRIGGER_CALL, Validators.required],
          channelType: [action?.channelType ?? ChannelType.CALL],
          questionTemplate: [action?.questionTemplate ?? ''],
          fieldsToExtractRaw: [(action?.fieldsToExtract ?? []).join(', ')],
          jumpToStepId: [action?.jumpToStepId ?? ''],
          childWorkflowTemplateId: [action?.childWorkflowTemplateId ?? ''],
          providerAgentId: [action?.providerAgentId ?? ''],
          providerParams: this.fb.group({
            language: [(action?.providerParams?.['language'] as string) ?? 'hinglish'],
            voice: [(action?.providerParams?.['voice'] as string) ?? 'Ferris'],
          }),
        }),
        onSuccessStepId: [value?.onSuccessStepId ?? 'COMPLETE'],
        onFailureStepId: [value?.onFailureStepId ?? 'COMPLETE'],
        maxRetries: [value?.maxRetries ?? 3, [Validators.min(0), Validators.max(10)]],
        retryDelayMinutes: [value?.retryDelayMinutes ?? 30, [Validators.min(1)]],
      })
    );
  }

  removeStep(index: number): void {
    this.steps.removeAt(index);
  }

  moveStep(from: number, to: number): void {
    if (to < 0 || to >= this.steps.length || from === to) return;
    const ctrl = this.steps.at(from);
    this.steps.removeAt(from);
    this.steps.insert(to, ctrl);
  }

  private buildConditionGroup(value?: Partial<StepCondition>): FormGroup {
    return this.fb.group({
      field: [value?.field ?? '', Validators.required],
      operator: [value?.operator ?? ConditionOperator.EQUALS, Validators.required],
      value: [value?.value != null ? String(value.value) : ''],
    });
  }

  addCondition(stepIndex: number): void {
    this.conditionsArray(stepIndex).push(this.buildConditionGroup());
  }

  removeCondition(stepIndex: number, conditionIndex: number): void {
    this.conditionsArray(stepIndex).removeAt(conditionIndex);
  }

  /** All stepIds in the current form — used to populate jump/onSuccess/onFailure dropdowns. */
  availableStepIds(): string[] {
    return this.steps.controls
      .map((c) => (c.get('stepId')?.value as string)?.trim())
      .filter(Boolean);
  }

  isActionFieldVisible(stepIndex: number, field: 'channelType' | 'questionTemplate' | 'fieldsToExtract' | 'providerAgentId' | 'providerParams' | 'jumpToStepId' | 'childWorkflowTemplateId'): boolean {
    const type = this.actionGroup(stepIndex).get('actionType')?.value as ActionType;
    const triggerTypes = new Set<ActionType>([
      ActionType.TRIGGER_CALL,
      ActionType.TRIGGER_WHATSAPP,
      ActionType.TRIGGER_CHAT,
    ]);
    switch (field) {
      case 'channelType':
      case 'questionTemplate':
      case 'fieldsToExtract':
      case 'providerAgentId':
        return triggerTypes.has(type);
      case 'providerParams':
        return type === ActionType.TRIGGER_CALL;
      case 'jumpToStepId':
        return type === ActionType.JUMP_TO_STEP;
      case 'childWorkflowTemplateId':
        return type === ActionType.TRIGGER_CHILD_WORKFLOW;
    }
  }

  /* ─── Submit ─── */

  get isEdit(): boolean {
    return !!this.template();
  }

  submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.errorMessage.set('Please fix the highlighted fields before saving.');
      return;
    }

    if (this.duplicateReportFieldNames()) {
      this.activeTab.set('report');
      this.errorMessage.set('Report field names must be unique.');
      return;
    }

    const v = this.form.value;

    const triggerEventTypes = (v.triggerEventTypesRaw as string)
      .split(',')
      .map((s: string) => s.trim().toUpperCase())
      .filter(Boolean);

    const steps: WorkflowStep[] = (v.steps as Array<Record<string, unknown>>).map((raw) => {
      const a = raw['action'] as Record<string, unknown>;
      const providerParams = a['providerParams'] as Record<string, unknown> | undefined;
      const fieldsToExtract = String(a['fieldsToExtractRaw'] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const action: StepAction = {
        actionType: a['actionType'] as ActionType,
      };
      if (a['channelType']) action.channelType = a['channelType'] as ChannelType;
      if (a['questionTemplate']) action.questionTemplate = String(a['questionTemplate']);
      if (fieldsToExtract.length) action.fieldsToExtract = fieldsToExtract;
      if (a['jumpToStepId']) action.jumpToStepId = String(a['jumpToStepId']);
      if (a['childWorkflowTemplateId']) action.childWorkflowTemplateId = String(a['childWorkflowTemplateId']);
      if (a['providerAgentId']) action.providerAgentId = String(a['providerAgentId']);
      if (providerParams && (providerParams['language'] || providerParams['voice'])) {
        action.providerParams = {};
        if (providerParams['language']) action.providerParams['language'] = providerParams['language'];
        if (providerParams['voice']) action.providerParams['voice'] = providerParams['voice'];
      }

      const conditions = (raw['conditions'] as Array<Record<string, unknown>>)
        .filter((c) => c['field'])
        .map((c) => ({
          field: String(c['field']),
          operator: c['operator'] as ConditionOperator,
          value: c['value'] !== '' && c['value'] != null ? c['value'] : undefined,
        }));

      return {
        stepId: String(raw['stepId']),
        description: raw['description'] ? String(raw['description']) : undefined,
        conditions: conditions.length ? conditions : undefined,
        action,
        onSuccessStepId: raw['onSuccessStepId'] ? String(raw['onSuccessStepId']) : undefined,
        onFailureStepId: raw['onFailureStepId'] ? String(raw['onFailureStepId']) : undefined,
        maxRetries: raw['maxRetries'] as number,
        retryDelayMinutes: raw['retryDelayMinutes'] as number,
      };
    });

    // The Exchange "Input Fields" UI has no jsonPath input (unlike Context Mapping's manual entry
    // for Kafka/API payloads) — it's self-referential for CSV upload, so a blank one is derived
    // from the field name instead of being silently dropped.
    const contextMappings = (v.contextMappings as ContextMapping[])
      .filter((m) => m.fieldName?.trim())
      .map((m) => ({ ...m, jsonPath: m.jsonPath?.trim() || `$.${m.fieldName.trim()}` }));

    const reportFieldRows = (v.reportFields as Array<{
      header: string;
      fieldName: string;
      dataType: FieldDataType;
      originalFieldName?: string;
    }>);

    const reportFields = reportFieldRows
      .filter((m) => m.header?.trim() && m.fieldName?.trim())
      .map((m) => ({ header: m.header.trim(), fieldName: m.fieldName.trim(), dataType: m.dataType }));

    // Renames: rows whose original (server-loaded) fieldName differs from the current value.
    // Only sent on edit; on create there is nothing historical to migrate.
    const reportFieldRenames = this.isEdit
      ? reportFieldRows
          .map((m) => ({
            oldFieldName: String(m.originalFieldName ?? '').trim(),
            newFieldName: String(m.fieldName ?? '').trim(),
          }))
          .filter((p) => p.oldFieldName && p.newFieldName && p.oldFieldName !== p.newFieldName)
      : [];

    const enrichments = (v.enrichments as Array<{
      dataFunctionId: string;
      required: boolean;
      acceptInputs: boolean;
      inputs: Array<{ param: string; source: string }>;
      outputs: Array<{ output: string; target: string }>;
    }>)
      .filter((e) => e.dataFunctionId)
      .map((e) => ({
        dataFunctionId: e.dataFunctionId,
        required: e.required,
        acceptInputs: e.acceptInputs,
        inputBindings: Object.fromEntries(
          e.inputs.filter((r) => r.param?.trim() && r.source?.trim()).map((r) => [r.param, r.source])
        ),
        outputBindings: Object.fromEntries(
          e.outputs.filter((r) => r.output?.trim() && r.target?.trim()).map((r) => [r.output, r.target])
        ),
      }));

    const request: WorkflowTemplateRequest = {
      templateKey: v.templateKey,
      name: v.name,
      description: v.description || undefined,
      defaultChannelType: v.defaultChannelType,
      callProviderKey: v.callProviderKey || undefined,
      providerAgentId: v.providerAgentId,
      providerAgentSpec: this.buildProviderAgentSpecPayload(v.providerAgentSpec),
      agentFieldBindings: this.buildAgentFieldBindingsPayload(),
      triggerEventTypes,
      maxRetries: v.maxRetries,
      retryDelayMinutes: v.retryDelayMinutes,
      requiredFields: v.requiredFields,
      enrichments: enrichments.length ? enrichments : undefined,
      steps,
      contextMappings: contextMappings.length ? contextMappings : undefined,
      reportFields: reportFields.length ? reportFields : undefined,
      // Undefined when nothing was ever selected or reordered, which the backend reads as
      // "every column, default order" — the shape a template starts life with.
      reportColumns: this.buildReportColumnsPayload(),
      reportFieldRenames: reportFieldRenames.length ? reportFieldRenames : undefined,
      contactExtractionConfig:
        v.contactPhone || v.contactEmail || v.contactName
          ? {
              phoneJsonPath: v.contactPhone || undefined,
              emailJsonPath: v.contactEmail || undefined,
              nameJsonPath: v.contactName || undefined,
            }
          : undefined,
    };

    this.submitting.set(true);
    this.errorMessage.set(null);

    const call$ = this.isEdit
      ? this.templateService.update(this.template()!.id, request)
      : this.templateService.create(request);

    call$
      .pipe(
        takeUntil(this.destroy$),
        timeout(15000),
        finalize(() => this.submitting.set(false))
      )
      .subscribe({
        next: () => this.saved.emit(),
        error: (err: string) => this.errorMessage.set(err),
      });
  }

  cancel(): void {
    this.cancelled.emit();
  }

  setTab(tab: 'basic' | 'input' | 'report'): void {
    this.activeTab.set(tab);
  }

  isFieldInvalid(path: string): boolean {
    const ctrl = this.form.get(path);
    return !!(ctrl?.invalid && ctrl?.touched);
  }
}
