export interface Repository<T> {
  findById(id: string): Promise<T | undefined>;
  findAll(): Promise<T[]>;
  save(id: string, entity: T): Promise<string>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}
