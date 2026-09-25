/**
 * Error vocabulary for API procedures.
 *
 * `not_found` deliberately covers both "does not exist" and "you are not a
 * member": a caller must not be able to tell the difference, or organization ids
 * become enumerable.
 */
export class ApiError extends Error {
  readonly code:
    | "unauthenticated"
    | "forbidden"
    | "not_found"
    | "invalid_input"
    | "conflict"
    | "budget_exceeded"
    | "engine_unavailable";

  constructor(
    code: ApiError["code"],
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
