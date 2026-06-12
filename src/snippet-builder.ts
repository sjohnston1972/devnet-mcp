/**
 * Deterministic curl snippet builder.
 *
 * The DevNet MCP server returns documentation, not code: api_method, api_path
 * and an OpenAPI excerpt in YAML-flow-ish text (unquoted keys and scalars).
 * Instead of letting the chat model write curl/JSON freehand — the source of
 * the push failures — the worker builds the canonical snippet here and the
 * model only fills in values.
 */

/**
 * Parse the relaxed {key: value, ...} / [...] flow syntax used by
 * openapi_specification. Scalars run until a , } ] at the current depth;
 * a segment without a colon is rejoined to the previous value, which keeps
 * comma-separated scalars like "80,443" intact. Scalars are typed
 * (true/false/null/number), and matching single quotes are stripped.
 */
export function parseRelaxedFlow(text: string): unknown {
  let i = 0;

  const skipWs = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };

  const typeScalar = (raw: string): unknown => {
    const s = raw.trim();
    if (s === "true") return true;
    if (s === "false") return false;
    if (s === "null") return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
    return s;
  };

  const parseScalar = (): unknown => {
    let s = "";
    while (i < text.length && !/[,}\]]/.test(text[i])) {
      s += text[i];
      i++;
    }
    return typeScalar(s);
  };

  const parseValue = (): unknown => {
    skipWs();
    if (text[i] === "{") return parseObject();
    if (text[i] === "[") return parseArray();
    return parseScalar();
  };

  const parseObject = (): Record<string, unknown> => {
    const obj: Record<string, unknown> = {};
    let lastKey: string | null = null;
    i++; // consume {
    while (i < text.length) {
      skipWs();
      if (text[i] === "}") {
        i++;
        break;
      }
      if (text[i] === ",") {
        i++;
        continue;
      }
      let seg = "";
      while (i < text.length && !/[:,}\]]/.test(text[i])) {
        seg += text[i];
        i++;
      }
      if (text[i] === ":") {
        i++;
        const key = seg.trim();
        obj[key] = parseValue();
        lastKey = key;
      } else if (lastKey !== null && seg.trim()) {
        // No colon: the comma belonged to the previous scalar value.
        obj[lastKey] = `${String(obj[lastKey])},${seg.trim()}`;
      }
    }
    return obj;
  };

  const parseArray = (): unknown[] => {
    const arr: unknown[] = [];
    i++; // consume [
    while (i < text.length) {
      skipWs();
      if (text[i] === "]") {
        i++;
        break;
      }
      if (text[i] === ",") {
        i++;
        continue;
      }
      arr.push(parseValue());
    }
    return arr;
  };

  return parseValue();
}

/**
 * Pull the request-body example object out of an openapi_specification
 * excerpt. Only the example subtree is parsed — schema descriptions contain
 * free prose (commas, colons) that no lightweight parser can handle, but
 * Cisco's examples are simple scalars. Returns null when there is no
 * requestBody example or it cannot be parsed.
 */
export function extractRequestExample(spec: string): unknown {
  try {
    const rb = spec.indexOf("requestBody");
    if (rb < 0) return null;
    const responses = spec.indexOf("responses:", rb);
    const end = responses > 0 ? responses : spec.length;
    const exIdx = spec.indexOf("example: {", rb);
    if (exIdx < 0 || exIdx >= end) return null;

    const start = spec.indexOf("{", exIdx);
    let depth = 0;
    let close = -1;
    for (let j = start; j < spec.length; j++) {
      const ch = spec[j];
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          close = j;
          break;
        }
      }
    }
    if (close < 0) return null;

    const value = parseRelaxedFlow(spec.slice(start, close + 1));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export interface SnippetInput {
  method: string;
  path: string;
  spec?: string;
  base: string;
}

/**
 * Build the canonical curl snippet for one MCP search hit. The body (when the
 * method takes one and the spec carries an example) is strict JSON — pretty
 * printed, apostrophes escaped as ' so the bash single-quoted -d can
 * never be broken by a value.
 */
export function buildCurlSnippet({ method, path, spec, base }: SnippetInput): string {
  const verb = method.toUpperCase();
  const url = base.replace(/\/$/, "") + (path.startsWith("/") ? path : "/" + path);

  const lines = [
    `curl -X ${verb} \\`,
    `  ${url} \\`,
    `  -H 'X-Cisco-Meraki-API-Key: YOUR_API_KEY'`,
  ];

  if (verb !== "GET" && verb !== "DELETE") {
    const example = spec ? extractRequestExample(spec) : null;
    if (example !== null) {
      lines[2] += " \\";
      lines.push(`  -H 'Content-Type: application/json' \\`);
      const json = JSON.stringify(example, null, 2).replace(/'/g, "\\u0027");
      lines.push(`  -d '${json}'`);
    }
  }

  return lines.join("\n");
}
