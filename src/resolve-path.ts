export function resolvePath(
  rawPath: string,
  values: { orgId?: string; netId?: string; serial?: string },
): { resolvedPath: string; missing: string[] } {
  let path = rawPath.trim();
  // Drop fully-qualified URLs
  path = path.replace(/^https?:\/\/[^/]+/i, "");
  if (!path.startsWith("/")) path = "/" + path;
  // Strip query for safety on substitution; reattach later
  const qIdx = path.indexOf("?");
  const query = qIdx >= 0 ? path.slice(qIdx) : "";
  let basePath = qIdx >= 0 ? path.slice(0, qIdx) : path;

  // Normalize token to lowercase + strip underscores so {organization_id},
  // {organizationId}, {OrganizationID}, {ORG_ID} all resolve.
  basePath = basePath.replace(
    /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g,
    (full, token: string) => {
      const norm = token.toLowerCase().replace(/_/g, "");
      if ((norm === "organizationid" || norm === "orgid") && values.orgId) {
        return values.orgId;
      }
      if ((norm === "networkid" || norm === "netid") && values.netId) {
        return values.netId;
      }
      if ((norm === "serial" || norm === "deviceserial") && values.serial) {
        return values.serial;
      }
      return full;
    },
  );

  const missingMatches = basePath.match(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g) ?? [];
  const missing = [...new Set(missingMatches)];

  return { resolvedPath: basePath + query, missing };
}
