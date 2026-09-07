/**
 * Tests for resolver-npx.ts. Runs under `bun test`.
 *
 * The real `npx` is never invoked — every test injects a fake NpxFetchFn via
 * `opts.fetch`. Cache root is a tmpdir per test, never profiles/_cache/.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Profile } from "../../profiles/_types";
import {
  CacheCorrupt,
  NpxFetchFailed,
  PinNotFound,
  cacheKey,
  needsCompanionRecovery,
  resolveNpx,
  resolveNpxDetailed,
  type NpxBatchFetchFn,
  type NpxFetchFn,
} from "./resolver-npx";
import { cachePath, cacheSkillPath, type FetchFailureMark } from "./cache";

// --- helpers ---------------------------------------------------------------

let repoRoot: string;
let calls: Array<{ repo: string; pin: string | undefined; skill: string; destDir: string }>;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "cue-test-"));
  // The resolver writes under <repoRoot>/profiles/_cache/npx/<key>/, so make
  // sure the parent dirs exist — cache.cachePut calls mkdirSync recursive.
  mkdirSync(join(repoRoot, "profiles", "_cache", "npx"), { recursive: true });
  calls = [];
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

/** Make a fetcher that drops a fake SKILL.md into <destDir>/<skill>/. */
function fakeFetcher(): NpxFetchFn {
  return async (repo, pin, skill, destDir) => {
    calls.push({ repo, pin, skill, destDir });
    const sk = join(destDir, skill);
    mkdirSync(sk, { recursive: true });
    writeFileSync(join(sk, "SKILL.md"), `# ${skill} from ${repo}@${pin ?? "HEAD"}\n`);
  };
}

/** Fetcher that always throws — used to assert "no fetch was called". */
const explodingFetcher: NpxFetchFn = async () => {
  throw new Error("fetcher invoked but should not have been");
};

function profile(npx: Profile["skills"] extends infer S ? NonNullable<S>["npx"] : never): Profile {
  return {
    name: "t",
    description: "test",
    skills: { npx },
  };
}

/** Pre-populate a cache slot for (repo, pin) with the given skills. */
function seedCache(repo: string, pin: string | undefined, skills: string[]): string {
  const key = cacheKey(repo, pin);
  const slot = cachePath({ repoRoot }, key);
  mkdirSync(slot, { recursive: true });
  for (const s of skills) {
    const d = join(slot, s);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `# ${s}\n`);
  }
  return key;
}

// --- cache-key scheme ------------------------------------------------------

describe("cacheKey", () => {
  it("uses sha256(repo + (pin || 'HEAD'))", () => {
    expect(cacheKey("anthropics/skills", undefined)).toBe(
      createHash("sha256").update("anthropics/skillsHEAD").digest("hex"),
    );
    expect(cacheKey("anthropics/skills", "tag@v1.2.3")).toBe(
      createHash("sha256").update("anthropics/skillstag@v1.2.3").digest("hex"),
    );
    expect(cacheKey("anthropics/skills", "git@abcdef0")).toBe(
      createHash("sha256").update("anthropics/skillsgit@abcdef0").digest("hex"),
    );
  });

  it("produces distinct keys for distinct pins on the same repo", () => {
    const a = cacheKey("anthropics/skills", undefined);
    const b = cacheKey("anthropics/skills", "tag@v1.0.0");
    const c = cacheKey("anthropics/skills", "git@deadbeef");
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

// --- cache hit / miss ------------------------------------------------------

describe("resolveNpx — cache behavior", () => {
  it("batches all cold skills from one repo into one production fetch", async () => {
    const batches: string[][] = [];
    const fetchMany: NpxBatchFetchFn = async (repo, pin, skills, destDir) => {
      batches.push(skills);
      for (const skill of skills) {
        const dir = join(destDir, skill);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "SKILL.md"),
          `# ${skill} from ${repo}@${pin ?? "HEAD"}\n`,
        );
      }
    };

    const plans = await resolveNpx(
      profile([
        {
          repo: "google/skills",
          skills: ["gcloud", "bigquery-basics", "cloud-run-basics"],
        },
      ]),
      { repoRoot, fetchMany },
    );

    expect(plans).toHaveLength(3);
    expect(batches).toEqual([
      ["gcloud", "bigquery-basics", "cloud-run-basics"],
    ]);
  });

  it("returns LinkPlans without calling fetch when cache is fully populated", async () => {
    seedCache("anthropics/skills", undefined, ["pdf", "xlsx"]);
    const plans = await resolveNpx(
      profile([{ repo: "anthropics/skills", skills: ["pdf", "xlsx"] }]),
      { repoRoot, fetch: explodingFetcher },
    );
    expect(plans).toHaveLength(2);
    expect(calls).toHaveLength(0); // exploder would have thrown if called
    expect(plans[0]).toMatchObject({
      target: ".claude/skills/pdf",
      origin: "npx",
    });
    expect(plans[0].source.endsWith("/pdf")).toBe(true);
  });

  it("fetches on cache miss and publishes to the cache slot", async () => {
    const fetcher = fakeFetcher();
    const plans = await resolveNpx(
      profile([{ repo: "anthropics/skills", skills: ["pdf"] }]),
      { repoRoot, fetch: fetcher },
    );
    expect(plans).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].skill).toBe("pdf");
    const key = cacheKey("anthropics/skills", undefined);
    expect(existsSync(join(cachePath({ repoRoot }, key), "pdf", "SKILL.md"))).toBe(true);
  });

  it("a second resolve after a fetch is a pure cache hit", async () => {
    const fetcher = fakeFetcher();
    const prof = profile([{ repo: "anthropics/skills", skills: ["pdf"] }]);

    await resolveNpx(prof, { repoRoot, fetch: fetcher });
    expect(calls).toHaveLength(1);

    // Reset the call log and try again — should not re-fetch.
    calls.length = 0;
    const plans = await resolveNpx(prof, { repoRoot, fetch: explodingFetcher });
    expect(calls).toHaveLength(0);
    expect(plans).toHaveLength(1);
  });

  it("returns [] for a profile with no npx entries", async () => {
    const plans = await resolveNpx({ name: "t", description: "" }, {
      repoRoot,
      fetch: explodingFetcher,
    });
    expect(plans).toEqual([]);
  });
});

