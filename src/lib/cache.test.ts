import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  MAX_CACHE_ENTRIES,
  cacheChildren,
  cacheEvict,
  cacheHit,
  cachePath,
  cachePut,
  cacheSkillPath,
  type CacheLayout,
} from "./cache";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cue-cache-test-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// MAX_CACHE_ENTRIES
// ---------------------------------------------------------------------------

describe("MAX_CACHE_ENTRIES", () => {
  /**
   * The cap is a budget, but it has one hard floor: a single profile's npx
   * entries must all fit. Below that floor the profile re-fetches every repo on
   * every launch, because eviction fires from inside cachePut while that same
   * profile is still being resolved. (`protect` keeps such a profile CORRECT
   * even under a small cap — this test keeps it FAST, by sizing the budget so
   * protection is not doing the work alone.)
   */
  test("fits the largest bundled profile", () => {
    const profilesDir = join(import.meta.dir, "..", "..", "profiles");
    let largest = 0;
    let worst = "";
    for (const name of readdirSync(profilesDir)) {
      const file = join(profilesDir, name, "profile.yaml");
      if (!existsSync(file)) continue;
      const doc = parseYaml(readFileSync(file, "utf8")) as {
        skills?: { npx?: unknown[] };
      };
      const count = doc?.skills?.npx?.length ?? 0;
      if (count > largest) {
        largest = count;
        worst = name;
      }
    }
    // Guard against the scan silently finding nothing.
    expect(largest).toBeGreaterThan(0);
    expect(
      MAX_CACHE_ENTRIES,
      `profile "${worst}" needs ${largest} cache slots`,
    ).toBeGreaterThanOrEqual(largest);
  });
});

// ---------------------------------------------------------------------------
// cachePath
// ---------------------------------------------------------------------------

