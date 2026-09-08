/**
 * runtime-materializer — produce a per-profile config dir under
 *   ~/.config/cue/runtime/<profile>/{claude,codex}/
 * with content-hash short-circuit and atomic swap.
 *
 * Pure surface; callers inject filesystem and registry dependencies so this
 * module can be tested without touching ~/.claude or ~/.codex.
 */

import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import {
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
  readFile,
  mkdtemp,
  readdir,
  lstat,
} from "node:fs/promises";
import {
  dirname,
  join,
  resolve as resolvePath,
  basename,
  isAbsolute,
} from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AgentKind,
  CodexProfileConfig,
  ResolvedProfile,
} from "../../profiles/_types";
import { buildCodexConfigToml, extractRuntimeCodexState } from "./codex-config";
import { reconcileCodexHooks } from "./codex-hooks";
import { normalizeUvxGitServers } from "./uvx-installer";
import { evaluateCondition } from "./conditional-skills";
import {
  hasWorkspaces,
  getActiveWorkspace,
  computeOverrides,
} from "./workspaces";
import {
  parseSkillFromDir,
  renderRouter,
  type ParsedSkill,
} from "./skill-router";
import { CODEX_BRIEF_POINTER } from "./project-brief";

const REPO_ROOT = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const RESOURCES_RULES = join(REPO_ROOT, "resources", "rules");
const RESOURCES_COMMANDS = join(REPO_ROOT, "resources", "commands");
const RESOURCES_SUBAGENTS = join(REPO_ROOT, "resources", "subagents");
const RESOURCES_HOOKS = join(REPO_ROOT, "resources", "hooks");
const RESOURCES_PLAYBOOKS = join(REPO_ROOT, "resources", "playbooks");
const RESOURCES_QUALITY_GATES = join(REPO_ROOT, "resources", "quality-gates");
const RESOURCES_PERSONAS = join(REPO_ROOT, "resources", "personas");

/** Char count past which Claude Code warns about (and is slowed by) a memory file. */
const MEMORY_FILE_WARN_CHARS = 40_000;
const RUNTIME_KEY_MAX_BYTES = 120;

/**
 * Keep a logical profile/composite key usable as one filesystem component.
 * Short keys stay unchanged; oversized keys retain a readable prefix plus a
 * stable hash so distinct composites cannot collapse onto the same runtime.
 */
export function runtimePathKey(runtimeKey: string): string {
  if (Buffer.byteLength(runtimeKey, "utf8") <= RUNTIME_KEY_MAX_BYTES) {
    return runtimeKey;
  }

  const suffix = `~${createHash("sha256").update(runtimeKey).digest("hex").slice(0, 16)}`;
  const prefixBudget = RUNTIME_KEY_MAX_BYTES - Buffer.byteLength(suffix, "utf8");
  let prefix = "";
  let prefixBytes = 0;
  for (const char of runtimeKey) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (prefixBytes + charBytes > prefixBudget) break;
    prefix += char;
    prefixBytes += charBytes;
  }
  return `${prefix}${suffix}`;
}

function resolveResourcePath(ref: string, base: string): string {
  return isAbsolute(ref) ? ref : join(base, ref);
}

/** MCP server configuration as stored in the registry. */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface MaterializeInput {
  profile: ResolvedProfile;
  agent: AgentKind;
  runtimeRoot: string;
  /** Runtime dir key — defaults to `profile.name`. Set to `<profile>@<accountTag>`
   *  so two authmux parallel accounts sharing a cue profile get isolated runtimes
   *  (separate `.credentials.json`/`.claude.json`) instead of collapsing into one
   *  Anthropic login. Only the physical runtime path changes; profile identity is
   *  still `profile.name`. */
  runtimeKey?: string;
  /** Map skill id → source dir on disk (caller resolves local/npx/plugin paths). */
  skillSourceLookup: (id: string) => Promise<string>;
  /** Pre-resolved sanitized MCP registry for this agent. */
  mcpRegistry: Record<string, McpServerConfig>;
  /** Content of ~/.claude/CLAUDE.md (or ~/.codex/AGENTS.md) to append. */
  userClaudeMd: string;
  /** Directory to copy .credentials.json from (e.g. a pre-set CLAUDE_CONFIG_DIR). */
  credentialsSource?: string;
  /** Codex only: path to the base `config.toml` (normally ~/.codex/config.toml)
   *  whose top-level keys, `[features]`, and `[[skills.config]]` the runtime
   *  config inherits. cue redirects CODEX_HOME at the runtime, so without this
   *  the session loses user configuration. Omit to inherit nothing (what tests do). */
  codexBaseConfig?: string;
  /** Codex only: user/repo skill files that bypass `$CODEX_HOME/skills` and
   *  must be disabled so the cue profile remains the source of truth. */
  codexExternalSkillPaths?: string[];
  /** Lazy-MCP: ids the launcher disabled — removed from the runtime .claude.json
   *  even though the rebuild preserves the old file. Profile.mcps is already
   *  pruned to the kept set; this just evicts the stale keys. */
  disabledMcpIds?: string[];
  /** Test seam for loopback proxy health; production defaults to the HTTP probe. */
  proxyHealthCheck?: (url: string) => Promise<boolean>;
}

export interface MaterializeOutput {
  runtimeDir: string;
  rebuilt: boolean;
  hash: string;
}

function agentSubdir(agent: AgentKind): string {
  return agent === "claude-code" ? "claude" : "codex";
}

/** Directory profiles are read from (CUE_PROFILES_DIR override → repo profiles/).
 * Read lazily so tests can point it at a temp dir. */
function profilesDir(): string {
  return process.env.CUE_PROFILES_DIR ?? join(REPO_ROOT, "profiles");
}

/**
 * Staleness predicate shared with `cue doctor`'s D5 check: a materialized
 * runtime is stale when the profile's source `profile.yaml` OR any resolved
 * skill's `SKILL.md` was modified more recently than the stored `.cue-hash`.
 * Mirror, not duplicate — doctor reports it, launch acts on it (auto-rebuild).
 *
 * The SKILL.md check makes "edit a skill → relaunch → see the change" work:
 * the materialized runtime's own `skills/<slug>` entries are symlinks to the
 * source skill dirs, so lstat'ing `skills/<slug>/SKILL.md` resolves through to
 * the real source file's mtime (only the final path component is treated
 * specially by lstat, and SKILL.md is never itself a symlink). This is
 * automatically scoped to the agent and to any conditional/subset pruning.
 *
 * Returns false when there's no runtime yet (no `.cue-hash`): the content-hash
 * path in materializeRuntime handles a fresh build. Fail-open per entry — a
 * deleted skill source (broken symlink) is skipped, not fatal (the profile.yaml
 * edit that removed it already trips the yaml branch).
 */
export async function isRuntimeStale(
  profileName: string,
  agent: AgentKind,
  runtimeRoot: string,
  runtimeKey: string = profileName,
): Promise<boolean> {
  const runtimeDir = join(
    runtimeRoot,
    runtimePathKey(runtimeKey),
    agentSubdir(agent),
  );
  const hashFile = join(runtimeDir, ".cue-hash");
  let hashMtime: number;
  try {
    hashMtime = (await lstat(hashFile)).mtimeMs;
  } catch {
    return false; // no runtime yet — materializeRuntime's content hash handles it
  }

  // (a) Source profile.yaml newer than the hash. Its own try/catch so a missing
  //     yaml doesn't short-circuit the skill check below.
  try {
    if (
      (await lstat(join(profilesDir(), profileName, "profile.yaml"))).mtimeMs >
      hashMtime
    ) {
      return true;
    }
  } catch {
    /* no source yaml — fall through to the skill check */
  }

  // (b) Any resolved SKILL.md newer than the hash.
  const skillsDir = join(runtimeDir, "skills");
  let slugs: string[];
  try {
    slugs = await readdir(skillsDir);
  } catch {
    return false; // no skills/ dir → nothing more to compare
  }
  for (const slug of slugs) {
    try {
      if ((await lstat(join(skillsDir, slug, "SKILL.md"))).mtimeMs > hashMtime)
        return true;
    } catch {
      /* broken symlink / no SKILL.md under this slug — skip */
    }
  }
  return false;
}

function appliesToAgent(
  scoped: { agents?: AgentKind[] },
  agent: AgentKind,
): boolean {
  if (!scoped.agents || scoped.agents.length === 0) return true;
  return scoped.agents.includes(agent);
}

function sortedJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(sortedJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + sortedJson(obj[k])).join(",") +
    "}"
  );
}

// Bump when the on-disk runtime layout changes in a way the profile content
// doesn't capture (e.g. flat vs nested skills, new manifest files). Folding it
// into the hash forces every profile to rebuild once on its next launch, so
// layout fixes roll out without a manual `--rematerialize` per profile.
//   v2: flat skill layout + .cue-skills manifest (was nested <category>/<slug>)
//   v3: slimmer CLAUDE.md — drop the duplicate ~/.claude/CLAUDE.md append and
//       default-off the per-session telemetry sections (#65). The generated
//       content shrank but no profile field changed, so without this bump every
//       already-materialized runtime would keep serving its cached 37KB file.
//   v4: Codex config.toml inherits the base config's top-level keys +
//       [features] (reasoning effort, context window, auto-compact). Same
//       situation — generated content changed, no profile field did.
//   v5: Codex profile hooks share hooks.json with installed runtime hooks.
//   v6: Retain runtime approvals, track hook ownership, deduplicate instructions.
const MATERIALIZER_VERSION = 6;

