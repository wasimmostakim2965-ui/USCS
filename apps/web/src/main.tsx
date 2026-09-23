/**
 * Browser entry point.
 *
 * The only thing decided here is where the API lives and whether the session
 * provider is real. When Supabase is not configured the dashboard still renders
 * — with an explicit banner and no sign-in — rather than failing to load, so a
 * reviewer can see the product before credentials exist.
 */
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import {
  createSessionController,
  sessionConfigFromEnv,
  unconfiguredSessionController,
} from "./session.js";
import "@cloud-wai/ui/styles.css";

const env = import.meta.env as unknown as Record<string, string | undefined>;

const apiBaseUrl = env["VITE_CLOUD_WAI_API_URL"] ?? "http://127.0.0.1:8787";
const config = sessionConfigFromEnv(env);
const session = config ? createSessionController(config) : unconfiguredSessionController();

const container = document.getElementById("root");
if (!container) throw new Error("The #root element is missing from index.html.");

createRoot(container).render(
  <App session={session} apiBaseUrl={apiBaseUrl} misconfigured={config === null} />,
);
