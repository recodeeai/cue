import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  candidateProfileUrls,
  fetchProfileYaml,
  listInstalled,
  namespaceProfileYaml,
  parseShareRef,
  removeInstall,
  sharedProfileDir,
  sharedProfileName,
  sharedRoot,
  writeInstall,
} from "./shared-profiles";

describe("parseShareRef", () => {
  test("shorthand user/repo", () => {
    expect(parseShareRef("jane/medusa-shop")).toEqual({
      user: "jane", repo: "medusa-shop",
    });
  });

  test("shorthand with @ref", () => {
    expect(parseShareRef("jane/medusa-shop@v1.2")).toEqual({
      user: "jane", repo: "medusa-shop", ref: "v1.2",
    });
  });

  test("shorthand with :subpath", () => {
    expect(parseShareRef("jane/dotfiles:profiles/storefront")).toEqual({
      user: "jane", repo: "dotfiles", subpath: "profiles/storefront",
    });
  });

  test("github.com URL", () => {
    expect(parseShareRef("https://github.com/jane/medusa-shop")).toEqual({
      user: "jane", repo: "medusa-shop",
    });
  });

  test("github.com URL with tree/ref/subpath", () => {
    expect(parseShareRef("https://github.com/jane/medusa-shop/tree/v1/profiles/storefront")).toEqual({
      user: "jane", repo: "medusa-shop", ref: "v1", subpath: "profiles/storefront",
    });
  });

  test("strips .git suffix from URL", () => {
    expect(parseShareRef("https://github.com/jane/medusa-shop.git")).toEqual({
      user: "jane", repo: "medusa-shop",
    });
  });

  test("rejects nonsense", () => {
    expect(parseShareRef("")).toBeNull();
    expect(parseShareRef("not-a-ref")).toBeNull();
    expect(parseShareRef("/leading/slash/bad")).toBeNull();
  });

  test("rejects traversal, shell syntax, encoded separators, and non-GitHub URLs", () => {
    for (const input of [
      "jane/..", "jane/.", "../repo", "jane/repo:../outside", "jane/repo:/absolute",
      "jane/repo:profiles//shop", "jane/repo@../main", "jane/repo:profiles/./shop",
      "jane/repo:profiles/shop;whoami", "jane/repo:profiles\\shop",
      "https://github.com/jane/repo/tree/main/%2e%2e/outside",
      "https://github.com/jane/repo/tree/main/profiles%2fshop",
      "https://github.com/jane/repo?x=1", "https://github.com/jane/repo#fragment",
      "https://evil.example/jane/repo", "https://github.com@evil.example/jane/repo",
    ]) expect(parseShareRef(input)).toBeNull();
  });

  test("accepts pinned subdirectory references used by community cards", () => {
    expect(parseShareRef("jane/dotfiles@abc123:profiles/my-shop")).toEqual({
      user: "jane", repo: "dotfiles", ref: "abc123", subpath: "profiles/my-shop",
    });
  });
});

describe("sharedProfileName slugification", () => {
  test("kebab-cases mixed-case + underscores", () => {
    expect(sharedProfileName({ user: "Jane_QA", repo: "MedusaShop" }))
      .toBe("jane-qa-medusashop");
  });

  test("collapses repeated separators", () => {
    expect(sharedProfileName({ user: "jane--qa", repo: "medusa---shop" }))
      .toBe("jane-qa-medusa-shop");
  });

  test("trims leading/trailing hyphens per segment", () => {
    expect(sharedProfileName({ user: "-jane-", repo: "-shop-" }))
      .toBe("jane-shop");
  });
});

describe("candidateProfileUrls", () => {
  test("no ref: tries main then master", () => {
    const urls = candidateProfileUrls({ user: "j", repo: "r" });
    expect(urls).toEqual([
      "https://raw.githubusercontent.com/j/r/main/profile.yaml",
      "https://raw.githubusercontent.com/j/r/main/profiles/r/profile.yaml",
      "https://raw.githubusercontent.com/j/r/master/profile.yaml",
      "https://raw.githubusercontent.com/j/r/master/profiles/r/profile.yaml",
    ]);
  });

  test("with explicit ref: only that ref is tried", () => {
    const urls = candidateProfileUrls({ user: "j", repo: "r", ref: "v1" });
    expect(urls.every((u) => u.includes("/v1/"))).toBe(true);
    expect(urls.length).toBe(2);
  });

  test("with subpath: skips the profiles/ fallback", () => {
    const urls = candidateProfileUrls({ user: "j", repo: "r", subpath: "shops/lifted" });
    expect(urls.every((u) => u.endsWith("shops/lifted/profile.yaml"))).toBe(true);
  });
});

