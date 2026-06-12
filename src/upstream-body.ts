/**
 * Decide what body (if any) to forward to Meraki. Returns undefined when
 * no body should be attached to the upstream request.
 */
export function upstreamBodyFor(method: string, body: unknown): string | undefined {
  // null means "snippet had no payload" (client default) — send nothing.
  if (body === undefined || body === null || method === "GET" || method === "DELETE") {
    return undefined;
  }
  return typeof body === "string" ? body : JSON.stringify(body);
}
