/**
 * Shared-profile management.
 *
 * v1 design: any GitHub repo containing a `profile.yaml` (or a
 * `profiles/<name>/profile.yaml`) can be installed by reference. No central
 * registry is required to ship — install pulls raw files via the GitHub raw
 * content URL. The central registry (`opencue/claude-code-skills-profiles`) is a
 * future-turn convenience, not a v1 dependency.
 *
 * Installed shared profiles land under `~/.config/cue/shared/<user>/<name>/`
 * and are namespaced as `<user>.<name>` to prevent collision with builtins.
 * `cue use <user>.<name>` resolves them via the standard profile loader,
 * which already understands `CUE_SHARED_PROFILES_DIR` as an extra search path.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import { isMap, parse as parseYaml, parseDocument } from "yaml";
import { cacheDir } from "./config-paths";
import { repoRoot } from "./repo-root";

export interface SharedRef {
  /** Originating GitHub user / org. */
  user: string;
  /** Repo (or repo/path if the profile lives in a subdirectory). */
  repo: string;
  /** Optional ref — branch / tag / sha. Defaults to "main" then "master". */
  ref?: string;
  /**
   * Optional path within the repo to the profile dir. When absent we try the
   * repo root first, then `profiles/<repo>/profile.yaml`.
   */
  subpath?: string;
}

export interface InstalledMeta {
  source_url: string;
  installed_at: string;
  sha: string | null;
}

export function sharedRoot(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "cue", "shared");
}

/** Local install path for a given shared ref. */
export function sharedProfileDir(ref: SharedRef): string {
  if (!validShareRef(ref)) throw new Error("Invalid GitHub profile reference");
  return join(sharedRoot(), ref.user, ref.repo);
}

function validShareRef(ref: SharedRef): boolean {
  const segment = (value: string) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(value) && value !== "." && value !== "..";
  const path = (value: string) => value.split("/").every(segment);
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(ref.user) && segment(ref.repo)
    && (!ref.ref || path(ref.ref)) && (!ref.subpath || path(ref.subpath));
}

/**
 * Local profile name used in selectors (`cue use jane-medusa-shop`).
 * Kebab-case (no `.`) so it passes the existing schema name pattern
 * without changes elsewhere. Lower-cased + non-kebab chars stripped from
 * each segment so a GitHub user like `Jane_QA` becomes `jane-qa`.
 */
export function sharedProfileName(ref: SharedRef): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${slug(ref.user)}-${slug(ref.repo)}`;
}

/**
 * Parse a CLI argument like `jane/medusa-shop`, `jane/medusa-shop@v1`,
 * `https://github.com/jane/medusa-shop`, or
 * `https://github.com/jane/medusa-shop/tree/v1/profiles/storefront`.
 *
 * Returns null on anything we can't recognize so callers can render a
 * helpful error pointing at the supported formats.
 */
export function parseShareRef(input: string): SharedRef | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // github.com URL form.
  const urlMatch = trimmed.match(
    /^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/\s]+)(?:\/(.+?))?)?\/?$/,
  );
  if (urlMatch) {
    const ref = {
      user: urlMatch[1]!,
      repo: urlMatch[2]!,
      ref: urlMatch[3],
      subpath: urlMatch[4],
    };
    return validShareRef(ref) ? ref : null;
  }

  // Shorthand `user/repo` or `user/repo@ref` or `user/repo:path`.
  const short = trimmed.match(/^([a-zA-Z0-9][\w.-]*)\/([\w.-]+?)(?:@([\w./-]+))?(?::(.+))?$/);
  if (short) {
    const ref = {
      user: short[1]!,
      repo: short[2]!,
      ref: short[3],
      subpath: short[4],
    };
    return validShareRef(ref) ? ref : null;
  }

  return null;
}

/**
 * Candidate raw-file URLs to try, in order. The first one that responds
 * with a profile.yaml wins. Empty `ref` falls through `main` → `master`.
 */
export function candidateProfileUrls(ref: SharedRef): string[] {
  if (!validShareRef(ref)) throw new Error("Invalid GitHub profile reference");
  const refs = ref.ref ? [ref.ref] : ["main", "master"];
  const paths: string[] = [];
  if (ref.subpath) {
    const sub = ref.subpath.replace(/\/+$/, "");
    paths.push(`${sub}/profile.yaml`);
  } else {
    paths.push("profile.yaml");
    paths.push(`profiles/${ref.repo}/profile.yaml`);
  }
  const out: string[] = [];
  for (const r of refs) {
    for (const p of paths) {
      out.push(`https://raw.githubusercontent.com/${ref.user}/${ref.repo}/${r}/${p}`);
    }
  }
  return out;
}

