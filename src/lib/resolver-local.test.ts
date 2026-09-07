/**
 * Tests for `resolveLocal` (Agent A6).
 *
 * The suite builds a tiny fake `skills/skills/` tree under `tmpdir()` so it
 * does not depend on the real repo layout. Covered cases:
 *   - exact `<category>/<slug>` resolves to an absolute source + correct target
 *   - bare slug resolves when unique across categories
 *   - bare slug throws `AmbiguousSkillRef` when defined in multiple categories
 *   - missing slug throws `SkillNotFound` and surfaces Levenshtein suggestions
 *   - a directory without `SKILL.md` is treated as missing
 *   - an empty `skills.local` list returns `[]`
 *   - traversal escapes (`..`, absolute paths) are rejected
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AmbiguousSkillRef,
  createLocalSkillResolver,
  resolveLocal,
  SkillNotFound,
  suggest,
} from "./resolver-local";
import type { ResolvedProfile } from "../../profiles/_types";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let rootDir: string;
let skillsRoot: string;

/**
 * Layout — chosen so we have a unique slug (`unique-skill`), a duplicated
 * slug across two categories (`shared-skill`), and a slug whose directory
 * exists but is missing `SKILL.md` (`broken-skill`).
 */
async function buildTree(): Promise<void> {
  const files: Array<[string, string]> = [
    ["medusa/building-with-medusa/SKILL.md", "# building-with-medusa\n"],
    ["medusa/db-migrate/SKILL.md", "# db-migrate\n"],
    ["medusa/unique-skill/SKILL.md", "# unique-skill\n"],
    ["medusa/shared-skill/SKILL.md", "# shared in medusa\n"],
    ["medusa/broken-skill/README.md", "no SKILL.md here\n"],
    ["github/shared-skill/SKILL.md", "# shared in github\n"],
    ["github/review-pr/SKILL.md", "# review-pr\n"],
    ["meta/init/SKILL.md", "# init\n"],
  ];
  for (const [rel, body] of files) {
    const abs = join(skillsRoot, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, body, "utf8");
  }
}

