import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLimit, listLimit, searchLimit } from "./src/index.js";
test("all callers preserve defaults and accept zero and boundaries", () => {
  for (const parse of [parseLimit, listLimit, searchLimit]) {
    assert.equal(parse(undefined), 20);
    for (const value of [0, "0", 5, "5", 100, "100"]) assert.equal(parse(value), Number(value));
  }
});
test("all callers reject invalid limits", () => {
  for (const parse of [parseLimit, listLimit, searchLimit]) {
    for (const value of ["", -1, "-1", 101, "101", 1.5, "abc", Infinity]) {
      assert.throws(() => parse(value), RangeError);
    }
  }
});

test("existing checks, package contract and helpers remain intact", () => {
  assert.deepEqual(JSON.parse(readFileSync("package.json", "utf8")), {"name":"cue-eval-shared-limit","private":true,"type":"module","scripts":{"test":"node checks.mjs"},"devDependencies":{"vitest":"2.1.0"}});
  assert.equal(readFileSync("checks.mjs", "utf8"), "import assert from \"node:assert/strict\";\nimport { listLimit, searchLimit } from \"./src/index.js\";\nassert.equal(listLimit(undefined), 20);\nassert.equal(searchLimit(\"5\"), 5);\n");

});
