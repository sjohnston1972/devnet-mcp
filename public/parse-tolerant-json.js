/**
 * Tolerant JSON parser that auto-fixes common LLM-emitted bugs:
 *   1. "key: value"   — colon inside the string instead of between key/value
 *   2. "key":         — key declared with no value (drop the member; server
 *                       defaults apply)
 *   3. trailing commas before } or ]
 * If strict parse works, returns the value unchanged. If a repair pass works,
 * returns { value, repaired: true, repairedSource }. If nothing parses,
 * returns { value: null, error }.
 */
export function parseTolerantJson(raw) {
  // Strict first
  try {
    return { value: JSON.parse(raw), repaired: false };
  } catch (firstErr) {
    let candidate = raw;

    // Fix "key: value" → "key": <value>. Heuristic: a string that opens with
    // an identifier, then a colon, then a non-quote run, then closing quote.
    candidate = candidate.replace(
      /"([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([^",}\]\n]+?)"/g,
      (_m, key, val) => {
        const t = val.trim();
        if (/^-?\d+(\.\d+)?$/.test(t)) return `"${key}": ${t}`;
        if (t === "true" || t === "false" || t === "null") return `"${key}": ${t}`;
        return `"${key}": "${t}"`;
      },
    );

    // Drop empty-valued members: "key":  followed by , or } or ]. Three cases:
    //   ,"key":<ws>}  → }     (trailing member; preceding comma also goes)
    //   "key":<ws>,   → ""    (leading/middle member; trailing comma also goes)
    //   {"key":<ws>}  → {}    (only member; no commas to clean up)
    candidate = candidate.replace(/,\s*"[a-zA-Z_][a-zA-Z0-9_]*"\s*:\s*(?=[}\]])/g, "");
    candidate = candidate.replace(/"[a-zA-Z_][a-zA-Z0-9_]*"\s*:\s*,\s*/g, "");
    candidate = candidate.replace(/"[a-zA-Z_][a-zA-Z0-9_]*"\s*:\s*(?=[}\]])/g, "");

    // Strip trailing commas
    candidate = candidate.replace(/,(\s*[}\]])/g, "$1");

    if (candidate !== raw) {
      try {
        return {
          value: JSON.parse(candidate),
          repaired: true,
          repairedSource: candidate,
        };
      } catch {
        /* fall through */
      }
    }

    return {
      value: null,
      repaired: false,
      error: firstErr?.message ?? String(firstErr),
    };
  }
}
