/**
 * Local skills resolver (Agent A6).
 *
 * Given a `ResolvedProfile`, walk the on-disk `skills/skills/` tree and
 * produce a `LinkPlan[]` for every entry in `profile.skills.local`. No
 * symlinking happens here — that's the materializer (A14). This module is
 * read-only by contract.
 *
 * Each `skills.local` entry is one of:
 *   - `<category>/<slug>` — an exact path: look up `<root>/<category>/<slug>`.
 *   - `<slug>`            — a bare slug: search every category. Throws
 *                           `AmbiguousSkillRef` if more than one category
 *                           defines the slug.
 *
 * The directory must contain a `SKILL.md`, otherwise `SkillNotFound` is
 * raised. Missing slugs trigger `SkillNotFound` with up to three Levenshtein
 * suggestions across the discovered slugs.
 */
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ProfileError, type LinkPlan, type ResolvedProfile } from "../../profiles/_types";

// ---------------------------------------------------------------------------
// Repo-root helpers (used by resolveLocalSkill)
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const DEFAULT_SKILLS_ROOT = join(REPO_ROOT, "resources", "skills", "skills");

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class AmbiguousSkillRef extends ProfileError {
  constructor(
    public ref: string,
    public candidates: string[],
  ) {
    super(
      "AMBIGUOUS_SKILL_REF",
      `Skill ref "${ref}" is ambiguous; matches: ${candidates.join(", ")}. ` +
        `Disambiguate by using "<category>/${ref}".`,
    );
  }
}

export class SkillNotFound extends ProfileError {
  /** Known slugs (`<category>/<slug>`) whose trailing segment equals the ref. */
  public categoryMatches: string[];

