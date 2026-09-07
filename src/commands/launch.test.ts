import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPickerSections,
  categoryBreakdown,
  computeTokenBreakdown,
  formatDoctorWarnings,
  formatProfileSummary,
  formatStartupBanner,
  formatTmuxTitle,
  getDefaultSelector,
  mergeProfileSuggestions,
  ownsPaneBadge,
  relativeTime,
  formatNpxDegraded,
  resolveNpxSkillSources,
  shouldAppendUserClaudeMd,
  sortProfileOptions,
  splitSkillBytes,
  tokenLevelEmoji,
} from "./launch";
import { DIVIDER_PREFIX } from "../lib/picker";
import type { PickerOption } from "../lib/picker";
import type { ResolvedProfile } from "../../profiles/_types";

const make = (value: string): PickerOption => ({ value, label: value, hint: "" });

function makeProfile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    name: "test",
    description: "",
    inherits: [],
    inheritanceChain: ["test"],
    agents: [],
    skills: { local: [], npx: [] },
    mcps: [],
    plugins: [],
    env: {},
    commands: [],
    rules: [],
    hooks: [],
    persona: "",
    playbooks: [],
    qualityGates: [],
    evals: [],
    recommends: [],
    ...overrides,
  } as ResolvedProfile;
}

describe("resolveNpxSkillSources", () => {
  test("resolves pinned npx skills through cache sources", async () => {
    const root = mkdtempSync(join(tmpdir(), "cue-launch-npx-"));
    const resolved = join(root, "cache", "skill");
    mkdirSync(resolved, { recursive: true });
    writeFileSync(join(resolved, "SKILL.md"), "# Missing\n");

    let requested: string[] = [];
    try {
      const sources = await resolveNpxSkillSources(
        makeProfile({
          skills: {
            local: [],
            npx: [{ repo: "owner/repo", pin: "git@abc", skills: ["installed", "missing"] }],
          },
        }),
        {
          resolveNpx: async (profile) => {
            requested = profile.skills.npx.flatMap((entry) => entry.skills);
            return profile.skills.npx[0]!.skills.map((skill) => ({
              source: resolved,
              target: `.claude/skills/${skill}`,
              origin: "npx" as const,
            }));
          },
        },
      );

      expect(requested).toEqual(["installed", "missing"]);
      expect(sources.get("installed")).toBe(resolved);
      expect(sources.get("missing")).toBe(resolved);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("formats a degraded fetch as a warning, not a crash", () => {
    const lines = formatNpxDegraded([
      {
        repo: "xixu-me/skills",
        skills: ["alpha", "beta"],
        servedFromCache: [],
        error: new Error("npx fetch failed for xixu-me/skills: exit 1 (after 3 attempts)"),
      },
      {
        repo: "owner/warm",
        skills: [],
        servedFromCache: ["gamma"],
        error: new Error("npx fetch failed for owner/warm: getaddrinfo EAI_AGAIN"),
      },
    ]);

    expect(lines[0]).toContain("xixu-me/skills unreachable (exit 1 (after 3 attempts))");
    expect(lines[0]).toContain("launching without alpha, beta");
    expect(lines[1]).toContain("owner/warm unreachable (getaddrinfo EAI_AGAIN)");
    expect(lines[1]).toContain("using cached copy");
    // The advice must force past the marker this very failure just wrote.
    expect(lines[2]).toContain("CUE_NPX_FORCE=1");
  });

  test("a skipped entry reports the cooldown, not a fresh failure", () => {
    const lines = formatNpxDegraded([
      {
        repo: "github/awesome-copilot",
        skills: ["pytest-coverage"],
        servedFromCache: [],
        error: new Error(
          "npx fetch skipped for github/awesome-copilot: spawnSync npx ETIMEDOUT",
        ),
        skipped: true,
        retryInMs: 5 * 60 * 60 * 1000 + 48 * 60 * 1000,
      },
    ]);

    expect(lines[0]).toContain("github/awesome-copilot skipped");
    // Must not claim a fetch happened this launch.
    expect(lines[0]).not.toContain("unreachable");
    expect(lines[0]).toContain("spawnSync npx ETIMEDOUT");
    expect(lines[0]).toContain("auto-retry in 5h48m");
    expect(lines[0]).toContain("launching without pytest-coverage");
    expect(lines[1]).toContain("CUE_NPX_FORCE=1");
  });

  test("no failures means no output", () => {
    expect(formatNpxDegraded([])).toEqual([]);
  });
});

describe("sortProfileOptions", () => {
  test("pinned profile is first, then alphabetical (full no longer gets pole position)", () => {
    const input = [make("backend"), make("frontend"), make("full"), make("marketing")];
    const out = sortProfileOptions(input, "marketing");
    expect(out.map((o) => o.value)).toEqual(["marketing", "backend", "frontend", "full"]);
  });

  test("unused profiles sort alphabetically without any full special-case", () => {
    const input = [make("backend"), make("research"), make("full"), make("marketing")];
    const out = sortProfileOptions(input);
    expect(out.map((o) => o.value)).toEqual(["backend", "full", "marketing", "research"]);
  });

  test("works when pinned profile equals 'full'", () => {
    const input = [make("backend"), make("frontend"), make("full")];
    const out = sortProfileOptions(input, "full");
    expect(out[0]!.value).toBe("full");
  });

  test("does not mutate the input array", () => {
    const input = [make("backend"), make("full"), make("frontend")];
    const before = input.map((o) => o.value);
    sortProfileOptions(input, "frontend");
    expect(input.map((o) => o.value)).toEqual(before);
  });

  test("alphabetical tie-break for non-special profiles", () => {
    const input = [make("zebra"), make("apple"), make("mango")];
    const out = sortProfileOptions(input);
    expect(out.map((o) => o.value)).toEqual(["apple", "mango", "zebra"]);
  });

  test("top-flagged options sort above pinned and everything else", () => {
    const defaultOpt: PickerOption = { value: "core", label: "⭐ Default", hint: "", top: true };
    const input = [make("backend"), make("full"), make("frontend"), defaultOpt];
    const out = sortProfileOptions(input, "frontend");
    expect(out[0]!.value).toBe("core");
    expect(out[0]!.label).toBe("⭐ Default");
    expect(out[1]!.value).toBe("frontend"); // pinned still comes before usage/alpha
  });

  test("used profiles outrank unused ones, with usage as the tie-breaker", () => {
    const input = [make("backend"), make("frontend"), make("marketing"), make("postizz")];
    const usage = new Map<string, number>([
      ["postizz", 30],
      ["marketing", 5],
      // backend, frontend unused
    ]);
    const out = sortProfileOptions(input, undefined, usage);
    expect(out.map((o) => o.value)).toEqual(["postizz", "marketing", "backend", "frontend"]);
  });
});

describe("mergeProfileSuggestions", () => {
  test("puts agreement first and combines distinct reasons", () => {
    const advised = [
      { profile: "nextjs", confidence: 0.82, reasons: ["primary web app"] },
      { profile: "gstack", confidence: 0.7, reasons: ["agent workflow"] },
    ];
    const deterministic = [
      { profile: "nextjs", confidence: 0.9, reasons: ["next.config.ts"] },
      { profile: "typescript", confidence: 0.8, reasons: ["tsconfig.json"] },
    ];

    const merged = mergeProfileSuggestions(advised, deterministic);
    expect(merged.map((item) => item.profile)).toEqual([
      "nextjs",
      "gstack",
      "typescript",
    ]);
    expect(merged[0]?.confidence).toBe(0.9);
    expect(merged[0]?.reasons).toEqual(["primary web app", "next.config.ts"]);
  });

  test("preserves one AI and one deterministic choice when they disagree", () => {
    const merged = mergeProfileSuggestions(
      [
        { profile: "google-ads", confidence: 0.9, reasons: ["GAQL scripts"] },
        { profile: "marketing", confidence: 0.8, reasons: ["campaign copy"] },
      ],
      [
        { profile: "coolify", confidence: 0.85, reasons: ["Dockerfile"] },
        { profile: "nextjs", confidence: 0.75, reasons: ["next.config.ts"] },
      ],
    );

    expect(merged.slice(0, 2).map((item) => item.profile)).toEqual([
      "google-ads",
      "coolify",
    ]);
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-05-26T12:00:00Z").getTime();

  test("returns empty string for null/undefined/invalid", () => {
    expect(relativeTime(null, now)).toBe("");
    expect(relativeTime(undefined, now)).toBe("");
    expect(relativeTime("not a date", now)).toBe("");
  });

  test("today / yesterday / Nd ago / ISO date", () => {
    expect(relativeTime("2026-05-26T08:00:00Z", now)).toBe("today");
    expect(relativeTime("2026-05-25T08:00:00Z", now)).toBe("yesterday");
    expect(relativeTime("2026-05-22T08:00:00Z", now)).toBe("4d ago");
    expect(relativeTime("2026-04-01T08:00:00Z", now)).toBe("2026-04-01");
  });
});

describe("buildPickerSections", () => {
  const opt = (value: string): PickerOption => ({ value, label: value, hint: "" });
  const now = new Date("2026-05-26T12:00:00Z").getTime();

  test("no usage: just Default + flat list, no Recent divider", () => {
    // Use names that don't match any stack section so the alphabetical body
    // stays flat. core/caveman-quick/full are the only ungrouped survivors.
    const all = [opt("core"), opt("caveman-quick"), opt("full")];
    const out = buildPickerSections(opt("__default"), all, [], 3, now);
    expect(out.map((o) => o.value)).toEqual([
      "__default",
      `${DIVIDER_PREFIX}all`,
      "core",
      "caveman-quick",
      "full",
    ]);
  });

  test("with recent: inserts Recent divider, omits recents from All section", () => {
    const all = [opt("core"), opt("marketing"), opt("research")];
    const recent = [
      { name: "marketing", sessions: 8, lastUsed: "2026-05-26T08:00:00Z" },
      { name: "research", sessions: 3, lastUsed: "2026-05-22T08:00:00Z" },
    ];
    const out = buildPickerSections(opt("__default"), all, recent, 3, now);
    expect(out.map((o) => o.value)).toEqual([
      "__default",
      `${DIVIDER_PREFIX}recent`,
      "marketing",
      "research",
      `${DIVIDER_PREFIX}all`,
      "core",
    ]);
  });

  test("dedupes repeated parts in a composite Recent row (legacy analytics)", () => {
    // Legacy analytics can carry a snowballed selector with parts repeated many
    // times (an old pre-dedup picker path appended companions to the resolved
    // profile each launch). The synthesized Recent row must show each profile
    // exactly once — in BOTH value and label — never "gstack + … + gstack".
    const all = [opt("gstack"), opt("core"), opt("improver"), opt("commerce")];
    const recent = [
      {
        name: "gstack+core+improver+commerce+core+gstack+improver",
        sessions: 4,
        lastUsed: "2026-05-26T08:00:00Z",
      },
    ];
    const out = buildPickerSections(opt("__default"), all, recent, 3, now);
    const row = out.find((o) => o.value.startsWith("gstack+"))!;
    expect(row).toBeDefined();
    // value: each part once, first-seen order preserved — this is what gets
    // pinned to .cue.profile and launched, so it must be clean.
    expect(row.value).toBe("gstack+core+improver+commerce");
    const valueParts = row.value.split("+");
    expect(new Set(valueParts).size).toBe(valueParts.length);
    // label: no icon/name repeated either (this is the row the user reads).
    const labelParts = row.label.split(" + ");
    expect(new Set(labelParts).size).toBe(labelParts.length);
  });

  test("Recent shows the N most recently used profiles, sorted by lastUsed not by session count", () => {
    const all = [opt("career"), opt("core"), opt("ecc"), opt("skill-writer")];
    // Input arrives session-sorted (career has the most), but Recent must
    // re-sort by recency. The actually-last-picked profile leads.
    const recent = [
      { name: "career", sessions: 158, lastUsed: "2026-05-10T08:00:00Z" },   // most-used, oldest
      { name: "skill-writer", sessions: 11, lastUsed: "2026-05-26T08:00:00Z" }, // most-recent
      { name: "core", sessions: 5, lastUsed: "2026-05-24T08:00:00Z" },
      { name: "ecc", sessions: 1, lastUsed: "2026-05-20T08:00:00Z" },
    ];
    const out = buildPickerSections(opt("__default"), all, recent, 3, now);
    const recentSection = out
      .slice(
        out.findIndex((o) => o.value === `${DIVIDER_PREFIX}recent`) + 1,
        out.findIndex((o) => o.value === `${DIVIDER_PREFIX}all`),
      )
      .map((o) => o.value);
    expect(recentSection).toEqual(["skill-writer", "core", "ecc"]);
  });

  test("recent profile hints include session count and relative time", () => {
    const all = [opt("marketing")];
    const recent = [{ name: "marketing", sessions: 8, lastUsed: "2026-05-26T08:00:00Z" }];
    const out = buildPickerSections(opt("__default"), all, recent, 3, now);
    const marketing = out.find((o) => o.value === "marketing")!;
    expect(marketing.hint).toBe("8× sessions, last today");
  });

  test("dividers carry the divider flag and DIVIDER_PREFIX value", () => {
    const all = [opt("core")];
    const recent = [{ name: "core", sessions: 1, lastUsed: "2026-05-26T08:00:00Z" }];
    const out = buildPickerSections(opt("__default"), all, recent, 3, now);
    const recentDiv = out.find((o) => o.value === `${DIVIDER_PREFIX}recent`);
    expect(recentDiv?.divider).toBe(true);
    expect(recentDiv?.label).toBe("  ── Recent ──");
  });

  test("recent entries pointing at non-existent profiles are skipped", () => {
    const all = [opt("backend")];
    const recent = [
      { name: "ghost", sessions: 5, lastUsed: "2026-05-26T08:00:00Z" }, // not in all
      { name: "backend", sessions: 4, lastUsed: "2026-05-26T08:00:00Z" },
    ];
    const out = buildPickerSections(opt("__default"), all, recent, 3, now);
    expect(out.map((o) => o.value)).toEqual([
      "__default",
      `${DIVIDER_PREFIX}recent`,
      "backend",
    ]);
  });

  test("recent composite picks are synthesized, not dropped (the coolify bug)", () => {
    // A composite has no standalone option in `all`. The old code resolved
    // recent via allProfileOpts.find and dropped it, collapsing Recent to the
    // lone surviving single profile. It must now appear as its own row.
    const all = [opt("backend"), opt("designer"), opt("coolify")];
    const recent = [
      { name: "backend+designer", sessions: 6, lastUsed: "2026-05-26T09:00:00Z" }, // newest
      { name: "coolify", sessions: 2, lastUsed: "2026-05-26T08:00:00Z" },
    ];
    const out = buildPickerSections(opt("__default"), all, recent, 3, now);
    const recentSection = out
      .slice(
        out.findIndex((o) => o.value === `${DIVIDER_PREFIX}recent`) + 1,
        out.findIndex((o) => o.value === `${DIVIDER_PREFIX}all`),
      )
      .map((o) => o.value);
    expect(recentSection).toEqual(["backend+designer", "coolify"]);
    const composite = out.find((o) => o.value === "backend+designer");
    expect(composite?.label).toBe("backend + designer");
  });

  test("recent composite reuses each part's icon label, not bare names", () => {
    // Combined recent rows should carry every part's icon (emoji or kitty image
    // placeholder), pulled from each part's own option label.
    const all = [
      { value: "improver", label: "📈 improver", hint: "" },
      { value: "secops", label: "🔒 secops", hint: "" },
      { value: "builder", label: "🐻 builder", hint: "" },
    ];
    const recent = [
      { name: "improver+secops+builder", sessions: 4, lastUsed: "2026-05-26T09:00:00Z" },
    ];
    const out = buildPickerSections(opt("__default"), all, recent, 3, now);
    const composite = out.find((o) => o.value === "improver+secops+builder");
    expect(composite?.label).toBe("📈 improver + 🔒 secops + 🐻 builder");
  });

  test("featured: composites synthesized, single profiles reuse their option and leave All", () => {
    const all = [opt("backend"), opt("designer"), opt("webshop")];
    const out = buildPickerSections(
      opt("__default"), all, [], 3, now, [], ["webshop", "backend+designer"],
    );
    expect(out.findIndex((o) => o.value === `${DIVIDER_PREFIX}featured`)).toBeGreaterThanOrEqual(0);
    expect(out.find((o) => o.value === "backend+designer")?.label).toBe("backend + designer");
    // A featured single profile is pulled out of the All section (no dupes).
    const allDiv = out.findIndex((o) => o.value === `${DIVIDER_PREFIX}all`);
    expect(out.slice(allDiv).map((o) => o.value)).not.toContain("webshop");
  });

  test("stack profiles land in their dedicated subsections in fixed order", () => {
    const all = [
      opt("backend"),
      opt("blog-writer"),
      opt("career"),
      opt("coolify"),
      opt("core"),
      opt("designer"),
      opt("designer-medusa"),
      opt("docs-writer"),
      opt("ecc"),
      opt("frontend"),
      opt("google-ads"),
      opt("google-analytics"),
      opt("higgsfield"),
      opt("medusa-dev"),
      opt("nextjs"),
      opt("postizz"),
      opt("python"),
      opt("rust"),
      opt("rust-core"),
      opt("skill-writer"),
      opt("vite"),
    ];
    const out = buildPickerSections(opt("__default"), all, [], 3, now);
    expect(out.map((o) => o.value)).toEqual([
      "__default",
      `${DIVIDER_PREFIX}all`,
      // Ungrouped survivors stay alphabetical (core only — everything else
      // now belongs to a labeled section).
      "core",
      // Subsections follow STACK_SECTIONS order.
      `${DIVIDER_PREFIX}ecommerce`,
      "ecc",
      `${DIVIDER_PREFIX}medusa`,
      "designer-medusa",
      "medusa-dev",
      `${DIVIDER_PREFIX}web`,
      "backend",
      "frontend",
      "nextjs",
      "vite",
      `${DIVIDER_PREFIX}creative`,
      "designer",
      "higgsfield",
      `${DIVIDER_PREFIX}marketing`,
      "postizz",
      `${DIVIDER_PREFIX}google`,
      "google-ads",
      "google-analytics",
      `${DIVIDER_PREFIX}infra`,
      "coolify",
      `${DIVIDER_PREFIX}data`,
      "python",
      `${DIVIDER_PREFIX}rust`,
      "rust",
      "rust-core",
      `${DIVIDER_PREFIX}writer`,
      "blog-writer",
      "docs-writer",
      "skill-writer",
      `${DIVIDER_PREFIX}security`,
      "career",
    ]);
    const labels = Object.fromEntries(
      out.filter((o) => o.divider).map((o) => [o.value, o.label] as const),
    );
    expect(labels[`${DIVIDER_PREFIX}ecommerce`]).toBe("  ── Ecommerce ──");
    expect(labels[`${DIVIDER_PREFIX}medusa`]).toBe("  ── Medusa ──");
    expect(labels[`${DIVIDER_PREFIX}web`]).toBe("  ── Web Development ──");
    expect(labels[`${DIVIDER_PREFIX}creative`]).toBe("  ── Design & Creative ──");
    expect(labels[`${DIVIDER_PREFIX}marketing`]).toBe("  ── Marketing & Social ──");
    expect(labels[`${DIVIDER_PREFIX}google`]).toBe("  ── Google ──");
    expect(labels[`${DIVIDER_PREFIX}infra`]).toBe("  ── Infra & Hosting ──");
    expect(labels[`${DIVIDER_PREFIX}data`]).toBe("  ── Data & Compute ──");
    expect(labels[`${DIVIDER_PREFIX}rust`]).toBe("  ── Rust ──");
    expect(labels[`${DIVIDER_PREFIX}writer`]).toBe("  ── Writer ──");
    expect(labels[`${DIVIDER_PREFIX}security`]).toBe("  ── Career & Security ──");
  });

  test("Featured section surfaces below Recent and dedupes from All", () => {
    const all = [opt("core"), opt("marketing"), opt("webshop"), opt("webshop-google")];
    const recent = [{ name: "core", sessions: 4, lastUsed: "2026-05-26T08:00:00Z" }];
    const out = buildPickerSections(
      opt("__default"), all, recent, 3, now, [], ["webshop", "webshop-google", "marketing"],
    );
    expect(out.map((o) => o.value)).toEqual([
      "__default",
      `${DIVIDER_PREFIX}recent`,
      "core",
      `${DIVIDER_PREFIX}featured`,
      "webshop",
      "webshop-google",
      "marketing",
    ]);
    // All featured rows were pulled out of the body — nothing left for an
    // "All profiles" section here.
    expect(out.some((o) => o.value === `${DIVIDER_PREFIX}all`)).toBe(false);
    const featuredDiv = out.find((o) => o.value === `${DIVIDER_PREFIX}featured`);
    expect(featuredDiv?.label).toBe("  ── ✨ Featured ──");
  });

  test("Featured skips profiles already shown in Suggested or Recent", () => {
    const all = [opt("webshop"), opt("marketing"), opt("core")];
    const recent = [{ name: "marketing", sessions: 2, lastUsed: "2026-05-26T08:00:00Z" }];
    const out = buildPickerSections(
      opt("__default"), all, recent, 3, now, [], ["webshop", "marketing"],
    );
    // marketing is in Recent, so Featured only carries webshop.
    const featuredIdx = out.findIndex((o) => o.value === `${DIVIDER_PREFIX}featured`);
    const featuredRows = out.slice(featuredIdx + 1).filter((o) => !o.divider).map((o) => o.value);
    expect(featuredRows).toContain("webshop");
    expect(out.filter((o) => o.value === "marketing")).toHaveLength(1);
  });

  test("subsection dividers are omitted when no profiles match", () => {
    const all = [opt("core"), opt("caveman-quick")]; // none match any stack section
    const out = buildPickerSections(opt("__default"), all, [], 3, now);
    expect(out.some((o) => o.divider && o.value !== `${DIVIDER_PREFIX}all`)).toBe(false);
  });

  test("Suggested section pins matching profiles above Default and skips them downstream", () => {
    const all = [opt("core"), opt("medusa-dev"), opt("medusa-next"), opt("nextjs")];
    const recent = [
      { name: "medusa-dev", sessions: 12, lastUsed: "2026-05-26T08:00:00Z" },
    ];
    const suggested = [
      { name: "medusa-dev", confidence: 0.9, reasons: ["medusa-config.js"] },
      { name: "medusa-next", confidence: 0.6, reasons: ["package.json has next"] },
    ];
    const out = buildPickerSections(opt("__default"), all, recent, 3, now, suggested);
    expect(out.map((o) => o.value)).toEqual([
      `${DIVIDER_PREFIX}suggested`,
      "medusa-dev",
      "medusa-next",
      "__default",
      `${DIVIDER_PREFIX}all`,
      "core",
      `${DIVIDER_PREFIX}web`,
      "nextjs",
    ]);
    // Suggested rows carry a "% match — reasons" hint.
    const medusaDev = out.find((o) => o.value === "medusa-dev")!;
    expect(medusaDev.hint).toBe("90% match — medusa-config.js");
    // medusa-dev had 12 Recent sessions but Suggested already showed it, so
    // there's no Recent divider on this run.
    expect(out.some((o) => o.value === `${DIVIDER_PREFIX}recent`)).toBe(false);
  });

  test("Suggested entries below the confidence floor are dropped entirely", () => {
    const all = [opt("frontend"), opt("rust")];
    const suggested = [
      { name: "frontend", confidence: 0.3, reasons: ["tsconfig.json"] }, // below 0.5 floor
    ];
    const out = buildPickerSections(opt("__default"), all, [], 3, now, suggested);
    expect(out.some((o) => o.value === `${DIVIDER_PREFIX}suggested`)).toBe(false);
    // frontend still appears in Web Development since it wasn't deduped out.
    expect(out.some((o) => o.value === "frontend")).toBe(true);
  });

  test("Suggested entries for unknown profiles are skipped", () => {
    const all = [opt("core")];
    const suggested = [
      { name: "ghost-profile", confidence: 0.9, reasons: ["fakefile"] },
    ];
    const out = buildPickerSections(opt("__default"), all, [], 3, now, suggested);
    expect(out.some((o) => o.value === `${DIVIDER_PREFIX}suggested`)).toBe(false);
  });

  test("AI suggestions get a distinct advisor heading", () => {
    const out = buildPickerSections(opt("__default"), [opt("google-ads")], [], 3, now, [
      { name: "google-ads", confidence: 0.9, reasons: ["GAQL scripts"], source: "ai" },
    ]);
    expect(out[0]?.label).toContain("AI profile advisor");
    expect(out.find((o) => o.value === "google-ads")?.hint).toBe("90% match — GAQL scripts");
  });

  test("hybrid suggestions disclose repository-signal merging and stale reuse", () => {
    const hybrid = buildPickerSections(opt("__default"), [opt("nextjs")], [], 3, now, [
      { name: "nextjs", confidence: 0.9, reasons: ["next.config.ts"], source: "hybrid" },
    ]);
    expect(hybrid[0]?.label).toContain("AI + repository signals");

    const stale = buildPickerSections(opt("__default"), [opt("nextjs")], [], 3, now, [
      { name: "nextjs", confidence: 0.9, reasons: ["next.config.ts"], source: "stale-hybrid" },
    ]);
    expect(stale[0]?.label).toContain("Recent AI + repository signals");
  });
});

describe("getDefaultSelector", () => {
  test("reads the real default-profile file when no reader is injected", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "cue-default-selector-"));
    try {
      await writeFile(join(dir, "default-profile"), "backend\ncore\nbackend\n");
      expect(getDefaultSelector(dir)).toBe("core+backend");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  const reader = (contents: string) => (_path: string) => contents;
  const missing = (_path: string): string => { throw new Error("ENOENT"); };

  test("returns 'core' when no file exists", () => {
    expect(getDefaultSelector("/fake", missing)).toBe("core");
  });

  test("composes core + extras from one-per-line file", () => {
    expect(
      getDefaultSelector(
        "/fake",
        reader("core\nskill-writer\necc\n"),
      ),
    ).toBe("core+skill-writer+ecc");
  });

  test("ignores comments, blanks, and duplicate 'core'", () => {
    expect(
      getDefaultSelector(
        "/fake",
        reader("# header\ncore\n\nskill-writer  # my fav\ncore\necc\n"),
      ),
    ).toBe("core+skill-writer+ecc");
  });

  test("accepts '+'-separated form too", () => {
    expect(
      getDefaultSelector("/fake", reader("core+skill-writer+ecc")),
    ).toBe("core+skill-writer+ecc");
  });

  test("always prepends 'core' even if user removed it", () => {
    expect(
      getDefaultSelector("/fake", reader("skill-writer\necc\n")),
    ).toBe("core+skill-writer+ecc");
  });
});


describe("formatProfileSummary", () => {
  test("empty profile returns no lines", () => {
    expect(formatProfileSummary(makeProfile())).toEqual([]);
  });

  test("counts skills and lists mcps + plugins", () => {
    const out = formatProfileSummary(
      makeProfile({
        skills: {
          local: [{ id: "github/github" }, { id: "deployment/coolify" }],
          npx: [],
        },
        mcps: [{ id: "claude-mem" }, { id: "gbrain" }],
        plugins: [{ id: "cue" }],
      }),
    );
    expect(out).toEqual([
      "skills    2",
      "mcps      claude-mem, gbrain",
      "plugins   cue",
    ]);
  });

  test("composite breakdown shows per-part skill counts after the arrow", () => {
    const main = makeProfile({
      name: "skill-writer+core+ecc",
      skills: {
        local: Array.from({ length: 53 }, (_, i) => ({ id: `cat/skill-${i}` })),
        npx: [],
      },
    });
    const parts = [
      makeProfile({
        name: "skill-writer",
        skills: { local: Array.from({ length: 8 }, (_, i) => ({ id: `sw/${i}` })), npx: [] },
      }),
      makeProfile({
        name: "core",
        skills: { local: Array.from({ length: 12 }, (_, i) => ({ id: `c/${i}` })), npx: [] },
      }),
      makeProfile({
        name: "ecc",
        skills: { local: Array.from({ length: 33 }, (_, i) => ({ id: `e/${i}` })), npx: [] },
      }),
    ];
    const out = formatProfileSummary(main, parts);
    expect(out[0]).toBe("skills    53  ← skill-writer:8 + core:12 + ecc:33");
  });

  test("composite breakdown prefixes each part with its icon when set", () => {
    const main = makeProfile({
      skills: { local: Array.from({ length: 6 }, (_, i) => ({ id: `cat/x-${i}` })), npx: [] },
    });
    const parts = [
      makeProfile({
        name: "writer",
        icon: "🧬",
        skills: { local: [{ id: "a/1" }, { id: "a/2" }], npx: [] },
      }),
      makeProfile({
        name: "core",
        icon: "🐢",
        skills: { local: [{ id: "b/1" }, { id: "b/2" }], npx: [] },
      }),
    ];
    const out = formatProfileSummary(main, parts);
    expect(out[0]).toBe("skills    6  ← 🧬 writer:2 + 🐢 core:2");
  });

  test("caps a fat composite breakdown at 6 parts with a '+N more' suffix", () => {
    const names = ["a", "b", "c", "d", "e", "f", "g"]; // 7 parts → cap kicks in
    const main = makeProfile({
      name: names.join("+"),
      skills: { local: names.map((n) => ({ id: `${n}/1` })), npx: [] },
    });
    const parts = names.map((n) =>
      makeProfile({ name: n, skills: { local: [{ id: `${n}/1` }], npx: [] } }),
    );
    const out = formatProfileSummary(main, parts);
    expect(out[0]).toBe("skills    7  ← a:1 + b:1 + c:1 + d:1 + e:1 + f:1 +1 more");
  });

  test("adds category line below skills when localCount >= 5", () => {
    const profile = makeProfile({
      skills: {
        local: [
          { id: "meta/a" }, { id: "meta/b" }, { id: "meta/c" },
          { id: "review/x" }, { id: "review/y" },
          { id: "plan/p" },
        ],
        npx: [],
      },
    });
    const out = formatProfileSummary(profile);
    expect(out).toEqual([
      "skills    6",
      "          meta:3  review:2  plan:1",
    ]);
  });

  test("omits category line when fewer than 5 local skills", () => {
    const profile = makeProfile({
      skills: { local: [{ id: "a/x" }, { id: "b/y" }], npx: [] },
    });
    const out = formatProfileSummary(profile);
    expect(out).toEqual(["skills    2"]);
  });

  test("no composite breakdown when parts has a single entry", () => {
    const profile = makeProfile({
      name: "solo",
      skills: { local: [{ id: "a/x" }], npx: [] },
    });
    const out = formatProfileSummary(profile, [profile]);
    expect(out[0]).toBe("skills    1");
  });

  test("breaks down local vs npx when both present", () => {
    const out = formatProfileSummary(
      makeProfile({
        skills: {
          local: [{ id: "a/x" }, { id: "a/y" }],
          npx: [{ source: { repo: "owner/r", pin: "v1" }, skills: [{ name: "z" }] } as never],
        },
      }),
    );
    expect(out[0]).toBe("skills    3 (2 local, 1 npx)");
  });

  test("truncates long mcp lists with '+N more'", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `mcp-${i}`);
    const out = formatProfileSummary(makeProfile({ mcps: ids.map((id) => ({ id })) }));
    expect(out[0]).toMatch(/^mcps      mcp-0, mcp-1, mcp-2, mcp-3, mcp-4, mcp-5, mcp-6, mcp-7, \+4 more$/);
  });

  test("omits sections that are empty", () => {
    const out = formatProfileSummary(
      makeProfile({
        skills: { local: [{ id: "a/x" }], npx: [] },
        // no mcps, no plugins
      }),
    );
    expect(out).toEqual(["skills    1"]);
  });

  test("renders commands as slash-prefixed list with basename stripped", () => {
    const out = formatProfileSummary(
      makeProfile({
        commands: [
          "resources/commands/code-review.md",
          "resources/commands/skill-lint.md",
          "careful.md",
        ],
      }),
    );
    expect(out).toEqual([
      "commands  /code-review  /skill-lint  /careful",
    ]);
  });

  test("renders agents separated by double-space", () => {
    const out = formatProfileSummary(
      makeProfile({ agents: ["claude-code", "codex"] }),
    );
    expect(out).toEqual(["agents    claude-code  codex"]);
  });

  test("wraps long command lists across multiple lines, indented under label", () => {
    const cmds = [
      "code-review", "checkpoint", "cue", "careful",
      "freeze", "unfreeze", "guard", "skill-lint",
      "feature-dev", "build-fix", "aside", "cost-report",
    ];
    const out = formatProfileSummary(makeProfile({ commands: cmds }));
    expect(out[0]).toBe(
      "commands  /code-review  /checkpoint  /cue  /careful\n" +
      "          /freeze  /unfreeze  /guard  /skill-lint\n" +
      "          /feature-dev  /build-fix  /aside  /cost-report",
    );
  });
});

describe("categoryBreakdown", () => {
  test("groups by leading segment, sorted by descending count", () => {
    expect(
      categoryBreakdown([
        "meta/a", "meta/b", "meta/c",
        "review/x", "review/y",
        "plan/p",
        "rogue", // no slash → "other"
      ]),
    ).toBe("meta:3  review:2  plan:1  other:1");
  });

  test("truncates beyond `max` with a +N cats footer", () => {
    const ids = [
      ...Array(8).fill("a/x"),
      ...Array(7).fill("b/x"),
      ...Array(1).fill("c/x"),
      ...Array(1).fill("d/x"),
      ...Array(1).fill("e/x"),
      ...Array(1).fill("f/x"),
      ...Array(1).fill("g/x"),
      ...Array(1).fill("h/x"),
      ...Array(1).fill("i/x"),
    ];
    expect(categoryBreakdown(ids)).toBe(
      "a:8  b:7  c:1  d:1  e:1  f:1  g:1  +2 cats",
    );
  });

  test("returns empty string for no input", () => {
    expect(categoryBreakdown([])).toBe("");
  });
});

describe("splitSkillBytes", () => {
  test("splits at the closing --- and counts each side", () => {
    const fm = "---\nname: foo\ndescription: bar\n---\n";
    const body = "# Heading\n\nbody text here";
    const out = splitSkillBytes(fm + body);
    expect(out.frontmatter).toBe(fm.length);
    expect(out.body).toBe(body.length);
  });

  test("no frontmatter delimiter: counts everything as body", () => {
    const src = "# just a markdown file\nno frontmatter";
    expect(splitSkillBytes(src)).toEqual({ frontmatter: 0, body: src.length });
  });
});

describe("computeTokenBreakdown", () => {
  // Each test skill: 100 tok frontmatter, body varies. Keeps math obvious.
  const tokens = (bodies: Record<string, number>) =>
    (id: string): { frontmatter: number; body: number } =>
      bodies[id] !== undefined ? { frontmatter: 100, body: bodies[id]! } : { frontmatter: 0, body: 0 };

  test("single profile: alwaysOn = sum of frontmatter, maxIfAllActivate = sum of bodies", () => {
    const profile = makeProfile({
      skills: { local: [{ id: "a/x" }, { id: "a/y" }, { id: "a/z" }], npx: [] },
    });
    const b = computeTokenBreakdown(profile, undefined, tokens({ "a/x": 1000, "a/y": 5000, "a/z": 3000 }));
    expect(b.alwaysOn).toBe(300);
    expect(b.maxIfAllActivate).toBe(9000);
    expect(b.totalSkills).toBe(3);
    expect(b.byProfile).toEqual([]);
    expect(b.heaviestBodies.map((s) => s.id)).toEqual(["a/y", "a/z", "a/x"]);
  });

  test("composite: per-profile alwaysOn dedupes overlap (first-wins)", () => {
    const writer = makeProfile({
      name: "writer",
      skills: { local: [{ id: "w/1" }, { id: "shared/x" }], npx: [] },
    });
    const core = makeProfile({
      name: "core",
      skills: { local: [{ id: "c/1" }, { id: "shared/x" }], npx: [] }, // overlap -> credited to writer
    });
    const ecc = makeProfile({
      name: "ecc",
      skills: { local: [{ id: "e/1" }, { id: "e/2" }, { id: "e/3" }], npx: [] },
    });
    const merged = makeProfile({
      skills: {
        local: [{ id: "w/1" }, { id: "shared/x" }, { id: "c/1" }, { id: "e/1" }, { id: "e/2" }, { id: "e/3" }],
        npx: [],
      },
    });
    const b = computeTokenBreakdown(merged, [writer, core, ecc], tokens({
      "w/1": 1000, "shared/x": 2000, "c/1": 5000, "e/1": 8000, "e/2": 5000, "e/3": 3000,
    }));
    // 6 skills * 100 = 600 frontmatter
    expect(b.alwaysOn).toBe(600);
    expect(b.byProfile).toEqual([
      { name: "writer", tokens: 200, skillCount: 2 }, // w/1 + shared/x
      { name: "core", tokens: 100, skillCount: 1 },   // c/1 only
      { name: "ecc", tokens: 300, skillCount: 3 },    // e/1 + e/2 + e/3
    ]);
  });
});

describe("tokenLevelEmoji", () => {
  test("maps each threshold band to the right dot", () => {
    expect(tokenLevelEmoji(0)).toBe("🟢");
    expect(tokenLevelEmoji(5000)).toBe("🟢"); // boundary: not > 5000
    expect(tokenLevelEmoji(5001)).toBe("🟡");
    expect(tokenLevelEmoji(10000)).toBe("🟡"); // boundary
    expect(tokenLevelEmoji(10001)).toBe("🟠");
    expect(tokenLevelEmoji(15000)).toBe("🟠"); // boundary
    expect(tokenLevelEmoji(15001)).toBe("🔴");
    expect(tokenLevelEmoji(50000)).toBe("🔴");
  });

  test("matches the dot used by formatStartupBanner's token segment", () => {
    // Cross-check: if the helper and the banner ever drift, this fails.
    const out = formatStartupBanner({ title: "x", skills: 30, mcps: 0, alwaysOn: 12000 });
    expect(out).toContain(tokenLevelEmoji(12000));
  });
});

describe("formatStartupBanner", () => {
  // colorFns() disables ANSI when stdout isn't a TTY (the test env), so these
  // assertions are plain text.
  test("identity-only line for a light profile (no token info)", () => {
    expect(formatStartupBanner({ title: "claude · 🦊 core", skills: 3, mcps: 0 })).toBe(
      "▸ claude · 🦊 core · 3 skills",
    );
  });

  test("singular skill/MCP words and an MCP segment when present", () => {
    expect(formatStartupBanner({ title: "codex · 🧪 x", skills: 1, mcps: 1 })).toBe(
      "▸ codex · 🧪 x · 1 skill · 1 MCP",
    );
  });

  test("omits the token segment under the 2K always-on floor", () => {
    expect(
      formatStartupBanner({ title: "claude · core", skills: 20, mcps: 0, alwaysOn: 1500 }),
    ).toBe("▸ claude · core · 20 skills");
  });

  test("shows the level dot and ~NK, but no pointer below the 10K heavy mark", () => {
    expect(
      formatStartupBanner({ title: "claude · core", skills: 53, mcps: 7, alwaysOn: 8000 }),
    ).toBe("▸ claude · core · 53 skills · 7 MCPs · 🟡 ~8K always-on");
  });

  test("appends → cue cost for heavy profiles (>=10K always-on)", () => {
    expect(
      formatStartupBanner({ title: "claude · 🏭 gstack +4", skills: 96, mcps: 7, alwaysOn: 22845 }),
    ).toBe("▸ claude · 🏭 gstack +4 · 96 skills · 7 MCPs · 🔴 ~23K always-on · → cue cost");
  });
});

describe("formatDoctorWarnings", () => {
  test("returns [] for no warnings", () => {
    expect(formatDoctorWarnings([])).toEqual([]);
  });

  test("single compact line, singular 'warning' for exactly one", () => {
    const out = formatDoctorWarnings([{ code: "D1", message: `skill "meta/foo" not found on disk` }]);
    expect(out).toEqual(["⚠ 1 cue-doctor warning → cue doctor --fix"]);
  });

  test("single compact line, plural for more than one", () => {
    const out = formatDoctorWarnings([
      { code: "D1", message: `skill "meta/foo" not found on disk` },
      { code: "D2", message: `MCP "obsidian" not in registry` },
      { code: "D4", message: `skill "vps" needs MCP "hostinger" (from profile)` },
      { code: "D2", message: `MCP "extra" not in registry` },
      { code: "D5", message: `runtime missing hash (may be stale)` },
    ]);
    expect(out).toEqual(["⚠ 5 cue-doctor warnings → cue doctor --fix"]);
  });
});

describe("formatTmuxTitle", () => {
  test("single profile shows icon + name", () => {
    expect(formatTmuxTitle("claude", "medusa-dev", ["🦊"])).toBe("claude · 🦊 medusa-dev");
  });

  test("two profiles spell out both with a `+`", () => {
    expect(formatTmuxTitle("claude", "medusa-dev+backend", ["🦊", "🌐"])).toBe(
      "claude · 🦊 medusa-dev + 🌐 backend",
    );
  });

  test("three or more profiles collapse the tail into a count badge", () => {
    expect(
      formatTmuxTitle(
        "claude",
        "coolify+backend+hostinger+medusa-dev",
        ["🍐", "⚙️", "🏠", "🦊"],
      ),
    ).toBe("claude · 🍐 coolify +3");
  });

  test("missing icons just drop the icon prefix for that part", () => {
    expect(formatTmuxTitle("claude", "ecc", [""])).toBe("claude · ecc");
    expect(formatTmuxTitle("claude", "ecc+backend", ["", "🌐"])).toBe("claude · ecc + 🌐 backend");
  });

  test("empty/whitespace profile name degrades to just the agent label", () => {
    expect(formatTmuxTitle("claude", "", [])).toBe("claude");
    expect(formatTmuxTitle("claude", "   ", [])).toBe("claude");
  });
});

describe("shouldAppendUserClaudeMd", () => {
  const home = "/home/u";

  test("claude-code under $HOME → skip (harness already loads ~/.claude/CLAUDE.md)", () => {
    expect(shouldAppendUserClaudeMd({ agent: "claude-code", cwd: "/home/u/proj/x", home })).toBe(false);
  });

  test("claude-code exactly at $HOME → skip", () => {
    expect(shouldAppendUserClaudeMd({ agent: "claude-code", cwd: "/home/u", home })).toBe(false);
  });

  test("claude-code outside $HOME → append (cue is the only source)", () => {
    expect(shouldAppendUserClaudeMd({ agent: "claude-code", cwd: "/tmp/proj", home })).toBe(true);
  });

  test("sibling dir sharing a name prefix is NOT inside $HOME", () => {
    expect(shouldAppendUserClaudeMd({ agent: "claude-code", cwd: "/home/u2", home })).toBe(true);
  });

  test("codex always appends (its memory-load model is unverified here)", () => {
    expect(shouldAppendUserClaudeMd({ agent: "codex", cwd: "/home/u/proj", home })).toBe(true);
  });

  test("pathological home === '/' falls back to append (safe default)", () => {
    expect(shouldAppendUserClaudeMd({ agent: "claude-code", cwd: "/home/u/proj", home: "/" })).toBe(true);
  });

  test("CUE_APPEND_USER_CLAUDEMD=1 forces the legacy always-append behavior", () => {
    expect(
      shouldAppendUserClaudeMd({ agent: "claude-code", cwd: "/home/u/proj", home, env: { CUE_APPEND_USER_CLAUDEMD: "1" } }),
    ).toBe(true);
  });
});

describe("ownsPaneBadge", () => {
  test("an interactive launch inside tmux owns the badge", () => {
    expect(ownsPaneBadge({ TMUX: "/tmp/tmux-1000/default,123,0" }, true)).toBe(true);
  });

  test("a piped launch does not — it is the --print helper sharing the pane", () => {
    // The skill-selector cue spawns on every session start inherits TMUX_PANE
    // from the session it helps. Announcing there would overwrite that
    // session's badge and clear it again on exit seconds later.
    expect(ownsPaneBadge({ TMUX: "/tmp/tmux-1000/default,123,0" }, false)).toBe(false);
  });

  test("outside tmux nobody owns a badge", () => {
    expect(ownsPaneBadge({}, true)).toBe(false);
  });

  test("CUE_TMUX_TITLE=0 opts out even when interactive", () => {
    expect(
      ownsPaneBadge({ TMUX: "/tmp/tmux-1000/default,123,0", CUE_TMUX_TITLE: "0" }, true),
    ).toBe(false);
  });
});