describe("fetchProfileYaml", () => {
  test("returns the first 200 it finds", async () => {
    const fetched: string[] = [];
    const fakeFetch = (url: string) => {
      fetched.push(url);
      const status = url.endsWith("/master/profile.yaml") ? 200 : 404;
      return Promise.resolve(new Response(status === 200 ? "name: x" : "", { status }));
    };
    const result = await fetchProfileYaml({ user: "j", repo: "r" }, fakeFetch as typeof fetch);
    expect(result.body).toBe("name: x");
    expect(result.source).toContain("/master/profile.yaml");
    // Should have stopped after the master hit — main/main attempts come first.
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.length).toBeLessThanOrEqual(4);
  });

  test("throws when nothing returns 200", async () => {
    const fakeFetch = () => Promise.resolve(new Response("", { status: 404 }));
    await expect(
      fetchProfileYaml({ user: "j", repo: "r" }, fakeFetch as typeof fetch),
    ).rejects.toThrow(/Profile not found/);
  });

  test("tolerates network errors per-URL and falls through", async () => {
    let i = 0;
    const fakeFetch = () => {
      i++;
      if (i === 1) return Promise.reject(new Error("ENOTFOUND"));
      return Promise.resolve(new Response("name: ok", { status: 200 }));
    };
    const r = await fetchProfileYaml({ user: "j", repo: "r" }, fakeFetch as typeof fetch);
    expect(r.body).toBe("name: ok");
  });
});

describe("namespaceProfileYaml", () => {
  test("rewrites the first `name:` line in place", () => {
    const out = namespaceProfileYaml(
      "name: medusa-shop\ndescription: x\nicon: '🛍️'\n",
      "jane-medusa-shop",
    );
    expect(out).toContain("name: jane-medusa-shop");
    expect(out).toContain("description: x");
    expect(out).toContain("icon: '🛍️'");
  });

  test("preserves indentation on the name line", () => {
    const out = namespaceProfileYaml("   name: old\n", "new");
    expect(out).toBe("   name: new\n");
  });

  test("prepends name when none found", () => {
    expect(namespaceProfileYaml("description: x\n", "jane-test"))
      .toBe("name: jane-test\ndescription: x\n");
  });

  test("doesn't touch nested name keys deeper in the file", () => {
    const out = namespaceProfileYaml(
      "name: shop\nskills:\n  local:\n    - name: not-this\n",
      "jane-shop",
    );
    expect(out).toContain("name: jane-shop");
    expect(out).toContain("name: not-this"); // untouched
  });

  test("rewrites root names after comments and nested mapping keys", () => {
    const input = "# one\n# two\n# three\n# four\n# five\nmetadata:\n  name: nested\nname: original\n";
    const output = namespaceProfileYaml(input, "jane-shop");
    expect(output).toContain("  name: nested");
    expect(output).toContain("\nname: jane-shop");
    expect(output.match(/^name:/gm)).toHaveLength(1);
  });
});

describe("install/list/remove round-trip", () => {
  let prevXdg: string | undefined;
  let scratch: string;
  beforeEach(() => {
    prevXdg = process.env.XDG_CONFIG_HOME;
    scratch = mkdtempSync(join(tmpdir(), "cue-shared-test-"));
    process.env.XDG_CONFIG_HOME = scratch;
  });
  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("writeInstall lands the file at the expected path with namespaced name", () => {
    const ref = { user: "jane", repo: "medusa-shop" };
    const { dir, namespacedName } = writeInstall(ref, "name: medusa-shop\ndescription: x\n", {
      source_url: "https://example/profile.yaml",
      installed_at: "2026-05-28T10:00:00Z",
      sha: null,
    });
    expect(namespacedName).toBe("jane-medusa-shop");
    expect(dir).toBe(join(sharedRoot(), "jane", "medusa-shop"));
    const written = readFileSync(join(dir, "profile.yaml"), "utf8");
    expect(written).toContain("name: jane-medusa-shop");
  });

  test("listInstalled enumerates after install", () => {
    writeInstall({ user: "jane", repo: "shop-a" }, "name: shop-a\ndescription: a\n", {
      source_url: "x", installed_at: "2026-05-28T10:00:00Z", sha: null,
    });
    writeInstall({ user: "bob", repo: "shop-b" }, "name: shop-b\ndescription: b\n", {
      source_url: "y", installed_at: "2026-05-28T11:00:00Z", sha: "abc",
    });
    const installed = listInstalled();
    expect(installed.map((i) => i.namespacedName).sort()).toEqual([
      "bob-shop-b", "jane-shop-a",
    ]);
    expect(installed.find((i) => i.user === "bob")?.meta?.sha).toBe("abc");
  });

  test("removeInstall cleans the dir AND prunes empty parent", () => {
    const ref = { user: "jane", repo: "only-one" };
    writeInstall(ref, "name: only-one\ndescription: x\n", {
      source_url: "x", installed_at: "2026-05-28T10:00:00Z", sha: null,
    });
    expect(listInstalled().length).toBe(1);
    expect(removeInstall(ref)).toBe(true);
    expect(listInstalled().length).toBe(0);
    // Removing again returns false (idempotent).
    expect(removeInstall(ref)).toBe(false);
  });

  test("sharedProfileDir is deterministic across calls", () => {
    const a = sharedProfileDir({ user: "x", repo: "y" });
    const b = sharedProfileDir({ user: "x", repo: "y" });
    expect(a).toBe(b);
  });

  test("invalid YAML or schema never writes a profile or overwrites an install", () => {
    const ref = { user: "jane", repo: "shop" };
    const meta = { source_url: "https://example/profile.yaml", installed_at: "now", sha: null };
    for (const invalid of ["[", "null", "- one", "name: shop\n", "name: shop\ndescription: valid\nunknown: true\n", "name: shop\nname: duplicate\ndescription: x\n"]) {
      expect(() => writeInstall(ref, invalid, meta)).toThrow();
      expect(existsSync(sharedProfileDir(ref))).toBe(false);
    }
    const { dir } = writeInstall(ref, "name: shop\ndescription: valid\n", meta);
    const before = readFileSync(join(dir, "profile.yaml"), "utf8");
    expect(() => writeInstall(ref, "name: shop\n", meta)).toThrow();
    expect(readFileSync(join(dir, "profile.yaml"), "utf8")).toBe(before);
  });

  test("rejects direct unsafe refs and symlinked install directories", () => {
    expect(() => sharedProfileDir({ user: "jane", repo: ".." })).toThrow();
    const outside = join(scratch, "outside");
    mkdirSync(outside);
    mkdirSync(sharedRoot(), { recursive: true });
    symlinkSync(outside, join(sharedRoot(), "jane"));
    expect(() => writeInstall({ user: "jane", repo: "shop" }, "name: shop\ndescription: x\n", {
      source_url: "x", installed_at: "now", sha: null,
    })).toThrow(/symlink/i);
    expect(existsSync(join(outside, "shop"))).toBe(false);
  });

  test("orphaned directories without profile.yaml are skipped by listInstalled", () => {
    mkdirSync(join(sharedRoot(), "ghost", "empty"), { recursive: true });
    writeFileSync(join(sharedRoot(), "ghost", "empty", "README.md"), "x");
    expect(listInstalled().length).toBe(0);
  });
});

