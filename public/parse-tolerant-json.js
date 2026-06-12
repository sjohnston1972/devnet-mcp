/**
 * Tolerant JSON parser that auto-fixes common LLM-emitted bugs:
 *   1. # and // line comments (legal in shell/JS examples, fatal in JSON)
 *   2. "key: value"   — colon inside the string instead of between key/value
 *   3. "key":         — key declared with no value (drop the member; server
 *                       defaults apply)
 *   4. trailing commas before } or ]
 * If strict parse works, returns the value unchanged. If a repair pass works,
 * returns { value, repaired: true, repairedSource }. If nothing parses,
 * returns { value: null, error }.
 */

// Remove # and // line comments outside of string literals. A simple
// character scanner — regex can't tell a comment from a # inside a value.
function stripLineComments(src) {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const ch = src[i];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "#" || (ch === "/" && src[i + 1] === "/")) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function parseTolerantJson(raw) {
  // Strict first
  try {
    return { value: JSON.parse(raw), repaired: false };
  } catch (firstErr) {
    let candidate = stripLineComments(raw);

    // Comments (plus any trailing comma they leave behind) are the least
    // invasive repair — if that alone parses, stop before the regex passes
    // below, which can touch string contents.
    const commentOnly = candidate.replace(/,(\s*[}\]])/g, "$1");
    if (commentOnly !== raw) {
      try {
        return {
          value: JSON.parse(commentOnly),
          repaired: true,
          repairedSource: commentOnly,
        };
      } catch {
        /* fall through to the heavier repairs */
      }
    }

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
