/**
 * Shared cache helpers for resolver modules (currently only resolver-npx).
 *
 * The on-disk layout is contract-bound (see profiles/_cache/README.md):
 *
 *   <repoRoot>/profiles/_cache/npx/<key>/<skill-name>/SKILL.md
 *
 * Callers compute `<key>` (sha256 of repo + pin) and hand it to:
 *   - cachePath(key)        -> absolute dir path (may or may not exist)
 *   - cacheHit(key)         -> true iff a non-empty cache dir exists
 *   - cachePut(key, srcDir) -> atomic-ish move of an already-prepared
 *                              directory into the cache slot
 *   - cacheEvict(layout)    -> prune LRU entries beyond MAX_CACHE_ENTRIES
 *
 * The cache root is injected so tests can use tmpdir() instead of touching
 * the real profiles/_cache/ tree.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cacheDir } from "./config-paths";

export interface CacheLayout {
  /**
   * Absolute dir that holds the `npx/` cache subtree. When omitted, the cache
   * lives in the XDG cache dir (`~/.cache/cue`) so a globally-installed cue
   * never writes inside its own install directory.
   */
  cacheRoot?: string;
  /**
   * @deprecated Legacy injection point. If set (and `cacheRoot` is not), the
   * cache lives at `<repoRoot>/profiles/_cache/npx/` to preserve the old
   * dev-tree layout. Tests use this; production passes neither.
   */
  repoRoot?: string;
}

const NPX_SUBDIR = "npx";

/** Absolute path to the `npx/` cache root for a given layout. */
function npxRoot(layout: CacheLayout): string {
  if (layout.cacheRoot) return resolve(layout.cacheRoot, NPX_SUBDIR);
  if (layout.repoRoot) return resolve(layout.repoRoot, "profiles", "_cache", NPX_SUBDIR);
  return join(cacheDir(), NPX_SUBDIR);
}

/**
 * Maximum number of cache entries before LRU eviction kicks in.
 *
 * Sizing: a slot is one repo+pin's skill dirs — ~512 KB measured across a real
 * cache — so this cap is roughly 100 MB. It must comfortably exceed the entry
 * count of the largest single profile (the bundled `ego-lite-stack` needs 41),
 * or that profile re-fetches on every launch. `protect` below is the hard
 * guarantee; this number is the budget.
 */
export const MAX_CACHE_ENTRIES = 200;

/** Effective cap: CUE_NPX_CACHE_MAX overrides the default (min 1). */
export function cacheMaxEntries(): number {
  const raw = Number(process.env.CUE_NPX_CACHE_MAX);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return MAX_CACHE_ENTRIES;
}

/**
 * Resolve the absolute cache dir for a given key. Does NOT create it.
 *
 * `key` must be a hex sha256 — callers compute it via crypto.createHash so
 * we keep cache.ts hash-agnostic and reusable for non-npx caches later.
 */
export function cachePath(layout: CacheLayout, key: string): string {
  if (!key || key.includes("/") || key.includes("..")) {
    throw new Error(`cache: invalid key ${JSON.stringify(key)}`);
  }
  return join(npxRoot(layout), key);
}

/**
 * True iff the cache dir for `key` exists AND contains at least one entry.
 * An empty dir is treated as a miss — half-populated caches are corruption,
 * not hits.
 */
export function cacheHit(layout: CacheLayout, key: string): boolean {
  const dir = cachePath(layout, key);
  if (!existsSync(dir)) return false;
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) return false;
    const entries = readdirSync(dir);
    if (entries.length === 0) return false;
    // Touch atime to mark as recently used (LRU tracking).
    try { utimesSync(dir, new Date(), st.mtime); } catch {}
    return true;
  } catch {
    return false;
  }
}

/**
 * Move an already-prepared directory at `srcDir` into the cache slot for
 * `key`. If the slot already exists, it's replaced. Cross-device safe in
 * the common case (same FS) — we rely on rename within the repo tree.
 *
 * Callers should populate `srcDir` in a temp directory first, then call
 * cachePut to publish atomically. Never write directly into cachePath().
 */