  constructor(
    public ref: string,
    public suggestions: string[],
    /**
     * Full list of known `<category>/<slug>` ids. When the bare ref matches an
     * existing slug under a category path, that case is surfaced first — the
     * common mistake is referencing `roi-estimator` instead of
     * `meta/roi-estimator`.
     */
    allSlugs: string[] = [],
  ) {
    const bare = ref.trim().replace(/\/+$/, "");
    const categoryMatches =
      bare === "" || bare.includes("/")
        ? []
        : allSlugs.filter(
            (s) => s.slice(s.lastIndexOf("/") + 1) === bare,
          );

    let hint = "";
    if (categoryMatches.length === 1) {
      hint =
        ` Found "${categoryMatches[0]}" — did you mean that?` +
        ` Skills are referenced as <category>/<name>.`;
    } else if (categoryMatches.length > 1) {
      hint =
        ` Found under these categories: ${categoryMatches.join(", ")}.` +
        ` Skills are referenced as <category>/<name>.`;
    } else if (suggestions.length > 0) {
      hint = ` Did you mean: ${suggestions.join(", ")}?`;
    }

    super("SKILL_NOT_FOUND", `Skill "${ref}" not found.${hint}`);
    this.categoryMatches = categoryMatches;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ResolveLocalOptions {
  /**
   * Absolute path to the `skills/skills/` root. Configurable for tests; in
   * production the CLI passes `<repo>/skills/skills`.
   */
  skillsRoot: string;
}

/**
 * Resolve every `skills.local` entry on the profile into a `LinkPlan`.
 *
 * The function discovers the directory layout at call time — it does not
 * assume any particular category set. The `skillsRoot` option exists so the
 * test suite can point at a temporary fake tree.
 */
export async function resolveLocal(
  profile: ResolvedProfile,
  options: ResolveLocalOptions,
): Promise<LinkPlan[]> {
  const root = resolve(options.skillsRoot);
  const refs = profile.skills?.local ?? [];
  if (refs.length === 0) return [];

  // Discover the on-disk layout once. `categoryIndex` maps category -> slugs;
  // `slugIndex` maps bare-slug -> list of categories that define it. Built
  // lazily so a profile with only `<category>/<slug>` refs only pays for the
  // categories it touches if we wanted — but the cost of a single readdir
  // pass is tiny, so we always walk.
  const { categoryIndex, slugIndex, allSlugs } = await walk(root);

  const plans: LinkPlan[] = [];
  for (const ref of refs) {
    const id = ref.id;

    // Wildcard: "*/*" means "all skills in all categories".
    if (id === "*/*") {
      for (const slug of allSlugs) {
        try {
          plans.push(await resolveOne(slug, root, categoryIndex, slugIndex, allSlugs));
        } catch {
          // Skip entries without SKILL.md (e.g. .omc/state)
        }
      }
      continue;
    }

    plans.push(await resolveOne(id, root, categoryIndex, slugIndex, allSlugs));
  }
  return plans;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface SkillsIndex {
  /** category -> sorted list of slugs in that category */
  categoryIndex: Map<string, string[]>;
  /** slug -> sorted list of categories defining that slug */
  slugIndex: Map<string, string[]>;
  /** Every `<category>/<slug>` pair, used for Levenshtein suggestions. */
  allSlugs: string[];
}

async function walk(root: string): Promise<SkillsIndex> {
  let categories: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    categories = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    // Surface a clear error if the skills root itself is wrong; this is a
    // misconfiguration, not a missing skill.
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProfileError(
      "SKILLS_ROOT_UNREADABLE",
      `Cannot read skills root "${root}": ${msg}`,
    );
  }

  const categoryIndex = new Map<string, string[]>();
  const slugIndex = new Map<string, string[]>();
  const allSlugs: string[] = [];

  for (const category of categories) {
    const catPath = join(root, category);
    let slugs: string[];
    try {
      const entries = await readdir(catPath, { withFileTypes: true });
      // A skill maintained in its own repo can be symlinked into the tree
      // (e.g. browser/ego-browser -> ~/Documents/ego-lite-linux/skills/...).
      // dirent.isDirectory() is false for the link itself, so stat through it.
      const resolved = await Promise.all(
        entries.map(async (e) => {
          if (e.isDirectory()) return e.name;
          if (!e.isSymbolicLink()) return null;
          try {
            return (await stat(join(catPath, e.name))).isDirectory()
              ? e.name
              : null;
          } catch {
            return null; // dangling link — treat as absent
          }
        }),
      );
      slugs = resolved.filter((name): name is string => name !== null);
    } catch {
      // A non-directory or unreadable entry at the category level is ignored
      // rather than fatal — keeps walk robust against stray files.
      continue;
    }
    slugs.sort();
    categoryIndex.set(category, slugs);
    for (const slug of slugs) {
      const list = slugIndex.get(slug);
      if (list) list.push(category);
      else slugIndex.set(slug, [category]);
      allSlugs.push(`${category}/${slug}`);
    }
  }
  for (const list of slugIndex.values()) list.sort();
  return { categoryIndex, slugIndex, allSlugs };
}

async function resolveOne(
  ref: string,
  root: string,
  categoryIndex: Map<string, string[]>,
  slugIndex: Map<string, string[]>,
  allSlugs: string[],
): Promise<LinkPlan> {
  // Normalize: trim, drop trailing slash; reject empty, absolute, or `..`.
  const trimmed = ref.trim().replace(/\/+$/, "");
  if (trimmed === "" || trimmed.startsWith("/") || trimmed.includes("..")) {
    throw new SkillNotFound(ref, [], allSlugs);
  }

  const parts = trimmed.split("/");
  let category: string;
  let slug: string;

  if (parts.length === 1) {
    // Bare slug — search every category.
    slug = parts[0]!;
    const hits = slugIndex.get(slug) ?? [];
    if (hits.length === 0) {
      throw new SkillNotFound(ref, suggest(trimmed, allSlugs), allSlugs);
    }
    if (hits.length > 1) {
      throw new AmbiguousSkillRef(
        ref,
        hits.map((c) => `${c}/${slug}`),
      );
    }
    category = hits[0]!;
  } else if (parts.length === 2) {
    category = parts[0]!;
    slug = parts[1]!;
    const slugs = categoryIndex.get(category);
    if (!slugs || !slugs.includes(slug)) {
      throw new SkillNotFound(ref, suggest(trimmed, allSlugs), allSlugs);
    }
  } else {
    // We don't support nested categories. Treat as not-found with suggestions.
    throw new SkillNotFound(ref, suggest(trimmed, allSlugs), allSlugs);
  }

  const skillDir = join(root, category, slug);
  const skillMd = join(skillDir, "SKILL.md");
  let ok = false;
  try {
    const st = await stat(skillMd);
    ok = st.isFile();
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new SkillNotFound(ref, suggest(trimmed, allSlugs), allSlugs);
  }

  return {
    source: skillDir,
    target: `.claude/skills/${basename(skillDir)}`,
    origin: "local",
  };
}

// ---------------------------------------------------------------------------
// Levenshtein suggestions
// ---------------------------------------------------------------------------

/**
 * Return up to `limit` closest candidates from `pool` by Levenshtein distance
 * to `query`. Ties broken by lexicographic order so output is deterministic.
 */
export function suggest(query: string, pool: string[], limit = 3): string[] {
  if (pool.length === 0) return [];
  // Compare against the *last segment* of pool entries too (so a bare slug
  // query can match `<category>/<slug>` pool entries cleanly). Take the
  // smaller of the two distances.
  const scored = pool.map((candidate) => {
    const tail = candidate.includes("/")
      ? candidate.slice(candidate.lastIndexOf("/") + 1)
      : candidate;
    const d = Math.min(levenshtein(query, candidate), levenshtein(query, tail));
    return { candidate, d };
  });
  scored.sort((a, b) => (a.d - b.d) || a.candidate.localeCompare(b.candidate));
  return scored.slice(0, limit).map((s) => s.candidate);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Two-row DP — O(min(a,b)) memory, O(a*b) time. Small inputs (skill slugs),
  // so this is fine.
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]! + 1, // insertion
        prev[j]! + 1, // deletion
        prev[j - 1]! + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

// Re-export for internal tests that want to assert the platform separator
// isn't leaking into target paths.
export const _internal = { sep };

// ---------------------------------------------------------------------------
// Convenience export for launch.ts — resolve a single skill id → source dir
// ---------------------------------------------------------------------------

/**
 * Resolve a single skill id (e.g. "design/ui-ux-pro-max") to its absolute
 * source directory on disk, using the repo's `skills/skills/` root.
 *
 * This is a thin wrapper over the internal `resolveOne` + `walk` logic that
 * already exists; it just removes the need for callers to build a fake
 * ResolvedProfile or pass skillsRoot explicitly.
 *
 * Uses CUE_REPO_ROOT (or legacy SOUL_REPO_ROOT) env var as override if set (so tests can inject a
 * different root without touching the real skills tree).
 */
export async function resolveLocalSkill(id: string): Promise<string> {
  return createLocalSkillResolver()(id);
}

/** Share one lazy directory scan within a launch/install, never across sessions.
 * SKILL.md is still checked on every lookup; errors and ambiguity stay unchanged.
 */
export function createLocalSkillResolver(options?: ResolveLocalOptions): (id: string) => Promise<string> {
  const skillsRoot = (process.env.CUE_REPO_ROOT ?? process.env.SOUL_REPO_ROOT)
    ? join((process.env.CUE_REPO_ROOT ?? process.env.SOUL_REPO_ROOT)!, "resources", "skills", "skills")
    : DEFAULT_SKILLS_ROOT;
  const root = resolve(options?.skillsRoot ?? skillsRoot);
  let index: Promise<SkillsIndex> | undefined;
  return async (id) => {
    index ??= walk(root);
    const { categoryIndex, slugIndex, allSlugs } = await index;
    const plan = await resolveOne(id, root, categoryIndex, slugIndex, allSlugs);
    return plan.source;
  };
}

/**
 * Return all valid `<category>/<slug>` skill IDs (those with a SKILL.md).
 */
export async function listAllSkillIds(): Promise<string[]> {
  const skillsRoot = (process.env.CUE_REPO_ROOT ?? process.env.SOUL_REPO_ROOT)
    ? join((process.env.CUE_REPO_ROOT ?? process.env.SOUL_REPO_ROOT)!, "resources", "skills", "skills")
    : DEFAULT_SKILLS_ROOT;
  const root = resolve(skillsRoot);
  const { allSlugs } = await walk(root);
  const valid: string[] = [];
  for (const slug of allSlugs) {
    try {
      const st = await stat(join(root, slug, "SKILL.md"));
      if (st.isFile()) valid.push(slug);
    } catch {}
  }
  return valid;
}
