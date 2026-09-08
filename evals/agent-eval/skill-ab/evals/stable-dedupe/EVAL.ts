import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { uniqueBy } from "./src/index.js";
test("stable first occurrence, identity, no mutation, one key call", () => {
  const a = Object.freeze({ id: 1, text: "first" });
  const b = Object.freeze({ id: 2, text: "second" });
  const c = Object.freeze({ id: 1, text: "last" });
  const input = Object.freeze([a, b, c]);
  let calls = 0;
  const result = uniqueBy(input, (item) => { calls++; return item.id; });
  assert.deepEqual(result, [a, b]);
  assert.equal(result[0], a);
  assert.equal(result[1], b);
  assert.equal(calls, 3);
  assert.equal(input.length, 3);
});
test("empty and falsy/object keys preserve Set equality", () => {
  const key = {};
  assert.deepEqual(uniqueBy([], (x) => x), []);
  assert.deepEqual(uniqueBy([0, "", false, undefined, 0, "", false, undefined], (x) => x), [0, "", false, undefined]);
  const a = { key }, b = { key };
  assert.equal(uniqueBy([a, b], (item) => item.key)[0], a);
  assert.equal(uniqueBy([a, b], (item) => item.key).length, 1);
});

test("existing checks, package contract and helpers remain intact", () => {
  assert.deepEqual(JSON.parse(readFileSync("package.json", "utf8")), {"name":"cue-eval-stable-dedupe","private":true,"type":"module","scripts":{"test":"node checks.mjs"}});
  assert.equal(readFileSync("checks.mjs", "utf8"), "import assert from \"node:assert/strict\";\nimport { uniqueBy } from \"./src/index.js\";\nassert.deepEqual(uniqueBy([1, 2], (value) => value), [1, 2]);\n");

});
