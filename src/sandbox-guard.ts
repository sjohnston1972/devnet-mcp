// Security guard for POST /api/sandbox-call.
//
// Kept in its own module, with its own state, deliberately: the chat
// endpoint is getting its own rate limiting / auth work from a different
// agent in parallel, and this file has no shared dependency on that work.
// If a genuinely shared helper makes sense later, factor it out then --
// don't guess at someone else's interface now.

/**
 * True if the request's Origin (or, failing that, Referer) header matches
 * `selfUrl`'s origin. A request with neither header is treated as
 * cross-origin -- fail closed, don't assume trust just because a browser
 * happened not to send one (e.g. a raw curl call never sends either).
 *
 * Issue #9: the server's own Meraki key must only ever be driven by the
 * app's own page, never an anonymous/cross-origin caller.
 */
export function isSameOrigin(request: Request, selfUrl: URL): boolean {
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).origin === selfUrl.origin;
    } catch {
      return false;
    }
  }

  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === selfUrl.origin;
    } catch {
      return false;
    }
  }

  return false;
}