export function cachePut(
  layout: CacheLayout,
  key: string,
  srcDir: string,
  protect: ReadonlySet<string> = new Set(),
): string {
  if (!existsSync(srcDir)) {
    throw new Error(`cache: source dir does not exist: ${srcDir}`);
  }
  const dest = cachePath(layout, key);
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }
  renameSync(srcDir, dest);
  // Evict oldest entries if over budget, but never the slot just written nor
  // anything the caller is still resolving — see cacheEvict.
  cacheEvict(layout, cacheMaxEntries(), new Set([...protect, key]));
  return dest;
}

/**
 * Internal helper: list children of a cache slot. Used by resolver-npx to
 * detect partial / corrupt caches without re-implementing path math.
 */
export function cacheChildren(layout: CacheLayout, key: string): string[] {
  const dir = cachePath(layout, key);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Convenience: full path to a single skill inside a cache slot. */
export function cacheSkillPath(layout: CacheLayout, key: string, skill: string): string {
  return join(cachePath(layout, key), skill);
}

/**
 * LRU eviction: remove the least-recently-accessed entries when the cache
 * exceeds MAX_CACHE_ENTRIES. Uses directory atime (updated on cacheHit).
 * Non-fatal — eviction errors are silently ignored.
 *
 * `protect` is a correctness guarantee, not a hint. Eviction runs from inside
 * cachePut, i.e. WHILE a profile is being resolved, and the slots it just
 * populated are the least-recently-used ones in the cache. Without protection a
 * profile with more entries than the cap evicts its own fresh slots as it goes:
 * it never converges (every launch re-fetches) and the resolver hands the
 * materializer source paths that no longer exist. A protected cache may
 * therefore exceed maxEntries — a temporarily oversized cache is strictly
 * better than an incoherent one, and the next eviction with a smaller
 * protected set trims it back.
 */
export function cacheEvict(
  layout: CacheLayout,
  maxEntries = cacheMaxEntries(),
  protect: ReadonlySet<string> = new Set(),
): number {
  const cacheRoot = npxRoot(layout);
  if (!existsSync(cacheRoot)) return 0;

  let entries: { name: string; atime: number }[];
  try {
    entries = readdirSync(cacheRoot)
      .map((name) => {
        try {
          const st = statSync(join(cacheRoot, name));
          return st.isDirectory() ? { name, atime: st.atimeMs } : null;
        } catch { return null; }
      })
      .filter((e): e is { name: string; atime: number } => e !== null);
  } catch { return 0; }

  if (entries.length <= maxEntries) return 0;

  // Sort by atime ascending (oldest first), remove excess — skipping protected
  // slots, which stay regardless of age.
  entries.sort((a, b) => a.atime - b.atime);
  const evictable = entries.filter((e) => !protect.has(e.name));
  const overBudget = entries.length - maxEntries;
  const toRemove = evictable.slice(0, Math.min(overBudget, evictable.length));
  let removed = 0;
  for (const entry of toRemove) {
    try {
      rmSync(join(cacheRoot, entry.name), { recursive: true, force: true });
      removed++;
    } catch {}
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Negative cache: remembered fetch failures
// ---------------------------------------------------------------------------
//
// A remote skill repo that cannot be fetched is not a one-off cost: without a
// memory of the failure, EVERY launch pays the full retry budget again (three
// 45s `npx skills add` attempts = >2 minutes of dead time before the launch
// degrades to the cache and proceeds). Marking the failure lets the next launch
// skip straight to the degraded path, and the cooldown makes the retry happen
// on its own once the transient cause is plausibly gone.
//
// Markers live beside the cache slots (never inside `npx/`, which cacheEvict
// walks) and hold only a timestamp and a reason string.

const NPX_FAILURE_SUBDIR = "npx-failed";

/** How long a remembered fetch failure suppresses the next attempt. */
export const NPX_FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** A remembered failure for one cache key. */
export interface FetchFailureMark {
  /** Epoch ms of the failed attempt. */
  at: number;
  /** Short human-readable reason, replayed in the degraded-launch message. */
  reason: string;
  /**
   * Consecutive failed attempts, counting the one this mark records.
   *
   * Lets the caller back off further each time: a repo that is merely having a
   * bad afternoon is retried soon, while one that is permanently gone (renamed,
   * deleted, too big to ever clone in budget) stops costing a stall every
   * cooldown. Reset by clearFetchFailure on the first success.
   */
  strikes: number;
  /**
   * The skills that were being requested when it failed, unioned across
   * attempts.
   *
   * The cache key is only (repo, pin), but a failure is not always about the
   * repo: asking for a skill that does not exist there fails too. Without this,
   * one bad skill name would suppress every OTHER skill from the same repo —
   * including after the name was corrected, and for unrelated profiles — for a
   * whole cooldown. Suppression therefore applies only to a request this set
   * already covers; anything new is evidence we do not have, so it is fetched.
   */
  skills: string[];
}

function failureRoot(layout: CacheLayout): string {
  if (layout.cacheRoot) return resolve(layout.cacheRoot, NPX_FAILURE_SUBDIR);
  if (layout.repoRoot)
    return resolve(layout.repoRoot, "profiles", "_cache", NPX_FAILURE_SUBDIR);
  return join(cacheDir(), NPX_FAILURE_SUBDIR);
}

function failurePath(layout: CacheLayout, key: string): string {
  if (!key || key.includes("/") || key.includes("..")) {
    throw new Error(`cache: invalid key ${JSON.stringify(key)}`);
  }
  return join(failureRoot(layout), `${key}.json`);
}

/**
 * Read the remembered failure for `key`, or null when there is none.
 *
 * Non-fatal by construction: an unreadable or malformed marker reads as "no
 * failure remembered", so a corrupt cache dir can only ever cost an extra
 * fetch attempt — never a launch.
 */
export function readFetchFailure(
  layout: CacheLayout,
  key: string,
): FetchFailureMark | null {
  try {
    const raw = readFileSync(failurePath(layout, key), "utf8");
    const parsed = JSON.parse(raw) as Partial<FetchFailureMark>;
    if (typeof parsed?.at !== "number" || !Number.isFinite(parsed.at)) return null;
    const strikes =
      typeof parsed.strikes === "number" && Number.isFinite(parsed.strikes)
        ? Math.max(1, Math.floor(parsed.strikes))
        : 1; // marker written before strikes existed
    // A marker with no skill list carries no evidence about any specific
    // request, so it suppresses nothing — fail open, never open-ended.
    const skills = Array.isArray(parsed.skills) ? parsed.skills.map(String) : [];
    return {
      at: parsed.at,
      reason: String(parsed.reason ?? "unknown"),
      strikes,
      skills,
    };
  } catch {
    return null;
  }
}

/**
 * Remember that fetching `key` failed, so the next launch can skip it.
 *
 * Strikes accumulate across calls. Because the cooldown suppresses attempts in
 * between, one strike means roughly one elapsed cooldown of continued failure —
 * which is what makes escalating backoff meaningful rather than a count of how
 * often the user happened to launch.
 *
 * `skills` is what was being requested. It is unioned with anything already
 * remembered, so repeated failures widen the set the marker can suppress
 * rather than replacing it.
 */
export function recordFetchFailure(
  layout: CacheLayout,
  key: string,
  reason: string,
  skills: readonly string[] = [],
): void {
  try {
    const path = failurePath(layout, key);
    mkdirSync(dirname(path), { recursive: true });
    const previous = readFetchFailure(layout, key);
    const mark: FetchFailureMark = {
      at: Date.now(),
      reason,
      strikes: (previous?.strikes ?? 0) + 1,
      skills: [...new Set([...(previous?.skills ?? []), ...skills])].sort(),
    };
    writeFileSync(path, JSON.stringify(mark), "utf8");
  } catch {
    // Best-effort: losing the marker only costs the next launch a retry.
  }
}

/** Forget any remembered failure for `key` (the fetch succeeded). */
export function clearFetchFailure(layout: CacheLayout, key: string): void {
  try {
    rmSync(failurePath(layout, key), { force: true });
  } catch {}
}
