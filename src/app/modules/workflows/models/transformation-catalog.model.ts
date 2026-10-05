export type TransformationStatus = 'LIVE' | 'PLANNED';

/** A read-only, documented description of a reshaping step in the CSV-to-call pipeline. */
export interface TransformationCatalogEntry {
  id: string;
  name: string;
  description: string;
  input: string;
  output: string;
  status: TransformationStatus;
  usageCount?: number;
}
