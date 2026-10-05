import { WorkflowTemplate } from '../models/workflow-template.model';
import { resolveTriggerInputs } from './trigger-inputs';

/** Quotes a cell only when it contains a delimiter, quote, or newline. */
export function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Hands the browser a blob as a download, then releases the object URL. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Hands the browser a generated CSV as a download. */
export function downloadCsv(filename: string, content: string): void {
  downloadBlob(filename, new Blob([content], { type: 'text/csv;charset=utf-8;' }));
}

/**
 * Header row a bulk trigger CSV for this template must supply. Values a Data Function enrichment
 * derives are left out — the sample asks for the functions' input columns instead.
 */
export function sampleCsvHeaders(template: WorkflowTemplate): string[] {
  const inputs = resolveTriggerInputs(template);
  const headers: string[] = [...inputs.contactKeys];
  for (const m of inputs.contextParams) {
    if (m?.fieldName && !headers.includes(m.fieldName)) headers.push(m.fieldName);
  }
  for (const e of inputs.enrichmentInputs) {
    if (e.key && !headers.includes(e.key)) headers.push(e.key);
  }
  return headers;
}

/** Downloads the header-only sample CSV a user fills in to bulk-trigger this template. */
export function downloadSampleCsv(template: WorkflowTemplate): void {
  const content = sampleCsvHeaders(template).map(escapeCsvCell).join(',') + '\n';
  const safeKey = (template.templateKey || template.id).replace(/[^A-Za-z0-9_-]/g, '_');
  downloadCsv(`${safeKey}_template.csv`, content);
}
