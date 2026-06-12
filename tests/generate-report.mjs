// Runs the unit test suite + TypeScript typecheck and writes test-report.html.
// Usage: node tests/generate-report.mjs

import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const testFiles = readdirSync(path.join(root, "tests"))
  .filter((f) => f.endsWith(".test.mjs"))
  .map((f) => path.join("tests", f));

const run = spawnSync(
  process.execPath,
  ["--test", "--test-reporter=junit", ...testFiles],
  { cwd: root, encoding: "utf8" },
);
const junit = run.stdout ?? "";

const tsc = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["tsc", "--noEmit"],
  { cwd: root, encoding: "utf8", shell: true },
);
const tscOk = tsc.status === 0;
const tscOutput = `${tsc.stdout ?? ""}${tsc.stderr ?? ""}`.trim();

// Parse <testcase> entries out of the junit XML (flat, no nesting needed).
const cases = [];
const caseRe = /<testcase([^>]*)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
const attr = (s, name) => {
  const m = s.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : "";
};
const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

let m;
while ((m = caseRe.exec(junit)) !== null) {
  const attrs = m[1];
  const inner = m[2] ?? "";
  const failure = inner.match(/<(?:failure|error)[^>]*message="([^"]*)"/);
  cases.push({
    name: unescapeXml(attr(attrs, "name")),
    file: unescapeXml(attr(attrs, "file") || attr(attrs, "classname")),
    timeMs: Math.round(parseFloat(attr(attrs, "time") || "0") * 1000 * 100) / 100,
    failed: Boolean(failure) || /<(?:failure|error)/.test(inner),
    failureMessage: failure ? unescapeXml(failure[1]) : "",
  });
}

const passed = cases.filter((c) => !c.failed);
const failed = cases.filter((c) => c.failed);
const allGreen = failed.length === 0 && cases.length > 0;

// Group by source test file
const groups = new Map();
for (const c of cases) {
  const key = path.basename(c.file || "unknown");
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(c);
}

