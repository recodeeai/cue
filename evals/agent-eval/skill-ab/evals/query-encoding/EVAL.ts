import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildUrl } from "./src/index.js";
test("query values cannot inject parameters and repeated values survive", () => {
  const input = { q: "a&admin=true #?", tag: ["ár", "b c"], skip: undefined, page: 0 };
  const url = new URL(buildUrl("/search", input), "https://example.test");
  assert.equal(url.pathname, "/search");
  assert.equal(url.hash, "");
  assert.equal(url.searchParams.get("q"), input.q);
  assert.equal(url.searchParams.has("admin"), false);
  assert.deepEqual(url.searchParams.getAll("tag"), ["ár", "b c"]);
  assert.equal(url.searchParams.has("skip"), false);
  assert.equal(url.searchParams.get("page"), "0");
  assert.deepEqual(input.tag, ["ár", "b c"]);
});
test("empty queries leave the path unchanged", () => {
  assert.equal(buildUrl("/search", {}), "/search");
  assert.equal(buildUrl("/search", { skip: undefined }), "/search");
});

test("existing checks, package contract and helpers remain intact", () => {
  assert.deepEqual(JSON.parse(readFileSync("package.json", "utf8")), {"name":"cue-eval-query-encoding","private":true,"type":"module","scripts":{"test":"node checks.mjs"}});
  assert.equal(readFileSync("checks.mjs", "utf8"), "import assert from \"node:assert/strict\";\nimport { buildUrl } from \"./src/index.js\";\nassert.equal(buildUrl(\"/search\", { q: \"hello\" }), \"/search?q=hello\");\n");
  assert.equal(readFileSync("src/query.js", "utf8"), "export function encodeQuery(params) {\n  const query = new URLSearchParams();\n  for (const [key, value] of Object.entries(params)) {\n    if (value === undefined) continue;\n    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);\n  }\n  return query.toString();\n}\n");
});
