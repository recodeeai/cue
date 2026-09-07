/**
 * cwd-resolver — given a working directory, find the profile cue should use.
 *
 * Resolution precedence (stop at first hit):
 *   1. `opts.override` (matches the --cue-profile CLI flag)
 *   2. `.cue.profile` file walking up from cwd; stops at git repo root or homeDir
 *   3. `<configDir>/repo-defaults.json` keyed by git repo root absolute path
 *   4. `<configDir>/default-profile` (composition list: one profile per line
 *      and/or `+`-joined; composed into a `core+...` selector)
 *   5. none — caller should open the picker
 *
 * Pure: only reads files under cwd and configDir. Never writes.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseDefaultSelector } from "./default-profile";

export type ResolveResult =
  | { source: "flag"; profile: string }
  | { source: "pin-file"; profile: string; pinPath: string }
  | { source: "repo-default"; profile: string }
  | { source: "global-default"; profile: string }
  | { source: "none" };

export interface ResolveOptions {
  cwd: string;
  homeDir: string;
  configDir: string;
  override?: string | null;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function findUpward(startDir: string, fileName: string, stopAt: string): Promise<string | null> {
  let dir = resolve(startDir);
  const stop = resolve(stopAt);
  while (true) {
    const candidate = join(dir, fileName);
    if (await exists(candidate)) return candidate;
    if (dir === stop) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function findGitRoot(startDir: string, stopAt: string): Promise<string | null> {
  let dir = resolve(startDir);
  const stop = resolve(stopAt);
  while (true) {
    if (await exists(join(dir, ".git"))) return dir;
    if (dir === stop) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function resolveProfileForCwd(opts: ResolveOptions): Promise<ResolveResult> {
  if (opts.override) return { source: "flag", profile: opts.override };

  const repoRoot = await findGitRoot(opts.cwd, opts.homeDir);
  const pinPath = await findUpward(opts.cwd, ".cue.profile", repoRoot ?? opts.homeDir);
  if (pinPath) {
    const profile = (await readFile(pinPath, "utf8")).trim();
    if (profile) return { source: "pin-file", profile, pinPath };
  }

  if (repoRoot) {
    const repoDefaultsPath = join(opts.configDir, "repo-defaults.json");
    if (await exists(repoDefaultsPath)) {
      try {
        const map: unknown = JSON.parse(await readFile(repoDefaultsPath, "utf8"));
        if (map !== null && typeof map === "object" && !Array.isArray(map)) {
          const value = (map as Record<string, unknown>)[repoRoot];
          if (typeof value === "string" && value.trim()) {
            return { source: "repo-default", profile: value.trim() };
          }
        }
      } catch { /* malformed repo-defaults.json — skip to the next resolution step */ }
    }
  }

  const defaultPath = join(opts.configDir, "default-profile");
  if (await exists(defaultPath)) {
    const profile = parseDefaultSelector(await readFile(defaultPath, "utf8"));
    if (profile) return { source: "global-default", profile };
  }

  return { source: "none" };
}

/**
 * Config dir for cue, honoring `XDG_CONFIG_HOME`. Mirrors the standalone
 * `configDir()` helpers scattered across commands so the resolver wrapper
 * agrees with them.
 */
function defaultConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), ".config"), "cue");
}

/**
 * Convenience wrapper: resolve the active profile for a cwd and return just
 * the profile selector (e.g. `core+skill-writer`), or `null` when none
 * applies. Commands that only need the name should call this instead of
 * hand-assembling `{ cwd, homeDir, configDir }` and unpacking `.profile` —
 * doing that by hand is what left a dozen callers passing a bare string to
 * `resolveProfileForCwd`.
 */
export async function resolveActiveProfile(
  cwd: string = process.cwd(),
  override?: string | null,
): Promise<string | null> {
  const result = await resolveProfileForCwd({
    cwd,
    homeDir: homedir(),
    configDir: defaultConfigDir(),
    override,
  });
  return result.source === "none" ? null : result.profile;
}
