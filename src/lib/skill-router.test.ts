import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseSkillFromContent,
  parseSkillFromPath,
  renderRouter,
  type ParsedSkill,
} from "./skill-router";

const HIGGS_GEN = `---
name: higgsfield-generate
description: >-
  Use when user says "generate image/video", "animate this photo", or "remix this". Higgsfield models + Marketing Studio. NOT for product photoshoots.
---
# body`;

const HIGGS_PHOTO = `---
name: higgsfield-product-photoshoot
description: >-
  Use when user says "product photo", "studio shot", or "hero banner". Backend-enhanced prompts on GPT Image 2.
---`;

const PHOTO_EXPLICIT = `---
name: explicit-skill
description: Use when user says "explicit thing".
capability: |
  Generates explicit outputs via backend enhancer. Don't freestyle: house style is baked in.
when_to_invoke:
  - User asked for an explicit output even without saying "explicit thing"
  - You're producing structured assets for downstream import
---`;

const NO_FRONTMATTER = `# just a body, no frontmatter at all`;

const EMPTY_DESC = `---
name: empty-desc
description: ""
---`;

const SHORT_NO_TRIGGER = `---
name: vague
description: Helps with vague stuff.
---`;

describe("parseSkillFromContent", () => {
  test("extracts trigger phrases and prose capability from a typical description", () => {
    const parsed = parseSkillFromContent("higgsfield/higgsfield-generate", HIGGS_GEN);
    expect(parsed.triggers).toEqual([
      "generate image/video",
      "animate this photo",
      "remix this",
    ]);
    expect(parsed.capability).toContain("Higgsfield models");
    expect(parsed.capabilityExplicit).toBe(false);
    expect(parsed.notFor).toMatch(/NOT for product photoshoots/);
    expect(parsed.quality).toBe("good");
    expect(parsed.missing).toBe(false);
  });

  test("treats short prose without 'NOT for' the same way", () => {
    const parsed = parseSkillFromContent("higgsfield/higgsfield-product-photoshoot", HIGGS_PHOTO);
    expect(parsed.triggers.length).toBe(3);
    expect(parsed.capability).toContain("GPT Image 2");
    expect(parsed.notFor).toBe("");
    expect(parsed.quality).toBe("good");
  });

  test("prefers explicit capability + when_to_invoke over inferred prose", () => {
    const parsed = parseSkillFromContent("misc/explicit", PHOTO_EXPLICIT);
    expect(parsed.triggers).toEqual(["explicit thing"]);
    expect(parsed.capabilityExplicit).toBe(true);
    expect(parsed.capability).toContain("backend enhancer");
    expect(parsed.whenToInvoke).toEqual([
      "User asked for an explicit output even without saying \"explicit thing\"",
      "You're producing structured assets for downstream import",
    ]);
    expect(parsed.quality).toBe("good");
  });

  test("no frontmatter → quality none", () => {
    const parsed = parseSkillFromContent("foo/bar", NO_FRONTMATTER);
    expect(parsed.quality).toBe("none");
    expect(parsed.triggers).toEqual([]);
    expect(parsed.capability).toBe("");
  });

  test("empty description string → quality none", () => {
    const parsed = parseSkillFromContent("foo/empty", EMPTY_DESC);
    expect(parsed.quality).toBe("none");
  });

  test("description without triggers and short prose → quality partial", () => {
    const parsed = parseSkillFromContent("foo/vague", SHORT_NO_TRIGGER);
    expect(parsed.triggers).toEqual([]);
    expect(parsed.capability).toBe("Helps with vague stuff");
    expect(parsed.quality).toBe("partial");
  });

  test("falls back name to last slug segment when frontmatter name missing", () => {
    const parsed = parseSkillFromContent("namespace/whatever", NO_FRONTMATTER);
    expect(parsed.name).toBe("whatever");
  });
});

describe("parseSkillFromPath", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "skill-router-test-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("reads SKILL.md from the conventional path", async () => {
    const dir = join(root, "foo", "bar");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), HIGGS_GEN);
    const parsed = await parseSkillFromPath("foo/bar", root);
    expect(parsed.missing).toBe(false);
    expect(parsed.triggers.length).toBeGreaterThan(0);
  });

  test("returns missing=true when SKILL.md is absent", async () => {
    const parsed = await parseSkillFromPath("ghost/skill", root);
    expect(parsed.missing).toBe(true);
    expect(parsed.quality).toBe("none");
  });
});