describe("needsCompanionRecovery", () => {
  it("skips the GitHub fallback when the skills CLI already copied companions", () => {
    const skillDir = join(repoRoot, "complete-skill");
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# complete\n");
    writeFileSync(join(skillDir, "references", "guide.md"), "# guide\n");

    expect(needsCompanionRecovery(skillDir)).toBe(false);
  });

  it("keeps the fallback for legacy SKILL.md-only installs", () => {
    const skillDir = join(repoRoot, "legacy-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# legacy\n");

    expect(needsCompanionRecovery(skillDir)).toBe(true);
  });
});

// --- offline mode ----------------------------------------------------------

describe("resolveNpx — offline mode", () => {
  it("fails hard on cache miss when offline=true", async () => {
    const p = profile([{ repo: "anthropics/skills", skills: ["pdf"] }]);
    await expect(
      resolveNpx(p, { repoRoot, fetch: explodingFetcher, offline: true }),
    ).rejects.toBeInstanceOf(NpxFetchFailed);
    expect(calls).toHaveLength(0);
  });

  it("still serves cache hits when offline=true", async () => {
    seedCache("anthropics/skills", undefined, ["pdf"]);
    const plans = await resolveNpx(
      profile([{ repo: "anthropics/skills", skills: ["pdf"] }]),
      { repoRoot, fetch: explodingFetcher, offline: true },
    );
    expect(plans).toHaveLength(1);
  });

  it("treats partial cache as CacheCorrupt under offline=true", async () => {
    // Seed only "pdf"; request "pdf" + "xlsx".
    seedCache("anthropics/skills", undefined, ["pdf"]);
    await expect(
      resolveNpx(
        profile([{ repo: "anthropics/skills", skills: ["pdf", "xlsx"] }]),
        { repoRoot, fetch: explodingFetcher, offline: true },
      ),
    ).rejects.toBeInstanceOf(CacheCorrupt);
  });

  it("honors SOUL_OFFLINE=1 env when opts.offline is undefined", async () => {
    const prev = process.env.SOUL_OFFLINE;
    process.env.SOUL_OFFLINE = "1";
    try {
      await expect(
        resolveNpx(
          profile([{ repo: "anthropics/skills", skills: ["pdf"] }]),
          { repoRoot, fetch: explodingFetcher },
        ),
      ).rejects.toBeInstanceOf(NpxFetchFailed);
    } finally {
      if (prev === undefined) delete process.env.SOUL_OFFLINE;
      else process.env.SOUL_OFFLINE = prev;
    }
  });
});

// --- pins ------------------------------------------------------------------

