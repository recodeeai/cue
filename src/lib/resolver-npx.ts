/**
 * Resolver for `skills.npx` profile entries.
 *
 * Each entry { repo, pin?, skills } expands into one cache slot
 *   <xdgCache>/cue/npx/<sha256(repo + (pin || "HEAD"))>/  (XDG; tests pin via repoRoot)
 * containing one subdir per skill. The resolver returns a LinkPlan[] mapping
 * each cached skill dir into `.claude/skills/<skill>`.
 *
 * Fetching is delegated to injectable functions so tests never shell out to
 * the real `npx`. The production batch fetcher (`npxFetchMany`) executes one
 *   npx skills add <repo> --skill <name...> -a claude-code -y
 * per repo entry, then hands the populated directory to `cachePut`.
 *
 * Network resilience: `npxFetchMany` retries transient failures (DNS, 5xx,
 * resets, timeouts) with exponential backoff, and callers that must not die on
 * a blip pass `tolerateFetchFailure` to degrade to the cached copy instead.
 *
 * Negative cache: a repo that fails to fetch is remembered, so the next launch
 * skips it instead of paying the full retry budget again. The cooldown expires
 * on its own; `CUE_NPX_FORCE=1` ignores it. Only degrading callers (launch)
 * consult it — validation always makes the real call.
 *
 * Environment:
 *   SOUL_OFFLINE=1             →  cache miss is a hard failure (NpxFetchFailed).
 *   CUE_REPO_ROOT              →  override repo root (legacy: SOUL_REPO_ROOT).
 *   CUE_NPX_ATTEMPTS           →  fetch attempts per repo (default 3, max 6).
 *   CUE_NPX_TIMEOUT_MS         →  per-attempt timeout (default 45000).
 *   CUE_NPX_RETRY_COOLDOWN_MS  →  base negative-cache cooldown (default 6h, 0 = off;
 *                                 doubles per consecutive failure, capped at 7d).
 *   CUE_NPX_CACHE_MAX          →  cache slots kept before LRU eviction (default 200).
 *   CUE_NPX_CONCURRENCY        →  repos fetched in parallel (default 4, max 8).
 *   CUE_NPX_FORCE=1            →  ignore the negative cache this run.
 *
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LinkPlan, NpxSkillRef, Profile } from "../../profiles/_types";
import { ProfileError } from "../../profiles/_types";
import {
  cacheChildren,
  cacheHit,
  cachePut,
  cacheSkillPath,
  clearFetchFailure,
  NPX_FAILURE_COOLDOWN_MS,
  readFetchFailure,
  recordFetchFailure,
  type CacheLayout,
  type FetchFailureMark,
} from "./cache";
import { fetchCompanionFiles, detectSkillPath } from "./companion-fetch";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** `npx skills add ...` failed, or `--offline` blocked a needed fetch. */
export class NpxFetchFailed extends ProfileError {
  constructor(
    public repo: string,
    public reason: string,
    public details?: unknown,
  ) {
    super("NPX_FETCH_FAILED", `npx fetch failed for ${repo}: ${reason}`);
  }
}

/** Pin given but the fetched payload doesn't contain the expected skill dir. */
export class PinNotFound extends ProfileError {
  constructor(
    public repo: string,
    public pin: string,
    public skill: string,
  ) {
    super(
      "PIN_NOT_FOUND",
      `skill "${skill}" missing in ${repo}@${pin} after fetch`,
    );
  }
}

/**
 * A fetch was NOT attempted because a recent attempt for the same repo+pin
 * already failed and the cooldown has not elapsed.
 *
 * This is the negative cache doing its job, not a new failure: the caller
 * degrades to the cached copy exactly as it would for a real failure, but pays
 * none of the retry budget. Distinct from NpxFetchFailed so the reporting layer
 * can say "skipped, auto-retry in N" instead of implying a fresh network call.
 */
export class NpxFetchSkipped extends ProfileError {
  constructor(
    public repo: string,
    public mark: FetchFailureMark,
    public retryInMs: number,
  ) {
    super(
      "NPX_FETCH_SKIPPED",
      `npx fetch skipped for ${repo}: ${mark.reason}`,
    );
  }
}