describe("renderRouter", () => {
  function fixture(): ParsedSkill[] {
    return [
      parseSkillFromContent("higgsfield/higgsfield-generate", HIGGS_GEN),
      parseSkillFromContent("higgsfield/higgsfield-product-photoshoot", HIGGS_PHOTO),
      parseSkillFromContent("misc/explicit", PHOTO_EXPLICIT),
      parseSkillFromContent("foo/vague", SHORT_NO_TRIGGER),
      parseSkillFromContent("foo/empty", EMPTY_DESC),
    ];
  }

  test("renders capability table first, then triggers, then other skills", () => {
    const md = renderRouter(fixture());
    const capIdx = md.indexOf("## Skill capabilities");
    const trigIdx = md.indexOf("## Trigger phrases");
    const otherIdx = md.indexOf("## Other skills");
    expect(capIdx).toBeGreaterThan(-1);
    expect(trigIdx).toBeGreaterThan(capIdx);
    expect(otherIdx).toBeGreaterThan(trigIdx);
  });

  test("explicit when_to_invoke entries render as rows in the capability table", () => {
    const md = renderRouter(fixture());
    expect(md).toContain("User asked for an explicit output");
    expect(md).toContain("structured assets for downstream import");
  });

  test("prose capability falls back to a single capability row per skill", () => {
    const md = renderRouter(fixture());
    expect(md).toContain("Higgsfield models");
  });

  test("trigger rows are quoted and reference the skill name", () => {
    const md = renderRouter(fixture());
    expect(md).toContain('"generate image/video"');
    expect(md).toContain("higgsfield-generate");
  });

  test("quality=none skills land in the Other skills tail", () => {
    const md = renderRouter(fixture());
    expect(md).toContain("- `foo/empty`");
  });

  test("returns empty string when nothing meaningful exists", () => {
    const md = renderRouter([]);
    expect(md).toBe("");
  });

  test("caps trigger rows per skill", () => {
    const manyTriggers = parseSkillFromContent(
      "many/triggers",
      `---
description: Use when user says "a", "b", "c", "d", "e", "f", "g", "h".
---`,
    );
    const md = renderRouter([manyTriggers], { maxTriggersPerSkill: 3 });
    const triggerRows = md.split("\n").filter((line) => line.startsWith("| \""));
    expect(triggerRows.length).toBe(3);
  });
});

describe("renderRouter overrides", () => {
  test("composite duplicates collapse while distinct notes remain", () => {
    const row = { skill: "tools/opensrc", capability: "Fetch source", phrase: "read source" };
    const single = renderRouter([], { overrides: [row] });
    const repeated = renderRouter([], { overrides: [row, { phrase: row.phrase, capability: row.capability, skill: row.skill }, row] });
    expect(repeated).toBe(single);
    expect(renderRouter([], { overrides: [row, { ...row, note: "distinct" }] })).toContain("distinct");
  });
  test("manual phrase override appears in trigger table with ✎ marker", () => {
    const md = renderRouter(
      [parseSkillFromContent("higgsfield/higgsfield-generate", HIGGS_GEN)],
      { overrides: [{ phrase: "make me a hero video", skill: "higgsfield-generate", note: "client deck" }] },
    );
    expect(md).toContain('"make me a hero video"');
    expect(md).toContain("✎");
    expect(md).toContain("client deck");
  });

  test("manual capability override appears in capability table", () => {
    const md = renderRouter(
      [parseSkillFromContent("higgsfield/higgsfield-generate", HIGGS_GEN)],
      { overrides: [{ capability: "Generate a 6-second product reveal", skill: "higgsfield-generate" }] },
    );
    expect(md).toContain("Generate a 6-second product reveal ✎");
  });

  test("router section is omitted entirely when no skills and no overrides", () => {
    expect(renderRouter([], { overrides: [] })).toBe("");
  });

  test("renders only the override row when skills contribute nothing", () => {
    const md = renderRouter(
      [],
      { overrides: [{ phrase: "hand-tuned only", skill: "ghost" }] },
    );
    expect(md).toContain('"hand-tuned only"');
    expect(md).toContain("ghost");
  });
});