describe("resolveNpx — pin variants", () => {
  it("git@<sha> pin produces its own cache slot", async () => {
    const fetcher = fakeFetcher();
    await resolveNpx(
      profile([{ repo: "anthropics/skills", pin: "git@deadbeefcafe", skills: ["pdf"] }]),
      { repoRoot, fetch: fetcher },
    );
    expect(calls[0].pin).toBe("git@deadbeefcafe");
    const key = cacheKey("anthropics/skills", "git@deadbeefcafe");
    expect(existsSync(cachePath({ repoRoot }, key))).toBe(true);
    // HEAD slot should NOT exist
    const headKey = cacheKey("anthropics/skills", undefined);
    expect(existsSync(cachePath({ repoRoot }, headKey))).toBe(false);
  });

  it("tag@v1.2.3 pin produces its own cache slot", async () => {
    const fetcher = fakeFetcher();
    await resolveNpx(
      profile([{ repo: "anthropics/skills", pin: "tag@v1.2.3", skills: ["pdf"] }]),
      { repoRoot, fetch: fetcher },
    );
    expect(calls[0].pin).toBe("tag@v1.2.3");
    const key = cacheKey("anthropics/skills", "tag@v1.2.3");
    expect(existsSync(cacheSkillPath({ repoRoot }, key, "pdf"))).toBe(true);
  });

  it("different pins on same repo do not share cache slots", async () => {
    const fetcher = fakeFetcher();
    await resolveNpx(
      profile([
        { repo: "anthropics/skills", pin: "tag@v1.0.0", skills: ["pdf"] },
        { repo: "anthropics/skills", pin: "tag@v2.0.0", skills: ["pdf"] },
      ]),
      { repoRoot, fetch: fetcher },
    );
    expect(calls).toHaveLength(2);
    const k1 = cacheKey("anthropics/skills", "tag@v1.0.0");
    const k2 = cacheKey("anthropics/skills", "tag@v2.0.0");
    expect(k1).not.toBe(k2);
    expect(existsSync(cachePath({ repoRoot }, k1))).toBe(true);
    expect(existsSync(cachePath({ repoRoot }, k2))).toBe(true);
  });
});

// --- corrupt / pin-not-found -----------------------------------------------

describe("resolveNpx — error paths", () => {
  it("PinNotFound when fetcher silently produces no skill dir", async () => {
    const sneakyFetcher: NpxFetchFn = async () => {
      // does not create <destDir>/<skill>/ — simulates a bad pin where
      // `npx skills add` succeeds but ships nothing.
    };
    await expect(
      resolveNpx(
        profile([{ repo: "anthropics/skills", pin: "tag@bogus", skills: ["pdf"] }]),
        { repoRoot, fetch: sneakyFetcher },
      ),
    ).rejects.toBeInstanceOf(PinNotFound);
  });

  it("repairs a partial cache by re-fetching only the missing skills (online)", async () => {
    // Seed cache with "pdf" but request "pdf" + "xlsx".
    seedCache("anthropics/skills", undefined, ["pdf"]);
    const fetcher = fakeFetcher();
    const plans = await resolveNpx(
      profile([{ repo: "anthropics/skills", skills: ["pdf", "xlsx"] }]),
      { repoRoot, fetch: fetcher },
    );
    expect(plans).toHaveLength(2);
    // Only xlsx should have been fetched; pdf was warm.
    expect(calls.map((c) => c.skill)).toEqual(["xlsx"]);
    const key = cacheKey("anthropics/skills", undefined);
    expect(existsSync(cacheSkillPath({ repoRoot }, key, "pdf"))).toBe(true);
    expect(existsSync(cacheSkillPath({ repoRoot }, key, "xlsx"))).toBe(true);
  });

  it("propagates fetcher errors as NpxFetchFailed via the public surface", async () => {
    const failingFetcher: NpxFetchFn = async () => {
      throw new NpxFetchFailed("anthropics/skills", "synthetic boom");
    };
    await expect(
      resolveNpx(
        profile([{ repo: "anthropics/skills", skills: ["pdf"] }]),
        { repoRoot, fetch: failingFetcher },
      ),
    ).rejects.toBeInstanceOf(NpxFetchFailed);
  });
});

// --- detailed result -------------------------------------------------------

describe("resolveNpxDetailed", () => {
  it("returns cache keys keyed by repo@pin", async () => {
    seedCache("anthropics/skills", "tag@v1.0.0", ["pdf"]);
    const { plans, keys } = await resolveNpxDetailed(
      profile([{ repo: "anthropics/skills", pin: "tag@v1.0.0", skills: ["pdf"] }]),
      { repoRoot, fetch: explodingFetcher },
    );
    expect(plans).toHaveLength(1);
    expect(keys["anthropics/skills@tag@v1.0.0"]).toBe(
      cacheKey("anthropics/skills", "tag@v1.0.0"),
    );
  });
});

// --- flattenNpxLayout: post-fetch path relocation --------------------------

