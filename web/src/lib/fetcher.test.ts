import { describe, test } from "node:test";
import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import { resolveCueMode } from "./fetcher";
import { fetchCommunity } from "./market-client";

describe("public versus local Studio", () => {
  test("public hosts never imply a local connection", () => {
    strictEqual(resolveCueMode("cuecards.cc"), "demo");
    strictEqual(resolveCueMode("preview.vercel.app", "local"), "demo");
    strictEqual(resolveCueMode("localhost.evil.example"), "demo");
  });
  test("loopback preserves local Studio, with explicit demo previews", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      strictEqual(resolveCueMode(host), "local");
      strictEqual(resolveCueMode(host, "demo"), "demo");
    }
  });
});

describe("community catalog failures", () => {
  test("an empty successful catalog is not an outage", async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = Object.assign(async () => Response.json({ ok: true, data: { items: [] } }), original);
      deepStrictEqual(await fetchCommunity(), []);
    } finally { globalThis.fetch = original; }
  });
  test("HTTP errors remain visible to the query error UI", async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = Object.assign(async () => new Response("offline", { status: 503 }), original);
      await rejects(fetchCommunity(), /503/);
    } finally { globalThis.fetch = original; }
  });
});
