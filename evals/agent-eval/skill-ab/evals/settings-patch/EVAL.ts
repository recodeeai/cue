import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { patchSettings } from "./src/index.js";
test("valid patches trim names, preserve false and leave inputs unchanged", () => {
  const current = Object.freeze({ displayName: "Old", notifications: true, role: "reader" });
  const patch = Object.freeze({ displayName: "  New  ", notifications: false });
  const result = patchSettings(current, patch);
  assert.deepEqual(result, { ok: true, value: { displayName: "New", notifications: false, role: "reader" } });
  assert.notEqual(result.value, current);
  assert.deepEqual(patchSettings(current, {}), { ok: true, value: current });
  assert.equal(patchSettings(current, { displayName: "x".repeat(80) }).ok, true);
  assert.deepEqual(patchSettings(current, { notifications: false }), {
    ok: true, value: { displayName: "Old", notifications: false, role: "reader" },
  });
  assert.deepEqual(patchSettings({ ...current, notifications: false }, { displayName: "  New  " }), {
    ok: true, value: { displayName: "New", notifications: false, role: "reader" },
  });
});
test("invalid patches are rejected atomically with structured errors", () => {
  const invalid = { ok: false, error: { code: "INVALID_PATCH" } };
  for (const patch of [null, [], "x", 5, { role: "admin" }, { displayName: "" },
    { displayName: "  " }, { displayName: "x".repeat(81) }, { displayName: 7 },
    { notifications: "false" }, { displayName: "New", notifications: null },
    JSON.parse('{"__proto__":{"polluted":true}}')]) {
    const current = { displayName: "Old", notifications: true };
    assert.deepEqual(patchSettings(current, patch), invalid);
    assert.deepEqual(current, { displayName: "Old", notifications: true });
  }
  assert.equal({}.polluted, undefined);
});

test("existing checks, package contract and helpers remain intact", () => {
  assert.deepEqual(JSON.parse(readFileSync("package.json", "utf8")), {"name":"cue-eval-settings-patch","private":true,"type":"module","scripts":{"test":"node checks.mjs"},"devDependencies":{"vitest":"2.1.0"}});
  assert.equal(readFileSync("checks.mjs", "utf8"), "import assert from \"node:assert/strict\";\nimport { patchSettings } from \"./src/index.js\";\nassert.equal(patchSettings({ displayName: \"Old\" }, { displayName: \"New\" }).value.displayName, \"New\");\n");

});
