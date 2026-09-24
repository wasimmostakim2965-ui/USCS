/**
 * Request identifiers.
 *
 * A write that the server can replay must carry a key the server can recognise
 * on the second attempt. The key has to be stable across a retry of the *same*
 * intent and different for a new one, so it is minted once when a form opens and
 * sent unchanged if the operator presses the button again.
 */
export function newRequestId(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  // A UUID is preferred; this fallback only has to be unique among one
  // operator's open forms, which a time-plus-random pair is.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
