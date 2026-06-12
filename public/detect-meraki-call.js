/* Meraki call detection — extracted from app.js so it can be unit-tested. */

import { parseTolerantJson } from "./parse-tolerant-json.js";

const MERAKI_PATH_HINTS = [
  /\/(?:organizations|networks|devices|admins|licenses|inventoryDevices|merakiAuthUsers|wireless|switch|appliance|camera|cellularGateway|sensor|sm|insight)\b/,
];

/**
 * Deterministic Meraki path normalizer. Meraki URLs follow a strict
 * resource/{id}/sub-resource pattern, so we don't need to guess what
 * counts as an "example ID" — the segment after a known resource name
 * IS the ID for that resource. Force every such segment to its
 * placeholder unless it already is one. The runtime then substitutes
 * the user's linked DEV/PROD value.
 *
 *   /organizations/{X}/...  → X becomes {organizationId}
 *   /networks/{X}/...       → X becomes {networkId}
 *   /devices/{X}/...        → X becomes {serial}
 *
 * Already-templated segments ({networkId}, {organization_id}, etc.)
 * are left untouched.
 */
export function normalizeMerakiPath(path) {
  // Strip query before substituting to avoid touching values inside
  const qIdx = path.indexOf("?");
  const query = qIdx >= 0 ? path.slice(qIdx) : "";
  let base = qIdx >= 0 ? path.slice(0, qIdx) : path;

  base = base
    .replace(/\/organizations\/(?!\{)[^/]+/g, "/organizations/{organizationId}")
    .replace(/\/networks\/(?!\{)[^/]+/g, "/networks/{networkId}")
    .replace(/\/devices\/(?!\{)[^/]+/g, "/devices/{serial}");

  return base + query;
}

export function detectMerakiCall(text) {
  if (!text || text.length > 20_000) return null;

  let path = null;

  const fullUrl = text.match(/https?:\/\/api\.meraki\.com(\/[^\s'"`)\\<>]+)/i);
  if (fullUrl) path = fullUrl[1];

  if (!path) {
    const quoted = text.match(/['"`](\/api\/v1\/[^'"`\s]+)['"`]/);
    if (quoted) path = quoted[1];
  }

  if (!path) {
    const quotedShort = text.match(/['"`](\/(?:organizations|networks|devices|admins)[^'"`\s]+)['"`]/);
    if (quotedShort) path = quotedShort[1];
  }

  if (!path) return null;

  if (!path.startsWith("/api/v1") && !path.startsWith("/v1")) {
    if (MERAKI_PATH_HINTS.some((re) => re.test(path))) {
      path = "/api/v1" + path;
    } else {
      return null;
    }
  }

  let method = "GET";
  const m =
    text.match(/(?:--request|-X)\s+["']?(GET|POST|PUT|DELETE|PATCH)["']?/i) ||
    text.match(/requests\.(get|post|put|delete|patch)\b/i) ||
    text.match(/\.(get|post|put|delete|patch)\(/i) ||
    text.match(/method\s*[:=]\s*['"](GET|POST|PUT|DELETE|PATCH)['"]/i) ||
    text.match(/^\s*(GET|POST|PUT|DELETE|PATCH)\s+\//im);
  if (m) method = m[1].toUpperCase();

  let body = null;
  let bodyError = null;
  let bodyRepaired = false;
  let rawBody = null;
  // Quoted curl bodies: stop at the CLOSING quote, not the first inner one.
  // Inside double quotes, shell escapes (\" and \\) are part of the string
  // and must be unescaped to recover the JSON actually sent.
  const dataMatch =
    text.match(/(?:--data-binary|--data-raw|--data|-d)\s+(['"])((?:\\.|(?!\1)[\s\S])*?)\1/) ||
    text.match(/json\s*=\s*(\{[\s\S]*?\})\s*[,)]/) ||
    text.match(/data\s*=\s*(\{[\s\S]*?\})\s*[,)]/);
  if (dataMatch) {
    rawBody = dataMatch[2] ?? dataMatch[1];
    if (dataMatch[1] === '"' && dataMatch[2] !== undefined) {
      rawBody = rawBody.replace(/\\(["\\])/g, "$1");
    }
    const parsed = parseTolerantJson(rawBody);
    body = parsed.value;
    bodyRepaired = parsed.repaired;
    bodyError = parsed.error;
    if (parsed.repairedSource) rawBody = parsed.repairedSource;
  }

  return { method, path, body, bodyError, bodyRepaired, rawBody };
}
