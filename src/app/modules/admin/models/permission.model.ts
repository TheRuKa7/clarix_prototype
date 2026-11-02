export interface Permission {
  id: string;
  key: string;
  displayName: string;
  description?: string;
  category: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PermissionRequest {
  key: string;
  displayName: string;
  description?: string;
  category: string;
}

export interface ModuleEntity {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  permissions: string[];
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface ModuleRequest {
  name: string;
  displayName: string;
  description?: string;
  permissions: string[];
}

export interface BaseResponse<T> {
  status: boolean;
  message: string;
  code?: number;
  data: T;
  totalElements?: number;
}
