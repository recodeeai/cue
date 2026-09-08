import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Isolate auth/database mocks from other Bun tests; never connect to an account or DB.
function request(input: Record<string, unknown>, list = false) {
  const script = `
    import { mock } from "bun:test";
    let writes = 0;
    const input = ${JSON.stringify(input)};
    const row = { id: "profile:reviewer", handle: "cloud-handle", type: "profile",
      name: "reviewer", description: "", tags: [], status: "approved", stars: 0,
      created_at: new Date(), source_url: null, ...input };
    mock.module("./auth.js", () => ({ auth: { api: { getSession: async () => ({
      user: { id: "user-1", name: "cloud-handle", email: "alice@example.test" }
    }) } } }));
    mock.module("./db.js", () => ({ getPool: () => ({ query: async (sql, values) => {
      if (sql.includes("INSERT INTO")) {
        writes++;
        return { rows: [{ ...row, type: values[3], name: values[4], source_url: values[7] }] };
      }
      return { rows: sql.includes("SELECT id") ? [row] : [] };
    } }) }));
    const { publishMarket, getMarket } = await import("./market.ts");
    const result = ${list ? "await getMarket(new Headers())" : "await publishMarket(new Headers(), input)"};
    console.log(JSON.stringify({ result, writes }));
  `;
  const result = spawnSync("bun", ["-e", script], { cwd: import.meta.dir, encoding: "utf8", timeout: 10000 });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

describe("community profile source contract", () => {
  test.each([undefined, "https://example.com/repo", "https://github.com/alice/repo/tree/main/../other"])(
    "rejects missing or invalid profile sources without writing: %s", (sourceUrl) => {
      const { result, writes } = request({ type: "profile", name: "reviewer", sourceUrl });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain("public GitHub sourceUrl");
      expect(writes).toBe(0);
    },
  );

  test("publishes a GitHub install reference, not the cloud account handle", () => {
    const { result, writes } = request({ type: "profile", name: "reviewer", sourceUrl: "https://github.com/alice/profiles/tree/v1/reviewer" });
    expect(result.status).toBe(200);
    expect(result.body.data.add).toBe("cue share install alice/profiles@v1:reviewer");
    expect(writes).toBe(1);
  });

  test.each([null, "https://example.com/repo"])("legacy source %s is actionable, not a fictitious install", (source_url) => {
    const { result } = request({ source_url }, true);
    expect(result.body.data.items[0].add).toBe("");
    expect(result.body.data.items[0].status).toBe("source-required");
  });

  test("other types still accept optional sources and retain their install command", () => {
    const { result } = request({ type: "skill", name: "reviewer" });
    expect(result.status).toBe(200);
    expect(result.body.data.add).toBe("cue marketplace install-skill cloud-handle/reviewer");
  });
});
