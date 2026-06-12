import { test } from "node:test";
import assert from "node:assert/strict";
import { upstreamBodyFor } from "../src/upstream-body.ts";

test("GET and DELETE never send a body", () => {
  assert.equal(upstreamBodyFor("GET", { a: 1 }), undefined);
  assert.equal(upstreamBodyFor("DELETE", { a: 1 }), undefined);
});

test("PUT with an object body sends serialized JSON", () => {
  assert.equal(upstreamBodyFor("PUT", { rules: [] }), '{"rules":[]}');
});

test("POST with a string body passes it through", () => {
  assert.equal(upstreamBodyFor("POST", '{"a":1}'), '{"a":1}');
});

test("PUT with no detected body (null) sends nothing — not the string 'null'", () => {
  // The client sends body: null when the snippet had no -d payload.
  assert.equal(upstreamBodyFor("PUT", null), undefined);
});