describe("searchIndex", () => {
  // Local re-import to avoid breaking the existing test groups above.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { searchIndex } = require("./shared-profiles") as typeof import("./shared-profiles");

  const entries = [
    { author: "jane", name: "medusa-shop", description: "Medusa v2 storefront on Vite + TanStack", stars: 42 },
    { author: "bob",  name: "medusa-next", description: "Medusa on Next.js App Router", stars: 17 },
    { author: "kim",  name: "rust-cli",    description: "Rust CLI scaffold", stars: 9 },
  ];

  test("empty query returns everything sorted by stars DESC", () => {
    const result = searchIndex(entries, "");
    expect(result.map((e) => e.name)).toEqual(["medusa-shop", "medusa-next", "rust-cli"]);
  });

  test("single-word match is case-insensitive across name + description", () => {
    expect(searchIndex(entries, "MEDUSA").map((e) => e.name)).toEqual(["medusa-shop", "medusa-next"]);
    expect(searchIndex(entries, "scaffold").map((e) => e.name)).toEqual(["rust-cli"]);
  });

  test("multi-word query AND-matches every word", () => {
    expect(searchIndex(entries, "medusa next").map((e) => e.name)).toEqual(["medusa-next"]);
    expect(searchIndex(entries, "medusa vite").map((e) => e.name)).toEqual(["medusa-shop"]);
    expect(searchIndex(entries, "medusa rust")).toEqual([]); // no row has both
  });

  test("alphabetical tiebreak when stars are equal", () => {
    const tied = [
      { author: "z", name: "z", description: "x", stars: 10 },
      { author: "a", name: "a", description: "x", stars: 10 },
    ];
    expect(searchIndex(tied, "x").map((e) => e.name)).toEqual(["a", "z"]);
  });
});

describe("registry index cache", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const lib = require("./shared-profiles") as typeof import("./shared-profiles");
  let prevXdg: string | undefined;
  let prevCache: string | undefined;
  let scratch: string;
  beforeEach(() => {
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevCache = process.env.XDG_CACHE_HOME;
    scratch = mkdtempSync(join(tmpdir(), "cue-idx-test-"));
    process.env.XDG_CONFIG_HOME = scratch;
    process.env.XDG_CACHE_HOME = scratch;
  });
  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prevCache;
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("readCachedIndex returns null when nothing has been written", () => {
    expect(lib.readCachedIndex()).toBeNull();
  });

  test("write → read round-trip", () => {
    lib.writeIndexCache([{ author: "x", name: "y", description: "z" }], "http://src");
    const r = lib.readCachedIndex();
    expect(r?.entries.length).toBe(1);
    expect(r?.source).toBe("http://src");
  });

  test("cache older than maxAgeMinutes is treated as missing", () => {
    lib.writeIndexCache([], "src");
    // Re-write file with a doctored fetched_at far in the past.
    const path = lib.indexCachePath();
    const raw = readFileSync(path, "utf8");
    const obj = JSON.parse(raw);
    obj.fetched_at = "2000-01-01T00:00:00Z";
    writeFileSync(path, JSON.stringify(obj));
    expect(lib.readCachedIndex(60)).toBeNull();
  });

  test("malformed JSON in cache is treated as miss, not a crash", () => {
    mkdirSync(join(scratch, "cue"), { recursive: true });
    writeFileSync(lib.indexCachePath(), "{not json");
    expect(lib.readCachedIndex()).toBeNull();
  });
});
