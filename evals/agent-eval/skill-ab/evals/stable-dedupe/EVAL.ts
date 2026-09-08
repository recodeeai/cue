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
  const a = { key }, b = { key }, c = { key: {} };
  const result = uniqueBy([a, b, c], (item) => item.key);
  assert.equal(result.length, 2);
  assert.equal(result[0], a);
  assert.equal(result[1], c);
  assert.deepEqual(uniqueBy([0, "0", 0, "0"], (item) => item), [0, "0"]);
  assert.deepEqual(uniqueBy([NaN, NaN], (item) => item), [NaN]);
});

test("existing checks, package contract and helpers remain intact", () => {
  assert.deepEqual(JSON.parse(readFileSync("package.json", "utf8")), {"name":"cue-eval-stable-dedupe","private":true,"type":"module","scripts":{"test":"node checks.mjs"},"devDependencies":{"vitest":"2.1.0"}});
  assert.equal(readFileSync("checks.mjs", "utf8"), "import assert from \"node:assert/strict\";\nimport { uniqueBy } from \"./src/index.js\";\nassert.deepEqual(uniqueBy([1, 2], (value) => value), [1, 2]);\n");

});
