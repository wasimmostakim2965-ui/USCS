/**
 * The API client.
 *
 * The dashboard has exactly one way to reach the backend: `call()`, which posts
 * to the Cloud Wai API. It never constructs an engine URL, and it never has a
 * database or admin port to leak — there is nothing in this module that could.
 *
 * A response the server marked `notConfigured` is surfaced as such. It is not
 * downgraded to an error, and it is never converted into an empty success.
 */
export interface ApiClientOptions {
  readonly baseUrl: string;
  /** Returns the current Supabase access token, or null when signed out. */
  readonly getAccessToken: () => string | null;
  readonly fetchImpl?: typeof fetch;
}

export interface ApiResponse<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly data?: T;
  readonly error?: { readonly code: string; readonly message: string };
  readonly notConfigured?: boolean;
}

export class ApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  async call<T>(procedure: string, input?: unknown): Promise<ApiResponse<T>> {
    const token = this.options.getAccessToken();
    if (!token) {
      // No session: say so locally rather than making an unauthenticated call.
      return {
        ok: false,
        status: 401,
        error: { code: "unauthenticated", message: "Sign in to continue." },
      };
    }

    const doFetch = this.options.fetchImpl ?? fetch;
    try {
      const response = await doFetch(`${this.options.baseUrl.replace(/\/$/, "")}/rpc`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ procedure, input }),
      });

      const text = await response.text();
      const body = text ? (JSON.parse(text) as ApiResponse<T>) : undefined;
      if (body && typeof body.ok === "boolean") return body;

      return {
        ok: false,
        status: response.status,
        error: { code: "internal", message: "Unexpected response from the API." },
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        error: {
          code: "unreachable",
          message: error instanceof Error ? error.message : "The API is unreachable.",
        },
      };
    }
  }
}