function profile(local: string[]): ResolvedProfile {
  return {
    name: "test",
    description: "fixture",
    agents: ["claude-code"],
    skills: { local: local.map((id) => ({ id })), npx: [] },
    mcps: [],
    plugins: [],
    env: {},
    inheritanceChain: ["test"],
  };
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "cue-resolver-local-"));
  skillsRoot = join(rootDir, "skills", "skills");
  await mkdir(skillsRoot, { recursive: true });
  await buildTree();
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("launch-scoped local resolver", () => {
  test("walks once for concurrent and subsequent lookups, without eager work", async () => {
    const reads = spyOn(fs, "readdir");
    try {
      const resolveSkill = createLocalSkillResolver({ skillsRoot });
      expect(reads).not.toHaveBeenCalled();
      expect(await Promise.all([
        resolveSkill("medusa/unique-skill"), resolveSkill("github/review-pr"),
      ])).toEqual([join(skillsRoot, "medusa/unique-skill"), join(skillsRoot, "github/review-pr")]);
      expect(await resolveSkill("unique-skill")).toBe(join(skillsRoot, "medusa/unique-skill"));
      expect(reads.mock.calls.filter(([path]) => path === skillsRoot)).toHaveLength(1);
    } finally {
      reads.mockRestore();
    }
  });

  test("keeps ambiguity, missing-file and traversal checks", async () => {
    const resolveSkill = createLocalSkillResolver({ skillsRoot });
    await expect(resolveSkill("shared-skill")).rejects.toBeInstanceOf(AmbiguousSkillRef);
    await expect(resolveSkill("medusa/broken-skill")).rejects.toBeInstanceOf(SkillNotFound);
    await expect(resolveSkill("../unique-skill")).rejects.toBeInstanceOf(SkillNotFound);
    await expect(resolveSkill("/medusa/unique-skill")).rejects.toBeInstanceOf(SkillNotFound);
    await expect(resolveSkill("missing")).rejects.toBeInstanceOf(SkillNotFound);
  });

  test("new resolvers observe added skills and existing resolvers recheck deleted files", async () => {
    const resolveSkill = createLocalSkillResolver({ skillsRoot });
    await resolveSkill("meta/init");
    await mkdir(join(skillsRoot, "meta/new"));
    await writeFile(join(skillsRoot, "meta/new/SKILL.md"), "# new");
    expect(await createLocalSkillResolver({ skillsRoot })("meta/new"))
      .toBe(join(skillsRoot, "meta/new"));
    await rm(join(skillsRoot, "meta/init/SKILL.md"));
    await expect(resolveSkill("meta/init")).rejects.toBeInstanceOf(SkillNotFound);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("resolveLocal — happy path", () => {
  test("returns [] when skills.local is empty", async () => {
    const plans = await resolveLocal(profile([]), { skillsRoot });
    expect(plans).toEqual([]);
  });

  test("resolves an exact <category>/<slug> ref", async () => {
    const plans = await resolveLocal(profile(["medusa/building-with-medusa"]), {
      skillsRoot,
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toEqual({
      source: join(skillsRoot, "medusa", "building-with-medusa"),
      target: ".claude/skills/building-with-medusa",
      origin: "local",
    });
  });

  test("resolves a unique bare slug across all categories", async () => {
    const plans = await resolveLocal(profile(["unique-skill"]), { skillsRoot });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.source).toBe(join(skillsRoot, "medusa", "unique-skill"));
    expect(plans[0]?.target).toBe(".claude/skills/unique-skill");
    expect(plans[0]?.origin).toBe("local");
  });

  test("resolves multiple refs in input order", async () => {
    const plans = await resolveLocal(
      profile(["meta/init", "github/review-pr", "medusa/db-migrate"]),
      { skillsRoot },
    );
    expect(plans.map((p) => p.target)).toEqual([
      ".claude/skills/init",
      ".claude/skills/review-pr",
      ".claude/skills/db-migrate",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Ambiguity
// ---------------------------------------------------------------------------

describe("resolveLocal — ambiguity", () => {
  test("bare slug defined in multiple categories throws AmbiguousSkillRef", async () => {
    await expect(
      resolveLocal(profile(["shared-skill"]), { skillsRoot }),
    ).rejects.toBeInstanceOf(AmbiguousSkillRef);
  });

  test("ambiguous error lists every candidate as <category>/<slug>", async () => {
    try {
      await resolveLocal(profile(["shared-skill"]), { skillsRoot });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousSkillRef);
      const e = err as AmbiguousSkillRef;
      expect(e.candidates.sort()).toEqual([
        "github/shared-skill",
        "medusa/shared-skill",
      ]);
      expect(e.code).toBe("AMBIGUOUS_SKILL_REF");
    }
  });

  test("explicit <category>/<slug> resolves even when the slug is shared", async () => {
    const plans = await resolveLocal(profile(["github/shared-skill"]), {
      skillsRoot,
    });
    expect(plans[0]?.source).toBe(join(skillsRoot, "github", "shared-skill"));
  });
});

// ---------------------------------------------------------------------------
// Missing
// ---------------------------------------------------------------------------

describe("resolveLocal — missing", () => {
  test("unknown bare slug throws SkillNotFound with up to 3 suggestions", async () => {
    try {
      await resolveLocal(profile(["uniqe-skil"]), { skillsRoot });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SkillNotFound);
      const e = err as SkillNotFound;
      expect(e.code).toBe("SKILL_NOT_FOUND");
      expect(e.suggestions.length).toBeGreaterThan(0);
      expect(e.suggestions.length).toBeLessThanOrEqual(3);
      // The closest candidate by Levenshtein should be unique-skill.
      expect(e.suggestions[0]).toBe("medusa/unique-skill");
    }
  });

  test("unknown <category>/<slug> throws SkillNotFound", async () => {
    await expect(
      resolveLocal(profile(["medusa/does-not-exist"]), { skillsRoot }),
    ).rejects.toBeInstanceOf(SkillNotFound);
  });

  test("unknown category throws SkillNotFound", async () => {
    await expect(
      resolveLocal(profile(["nonsuch/whatever"]), { skillsRoot }),
    ).rejects.toBeInstanceOf(SkillNotFound);
  });

  test("SkillNotFound surfaces category match for a bare ref via allSlugs", () => {
    const e = new SkillNotFound("review-pr", [], [
      "github/review-pr",
      "meta/init",
    ]);
    expect(e.categoryMatches).toEqual(["github/review-pr"]);
    expect(e.message).toContain('Found "github/review-pr" — did you mean that?');
    expect(e.message).toContain("Skills are referenced as <category>/<name>.");
  });

  test("SkillNotFound lists every category when a bare slug is duplicated", () => {
    const e = new SkillNotFound("shared-skill", [], [
      "github/shared-skill",
      "medusa/shared-skill",
    ]);
    expect(e.categoryMatches).toEqual([
      "github/shared-skill",
      "medusa/shared-skill",
    ]);
    expect(e.message).toContain(
      "Found under these categories: github/shared-skill, medusa/shared-skill.",
    );
  });

  test("SkillNotFound falls back to Levenshtein hint when no category match", () => {
    const e = new SkillNotFound("uniqe-skil", ["medusa/unique-skill"], [
      "medusa/unique-skill",
    ]);
    expect(e.categoryMatches).toEqual([]);
    expect(e.message).toContain("Did you mean: medusa/unique-skill?");
  });

  test("directory without SKILL.md is treated as not found", async () => {
    try {
      await resolveLocal(profile(["medusa/broken-skill"]), { skillsRoot });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SkillNotFound);
    }
  });

  test("rejects path traversal attempts", async () => {
    for (const bad of ["../etc/passwd", "/abs/path", "medusa/../github/review-pr", ""]) {
      await expect(
        resolveLocal(profile([bad]), { skillsRoot }),
      ).rejects.toBeInstanceOf(SkillNotFound);
    }
  });
});

// ---------------------------------------------------------------------------
// Levenshtein helper — sanity check on the public `suggest` export
// ---------------------------------------------------------------------------

describe("suggest", () => {
  test("returns up to N closest matches", async () => {
    const pool = [
      "medusa/building-with-medusa",
      "medusa/db-migrate",
      "medusa/db-generate",
      "github/review-pr",
    ];
    const out = suggest("db-migrate", pool, 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe("medusa/db-migrate");
  });

  test("returns [] for an empty pool", () => {
    expect(suggest("anything", [])).toEqual([]);
  });

  test("ties are broken lexicographically", () => {
    // Both `cat` and `bat` are distance 1 from `bot` — substitute one char.
    // Lex order puts `bat` before `cat`.
    const out = suggest("bot", ["cat", "bat", "zebra"], 2);
    expect(out).toEqual(["bat", "cat"]);
  });
});
