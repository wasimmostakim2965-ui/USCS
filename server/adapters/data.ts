export type DataResourceResult =
  | { configured: true; adapterRef: string; status: "provisioning" | "ready"; tenantIdentifier?: string | null }
  | { configured: false; reason: string };

export type BackupResult =
  | { configured: true; adapterRef: string; status: "running" | "completed"; sizeBytes?: number | null }
  | { configured: false; reason: string };

export type DatabaseProvisionRequest = { databaseInstanceId: string; organizationId: string; projectId?: string | null; name: string };
export type StorageProvisionRequest = { bucketId: string; organizationId: string; projectId?: string | null; name: string; visibility: "private" | "public"; region?: string | null };
export type BackupRequest = { backupId: string; organizationId: string; resourceType: "database" | "storage"; resourceId: string };
export type StorageFileRequest = { fileId: string; bucketId: string; organizationId: string; objectKey: string; contentType?: string | null };
export type StorageFileResult = { configured: true; adapterRef: string; status: "pending" | "ready"; sizeBytes?: number | null } | { configured: false; reason: string };

export interface DatabaseAdapter {
  readonly name: string;
  readonly configured: boolean;
  provisionDatabase(request: DatabaseProvisionRequest): Promise<DataResourceResult>;
  createBackup(request: BackupRequest): Promise<BackupResult>;
  restoreBackup(request: BackupRequest): Promise<BackupResult>;
}
export interface StorageAdapter {
  readonly name: string;
  readonly configured: boolean;
  provisionBucket(request: StorageProvisionRequest): Promise<DataResourceResult>;
  createBackup(request: BackupRequest): Promise<BackupResult>;
  listFiles(bucketId: string): Promise<StorageFileResult>;
  uploadFile(request: StorageFileRequest): Promise<StorageFileResult>;
  restoreBackup(request: BackupRequest): Promise<BackupResult>;
}

export class NotConfiguredDatabaseAdapter implements DatabaseAdapter {
  readonly name = "self-hosted-postgres";
  readonly configured = false;
  async provisionDatabase(_request: DatabaseProvisionRequest): Promise<DataResourceResult> { return { configured: false, reason: "Self-hosted Postgres DatabaseAdapter is not configured." }; }
  async createBackup(_request: BackupRequest): Promise<BackupResult> { return { configured: false, reason: "Self-hosted Postgres backup engine is not configured." }; }
  async restoreBackup(_request: BackupRequest): Promise<BackupResult> { return { configured: false, reason: "Self-hosted Postgres restore engine is not configured." }; }
}

export class NotConfiguredStorageAdapter implements StorageAdapter {
  readonly name = "self-hosted-minio";
  readonly configured = false;
  async provisionBucket(_request: StorageProvisionRequest): Promise<DataResourceResult> { return { configured: false, reason: "Self-hosted MinIO StorageAdapter is not configured." }; }
  async createBackup(_request: BackupRequest): Promise<BackupResult> { return { configured: false, reason: "Self-hosted object-storage backup engine is not configured." }; }
  async listFiles(_bucketId: string): Promise<StorageFileResult> { return { configured: false, reason: "Self-hosted MinIO file browser is not configured." }; }
  async uploadFile(_request: StorageFileRequest): Promise<StorageFileResult> { return { configured: false, reason: "Self-hosted MinIO upload engine is not configured." }; }
  async restoreBackup(_request: BackupRequest): Promise<BackupResult> { return { configured: false, reason: "Self-hosted object-storage restore engine is not configured." }; }
}

export function getDatabaseAdapter(): DatabaseAdapter { return new NotConfiguredDatabaseAdapter(); }
export function getStorageAdapter(): StorageAdapter { return new NotConfiguredStorageAdapter(); }
