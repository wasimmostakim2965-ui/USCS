import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getDatabaseAdapter, getStorageAdapter } from "./adapters/data";

describe("data foundation", () => {
  it("keeps database and storage provisioning honest without adapters", async () => {
    const database = getDatabaseAdapter();
    const storage = getStorageAdapter();
    const databaseResult = await database.provisionDatabase({ databaseInstanceId: "database", organizationId: "organization", name: "primary" });
    const storageResult = await storage.provisionBucket({ bucketId: "bucket", organizationId: "organization", name: "uploads", visibility: "private" });
    const fileResult = await storage.uploadFile({ fileId: "file", bucketId: "bucket", organizationId: "organization", objectKey: "logo.svg" });
    const restoreResult = await storage.restoreBackup({ backupId: "backup", organizationId: "organization", resourceType: "storage", resourceId: "bucket" });
    const databaseBackup = await database.createBackup({ backupId: "backup", organizationId: "organization", resourceType: "database", resourceId: "database" });
    expect(databaseResult.configured).toBe(false);
    expect(storageResult.configured).toBe(false);
    expect(fileResult.configured).toBe(false);
    expect(restoreResult.configured).toBe(false);
    expect(databaseBackup.configured).toBe(false);
    expect(databaseResult.reason).toContain("not configured");
    expect(storageResult.reason).toContain("not configured");
  });

  it("keeps data resources tenant-scoped and mutations auditable", () => {
    const migration = readFileSync(new URL("../supabase/migrations/20260922150000_data_services.sql", import.meta.url), "utf8");
    const router = readFileSync(new URL("./routers.ts", import.meta.url), "utf8");
    expect(migration).toContain("alter table public.database_instances enable row level security");
    expect(migration).toContain("alter table public.storage_buckets enable row level security");
    expect(migration).toContain("alter table public.backups enable row level security");
    expect(migration.match(/private\.is_organization_member\(organization_id\)/g)?.length).toBeGreaterThanOrEqual(9);
    expect(router).toContain('action: "database_instance.provision"');
    expect(router).toContain('action: "storage_bucket.provision"');
    expect(router).toContain('action: "backup.create"');
    expect(router).toContain('action: "storage_file.upload"');
    expect(router).toContain('action: "backup.restore"');
    const depthMigration = readFileSync(new URL("../supabase/migrations/20260922192000_data_depth.sql", import.meta.url), "utf8");
    expect(depthMigration).toContain("alter table public.storage_files enable row level security");
    expect(depthMigration).toContain("alter table public.backup_schedules enable row level security");
  });
});