function computeHash(
  profile: ResolvedProfile,
  agent: AgentKind,
  extra = "",
): string {
  const canonical = sortedJson({
    v: MATERIALIZER_VERSION,
    agent,
    profile,
    extra,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

async function readPersonaIncludes(profile: ResolvedProfile): Promise<string> {
  const refs = profile.personaIncludes ?? [];
  let text = "";
  const included = new Set<string>();
  for (const ref of refs) {
    const path = isAbsolute(ref)
      ? ref
      : join(RESOURCES_PERSONAS, ref.endsWith(".md") ? ref : `${ref}.md`);
    try {
      const content = (await readFile(path, "utf8")).trim();
      if (content && !included.has(content)) {
        included.add(content);
        text += content + "\n\n";
      }
    } catch {
      // Missing snippet — skip silently; cue validate will surface it.
    }
  }
  return text;
}

function effectiveCodexOverrides(
  profile: ResolvedProfile,
): CodexProfileConfig | undefined {
  const legacy =
    (profile as { codexConfig?: Record<string, unknown> }).codexConfig ?? {};
  const current = (profile as { codex?: CodexProfileConfig }).codex ?? {};
  if (Object.keys(legacy).length === 0 && Object.keys(current).length === 0) {
    return undefined;
  }
  const merged: Record<string, unknown> = { ...legacy, ...current };
  const legacyFeatures = isRecord(legacy.features) ? legacy.features : {};
  const currentFeatures = isRecord(current.features) ? current.features : {};
  if (
    Object.keys(legacyFeatures).length > 0 ||
    Object.keys(currentFeatures).length > 0
  ) {
    merged.features = { ...legacyFeatures, ...currentFeatures };
  }
  return merged as CodexProfileConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether to emit the per-session telemetry sections — `## Skill Usage`,
 * `## Last Session`, `## Common Workflows` — into the materialized memory file.
 *
 * Default OFF. These are usage-analytics / warm-start blocks: they change every
 * time analytics or the last session change, cost ~0.6KB on a heavy profile, and
 * carry no triggering signal (a skill's `description` is what makes it fire, not
 * a hit count). The capability table and `## Available Skills` already name every
 * skill, so dropping these loses no trigger surface — only volatile noise.
 *
 * Opt back in with `CUE_SESSION_TELEMETRY=1|true` (mirrors the file's other
 * default-off knobs like `CUE_TRIGGER_PHRASES`).
 */
export function shouldIncludeSessionTelemetry(
  env: Record<string, string | undefined>,
): boolean {
  return (
    env.CUE_SESSION_TELEMETRY === "1" || env.CUE_SESSION_TELEMETRY === "true"
  );
}

const MATERIALIZE_LOCK_STALE_MS = 600_000;
const MATERIALIZE_LOCK_WAIT_MS = 30_000;

async function withMaterializeLock<T>(
  runtimeDir: string,
  action: () => Promise<T>,
): Promise<T> {
  const lockDir = `${runtimeDir}.lock`;
  const ownerFile = join(lockDir, "owner.json");
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + MATERIALIZE_LOCK_WAIT_MS;
  await mkdir(dirname(runtimeDir), { recursive: true });

  while (true) {
    let created = false;
    try {
      await mkdir(lockDir);
      created = true;
      await writeFile(ownerFile, JSON.stringify({ pid: process.pid, token }));
      break;
    } catch (error) {
      if (created) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const age = Date.now() - (await lstat(lockDir)).mtimeMs;
        const owner = JSON.parse(await readFile(ownerFile, "utf8")) as {
          pid?: number;
        };
        let ownerAlive = typeof owner.pid === "number";
        if (ownerAlive) {
          try {
            process.kill(owner.pid!, 0);
          } catch (probeError) {
            ownerAlive = (probeError as NodeJS.ErrnoException).code === "EPERM";
          }
        }
        if (!ownerAlive && age > 1_000) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        try {
          const age = Date.now() - (await lstat(lockDir)).mtimeMs;
          if (age > MATERIALIZE_LOCK_STALE_MS) {
            await rm(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          /* lock disappeared between checks */
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for runtime materialization lock: ${lockDir}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await action();
  } finally {
    try {
      const owner = JSON.parse(await readFile(ownerFile, "utf8")) as {
        token?: string;
      };
      if (owner.token === token)
        await rm(lockDir, { recursive: true, force: true });
    } catch {
      /* a stale-lock recovery already replaced or removed this lock */
    }
  }
}

export async function materializeRuntime(
  input: MaterializeInput,
): Promise<MaterializeOutput> {
  const runtimeDir = join(
    input.runtimeRoot,
    runtimePathKey(input.runtimeKey ?? input.profile.name),
    agentSubdir(input.agent),
  );
  return withMaterializeLock(runtimeDir, () =>
    materializeRuntimeUnlocked(input),
  );
}

async function materializeRuntimeUnlocked(
  input: MaterializeInput,
): Promise<MaterializeOutput> {
  const { profile, agent, runtimeRoot } = input;
  const runtimeDir = join(
    runtimeRoot,
    runtimePathKey(input.runtimeKey ?? profile.name),
    agentSubdir(agent),
  );

  // Normalize any `uvx --from git+<repo> <bin>` MCP entries: install the
  // package locally with `uv tool install` and rewrite the entry to call the
  // installed binary. Sidesteps both the MCP-startup cold-download race and
  // the auto-mode classifier's "fetch arbitrary code from URL" block.
  // Idempotent — re-runs detect an existing binary and just rewrite.
  const { normalized: normalizedRegistry, report: uvxReport } =
    normalizeUvxGitServers(input.mcpRegistry);
  const effectiveInput: MaterializeInput = {
    ...input,
    mcpRegistry: normalizedRegistry,
  };
  if (uvxReport.installed.length > 0) {
    process.stderr.write(
      `[cue] installed uvx MCPs: ${uvxReport.installed.join(", ")}\n`,
    );
  }

  // The base Codex config is part of this runtime's content, so it belongs in
  // the hash: edit ~/.codex/config.toml and the next launch must rebuild rather
  // than keep serving a config.toml with the previous knobs.
  const codexBaseText =
    agent === "codex" && effectiveInput.codexBaseConfig
      ? await readFile(effectiveInput.codexBaseConfig, "utf8").catch(() => "")
      : "";
  const codexSkillScopeText =
    agent === "codex" && effectiveInput.codexExternalSkillPaths
      ? JSON.stringify([...effectiveInput.codexExternalSkillPaths].sort())
      : "";
  // Collect profile MCP entries once. Codex embeds these in config.toml, so the
  // effective registry must participate in its runtime hash: installing or
  // removing a command must rebuild the file instead of retaining stale MCPs.
  const mcpServers = collectProfileMcps(
    profile,
    agent,
    effectiveInput.mcpRegistry,
  );
  const codexMcpText = agent === "codex" ? sortedJson(mcpServers) : "";
  // Included persona bodies are generated into CLAUDE.md / AGENTS.md, so their
  // source text must participate in the content hash. Otherwise editing a
  // shared policy leaves already-materialized runtimes stale indefinitely.
  const personaIncludesText = await readPersonaIncludes(profile);
  const hash = computeHash(
    profile,
    agent,
    `${codexBaseText}\n${codexSkillScopeText}\n${codexMcpText}\n${personaIncludesText}`,
  );

  // Short-circuit if hash matches.
  try {
    const existing = (
      await readFile(join(runtimeDir, ".cue-hash"), "utf8")
    ).trim();
    if (existing === hash) {
      // Refresh state from credentialsSource even on cache hit so account
      // switches and newly-added source entries are reflected.
      if (effectiveInput.credentialsSource) {
        // Re-merge settings.json from current credentialsSource.
        if (agent === "claude-code") {
          const merged = await buildClaudeSettings(
            profile,
            agent,
            effectiveInput,
            runtimeDir,
          );
          await writeFile(join(runtimeDir, "settings.json"), merged + "\n");
        }
        // Re-overlay any source entries that aren't already present (e.g.
        // user added a new sessions/ entry, plugins/, etc.).
        await overlaySourceState(runtimeDir, effectiveInput.credentialsSource);
        // Pre-seed the plugin cache so enabled-plugin hooks find their version
        // dir immediately (avoids the "Plugin directory does not exist" race).
        if (!sameResolvedPath(runtimeDir, effectiveInput.credentialsSource)) {
          await linkPluginCache(runtimeDir, effectiveInput.credentialsSource);
        }
      }
      if (agent === "claude-code") {
        await syncMcpsIntoClaudeJson(
          runtimeDir,
          mcpServers,
          effectiveInput.disabledMcpIds,
        );
      }
      return { runtimeDir, rebuilt: false, hash };
    }
  } catch {
    /* not present — fall through to build */
  }

  // Build in a sibling tmp dir, atomic-swap at the end.
  await mkdir(dirname(runtimeDir), { recursive: true });
  const tmpDir = await mkdtemp(`${runtimeDir}.tmp.`);

  // 1. Skills — missing refs are warned + skipped, not fatal. A profile that
  // lists 20 skills and has 1 broken ref shouldn't crash the entire launch.
  // `cue debug` and `cue validate` surface the broken ref clearly so the user
  // can fix it. Behavior matches `cue debug`'s tolerance.
  const skillsDir = join(tmpDir, "skills");
  await mkdir(skillsDir, { recursive: true });
  const skippedSkills: string[] = [];
  let attemptedSkills = 0;
  // Skills are linked FLAT — skills/<slug>, not skills/<category>/<slug>.
  // Claude Code (and Codex) only register a personal skill one level deep, by
  // its directory name (skills/<name>/SKILL.md → /<name>); a nested category
  // dir is invisible to that scan. Flattening matches `activate-profile.sh`'s
  // manual installer and lets every profile skill be invoked via the Skill
  // tool — including the slug==category cases (caveman/caveman, github/github,
  // colony/colony) that a nested layout can't expose. smart-loader's dedup no
  // longer reads the dir tree; it reads the `.cue-skills` manifest written
  // below, which preserves the <category>/<slug> identity.
  const loadedSkillIds: string[] = [];
  // Resolve first, link second, so slug collisions resolve by LAST-WINS: when
  // two skills share a slug (e.g. plan/investigate lean vs gstack/investigate
  // full), the later entry wins the flat /<slug> name. Skill lists merge
  // parent→child (core first, profile last), so last-wins = the more-specific
  // profile's choice overrides the inherited one — the standard override rule.
  // The loser is still in the manifest, so smart-loader can surface it.
  const slugToSrc = new Map<string, string>();
  const slugToId = new Map<string, string>();
  const overridden: string[] = [];
  for (const skill of profile.skills.local) {
    if (!appliesToAgent(skill, agent)) continue;
    if (skill.when && !evaluateCondition(skill.when, process.cwd())) continue;
    attemptedSkills++;
    try {
      const src = await input.skillSourceLookup(skill.id);
      loadedSkillIds.push(skill.id);
      const slug = basename(skill.id);
      const prevId = slugToId.get(slug);
      if (prevId !== undefined && prevId !== skill.id) {
        overridden.push(`${slug}: ${prevId} → ${skill.id}`);
      }
      slugToSrc.set(slug, src);
      slugToId.set(slug, skill.id);
    } catch {
      skippedSkills.push(skill.id);
    }
  }
  for (const [slug, src] of slugToSrc) {
    await symlink(src, join(skillsDir, slug));
  }
  // Project-loadout deferred index: one generated (written, not symlinked)
  // skill standing in for every skill the loadout deferred. Costs a single
  // frontmatter line always-on; the agent invokes it to discover and Read a
  // deferred skill's real SKILL.md. Present in the content hash via
  // profile.deferredSkills, so loadout changes rebuild this file.
  const deferredSkills = profile.deferredSkills ?? [];
  if (deferredSkills.length > 0) {
    const { DEFERRED_INDEX_SLUG, generateDeferredIndexSkill } =
      await import("./lazy-skills");
    const indexDir = join(skillsDir, DEFERRED_INDEX_SLUG);
    await mkdir(indexDir, { recursive: true });
    await writeFile(
      join(indexDir, "SKILL.md"),
      generateDeferredIndexSkill(deferredSkills),
    );
  }
  if (overridden.length > 0) {
    process.stderr.write(
      `[cue] ${overridden.length} skill slug collision(s) resolved last-wins ` +
        `(loser still smart-loadable): ${overridden.join("; ")}\n`,
    );
  }
  // Manifest for smart-loader's --exclude-loaded: the resolved <category>/<slug>
  // ids, decoupled from the (now flat) on-disk layout.
  await writeFile(
    join(tmpDir, ".cue-skills"),
    loadedSkillIds.length > 0 ? `${loadedSkillIds.join("\n")}\n` : "",
  );
  if (skippedSkills.length > 0) {
    process.stderr.write(
      `[cue] skipped ${skippedSkills.length} missing skill(s): ${skippedSkills.slice(0, 5).join(", ")}` +
        (skippedSkills.length > 5
          ? `, +${skippedSkills.length - 5} more`
          : "") +
        ` — run \`cue debug ${profile.name}\` for details\n`,
    );
  }
  // Fail-loud guard: a single broken ref in a 20-skill profile is tolerable
  // (warned above), but if MORE THAN HALF the skills failed to resolve, the
  // materialized runtime is broken — almost always a misconfigured skill
  // source root (e.g. resolveLocalSkill falling back to a stale default when
  // CUE_REPO_ROOT is unset). Silently writing a near-empty CLAUDE.md is worse
  // than crashing. Bypass with CUE_ALLOW_PARTIAL_SKILLS=1 for the rare profile
  // that genuinely expects most skills to be unavailable.
  const allowPartial =
    process.env.CUE_ALLOW_PARTIAL_SKILLS === "1" ||
    process.env.CUE_ALLOW_PARTIAL_SKILLS === "true";
  if (
    !allowPartial &&
    attemptedSkills > 0 &&
    skippedSkills.length / attemptedSkills > 0.5
  ) {
    await rm(tmpDir, { recursive: true, force: true });
    throw new Error(
      `[cue] skill resolution failed: ${skippedSkills.length}/${attemptedSkills} ` +
        `skill(s) for profile "${profile.name}" could not be resolved. The runtime ` +
        `would be broken, so the rebuild was aborted (old runtime left intact). ` +
        `This usually means the skill source root is wrong — check CUE_REPO_ROOT / ` +
        `the skillSourceLookup wiring, then run \`cue debug ${profile.name}\`. ` +
        `Set CUE_ALLOW_PARTIAL_SKILLS=1 to bypass.`,
    );
  }

  // Defensive defaults — older fixtures may not declare these arrays.
  const profileRules = profile.rules ?? [];
  const profileCommands = profile.commands ?? [];
  const profileSubagents = profile.subagents ?? [];
  // Effective hook list: profile-declared hooks PLUS the cue-quality-gates
  // Stop hook when the profile declares any qualityGates. Keeps profile
  // authors from having to remember to wire both `qualityGates` and the
  // matching hook entry — declaring gates is enough. Same dedupe + merge
  // logic runs again in buildClaudeSettings so the settings.json wiring
  // stays consistent with the symlinked files here.
  const profileHooks = [...(profile.hooks ?? [])];
  const profileGatesForAutoHook = (profile as any).qualityGates ?? [];
  if (
    agent === "claude-code" &&
    profileGatesForAutoHook.length > 0 &&
    !profileHooks.includes("cue-quality-gates.json")
  ) {
    profileHooks.push("cue-quality-gates.json");
  }

  // 1b. Commands — symlink each <ref>.md into commands/ (Claude reads .claude/commands/*.md)
  if (agent === "claude-code" && profileCommands.length > 0) {
    const commandsDir = join(tmpDir, "commands");
    await mkdir(commandsDir, { recursive: true });
    for (const ref of profileCommands) {
      const src = resolveResourcePath(
        ref.endsWith(".md") ? ref : `${ref}.md`,
        RESOURCES_COMMANDS,
      );
      try {
        await lstat(src);
        await symlink(src, join(commandsDir, basename(src)));
      } catch {
        /* missing source — skip */
      }
    }
  }

  // 1b2. Subagents — symlink each <ref>.md FLAT into agents/ (Claude reads
  // .claude/agents/*.md and delegates to them via the Task tool). Refs may be
  // division-scoped (e.g. "design/design-ui-designer"); we flatten to the
  // basename since agent file-stems are already globally unique. When a profile
  // declares subagents, the real agents/ dir we create here causes the later
  // overlay step to skip the user's ~/.claude/agents passthrough (existing real
  // dir is left untouched) — the profile's curated set wins, by design.
  if (agent === "claude-code" && profileSubagents.length > 0) {
    const agentsDir = join(tmpDir, "agents");
    await mkdir(agentsDir, { recursive: true });
    for (const ref of profileSubagents) {
      const src = resolveResourcePath(
        ref.endsWith(".md") ? ref : `${ref}.md`,
        RESOURCES_SUBAGENTS,
      );
      try {
        await lstat(src);
        await symlink(src, join(agentsDir, basename(src)));
      } catch {
        /* missing source — skip */
      }
    }
  }

  // 1c. Rules — symlink into rules/. Contents get appended to CLAUDE.md below.
  if (profileRules.length > 0) {
    const rulesDir = join(tmpDir, "rules");
    await mkdir(rulesDir, { recursive: true });
    for (const ref of profileRules) {
      const src = resolveResourcePath(
        ref.endsWith(".md") ? ref : `${ref}.md`,
        RESOURCES_RULES,
      );
      try {
        await lstat(src);
        await symlink(src, join(rulesDir, basename(src)));
      } catch {
        /* missing source — skip */
      }
    }
  }

  // 1d. Hooks — symlink scripts into hooks/. settings.json wiring happens in buildClaudeSettings.
  // A hook ref points at a `.json` config; its referenced script (e.g. `<stem>.sh`)
  // lives next to it in resources/hooks/ and must be symlinked too, otherwise the
  // Stop/PreToolUse/etc. hook fires `bash $CLAUDE_CONFIG_DIR/hooks/<stem>.sh` and
  // dies with "No such file or directory".
  if (agent === "claude-code" && profileHooks.length > 0) {
    const hooksDir = join(tmpDir, "hooks");
    await mkdir(hooksDir, { recursive: true });
    for (const ref of profileHooks) {
      const src = resolveResourcePath(ref, RESOURCES_HOOKS);
      try {
        await lstat(src);
        await symlink(src, join(hooksDir, basename(src)));
      } catch {
        /* missing source — skip */
      }
      const stem = basename(ref).replace(/\.[^.]+$/, "");
      for (const ext of [".sh", ".py", ".js", ".mjs", ".ts"]) {
        const companion = join(RESOURCES_HOOKS, `${stem}${ext}`);
        try {
          await lstat(companion);
          await symlink(companion, join(hooksDir, `${stem}${ext}`));
        } catch {
          /* no companion at this ext — skip */
        }
      }
    }
  }

  // 1e. Playbooks (Phase 2) — symlink markdown protocols into playbooks/.
  // Indexed in CLAUDE.md so Claude knows to consult them; bodies lazy-loaded.
  const profilePlaybooks = (profile as any).playbooks ?? [];
  if (profilePlaybooks.length > 0) {
    const pbDir = join(tmpDir, "playbooks");
    await mkdir(pbDir, { recursive: true });
    for (const ref of profilePlaybooks) {
      const src = resolveResourcePath(
        ref.endsWith(".md") ? ref : `${ref}.md`,
        RESOURCES_PLAYBOOKS,
      );
      try {
        await lstat(src);
        await symlink(src, join(pbDir, basename(src)));
      } catch {
        /* missing source — skip */
      }
    }
  }

  // 1f. Quality gates (Phase 3) — symlink validator scripts into quality-gates/.
  // The Stop hook (cue-quality-gates.sh, see resources/hooks/) iterates this
  // directory and fails the session if any gate exits non-zero.
  // Refs in profile.yaml typically omit the `.sh` extension, so we append it
  // when missing — otherwise resolveResourcePath produces e.g.
  // `.../resources/quality-gates/lint-skill-pass` (no such file) and the
  // lstat fails silently, leaving the gate undeployed at Stop time.
  const profileGates = (profile as any).qualityGates ?? [];
  if (agent === "claude-code" && profileGates.length > 0) {
    const gDir = join(tmpDir, "quality-gates");
    await mkdir(gDir, { recursive: true });
    for (const ref of profileGates) {
      const fname = ref.endsWith(".sh") ? ref : `${ref}.sh`;
      const src = resolveResourcePath(fname, RESOURCES_QUALITY_GATES);
      try {
        await lstat(src);
        await symlink(src, join(gDir, basename(src)));
      } catch {
        /* missing source — skip; surfaced by `cue doctor` (D8) */
      }
    }
  }

  // 2. settings.json (Claude) or config.toml (Codex) — Claude-only first cut.
  // mcpServers was already collected above (used by both code paths).
  if (agent === "claude-code") {
    const merged = await buildClaudeSettings(
      profile,
      agent,
      effectiveInput,
      runtimeDir,
    );
    await writeFile(join(tmpDir, "settings.json"), merged + "\n");
  } else {
    // Codex equivalent — config.toml. cue points CODEX_HOME at this runtime, so
    // this file is the ONLY config the session reads: it has to carry the base
    // config's autonomy knobs (reasoning effort, context window, auto-compact,
    // [features]) and its skill overrides or the session silently diverges from
    // the user's canonical Codex setup.
    const overrides = effectiveCodexOverrides(profile) ?? {};
    let config = buildCodexConfigToml({
      baseText: codexBaseText,
      overrides,
      mcpServers,
      disabledSkillPaths: effectiveInput.codexExternalSkillPaths,
      enabledSkillPaths: [
        ...slugToSrc.keys(),
        ...(deferredSkills.length > 0 ? ["cue-deferred-skills"] : []),
      ].map((slug) => join(runtimeDir, "skills", slug, "SKILL.md")),
    });
    const readOptional = (name: string) => readFile(join(runtimeDir, name), "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
    const ownedRaw = await readOptional(".cue-hooks.json");
    if (overrides.hooks || ownedRaw !== undefined) {
      const { document, owned } = reconcileCodexHooks(await readOptional("hooks.json"), ownedRaw, overrides.hooks);
      await writeFile(
        join(tmpDir, "hooks.json"),
        JSON.stringify(document, null, 2) + "\n",
        { mode: 0o600 },
      );
      await writeFile(join(tmpDir, ".cue-hooks.json"), JSON.stringify(owned, null, 2) + "\n", { mode: 0o600 });
      // The builder emits profile overrides as single-line top-level values.
      config = config.replace(/^hooks = .*\n/m, "");
    }
    await writeFile(join(tmpDir, "config.toml"), config);
  }

  // 3. CLAUDE.md with stamp + role identity
  const iconStr = profile.icon ?? "";
  const skillsList = (profile.skills?.local ?? [])
    .map((s) => (typeof s === "string" ? s : s.id))
    .filter((s) => !s.includes("*"));
  const mcpsList = (profile.mcps ?? []).map((m) =>
    typeof m === "string" ? m : m.id,
  );

  let stamp =
    `<!-- cue: profile=${profile.name} icon=${iconStr} -->\n` +
    `# Active Profile: ${iconStr ? iconStr + " " : ""}${profile.name}\n\n` +
    `> ${profile.description}\n\n`;

  // Phase 1: Persona — multi-line role-priming defining who the agent IS.
  // Goes above the mechanical "Your Role" block so it primes interpretation
  // of everything that follows. Profiles without a persona keep the old
  // generic block (backwards-compatible).
  const profilePersona = (profile as any).persona ?? "";

  // persona_includes: shared snippets prepended to the persona. Lets
  // cross-profile policies (Integrity Protocol, voice rules) live in one
  // file in resources/personas/ and fan out via the profile chain.
  const fullPersona = (personaIncludesText + profilePersona).trim();
  if (fullPersona) {
    stamp += `## Your Expertise\n\n${fullPersona}\n\n`;
  }

  // Workspace context — inject active workspace's context into persona
  if (hasWorkspaces(profile.name)) {
    const activeWs = getActiveWorkspace(profile.name);
    if (activeWs) {
      const overrides = computeOverrides(profile.name, activeWs);
      if (overrides?.personaPrefix) {
        stamp += overrides.personaPrefix;
      }
    }
  }

  // Skill router — auto-built capability + trigger tables that prime Claude
  // to reach for skills proactively (capability) and reactively (triggers)
  // instead of freestyling. Parsed from each skill's SKILL.md frontmatter;
  // skills with weak descriptions land in the "Other skills" tail and are
  // flagged by the linter (W6/W7/W8).
  const routerParsed: ParsedSkill[] = [];
  for (const id of skillsList) {
    try {
      const dir = await input.skillSourceLookup(id);
      routerParsed.push(await parseSkillFromDir(id, dir));
    } catch {
      // Skill source not on disk (e.g. plugin skill resolved at runtime) —
      // include a placeholder so it surfaces in "Other skills" rather than
      // silently vanishing.
      const fallbackName = id.split("/").pop() ?? id;
      routerParsed.push({
        id,
        name: fallbackName,
        triggers: [],
        capability: "",
        capabilityExplicit: false,
        whenToInvoke: [],
        notFor: "",
        rawDescription: "",
        quality: "none",
        missing: true,
      });
    }
  }
  const routerOverrides =
    (
      profile as {
        personaRouting?: {
          phrase?: string;
          capability?: string;
          skill: string;
          note?: string;
        }[];
      }
    ).personaRouting ?? [];

  // Telemetry-driven router compaction. Read the same skill-usage data that
  // `cue skill-report` shows; collapse zombies (0 hits in last 30d) into a
  // single compact tail in the rendered router. Saves ~40% of router-block
  // tokens on heavy profiles. Honors `CUE_LEAN=1` to drop zombies entirely.
  // Best-effort: any failure (telemetry off, log unreadable) → render full.
  let zombieIds: string[] = [];
  try {
    const { computeSkillUsage } = await import("./skill-report");
    const usage = computeSkillUsage(profile, { windowDays: 30 });
    zombieIds = usage.filter((u) => u.zombie).map((u) => u.id);
  } catch {
    /* render full router on any failure */
  }
  const lean = process.env.CUE_LEAN === "1" || process.env.CUE_LEAN === "true";
  // Default-on: the trigger-phrases table duplicates each SKILL.md's own
  // frontmatter, and on heavy profiles it pushes the materialized CLAUDE.md
  // past Claude Code's 40KB perf-warning threshold. Opt back in with
  // CUE_TRIGGER_PHRASES=1.
  const omitTriggerPhrases = !(
    process.env.CUE_TRIGGER_PHRASES === "1" ||
    process.env.CUE_TRIGGER_PHRASES === "true"
  );
  // Cap the capability table so heavy profiles (60+ skills) don't blow past
  // Claude Code's 40KB CLAUDE.md perf threshold. Overflow skills stay listed
  // under "Available Skills" and loadable on demand. Override with
  // CUE_MAX_CAPABILITY_ROWS (0 disables the cap).
  const maxCapEnv = Number(process.env.CUE_MAX_CAPABILITY_ROWS);
  const maxCapabilityRows =
    Number.isFinite(maxCapEnv) && maxCapEnv >= 0 ? maxCapEnv : 50;
  const routerBlock = renderRouter(routerParsed, {
    overrides: routerOverrides,
    zombies: zombieIds,
    lean,
    omitTriggerPhrases,
    maxCapabilityRows,
  });
  if (routerBlock) stamp += routerBlock;

  // Role identity — tell Claude what it is
  stamp +=
    `## Your Role\n\n` +
    `You are operating as **${profile.name}** — ${profile.description.toLowerCase()}.\n` +
    `Focus on tasks within this domain. Use the skills loaded in this profile.\n\n`;

  // Skills summary
  if (skillsList.length > 0) {
    stamp += `## Available Skills (${skillsList.length})\n\n`;
    if (skillsList.length <= 20) {
      stamp +=
        skillsList.map((s) => `- \`${s.split("/").pop()}\``).join("\n") + "\n";
    } else {
      // Group by category
      const groups = new Map<string, string[]>();
      for (const s of skillsList) {
        const parts = s.split("/");
        const cat = parts.length > 1 ? parts[0]! : "other";
        const list = groups.get(cat) ?? [];
        list.push(parts.pop()!);
        groups.set(cat, list);
      }
      for (const [cat, skills] of [...groups.entries()].sort()) {
        stamp += `- **${cat}/** (${skills.length}): ${skills.slice(0, 5).join(", ")}${skills.length > 5 ? ` +${skills.length - 5} more` : ""}\n`;
      }
    }
    stamp += "\n";
  }

  // MCPs
  if (mcpsList.length > 0) {
    stamp += `## MCP Servers: ${mcpsList.join(", ")}\n\n`;
  }

  // Per-session telemetry sections (Skill Usage / Last Session / Common
  // Workflows). Default-off: volatile usage/warm-start noise with no triggering
  // value — every skill is already named in the capability table and
  // "## Available Skills". Opt back in with CUE_SESSION_TELEMETRY=1. Skipping
  // the block also skips the analytics/session disk reads below.
  if (shouldIncludeSessionTelemetry(process.env)) {
    // Skill usage analytics — help the model prioritize frequently-used skills
    try {
      const { skillStats } = await import("./analytics");
      const stats = skillStats(profile.name);
      if (stats.length > 0) {
        stamp += `## Skill Usage (last 30 days)\n\n`;
        stamp += `Prioritize these skills — they're the ones actually used:\n`;
        for (const s of stats.slice(0, 8)) {
          stamp += `- \`${s.skill}\` (${s.hits}× used)\n`;
        }
        stamp += "\n";
      }
    } catch {
      /* analytics unavailable — skip */
    }

    // Profile fit monitoring — formerly a ~150-token hardcoded block; now a
    // skill (meta/profile-fit-monitor) loaded on demand. Net per-message cost
    // drops to just the skill's description line in "## Available Skills".

    // #8: Warm-start context — last session summary
    const lastSession = await getLastSessionSummary(profile.name);
    if (lastSession) {
      stamp += `## Last Session\n\n${lastSession}\n\n`;
    }

    // #9: Skill chaining hints — common workflows from usage patterns
    const chains = await getSkillChains(skillsList);
    if (chains) {
      stamp += `## Common Workflows\n\n${chains}\n\n`;
    }
  }

  // Rules — index only. Symlinks live in rules/; Claude reads on demand instead
  // of paying the full token cost every turn.
  if (profileRules.length > 0) {
    stamp +=
      `## Rules (${profileRules.length})\n\n` +
      `Read on demand from \`rules/\`:\n` +
      profileRules
        .map(
          (r) => `- \`rules/${basename(r.endsWith(".md") ? r : `${r}.md`)}\``,
        )
        .join("\n") +
      "\n\n";
  }

  // Commands — list as a quick reference
  if (profileCommands.length > 0) {
    stamp +=
      `## Available Commands\n\n` +
      profileCommands.map((c) => `- /${basename(c, ".md")}`).join("\n") +
      "\n\n";
  }

  // Subagents — a grouped roster of the delegatable specialists in agents/.
  // Claude Code already routes to them natively by each agent's description;
  // this section is the proactive nudge — a quick "who's on the floor" map so
  // the model reaches for a specialist instead of improvising. Names only (the
  // full descriptions Claude Code loads from agents/ would be too costly to
  // repeat every turn). Grouped by the ref's division prefix.
  if (agent === "claude-code" && profileSubagents.length > 0) {
    const groups = new Map<string, string[]>();
    for (const ref of profileSubagents) {
      const slash = ref.indexOf("/");
      const div = slash > 0 ? ref.slice(0, slash) : "general";
      const stem = basename(ref, ".md");
      if (!groups.has(div)) groups.set(div, []);
      groups.get(div)!.push(stem);
    }
    stamp +=
      `## Subagents (${profileSubagents.length})\n\n` +
      `Delegatable specialists in \`agents/\`. **Prefer handing a matching task ` +
      `to one of these via the Task tool over improvising it yourself.** Claude ` +
      `Code routes by each agent's description; this is your quick map of who's ` +
      `on the floor:\n\n`;
    for (const [div, stems] of [...groups.entries()].sort()) {
      stamp += `- **${div}** (${stems.length}): ${stems.join(", ")}\n`;
    }
    stamp += "\n";
  }

  // Playbooks (Phase 2) — proven step-by-step protocols for common tasks.
  // Indexed only; bodies are read on demand when the matching task triggers.
  if (profilePlaybooks.length > 0) {
    stamp +=
      `## Playbooks (${profilePlaybooks.length})\n\n` +
      `Read on demand from \`playbooks/\` when the user's request matches:\n` +
      profilePlaybooks
        .map((p: string) => {
          const stem = basename(p, ".md");
          return `- \`playbooks/${stem}.md\` — use when ${stem.replace(/-/g, " ")}`;
        })
        .join("\n") +
      "\n\n" +
      `**Following a playbook beats freestyling.** If a relevant playbook exists, read it first and step through it.\n\n`;
  }

  // Quality gates (Phase 3) — mention so Claude knows what'll be checked at Stop.
  const profileGatesForStamp = (profile as any).qualityGates ?? [];
  if (profileGatesForStamp.length > 0) {
    stamp +=
      `## Quality Gates\n\nBefore claiming this session complete, these checks run at Stop:\n` +
      profileGatesForStamp
        .map((g: string) => `- \`${basename(g)}\``)
        .join("\n") +
      "\n\n" +
      `Don't claim "done" if you haven't met them — they'll fail you publicly.\n\n`;
  }

  // Codex has no `--append-system-prompt`, so the per-directory project brief
  // reaches it through a file named by CUE_PROJECT_BRIEF. This pointer must stay
  // STATIC: the runtime memory file is shared by every directory using this
  // profile, so anything directory-specific here would leak across projects and
  // churn the materialization hash. claude-code gets the brief inline instead.
  if (agent === "codex") {
    stamp += `## Project brief\n\n${CODEX_BRIEF_POINTER}\n\n`;
  }

  stamp += `---\n*generated ${new Date().toISOString()} — do not hand-edit*\n\n`;

  const memoryFileContent = stamp + input.userClaudeMd;
  const memoryFileName = agent === "claude-code" ? "CLAUDE.md" : "AGENTS.md";
  // Size-budget guard: Claude Code warns (and degrades performance) once a
  // memory file crosses ~40k chars. Warn at materialize time — the moment the
  // file is generated — so a bloated profile is caught before the user sees
  // the runtime warning, with a pointer to the usual culprit.
  if (
    agent === "claude-code" &&
    memoryFileContent.length > MEMORY_FILE_WARN_CHARS
  ) {
    const kb = (memoryFileContent.length / 1000).toFixed(1);
    process.stderr.write(
      `[cue] ${memoryFileName} for profile "${profile.name}" is ${kb}k chars ` +
        `(> ${(MEMORY_FILE_WARN_CHARS / 1000).toFixed(0)}k) — large memory files slow the agent ` +
        `and trigger its perf warning. Trim the profile (fewer skills/rules) or the ` +
        `appended user instructions.\n`,
    );
  }
  await writeFile(join(tmpDir, memoryFileName), memoryFileContent);

  // 4. hash (no trailing newline so /^[a-f0-9]{64}$/ matches directly)
  await writeFile(join(tmpDir, ".cue-hash"), hash);

  // 5. Overlay source state: symlink everything from credentialsSource that
  // cue doesn't manage (sessions/, projects/, history.jsonl, .credentials.json,
  // .session-stats.json, plugins/, telemetry/, etc.). This makes the runtime
  // dir look like a fully-onboarded Claude Code config from Claude's
  // perspective, while still letting cue override skills/, settings.json,
  // and CLAUDE.md.
  if (input.credentialsSource) {
    await overlaySourceState(tmpDir, input.credentialsSource, runtimeDir);
    // Pre-seed the plugin cache + marketplace metadata from the real config so
    // enabled-plugin hooks find their version dir on the first prompt instead
    // of racing Claude's lazy per-config-dir download.
    if (!sameResolvedPath(runtimeDir, input.credentialsSource)) {
      await linkPluginCache(tmpDir, input.credentialsSource);
    }
  }

  // Codex writes durable thread state directly into CODEX_HOME (sessions/,
  // history.jsonl, thread-store SQLite files, writer locks, etc.). Unlike
  // Claude, it has no credentialsSource overlay, so an atomic rematerialization
  // must carry every non-cue-managed entry forward. Otherwise changing a
  // profile while Codex is running deletes the active rollout and transcript
  // persistence starts failing with "no rollout found for thread id".
  if (agent === "codex") {
    // Read as late as possible, before moving any durable state. An unreadable
    // file must not be mistaken for a first launch.
    const oldConfig = await readFile(join(runtimeDir, "config.toml"), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      },
    );
    const localState = extractRuntimeCodexState(oldConfig);
    if (localState) {
      const configPath = join(tmpDir, "config.toml");
      await writeFile(configPath, (await readFile(configPath, "utf8")) + "\n" + localState, { mode: 0o600 });
    }
    const managed = new Set([
      ".cue-hash",
      ".cue-skills",
      "AGENTS.md",
      "config.toml",
      "playbooks",
      "rules",
      "skills",
    ]);
    let oldEntries: string[] = [];
    try {
      oldEntries = await readdir(runtimeDir);
    } catch {
      /* first build */
    }
    for (const name of oldEntries) {
      if (managed.has(name)) continue;
      const oldPath = join(runtimeDir, name);
      const newPath = join(tmpDir, name);
      try {
        await lstat(newPath);
        continue; // a freshly generated entry wins
      } catch {
        /* absent in the new runtime — preserve the old one */
      }
      try {
        await rename(oldPath, newPath);
      } catch {
        /* best-effort per entry */
      }
    }
  }

  // 6. Atomic swap: rm -rf old, rename tmp.
  //
  // Preserve session/credential state from the OLD runtime so resume + auth
  // survive across rematerializations:
  //   - .claude.json      → session state, projects list, oauthAccount
  //   - .credentials.json → OAuth tokens (refresh + access)
  //   - backups/          → Claude Code's own .claude.json backup chain
  //   - session-env/      → environment snapshots for sessions still running
  //   - tasks/            → in-flight task state for sessions still running
  //
  // We MOVE these from the old runtime over whatever the overlay step (5)
  // dropped into tmpDir — so a logged-in runtime stays logged in even when
  // ~/.claude.json (the credentialsSource) is in a stale/half-logged-out
  // state. Without this, an authmux account swap or a partial claude write
  // to the source would propagate into every cue-materialized profile.
  //
  // Trade-off: to fresh-bootstrap a profile after deliberately switching
  // accounts at the source, run:
  //   rm ~/.config/cue/runtime/<profile>/claude/.credentials.json
  //   rm ~/.config/cue/runtime/<profile>/claude/.claude.json
  // Next launch will copy current source state.
  // Account-identity guard: runtime dirs are keyed by PROFILE, so two authmux
  // accounts (claude-account1 / claude-account2 with different
  // CLAUDE_CONFIG_DIRs) share the same runtime. When the OLD runtime belongs
  // to a different account than the current credentialsSource, resurrecting
  // its .claude.json/.credentials.json would pair the old account's identity
  // with the new account's tokens (or vice versa) — and the expiresAt
  // comparison below is meaningless across accounts. Skip preservation
  // entirely and let the overlay's source state win.
  let sameAccount = true;
  if (input.credentialsSource) {
    const srcUuid = await accountUuidAt(
      join(input.credentialsSource, ".claude.json"),
    );
    const oldUuid = await accountUuidAt(join(runtimeDir, ".claude.json"));
    if (srcUuid && oldUuid && srcUuid !== oldUuid) sameAccount = false;
  }
  const preserveFiles = sameAccount
    ? [".claude.json", ".credentials.json", "backups", "session-env", "tasks"]
    : [];
  for (const name of preserveFiles) {
    const oldPath = join(runtimeDir, name);
    const newPath = join(tmpDir, name);
    try {
      const st = await lstat(oldPath);
      if (!(st.isFile() || st.isDirectory())) continue;
      if (name === ".credentials.json") {
        // Freshness guard — fixes "logged-out after relaunch". Anthropic rotates
        // the refresh token on every refresh, so only the copy with the highest
        // expiresAt still holds a live refresh token. Step 5's overlay already
        // placed the freshly-synced SOURCE creds in tmpDir (and
        // resolveClaudeCredentialsSource healed source from the freshest sibling
        // runtime first). Resurrect the OLD runtime's creds ONLY when they are
        // strictly newer than source — otherwise keep source, so a rebuild can't
        // drag a dead, rotated token back into the runtime. When source is
        // half-logged-out its expiresAt is 0/old, so a logged-in runtime still
        // wins and stays logged in (the original intent of this preserve step).
        const oldExp = await credentialsExpiresAt(oldPath);
        const newExp = await credentialsExpiresAt(newPath);
        if (oldExp <= newExp) continue; // source as-fresh-or-fresher → keep it
      }
      // Remove whatever overlay put here (likely a symlink for .claude.json
      // or a copy for .credentials.json) so rename can replace it cleanly.
      await rm(newPath, { force: true, recursive: true });
      await rename(oldPath, newPath);
    } catch {
      /* doesn't exist — skip */
    }
  }
  // `rm -rf runtimeDir` followed by rename leaves the live path NONEXISTENT for
  // the whole recursive delete — seconds, on a runtime carrying a plugin cache
  // and a backup chain. A Claude Code session already running against this
  // profile resolves ${CLAUDE_CONFIG_DIR}/hooks/*.sh through that exact path, so
  // every hook firing inside the gap dies with "No such file or directory"
  // (observed 2026-08-03: nine Stop hooks at once, mid-session rematerialize).
  //
  // Move the old tree aside instead. The live path is then unresolvable only
  // between two renames, and the delete runs after the new runtime is already
  // in place. `.old-*` is a SIBLING of the swap target, so it stays on the same
  // filesystem (rename cannot cross devices) and one level below the runtime
  // root that runtime-gc scans — it is never mistaken for a runtime entry.
  const trashDir = `${runtimeDir}.old-${process.pid}-${Date.now().toString(36)}`;
  let trashed = false;
  try {
    await rename(runtimeDir, trashDir);
    trashed = true;
  } catch {
    /* no previous runtime (first materialization) — nothing to move aside */
  }
  await rename(tmpDir, runtimeDir);
  if (trashed) {
    await rm(trashDir, { recursive: true, force: true }).catch(() => {
      /* the new runtime is already live; a stale .old-* is swept below */
    });
  }
  await sweepStaleSwapDirs(runtimeDir);

  if (agent === "claude-code") {
    await syncMcpsIntoClaudeJson(
      runtimeDir,
      mcpServers,
      effectiveInput.disabledMcpIds,
    );
  }

  return { runtimeDir, rebuilt: true, hash };
}

/**
 * Delete `<runtimeDir>.old-*` leftovers from an earlier swap that was killed
 * between the two renames. Best-effort and never fatal: the runtime it belongs
 * to is already live, so a leftover only wastes disk.
 */
async function sweepStaleSwapDirs(runtimeDir: string): Promise<void> {
  const parent = dirname(runtimeDir);
  const prefix = `${basename(runtimeDir)}.old-`;
  try {
    const names = await readdir(parent);
    await Promise.all(
      names
        .filter((name) => name.startsWith(prefix))
        .map((name) =>
          rm(join(parent, name), { recursive: true, force: true }).catch(
            () => {},
          ),
        ),
    );
  } catch {
    /* parent unreadable — nothing to sweep */
  }
}

/**
 * Read `claudeAiOauth.expiresAt` (ms epoch) from a `.credentials.json`. Returns
 * 0 when the file is missing, unparseable, or carries no expiry — so anything
 * with a real token sorts as fresher in the rebuild preserve comparison.
 */
async function credentialsExpiresAt(path: string): Promise<number> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { expiresAt?: number };
    };
    const exp = parsed?.claudeAiOauth?.expiresAt;
    return typeof exp === "number" ? exp : 0;
  } catch {
    return 0;
  }
}

/**
 * Read `oauthAccount.accountUuid` from a `.claude.json` at `path`. Returns
 * undefined when the file is missing, unparseable, or carries no account —
 * callers treat "unknown" as "don't make account-based decisions".
 *
 * Sibling of `readAccountUuid` in credentials-sync.ts (dir-based); keep the
 * schema (`oauthAccount.accountUuid`) in sync if it ever changes.
 */
async function accountUuidAt(path: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as {
      oauthAccount?: { accountUuid?: string };
    };
    return parsed?.oauthAccount?.accountUuid;
  } catch {
    return undefined;
  }
}

function collectProfileMcps(
  profile: ResolvedProfile,
  agent: AgentKind,
  registry: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const m of profile.mcps) {
    if (!appliesToAgent(m, agent)) continue;
    // cwd/env gate — a `when:`-conditioned server only activates when its
    // condition holds, so gated MCPs cost zero schema tokens elsewhere.
    // Mirrors the conditional-skill guard above.
    if (m.when && !evaluateCondition(m.when, process.cwd())) continue;
    const reg = registry[m.id];
    if (reg !== undefined) out[m.id] = reg;
  }
  return out;
}

// Claude Code reads MCP server definitions from .claude.json's top-level
// `mcpServers` field, not from settings.json. Without this sync, profile MCPs
// declared in profile.yaml never get started.
//
// We dereference any symlink first and write a real file in its place so
// per-profile MCP additions don't leak back into a shared account-level
// .claude.json (e.g. multiple cue profiles backed by the same account file).
async function syncMcpsIntoClaudeJson(
  runtimeDir: string,
  mcpServers: Record<string, McpServerConfig>,
  disabledIds: string[] = [],
): Promise<void> {
  const target = join(runtimeDir, ".claude.json");
  let parsed: Record<string, unknown> = {};
  try {
    const raw = await readFile(target, "utf8"); // follows symlink
    parsed = JSON.parse(raw);
  } catch (err) {
    // A missing file (ENOENT) or invalid JSON is fine to start fresh from —
    // claude would also fail to read a corrupt file, so a clean rewrite loses
    // nothing. But a TRANSIENT read error (EMFILE/EACCES on an existing, valid
    // file) must NOT trigger a stub rewrite that wipes session/auth state — bail
    // and leave .claude.json untouched this launch.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== undefined && code !== "ENOENT") return;
  }
  const existing =
    (parsed.mcpServers as Record<string, unknown> | undefined) ?? {};
  const merged: Record<string, unknown> = { ...existing, ...mcpServers };

  // Lazy-MCP removal: the rebuild preserves the OLD runtime's .claude.json
  // (session/auth state) and we merge additively onto it — so an MCP the user
  // disabled would otherwise linger across launches. Delete exactly the ids the
  // launcher disabled (case-insensitive), and only those, so user-added MCPs
  // are never touched.
  if (disabledIds.length > 0) {
    const drop = new Set(disabledIds.map((id) => id.toLowerCase()));
    // Never evict a key that's part of the current (kept) set — a kept MCP can't
    // also be disabled. Keeps removal strictly to dropped ids.
    const kept = new Set(Object.keys(mcpServers).map((k) => k.toLowerCase()));
    for (const key of Object.keys(merged)) {
      const lower = key.toLowerCase();
      if (drop.has(lower) && !kept.has(lower)) delete merged[key];
    }
  }
  parsed.mcpServers = merged;

  // Replace whatever's there (symlink or stale file) with a real file copy.
  await rm(target, { force: true });
  await writeFile(target, JSON.stringify(parsed, null, 2));
}

// Build the merged Claude Code settings.json content (string).
// Reads existing settings from credentialsSource (preserves permissions,
// trustedDirectories, skipAutoPermissionPrompt) and overlays the profile's
// plugins + MCPs.
// Files/dirs cue actively manages — never overlay these from the source dir.
// Also includes Claude Code internal per-session dirs (session-env, tasks,
// plugins/data) so the overlay never re-creates a self-referential symlink.
// Bug pattern: if a previous rematerialize left ~/.claude/<dir> as a symlink
// pointing back into runtime/<profile>/claude/<dir>, a subsequent overlay
// would symlink the runtime path back to itself, producing an ELOOP that
// bricks every Bash/Task call until cleared by hand. Caught dirs so far:
// session-env, tasks, plugins/data/<plugin-id>. Adding any Claude Code
// internal write target here is cheap and forward-compatible.
const CUE_MANAGED_ENTRIES = new Set([
  "settings.json",
  "skills",
  "commands",
  "hooks",
  "rules",
  "CLAUDE.md",
  "AGENTS.md",
  ".cue-hash",
  "config.toml",
  // Claude Code internal per-session / plugin-data dirs — never overlay.
  "session-env",
  "tasks",
  "plugins",
]);

function sameResolvedPath(a: string, b: string): boolean {
  return resolvePath(a) === resolvePath(b);
}

/**
 * Overlay state from `sourceDir` into `targetDir` by symlinking every
 * top-level entry that cue doesn't actively manage. This makes the runtime
 * dir behave like a fully-onboarded Claude Code config from Claude's
 * perspective — sessions, projects, history, telemetry markers, plugins,
 * `.session-stats.json`, `.credentials.json`, etc. all surface from the
 * account dir. Token refreshes write back to the source.
 *
 * Existing real files/dirs (cue overrides like settings.json, skills/) are
 * left alone. Existing symlinks are replaced — supports account switching
 * on cache hit, where the previous symlinks point to a different source.
 * Errors per-entry are non-fatal.
 */
/**
 * @param staggerKey Stable identity for the runtime being built. The fresh path
 *   writes into a tmp dir that is renamed into place afterwards, so `targetDir`
 *   is not the same string across a fresh materialize and a later cache-hit
 *   refresh. Credential staggering must key off the runtime's final location or
 *   the same runtime would land in a different slot on every rebuild.
 */
async function overlaySourceState(
  targetDir: string,
  sourceDir: string,
  staggerKey: string = targetDir,
): Promise<void> {
  const sourceResolved = resolvePath(sourceDir);
  const targetResolved = resolvePath(targetDir);
  const finalResolved = resolvePath(staggerKey);
  if (sourceResolved === targetResolved || sourceResolved === finalResolved) {
    return;
  }

  let entries: string[];
  try {
    entries = await readdir(sourceDir);
  } catch {
    return; // source unreadable; nothing to overlay
  }

  // Legacy home-root .claude.json fallback: older Claude Code put session
  // state at ~/.claude.json (sibling to ~/.claude/), not inside it. If the
  // canonical inside-dir version is missing but the home-root one exists,
  // surface it so the runtime looks fully onboarded — otherwise claude
  // boots into the OAuth flow even with a valid .credentials.json present.
  // Only kicks in when sourceDir is the user's ~/.claude.
  if (
    !entries.includes(".claude.json") &&
    sourceDir === join(homedir(), ".claude")
  ) {
    const legacy = join(homedir(), ".claude.json");
    try {
      const { existsSync } = await import("node:fs");
      if (existsSync(legacy)) entries.push(".claude.json");
    } catch {
      /* skip */
    }
  }

  // Account identity of both sides, resolved ONCE before the loop below can
  // swap `.claude.json` out from under the comparison. Same home-root fallback
  // as the entry list above: with no CLAUDE_CONFIG_DIR, Claude Code keeps
  // `oauthAccount` in `~/.claude.json`, not in `~/.claude/.claude.json`.
  const identityOf = async (dir: string): Promise<string | undefined> =>
    (await accountUuidAt(join(dir, ".claude.json"))) ??
    (basename(dir) === ".claude"
      ? await accountUuidAt(join(dirname(dir), ".claude.json"))
      : undefined);
  const srcAccount = await identityOf(sourceDir);
  const dstAccount = await identityOf(targetDir);
  // Unknown on either side → treat as the same account: the expiry comparison
  // below is a no-op when the files agree, and refusing to compare would put us
  // back on the unconditional stamp this guard exists to prevent.
  const sameAccount = !srcAccount || !dstAccount || srcAccount === dstAccount;

  for (const name of entries) {
    if (CUE_MANAGED_ENTRIES.has(name)) continue;
    const targetPath = join(targetDir, name);
    // Special-case the legacy ~/.claude.json fallback above: source is at the
    // home-root path, not inside sourceDir.
    const isLegacyClaudeJson =
      name === ".claude.json" && sourceDir === join(homedir(), ".claude");
    const sourcePath = isLegacyClaudeJson
      ? join(homedir(), ".claude.json")
      : join(sourceDir, name);

    let existingType: "symlink" | "other" | "missing" = "missing";
    try {
      const st = await lstat(targetPath);
      existingType = st.isSymbolicLink() ? "symlink" : "other";
    } catch {
      /* missing */
    }

    // .claude.json gets the same copy-not-symlink treatment as .credentials.json:
    // claude rewrites it atomically and we want per-profile session state, not
    // a shared one that gets clobbered when 2 profiles run concurrently.
    const isCopyFile = name === ".credentials.json" || isLegacyClaudeJson;

    if (existingType === "other" && !isCopyFile) {
      // Account-identity guard: .claude.json starts life as a symlink into the
      // source dir, but Claude Code's atomic rewrite (tmp → rename) replaces it
      // with a local FILE owned by whichever account last logged in here. Since
      // runtime dirs are keyed by profile (not account), a different authmux
      // account launching the same profile used to find its fresh tokens paired
      // with the OLD account's identity — booting into the login flow every time
      // the two accounts alternated on a profile. When the uuids differ, re-seed
      // identity from the source so it follows CLAUDE_CONFIG_DIR.
      //
      // Trade-off: the swap replaces the whole file, so the OLD account's
      // per-profile session state (projects list etc.) in this runtime is
      // discarded — acceptable, since it belongs to a different account.
      if (name === ".claude.json") {
        const srcUuid = await accountUuidAt(sourcePath);
        const dstUuid = await accountUuidAt(targetPath);
        if (srcUuid && dstUuid && srcUuid !== dstUuid) {
          try {
            // Copy to a sibling tmp + atomic rename — never leaves a window
            // where .claude.json is missing/partial while a concurrent claude
            // process might read or atomically rewrite it.
            const { copyFile } = await import("node:fs/promises");
            const tmp = `${targetPath}.cue-swap.${process.pid}`;
            await copyFile(sourcePath, tmp);
            await rename(tmp, targetPath);
          } catch {
            /* non-fatal — keep existing file */
          }
        }
      }
      continue; // cue override — don't touch
    }

    // Freshness guard on the rotated OAuth token. Anthropic rotates the refresh
    // token on every refresh, so only the copy with the highest expiresAt still
    // holds a LIVE one. This overlay runs on every cache-hit launch — and via
    // `cue sync` / `cue install`, which resolve their source with
    // `healFromRuntime: false` — so stamping source over the runtime
    // unconditionally can hand a session a dead token and force a mid-session
    // re-login, across every runtime at once on a bulk sync. Keep whichever side
    // is newer; mirror of the rebuild path's `preserveFiles` guard.
    //
    // Scoped to one account: when the identities differ this is a deliberate
    // account switch, and source must win regardless of expiry.
    if (name === ".credentials.json" && sameAccount) {
      const srcExpiresAt = await credentialsExpiresAt(sourcePath);
      const dstExpiresAt = await credentialsExpiresAt(targetPath);
      if (dstExpiresAt > srcExpiresAt) continue; // runtime holds the live token
    }

    if (
      existingType === "symlink" ||
      (existingType === "other" && isCopyFile)
    ) {
      // Replace if it points elsewhere (e.g. previous account on cache hit).
      try {
        await rm(targetPath, { force: true });
      } catch {
        continue;
      }
    }

    if (isCopyFile) {
      const { copyFile } = await import("node:fs/promises");
      try {
        if (name === ".credentials.json") {
          // Staggered, so this runtime reaches its apparent expiry at a
          // different minute than its siblings and they stop racing for one
          // rotation. See writeStaggeredCopy in credentials-sync.
          const { writeStaggeredCopy } = await import("./credentials-sync");
          await writeStaggeredCopy(sourcePath, targetPath, staggerKey);
        } else {
          await copyFile(sourcePath, targetPath);
        }
      } catch {
        /* skip */
      }
    } else {
      try {
        await symlink(sourcePath, targetPath);
      } catch {
        /* race or permission — skip silently */
      }
    }
  }
}

/**
 * Pre-seed the runtime's plugin cache + marketplace metadata by symlinking them
 * from the real source config (`~/.claude/plugins`). `plugins` is excluded from
 * the generic overlay (CUE_MANAGED_ENTRIES) because Claude writes per-session
 * state under `plugins/data` — symlinking that whole tree risks the ELOOP
 * documented above. But the *downloaded* plugin payload and marketplace
 * metadata are read-mostly and identical across profiles, so sharing them is
 * safe and fixes a real bug:
 *
 *   A fresh per-profile runtime starts with an empty plugin cache. When
 *   settings.json enables a plugin (`enabledPlugins`), its hooks fire on the
 *   first prompt — but Claude hasn't finished downloading the plugin into this
 *   config dir's cache yet, so the hook fails with "Plugin directory does not
 *   exist … run /plugin to reinstall". Symlinking `cache` (and the marketplace
 *   metadata that resolves the enabled version) to the already-downloaded real
 *   tree makes the version dir present from the first moment — no race.
 *
 * Deliberately NOT linked:
 *   - `installed_plugins.json`: Claude rewrites this per-config-dir; symlinking
 *     it risks clobbering the real registry with an empty `{plugins:{}}`.
 *   - `data`: per-plugin writable state; the self-referential ELOOP source.
 */
export async function linkPluginCache(
  targetDir: string,
  sourceDir: string,
): Promise<void> {
  if (sameResolvedPath(targetDir, sourceDir)) return;

  const srcPlugins = join(sourceDir, "plugins");
  try {
    await lstat(srcPlugins);
  } catch {
    return; // source has no plugins tree — nothing to seed
  }
  const pluginsDir = join(targetDir, "plugins");
  await mkdir(pluginsDir, { recursive: true });

  for (const name of ["cache", "marketplaces", "known_marketplaces.json"]) {
    const sourcePath = join(srcPlugins, name);
    try {
      await lstat(sourcePath);
    } catch {
      continue; // not present in source
    }
    const targetPath = join(pluginsDir, name);
    // Replace whatever's there (Claude's lazy/empty copy or a stale symlink)
    // with a symlink to the real, already-downloaded tree — atomically.
    //
    // A plain rm-then-symlink leaves the path absent for a moment, and
    // re-materializing happens while sessions are live. A hook firing in that
    // window sees exactly the error this function exists to prevent:
    // "Plugin directory does not exist … run /plugin to reinstall". Observed
    // 2026-08-07, a Stop hook against claude-mem@thedotmack. So stage the new
    // link beside the target and rename() it over: same directory, so the swap
    // is atomic and a concurrent reader sees the old entry or the new one,
    // never neither.
    const stagePath = `${targetPath}.cue-tmp-${process.pid}`;
    try {
      await rm(stagePath, { recursive: true, force: true });
      await symlink(sourcePath, stagePath);
      try {
        await rename(stagePath, targetPath);
      } catch {
        // rename refuses to clobber a real directory, and POSIX has no atomic
        // way to replace a directory with a symlink — so this branch keeps the
        // old window. It is the first materialization, when the target is
        // still Claude's lazy empty copy; every later pass finds a symlink and
        // takes the atomic path above, which is the one that was failing hooks.
        await rm(targetPath, { recursive: true, force: true });
        await rename(stagePath, targetPath);
      }
    } catch {
      // Race or permission — leave the existing entry in place rather than
      // removing it, and don't leak the staged link.
      await rm(stagePath, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Parse a loopback proxy URL. Returns a URL only for loopback hosts
 * (127.0.0.1 / ::1 / localhost) — those are the ones we health-gate; any other
 * host is treated as a managed remote and left alone.
 */
function parseLoopbackProxyUrl(rawUrl: string): URL | null {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname;
    if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost")
      return null;
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

/**
 * Whether a proxy base URL should be applied to settings.json. Non-loopback
 * URLs are always "reachable" (not gated — assumed deliberately managed). A
 * loopback URL is reachable only if its HTTP `/health` endpoint returns 2xx
 * within `timeoutMs`. A raw TCP connect is not enough: a saturated proxy may
 * accept sockets while timing out or returning 503 to Claude traffic.
 */
async function isProxyReachable(
  rawUrl: string,
  timeoutMs = 400,
): Promise<boolean> {
  const baseUrl = parseLoopbackProxyUrl(rawUrl);
  if (!baseUrl) return true;
  const healthUrl = new URL("/health", baseUrl);
  return await new Promise<boolean>((resolveProbe) => {
    const client = healthUrl.protocol === "https:" ? https : http;
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolveProbe(ok);
    };
    const req = client.get(healthUrl, (res) => {
      res.resume();
      finish((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(false);
    });
    req.once("error", () => finish(false));
  });
}

async function buildClaudeSettings(
  profile: ResolvedProfile,
  agent: AgentKind,
  input: MaterializeInput,
  runtimeDir: string,
): Promise<string> {
  const enabledPlugins: Record<string, true> = {};
  for (const plugin of profile.plugins) {
    if (!appliesToAgent(plugin, agent)) continue;
    enabledPlugins[plugin.id] = true;
  }
  const mcpServers = collectProfileMcps(profile, agent, input.mcpRegistry);
  let baseSettings: Record<string, unknown> = {};
  if (input.credentialsSource) {
    try {
      const raw = await readFile(
        join(input.credentialsSource, "settings.json"),
        "utf8",
      );
      baseSettings = JSON.parse(raw);
    } catch {
      /* no existing settings — start fresh */
    }
  }
  const profileLocalSettings = await readClaudeProfileLocalSettings(runtimeDir);

  // Merge profile hooks. A hook ref points to a JSON file with shape
  // { hooks: { PreToolUse: [...], ... } } — same shape Claude Code expects.
  // Multiple hook files concat their event arrays under each lifecycle key.
  let mergedHooks: Record<string, unknown[]> = {};
  const baseHooks =
    (baseSettings.hooks as Record<string, unknown[]> | undefined) ?? {};
  for (const [k, v] of Object.entries(baseHooks)) {
    mergedHooks[k] = Array.isArray(v) ? [...v] : [];
  }
  // Auto-inject the cue-quality-gates Stop hook when the profile declares
  // any qualityGates. This avoids the footgun where a profile lists gates
  // but forgets to wire the hook, so gates would never actually fire.
  // Explicit `hooks: [cue-quality-gates.json]` still works and is deduped.
  const declaredHooks = [...(profile.hooks ?? [])];
  const profileGatesForHook = (profile as any).qualityGates ?? [];
  if (
    agent === "claude-code" &&
    profileGatesForHook.length > 0 &&
    !declaredHooks.includes("cue-quality-gates.json")
  ) {
    declaredHooks.push("cue-quality-gates.json");
  }
  for (const ref of declaredHooks) {
    const src = resolveResourcePath(ref, RESOURCES_HOOKS);
    try {
      const raw = await readFile(src, "utf8");
      const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown[]> };
      for (const [event, entries] of Object.entries(parsed.hooks ?? {})) {
        if (!Array.isArray(entries)) continue;
        mergedHooks[event] = [...(mergedHooks[event] ?? []), ...entries];
      }
    } catch {
      /* missing or malformed — skip */
    }
  }

  // Dedupe entries per event by JSON signature — keeps the first occurrence.
  // Closes the case where a previous rematerialize wrote cue's hooks to the
  // runtime settings.json, then this rematerialize reads them back as
  // baseSettings (line ~691) AND re-appends from declaredHooks below, silently
  // 2× hooks per rematerialize cycle. Dedupe at the end is cheap and removes
  // the symptom regardless of where dups came in.
  for (const event of Object.keys(mergedHooks)) {
    const seen = new Set<string>();
    mergedHooks[event] = mergedHooks[event]!.filter((entry) => {
      const sig = JSON.stringify(entry);
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
  }

  const settings: Record<string, unknown> = {
    ...baseSettings,
    // Claude's /auto-mode-setup writes environment-specific trust context to
    // the profile runtime, not the global credentials source. Carry that one
    // Claude-managed field across both cache-hit refreshes and full rebuilds.
    ...profileLocalSettings,
    // MCPs are profile-scoped — do NOT merge baseSettings.mcpServers in.
    // Otherwise every MCP registered in the user's source ~/.claude/settings.json
    // (or ~/.claude-accounts/<acct>/settings.json) leaks into every profile's
    // runtime, defeating profile isolation. Profiles like `cybersecurity` that
    // declare `mcps: []` would otherwise show whatever the user has globally.
    mcpServers,
    // Same reasoning for plugins: profile is the source of truth. `enabledPlugins`
    // controls Claude Code's plugin marketplace toggles per-profile; merging from
    // baseSettings would re-enable marketing plugins inside a backend profile.
    enabledPlugins,
  };
  if (Object.keys(mergedHooks).length > 0) {
    settings.hooks = mergedHooks;
  }

  // Surface an allowlisted subset of profile.env into settings.json `env` so
  // Claude Code's cost/runtime knobs actually reach the session. profile.env is
  // otherwise consumed only for MCP-placeholder substitution (mcp-materializer)
  // and never reaches the agent process. We allowlist deliberately: profile.env
  // also holds secret references like "${AWS_SECRET_ACCESS_KEY}" that must NOT
  // be written into settings.json. Gated to claude-code (these keys are
  // Claude-Code-specific; codex uses its own config). Set in `core` so it fans
  // out to every inheriting profile — e.g. CLAUDE_CODE_SUBAGENT_MODEL pins
  // subagents to Sonnet, ~50-60% cheaper than Opus on file-read/grep/review.
  if (agent === "claude-code") {
    // Allowlist of Claude-Code cost/runtime knobs that may flow from profile.env
    // into settings.json. To surface a new one, append its key here.
    const CLAUDE_RUNTIME_ENV_KEYS = [
      "CLAUDE_CODE_SUBAGENT_MODEL", // run Task/Agent subagents on a cheaper model
      "ANTHROPIC_BASE_URL", // route Claude traffic through a local proxy (e.g. the headroom compression wrap). Health-gated below: a loopback URL is dropped when the proxy isn't answering, so a dead proxy falls back to direct Anthropic instead of bricking Claude.
    ];
    // Preserve any account-level env from credentialsSource (spread in via
    // baseSettings above); profile-declared keys overlay it (profile is more
    // specific). Skip unset values and unresolved placeholders — the `${`
    // check is deliberately conservative: any "${...}"-shaped value is treated
    // as an unresolved secret reference and dropped, never written out.
    const runtimeEnv: Record<string, string> = {
      ...((settings.env as Record<string, string> | undefined) ?? {}),
    };
    for (const key of CLAUDE_RUNTIME_ENV_KEYS) {
      const val = profile.env?.[key];
      if (typeof val !== "string" || val.length === 0 || val.includes("${")) {
        continue;
      }
      // Health-gate the proxy wrap. ANTHROPIC_BASE_URL pointed at an unreachable
      // local proxy would make Claude unable to reach Anthropic at all. Only
      // surface it when a loopback proxy actually answers; otherwise drop it
      // (fail-open to direct Anthropic) and warn. Non-loopback URLs are not
      // gated — they're assumed to be a deliberately-managed remote endpoint.
      const proxyHealthCheck = input.proxyHealthCheck ?? isProxyReachable;
      if (key === "ANTHROPIC_BASE_URL" && !(await proxyHealthCheck(val))) {
        console.warn(
          `[cue] ANTHROPIC_BASE_URL=${val} is unreachable — dropping the proxy ` +
            `wrap for profile "${profile.name}"; Claude will talk to Anthropic ` +
            `directly. Start the proxy (e.g. \`systemctl --user start headroom-proxy\`) ` +
            `to enable compression.`,
        );
        continue;
      }
      runtimeEnv[key] = val;
    }
    if (Object.keys(runtimeEnv).length > 0) {
      settings.env = runtimeEnv;
    }
  }

  return JSON.stringify(settings, null, 2);
}

async function readClaudeProfileLocalSettings(
  runtimeDir: string,
): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(
      await readFile(join(runtimeDir, "settings.json"), "utf8"),
    ) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const settings = parsed as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(settings, "autoMode")) {
      return { autoMode: settings.autoMode };
    }
  } catch {
    /* first build or malformed old settings — use credentials source only */
  }
  return {};
}

// ---------------------------------------------------------------------------
// #8: Warm-start — summarize last session for this profile
// ---------------------------------------------------------------------------

import { homedir } from "node:os";
import { readdirSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

export async function getLastSessionSummary(
  profileName: string,
  projectsDir = join(homedir(), ".claude", "projects"),
): Promise<string | null> {
  try {
    if (!existsSync(projectsDir)) return null;

    // Find the most recent session jsonl in the cwd-based project dir
    const cwdKey = process.cwd().replace(/\//g, "-");
    const projectDir = readdirSync(projectsDir)
      .filter((d) => d.includes(cwdKey.slice(1, 30)))
      .map((d) => join(projectsDir, d))
      .find((d) => existsSync(d));

    if (!projectDir) return null;

    // Find most recent .jsonl (limit scan to avoid slow stat on large dirs)
    const allFiles = readdirSync(projectDir).filter((f) =>
      f.endsWith(".jsonl"),
    );
    if (allFiles.length === 0) return null;

    // Sort by name (includes timestamp) — take last 3 only
    const recent = allFiles.sort().slice(-3);
    const sessions = recent
      .map((f) => ({ name: f, mtime: statSync(join(projectDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    const lastFile = join(projectDir, sessions[0]!.name);
    const lastMtime = new Date(sessions[0]!.mtime);
    const ago = formatTimeAgo(lastMtime);

    // Extract a quick summary: last few assistant messages
    const res = spawnSync("tail", ["-50", lastFile], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 2000,
    });
    if (!res.stdout) return null;

    const lines = res.stdout.split("\n").filter(Boolean);
    const summaryParts: string[] = [];

    for (const line of lines.reverse()) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "assistant" && msg.message?.content) {
          const text = Array.isArray(msg.message.content)
            ? (msg.message.content.find((c: any) => c.type === "text")?.text ??
              "")
            : typeof msg.message.content === "string"
              ? msg.message.content
              : "";
          if (text.length > 20) {
            // Take first sentence
            const sentence = text.split(/[.!?\n]/)[0]?.trim();
            if (sentence && sentence.length > 10) summaryParts.push(sentence);
          }
        }
      } catch {}
      if (summaryParts.length >= 3) break;
    }

    if (summaryParts.length === 0) return null;

    return `Last session (${ago}): ${summaryParts.reverse().join(". ")}.`;
  } catch {
    return null;
  }
}

function formatTimeAgo(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// #9: Skill chaining — detect common skill sequences from usage
// ---------------------------------------------------------------------------

export async function getSkillChains(
  skillsList: string[],
  projectsDir = join(homedir(), ".claude", "projects"),
): Promise<string | null> {
  try {
    if (!existsSync(projectsDir)) return null;

    // Scan recent sessions for skill co-occurrence
    const slugs = new Set(skillsList.map((s) => s.split("/").pop() ?? s));

    const res = spawnSync(
      "grep",
      ["-roh", "skills/[a-z][a-z0-9-]*/SKILL.md", projectsDir],
      {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: 2000,
      },
    );

    if (!res.stdout) return null;

    // We can't easily get per-file grouping from grep -r, so use a simpler heuristic:
    // just find which skills from THIS profile are most commonly used together
    const skillCounts = new Map<string, number>();
    for (const line of res.stdout.split("\n")) {
      const match = line.match(/skills\/([a-z][a-z0-9-]*)\/SKILL\.md/);
      if (match && slugs.has(match[1]!)) {
        skillCounts.set(match[1]!, (skillCounts.get(match[1]!) ?? 0) + 1);
      }
    }

    // Find top 3 most-used skills and present as a workflow hint
    const topSkills = [...skillCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([s]) => s);

    if (topSkills.length < 2) return null;

    // Build a simple chain from the top skills
    return (
      `Based on your usage patterns, common skill sequences:\n` +
      `- ${topSkills.slice(0, 3).join(" → ")}\n` +
      (topSkills.length > 3 ? `- ${topSkills.slice(2, 5).join(" → ")}\n` : "")
    );
  } catch {
    return null;
  }
}