export interface FetchResult {
  /** Raw profile.yaml content. */
  body: string;
  /** URL that succeeded (for the .meta.json source_url). */
  source: string;
  /** Resolved git sha (when the GitHub API returns it). Null otherwise. */
  sha: string | null;
}

/**
 * Registry index entry — the shape of each row in the central
 * `opencue/claude-code-skills-profiles/index.json` that powers `cue share search`.
 * Kept minimal: the search rendering uses just these fields, and a heavier
 * payload makes the index file slow to fetch on cold cache.
 */
export interface RegistryEntry {
  /** Author's GitHub login. */
  author: string;
  /** Repo / profile name. */
  name: string;
  /** One-line description (copied from profile.yaml `description:`). */
  description: string;
  /** GitHub star count of the source repo, snapshotted by CI. */
  stars?: number;
  /** Number of times `cue share install` has fetched this entry. */
  downloads?: number;
  /** Commit sha the index entry was built from. */
  sha?: string;
  /** Last index refresh time (ISO). */
  updated_at?: string;
  /** Optional list of profile-name dependencies (the `inherits:` chain). */
  deps?: string[];
}

/**
 * Pull the first reachable profile.yaml. Strict 200-or-bust; redirects are
 * followed by fetch automatically. Network failures bubble up so the caller
 * can render a friendly error.
 */
