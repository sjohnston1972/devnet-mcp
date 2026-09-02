// Security guard for POST /api/sandbox-call.
//
// Kept in its own module, with its own state, deliberately: the chat
// endpoint is getting its own rate limiting / auth work from a different
// agent in parallel, and this file has no shared dependency on that work.
// If a genuinely shared helper makes sense later, factor it out then --
// don't guess at someone else's interface now.

/** The server's configured org/network/serial for a DEV or PROD slot. */
export interface SandboxTargetConfig {
  orgId: string;
  networkId: string;
  serial?: string;
}

export interface OverrideDecision {
  ok: boolean;
  orgId: string;
  netId: string;
  serial: string;
  reason?: string;
}

/**
 * Resolve which org/network/serial a /api/sandbox-call request may target.
 *
 * Issue #10: when the request is going to use the *server* Meraki key
 * (hasUserKey === false), x-user-meraki-org / x-user-meraki-network /
 * x-user-meraki-serial must never be able to retarget it. A header value
 * that disagrees with the server's configured slot is an explicit refusal
 * -- never sanitised, never silently overwritten with the server value.
 * Fails closed: if the server's own config is missing/empty and a header
 * is sent anyway, that also counts as a mismatch and is refused, not
 * passed through.
 */
export function resolveTarget(
  hasUserKey: boolean,
  headers: { org?: string; net?: string; serial?: string },
  serverConfig: SandboxTargetConfig,
): OverrideDecision {
  if (hasUserKey) {
    // The caller supplied their own credential: they may target their own
    // org/network/serial with it. The server config is only a fallback
    // default.
    return {
      ok: true,
      orgId: headers.org || serverConfig.orgId,
      netId: headers.net || serverConfig.networkId,
      serial: headers.serial || serverConfig.serial || "",
    };
  }

  if (headers.org && headers.org !== serverConfig.orgId) {
    return {
      ok: false,
      orgId: "",
      netId: "",
      serial: "",
      reason:
        "x-user-meraki-org does not match this sandbox's configured organization; " +
        "the server key cannot be retargeted. Supply x-user-meraki-key to use your own org.",
    };
  }
  if (headers.net && headers.net !== serverConfig.networkId) {
    return {
      ok: false,
      orgId: "",
      netId: "",
      serial: "",
      reason:
        "x-user-meraki-network does not match this sandbox's configured network; " +
        "the server key cannot be retargeted. Supply x-user-meraki-key to use your own network.",
    };
  }
  if (headers.serial && headers.serial !== (serverConfig.serial || "")) {
    return {
      ok: false,
      orgId: "",
      netId: "",
      serial: "",
      reason:
        "x-user-meraki-serial does not match this sandbox's configured device; " +
        "the server key cannot be retargeted. Supply x-user-meraki-key to use your own device.",
    };
  }

  return {
    ok: true,
    orgId: serverConfig.orgId,
    netId: serverConfig.networkId,
    serial: serverConfig.serial || "",
  };
}

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

/**
 * A small in-memory sliding-window rate limiter, keyed by an arbitrary
 * string (here, client IP). Deliberately simple: per-isolate state is a
 * reasonable "good enough" bound for abuse on a Worker without pulling in
 * a Durable Object / KV binding for this.
 */
export class SlidingWindowRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private hits = new Map<string, number[]>();

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Returns true (and records the hit) if under budget; false if not. */
  check(key: string): boolean {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }

    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

export interface SandboxAuditEntry {
  ts: string;
  endpoint: "/api/sandbox-call";
  method: string;
  path: string;
  env: "dev" | "prod" | null;
  resolvedOrgId: string | null;
  resolvedNetworkId: string | null;
  usedServerKey: boolean;
  ip: string;
  outcome: string;
  status: number;
}

/**
 * Emit one structured audit line for a /api/sandbox-call request (issue
 * #11). Never pass the API key, request body, or response body in here --
 * this is queryable via `wrangler tail` and must stay credential-free.
 */
export function auditLog(entry: SandboxAuditEntry): void {
  console.log(JSON.stringify({ event: "sandbox-call", ...entry }));
}