describe("flattenNpxLayout", () => {
  let staging: string;

  beforeEach(() => {
    staging = mkdtempSync(join(tmpdir(), "cue-flatten-test-"));
  });
  afterEach(() => {
    try { rmSync(staging, { recursive: true, force: true }); } catch {}
  });

  it("relocates <staging>/.claude/skills/<skill>/ → <staging>/<skill>/", async () => {
    const { flattenNpxLayout } = await import("./resolver-npx");

    // Set up the layout the `skills` CLI actually produces.
    const fromPath = join(staging, ".claude", "skills", "my-skill");
    mkdirSync(fromPath, { recursive: true });
    writeFileSync(join(fromPath, "SKILL.md"), "# my-skill\n");

    flattenNpxLayout(staging, "my-skill");

    const flatPath = join(staging, "my-skill");
    expect(existsSync(flatPath)).toBe(true);
    expect(existsSync(join(flatPath, "SKILL.md"))).toBe(true);
    expect(existsSync(fromPath)).toBe(false);
    // Cleanup: .claude/ should be gone now (was empty after the move).
    expect(existsSync(join(staging, ".claude"))).toBe(false);
  });

  it("is a no-op if <staging>/<skill>/ already exists (don't clobber)", async () => {
    const { flattenNpxLayout } = await import("./resolver-npx");

    const existing = join(staging, "my-skill");
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, "EXISTING.md"), "do not overwrite\n");

    const fromPath = join(staging, ".claude", "skills", "my-skill");
    mkdirSync(fromPath, { recursive: true });
    writeFileSync(join(fromPath, "NEW.md"), "would clobber existing\n");

    flattenNpxLayout(staging, "my-skill");

    // The existing skill is preserved.
    expect(existsSync(join(existing, "EXISTING.md"))).toBe(true);
    expect(existsSync(join(existing, "NEW.md"))).toBe(false);
  });

  it("is a no-op when source layout is absent (e.g. CLI changed again)", async () => {
    const { flattenNpxLayout } = await import("./resolver-npx");

    // Nothing in staging — flattening should be silent, not throw.
    expect(() => flattenNpxLayout(staging, "missing-skill")).not.toThrow();
    expect(existsSync(join(staging, "missing-skill"))).toBe(false);
  });

  it("leaves sibling skills under .claude/skills/ alone when relocating one", async () => {
    const { flattenNpxLayout } = await import("./resolver-npx");

    const skillsDir = join(staging, ".claude", "skills");
    mkdirSync(join(skillsDir, "alpha"), { recursive: true });
    mkdirSync(join(skillsDir, "beta"), { recursive: true });
    writeFileSync(join(skillsDir, "alpha", "SKILL.md"), "");
    writeFileSync(join(skillsDir, "beta", "SKILL.md"), "");

    flattenNpxLayout(staging, "alpha");

    // alpha got moved out, beta stayed in place — the .claude tree is still
    // present because beta is still there.
    expect(existsSync(join(staging, "alpha", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsDir, "beta", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsDir, "alpha"))).toBe(false);
  });
});

// --- network resilience ----------------------------------------------------

describe("isTransientNpxFailure", () => {
  it("retries spawn errors but not a missing npx binary", async () => {
    const { isTransientNpxFailure } = await import("./resolver-npx");
    const enoent = Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" });
    const etimedout = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });

    expect(isTransientNpxFailure({ error: enoent })).toBe(false);
    expect(isTransientNpxFailure({ error: etimedout })).toBe(true);
  });

  it("classifies network stderr as transient", async () => {
    const { isTransientNpxFailure } = await import("./resolver-npx");
    for (const stderr of [
      "request to https://registry.npmjs.org failed, reason: getaddrinfo EAI_AGAIN",
      "Error: socket hang up",
      "npm ERR! 503 Service Unavailable",
      "TypeError: fetch failed",
      "npm ERR! code ECONNRESET",
    ]) {
      expect(isTransientNpxFailure({ status: 1, stderr })).toBe(true);
    }
  });

  it("does not retry a repo/skill that does not exist", async () => {
    const { isTransientNpxFailure } = await import("./resolver-npx");
    for (const stderr of [
      "Error: skill 'nope' not found in owner/repo",
      "HTTP 404: Not Found (https://api.github.com/repos/owner/repo)",
      "npm ERR! 403 Forbidden",
    ]) {
      expect(isTransientNpxFailure({ status: 1, stderr })).toBe(false);
    }
  });
});

