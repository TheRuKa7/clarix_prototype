export type DataFunctionType = 'SQL' | 'REST';

export type FieldDataType = 'STRING' | 'NUMBER' | 'BOOLEAN' | 'DATE' | 'JSON';

export const FIELD_DATA_TYPES: FieldDataType[] = ['STRING', 'NUMBER', 'BOOLEAN', 'DATE', 'JSON'];

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export interface DataFunctionParam {
  name: string;
  dataType: FieldDataType;
  required: boolean;
  description?: string;
}

export interface DataFunctionOutput {
  name: string;
  dataType: FieldDataType;
  /** SQL: column to read from the first row. */
  sourceColumn?: string;
  /** REST: JSON path against the response body. */
  jsonPath?: string;
}

export interface SqlConfig {
  query: string;
}

export interface RestConfig {
  method: string;
  url: string;
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  bodyTemplate?: string;
}

export interface DataFunction {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  type: DataFunctionType;
  parameters: DataFunctionParam[];
  outputs: DataFunctionOutput[];
  sqlConfig?: SqlConfig;
  restConfig?: RestConfig;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DataFunctionRequest {
  name: string;
  description?: string;
  enabled: boolean;
  type: DataFunctionType;
  parameters: DataFunctionParam[];
  outputs: DataFunctionOutput[];
  sqlConfig?: SqlConfig;
  restConfig?: RestConfig;
}

export interface DataFunctionTestResult {
  success: boolean;
  message?: string;
  outputs?: Record<string, unknown>;
  raw?: unknown;
  durationMs: number;
}

export interface BaseResponse<T> {
  status: boolean;
  message: string;
  code?: number;
  data: T;
  totalElements?: number;
}