const FINDINGS = [
  {
    severity: "high",
    title: "LLM composed curl/JSON freehand — root of the whole push-failure class",
    status: "fixed",
    detail:
      "The DevNet MCP server returns documentation only (method, path, OpenAPI excerpt), never " +
      "code, so the chat model wrote every snippet from scratch — producing comments in JSON, " +
      "dangling members, broken quoting and wrong endpoints. The worker now builds each Meraki " +
      "snippet deterministically (src/snippet-builder.ts): a relaxed-flow parser extracts the " +
      "request-body example from the spec excerpt and emits canonical curl with strict JSON; the " +
      "system prompt instructs the model to reproduce it verbatim, changing only values. Round-trip " +
      "tested (generated snippet → detectMerakiCall → zero repairs) and probed live: 4/4 chat runs " +
      "emitted strict-JSON snippets on the correct endpoint.",
    where: "src/snippet-builder.ts, src/index.ts (formatToolResult, SYSTEM_PROMPT)",
  },
  {
    severity: "high",
    title: "Assistant chose INBOUND firewall rules for LAN→internet traffic (Meraki 400 on dst_cidr)",
    status: "fixed",
    detail:
      "For “SIP traffic to Microsoft subnets” the model generated updateNetworkApplianceFirewall" +
      "InboundFirewallRules with public subnets in destCidr. Live DEV experiments proved the rule " +
      "body itself is fine: Meraki rejects ANY public IPv4 destCidr on the inbound endpoint (it " +
      "only accepts local VLAN(n).* destinations or 'any'), while the outbound l3FirewallRules " +
      "endpoint accepts the exact same rule — including comma-separated CIDR lists with spaces, " +
      "which were proven harmless. Fixed by adding firewall-direction guidance to the system " +
      "prompt; probes now consistently generate the outbound endpoint.",
    where: "src/index.ts (SYSTEM_PROMPT)",
  },
  {
    severity: "high",
    title: "JSON bodies containing # / // comments were rejected (the reported push failures)",
    status: "fixed",
    detail:
      "LLM-generated curl snippets often annotate JSON members with shell-style comments " +
      '("dstCidr": "13.107.4.0/24", # Microsoft SIP subnet). Comments are illegal in JSON, ' +
      "so the strict parse failed and none of the repair passes in parseTolerantJson handled " +
      "comments — the push was refused with “Request body in the snippet isn't valid JSON”. " +
      "Fixed with a string-aware scanner that strips # and // line comments (never inside " +
      "string values, e.g. \"#ff0000\" or \"https://…\" are preserved) before other repairs.",
    where: "public/parse-tolerant-json.js",
  },
  {
    severity: "high",
    title: "Double-quoted curl bodies with escaped quotes were truncated at the first inner quote",
    status: "fixed",
    detail:
      'For snippets like curl -d "{\\"rules\\": …}" the body-extraction regex stopped at the ' +
      "first inner quote, producing a truncated, unparseable body and a refused push. The regex " +
      "now skips escaped characters to find the real closing quote, and shell escapes " +
      "(\\\" and \\\\) inside double-quoted bodies are unescaped before parsing.",
    where: "public/detect-meraki-call.js",
  },
  {
    severity: "medium",
    title: "curl --data-binary payloads were not detected at all",
    status: "fixed",
    detail:
      "The extractor recognized -d / --data / --data-raw but not --data-binary, so such snippets " +
      "pushed with an empty body. --data-binary is now part of the detection alternation.",
    where: "public/detect-meraki-call.js",
  },
  {
    severity: "medium",
    title: "PUT/POST with no detected body sent the literal string \"null\" to Meraki",
    status: "fixed",
    detail:
      "The client sends body: null when a snippet has no payload; the worker only excluded " +
      "undefined, so JSON.stringify(null) — the 4-byte string “null” — was forwarded as the " +
      "request body, which Meraki rejects with a 400. Body forwarding was extracted into " +
      "upstreamBodyFor() (src/upstream-body.ts), which now treats null like undefined.",
    where: "src/index.ts, src/upstream-body.ts",
  },
  {
    severity: "low",
    title: "Meraki-call detection was untestable (inlined in app.js alongside DOM code)",
    status: "fixed",
    detail:
      "detectMerakiCall/normalizeMerakiPath lived in app.js, which touches document at module " +
      "scope and can't be imported under Node. They were extracted verbatim into " +
      "public/detect-meraki-call.js and are now covered by unit tests.",
    where: "public/app.js → public/detect-meraki-call.js",
  },
  {
    severity: "low",
    title: "Python json=/data= extraction truncates nested objects ending in “}, ”",
    status: "open (noted)",
    detail:
      "The non-greedy json\\s*=\\s*(\\{…\\}) fallback can stop early on bodies like " +
      "json={\"a\": {\"b\": 1}, \"c\": 2}. Low impact: the Push button is suppressed for " +
      "python/py code blocks and the assistant defaults to curl examples; the tolerant parser " +
      "also rejects the truncated body rather than sending it.",
    where: "public/detect-meraki-call.js",
  },
  {
    severity: "low",
    title: "Repair pass could rewrite legit “word: value” strings in already-broken bodies",
    status: "mitigated",
    detail:
      "The \"key: value\" repair regex can rewrite a legitimate string like \"note: allow\" — but " +
      "only when the document already failed strict parsing. Comment stripping now runs first and " +
      "returns early when it alone fixes the document, so the riskier regex passes run far less often.",
    where: "public/parse-tolerant-json.js",
  },
];

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const sevColor = { high: "#e5484d", medium: "#f5a524", low: "#8ea0b5" };
const statusColor = (s) =>
  s === "fixed" ? "#46c98c" : s === "mitigated" ? "#f5a524" : "#8ea0b5";

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>devnet-mcp — bug sweep &amp; test report</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 40px 24px; background: #0b1420; color: #d7e2ee;
         font: 15px/1.55 "Segoe UI", system-ui, sans-serif; }
  .wrap { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 36px 0 12px; border-bottom: 1px solid #1d2c3e; padding-bottom: 8px; }
  .sub { color: #8ea0b5; margin: 0 0 28px; font-size: 13px; }
  .cards { display: flex; gap: 14px; flex-wrap: wrap; }
  .card { background: #101d2d; border: 1px solid #1d2c3e; border-radius: 10px;
          padding: 16px 20px; min-width: 150px; }
  .card .num { font-size: 28px; font-weight: 700; }
  .card .lbl { font-size: 12px; color: #8ea0b5; text-transform: uppercase; letter-spacing: .06em; }
  .ok { color: #46c98c; } .bad { color: #e5484d; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th { text-align: left; color: #8ea0b5; font-weight: 600; padding: 8px 10px;
       border-bottom: 1px solid #1d2c3e; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
  td { padding: 7px 10px; border-bottom: 1px solid #14202f; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .pill { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 600; }
  .pill.pass { background: #0f2e22; color: #46c98c; }
  .pill.fail { background: #3a1418; color: #ff8589; }
  .file-head td { background: #0e1929; color: #9fd1ff; font-weight: 600; font-size: 13px; }
  .finding { background: #101d2d; border: 1px solid #1d2c3e; border-radius: 10px;
             padding: 16px 18px; margin-bottom: 14px; }
  .finding h3 { margin: 0 0 6px; font-size: 14.5px; }
  .finding p { margin: 6px 0 4px; color: #b7c5d4; font-size: 13.5px; }
  .finding .where { font-family: Consolas, monospace; font-size: 12px; color: #8ea0b5; }
  .tag { display: inline-block; padding: 1px 8px; border-radius: 4px; font-size: 11px;
         font-weight: 700; text-transform: uppercase; letter-spacing: .05em; margin-right: 8px; }
  .mono { font-family: Consolas, monospace; font-size: 12.5px; }
  .time { color: #617082; white-space: nowrap; }
  pre.tsc { background: #101d2d; border: 1px solid #1d2c3e; border-radius: 8px;
            padding: 12px 14px; font-size: 12.5px; overflow-x: auto; }
  footer { margin-top: 40px; color: #617082; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>devnet-mcp — bug sweep &amp; test report</h1>
  <p class="sub">Generated ${new Date().toISOString()} · Node ${process.version} · trigger: “Push to DEV” failures on Meraki snippets</p>

  <div class="cards">
    <div class="card"><div class="num ${allGreen ? "ok" : "bad"}">${cases.length}</div><div class="lbl">tests run</div></div>
    <div class="card"><div class="num ok">${passed.length}</div><div class="lbl">passed</div></div>
    <div class="card"><div class="num ${failed.length ? "bad" : "ok"}">${failed.length}</div><div class="lbl">failed</div></div>
    <div class="card"><div class="num ${tscOk ? "ok" : "bad"}">${tscOk ? "clean" : "errors"}</div><div class="lbl">tsc --noEmit</div></div>
    <div class="card"><div class="num">${FINDINGS.filter((f) => f.status === "fixed").length}/${FINDINGS.length}</div><div class="lbl">findings fixed</div></div>
  </div>

  <h2>Findings</h2>
  ${FINDINGS.map(
    (f) => `<div class="finding">
    <h3><span class="tag" style="background:${sevColor[f.severity]}22;color:${sevColor[f.severity]}">${f.severity}</span>
        <span class="tag" style="background:${statusColor(f.status)}22;color:${statusColor(f.status)}">${esc(f.status)}</span>
        ${esc(f.title)}</h3>
    <p>${esc(f.detail)}</p>
    <div class="where">${esc(f.where)}</div>
  </div>`,
  ).join("\n")}

  <h2>Test results</h2>
  <table>
    <thead><tr><th>Test</th><th style="width:70px">Result</th><th style="width:80px">Time</th></tr></thead>
    <tbody>
    ${[...groups.entries()]
      .map(
        ([file, list]) =>
          `<tr class="file-head"><td colspan="3">${esc(file)} — ${list.filter((c) => !c.failed).length}/${list.length} passed</td></tr>` +
          list
            .map(
              (c) => `<tr>
        <td>${esc(c.name)}${c.failed ? `<div class="mono bad">${esc(c.failureMessage)}</div>` : ""}</td>
        <td><span class="pill ${c.failed ? "fail" : "pass"}">${c.failed ? "FAIL" : "PASS"}</span></td>
        <td class="time">${c.timeMs} ms</td></tr>`,
            )
            .join("\n"),
      )
      .join("\n")}
    </tbody>
  </table>

  <h2>TypeScript check</h2>
  <pre class="tsc">${tscOk ? "npx tsc --noEmit — no errors" : esc(tscOutput || "tsc failed")}</pre>

  <footer>devnet-chat · regenerate with <span class="mono">npm run test:report</span></footer>
</div>
</body>
</html>
`;

const outPath = path.join(root, "test-report.html");
writeFileSync(outPath, html, "utf8");
console.log(
  `report written to ${outPath} — ${passed.length}/${cases.length} tests passed, tsc ${tscOk ? "clean" : "FAILED"}`,
);
process.exit(failed.length > 0 || !tscOk ? 1 : 0);