export async function fetchProfileYaml(
  ref: SharedRef,
  fetcher: typeof fetch = fetch,
): Promise<FetchResult> {
  const urls = candidateProfileUrls(ref);
  let lastStatus = 0;
  for (const url of urls) {
    let res: Response;
    try {
      // Bound each request so a hung raw.githubusercontent.com response can't
      // stall the install indefinitely; a timeout throws → try the next URL.
      res = await fetcher(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    } catch {
      continue;
    }
    if (res.status === 200) {
      const body = await res.text();
      return { body, source: url, sha: null };
    }
    lastStatus = res.status;
  }
  throw new Error(
    `Profile not found at ${ref.user}/${ref.repo}` +
    (ref.ref ? `@${ref.ref}` : "") +
    (ref.subpath ? `:${ref.subpath}` : "") +
    ` (last HTTP ${lastStatus}; tried ${urls.length} candidate URL${urls.length > 1 ? "s" : ""})`,
  );
}

/**
 * Rewrite the profile YAML's `name:` line to the namespaced form so the
 * profile loader can find it without colliding with builtins. Surgical
 * regex edit — preserves comments and key order, just like
 * `dropSkillsFromYaml` in prune.ts.
 */
export function namespaceProfileYaml(body: string, namespacedName: string): string {
  const document = parseDocument(body);
  if (document.errors.length) throw new Error(`Invalid profile YAML: ${document.errors[0]!.message}`);
  if (isMap(document.contents)) {
    const name = document.contents.get("name", true);
    if (name?.range) {
      return body.slice(0, name.range[0]) + namespacedName + body.slice(name.range[1]);
    }
  }
  // No `name:` line found — prepend one so the loader doesn't barf.
  return `name: ${namespacedName}\n${body}`;
}

let sharedValidator: ValidateFunction | undefined;

/** Validate both fetched YAML and its local name against Cue's canonical schema. */
function validateSharedProfile(body: string): void {
  if (Buffer.byteLength(body, "utf8") > 1_000_000) throw new Error("Profile YAML exceeds 1 MB");
  sharedValidator ??= new Ajv({ allErrors: true, strict: false, useDefaults: false }).compile(
    JSON.parse(readFileSync(join(repoRoot(), "profiles", "schema.json"), "utf8")),
  );
  const profile: unknown = parseYaml(body);
  if (!sharedValidator(profile)) {
    throw new Error(`Invalid profile YAML: ${sharedValidator.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`);
  }
}

/** A downloaded profile must never write through pre-existing symlinks. */
function assertInstallPaths(ref: SharedRef): void {
  const dir = sharedProfileDir(ref);
  for (const path of [join(sharedRoot(), ref.user), dir, join(dir, "profile.yaml"), join(dir, ".meta.json")]) {
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symlink in shared profile path: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/**
 * Persist the install + a meta record. Idempotent — re-installing
 * overwrites the existing profile + meta.
 */
export function writeInstall(
  ref: SharedRef,
  body: string,
  meta: InstalledMeta,
): { dir: string; namespacedName: string } {
  const dir = sharedProfileDir(ref);
  validateSharedProfile(body);
  const namespacedName = sharedProfileName(ref);
  const namespaced = namespaceProfileYaml(body, namespacedName);
  validateSharedProfile(namespaced);
  assertInstallPaths(ref);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "profile.yaml"), namespaced);
  writeFileSync(join(dir, ".meta.json"), JSON.stringify(meta, null, 2) + "\n");
  return { dir, namespacedName };
}

export interface InstalledEntry {
  user: string;
  repo: string;
  namespacedName: string;
  dir: string;
  meta: InstalledMeta | null;
}

/** Walk the shared root and list every installed profile. */
export function listInstalled(): InstalledEntry[] {
  const root = sharedRoot();
  if (!existsSync(root)) return [];
  const out: InstalledEntry[] = [];
  for (const user of readdirSync(root)) {
    const userDir = join(root, user);
    let st;
    try { st = statSync(userDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const repo of readdirSync(userDir)) {
      const dir = join(userDir, repo);
      let inner;
      try { inner = statSync(dir); } catch { continue; }
      if (!inner.isDirectory()) continue;
      if (!existsSync(join(dir, "profile.yaml"))) continue;
      let meta: InstalledMeta | null = null;
      try {
        meta = JSON.parse(readFileSync(join(dir, ".meta.json"), "utf8")) as InstalledMeta;
      } catch { /* meta missing → still list */ }
      out.push({
        user,
        repo,
        namespacedName: sharedProfileName({ user, repo }),
        dir,
        meta,
      });
    }
  }
  return out.sort((a, b) => a.namespacedName.localeCompare(b.namespacedName));
}

/**
 * Default registry source. Single env override (`CUE_REGISTRY_URL`) lets
 * power users point at a fork or a self-hosted mirror without code changes.
 */
export function registryIndexUrl(): string {
  return (
    process.env.CUE_REGISTRY_URL ??
    "https://raw.githubusercontent.com/opencue/claude-code-skills-profiles/main/index.json"
  );
}

/** Path of the cached index.json on disk. */
export function indexCachePath(): string {
  return join(cacheDir(), "registry-index.json");
}

export interface IndexCacheEntry {
  fetched_at: string;
  source: string;
  entries: RegistryEntry[];
}

/**
 * Read the cached index. Returns null when missing, malformed, or older
 * than `maxAgeMinutes` (default 60 — same default the design doc commits
 * to). Callers re-fetch on miss.
 */
export function readCachedIndex(maxAgeMinutes = 60): IndexCacheEntry | null {
  const path = indexCachePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as IndexCacheEntry;
    if (!parsed.fetched_at || !Array.isArray(parsed.entries)) return null;
    const ageMs = Date.now() - new Date(parsed.fetched_at).getTime();
    if (ageMs > maxAgeMinutes * 60 * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist a fresh index — atomic via tmp + rename to avoid partial reads. */
export function writeIndexCache(entries: RegistryEntry[], source: string): void {
  const path = indexCachePath();
  mkdirSync(dirname(path), { recursive: true });
  const payload: IndexCacheEntry = {
    fetched_at: new Date().toISOString(),
    source,
    entries,
  };
  // Atomic (tmp + rename, same dir) so concurrent `cue share search` readers
  // never see a partial write — matches this function's own doc comment.
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * Substring-match search across cached entries. Multi-word queries match
 * AND-style: every word must appear in either the name or description.
 * Empty query returns every entry sorted by stars then alpha.
 */
export function searchIndex(
  entries: ReadonlyArray<RegistryEntry>,
  query: string,
): RegistryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matched = entries.filter((e) => {
    if (words.length === 0) return true;
    const haystack = `${e.author}/${e.name} ${e.description ?? ""}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
  matched.sort((a, b) =>
    (b.stars ?? 0) - (a.stars ?? 0) || `${a.author}/${a.name}`.localeCompare(`${b.author}/${b.name}`),
  );
  return matched;
}

/** rm -rf the install directory. No-op when not installed. */
export function removeInstall(ref: SharedRef): boolean {
  const dir = sharedProfileDir(ref);
  assertInstallPaths(ref);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  // Prune empty parent directory.
  const parent = dirname(dir);
  try {
    if (readdirSync(parent).length === 0) rmSync(parent, { recursive: true });
  } catch { /* ignore */ }
  return true;
}