describe("cachePath", () => {
  test("resolves under npx/ when using cacheRoot", () => {
    const layout: CacheLayout = { cacheRoot: tmpDir };
    expect(cachePath(layout, "abc123")).toBe(join(tmpDir, "npx", "abc123"));
  });

  test("resolves under profiles/_cache/npx/ when using repoRoot", () => {
    const layout: CacheLayout = { repoRoot: tmpDir };
    expect(cachePath(layout, "deadbeef")).toBe(
      join(tmpDir, "profiles", "_cache", "npx", "deadbeef"),
    );
  });

  test("throws on a key that contains a forward slash", () => {
    const layout: CacheLayout = { cacheRoot: tmpDir };
    expect(() => cachePath(layout, "abc/def")).toThrow();
  });

  test("throws on a key that contains '..'", () => {
    const layout: CacheLayout = { cacheRoot: tmpDir };
    expect(() => cachePath(layout, "..")).toThrow();
  });

  test("throws on an empty key", () => {
    const layout: CacheLayout = { cacheRoot: tmpDir };
    expect(() => cachePath(layout, "")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// cacheHit
// ---------------------------------------------------------------------------

describe("cacheHit", () => {
  test("returns false for a key whose directory has never been created", () => {
    const layout: CacheLayout = { cacheRoot: tmpDir };
    expect(cacheHit(layout, "no-such-key-xyz")).toBe(false);
  });

  test("returns false when the cache directory exists but is empty", () => {
    const layout: CacheLayout = { cacheRoot: tmpDir };
    const dir = cachePath(layout, "empty-slot");
    mkdirSync(dir, { recursive: true });
    expect(cacheHit(layout, "empty-slot")).toBe(false);
  });

  test("returns true when the cache directory has at least one file", () => {
    const layout: CacheLayout = { cacheRoot: tmpDir };
    const dir = cachePath(layout, "populated-slot");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# test skill");
    expect(cacheHit(layout, "populated-slot")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cachePut
// ---------------------------------------------------------------------------

describe("cachePut", () => {
  test("moves the source directory into the cache slot", () => {
    const layout: CacheLayout = { cacheRoot: tmpDir };
    const src = mkdtempSync(join(tmpdir(), "cue-put-src-"));
    writeFileSync(join(src, "SKILL.md"), "# my skill");

    const dest = cachePut(layout, "put-key", src);

    expect(existsSync(dest)).toBe(true);
    expect(existsSync(join(dest, "SKILL.md"))).toBe(true);
    // Source was moved, not copied — it must no longer exist at the old path.
    expect(existsSync(src)).toBe(false);
  });

  test("throws when the source directory does not exist", () => {
    const layout: CacheLayout = { cacheRoot: tmpDir };
    expect(() =>
      cachePut(layout, "bad-src-key", "/tmp/cue-nonexistent-dir-xyz-abc"),
    ).toThrow();
  });

  test("replaces an existing cache slot, keeping only the new content", () => {
    const layout: CacheLayout = { cacheRoot: tmpDir };

    const src1 = mkdtempSync(join(tmpdir(), "cue-replace1-"));
    writeFileSync(join(src1, "v1.md"), "version 1");
    cachePut(layout, "replace-key", src1);

    const src2 = mkdtempSync(join(tmpdir(), "cue-replace2-"));
    writeFileSync(join(src2, "v2.md"), "version 2");
    const dest = cachePut(layout, "replace-key", src2);

    expect(existsSync(join(dest, "v2.md"))).toBe(true);
    expect(existsSync(join(dest, "v1.md"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cacheChildren
// ---------------------------------------------------------------------------

describe("cacheChildren", () => {
  test("returns an empty array for a key that does not exist", () => {
    const layout: CacheLayout = { cacheRoot: tmpDir };
    expect(cacheChildren(layout, "no-key-xyz")).toEqual([]);
  });

  test("returns the filenames inside an existing slot", () => {
    const layout: CacheLayout = { cacheRoot: tmpDir };
    const src = mkdtempSync(join(tmpdir(), "cue-children-"));
    writeFileSync(join(src, "alpha"), "a");
    writeFileSync(join(src, "beta"), "b");
    cachePut(layout, "children-key", src);

    expect(cacheChildren(layout, "children-key").sort()).toEqual([
      "alpha",
      "beta",
    ]);
  });
});

// ---------------------------------------------------------------------------
// cacheSkillPath
// ---------------------------------------------------------------------------

describe("cacheSkillPath", () => {
  test("returns the absolute path to a named skill inside a cache slot", () => {
    const layout: CacheLayout = { cacheRoot: tmpDir };
    expect(cacheSkillPath(layout, "mykey", "my-skill")).toBe(
      join(tmpDir, "npx", "mykey", "my-skill"),
    );
  });
});

// ---------------------------------------------------------------------------
// cacheEvict
// ---------------------------------------------------------------------------

describe("cacheEvict", () => {
  test("returns 0 when the cache root does not exist", () => {
    const freshDir = mkdtempSync(join(tmpdir(), "cue-evict-empty-"));
    try {
      // npx/ subdir is never created, so there is nothing to evict.
      const layout: CacheLayout = { cacheRoot: freshDir };
      expect(cacheEvict(layout)).toBe(0);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test("returns 0 when entries are within budget", () => {
    const freshDir = mkdtempSync(join(tmpdir(), "cue-evict-under-"));
    try {
      const layout: CacheLayout = { cacheRoot: freshDir };
      for (let i = 0; i < 3; i++) {
        const src = mkdtempSync(join(tmpdir(), "cue-evict-under-src-"));
        writeFileSync(join(src, "f"), "x");
        cachePut(layout, `under-key-${i}`, src);
      }
      // Budget of 5 means 3 entries should not trigger any eviction.
      expect(cacheEvict(layout, 5)).toBe(0);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test("evicts oldest entries when over budget and returns the removed count", () => {
    const freshDir = mkdtempSync(join(tmpdir(), "cue-evict-over-"));
    try {
      const layout: CacheLayout = { cacheRoot: freshDir };
      for (let i = 0; i < 5; i++) {
        const src = mkdtempSync(join(tmpdir(), "cue-evict-fill-"));
        writeFileSync(join(src, "f"), `entry-${i}`);
        cachePut(layout, `over-key-${i}`, src);
      }

      const removed = cacheEvict(layout, 3);
      expect(removed).toBe(2);

      const npxDir = join(freshDir, "npx");
      expect(readdirSync(npxDir).length).toBe(3);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});
