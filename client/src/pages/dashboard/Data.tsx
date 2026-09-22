import { trpc } from "@/lib/trpc";
import { Empty, Header, Stat } from "./shared";
export default function Data() {
  const databases = trpc.data.databaseInstances.list.useQuery(undefined, { retry: false });
  const buckets = trpc.data.storageBuckets.list.useQuery(undefined, { retry: false });
  const backups = trpc.data.backups.list.useQuery(undefined, { retry: false });
  return <><Header title="Data" /><div className="vc-grid-3"><Stat label="Databases" value={databases.isLoading ? "—" : String(databases.data?.length ?? 0)} /><Stat label="Buckets" value={buckets.isLoading ? "—" : String(buckets.data?.length ?? 0)} /><Stat label="Backups" value={backups.isLoading ? "—" : String(backups.data?.length ?? 0)} /></div><div className="vc-card"><h3>PostgreSQL databases</h3><Empty title="No database instances" body="Database metadata will appear after a real self-hosted Postgres adapter is configured." /></div><div className="vc-card"><h3>Object storage buckets</h3><Empty title="No storage resources" body="Bucket metadata will appear after a real self-hosted MinIO adapter is configured." /></div></>;
}
