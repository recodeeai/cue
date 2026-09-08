import { expect, test } from "bun:test";
import { reconcileCodexHooks } from "./codex-hooks";

const cue = { hooks: [{ type: "command", command: "cue hook" }] };
const changed = { hooks: [{ type: "command", command: "cue hook --new" }] };
const omx = { hooks: [{ type: "command", command: "omx hook" }] };

test("only entries inserted by Cue are owned; external entries and metadata survive", () => {
  const result = reconcileCodexHooks(JSON.stringify({ metadata: "keep", hooks: { Stop: [omx] } }), undefined, { Stop: [cue] });
  expect(result.document).toEqual({ metadata: "keep", hooks: { Stop: [omx, cue] } });
  expect(result.owned).toEqual({ version: 1, hooks: { Stop: [cue] } });
  expect(reconcileCodexHooks(JSON.stringify(result.document), JSON.stringify(result.owned), { Stop: [cue] })).toEqual(result);
});

test("changed and removed Cue hooks are reconciled without removing external hooks", () => {
  const first = reconcileCodexHooks(JSON.stringify({ hooks: { Stop: [omx] } }), undefined, { Stop: [cue] });
  const next = reconcileCodexHooks(JSON.stringify(first.document), JSON.stringify(first.owned), { Stop: [changed] });
  expect(next.document.hooks.Stop).toEqual([omx, changed]);
  const removed = reconcileCodexHooks(JSON.stringify(next.document), JSON.stringify(next.owned));
  expect(removed.document.hooks.Stop).toEqual([omx]);
  expect(removed.owned.hooks).toEqual({});
});

test("legacy, identical shared entries and externally modified entries are never claimed or deleted", () => {
  const legacy = reconcileCodexHooks(JSON.stringify({ hooks: { Stop: [cue, omx] } }), undefined, { Stop: [cue] });
  expect(legacy.owned.hooks).toEqual({});
  expect(reconcileCodexHooks(JSON.stringify(legacy.document), JSON.stringify(legacy.owned)).document).toEqual(legacy.document);
  const edited = reconcileCodexHooks(JSON.stringify({ hooks: { Stop: [changed] } }), JSON.stringify({ version: 1, hooks: { Stop: [cue] } }));
  expect(edited.document.hooks.Stop).toEqual([changed]);
});

test("malformed documents, event lists and ownership manifests fail closed", () => {
  for (const raw of ["invalid", "null", "[]", '{"hooks":null}', '{"hooks":{"Stop":{}}}']) {
    expect(() => reconcileCodexHooks(raw)).toThrow();
  }
  expect(() => reconcileCodexHooks("{}", '{"version":2,"hooks":{}}')).toThrow();
  expect(() => reconcileCodexHooks("{}", undefined, { Stop: {} })).toThrow();
});

test("removing an owned registration leaves an identical externally added copy", () => {
  const result = reconcileCodexHooks(JSON.stringify({ hooks: { Stop: [cue, cue] } }), JSON.stringify({ version: 1, hooks: { Stop: [cue] } }));
  expect(result.document.hooks.Stop).toEqual([cue]);
});
