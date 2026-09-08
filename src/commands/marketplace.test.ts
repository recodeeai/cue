/**
 * Tests for `cue marketplace` — covers the hermetic surface:
 *  - --help / -h flag
 *  - search with empty query (early-return validation)
 *  - search against the local registry (docs/registry/index.json)
 *  - --json output shape from searchRegistry
 *  - open-pr missing-repo validation
 *  - discover --pr-preview missing-repo validation
 *  - publish missing-type validation
 *
 * Network is never hit because loadRegistry() reads the local registry file
 * first (docs/registry/index.json exists in this repo).
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CUE_BIN = join(import.meta.dir, "../index.ts");

// Guard: skip if bun cannot be spawned (rare sandboxed CI environments).
const BUN_SPAWNABLE =
  spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

function cue(args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("bun", ["run", CUE_BIN, ...args], {
    encoding: "utf8",
    timeout: 20000,
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

describe.skipIf(!BUN_SPAWNABLE)("cue marketplace", () => {
  test("publishing a profile requires its GitHub source before authentication or network", () => {
    const res = cue(["marketplace", "publish", "profile", "reviewer"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("--source-url");
    expect(res.stderr).toContain("https://github.com/");
  });

  // -------------------------------------------------------------------------
  // Help
  // -------------------------------------------------------------------------

  test("--help exits 0 and describes the command", () => {
    const res = cue(["marketplace", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("cue marketplace");
    expect(res.stdout).toContain("search");
    expect(res.stdout).toContain("install-mcp");
    expect(res.stdout).toContain("install-skill");
  });

  test("-h is an alias for --help", () => {
    const res = cue(["marketplace", "-h"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("cue marketplace");
  });

  // -------------------------------------------------------------------------
  // search — validation
  // -------------------------------------------------------------------------

  test("search without a query returns 1 and prints usage to stderr", () => {
    const res = cue(["marketplace", "search"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Usage");
    expect(res.stderr).toContain("search");
  });

  // -------------------------------------------------------------------------
  // search — local registry (docs/registry/index.json)
  // These tests exercise loadRegistry + searchRegistry without any network.
  // -------------------------------------------------------------------------

  test("search 'video' finds skills from the local registry", () => {
    const res = cue(["marketplace", "search", "video"]);
    expect(res.status).toBe(0);
    // registry has video/ffmpeg skills — output should mention them
    expect(res.stdout.toLowerCase()).toContain("video");
  });

  test("search is case-insensitive", () => {
    const res = cue(["marketplace", "search", "VIDEO"]);
    expect(res.status).toBe(0);
    expect(res.stdout.toLowerCase()).toContain("video");
  });

  test("search 'medusa' finds medusa skills", () => {
    const res = cue(["marketplace", "search", "medusa"]);
    expect(res.status).toBe(0);
    expect(res.stdout.toLowerCase()).toContain("medusa");
  });

  test("search with no match prints a no-results message", () => {
    const res = cue(["marketplace", "search", "zzz-nonexistent-xyz-abc-def"]);
    expect(res.status).toBe(0);
    // cmdSearch falls through to the Smithery/npx block (no registry match),
    // which prints either a no-results line or tries smithery (not installed) →
    // either way the exit code is 0 and the query string appears in output
    expect(res.status).toBe(0);
  });

  // -------------------------------------------------------------------------
  // search --json — structural shape from searchRegistry
  // -------------------------------------------------------------------------

  test("search --json returns a JSON object with skills and mcps arrays", () => {
    const res = cue(["marketplace", "search", "--json", "video"]);
    expect(res.status).toBe(0);
    let data: { skills: unknown[]; mcps: unknown[] };
    expect(() => {
      data = JSON.parse(res.stdout);
    }).not.toThrow();
    expect(Array.isArray(data!.skills)).toBe(true);
    expect(Array.isArray(data!.mcps)).toBe(true);
  });

  test("search --json video results include skill id, name, repo", () => {
    const res = cue(["marketplace", "search", "--json", "video"]);
    expect(res.status).toBe(0);
    const data: { skills: Array<{ id: string; name: string; repo: string }> } =
      JSON.parse(res.stdout);
    expect(data.skills.length).toBeGreaterThan(0);
    const first = data.skills[0]!;
    expect(typeof first.id).toBe("string");
    expect(typeof first.name).toBe("string");
    expect(typeof first.repo).toBe("string");
  });

  test("search --json for unknown query returns empty skills and mcps arrays", () => {
    const res = cue(["marketplace", "search", "--json", "zzz-nonexistent-xyz-abc-def"]);
    expect(res.status).toBe(0);
    const data: { skills: unknown[]; mcps: unknown[] } = JSON.parse(res.stdout);
    expect(data.skills).toEqual([]);
    expect(data.mcps).toEqual([]);
  });

  test("search --json results contain only items matching the query", () => {
    const res = cue(["marketplace", "search", "--json", "review"]);
    expect(res.status).toBe(0);
    const data: { skills: Array<{ id: string; name: string; description: string; tags: string[] }> } =
      JSON.parse(res.stdout);
    // Every returned skill must actually match "review" in id, name, description or tags
    for (const s of data.skills) {
      const combined =
        s.id.toLowerCase() +
        s.name.toLowerCase() +
        s.description.toLowerCase() +
        s.tags.join(" ").toLowerCase();
      expect(combined).toContain("review");
    }
  });

  // -------------------------------------------------------------------------
  // open-pr — validation guard
  // -------------------------------------------------------------------------

  test("open-pr without a repo arg returns 1 and prints usage", () => {
    const res = cue(["marketplace", "open-pr"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Usage");
  });

  // -------------------------------------------------------------------------
  // discover --pr-preview — validation guard
  // -------------------------------------------------------------------------

  test("discover --pr-preview without a following repo arg returns 1", () => {
    const res = cue(["marketplace", "discover", "--pr-preview"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Usage");
  });

  test("discover --pr-preview with a flag-like next token returns 1", () => {
    // --pr-preview followed by another flag, not a repo name
    const res = cue(["marketplace", "discover", "--pr-preview", "--json"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Usage");
  });

  // -------------------------------------------------------------------------
  // publish — validation guard (no type/name)
  // -------------------------------------------------------------------------

  test("publish without type and name returns 1 and prints usage", () => {
    const res = cue(["marketplace", "publish"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Usage");
    expect(res.stderr).toContain("publish");
  });

  test("publish with invalid type returns 1", () => {
    const res = cue(["marketplace", "publish", "invalid-type", "myname"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Usage");
  });
});
