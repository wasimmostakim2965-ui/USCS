/**
 * The worker's single applier: route a settled job to the applier for its kind.
 *
 * The processor calls one `apply` after every job settles — success or failure —
 * and it is what turns a job outcome into a customer-facing row. Each job kind
 * owns its own applier, so this only has to pick one. An applier whose kind does
 * not match returns without writing, which is what lets the table be a list of
 * every applier rather than a map a caller could key wrongly.
 */
import type { AdapterResult } from "@cloud-wai/contracts";
import type { Job } from "@cloud-wai/adapters";

export type JobOutcomeWriter = (job: Job, result: AdapterResult<unknown>) => Promise<void>;

/** Combine appliers into the one the processor calls. Order does not matter. */
export function buildApplier(...appliers: readonly JobOutcomeWriter[]): JobOutcomeWriter {
  return async (job, result) => {
    for (const apply of appliers) {
      await apply(job, result);
    }
  };
}