describe("renderRouter zombie compaction", () => {
  // Two real-shape skills: one with rich capability/triggers, one with same.
  const live = (): ParsedSkill[] => [
    parseSkillFromContent("higgsfield/higgsfield-generate", HIGGS_GEN),
    parseSkillFromContent("higgsfield/higgsfield-product-photoshoot", HIGGS_PHOTO),
    parseSkillFromContent("meta/explicit-skill", PHOTO_EXPLICIT),
  ];

  test("default behavior (no zombies option) renders every row as before", () => {
    const md = renderRouter(live());
    expect(md).toContain("higgsfield-generate");
    expect(md).toContain("higgsfield-product-photoshoot");
    expect(md).toContain("explicit-skill");
    expect(md).not.toContain("Rarely-used skills");
  });

  test("zombies pulled into a compact tail; their rows vanish from capability + trigger tables", () => {
    // Mark photoshoot as zombie via full id.
    const md = renderRouter(live(), {
      zombies: ["higgsfield/higgsfield-product-photoshoot"],
    });
    expect(md).toContain("higgsfield-generate"); // still in capability/trigger tables
    expect(md).toContain("Rarely-used skills (1)");
    expect(md).toContain("higgsfield-product-photoshoot");
    // No trigger phrase row for the zombie.
    expect(md).not.toContain('"product photo"');
  });

  test("zombie match works on the bare slug (skill name) too", () => {
    // Skill name `higgsfield-product-photoshoot` should match even if the
    // telemetry tagged the event with just the slug.
    const md = renderRouter(live(), {
      zombies: ["higgsfield-product-photoshoot"],
    });
    expect(md).toContain("Rarely-used skills (1)");
    expect(md).not.toContain('"product photo"');
  });

  test("lean mode omits zombies entirely — no tail, no name leak", () => {
    const md = renderRouter(live(), {
      zombies: ["higgsfield/higgsfield-product-photoshoot"],
      lean: true,
    });
    expect(md).not.toContain("Rarely-used skills");
    expect(md).not.toContain("higgsfield-product-photoshoot");
    expect(md).toContain("higgsfield-generate"); // active skill untouched
  });

  test("when EVERY skill is zombie and lean is on, the router renders empty", () => {
    const md = renderRouter(live(), {
      zombies: [
        "higgsfield/higgsfield-generate",
        "higgsfield/higgsfield-product-photoshoot",
        "meta/explicit-skill",
      ],
      lean: true,
    });
    expect(md).toBe("");
  });

  test("zombies grouped by category in the tail for scannability", () => {
    const md = renderRouter(live(), {
      zombies: [
        "higgsfield/higgsfield-generate",
        "higgsfield/higgsfield-product-photoshoot",
        "meta/explicit-skill",
      ],
    });
    expect(md).toContain("**higgsfield/**");
    expect(md).toContain("**meta/**");
    expect(md).toContain("Rarely-used skills (3)");
  });
});

describe("renderRouter capability cap", () => {
  function manySkills(n: number): ParsedSkill[] {
    return Array.from({ length: n }, (_, i) =>
      parseSkillFromContent(
        `cat/skill-${i}`,
        `---\ndescription: Does useful thing number ${i} for the pipeline workflow.\n---`,
      ),
    );
  }

  test("no cap → every capability row renders", () => {
    const md = renderRouter(manySkills(60));
    const rows = md.split("\n").filter((l) => l.startsWith("| Does useful thing"));
    expect(rows.length).toBe(60);
  });

  test("cap truncates capability rows and emits an on-demand note", () => {
    const md = renderRouter(manySkills(60), { maxCapabilityRows: 50 });
    const rows = md.split("\n").filter((l) => l.startsWith("| Does useful thing"));
    expect(rows.length).toBe(50);
    expect(md).toMatch(/\+10 more skills/);
    expect(md).toContain("loadable via the Skill tool on demand");
  });

  test("cap is a no-op when row count is at or below the cap", () => {
    const md = renderRouter(manySkills(50), { maxCapabilityRows: 50 });
    expect(md).not.toMatch(/more skill.* loadable via the Skill tool/);
  });

  test("manual persona_routing rows survive the cap", () => {
    const md = renderRouter(manySkills(60), {
      maxCapabilityRows: 50,
      overrides: [{ capability: "ALWAYS-KEEP this manual row", skill: "x/manual" }],
    });
    expect(md).toContain("ALWAYS-KEEP this manual row");
  });
});
