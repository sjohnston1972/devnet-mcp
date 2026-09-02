/**
 * Same-origin gate for the JSON API routes.
 *
 * This is defense-in-depth, not a substitute for authentication: it only
 * constrains browsers, which are required by the fetch/XHR spec to attach an
 * `Origin` (and usually `Referer`) header reflecting the calling page's
 * origin. A non-browser client (curl, a script) can simply omit both headers
 * and this check will not see it — that is expected and is why per-IP rate
 * limiting (see rate-limiter.ts) exists as the layer that actually bounds
 * non-browser abuse.
 *
 * The allowed origin is derived from the request's own URL host rather than
 * a hardcoded domain, so this works unmodified across the production custom
 * domain, a workers.dev preview, and `wrangler dev` on localhost.
 */
export function sameOrigin(request: Request): boolean {
  const selfHost = new URL(request.url).host;

  const origin = request.headers.get("origin");
  if (origin) {
    return hostMatches(origin, selfHost);
  }

  const referer = request.headers.get("referer");
  if (referer) {
    return hostMatches(referer, selfHost);
  }

  // Neither header present: some browsers omit both for same-origin
  // requests, and every non-browser HTTP client omits them by default.
  // Blocking here would break legitimate same-origin use without actually
  // stopping the non-browser abuse case, so we allow.
  return true;
}

function hostMatches(url: string, selfHost: string): boolean {
  try {
    return new URL(url).host === selfHost;
  } catch {
    return false;
  }
}