describe("resolveNpxDetailed — tolerateFetchFailure", () => {
  it("throws by default when a fetch fails (validate must still fail)", async () => {
    const boom: NpxFetchFn = async () => {
      throw new NpxFetchFailed("owner/repo", "exit 1");
    };
    await expect(
      resolveNpxDetailed(profile([{ repo: "owner/repo", skills: ["a"] }]), {
        repoRoot,
        fetch: boom,
      }),
    ).rejects.toBeInstanceOf(NpxFetchFailed);
  });

  it("drops the unreachable repo and reports it instead of failing the launch", async () => {
    const boom: NpxFetchFn = async () => {
      throw new NpxFetchFailed("owner/down", "exit 1");
    };

    const { plans, failures } = await resolveNpxDetailed(
      profile([
        { repo: "owner/up", skills: ["good"] },
        { repo: "owner/down", skills: ["gone"] },
      ]),
      {
        repoRoot,
        fetch: async (repo, pin, skill, destDir) => {
          if (repo === "owner/down") return boom(repo, pin, skill, destDir);
          return fakeFetcher()(repo, pin, skill, destDir);
        },
        tolerateFetchFailure: true,
      },
    );

    expect(plans.map((p) => p.target)).toEqual([".claude/skills/good"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.repo).toBe("owner/down");
    expect(failures[0]!.skills).toEqual(["gone"]);
    expect(failures[0]!.servedFromCache).toEqual([]);
  });

  it("serves the cached copy when the refetch of a partial slot fails", async () => {
    // Slot holds `warm` but not `cold`; the repair fetch dies on the network.
    const key = seedCache("owner/repo", undefined, ["warm"]);
    const boom: NpxFetchFn = async () => {
      throw new NpxFetchFailed("owner/repo", "getaddrinfo EAI_AGAIN");
    };

    const { plans, failures } = await resolveNpxDetailed(
      profile([{ repo: "owner/repo", skills: ["warm", "cold"] }]),
      { repoRoot, fetch: boom, tolerateFetchFailure: true },
    );

    expect(plans).toEqual([
      {
        source: cacheSkillPath({ repoRoot }, key, "warm"),
        target: ".claude/skills/warm",
        origin: "npx",
      },
    ]);
    expect(failures[0]!.servedFromCache).toEqual(["warm"]);
    expect(failures[0]!.skills).toEqual(["cold"]);
  });
});

describe("isTransientNpxFailure — private/auth repos", () => {
  it("treats a private-repo auth failure as permanent", async () => {
    const { isTransientNpxFailure } = await import("./resolver-npx");
    expect(
      isTransientNpxFailure({
        status: 1,
        stderr:
          "Authentication failed for https://github.com/xixu-me/skills.git.\n  - For private repos, ensure you have access",
      }),
    ).toBe(false);
  });
});

// --- negative cache (remembered fetch failures) -----------------------------

describe("negative cache", () => {
  /** Fetcher that fails every time, counting attempts. */
  function failingFetcher(): { fetch: NpxFetchFn; count: () => number } {
    let n = 0;
    return {
      fetch: async (repo) => {
        n++;
        throw new NpxFetchFailed(repo, "spawnSync npx ETIMEDOUT");
      },
      count: () => n,
    };
  }

  it("skips the second attempt while the cooldown is unexpired", async () => {
    const f = failingFetcher();
    const p = profile([{ repo: "github/awesome-copilot", skills: ["pytest-coverage"] }]);

    const first = await resolveNpxDetailed(p, {
      repoRoot,
      fetch: f.fetch,
      tolerateFetchFailure: true,
    });
    expect(f.count()).toBe(1);
    expect(first.failures[0]?.skipped).toBeUndefined();

    const second = await resolveNpxDetailed(p, {
      repoRoot,
      fetch: f.fetch,
      tolerateFetchFailure: true,
    });
    // No new fetch: this is the whole point — a doomed repo must not cost the
    // full retry budget on every single launch.
    expect(f.count()).toBe(1);
    expect(second.failures[0]?.skipped).toBe(true);
    expect(second.failures[0]?.retryInMs).toBeGreaterThan(0);
    expect(second.plans).toEqual([]);
  });

  it("retries once the cooldown has elapsed", async () => {
    const f = failingFetcher();
    const p = profile([{ repo: "a/b", skills: ["s"] }]);
    const opts = { repoRoot, fetch: f.fetch, tolerateFetchFailure: true };

    await resolveNpxDetailed(p, opts);
    expect(f.count()).toBe(1);

    // 0 disables the cooldown entirely, which is also how a user opts out.
    process.env.CUE_NPX_RETRY_COOLDOWN_MS = "0";
    try {
      await resolveNpxDetailed(p, opts);
    } finally {
      delete process.env.CUE_NPX_RETRY_COOLDOWN_MS;
    }
    expect(f.count()).toBe(2);
  });

  it("force ignores the remembered failure", async () => {
    const f = failingFetcher();
    const p = profile([{ repo: "a/b", skills: ["s"] }]);

    await resolveNpxDetailed(p, { repoRoot, fetch: f.fetch, tolerateFetchFailure: true });
    await resolveNpxDetailed(p, {
      repoRoot,
      fetch: f.fetch,
      tolerateFetchFailure: true,
      force: true,
    });
    expect(f.count()).toBe(2);
  });

  it("does not suppress non-degrading callers (validate must see the truth)", async () => {
    const f = failingFetcher();
    const p = profile([{ repo: "a/b", skills: ["s"] }]);

    await resolveNpxDetailed(p, { repoRoot, fetch: f.fetch, tolerateFetchFailure: true });
    await expect(resolveNpxDetailed(p, { repoRoot, fetch: f.fetch })).rejects.toThrow(
      NpxFetchFailed,
    );
    expect(f.count()).toBe(2);
  });

  it("a warm cache slot is served even while a marker is fresh", async () => {
    const f = failingFetcher();
    const p = profile([{ repo: "a/b", skills: ["s"] }]);

    await resolveNpxDetailed(p, { repoRoot, fetch: f.fetch, tolerateFetchFailure: true });
    seedCache("a/b", undefined, ["s"]);

    const res = await resolveNpxDetailed(p, {
      repoRoot,
      fetch: explodingFetcher,
      tolerateFetchFailure: true,
    });
    expect(res.failures).toEqual([]);
    expect(res.plans).toHaveLength(1);
  });

  it("a later success clears the marker", async () => {
    const f = failingFetcher();
    const p = profile([{ repo: "a/b", skills: ["s"] }]);

    await resolveNpxDetailed(p, { repoRoot, fetch: f.fetch, tolerateFetchFailure: true });
    // Force past the cooldown with a working fetcher, then confirm the next
    // (unforced) resolve is not suppressed by the stale marker.
    await resolveNpxDetailed(p, {
      repoRoot,
      fetch: fakeFetcher(),
      tolerateFetchFailure: true,
      force: true,
    });
    rmSync(cachePath({ repoRoot }, cacheKey("a/b", undefined)), {
      recursive: true,
      force: true,
    });
    const after = await resolveNpxDetailed(p, {
      repoRoot,
      fetch: fakeFetcher(),
      tolerateFetchFailure: true,
    });
    expect(after.failures).toEqual([]);
    expect(after.plans).toHaveLength(1);
  });
});

// --- cache convergence -----------------------------------------------------

describe("cache eviction during a resolve", () => {
  /**
   * Regression: eviction runs from inside cachePut, so a profile with more
   * entries than the cache cap used to evict the slots it had just written.
   * The observable damage was twofold — the profile re-fetched everything on
   * every launch, and half its resolved LinkPlan sources pointed at directories
   * that no longer existed by the time the materializer read them.
   *
   * The cap is pinned low here on purpose: the invariant is that a resolve
   * converges regardless of how the cap compares to the entry count.
   */
  const OVERSIZED = 12;

  beforeEach(() => {
    process.env.CUE_NPX_CACHE_MAX = "4";
  });
  afterEach(() => {
    delete process.env.CUE_NPX_CACHE_MAX;
  });

  function bigProfile(): Profile {
    return profile(
      Array.from({ length: OVERSIZED }, (_, i) => ({
        repo: `owner/repo-${i}`,
        skills: ["s"],
      })),
    );
  }

  it("does not evict slots the same resolve just wrote", async () => {
    const p = bigProfile();
    const res = await resolveNpxDetailed(p, { repoRoot, fetch: fakeFetcher() });

    expect(res.plans).toHaveLength(OVERSIZED);
    const dangling = res.plans.filter((plan) => !existsSync(plan.source));
    expect(dangling).toEqual([]);
  });

  it("a second resolve is a full cache hit", async () => {
    const p = bigProfile();
    await resolveNpxDetailed(p, { repoRoot, fetch: fakeFetcher() });
    const before = calls.length;

    const res = await resolveNpxDetailed(p, { repoRoot, fetch: explodingFetcher });
    expect(calls.length).toBe(before);
    expect(res.plans).toHaveLength(OVERSIZED);
  });

  it("still evicts unprotected slots from earlier runs", async () => {
    await resolveNpxDetailed(profile([{ repo: "owner/stale", skills: ["s"] }]), {
      repoRoot,
      fetch: fakeFetcher(),
    });
    const stale = cachePath({ repoRoot }, cacheKey("owner/stale", undefined));
    expect(existsSync(stale)).toBe(true);

    await resolveNpxDetailed(bigProfile(), { repoRoot, fetch: fakeFetcher() });
    // Not in the second resolve's protected set, and well past the cap.
    expect(existsSync(stale)).toBe(false);
  });
});

// --- concurrency -----------------------------------------------------------

describe("parallel entry resolution", () => {
  afterEach(() => {
    delete process.env.CUE_NPX_CONCURRENCY;
  });

  /** Fetcher that holds each call open for `ms`, tracking peak overlap. */
  function slowFetcher(ms: number) {
    let inFlight = 0;
    let peak = 0;
    const fetch: NpxFetchFn = async (repo, pin, skill, destDir) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      mkdirSync(join(destDir, skill), { recursive: true });
      writeFileSync(join(destDir, skill, "SKILL.md"), "# x\n");
      inFlight--;
    };
    return { fetch, peak: () => peak };
  }

  const eight = (): Profile =>
    profile(Array.from({ length: 8 }, (_, i) => ({ repo: `o/r${i}`, skills: ["s"] })));

  it("fetches repos concurrently", async () => {
    const f = slowFetcher(30);
    await resolveNpxDetailed(eight(), { repoRoot, fetch: f.fetch });
    expect(f.peak()).toBeGreaterThan(1);
  });

  it("honors the concurrency limit", async () => {
    process.env.CUE_NPX_CONCURRENCY = "2";
    const f = slowFetcher(30);
    await resolveNpxDetailed(eight(), { repoRoot, fetch: f.fetch });
    expect(f.peak()).toBe(2);
  });

  it("CUE_NPX_CONCURRENCY=1 is serial", async () => {
    process.env.CUE_NPX_CONCURRENCY = "1";
    const f = slowFetcher(5);
    await resolveNpxDetailed(eight(), { repoRoot, fetch: f.fetch });
    expect(f.peak()).toBe(1);
  });

  it("keeps plan order at the profile's declaration order", async () => {
    // Later entries finish first, so any order-by-completion bug shows up here.
    const delays = [50, 40, 30, 20, 10];
    const fetch: NpxFetchFn = async (repo, pin, skill, destDir) => {
      const idx = Number(repo.split("r")[1]);
      await new Promise((r) => setTimeout(r, delays[idx] ?? 0));
      mkdirSync(join(destDir, skill), { recursive: true });
      writeFileSync(join(destDir, skill, "SKILL.md"), "# x\n");
    };
    const p = profile(
      delays.map((_, i) => ({ repo: `o/r${i}`, skills: [`skill-${i}`] })),
    );

    const res = await resolveNpxDetailed(p, { repoRoot, fetch });
    expect(res.plans.map((pl) => pl.target)).toEqual([
      ".claude/skills/skill-0",
      ".claude/skills/skill-1",
      ".claude/skills/skill-2",
      ".claude/skills/skill-3",
      ".claude/skills/skill-4",
    ]);
  });

  it("one failure does not take down the other lanes", async () => {
    const fetch: NpxFetchFn = async (repo, pin, skill, destDir) => {
      if (repo === "o/r2") throw new NpxFetchFailed(repo, "boom");
      mkdirSync(join(destDir, skill), { recursive: true });
      writeFileSync(join(destDir, skill, "SKILL.md"), "# x\n");
    };
    const res = await resolveNpxDetailed(eight(), {
      repoRoot,
      fetch,
      tolerateFetchFailure: true,
    });
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]?.repo).toBe("o/r2");
    expect(res.plans).toHaveLength(7);
  });
});

