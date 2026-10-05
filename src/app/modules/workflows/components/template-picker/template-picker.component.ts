import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { LucideAngularModule } from 'lucide-angular';
import { WorkflowTemplateService } from '../../services/workflow-template.service';
import { WorkflowTemplate } from '../../models/workflow-template.model';

/**
 * Searchable workflow-template dropdown. Used both as a list filter (where "Any" is a real choice)
 * and inside the trigger modal (where a template must be chosen before anything else can happen).
 *
 * The list is fetched the first time the menu opens, so a page that never touches the picker never
 * pays for it.
 */
@Component({
  selector: 'app-template-picker',
  imports: [CommonModule, LucideAngularModule],
  templateUrl: './template-picker.component.html',
  styleUrl: './template-picker.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(document:keydown.escape)': 'close()',
  },
})
export class TemplatePickerComponent {
  private readonly templateService = inject(WorkflowTemplateService);
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly selectedId = input<string>('');
  readonly placeholder = input<string>('Select a workflow template…');
  /** Adds an explicit "Any template" entry — meaningful for a filter, not for a trigger. */
  readonly allowAny = input<boolean>(false);
  readonly anyLabel = input<string>('Any template');
  readonly disabled = input<boolean>(false);
  /** Restricts the list to a single status, e.g. 'ACTIVE' for pickers that trigger a real run. */
  readonly statusFilter = input<string | undefined>(undefined);

  readonly selected = output<WorkflowTemplate | null>();

  protected readonly templates = signal<WorkflowTemplate[]>([]);
  protected readonly loading = signal(false);
  protected readonly open = signal(false);
  protected readonly search = signal('');

  protected readonly selectedTemplate = computed(
    () => this.templates().find((t) => t.id === this.selectedId()) ?? null
  );

  /** Matches on name or template key, so "PAAS" finds a template named for its event. */
  protected readonly filtered = computed(() => {
    const term = this.search().trim().toLowerCase();
    if (!term) return this.templates();
    return this.templates().filter(
      (t) =>
        t.name?.toLowerCase().includes(term) || t.templateKey?.toLowerCase().includes(term)
    );
  });

  protected readonly label = computed(() => {
    const template = this.selectedTemplate();
    if (template) return template.name;
    if (this.selectedId()) return this.selectedId(); // loaded before the list arrived
    return this.allowAny() ? this.anyLabel() : this.placeholder();
  });

  protected toggle(): void {
    if (this.disabled()) return;
    if (this.open()) {
      this.close();
      return;
    }
    this.open.set(true);
    this.search.set('');
    this.loadTemplates();
  }

  protected close(): void {
    this.open.set(false);
  }

  protected onDocumentClick(event: MouseEvent): void {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) {
      this.close();
    }
  }

  protected onSearch(value: string): void {
    this.search.set(value);
  }

  protected pick(template: WorkflowTemplate | null): void {
    this.selected.emit(template);
    this.close();
  }

  private loadTemplates(): void {
    if (this.templates().length || this.loading()) return;
    this.loading.set(true);
    this.templateService.list({ size: 200, status: this.statusFilter() }).subscribe({
      next: (res) => {
        this.templates.set(res.items);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }
}
