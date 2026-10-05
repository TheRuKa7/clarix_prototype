import {
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
  output,
  signal,
  computed,
  effect,
  untracked,
  OnInit,
  OnDestroy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule } from 'lucide-angular';
import { Subject, timeout, interval } from 'rxjs';
import { takeUntil, finalize } from 'rxjs/operators';
import { WorkflowTemplateService } from '../../services/workflow-template.service';
import { WorkflowExecutionService } from '../../services/workflow-execution.service';
import {
  WorkflowTemplate,
  BulkTriggerResult,
  ReportFieldMapping,
} from '../../models/workflow-template.model';
import { ContactKey, resolveTriggerInputs, TriggerInputs } from '../../utils/trigger-inputs';
import { downloadCsv, downloadSampleCsv, escapeCsvCell } from '../../utils/csv-download';
import { countCsvDataRows, RowCountJob } from '../../utils/csv-row-count';
import { matchContactHeaders, normaliseHeader } from '../../utils/contact-header-aliases';

interface ContactColumnMapping {
  phone: string;
  name: string;
  email: string;
}

const HEADER_READ_BYTES = 64 * 1024;
const IN_PROGRESS_POLL_MS = 12_000;

@Component({
  selector: 'app-csv-bulk-upload',
  imports: [CommonModule, FormsModule, LucideAngularModule],
  templateUrl: './csv-bulk-upload.component.html',
  styleUrl: './csv-bulk-upload.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CsvBulkUploadComponent implements OnInit, OnDestroy {
  private readonly templateService = inject(WorkflowTemplateService);
  private readonly executionService = inject(WorkflowExecutionService);
  private readonly destroy$ = new Subject<void>();

  private rowCountJob: RowCountJob | null = null;
  /** Guards against a stale count landing after the user swapped files. */
  private rowCountToken = 0;

  /**
   * Preset by the templates page, where the template is already chosen. Left null when the modal is
   * opened from the triggers-sheet page, which asks for the template inside the dialog instead.
   */
  readonly template = input<WorkflowTemplate | null>(null);
  readonly closed = output<void>();
  readonly completed = output<BulkTriggerResult>();

  /** Live count of currently IN_PROGRESS executions for this template. */
  protected readonly allInProgress = signal(0);

  protected readonly file = signal<File | null>(null);
  protected readonly headers = signal<string[]>([]);
  protected readonly parsing = signal(false);
  /** Data rows in the selected file, or null while counting / when the count failed. */
  protected readonly rowCount = signal<number | null>(null);
  protected readonly countingRows = signal(false);
  protected readonly submitting = signal(false);
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly result = signal<BulkTriggerResult | null>(null);

  protected readonly contextMapping = signal<Record<string, string>>({});
  protected readonly enrichmentInputMapping = signal<Record<string, string>>({});
  protected readonly reportMapping = signal<Record<string, string>>({});
  protected readonly contactMapping = signal<ContactColumnMapping>({ phone: '', name: '', email: '' });
  /** CSV header that provides the per-row scheduled run time ('' = none → run immediately). */
  protected readonly scheduledAtColumn = signal<string>('');
  protected readonly eventType = signal<string>('');

  /** Chosen inside the dialog when no template was passed in. */
  private readonly pickedTemplate = signal<WorkflowTemplate | null>(null);

  /** The template this upload targets, however it was chosen. Null until one is picked. */
  protected readonly activeTemplate = computed<WorkflowTemplate | null>(
    () => this.pickedTemplate() ?? this.template()
  );

  /** Active agents for the dropdown; the one passed in is preselected and can be changed. */
  protected readonly agentOptions = signal<WorkflowTemplate[]>([]);
  protected readonly agentsLoading = signal(true);
  private readonly loadAgents = this.templateService.list({ size: 200, status: 'ACTIVE' }).subscribe({
    next: (r) => { this.agentOptions.set(r.items); this.agentsLoading.set(false); },
    error: () => this.agentsLoading.set(false),
  });
  protected pickById(id: string): void { this.onTemplatePicked(this.agentOptions().find((t) => t.id === id) ?? null); }

  /** True when the dialog has to ask for the template itself. */
  protected readonly needsTemplate = computed(() => this.template() === null);

  /** Effective inputs once Data Function enrichments are accounted for. */
  protected readonly triggerInputs = computed<TriggerInputs>(() => {
    const template = this.activeTemplate();
    return template
      ? resolveTriggerInputs(template)
      : { contactKeys: [], contextParams: [], enrichmentInputs: [] };
  });
  /** Context params still collected directly (not produced by an enrichment). */
  protected readonly contextMappings = computed(() => this.triggerInputs().contextParams);
  /** Deduped enrichment input source keys collected from the CSV. */
  protected readonly enrichmentInputs = computed(() => this.triggerInputs().enrichmentInputs);
  protected readonly reportFields = computed<ReportFieldMapping[]>(
    () => this.activeTemplate()?.reportFields ?? []
  );
  protected readonly eventTypeOptions = computed(() => this.activeTemplate()?.triggerEventTypes ?? []);

  /** Contact fields still collected (not produced by an enrichment). */
  protected readonly contactKeys = computed<ContactKey[]>(() => this.triggerInputs().contactKeys);

  /**
   * How many distinct CSV columns auto-matching recognised. A snapshot taken when the file is
   * parsed, not a live tally: it answers "did the system understand my sheet", so it must not
   * drift upward as the user maps the leftovers by hand. A column bound to two fields counts once.
   */
  protected readonly autoMappedColumnCount = signal(0);

  /** Rows whose phone number is not a valid mobile number, or repeats an earlier row. */
  protected readonly phoneIssues = signal<PhoneIssues | null>(null);
  /** Leave those rows out of the upload (default), so nothing invalid reaches the dialler. */
  protected readonly skipBadRows = signal(true);
  protected readonly badRowCount = computed(() => {
    const i = this.phoneIssues();
    return i ? i.invalid.length + i.duplicate.length : 0;
  });

  constructor() {
    effect(() => {
      const file = this.file();
      const col = this.contactMapping().phone;
      untracked(() => this.checkPhones(file, col));
    });
    queueMicrotask(() => {
      const opts = this.eventTypeOptions();
      if (opts.length && !this.eventType()) {
        this.eventType.set(opts[0]);
      }
    });
  }

  ngOnInit(): void {
    this.loadInProgressCount();
    // Keep the count live while the dialog is open.
    interval(IN_PROGRESS_POLL_MS)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.loadInProgressCount());
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /**
   * Loads the IN_PROGRESS count (size=1 → only totalElements is used). Opened from the triggers
   * sheet there is no template until the user picks one, so there is nothing to count yet.
   */
  private loadInProgressCount(): void {
    const template = this.activeTemplate();
    if (!template) {
      this.allInProgress.set(0);
      return;
    }
    this.executionService
      .listByTemplate(template.id, { status: 'IN_PROGRESS', size: 1 })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => this.allInProgress.set(res.total),
        error: () => this.allInProgress.set(0),
      });
  }

  setEventType(value: string): void {
    this.eventType.set(value);
  }

  protected readonly missingMappings = computed<string[]>(() => {
    if (this.headers().length === 0) return [];
    const missing: string[] = [];
    const c = this.contactMapping();
    for (const k of this.contactKeys()) {
      if (!c[k]) missing.push(k);
    }
    const ctx = this.contextMapping();
    for (const m of this.contextMappings()) {
      if (m.required && !ctx[m.fieldName]) missing.push(m.fieldName);
    }
    const ein = this.enrichmentInputMapping();
    for (const e of this.enrichmentInputs()) {
      if (e.required && !ein[e.key]) missing.push(e.key);
    }
    return missing;
  });

  /** A sheet we know holds no data rows — a header-only file. Null means unknown, not empty. */
  protected readonly isEmptySheet = computed(() => this.rowCount() === 0);

  protected readonly canSubmit = computed(
    () =>
      !!this.activeTemplate() &&
      !!this.file() &&
      this.headers().length > 0 &&
      // Only a confirmed zero blocks the trigger; a count still running or one that failed leaves
      // this null, and the backend rejects an empty sheet anyway.
      !this.isEmptySheet() &&
      this.missingMappings().length === 0 &&
      !this.submitting()
  );

  /**
   * Switching template invalidates every mapping, since the fields to map come from the template.
   * The file survives — its headers are re-matched against the new template's fields.
   */
  onTemplatePicked(template: WorkflowTemplate | null): void {
    if (template?.id === this.activeTemplate()?.id) return;
    this.pickedTemplate.set(template);
    this.result.set(null);
    this.errorMessage.set(null);
    this.eventType.set(template?.triggerEventTypes?.[0] ?? '');

    const headers = this.headers();
    this.clearMappings();
    if (headers.length && template) {
      this.autoMatchHeaders(headers);
    }
    this.loadInProgressCount();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const selected = input.files?.[0] ?? null;
    this.resetMapping();
    this.file.set(selected);
    if (selected) {
      this.parseHeaders(selected);
    }
  }

  /** Drops the column choices only; the file and its headers stay put. */
  private clearMappings(): void {
    this.autoMappedColumnCount.set(0);
    this.contextMapping.set({});
    this.enrichmentInputMapping.set({});
    this.reportMapping.set({});
    this.contactMapping.set({ phone: '', name: '', email: '' });
    this.scheduledAtColumn.set('');
  }

  /** Drops everything derived from the file, for when the file itself changes. */
  private resetMapping(): void {
    this.cancelRowCount();
    this.rowCount.set(null);
    this.headers.set([]);
    this.clearMappings();
    this.errorMessage.set(null);
    this.result.set(null);
  }

  private async parseHeaders(file: File): Promise<void> {
    this.parsing.set(true);
    try {
      const slice = file.slice(0, Math.min(file.size, HEADER_READ_BYTES));
      const text = await slice.text();
      const firstLine = this.extractFirstLine(text);
      if (!firstLine) {
        this.errorMessage.set('CSV file is empty or unreadable');
        return;
      }
      const parsed = this.parseCsvLine(firstLine);
      if (parsed.length === 0) {
        this.errorMessage.set('Could not detect any column headers');
        return;
      }
      this.headers.set(parsed);
      this.autoMatchHeaders(parsed);
      // Headers come from a 64 KB slice and land immediately; the row count walks the whole file,
      // so let it run behind the mapping UI rather than holding the dialog on it.
      this.startRowCount(file);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to read CSV file';
      this.errorMessage.set(msg);
    } finally {
      this.parsing.set(false);
    }
  }

  private startRowCount(file: File): void {
    this.cancelRowCount();
    const token = ++this.rowCountToken;
    this.countingRows.set(true);

    const job = countCsvDataRows(file);
    this.rowCountJob = job;

    job.result
      .then((rows) => {
        // A slower count for a file the user has already replaced must not overwrite the new one.
        if (token !== this.rowCountToken) return;
        this.rowCount.set(rows);
        this.countingRows.set(false);
        this.rowCountJob = null;
      })
      .catch(() => {
        if (token !== this.rowCountToken) return;
        // The row count is a nicety; a failure leaves it blank rather than blocking the upload.
        this.rowCount.set(null);
        this.countingRows.set(false);
        this.rowCountJob = null;
      });
  }

  private cancelRowCount(): void {
    this.rowCountJob?.cancel();
    this.rowCountJob = null;
    this.rowCountToken++;
    this.countingRows.set(false);
  }

  private extractFirstLine(text: string): string {
    const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const nlIdx = stripped.search(/\r\n|\n|\r/);
    return nlIdx === -1 ? stripped : stripped.slice(0, nlIdx);
  }

  private parseCsvLine(line: string): string[] {
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

  private autoMatchHeaders(headers: string[]): void {
    const norm = normaliseHeader;
    const map = new Map(headers.map((h) => [norm(h), h]));

    const nextFields: Record<string, string> = {};
    for (const m of this.contextMappings()) {
      const match = map.get(norm(m.fieldName));
      if (match) nextFields[m.fieldName] = match;
    }
    this.contextMapping.set(nextFields);

    const nextEnrichmentInputs: Record<string, string> = {};
    for (const e of this.enrichmentInputs()) {
      const match = map.get(norm(e.key));
      if (match) nextEnrichmentInputs[e.key] = match;
    }
    this.enrichmentInputMapping.set(nextEnrichmentInputs);

    const nextReport: Record<string, string> = {};
    for (const m of this.reportFields()) {
      const match = map.get(norm(m.fieldName)) ?? map.get(norm(m.header));
      if (match) nextReport[m.fieldName] = match;
    }
    this.reportMapping.set(nextReport);

    // Contact columns are spelled a dozen ways ("Mobile No", "Contact Number"), so they match
    // against an alias table rather than their own field name. Only the keys the trigger still
    // collects — a contact an enrichment derives has no column to map.
    const nextContact: ContactColumnMapping = { phone: '', name: '', email: '' };
    const contactMatches = matchContactHeaders(this.contactKeys(), headers);
    for (const [key, header] of Object.entries(contactMatches)) {
      nextContact[key as ContactKey] = header;
    }
    this.contactMapping.set(nextContact);

    const scheduledMatch = map.get('scheduledat') ?? map.get('scheduleat') ?? map.get('schedule');
    this.scheduledAtColumn.set(scheduledMatch ?? '');

    // Distinct CSV columns these guesses consumed — a column feeding two fields is still one column.
    const matched = new Set<string>([
      ...Object.values(nextFields),
      ...Object.values(nextEnrichmentInputs),
      ...Object.values(nextReport),
      nextContact.phone,
      nextContact.name,
      nextContact.email,
      scheduledMatch ?? '',
    ]);
    matched.delete('');
    this.autoMappedColumnCount.set(matched.size);
  }

  setContextMapping(key: string, value: string): void {
    const next = { ...this.contextMapping() };
    if (value) {
      next[key] = value;
    } else {
      delete next[key];
    }
    this.contextMapping.set(next);
  }

  setEnrichmentInputMapping(key: string, value: string): void {
    const next = { ...this.enrichmentInputMapping() };
    if (value) {
      next[key] = value;
    } else {
      delete next[key];
    }
    this.enrichmentInputMapping.set(next);
  }

  setContactMapping(key: keyof ContactColumnMapping, value: string): void {
    this.contactMapping.set({ ...this.contactMapping(), [key]: value });
  }

  setReportMapping(key: string, value: string): void {
    const next = { ...this.reportMapping() };
    if (value) {
      next[key] = value;
    } else {
      delete next[key];
    }
    this.reportMapping.set(next);
  }

  setScheduledAtColumn(value: string): void {
    this.scheduledAtColumn.set(value ?? '');
  }

  removeFile(): void {
    this.file.set(null);
    this.resetMapping();
  }

  resetAll(): void {
    this.file.set(null);
    this.resetMapping();
    this.submitting.set(false);
  }

  cancel(): void {
    this.cancelRowCount(); // don't leave a worker chewing through a large sheet after we're gone
    this.destroy$.next();
    this.closed.emit();
  }

  /**
   * Reads the sheet once the phone column is known and lists rows that would fail at
   * the dialler: not a 10 digit Indian mobile number (after dropping +91 or a leading
   * 0), or the same number again. Skipped for very large files.
   */
  private async checkPhones(file: File | null, col: string): Promise<void> {
    if (!file || !col || file.size > PHONE_CHECK_MAX_BYTES) { this.phoneIssues.set(null); return; }
    const lines = (await file.text()).split(/\r?\n/);
    const idx = this.parseCsvLine(lines[0] ?? '').indexOf(col);
    if (idx < 0) { this.phoneIssues.set(null); return; }
    const seen = new Map<string, number>();
    const invalid: PhoneIssue[] = [];
    const duplicate: PhoneIssue[] = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const value = (this.parseCsvLine(lines[i])[idx] ?? '').trim();
      const n = normalisePhone(value);
      if (!n) invalid.push({ row: i + 1, value });
      else if (seen.has(n)) duplicate.push({ row: i + 1, value, firstRow: seen.get(n) });
      else seen.set(n, i + 1);
    }
    if (this.file() === file) this.phoneIssues.set({ invalid, duplicate });
  }

  /** The sheet without the flagged rows, keeping the header and every other line as is. */
  private async withoutBadRows(file: File): Promise<File> {
    const issues = this.phoneIssues();
    if (!issues || !this.badRowCount() || !this.skipBadRows()) return file;
    const drop = new Set([...issues.invalid, ...issues.duplicate].map((r) => r.row - 1));
    const lines = (await file.text()).split(/\r?\n/);
    const kept = lines.filter((_, i) => !drop.has(i));
    return new File([kept.join('\n')], file.name, { type: file.type || 'text/csv' });
  }

  async submit(): Promise<void> {
    const original = this.file();
    const file = original ? await this.withoutBadRows(original) : null;
    const template = this.activeTemplate();
    if (!file || !template || !this.canSubmit()) return;

    const contact = this.contactMapping();
    const columnMapping = {
      contact: {
        phone: contact.phone || undefined,
        name: contact.name || undefined,
        email: contact.email || undefined,
      },
      fields: { ...this.contextMapping() },
      enrichmentInputs: { ...this.enrichmentInputMapping() },
      reportFields: { ...this.reportMapping() },
      scheduledAt: this.scheduledAtColumn() || undefined,
    };

    this.submitting.set(true);
    this.errorMessage.set(null);

    this.templateService
      .triggerBulk({
        file,
        templateId: template.id,
        eventType: this.eventType() || undefined,
        columnMapping,
      })
      .pipe(
        takeUntil(this.destroy$),
        timeout(120000),
        finalize(() => this.submitting.set(false))
      )
      .subscribe({
        next: (res) => {
          this.result.set(res);
          this.completed.emit(res);
          this.loadInProgressCount();
        },
        error: (err: string) => this.errorMessage.set(err),
      });
  }

  /** Header-only sheet the user fills in. Lives here rather than on the card: you want it at the
   *  moment you realise you don't have a file, not before you opened the dialog. */
  downloadSample(): void {
    const template = this.activeTemplate();
    if (template) downloadSampleCsv(template);
  }

  async downloadResultCsv(): Promise<void> {
    const file = this.file();
    const res = this.result();
    if (!file || !res?.rows?.length) return;

    const statusByRow = new Map<number, { status: string; reason: string }>();
    for (const r of res.rows) statusByRow.set(r.row, { status: r.status, reason: r.reason });

    const text = await file.text();
    const lines = this.splitCsvLines(text);
    if (lines.length === 0) return;

    const output: string[] = [];
    output.push(lines[0] + ',Status,Reason');
    for (let i = 1; i < lines.length; i++) {
      const lookup = statusByRow.get(i);
      const status = lookup?.status ?? '';
      const reason = lookup?.reason ?? '';
      output.push(`${lines[i]},${escapeCsvCell(status)},${escapeCsvCell(reason)}`);
    }

    downloadCsv(file.name.replace(/\.csv$/i, '') + '_result.csv', output.join('\n'));
  }

  private splitCsvLines(text: string): string[] {
    const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const lines: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < stripped.length; i++) {
      const ch = stripped[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
        current += ch;
      } else if (!inQuotes && (ch === '\n' || ch === '\r')) {
        if (current.length > 0) lines.push(current);
        current = '';
        if (ch === '\r' && stripped[i + 1] === '\n') i++;
      } else {
        current += ch;
      }
    }
    if (current.length > 0) lines.push(current);
    return lines;
  }
}

interface PhoneIssue { row: number; value: string; firstRow?: number; }
interface PhoneIssues { invalid: PhoneIssue[]; duplicate: PhoneIssue[]; }
const PHONE_CHECK_MAX_BYTES = 5_000_000;

/** 10 digit Indian mobile number, or null. Accepts +91, 91 or 0 in front and any spacing. */
function normalisePhone(value: string): string | null {
  let d = value.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}
