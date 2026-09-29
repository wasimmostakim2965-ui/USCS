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
  listEnabledProviders,
  unconfiguredSessionController,
  withDemoSession,
  type OAuthProvider,
  type SessionConfig,
} from "./session.js";
import "@cloud-wai/ui/styles.css";

// Read each value with static member access. Vite inlines `import.meta.env.KEY`
// only when the key is written out literally; collecting them into a record with
// a computed lookup drops some keys at build time.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey =
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ??
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined);

const apiBaseUrl =
  (import.meta.env.VITE_CLOUD_WAI_API_URL as string | undefined) ?? "http://127.0.0.1:8787";

const config: SessionConfig | null =
  supabaseUrl && supabaseAnonKey ? { url: supabaseUrl, anonKey: supabaseAnonKey } : null;
const baseSession = config ? createSessionController(config) : unconfiguredSessionController();

// Temporary no-login bypass: when the deployment enables it, the dashboard asks
// the API for a demo session and adopts it, so the landing page is skipped. The
// API holds the demo credentials; the browser never does. It is off unless
// `VITE_CLOUD_WAI_DEMO_AUTOLOGIN=1` is set at build time.
const demoEnabled = import.meta.env.VITE_CLOUD_WAI_DEMO_AUTOLOGIN === "1";

const session = config && demoEnabled ? withDemoSession(baseSession, apiBaseUrl) : baseSession;

const container = document.getElementById("root");
if (!container) throw new Error("The #root element is missing from index.html.");
const root = container;

async function bootstrap(): Promise<void> {
  // Read the enabled providers once, before the first render, so the sign-in form
  // never briefly shows a button for a provider that is switched off. A failed
  // read resolves to `null`, which offers no button rather than guessing.
  const oauthProviders: readonly OAuthProvider[] | null = config
    ? await listEnabledProviders(config)
    : null;

  createRoot(root).render(
    <App
      session={session}
      apiBaseUrl={apiBaseUrl}
      misconfigured={config === null}
      oauthProviders={oauthProviders}
    />,
  );
}

void bootstrap();
