import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { LucideAngularModule } from 'lucide-angular';
import { FieldDataType } from '../../models/workflow-template.model';
import { FilterOperator, ReportFilter } from '../../models/execution-report.model';
import {
  CHANNEL_TYPE_VALUES,
  OPERATOR_LABELS,
  ReportColumnMeta,
  WORKFLOW_STATUS_VALUES,
  operatorArity,
  operatorIsMulti,
  operatorsFor,
} from '../../utils/report-columns';

interface FilterRow {
  columnId: string;
  operator: FilterOperator;
  values: string[];
}

/**
 * Report filter editor: a list of conditions, each a column + an operator (constrained by the
 * column's data type) + value(s). Enum columns (status/channel) offer their known value set. Emits
 * a {@link ReportFilter}[] on any change.
 */
@Component({
  selector: 'app-report-filters',
  imports: [CommonModule, LucideAngularModule],
  templateUrl: './report-filters.component.html',
  styleUrl: './report-filters.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportFiltersComponent {
  readonly columns = input<ReportColumnMeta[]>([]);
  readonly initialFilters = input<ReportFilter[]>([]);
  readonly filtersChange = output<ReportFilter[]>();

  protected readonly rows = signal<FilterRow[]>([]);
  protected readonly OPERATOR_LABELS = OPERATOR_LABELS;
  protected readonly FieldDataType = FieldDataType;

  private hydrated = false;

  constructor() {
    effect(() => {
      const init = this.initialFilters();
      if (!this.hydrated && init.length) {
        this.rows.set(init.map((f) => ({ columnId: f.columnId, operator: f.operator, values: [...(f.values ?? [])] })));
        this.hydrated = true;
      }
    });
  }

  protected readonly filterable = computed(() => this.columns().filter((c) => c.filterable));

  columnMeta(id: string): ReportColumnMeta | undefined {
    return this.columns().find((c) => c.id === id);
  }

  operatorsForRow(row: FilterRow): FilterOperator[] {
    const meta = this.columnMeta(row.columnId);
    return meta ? operatorsFor(meta.dataType) : [];
  }

  arity(op: FilterOperator): 0 | 1 | 2 {
    return operatorArity(op);
  }

  isMulti(op: FilterOperator): boolean {
    return operatorIsMulti(op);
  }

  enumValues(row: FilterRow): string[] {
    const meta = this.columnMeta(row.columnId);
    if (meta?.enumKind === 'status') return WORKFLOW_STATUS_VALUES;
    if (meta?.enumKind === 'channel') return CHANNEL_TYPE_VALUES;
    return [];
  }

  isEnum(row: FilterRow): boolean {
    return this.enumValues(row).length > 0;
  }

  inputType(row: FilterRow): string {
    switch (this.columnMeta(row.columnId)?.dataType) {
      case FieldDataType.NUMBER:
        return 'number';
      case FieldDataType.DATE:
        return 'date';
      default:
        return 'text';
    }
  }

  hasEnumValue(row: FilterRow, value: string): boolean {
    return row.values.includes(value);
  }

  addRow(): void {
    const first = this.filterable()[0];
    if (!first) return;
    this.rows.update((r) => [...r, { columnId: first.id, operator: operatorsFor(first.dataType)[0], values: [] }]);
    this.emit();
  }

  removeRow(index: number): void {
    this.rows.update((r) => r.filter((_, i) => i !== index));
    this.emit();
  }

  setColumn(index: number, columnId: string): void {
    const meta = this.columnMeta(columnId);
    const op = meta ? operatorsFor(meta.dataType)[0] : FilterOperator.EQUALS;
    this.rows.update((r) => r.map((row, i) => (i === index ? { columnId, operator: op, values: [] } : row)));
    this.emit();
  }

  setOperator(index: number, op: FilterOperator): void {
    this.rows.update((r) => r.map((row, i) => (i === index ? { ...row, operator: op, values: [] } : row)));
    this.emit();
  }

  setValue(index: number, valueIndex: number, value: string): void {
    this.rows.update((r) =>
      r.map((row, i) => {
        if (i !== index) return row;
        const values = [...row.values];
        values[valueIndex] = value;
        return { ...row, values };
      })
    );
    this.emit();
  }

  setCsvValues(index: number, csv: string): void {
    const values = csv.split(',').map((s) => s.trim()).filter(Boolean);
    this.rows.update((r) => r.map((row, i) => (i === index ? { ...row, values } : row)));
    this.emit();
  }

  toggleEnumValue(index: number, value: string, checked: boolean): void {
    this.rows.update((r) =>
      r.map((row, i) => {
        if (i !== index) return row;
        const set = new Set(row.values);
        if (checked) set.add(value);
        else set.delete(value);
        return { ...row, values: Array.from(set) };
      })
    );
    this.emit();
  }

  private emit(): void {
    const filters: ReportFilter[] = this.rows().map((row) => ({
      columnId: row.columnId,
      dataType: this.columnMeta(row.columnId)?.dataType ?? FieldDataType.STRING,
      operator: row.operator,
      values: row.values,
    }));
    this.filtersChange.emit(filters);
  }
}
