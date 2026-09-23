/**
 * @cloud-wai/web — Cloud Wai dashboard (React, URL-driven routes). Talks only to the Cloud Wai API.
 */

export const APP_NAME = "web" as const;

export interface AppDescriptor {
  readonly name: string;
  readonly role: string;
  /** Boundaries this app enforces; asserted by tests in tests/. */
  readonly boundaries: readonly string[];
}

export function describe(): AppDescriptor {
  return {
    name: APP_NAME,
    role: "Cloud Wai dashboard (React, URL-driven routes). Talks only to the Cloud Wai API.",
    boundaries: [
      "Calls only the Cloud Wai API, never an engine, database or admin port.",
      "Renders loading/empty/success/degraded/error and no fabricated success.",
    ],
  };
}
