import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withResource } from "./src/index.js";
test("cleanup is awaited exactly once on success and both action failure modes", async () => {
  for (const mode of ["success", "throw", "reject"]) {
    let closes = 0, closed = false;
    const error = new Error("action");
    const resource = { async close() { closes++; await new Promise((r) => setTimeout(r, 5)); closed = true; } };
    const result = withResource(async () => resource, (received) => {
      assert.equal(received, resource);
      if (mode === "throw") throw error;
      if (mode === "reject") return Promise.reject(error);
      return 42;
    });
    if (mode === "success") assert.equal(await result, 42);
    else await assert.rejects(result, (caught) => caught === error);
    assert.equal(closes, 1);
    assert.equal(closed, true);
  }
});
test("open and cleanup errors are not swallowed", async () => {
  const error = new Error("open");
  let calls = 0;
  await assert.rejects(withResource(async () => { throw error; }, () => { calls++; }), (caught) => caught === error);
  assert.equal(calls, 0);
  const closeError = new Error("close");
  for (const fails of [false, true]) {
    await assert.rejects(withResource(async () => ({ close() { throw closeError; } }),
      () => { if (fails) throw error; return 1; }), (caught) => caught === closeError);
  }
});

test("existing checks, package contract and helpers remain intact", () => {
  assert.deepEqual(JSON.parse(readFileSync("package.json", "utf8")), {"name":"cue-eval-async-cleanup","private":true,"type":"module","scripts":{"test":"node checks.mjs"}});
  assert.equal(readFileSync("checks.mjs", "utf8"), "import assert from \"node:assert/strict\";\nimport { withResource } from \"./src/index.js\";\nassert.equal(await withResource(async () => ({ close() {} }), async () => 42), 42);\n");

});