/** Cache slot exists but is incoherent (missing requested skill subdir). */
export class CacheCorrupt extends ProfileError {
  constructor(
    public key: string,
    public missing: string[],
  ) {
    super(
      "CACHE_CORRUPT",
      `cache slot ${key} missing skill(s): ${missing.join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Cache-key scheme
// ---------------------------------------------------------------------------

/**
 * Cache key = sha256(`<repo>` + `<pin || "HEAD">`).
 *
 * Hex digest, 64 chars. Stable across machines so cache hits work in CI.
 * Note: we deliberately do NOT hash the skill name — one (repo, pin) tuple
 * yields one cache slot containing every skill that's been pulled from it.
 */
export function cacheKey(repo: string, pin: string | undefined): string {
  const ref = pin ?? "HEAD";
  return createHash("sha256").update(repo + ref).digest("hex");
}

// ---------------------------------------------------------------------------
// Fetcher contract
// ---------------------------------------------------------------------------

/**
 * Fetch one skill from `repo` (optionally at `pin`) into `destDir`. The
 * resolver always passes an empty, freshly-created `destDir`; the fetcher
 * must leave a directory named `<skill>` under it.
 */
export type NpxFetchFn = (
  repo: string,
  pin: string | undefined,
  skill: string,
  destDir: string,
) => Promise<void>;

/** Fetch multiple skills from one repo checkout in a single CLI invocation. */
export type NpxBatchFetchFn = (
  repo: string,
  pin: string | undefined,
  skills: string[],
  destDir: string,
) => Promise<void>;

/**
 * Does this `npx skills add` failure look like a network blip rather than a
 * real "this repo/skill does not exist"?
 *
 * Transient failures are worth retrying (DNS hiccup, registry 5xx, proxy
 * reset, timeout). Permanent ones are not: retrying a 404 or a private-repo
 * auth error just multiplies the wait before the same message. An unclassified
 * non-zero exit is treated as permanent — the caller degrades rather than
 * fails, so an un-retried blip costs one skill this launch, while retrying
 * every deterministic error costs every launch a multi-second stall.
 */
export function isTransientNpxFailure(res: {
  error?: Error & { code?: string };
  status?: number | null;
  stderr?: string;
}): boolean {
  if (res.error) {
    // npx itself is missing / not executable — retrying never helps.
    const code = res.error.code;
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return false;
    return true; // ETIMEDOUT and friends
  }
  const err = (res.stderr ?? "").toLowerCase();
  // Permanent: the repo or skill simply isn't there. Check first — a 404 body
  // can still mention "fetch"/"network" in a stack trace.
  if (
    /\b404\b|not found|no such (repo|skill)|does not exist|unknown skill|\b(401|403)\b|authentication failed|permission denied|access denied|repository not found/.test(
      err,
    )
  ) {
    return false;
  }
  return /etimedout|econnreset|econnrefused|enotfound|eai_again|epipe|socket hang up|network|fetch failed|timed out|timeout|tls|certificate|proxy|getaddrinfo|\b(429|500|502|503|504)\b|rate limit|temporarily unavailable|registry error/.test(
    err,
  );
}

/** Attempts (not retries): 1 = no retry. CUE_NPX_ATTEMPTS overrides. */
function npxAttempts(): number {
  const raw = Number(process.env.CUE_NPX_ATTEMPTS);
  if (Number.isFinite(raw) && raw >= 1) return Math.min(Math.floor(raw), 6);
  return 3;
}

const NPX_RETRY_BASE_MS = 600;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Production batch fetcher: shells out to `npx skills add ...`.
 *
 * Transient network failures are retried with exponential backoff before the
 * error escapes — a single DNS blip must not fail a launch.
 *
 * Exported so the default resolver can use it; tests inject a mock instead
 * and never reach this code path.
 */
export const npxFetchMany: NpxBatchFetchFn = async (
  repo,
  pin,
  skills,
  destDir,
) => {
  if (skills.length === 0) return;

  const args = [
    "-y",
    "skills@latest",
    "add",
    repo,
    "--skill",
    ...skills,
    "-a",
    "claude-code",
    "-y",
  ];
  if (pin) {
    // Pin format from schema: "git@<sha>" or "tag@<version>".
    // `npx skills add` accepts `--ref <ref>` for both shas and tags.
    const ref = pin.replace(/^git@/, "").replace(/^tag@/, "");
    args.push("--ref", ref);
  }
  // Defense-in-depth: a single wedged `npx skills add` must never hang the
  // whole run. On timeout spawnSync sets res.error (ETIMEDOUT), which maps to
  // NpxFetchFailed below. CUE_NPX_TIMEOUT_MS overrides; a non-positive or
  // non-numeric value (incl. "" → 0, which would DISABLE the timeout) falls
  // back to the 45s default rather than silently defeating the guard.
  const envTimeout = Number(process.env.CUE_NPX_TIMEOUT_MS);
  const npxTimeoutMs = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 45000;

  const attempts = npxAttempts();
  for (let attempt = 1; ; attempt++) {
    const res = spawnSync("npx", args, {
      cwd: destDir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: npxTimeoutMs,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    if (!res.error && res.status === 0) break;

    // Our own timeout kill (SIGKILL after npxTimeoutMs) is a budget verdict,
    // not a network blip: the clone needs more wall time than we allow, and a
    // second and third identical budget will end identically. Retrying costs
    // the user 2x npxTimeoutMs of dead launch for a guaranteed same answer, so
    // a self-inflicted timeout ends the loop immediately. A network ETIMEDOUT
    // reported BY npx (no SIGKILL) stays retryable.
    const selfTimedOut = res.signal === "SIGKILL";
    const last = attempt >= attempts || selfTimedOut;
    if (!last && isTransientNpxFailure(res)) {
      await sleep(NPX_RETRY_BASE_MS * 2 ** (attempt - 1));
      continue;
    }
    const suffix = attempt > 1 ? ` (after ${attempt} attempts)` : "";
    if (res.error) {
      throw new NpxFetchFailed(repo, `${res.error.message}${suffix}`, res.error);
    }
    throw new NpxFetchFailed(repo, `exit ${res.status}${suffix}`, {
      stdout: res.stdout,
      stderr: res.stderr,
    });
  }

  for (const skill of skills) {
    flattenNpxLayout(destDir, skill);
  }

  // Fetch companion files (scripts/, forms.md, reference.md, etc.) so the
  // installed skill is a complete package, not just SKILL.md.
  for (const skill of skills) {
    const skillDir = join(destDir, skill);
    if (existsSync(skillDir) && needsCompanionRecovery(skillDir)) {
      const skillPath = detectSkillPath(repo, skill);
      if (skillPath) {
        fetchCompanionFiles(repo, skillPath, skillDir, { quiet: true });
      }
    }
  }
};

export const npxFetch: NpxFetchFn = async (repo, pin, skill, destDir) => {
  await npxFetchMany(repo, pin, [skill], destDir);
};

/**
 * The `skills` CLI drops fetched skills at `<destDir>/.claude/skills/<skill>/`
 * (it follows Claude Code's runtime layout). Cue's resolver expects a flat
 * `<destDir>/<skill>/` layout — so relocate here. Exported for tests; callers
 * outside this module should not need this.
 */
export function flattenNpxLayout(destDir: string, skill: string): void {
  const fromClaudeLayout = join(destDir, ".claude", "skills", skill);
  const flatTarget = join(destDir, skill);
  if (!existsSync(fromClaudeLayout) || existsSync(flatTarget)) return;

  // Lazy import — avoids node:fs/promises overhead in the cached-fetch path.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  fs.renameSync(fromClaudeLayout, flatTarget);

  // Clean up the now-empty .claude/skills/ scaffold so the staging dir
  // doesn't accumulate cruft when multiple skills are pulled in sequence.
  try {
    const claudeSkills = join(destDir, ".claude", "skills");
    if (existsSync(claudeSkills) && fs.readdirSync(claudeSkills).length === 0) {
      fs.rmSync(claudeSkills, { recursive: true, force: true });
    }
    const claudeDir = join(destDir, ".claude");
    if (existsSync(claudeDir) && fs.readdirSync(claudeDir).length === 0) {
      fs.rmSync(claudeDir, { recursive: true, force: true });
    }
  } catch { /* cleanup is best-effort */ }
}

/**
 * Modern versions of the `skills` CLI copy the complete skill directory.
 * Only fall back to GitHub companion discovery for legacy SKILL.md-only
 * payloads; probing every already-complete skill adds one network round trip
 * per skill to cold profile launches.
 */
export function needsCompanionRecovery(skillDir: string): boolean {
  try {
    return !readdirSync(skillDir).some((entry) => entry !== "SKILL.md");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public resolver
// ---------------------------------------------------------------------------

export interface ResolveNpxOptions {
  /** Legacy: pin the cache under `<repoRoot>/profiles/_cache`. Omit to use the XDG cache (~/.cache/cue). */
  repoRoot?: string;
  /** Fetcher; defaults to the real `npx skills add` shellout. */
  fetch?: NpxFetchFn;
  /** Batch fetcher used by production to resolve one repo in one shellout. */
  fetchMany?: NpxBatchFetchFn;
  /** Override offline flag (defaults to CUE_OFFLINE / SOUL_OFFLINE env). */
  offline?: boolean;
  /**
   * Degrade instead of throwing when an entry can't be fetched.
   *
   * A launch must survive a flaky network: with this set, a repo that fails to
   * fetch contributes whatever it already has in cache (possibly nothing) and
   * lands in `result.failures` for the caller to report. Validation paths
   * (`cue validate`) leave it off — there a fetch failure IS the finding.
   */
  tolerateFetchFailure?: boolean;
  /**
   * Ignore the negative cache and attempt every fetch again right now.
   *
   * Defaults to CUE_NPX_FORCE=1. The escape hatch for "the network is back,
   * stop waiting out the cooldown".
   */
  force?: boolean;
}

/** One repo entry that could not be fully resolved under `tolerateFetchFailure`. */
export interface NpxEntryFailure {
  repo: string;
  pin?: string;
  /** Requested skills that are NOT available (cache had no usable copy). */
  skills: string[];
  /** Requested skills served from an existing (possibly stale) cache slot. */
  servedFromCache: string[];
  error: Error;
  /**
   * True when no fetch was attempted because a recent one already failed.
   * `retryInMs` is the remaining cooldown.
   */
  skipped?: boolean;
  retryInMs?: number;
}

export interface ResolveNpxResult {
  plans: LinkPlan[];
  /** Per-entry cache key — useful for debugging / `cue doctor`. */
  keys: Record<string, string>;
  /** Non-empty only under `tolerateFetchFailure`. */
  failures: NpxEntryFailure[];
}

/**
 * Resolve every `skills.npx` entry on `profile` into a LinkPlan[].
 *
 * Steps per entry:
 *   1. Compute cache key from (repo, pin).
 *   2. If cache hit AND every requested skill subdir exists  → reuse.
 *   3. Cache hit but some skill missing                       → CacheCorrupt
 *      (force a re-fetch into a fresh slot; if `--offline`, fail hard).
 *   4. Cache miss                                             → fetch into
 *      a tmp dir, then cachePut it as the new slot.
 *
 * Returns one LinkPlan per (entry, skill) tuple. Target is fixed at
 * `.claude/skills/<skill>` to match the materializer's expectations.
 */
export async function resolveNpx(
  profile: Profile,
  opts: ResolveNpxOptions = {},
): Promise<LinkPlan[]> {
  const { plans } = await resolveNpxDetailed(profile, opts);
  return plans;
}

/** Same as resolveNpx but also returns the cache keys (handy for doctor/list). */
export async function resolveNpxDetailed(
  profile: Profile,
  opts: ResolveNpxOptions = {},
): Promise<ResolveNpxResult> {
  const entries = profile.skills?.npx ?? [];
  const plans: LinkPlan[] = [];
  const keys: Record<string, string> = {};
  const failures: NpxEntryFailure[] = [];
  if (entries.length === 0) {
    return { plans, keys, failures };
  }

  // Default cache lives in the XDG cache dir (~/.cache/cue), never inside the
  // install tree. Tests/legacy callers may still pin it via opts.repoRoot.
  const layout: CacheLayout = opts.repoRoot ? { repoRoot: opts.repoRoot } : {};
  const fetcher = opts.fetch ?? npxFetch;
  const batchFetcher = opts.fetchMany ?? (opts.fetch ? undefined : npxFetchMany);
  const offline = opts.offline ?? (process.env.CUE_OFFLINE ?? process.env.SOUL_OFFLINE) === "1";
  // The negative cache only guards the degrading caller (launch). Validation
  // paths must always make the real call — there a fetch failure IS the finding,
  // and a remembered one would report stale news.
  const force = opts.force ?? process.env.CUE_NPX_FORCE === "1";
  const suppress: SuppressOptions = {
    enabled: opts.tolerateFetchFailure === true && !force,
    cooldownMs: failureCooldownMs(),
  };

  // Every slot this resolve touches, computed before the first fetch: eviction
  // runs inside cachePut, so without this the loop evicts its own earlier
  // slots whenever a profile has more entries than the cache cap.
  const activeKeys = new Set(entries.map((e) => cacheKey(e.repo, e.pin)));

  for (const entry of entries) {
    keys[entryId(entry)] = cacheKey(entry.repo, entry.pin);
  }

  /** Resolve one entry. Never throws under tolerateFetchFailure. */
  const resolveEntry = async (
    entry: NpxSkillRef,
  ): Promise<{ plans: LinkPlan[]; failure?: NpxEntryFailure }> => {
    const key = cacheKey(entry.repo, entry.pin);
    let usable = entry.skills;
    let failure: NpxEntryFailure | undefined;

    try {
      await ensureCacheForEntry(
        layout,
        key,
        entry,
        fetcher,
        batchFetcher,
        offline,
        suppress,
        activeKeys,
      );
      // Nothing to fetch, or the fetch worked: any remembered failure is stale.
      clearFetchFailure(layout, key);
    } catch (err) {
      if (err instanceof NpxFetchSkipped) {
        // Already remembered; re-recording would slide the cooldown forward
        // forever and the repo would never be retried.
      } else if (!offline) {
        recordFetchFailure(layout, key, failureReason(err), entry.skills);
      }
      // Offline mode throws without attempting anything, so there is nothing to
      // remember: the marker would outlive the offline session and suppress
      // real fetches for a whole cooldown after the network came back.
      if (!opts.tolerateFetchFailure) throw err;
      // Degraded path: serve whatever this cache slot already holds. A warm
      // slot means the offline/flaky launch is indistinguishable from a good
      // one; a cold slot means those skills are simply absent this run.
      usable = cachedSkills(layout, key, entry.skills);
      failure = {
        repo: entry.repo,
        pin: entry.pin,
        skills: entry.skills.filter((s) => !usable.includes(s)),
        servedFromCache: usable,
        error: err as Error,
        ...(err instanceof NpxFetchSkipped
          ? { skipped: true, retryInMs: err.retryInMs }
          : {}),
      };
    }

    return {
      plans: usable.map((skill) => ({
        source: cacheSkillPath(layout, key, skill),
        target: `.claude/skills/${skill}`,
        origin: "npx" as const,
      })),
      failure,
    };
  };

  // Entries are independent network fetches, so they run concurrently — a cold
  // profile is bounded by its slowest repo instead of the sum of all of them
  // (the bundled ego-lite-stack has 41). The limit is small on purpose: each
  // task is a full `npx skills add` with its own git clone, so an unbounded
  // fan-out trades launch latency for disk and registry pressure.
  //
  // Results are collected by index and flattened afterwards, so plan order
  // stays the profile's declaration order no matter how the tasks interleave.
  const results = new Array<{ plans: LinkPlan[]; failure?: NpxEntryFailure }>(
    entries.length,
  );
  let cursor = 0;
  // Only the non-tolerating path (cue validate) throws out of resolveEntry, and
  // there the first failure aborts the resolve. Letting that rejection escape
  // Promise.all directly would leave the other lanes fetching and writing to
  // the cache after the caller had already moved on to error handling — so the
  // error is captured, the remaining lanes stop pulling work, and every lane is
  // awaited before it propagates.
  let aborted = false;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (aborted) return;
      const i = cursor++;
      const entry = entries[i];
      if (entry === undefined) return;
      try {
        results[i] = await resolveEntry(entry);
      } catch (err) {
        if (!aborted) {
          aborted = true;
          firstError = err;
        }
        return;
      }
    }
  };
  const lanes = Math.min(fetchConcurrency(), entries.length);
  await Promise.all(Array.from({ length: lanes }, () => worker()));
  if (aborted) throw firstError;

  for (const result of results) {
    plans.push(...result.plans);
    if (result.failure) failures.push(result.failure);
  }

  return { plans, keys, failures };
}

/** Subset of `skills` that is present and non-empty in the cache slot `key`. */
function cachedSkills(
  layout: CacheLayout,
  key: string,
  skills: string[],
): string[] {
  if (!cacheHit(layout, key)) return [];
  const present = new Set(cacheChildren(layout, key));
  return skills.filter(
    (s) => present.has(s) && isNonEmptyDir(cacheSkillPath(layout, key, s)),
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function ensureCacheForEntry(
  layout: CacheLayout,
  key: string,
  entry: NpxSkillRef,
  fetcher: NpxFetchFn,
  batchFetcher: NpxBatchFetchFn | undefined,
  offline: boolean,
  suppress: SuppressOptions = { enabled: false, cooldownMs: 0 },
  protect: ReadonlySet<string> = new Set(),
): Promise<void> {
  if (cacheHit(layout, key)) {
    const present = new Set(cacheChildren(layout, key));
    const missing = entry.skills.filter((s) => !present.has(s) || !isNonEmptyDir(cacheSkillPath(layout, key, s)));
    if (missing.length === 0) {
      return; // full hit
    }
    // Partial hit: detectable corruption. In offline mode this is fatal.
    if (offline) {
      throw new CacheCorrupt(key, missing);
    }
    // Otherwise, fall through to re-populate the missing skills.
    assertNotCoolingDown(layout, key, entry, suppress);
    await fetchInto(layout, key, entry, missing, fetcher, batchFetcher, protect);
    return;
  }

  // Total miss.
  if (offline) {
    throw new NpxFetchFailed(
      entry.repo,
      `cache miss for key ${key} and SOUL_OFFLINE=1`,
    );
  }
  assertNotCoolingDown(layout, key, entry, suppress);
  await fetchInto(layout, key, entry, entry.skills, fetcher, batchFetcher, protect);
}

/** Cooldown policy handed down to ensureCacheForEntry. */
interface SuppressOptions {
  enabled: boolean;
  cooldownMs: number;
}

/** Concurrent repo fetches. CUE_NPX_CONCURRENCY overrides (1 = serial, max 8). */
function fetchConcurrency(): number {
  const raw = Number(process.env.CUE_NPX_CONCURRENCY);
  if (Number.isFinite(raw) && raw >= 1) return Math.min(Math.floor(raw), 8);
  return 4;
}

/** Base cooldown. CUE_NPX_RETRY_COOLDOWN_MS overrides; 0 disables entirely. */
function failureCooldownMs(): number {
  const raw = Number(process.env.CUE_NPX_RETRY_COOLDOWN_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return NPX_FAILURE_COOLDOWN_MS;
}

/** Ceiling for the escalated cooldown — a week without a retry is enough. */
const MAX_FAILURE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Cooldown after `strikes` consecutive failures: base, then double each time.
 *
 * A repo having a bad afternoon is retried within the base window; one that is
 * permanently gone (renamed, deleted, or simply too large to ever clone inside
 * the timeout) stops costing a stall every cooldown. The ceiling keeps a
 * recovered repo from being written off forever, and any explicit retry —
 * CUE_NPX_FORCE=1, or `cue validate`, which never consults the marker — is
 * unaffected by how high the count has climbed.
 */
function escalatedCooldownMs(base: number, strikes: number): number {
  if (base <= 0) return 0;
  const factor = 2 ** Math.max(0, Math.min(strikes - 1, 20));
  return Math.min(base * factor, MAX_FAILURE_COOLDOWN_MS);
}

/**
 * How much longer `mark` suppresses a fetch — 0 when nothing is suppressed.
 *
 * The single source of truth for "is this repo still cooling down?". A marker
 * outlives its own cooldown (nothing sweeps it until the next attempt), so its
 * mere existence proves nothing; anything that reports a cooldown to a human
 * must ask this instead, or it will claim a repo is suppressed when the next
 * launch would in fact retry it.
 *
 * Returns 0 for an expired cooldown, for a disabled one (base 0), and for a
 * future-dated marker — clock skew or a restored backup is not evidence.
 */
export function remainingCooldownMs(
  mark: FetchFailureMark,
  base: number = failureCooldownMs(),
  now: number = Date.now(),
): number {
  const cooldown = escalatedCooldownMs(base, mark.strikes);
  if (cooldown <= 0) return 0;
  const elapsed = now - mark.at;
  if (elapsed < 0 || elapsed >= cooldown) return 0;
  return cooldown - elapsed;
}

/**
 * Throw NpxFetchSkipped when a recent attempt for this cache key already
 * failed. Called only where a network fetch is genuinely about to happen, so a
 * warm cache slot is never withheld because of an old marker.
 */
function assertNotCoolingDown(
  layout: CacheLayout,
  key: string,
  entry: NpxSkillRef,
  suppress: SuppressOptions,
): void {
  if (!suppress.enabled) return;
  const mark = readFetchFailure(layout, key);
  if (!mark) return;
  // The key is (repo, pin), but the failure may have been about one skill —
  // a name that does not exist in that repo. Suppress only a request the
  // remembered failure already covers; a skill we have never seen fail is
  // evidence we do not have, so fetch it and find out.
  const covered = new Set(mark.skills);
  if (!entry.skills.every((skill) => covered.has(skill))) return;
  const remaining = remainingCooldownMs(mark, suppress.cooldownMs);
  if (remaining <= 0) return;
  throw new NpxFetchSkipped(entry.repo, mark, remaining);
}

/** Compact reason string for a marker — the raw message minus our own prefix. */
function failureReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^npx fetch failed for \S+: /, "").slice(0, 300);
}

async function fetchInto(
  layout: CacheLayout,
  key: string,
  entry: NpxSkillRef,
  skills: string[],
  fetcher: NpxFetchFn,
  batchFetcher?: NpxBatchFetchFn,
  protect: ReadonlySet<string> = new Set(),
): Promise<void> {
  // Stage into a tmp dir, then publish via cachePut (atomic-ish rename).
  // If the slot already exists (partial-hit repair), we merge skill subdirs
  // into the existing slot rather than nuking it; this keeps already-good
  // skills warm.
  const staging = mkdtempSync(join(tmpdir(), "cue-npx-"));
  try {
    if (batchFetcher) {
      await batchFetcher(entry.repo, entry.pin, skills, staging);
    } else {
      for (const skill of skills) {
        await fetcher(entry.repo, entry.pin, skill, staging);
      }
    }
    for (const skill of skills) {
      const produced = join(staging, skill);
      if (!isNonEmptyDir(produced)) {
        throw new PinNotFound(entry.repo, entry.pin ?? "HEAD", skill);
      }
    }

    if (cacheHit(layout, key)) {
      // Partial-repair path: move skills one at a time into existing slot.
      for (const skill of skills) {
        const src = join(staging, skill);
        const dest = cacheSkillPath(layout, key, skill);
        if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
        // renameSync within tmp -> repo can fail across FS; fall back to copy.
        try {
          // We deliberately import only on demand to avoid a top-level cycle.
          const { renameSync } = await import("node:fs");
          renameSync(src, dest);
        } catch {
          const { cpSync } = await import("node:fs");
          cpSync(src, dest, { recursive: true });
          rmSync(src, { recursive: true, force: true });
        }
      }
    } else {
      cachePut(layout, key, staging, protect);
      return; // staging was consumed by rename inside cachePut
    }
  } finally {
    // Best-effort cleanup; cachePut may have already renamed `staging` away.
    if (existsSync(staging)) {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

function isNonEmptyDir(p: string): boolean {
  try {
    if (!existsSync(p)) return false;
    const st = statSync(p);
    if (!st.isDirectory()) return false;
    return readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

function entryId(e: NpxSkillRef): string {
  return `${e.repo}@${e.pin ?? "HEAD"}`;
}

// Re-export cachePath for callers that want to print the slot for debugging.
export { cachePath } from "./cache";