// --- escalating backoff ----------------------------------------------------

describe("escalating cooldown", () => {
  afterEach(() => {
    delete process.env.CUE_NPX_RETRY_COOLDOWN_MS;
  });

  const failing: NpxFetchFn = async (repo) => {
    throw new NpxFetchFailed(repo, "spawnSync npx ETIMEDOUT");
  };

  /** Fail once with the cooldown disabled, so every call reaches the fetcher. */
  async function strike(p: Profile): Promise<number | undefined> {
    process.env.CUE_NPX_RETRY_COOLDOWN_MS = "0";
    await resolveNpxDetailed(p, { repoRoot, fetch: failing, tolerateFetchFailure: true });
    // Now measure the cooldown a 1s base would produce for the strikes so far.
    process.env.CUE_NPX_RETRY_COOLDOWN_MS = "1000";
    const res = await resolveNpxDetailed(p, {
      repoRoot,
      fetch: failing,
      tolerateFetchFailure: true,
    });
    return res.failures[0]?.retryInMs;
  }

  it("doubles the wait on each consecutive failure", async () => {
    const p = profile([{ repo: "a/b", skills: ["s"] }]);

    const first = await strike(p);
    const second = await strike(p);
    const third = await strike(p);

    // 1 strike -> ~1s, 2 -> ~2s, 3 -> ~4s (minus the elapsed test time).
    expect(first).toBeGreaterThan(500);
    expect(first).toBeLessThanOrEqual(1000);
    expect(second).toBeGreaterThan(1000);
    expect(second).toBeLessThanOrEqual(2000);
    expect(third).toBeGreaterThan(2000);
    expect(third).toBeLessThanOrEqual(4000);
  });

  it("a success resets the escalation", async () => {
    const p = profile([{ repo: "a/c", skills: ["s"] }]);
    await strike(p);
    await strike(p);

    process.env.CUE_NPX_RETRY_COOLDOWN_MS = "0";
    await resolveNpxDetailed(p, { repoRoot, fetch: fakeFetcher(), tolerateFetchFailure: true });
    rmSync(cachePath({ repoRoot }, cacheKey("a/c", undefined)), {
      recursive: true,
      force: true,
    });

    // Back to a single strike, so back to the base cooldown.
    const after = await strike(p);
    expect(after).toBeLessThanOrEqual(1000);
  });

  it("never escalates past the one-week ceiling", async () => {
    const p = profile([{ repo: "a/d", skills: ["s"] }]);
    process.env.CUE_NPX_RETRY_COOLDOWN_MS = "0";
    for (let i = 0; i < 12; i++) {
      await resolveNpxDetailed(p, { repoRoot, fetch: failing, tolerateFetchFailure: true });
    }
    // 12 strikes against a 1h base would be 2048h without a ceiling.
    process.env.CUE_NPX_RETRY_COOLDOWN_MS = String(60 * 60 * 1000);
    const res = await resolveNpxDetailed(p, {
      repoRoot,
      fetch: failing,
      tolerateFetchFailure: true,
    });
    expect(res.failures[0]?.retryInMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
    expect(res.failures[0]?.retryInMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
  });
});

// --- offline mode ----------------------------------------------------------

describe("offline mode and the negative cache", () => {
  /**
   * Regression: offline mode throws WITHOUT attempting a fetch. Recording that
   * as a remote failure left a marker that outlived the offline session and
   * suppressed real fetches for a whole cooldown after the network came back.
   */
  it("a cold offline miss leaves no marker", async () => {
    const p = profile([{ repo: "a/b", skills: ["s"] }]);

    const offlineRes = await resolveNpxDetailed(p, {
      repoRoot,
      fetch: explodingFetcher,
      offline: true,
      tolerateFetchFailure: true,
    });
    expect(offlineRes.failures).toHaveLength(1);

    // Back online: the very next resolve must fetch for real, not skip.
    const res = await resolveNpxDetailed(p, {
      repoRoot,
      fetch: fakeFetcher(),
      tolerateFetchFailure: true,
    });
    expect(res.failures).toEqual([]);
    expect(res.plans).toHaveLength(1);
  });
});

// --- cooldown expiry and fatal-error fan-out -------------------------------

describe("remainingCooldownMs", () => {
  const mark = (over: Partial<FetchFailureMark> = {}): FetchFailureMark => ({
    at: Date.now(),
    reason: "boom",
    strikes: 1,
    ...over,
  });

  it("is zero once the cooldown has elapsed", async () => {
    const { remainingCooldownMs } = await import("./resolver-npx");
    expect(remainingCooldownMs(mark({ at: Date.now() - 5000 }), 1000)).toBe(0);
  });

  it("is zero when the cooldown is disabled", async () => {
    const { remainingCooldownMs } = await import("./resolver-npx");
    expect(remainingCooldownMs(mark(), 0)).toBe(0);
  });

  it("is zero for a future-dated marker", async () => {
    const { remainingCooldownMs } = await import("./resolver-npx");
    expect(remainingCooldownMs(mark({ at: Date.now() + 60_000 }), 1000)).toBe(0);
  });

  it("counts down inside the window, scaled by strikes", async () => {
    const { remainingCooldownMs } = await import("./resolver-npx");
    const now = 1_000_000;
    expect(remainingCooldownMs({ at: now, reason: "b", strikes: 1 }, 1000, now)).toBe(1000);
    expect(remainingCooldownMs({ at: now, reason: "b", strikes: 3 }, 1000, now)).toBe(4000);
  });
});

describe("a fatal error stops the whole fan-out", () => {
  /**
   * Regression: Promise.all rejects on the first failure, but the other lanes
   * kept pulling entries and writing to the cache after the caller had already
   * moved on to error handling.
   */
  it("stops scheduling and awaits every lane before throwing", async () => {
    let started = 0;
    let running = 0;
    const fetch: NpxFetchFn = async (repo, pin, skill, destDir) => {
      started++;
      running++;
      try {
        await new Promise((r) => setTimeout(r, 10));
        if (repo === "o/r0") throw new NpxFetchFailed(repo, "boom");
        mkdirSync(join(destDir, skill), { recursive: true });
        writeFileSync(join(destDir, skill, "SKILL.md"), "# x\n");
      } finally {
        running--;
      }
    };
    const p = profile(
      Array.from({ length: 40 }, (_, i) => ({ repo: `o/r${i}`, skills: ["s"] })),
    );

    // No tolerateFetchFailure: the first failure must abort the resolve.
    await expect(resolveNpxDetailed(p, { repoRoot, fetch })).rejects.toThrow(
      NpxFetchFailed,
    );
    // Nothing left in flight once the rejection surfaces.
    expect(running).toBe(0);
    // And the remaining entries were never scheduled.
    expect(started).toBeLessThan(40);
  });
});
