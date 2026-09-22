import { trpc } from "@/lib/trpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { createRoot } from "react-dom/client";
import App from "./App";
import { getSupabaseSession } from "./lib/supabase";
import "./index.css";
import "./auth.css";

const queryClient = new QueryClient();

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      async headers() {
        const supabaseSession = await getSupabaseSession();
        if (supabaseSession.data.session?.access_token) {
          return { Authorization: `Bearer ${supabaseSession.data.session.access_token}` };
        }
        return {};
      },
      async fetch(input, init) {
        const response = await globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          return new Response(JSON.stringify({ error: { message: "The API endpoint returned a non-JSON response. Check the deployment API route." } }), {
            status: response.status >= 400 ? response.status : 502,
            headers: { "content-type": "application/json" },
          });
        }
        return response;
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
