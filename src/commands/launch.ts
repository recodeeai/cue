/**
 * `cue launch <agent>` — the hot path.
 *
 * Flow: resolve(cwd) → if none, runPicker() → materializeRuntime() → exec.
 *
 * Bypass paths:
 *   CUE_BYPASS=1           exec the real binary and nothing else — no resolve,
 *                          no materialize, no profile, no config dir
 *   --cue-profile <name>   force this profile
 *   bare claude/codex      open picker in an interactive terminal
 *   --cue-pick             always open picker (ignore pins)
 *                          (CUE_ALWAYS_PICK=1 also opens it for interactive
 *                           launches that pass agent arguments)
 *   --dry-run              everything except the final exec; prints env
 *
 * Recursion guard via a CUE_LAUNCHING depth counter in the child env.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { configDir } from "../lib/config-paths";
import { touchRuntime, maybeAutoGc } from "../lib/runtime-gc";
import { debug } from "../lib/debug-log";
import { syncCodexAuth } from "../lib/codex-auth";
import {
  canonicalCodexAuthPath,
  canonicalCodexConfigPath,
  canonicalCodexHome,
  discoverCodexSkillFiles,
} from "../lib/codex-config";
import {
  computeTokenBreakdown,
  computeContextBudget,
  formatContextBudgetWarning,
  splitSkillBytes,
  tokenLevelEmoji,
  type SkillTokens,
  type TokenBreakdown,
} from "../lib/token-budget";

import {
  loadProfile,
  listProfiles,
  listFeaturedProfiles,
  parseProfileSelector,
} from "../lib/profile-loader";
import { resolveProfileForCwd } from "../lib/cwd-resolver";
import { withCodexPonytail } from "../lib/codex-ponytail";
import {
  DIVIDER_PREFIX,
  dedupeSelectorParts,
  runPicker,
  type PickerOption,
  type ProfileTally,
} from "../lib/picker";
import type { ComboUsage } from "../lib/combo-history";
import {
  materializeRuntime,
  runtimePathKey,
} from "../lib/runtime-materializer";
import {
  agentLaunchAccent,
  agentLaunchMessage,
  startLoader,
} from "../lib/launch-loader";
import { ensureClaudeLogoPath } from "../lib/claude-logo";
import { resolveLocalSkill } from "../lib/resolver-local";
import {
  resolveNpxDetailed,
  type NpxEntryFailure,
} from "../lib/resolver-npx";
import {
  expandSkillWildcards,
  loadMcpRegistry,
  resolveClaudeCredentialsSource as resolveSharedClaudeCredentialsSource,
  runtimeDirFor,
} from "../lib/runtime-install";
import {
  detectKittyTerminal,
  kittyPlaceholderLabel,
  transmitKittyImage,
} from "../lib/kitty-image";
import { computeStats } from "../lib/analytics";
import { countProfileSkills, profileSkillIds } from "../lib/profile-capabilities";
import { detectProfileV2, type DetectionResultV2 } from "../lib/auto-detect";
import {
  detectCompanions,
  serviceCompanions,
  type CompanionSignal,
} from "../lib/companion-detect";
import type { LinkPlan, ResolvedProfile } from "../../profiles/_types";
import type {
  ProfileAffinity,
  UniversalSuggestion,
} from "../lib/pair-suggestions";
import {
  hasWorkspaces,
  getActiveWorkspace,
  computeOverrides,
  resolveWorkspaceForCwd,
} from "../lib/workspaces";
import {
  launchDepth,
  MAX_LAUNCH_DEPTH,
  shouldForcePicker,
  shouldInheritSessionProfile,
} from "../lib/launch-guards";
import { shimDir, stripShimDirFromPath } from "../lib/shim-dir";
import { needsWindowsCommandShell } from "../lib/claude-binary";

export {
  isAlwaysPickEnabled,
  launchDepth,
  MAX_LAUNCH_DEPTH,
  shouldForcePicker,
  shouldInheritSessionProfile,
} from "../lib/launch-guards";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  agent: "claude" | "codex" | null;
  override: string | null;
  forcePick: boolean;
  dryRun: boolean;
  rematerialize: boolean;
  /** `--subset "<prompt>"` — filter skills to those relevant to the prompt before materializing. */
  subset: string | null;
  /** True only when `subset` came from an explicit `--subset` flag (not the
   *  CUE_SMART_SUBSET env fold of a `-p` prompt). Explicit intent bypasses the
   *  keep-set cache so the user gets a fresh classification; the env-folded
   *  path uses the cache so repeat `-p` launches don't re-call the classifier. */
  subsetExplicit: boolean;
  /** `--cue-pick-mcps` — always re-open the MCP toggle, ignoring a remembered choice. */
  forcePickMcps: boolean;
  /** `--cue-full` — skip the project loadout for this launch (materialize every skill). */
  fullLoad: boolean;
  /** `--disable-mcp <id>` (repeatable) — drop these MCPs for THIS launch only
   *  (pinned ones excepted); session-scoped, not written as a remembered
   *  override. Persist a choice via the interactive picker / `--cue-pick-mcps`. */
  disableMcp: string[];
  // Env `CUE_PRUNE_MCPS=auto|unused|profile|all|1|true|on` — non-interactive auto-prune: drop
  // every MCP no active skill references (pinned excepted). Read inline at launch,
  // not a parsed flag. A remembered picker override or `--disable-mcp` takes
  // precedence; default (unset) stays fail-open and keeps all MCPs.
  passthrough: string[];
}

/**
 * The `CUE_BYPASS=1` escape hatch: cue does nothing but exec the real agent.
 *
 * Exactly `"1"`, matching every other reader of the flag (`launch-loader.ts`).
 * Deliberately not the looser 1/true/on set `isAlwaysPickEnabled` accepts —
 * this one is documented as `CUE_BYPASS=1` in both docs and every internal
 * caller sets it that way.
 */
export function isBypassEnabled(
  envVal: string | undefined = process.env.CUE_BYPASS,
): boolean {
  return envVal === "1";
}

/**
 * The prompt buried in an agent's passthrough argv, or "" when there isn't one.
 *
 * `CUE_SMART_SUBSET` folds a real prompt (`claude -p "fix the auth bug"`) into
 * the subset classifier. A switch is not a prompt: folding the whole argv hands
 * the classifier a flag to interpret, and it dutifully obliges — `codex
 * --madmax` measured as `smart-subset: 4/21 skills kept — "--madmax" likely
 * refers to a cue profile`, gutting the profile the user had just picked.
 *
 * So every `-`-leading token drops out and the rest is kept, including the
 * value that follows a flag: in the case this fold exists for, `-p`'s value IS
 * the prompt. That leaves `--model haiku` folding as `haiku` — imprecise, but
 * strictly closer than the `--model haiku` it used to send.
 */
export function passthroughPrompt(passthrough: readonly string[]): string {
  return passthrough
    .filter((arg) => !arg.startsWith("-"))
    .join(" ")
    .trim();
}

function parse(args: string[]): ParsedArgs {
  let agent: ParsedArgs["agent"] = null;
  let override: string | null = null;
  let forcePick = false;
  let dryRun = false;
  let rematerialize = false;
  let subset: string | null = null;
  let forcePickMcps = false;
  let fullLoad = false;
  const disableMcp: string[] = [];
  const passthrough: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      // Conventional separator: everything after it belongs to the agent,
      // verbatim. The `--` itself must NOT reach the agent — `claude -- --version`
      // makes claude treat "--version" as a PROMPT and open an interactive
      // session, which hangs forever when stdin isn't a terminal.
      passthrough.push(...args.slice(i + 1).map((s) => s!));
      break;
    }
    if (i === 0 && (a === "claude" || a === "codex")) {
      agent = a;
    } else if (a === "--cue-profile") {
      override = args[++i] ?? null;
    } else if (a === "--cue-pick") {
      forcePick = true;
    } else if (a === "--cue-pick-mcps") {
      forcePickMcps = true;
    } else if (a === "--cue-full") {
      fullLoad = true;
    } else if (a === "--disable-mcp") {
      const id = args[++i];
      if (id) disableMcp.push(id);
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--rematerialize") {
      rematerialize = true;
    } else if (a === "--subset") {
      subset = args[++i] ?? null;
    } else {
      passthrough.push(a!);
    }
  }
  const subsetExplicit = subset !== null;
  // Env var fallback for users who want subset on every launch without retyping.
  // Folds a real passthrough prompt (`claude -p "…"`) into `subset` so it drives
  // classification, but leaves `subsetExplicit` false so it uses the keep-set
  // cache — repeat identical `-p` launches don't re-call the classifier.
  //
  // CUE_BYPASS gates the fold, as a second line of defense behind the
  // short-circuit in `run()` — under a real bypass this parse result never
  // reaches the classifier at all. Kept because the fold is the specific thing
  // that turned a re-entered shim into a memory bomb: the classifiers spawn
  // `claude` themselves, and on a machine with cue's shims first on PATH that
  // lands back here. Unguarded, the child's own argv (`--print --model haiku -p
  // "<prompt>"`) becomes the next classification prompt, which spawns another
  // classifier, which folds ITS argv, and so on — each level a full ~400MB
  // claude process carrying every previous level's argv.
  //
  // MAX_LAUNCH_DEPTH already bounds the PROCESS nesting at 3, so this was never
  // unbounded recursion. What it was is waste: measured on a live machine, one
  // classifier carried a 67KB command line with the prompt template repeated 10
  // times, and 7 concurrent classifier processes (across simultaneously
  // launching sessions) held ~2.9GB. An explicit `--subset` still wins, so a
  // deliberate override is never silently dropped.
  //
  // Only the PROSE in passthrough folds — see `passthroughPrompt`. A bare flag
  // (`codex --madmax`, `claude --resume`) carries no prompt, so it leaves the
  // subset unset and the full profile loads.
  const bypassed = isBypassEnabled();
  if (
    !subset &&
    !bypassed &&
    process.env.CUE_SMART_SUBSET &&
    passthrough.length > 0
  ) {
    subset = passthroughPrompt(passthrough) || null;
  }
  return {
    agent,
    override,
    forcePick,
    forcePickMcps,
    fullLoad,
    disableMcp,
    dryRun,
    rematerialize,
    subset,
    subsetExplicit,
    passthrough,
  };
}

/** Test-only surface. */
export const __test = { parse, shouldOpenMcpPicker, listProfileOptions };

// ---------------------------------------------------------------------------
// Workspace overrides — merge active workspace env into profile
// ---------------------------------------------------------------------------

async function applyWorkspaceOverrides(
  profile: ResolvedProfile,
): Promise<ResolvedProfile> {
  if (!hasWorkspaces(profile.name)) return profile;

  // Feature 4: .cue-workspace auto-switch takes precedence over global active
  const cwdWs = resolveWorkspaceForCwd(profile.name, process.cwd());
  const activeWs = cwdWs ?? getActiveWorkspace(profile.name);
  if (!activeWs) return profile;

  const overrides = computeOverrides(profile.name, activeWs);
  if (!overrides) return profile;

  let result: ResolvedProfile = {
    ...profile,
    env: { ...profile.env, ...overrides.env },
  };

  // Feature 6: Workspace persona override replaces profile persona
  if (overrides.personaOverride) {
    result = { ...result, persona: overrides.personaOverride };
  }

  // Feature 2: Workspace-specific skills appended to profile.skills.local
  if (overrides.skills && overrides.skills.length > 0) {
    const existingIds = new Set(result.skills.local.map((s) => s.id));
    const newSkills = overrides.skills
      .filter((id) => !existingIds.has(id))
      .map((id) => ({ id }));
    result = {
      ...result,
      skills: {
        ...result.skills,
        local: [...result.skills.local, ...newSkills],
      },
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Exec helper — spawn with inherited stdio so interactive sessions work
// ---------------------------------------------------------------------------

function execAgent(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((res) => {
    const child = spawn(bin, args, {
      env,
      stdio: "inherit",
      shell: needsWindowsCommandShell(bin),
    });
    child.on("exit", (code) => res(code ?? 0));
    child.on("error", () => res(127));
  });
}

/**
 * Whether the interactive MCP toggle should open this launch. Only when stdin
 * is a TTY, AND either the user forced it (`--cue-pick-mcps`) or there's no
 * valid remembered choice to honor. A remembered override alone keeps the
 * toggle closed — picking a profile interactively no longer re-forces it.
 */
export function shouldOpenMcpPicker(opts: {
  interactive: boolean;
  forcePickMcps: boolean;
  overrideValid: boolean;
}): boolean {
  return opts.interactive && (opts.forcePickMcps || !opts.overrideValid);
}

function isAgentHelpPassthrough(parsed: ParsedArgs): boolean {
  return (
    !parsed.override &&
    !parsed.forcePick &&
    !parsed.dryRun &&
    !parsed.rematerialize &&
    parsed.subset === null &&
    parsed.passthrough.length === 1 &&
    (parsed.passthrough[0] === "--help" || parsed.passthrough[0] === "-h")
  );
}

export interface TmuxAnnounceExtras {
  /** Token-overhead summary: dot = 🟢/🟡/🟠/🔴, size = "8K". Both optional. */
  overhead?: { dot: string; size: string };
  /** "!" when quickDiagnose returned warnings; "" otherwise. */
  health?: string;
}

/**
 * Surface the active profile to tmux so status lines can show what's loaded.
 * Channels (pick whichever fits the user's setup):
 *   1. OSC 2 pane title — zero-config; tmux exposes it as `#{pane_title}`.
 *   2. tmux pane-local user options:
 *        @cue_profile          full styled string
 *        @cue_profile_name     "postizz+blog-writer+trendradar"
 *        @cue_profile_icon     primary icon only: "📮"
 *        @cue_profile_icons    every part's icon concatenated: "📮✍️📡"
 *        @cue_agent            "claude" / "codex"
 *        @cue_overhead_dot     "🟢"/"🟡"/"🟠"/"🔴" — token band of always-on overhead
 *        @cue_overhead_size    "8K" — total always-on size
 *        @cue_health           "!" when doctor flagged issues, "" when clean
 *   3. CUE_PROFILE / CUE_AGENT env vars on the child — for shell prompts.
 *
 * No-op outside tmux. Opt-out via `CUE_TMUX_TITLE=0`.
 *
 * `icons` is an array of one entry per profile part, primary first. Empty
 * strings are filtered out so missing icons don't introduce padding.
 */
/**
 * Build the visible tmux pane title for an active cue profile.
 *
 * Layout collapses gracefully as the composite grows:
 *   - 1 part:   `claude · 🦊 medusa-dev`
 *   - 2 parts:  `claude · 🦊 medusa-dev + 🌐 backend`
 *   - 3+ parts: `claude · 🦊 medusa-dev +3`
 *
 * `icons` is parallel to the `+`-split of `profileName` (one per part);
 * empty entries are tolerated and just drop the icon prefix for that part.
 * Exported only for tests.
 */
export function formatTmuxTitle(
  friendly: string,
  profileName: string,
  icons: ReadonlyArray<string>,
): string {
  const parts = profileName
    .split("+")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return friendly;
  const segment = (i: number): string => {
    const icon = (icons[i] ?? "").trim();
    const name = parts[i]!;
    return icon ? `${icon} ${name}` : name;
  };
  if (parts.length === 1) return `${friendly} · ${segment(0)}`;
  if (parts.length === 2) return `${friendly} · ${segment(0)} + ${segment(1)}`;
  // 3+ parts: lead with primary, collapse the tail to a numeric badge so
  // long composites don't shove the tab title off-screen.
  return `${friendly} · ${segment(0)} +${parts.length - 1}`;
}

/** Field separator for the batched option read-back. Never appears in a value. */
const UNIT_SEP = "\x1f";

/**
 * Whether this launch owns the pane's cue badge.
 *
 * Only an interactive launch does. The `--print` skill-selector cue spawns on
 * every session start inherits TMUX_PANE from the session it is helping, so
 * letting it announce would overwrite that session's badge and then clear it
 * again on exit seconds later — the pane border visibly loses its profile name
 * while the session is still running. A piped or redirected stdout is what
 * separates those helper runs from the session the user is looking at.
 */
export function ownsPaneBadge(
  env: NodeJS.ProcessEnv,
  stdoutIsTty: boolean,
): boolean {
  return Boolean(env.TMUX) && env.CUE_TMUX_TITLE !== "0" && stdoutIsTty;
}

function announceTmuxProfile(
  profileName: string,
  agentKind: string,
  icons: string[],
  childEnv: NodeJS.ProcessEnv,
  extras: TmuxAnnounceExtras = {},
): void {
  const friendly = agentKind === "claude-code" ? "claude" : agentKind;
  childEnv.CUE_PROFILE = profileName;
  childEnv.CUE_AGENT = friendly;

  if (!ownsPaneBadge(process.env, process.stdout.isTTY === true)) return;
  const cleanIcons = icons.filter((i) => i && i.trim().length > 0);
  // Keep the concatenated icon strip as a separate tmux option for status
  // lines that want every icon at a glance — the visible *title* below uses
  // a more compact layout.
  const iconStr = cleanIcons.join("");
  const primaryIcon = cleanIcons[0] ?? "";
  const title = formatTmuxTitle(friendly, profileName, icons);
  const pane = process.env.TMUX_PANE ?? "";

  try {
    process.stdout.write(`\x1b]2;${title}\x07`);
  } catch {
    /* best-effort */
  }

  // Exactly what we wrote, so the exit sweep can tell our own badge from one a
  // nested launch installed over it — clearing that one blanks the border for a
  // session still running.
  const applied = new Map<string, string>();

  if (pane) {
    try {
      const { spawnSync } = require("node:child_process");
      // One tmux invocation for all eight options. Measured on a live server:
      // eight separate spawns cost ~81ms, the batched form ~11ms — and this
      // runs on the launch path, in front of the agent the user is waiting on.
      // The pane border also stops rendering half-set states on the way in.
      const args: string[] = [];
      const setOpt = (key: string, val: string) => {
        if (args.length > 0) args.push(";");
        args.push("set-option", "-p", "-t", pane, key, val);
        applied.set(key, val);
      };
      setOpt("@cue_profile", title);
      setOpt("@cue_profile_name", profileName);
      setOpt("@cue_profile_icon", primaryIcon);
      setOpt("@cue_profile_icons", iconStr);
      setOpt("@cue_agent", friendly);
      setOpt("@cue_overhead_dot", extras.overhead?.dot ?? "");
      setOpt("@cue_overhead_size", extras.overhead?.size ?? "");
      setOpt("@cue_health", extras.health ?? "");
      spawnSync("tmux", args, { stdio: "ignore" });
    } catch {
      /* best-effort */
    }
  }

  process.on("exit", () => {
    try {
      process.stdout.write("\x1b]2;\x07");
    } catch {
      /* ok */
    }
    if (pane && applied.size > 0) {
      try {
        const { spawnSync } = require("node:child_process");
        const keys = [...applied.keys()];
        // Read all eight back in one spawn. A launch that started after us owns
        // the badge now, and clearing its values would blank the border for a
        // session still running — so only unset what still holds our value.
        // Must stay synchronous: process.on("exit") handlers cannot await.
        const probe = spawnSync(
          "tmux",
          [
            "display-message",
            "-p",
            "-t",
            pane,
            keys.map((k) => `#{${k}}`).join(UNIT_SEP),
          ],
          { encoding: "utf8" },
        );
        // A failed probe leaves the options in place. Leaking a stale badge is
        // recoverable — the next launch overwrites it — whereas clearing one we
        // no longer own is not.
        const live =
          probe.status === 0
            ? String(probe.stdout).replace(/\n$/, "").split(UNIT_SEP)
            : [];
        // Same batching as the set path. This one runs inside an `exit`
        // handler, where every spawnSync is time the process spends refusing
        // to die.
        const args: string[] = [];
        keys.forEach((key, i) => {
          if (live[i] !== applied.get(key)) return;
          if (args.length > 0) args.push(";");
          args.push("set-option", "-p", "-u", "-t", pane, key);
        });
        if (args.length > 0) spawnSync("tmux", args, { stdio: "ignore" });
      } catch {
        /* ok */
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Expand the wildcard `* /*` skill ref (slash-escaped here to avoid closing
 * this JSDoc) to the full set of installed local skill IDs. Mutates
 * `profile.skills.local` in place. Other refs are preserved and any
 * wildcards inherit the original ref's metadata (agents scoping, etc.).
 *
 * Used by both the launch hot path and the picker `details` callback so the
 * shown summary matches what materializeRuntime will actually link.
 */
const expandWildcards = expandSkillWildcards;

/**
 * Compact human-readable summary of what a profile would load. Each returned
 * string is one line (or wrapped block) in the picker's post-pick log.
 *
 * When `parts` is supplied and contains more than one entry, the summary
 * shows a composite breakdown after the skills count — e.g.
 * `skills    53  ← skill-writer:8 + core:12 + ecc:33`.
 *
 * Colors are emitted only when stdout is a TTY and `NO_COLOR` is unset.
 */
const LIST_TRUNCATE = 8;
const BREAKDOWN_MAX = 6; // per-profile skill breakdown cap before "+N more"
const COMMANDS_PER_LINE = 4;
const LABEL_WIDTH = 10; // "commands  " — keep visually aligned

export function formatProfileSummary(
  profile: ResolvedProfile,
  parts?: ResolvedProfile[],
): string[] {
  const c = colorFns();
  const label = (s: string) => c.cyan(s.padEnd(LABEL_WIDTH));
  const indent = " ".repeat(LABEL_WIDTH);
  const lines: string[] = [];

  const localCount = profile.skills.local.length;
  const npxCount = profile.skills.npx.reduce((sum, source) => sum + source.skills.length, 0);
  const totalSkills = countProfileSkills(profile);
  if (totalSkills > 0) {
    const breakdown =
      npxCount > 0 ? ` (${localCount} local, ${npxCount} npx)` : "";
    let line = `${label("skills")}${c.yellow(String(totalSkills))}${c.dim(breakdown)}`;
    if (parts && parts.length > 1) {
      const segs = parts.map(
        (p) =>
          `${p.icon ? `${p.icon} ` : ""}${p.name}:${countProfileSkills(p)}`,
      );
      // Cap the per-profile breakdown so a fat composite doesn't wrap into a
      // multi-line wall — the headline total already carries the full picture.
      const shown =
        segs.length > BREAKDOWN_MAX
          ? `${segs.slice(0, BREAKDOWN_MAX).join(" + ")} +${segs.length - BREAKDOWN_MAX} more`
          : segs.join(" + ");
      line += `  ${c.dim("←")} ${c.dim(shown)}`;
    }
    lines.push(line);
    if (localCount >= 5) {
      const cats = categoryBreakdown(profile.skills.local.map((s) => s.id));
      if (cats) lines.push(`${indent}${c.dim(cats)}`);
    }
  }
  if (profile.mcps.length > 0) {
    lines.push(
      `${label("mcps")}${truncateList(profile.mcps.map((m) => m.id))}`,
    );
  }
  if (profile.plugins.length > 0) {
    lines.push(
      `${label("plugins")}${truncateList(profile.plugins.map((pl) => pl.id))}`,
    );
  }
  if (profile.commands && profile.commands.length > 0) {
    const slashed = profile.commands.map((cmd) => `/${basename(cmd, ".md")}`);
    lines.push(
      `${label("commands")}${wrapItems(slashed, COMMANDS_PER_LINE, LABEL_WIDTH)}`,
    );
  }
  if (profile.agents && profile.agents.length > 0) {
    lines.push(`${label("agents")}${profile.agents.join("  ")}`);
  }
  return lines;
}

/**
 * Group skill ids by their `<category>/<slug>` prefix and emit a compact
 * `meta:25  gstack:16  plan:5 …` summary. Sorted by descending count.
 * Returns "" when there are no skills.
 */
export function categoryBreakdown(skillIds: string[], max = 7): string {
  if (skillIds.length === 0) return "";
  const groups = new Map<string, number>();
  for (const id of skillIds) {
    const parts = id.split("/");
    const cat = parts.length > 1 ? parts[0]! : "other";
    groups.set(cat, (groups.get(cat) ?? 0) + 1);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1] - a[1]);
  const head = sorted
    .slice(0, max)
    .map(([cat, n]) => `${cat}:${n}`)
    .join("  ");
  if (sorted.length > max) {
    return `${head}  +${sorted.length - max} cats`;
  }
  return head;
}

/** Wrap a list of items into rows of `perRow`, separated by two spaces, with
 * continuation lines indented to align with the first item. */
function wrapItems(items: string[], perRow: number, indent: number): string {
  const rows: string[] = [];
  for (let i = 0; i < items.length; i += perRow) {
    rows.push(items.slice(i, i + perRow).join("  "));
  }
  const pad = " ".repeat(indent);
  return rows.join(`\n${pad}`);
}

function truncateList(items: string[], max = LIST_TRUNCATE): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")}, +${items.length - max} more`;
}

/** Lazy color helpers. Disabled when stdout isn't a TTY or `NO_COLOR` is set. */
function colorFns() {
  const enabled = process.stdout.isTTY === true && !process.env.NO_COLOR;
  const wrap = (code: string) => (s: string) =>
    enabled ? `\x1b[${code}m${s}\x1b[0m` : s;
  return {
    cyan: wrap("36"),
    yellow: wrap("33"),
    dim: wrap("2"),
    bold: wrap("1"),
  };
}

// ---------------------------------------------------------------------------
// Token-overhead breakdown
//
// Claude Code skills use progressive disclosure: the YAML frontmatter
// (name + description) is always in the model's system prompt so it can
// decide when to invoke a skill; the body only loads when the skill fires.
// So the *real* always-on overhead is the frontmatter sum — not the body
// sum, which is only the ceiling if every skill activates in one session.
//
// Two pure helpers below (testable without filesystem) plus an orchestrator
// at the call site that supplies them with real file measurements.
// ---------------------------------------------------------------------------

// Token-budget math (SkillTokens, TokenBreakdown, computeTokenBreakdown,
// splitSkillBytes, tokenLevelEmoji) moved to lib/token-budget.ts. Re-exported
// here so existing importers of these from "./launch" keep resolving.
export {
  computeTokenBreakdown,
  splitSkillBytes,
  tokenLevelEmoji,
  type SkillTokens,
  type TokenBreakdown,
} from "../lib/token-budget";
/** Format the token-overhead block. Returns `[]` under the 2K always-on floor. */
export function formatTokenWarning(b: TokenBreakdown): string[] {
  if (b.alwaysOn < 2000) return [];
  const c = colorFns();
  const lines: string[] = [];
  const level = tokenLevelEmoji(b.alwaysOn);
  const alwaysK = `${(b.alwaysOn / 1000).toFixed(1)}K`;
  lines.push(
    `${level} Skill overhead: ${c.yellow(`~${alwaysK}`)} always-on (${b.totalSkills} skills)`,
  );
  if (b.alwaysOn >= 50_000) {
    lines.push(
      `   ${c.yellow("Very heavy profile:")} prefer \`core\` or a narrow stack; use \`--subset "<task>"\` before launching broad composites.`,
    );
  }

  // `byProfile[0]` is the primary (the profile the user actively picked);
  // the rest are companions added via the multiselect. We tag whichever part
  // weighs the most as "← heaviest" purely for info, but only consider
  // *companions* as candidates for the "Drop X" hint below — telling the
  // user to drop their primary is never the right advice.
  let heaviestPart: { name: string; tokens: number } | undefined;
  let heaviestDroppable: { name: string; tokens: number } | undefined;
  if (b.byProfile.length > 1) {
    heaviestPart = [...b.byProfile].sort((a, x) => x.tokens - a.tokens)[0];
    heaviestDroppable = [...b.byProfile.slice(1)].sort(
      (a, x) => x.tokens - a.tokens,
    )[0];
    const heaviestName = heaviestPart!.name;
    const segments = b.byProfile.map((p) => {
      const kStr = `${(p.tokens / 1000).toFixed(1)}K`;
      const iconPart = p.icon ? `${p.icon} ` : "";
      const label = `${iconPart}${p.name} ${kStr}`;
      return p.name === heaviestName
        ? `${c.bold(label)} ${c.dim("← heaviest")}`
        : c.dim(label);
    });
    lines.push(`   By profile:  ${segments.join(c.dim("  ·  "))}`);
  }

  if (b.maxIfAllActivate > 0) {
    const maxK = `${(b.maxIfAllActivate / 1000).toFixed(0)}K`;
    lines.push(
      `   ${c.dim(`~${maxK} max if every skill activates (bodies load on demand)`)}`,
    );
  }

  const top3 = b.heaviestBodies.slice(0, 3);
  if (top3.length > 0) {
    const items = top3
      .map((s) => `${s.id.split("/").pop()} (${(s.tokens / 1000).toFixed(1)}K)`)
      .join(", ");
    lines.push(`   ${c.dim(`Heaviest bodies:  ${items}`)}`);
  }

  if (heaviestDroppable && heaviestDroppable.tokens > 3000) {
    const saveK = `${(heaviestDroppable.tokens / 1000).toFixed(1)}K`;
    lines.push(
      `   💡 Drop ${c.bold(`"${heaviestDroppable.name}"`)} to save ~${saveK} always-on`,
    );
  } else if (b.alwaysOn > 10000) {
    lines.push(`   💡 Run \`cue skills audit\` to trim unused skills.`);
  }

  return lines;
}

/**
 * Format the single-line startup identity banner shown on every warm launch.
 * Confirms what you landed in: agent · icon+profile (collapsed to `primary +N`
 * for composites, via formatTmuxTitle) · skill and MCP counts · the always-on
 * token cost. The token segment is omitted under the 2K floor; a `→ cue cost`
 * pointer is appended only for genuinely heavy profiles. The full breakdown —
 * per-profile attribution, heaviest bodies — lives in `cue cost`.
 */
const BANNER_TOKEN_FLOOR = 2000;
const BANNER_HEAVY = 10_000;

export interface StartupBannerInfo {
  /** Pre-collapsed title from formatTmuxTitle, e.g. "claude · 🏭 gstack +4". */
  title: string;
  /** Total skills (local + npx). */
  skills: number;
  /** MCP server count. */
  mcps: number;
  /** Always-on token estimate, or undefined when not computed (light profile). */
  alwaysOn?: number;
}

export function formatStartupBanner(info: StartupBannerInfo): string {
  const c = colorFns();
  const segs: string[] = [`${c.cyan("▸")} ${info.title}`];
  segs.push(`${info.skills} skill${info.skills === 1 ? "" : "s"}`);
  if (info.mcps > 0) segs.push(`${info.mcps} MCP${info.mcps === 1 ? "" : "s"}`);
  if (info.alwaysOn !== undefined && info.alwaysOn >= BANNER_TOKEN_FLOOR) {
    segs.push(
      `${tokenLevelEmoji(info.alwaysOn)} ${c.yellow(`~${Math.round(info.alwaysOn / 1000)}K`)} always-on`,
    );
  }
  let line = segs.join(c.dim(" · "));
  if (info.alwaysOn !== undefined && info.alwaysOn >= BANNER_HEAVY) {
    line += c.dim(" · → cue cost");
  }
  return line;
}

// ---------------------------------------------------------------------------
// Doctor warnings — inline summary of diagnostics on first build after a
// rebuild. Replaces the older "run cue doctor to see" generic message.
// ---------------------------------------------------------------------------

export interface DoctorWarning {
  code: string;
  message: string;
}

/**
 * Format doctor warnings as a single compact line. Returns `[]` when there are
 * none. The per-warning detail lives in `cue doctor --fix`; launch only signals
 * that there's something to look at.
 */
export function formatDoctorWarnings(warnings: DoctorWarning[]): string[] {
  if (warnings.length === 0) return [];
  const c = colorFns();
  const n = warnings.length;
  return [
    `${c.yellow(`⚠ ${n} cue-doctor warning${n > 1 ? "s" : ""}`)} ${c.dim("→ cue doctor --fix")}`,
  ];
}

/**
 * Sort picker options. Pure function so tests don't need filesystem.
 *
 * Priority order:
 *   1. Pinned profile (if any) — pinned to top so resuming is one Enter.
 *   2. Used profiles, descending by session count.
 *   3. Never-used profiles, alphabetical. `full` no longer floats to the top
 *      here — it carries a NEVER-USE warning and should sit with its peers.
 */
export function sortProfileOptions(
  opts: PickerOption[],
  pinnedProfile?: string,
  usage?: Map<string, number>,
): PickerOption[] {
  return [...opts].sort((a, b) => {
    // `top` (the Default entry) always wins, regardless of pin or usage.
    if (a.top && !b.top) return -1;
    if (b.top && !a.top) return 1;
    if (a.value === pinnedProfile) return -1;
    if (b.value === pinnedProfile) return 1;
    const ua = usage?.get(a.value) ?? 0;
    const ub = usage?.get(b.value) ?? 0;
    if (ua !== ub) return ub - ua;
    return a.value.localeCompare(b.value);
  });
}

/**
 * Format a relative-time string for the picker's recent-section hints.
 * `today` / `yesterday` / `Nd ago` / ISO date. Empty string when `iso` is null.
 */
export function relativeTime(
  iso: string | null | undefined,
  now = Date.now(),
): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = now - then;
  const day = 24 * 3600 * 1000;
  if (diffMs < day) return "today";
  const days = Math.floor(diffMs / day);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toISOString().split("T")[0]!;
}

/**
 * Build a structured picker order: Default → Recent section → All section.
 *
 * Recent = top `recentLimit` profiles by session count whose `lastUsed` is
 * non-null. Empty when nothing's been used yet — the Recent divider is
 * skipped in that case so the picker stays terse for fresh installs.
 */
export interface RecentEntry {
  name: string;
  sessions: number;
  lastUsed: string | null;
}

export interface SuggestedEntry {
  /** Profile name — must match a value in `allProfileOpts`. */
  name: string;
  /** 0.0–1.0 from `detectProfileV2`. */
  confidence: number;
  /** Files / signals that drove the match — surfaced in the hint. */
  reasons: string[];
  /** AI advice is visually distinguished from deterministic detection. */
  source?: "ai" | "deterministic" | "hybrid" | "stale-hybrid";
}

/**
 * Cap on how many cwd-detected suggestions we surface at the top. Two is
 * enough to cover the "primary stack + sub-profile" case (medusa-dev +
 * medusa-next) without dominating the picker.
 */
export const MAX_SUGGESTIONS = 2;

/**
 * Combine model judgement with repository signals without inventing a weighted
 * score. Agreement leads. When they disagree, the model's first choice and the
 * detector's strongest choice both survive the two-row picker cap.
 */
export function mergeProfileSuggestions(
  advised: readonly DetectionResultV2[],
  deterministic: readonly DetectionResultV2[],
): DetectionResultV2[] {
  const deterministicByProfile = new Map(
    deterministic.map((item) => [item.profile, item]),
  );
  const seen = new Set<string>();
  const merged: DetectionResultV2[] = [];
  const add = (
    item: DetectionResultV2,
    counterpart?: DetectionResultV2,
  ): void => {
    if (seen.has(item.profile)) return;
    seen.add(item.profile);
    merged.push({
      profile: item.profile,
      confidence: Math.max(item.confidence, counterpart?.confidence ?? 0),
      reasons: [...new Set([...item.reasons, ...(counterpart?.reasons ?? [])])].slice(
        0,
        3,
      ),
    });
  };

  const consensus = advised.filter((item) =>
    deterministicByProfile.has(item.profile),
  );
  for (const item of consensus) {
    add(item, deterministicByProfile.get(item.profile));
  }

  const advisedOnly = advised.filter(
    (item) => !deterministicByProfile.has(item.profile),
  );
  const deterministicOnly = deterministic.filter(
    (item) => !seen.has(item.profile),
  );

  // No consensus: preserve one choice from each system before either can fill
  // the remaining rows. With consensus, it already represents both systems.
  if (consensus.length === 0) {
    if (advisedOnly[0]) add(advisedOnly[0]);
    if (deterministicOnly[0]) add(deterministicOnly[0]);
  }
  for (const item of advisedOnly) add(item);
  for (const item of deterministicOnly) add(item);
  return merged;
}

/**
 * Minimum confidence for a detection to appear in the Suggested section at
 * all. Below this the signal is too noisy (e.g. a stray tsconfig.json
 * suggesting "frontend") and would push real choices down the screen.
 */
export const SUGGESTED_MIN_CONFIDENCE = 0.5;

/**
 * Confidence at which the picker pre-selects the top suggestion (Enter on
 * first keystroke launches it). Below this we still SHOW the suggestion but
 * leave Default as the Enter-default so a wrong guess can't hijack the
 * common case.
 */
export const SUGGESTED_AUTO_PICK_CONFIDENCE = 0.7;

/**
 * Registered postizz brand folder names (dir basenames under
 * profiles/postizz/brands), used by the combine companion detector to suggest
 * postizz when the cwd is a brand dir. Best-effort: missing dir → empty set.
 * Resolves the profiles root exactly like listProfileOptions does.
 */
function listPostizzBrands(): Set<string> {
  try {
    const profilesRoot =
      process.env.CUE_PROFILES_DIR ??
      process.env.SOUL_PROFILES_DIR ??
      join(
        resolve(new URL(import.meta.url).pathname, "..", "..", ".."),
        "profiles",
      );
    return new Set(
      readdirSync(join(profilesRoot, "postizz", "brands"), {
        withFileTypes: true,
      })
        .filter((d) => d.isDirectory())
        .map((d) => d.name),
    );
  } catch {
    return new Set();
  }
}

// Recent now answers "what were the last N profiles I picked," not "what do
// I pick most often." It sorts strictly by lastUsed timestamp and applies no
// session-count floor — a single deliberate pick yesterday belongs in Recent
// more than a profile racked up by an inherited $HOME pin two weeks ago.

/**
 * Stack subsections to extract from "All profiles" so related profiles cluster
 * together instead of scattering across the alphabet. Order in this array is
 * the order subsections appear at the bottom of the picker.
 */
const STACK_SECTIONS: ReadonlyArray<{
  key: string;
  label: string;
  match: (value: string) => boolean;
}> = [
  {
    key: "ecommerce",
    label: "  ── Ecommerce ──",
    match: (v) => v === "ecc" || v === "resend" || /^webshop(?:-|$)/.test(v),
  },
  {
    // Must precede `creative` so `designer-medusa*` land here, not in Design.
    key: "medusa",
    label: "  ── Medusa ──",
    match: (v) => /(?:^|-)medusa(?:-|$)/.test(v),
  },
  {
    key: "web",
    label: "  ── Web Development ──",
    match: (v) =>
      v === "frontend" ||
      v === "backend" ||
      v === "backend-base" ||
      v === "vite" ||
      v === "nextjs" ||
      v === "browser" ||
      v === "web-frontend-base",
  },
  {
    key: "creative",
    label: "  ── Design & Creative ──",
    match: (v) =>
      v === "designer" ||
      v === "creative-media" ||
      v === "creativity" ||
      v === "event-design" ||
      v === "video" ||
      v === "threejs" ||
      v === "higgsfield",
  },
  {
    key: "marketing",
    label: "  ── Marketing & Social ──",
    match: (v) =>
      v === "marketing" ||
      v === "postizz" ||
      v === "instagram" ||
      v === "trendradar" ||
      v === "affiliate",
  },
  {
    key: "google",
    label: "  ── Google ──",
    match: (v) => /^google(?:-|$)/.test(v),
  },
  {
    key: "infra",
    label: "  ── Infra & Hosting ──",
    match: (v) => v === "coolify" || v === "hostinger",
  },
  {
    key: "data",
    label: "  ── Data & Compute ──",
    match: (v) =>
      v === "python" ||
      v === "go-api" ||
      v === "research" ||
      v === "predict-everything" ||
      v === "supercomputer" ||
      v === "nvidia",
  },
  {
    key: "rust",
    label: "  ── Rust ──",
    match: (v) => /(?:^|-)rust(?:-|$)/.test(v),
  },
  {
    key: "writer",
    label: "  ── Writer ──",
    // Matches skill-writer, blog-writer, docs-writer, readme-writer.
    match: (v) => /-writer$/.test(v),
  },
  {
    key: "security",
    label: "  ── Career & Security ──",
    match: (v) => v === "career" || v === "cybersecurity",
  },
];

/** Profile names hidden from the picker. Still installable via `cue use <name>`. */
const PICKER_HIDDEN_PROFILES = new Set<string>(["fleet-control"]);

/**
 * Replacement hints for profiles that exist for completeness but should rarely
 * be picked interactively (e.g. `full` loads every skill — slow and expensive).
 *
 * The "don't pick this" part is said ONCE, by the red danger tag the picker
 * attaches to these rows (see `danger` in lib/picker). This hint carries only
 * the reason. The row used to state it three times over — a yellow
 * `⚠ NEVER USE THIS` label suffix, the red tag, and a hint that repeated "do
 * not pick interactively" — which read as noise and crowded out the reason.
 */
const PICKER_WARNINGS: Record<string, { hint: string }> = {
  full: {
    hint: "kitchen sink — loads every skill; slow and expensive",
  },
};

/**
 * Resolve a picker row for a profile selector. Single profiles map straight to
 * their pre-built option (which already carries icon + `includes:` label).
 * Composite selectors (`a+b+c`) have no standalone option — historically the
 * Recent and Featured sections resolved entries with `allProfileOpts.find` and
 * dropped anything that didn't match, so every stacked pick silently vanished
 * and the section collapsed to whatever single profile happened to survive
 * (the "Recent only ever shows coolify" bug). We synthesize a row instead: the
 * label lists the parts so the stack is self-describing.
 */
function makeSelectorOption(
  selector: string,
  allProfileOpts: PickerOption[],
): PickerOption | undefined {
  // Dedupe parts up front: legacy analytics / combo history can carry a selector
  // with the same profile repeated many times (an old pre-dedup picker path
  // appended companions to the resolved profile each launch, snowballing
  // "gstack+core+…+gstack+core"). Normalize before we synthesize a row so the
  // value we pin/launch and the label we show each list every profile once.
  const parts = dedupeSelectorParts([selector]);
  const normalized = parts.join("+");
  const existing = allProfileOpts.find((o) => o.value === normalized);
  if (existing) return existing;
  // No standalone option. A composite (`a+b+c`) is a valid stacked pick we
  // synthesize a self-describing row for; a bare unknown name (one part, no
  // matching option) is a stale or deleted profile and is dropped (undefined)
  // so it never shows in the picker.
  if (parts.length <= 1) return undefined;
  // Reuse each part's own option label so the combined row carries every part's
  // icon — emoji or kitty image placeholder — e.g. "📈 improver + 🔒 secops + 🐻
  // builder" instead of bare "improver + secops + builder". Parts with no
  // resolved option (stale) fall back to the bare name.
  const label = parts
    .map((part) => allProfileOpts.find((o) => o.value === part)?.label ?? part)
    .join(" + ");
  return {
    value: normalized,
    label,
    hint: "stacked profile",
  };
}

export function buildPickerSections(
  defaultOpt: PickerOption | undefined,
  allProfileOpts: PickerOption[],
  recent: RecentEntry[],
  recentLimit = 3,
  now = Date.now(),
  suggested: SuggestedEntry[] = [],
  featured: string[] = [],
): PickerOption[] {
  const result: PickerOption[] = [];

  // Suggested section sits at the very top — above Default — so the picker
  // answers "what is this directory" before "what do you usually pick."
  // Entries must resolve to a real profile option AND clear the confidence
  // floor; otherwise we suppress the section entirely rather than show a
  // weak guess.
  const eligibleSuggestions = suggested
    .filter((s) => s.confidence >= SUGGESTED_MIN_CONFIDENCE)
    .slice(0, MAX_SUGGESTIONS)
    .map((s) => ({ ...s, opt: allProfileOpts.find((o) => o.value === s.name) }))
    .filter(
      (s): s is SuggestedEntry & { opt: PickerOption } => s.opt !== undefined,
    );
  const suggestedSet = new Set(eligibleSuggestions.map((s) => s.name));

  if (eligibleSuggestions.length > 0) {
    const sourceKinds = new Set(eligibleSuggestions.map((s) => s.source));
    const heading = sourceKinds.has("stale-hybrid")
      ? "  ── ✨ Recent AI + repository signals ──"
      : sourceKinds.has("hybrid")
        ? "  ── ✨ AI + repository signals ──"
        : sourceKinds.has("ai")
          ? "  ── ✨ AI profile advisor ──"
          : "  ── 🔍 Suggested for this cwd ──";
    result.push({
      value: `${DIVIDER_PREFIX}suggested`,
      label: heading,
      hint: "",
      divider: true,
    });
    for (const s of eligibleSuggestions) {
      const pct = Math.round(s.confidence * 100);
      const reasons = s.reasons.slice(0, 2).join(", ");
      const hint = `${pct}% match — ${reasons}`;
      result.push({ ...s.opt, hint });
    }
  }

  if (defaultOpt) result.push(defaultOpt);

  // Recent = the last N profiles the user actually picked, sorted by
  // lastUsed (most recent first). Inputs may arrive sorted by session count
  // (that's how `computeStats` returns them) so we re-sort here. Profiles
  // already surfaced in Suggested are excluded so each row appears exactly
  // once in the picker (Suggested wins over Recent on conflicts).
  const eligible = [...recent]
    .filter((r) => r.lastUsed)
    .filter((r) => !suggestedSet.has(r.name))
    // Skip the Default selector — it already has its own pinned row up top,
    // no need to echo it in Recent.
    .filter((r) => r.name !== defaultOpt?.value)
    .sort((a, b) => (b.lastUsed ?? "").localeCompare(a.lastUsed ?? ""))
    .slice(0, recentLimit)
    // Synthesize a row for composites instead of dropping them; stale single
    // profiles (no option, no `+`) still drop — see makeSelectorOption.
    .map((r) => ({ ...r, opt: makeSelectorOption(r.name, allProfileOpts) }))
    .filter(
      (r): r is RecentEntry & { opt: PickerOption } => r.opt !== undefined,
    );

  const recentSet = new Set(eligible.map((r) => r.name));

  if (eligible.length > 0) {
    result.push({
      value: `${DIVIDER_PREFIX}recent`,
      label: "  ── Recent ──",
      hint: "",
      divider: true,
    });
    for (const r of eligible) {
      const when = relativeTime(r.lastUsed, now);
      const hint = `${r.sessions}× session${r.sessions > 1 ? "s" : ""}, last ${when}`;
      result.push({ ...r.opt, hint });
    }
  }

  // Featured = curated composite/top-pick profiles (profiles/_featured.yaml),
  // surfaced below Recent so the user's go-to merged loadouts are one glance
  // away instead of buried in the alphabetical body. Items already shown in
  // Suggested or Recent are skipped so each row appears exactly once.
  const featuredEligible = featured
    .filter((name) => !suggestedSet.has(name) && !recentSet.has(name))
    // Synthesize composite rows too, so a stacked loadout (e.g. a saved
    // `medusa-vite+designer+backend`) can be featured without being dropped.
    .map((name) => makeSelectorOption(name, allProfileOpts))
    .filter((o): o is PickerOption => o !== undefined);
  const featuredSet = new Set(featuredEligible.map((o) => o.value));

  if (featuredEligible.length > 0) {
    result.push({
      value: `${DIVIDER_PREFIX}featured`,
      label: "  ── ✨ Featured ──",
      hint: "",
      divider: true,
    });
    result.push(...featuredEligible);
  }

  const rest = allProfileOpts.filter(
    (o) =>
      !recentSet.has(o.value) &&
      !suggestedSet.has(o.value) &&
      !featuredSet.has(o.value),
  );
  if (rest.length > 0) {
    result.push({
      value: `${DIVIDER_PREFIX}all`,
      label: "  ── All profiles ──",
      hint: "",
      divider: true,
    });
    // Pull stack-specific profiles (medusa, rust, …) out of the alphabetical
    // body and surface each in its own subsection so a stack is browsable as
    // one block instead of scattered across the alphabet. Within each
    // subsection the upstream sort order is preserved (already alpha).
    const grouped: PickerOption[][] = STACK_SECTIONS.map(() => []);
    const ungrouped: PickerOption[] = [];
    for (const o of rest) {
      const idx = STACK_SECTIONS.findIndex((s) => s.match(o.value));
      if (idx === -1) ungrouped.push(o);
      else grouped[idx]!.push(o);
    }
    result.push(...ungrouped);
    STACK_SECTIONS.forEach((section, idx) => {
      const items = grouped[idx]!;
      if (items.length === 0) return;
      result.push({
        value: `${DIVIDER_PREFIX}${section.key}`,
        label: section.label,
        hint: "",
        divider: true,
      });
      result.push(...items);
    });
  }

  return result;
}

/**
 * Read the user's Default-profile composition from
 * `<configDir>/default-profile`. Format: one profile name per line; `#`
 * comments and blank lines ignored. `core` is always included even if the
 * user removed it from the file. Missing file → just `core`.
 *
 * Returns the composite selector (e.g. `"core"` or `"core+skill-writer+ecc"`).
 */
export function getDefaultSelector(
  configDirPath: string = configDir(),
  readFile: (p: string) => string = (p) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require("node:fs") as typeof import("node:fs")).readFileSync(
      p,
      "utf8",
    );
  },
): string {
  const path = join(configDirPath, "default-profile");
  let extras: string[] = [];
  try {
    const raw = readFile(path);
    extras = raw
      .split(/[\n+]/)
      .map((s) => s.trim())
      .map((s) => s.replace(/#.*$/, "").trim())
      .filter((s) => s.length > 0 && s !== "core");
  } catch (err) {
    debug("launch:default-profile", err); /* missing → core only */
  }
  // Dedupe while preserving order.
  const seen = new Set<string>(["core"]);
  const parts = ["core"];
  for (const e of extras) {
    if (!seen.has(e)) {
      seen.add(e);
      parts.push(e);
    }
  }
  return parts.join("+");
}

/**
 * Everything the picker needs about this directory: the option rows plus the
 * raw signals behind them. v1 only ever needed the rows (the sections baked
 * the signals into hint strings); v2's suggestion engine ranks stacks from the
 * signals themselves, so they're returned alongside instead of re-derived.
 */
interface ProfileOptionSet {
  options: PickerOption[];
  profileNames: string[];
  /** AI-cache + deterministic merge used by the default v2 suggestion card. */
  detected: DetectionResultV2[];
  /** Rules-only signals retained for service-companion auto-selection. */
  deterministic: DetectionResultV2[];
  recents: RecentEntry[];
  recentsAreCwdScoped: boolean;
  featured: string[];
  defaultSelector?: string;
}

async function listProfileOptions(
  pinnedProfile?: string,
  preferredAgent: "claude" | "codex" = "claude",
): Promise<ProfileOptionSet> {
  const names = await listProfiles();
  const knownNames = new Set(names);
  const opts: PickerOption[] = [];
  const kitty = await detectKittyTerminal();
  const profilesRoot =
    process.env.CUE_PROFILES_DIR ??
    process.env.SOUL_PROFILES_DIR ??
    join(
      resolve(new URL(import.meta.url).pathname, "..", "..", ".."),
      "profiles",
    );
  // Stable per-process image IDs (1..255) for kitty's 256-color FG-encoded
  // placeholder protocol. We have at most a handful of iconImage profiles, so
  // overflow isn't a concern in practice — assert anyway in transmitKittyImage.
  let nextImageId = 1;
  // Each profile gets one row; companion combos are no longer flattened into
  // the list — runPicker surfaces them as a multiselect *after* the user picks
  // a profile, using each option's `recommends` field below.
  for (const name of names) {
    // Hidden profiles stay installable via `cue use <name>` but never appear
    // in the interactive picker. Pinned profiles are an exception — if the
    // user has pinned a hidden profile, surface it so they can re-confirm.
    if (PICKER_HIDDEN_PROFILES.has(name) && name !== pinnedProfile) continue;
    try {
      const p = await loadProfile(name);
      if (p.kind === "internal" && name !== pinnedProfile) continue;
      let iconLabel: string;
      // iconImage may be inherited from a parent (e.g. medusa-dev's logo.png
      // bleeds to designer-medusa via the inherits chain), but the file
      // itself only lives in the declaring profile's directory. Verify the
      // resolved path actually exists before transmitting — otherwise the
      // kitty placeholder paints blank and swallows the emoji fallback.
      const iconImagePath = p.iconImage
        ? resolve(profilesRoot, name, p.iconImage)
        : null;
      if (
        kitty &&
        iconImagePath &&
        existsSync(iconImagePath) &&
        nextImageId <= 255
      ) {
        const id = nextImageId++;
        // Transmit + virtual placement; placeholder text in the label triggers
        // the actual paint when @clack/prompts renders the option.
        transmitKittyImage(iconImagePath, id, 2, 1);
        iconLabel = kittyPlaceholderLabel(id, 2, 1);
      } else if (p.icon) {
        iconLabel = p.icon;
      } else {
        iconLabel = "";
      }
      // Rows show the profile name only — no `includes:` bundle list or
      // `↪ in <mega>` breadcrumb. The makeup of a composite profile is shown
      // in the post-pick details, not crammed into every label.
      const nameLabel = iconLabel ? `${iconLabel} ${name}` : name;
      const warning = PICKER_WARNINGS[name];
      const hint = warning ? warning.hint : p.description;
      const recommends = p.recommends.filter(
        (r) => r !== name && knownNames.has(r),
      );
      const autoSelect = p.autoSelect.filter(
        (r) => r !== name && knownNames.has(r),
      );
      const conflicts = p.conflicts.filter(
        (c) => c !== name && knownNames.has(c),
      );
      opts.push({
        value: name,
        label: nameLabel,
        hint,
        catalogGroup: p.catalog?.group,
        searchOnly: p.kind === "overlay" || p.catalog?.discoverability === "search",
        recommends,
        autoSelect,
        conflicts,
        inherits: p.inheritanceChain.filter((ancestor) => ancestor !== name),
      });
    } catch {
      opts.push({ value: name, label: name, hint: "" });
    }
  }

  // Keep the resolved .cue.profile visible as context, but never silently
  // select it or let it suppress advice. The user remains in control.
  if (pinnedProfile) {
    const current = opts.find((o) => o.value === pinnedProfile);
    if (current)
      current.hint = `current profile (.cue.profile)${current.hint ? ` — ${current.hint}` : ""}`;
  }

  // Build the Default entry (composite of core + user-added profiles).
  // Pressing Enter on the picker selects it (it's first in the section order).
  // The loaded parts are baked into the label so the user always sees what
  // Default resolves to, even when their cursor is elsewhere.
  let defaultOpt: PickerOption | undefined;
  try {
    const defaultSelector = getDefaultSelector();
    const parts = defaultSelector.split("+");
    const partsStr = parts.join(" + ");
    defaultOpt = {
      value: defaultSelector,
      label: `⭐ Default → ${partsStr}`,
      hint: "",
      top: true,
    };
  } catch {
    /* non-fatal — picker still works without the Default entry */
  }

  // Pull usage data so most-picked entries float to the top. Combo pins like
  // "blog-writer+postizz" are naturally separate keys in the analytics log.
  const usage = new Map<string, number>();
  const recentGlobal: RecentEntry[] = [];
  const recentCwd: RecentEntry[] = [];
  const cwd = process.cwd();
  try {
    for (const s of computeStats()) {
      usage.set(s.profile, s.sessions);
      recentGlobal.push({
        name: s.profile,
        sessions: s.sessions,
        lastUsed: s.last_used,
      });
    }
    // Second pass scoped to this cwd subtree. When the user opens a project
    // directory, this filters out the ambient career/skill-writer sessions
    // racked up in $HOME so Recent reflects what's been picked *here*.
    for (const s of computeStats({ cwd })) {
      recentCwd.push({
        name: s.profile,
        sessions: s.sessions,
        lastUsed: s.last_used,
      });
    }
  } catch {
    // Analytics is best-effort — never block the picker on a missing/corrupt log.
  }
  // Prefer cwd-scoped Recent whenever this directory has *any* launch
  // history; fall back to global only for brand-new directories. Keeps
  // ambient $HOME launches (auto-pinned profiles) out of project pickers.
  const recent = recentCwd.length > 0 ? recentCwd : recentGlobal;

  // Cwd-detected suggestions (medusa-config.js, Cargo.toml, etc.). Only
  // surfaced when a profile of the same name actually exists in this install.
  const knownProfileNames = new Set(names);
  const deterministic = detectProfileV2(cwd).filter((d: DetectionResultV2) =>
    knownProfileNames.has(d.profile),
  );
  let detections = deterministic;
  let suggestionSource: SuggestedEntry["source"] = "deterministic";
  try {
    const { adviseProfiles, getCachedProfileAdvice } = await import("../lib/ai-profile-advisor");
    const advisorOptions = {
      cwd,
      knownProfiles: names,
      currentProfile: pinnedProfile,
      preferredAgent,
    } as const;
    const cachedAdvice = getCachedProfileAdvice(advisorOptions);
    if (cachedAdvice) {
      detections = mergeProfileSuggestions(
        cachedAdvice.advice.suggestions,
        deterministic,
      );
      suggestionSource =
        cachedAdvice.freshness === "fresh" ? "hybrid" : "stale-hybrid";
    }
    if (!cachedAdvice || cachedAdvice.freshness === "stale") {
      // A model-backed recommendation may take 12 seconds per attempted agent.
      // Never make the picker wait: show deterministic or stale hybrid matches
      // now and refresh the AI cache for the next launch in the background.
      void adviseProfiles(advisorOptions).catch((err) => {
        debug("launch:profile-advisor-warm", err);
      });
    }
  } catch (err) {
    // Import and cache errors fall through to the deterministic detector.
    debug("launch:profile-advisor", err);
  }
  const suggested: SuggestedEntry[] = detections.map((d) => ({
    name: d.profile,
    confidence: d.confidence,
    reasons: d.reasons,
    source: suggestionSource,
  }));

  // Tag any option that the cwd autodetect strongly endorses so the combine
  // multiselect can pre-check it (e.g. you cd'd into a Medusa shop → when
  // you pick `designer`, medusa-dev starts checked in the companion list).
  // Mutating in place is fine since opts hasn't been returned yet.
  const preselectNames = new Set(
    detections
      .filter((d) => d.confidence >= SUGGESTED_AUTO_PICK_CONFIDENCE)
      .map((d) => d.profile),
  );
  if (preselectNames.size > 0) {
    for (const o of opts) {
      if (preselectNames.has(o.value)) o.preselect = true;
    }
  }

  const sorted = sortProfileOptions(opts, pinnedProfile, usage);
  // Keep a featured entry if it's a known single profile OR a composite whose
  // every part resolves — otherwise the caller would strip composites before
  // buildPickerSections ever sees them (the same drop that broke Recent).
  const featured = (await listFeaturedProfiles()).filter((n) =>
    n.split("+").every((part) => knownProfileNames.has(part)),
  );
  return {
    options: buildPickerSections(
      defaultOpt,
      sorted,
      recent,
      3,
      Date.now(),
      suggested,
      featured,
    ),
    profileNames: names,
    detected: detections,
    deterministic,
    recents: recent,
    recentsAreCwdScoped: recentCwd.length > 0,
    featured,
    defaultSelector: defaultOpt?.value,
  };
}

async function readSharedClaudeMd(profile?: {
  name: string;
  inheritanceChain?: string[];
}): Promise<string> {
  const root =
    process.env.CUE_REPO_ROOT ??
    process.env.SOUL_REPO_ROOT ??
    resolve(new URL(import.meta.url).pathname, "..", "..", "..");
  const baseDir = join(root, "resources", "claude-md");
  const { readdir: rd } = await import("node:fs/promises");
  const parts: string[] = [];

  // Helper: read all .md files from a directory (sorted)
  async function readLayer(dir: string): Promise<void> {
    try {
      const files = (await rd(dir)).filter((f) => f.endsWith(".md")).sort();
      for (const f of files) {
        try {
          parts.push(await readFile(join(dir, f), "utf8"));
        } catch {
          /* skip */
        }
      }
    } catch {
      /* dir doesn't exist — skip */
    }
  }

  // Layer 1: _always/ (all profiles)
  await readLayer(join(baseDir, "_always"));

  // Layer 2: inheritance chain layers (e.g. _core/ if profile inherits core)
  if (profile?.inheritanceChain) {
    for (const ancestor of profile.inheritanceChain) {
      if (ancestor === profile.name) continue; // skip self, handled in layer 3
      await readLayer(join(baseDir, `_${ancestor}`));
    }
  }

  // Layer 3: profile-specific layer
  if (profile?.name) {
    await readLayer(join(baseDir, profile.name));
  }

  return parts.length ? parts.join("\n") + "\n" : "";
}

async function buildUserClaudeMd(
  profile: ResolvedProfile,
  agent: "claude-code" | "codex",
): Promise<string> {
  const appendUser = shouldAppendUserClaudeMd({
    agent,
    cwd: process.cwd(),
    home: homedir(),
  });
  let content =
    (await readSharedClaudeMd(profile)) +
    (appendUser ? await readUserClaudeMd(agent) : "");

  // First-time profile suggestion: if no .cue.profile in cwd, inject marker
  const cueProfilePath = join(process.cwd(), ".cue.profile");
  if (!existsSync(cueProfilePath)) {
    content +=
      "\n<!-- cue:first-time-suggest -->\n" +
      "## ⚡ First-Time Setup\n\n" +
      "No `.cue.profile` is pinned to this directory. Before answering the user's first message, " +
      "summon the right profile into THIS session — no restart. Invoke the `meta/profile-summon` " +
      "skill, or run `cue summon` (auto-detects from the repo). It soft-loads the profile's persona " +
      "and skill playbooks inline, pins `.cue.profile`, and prints an agent-specific warm handoff for the MCP / " +
      "command tail (Claude continues natively; Codex reads the prior rollout in a newly profiled process). Propose the detected profile in 3-4 lines, " +
      "apply on the user's OK, then proceed with their request.\n\n" +
      "Available profiles:\n```\n" +
      (await getProfileListForStamp()) +
      "```\n\n";
  }

  return content;
}

async function getProfileListForStamp(): Promise<string> {
  try {
    const names = await listProfiles();
    const lines: string[] = [];
    for (const name of names.slice(0, 15)) {
      const yamlPath = join(
        process.env.CUE_PROFILES_DIR ??
          join(resolve(import.meta.dirname, "..", ".."), "profiles"),
        name,
        "profile.yaml",
      );
      try {
        const content = readFileSync(yamlPath, "utf8");
        const iconMatch = content.match(/^icon:\s*["']?(.+?)["']?\s*$/m);
        const descMatch = content.match(/^description:\s*["']?(.+?)["']?\s*$/m);
        const icon = iconMatch?.[1] ?? " ";
        const desc = descMatch?.[1]?.slice(0, 60) ?? "";
        lines.push(`${icon} ${name} — ${desc}`);
      } catch {
        lines.push(`  ${name}`);
      }
    }
    return lines.join("\n") + "\n";
  } catch {
    return "";
  }
}

/**
 * Decide whether cue should append the user's global agent memory file
 * (`~/.claude/CLAUDE.md` for claude-code, `$CODEX_HOME/AGENTS.md` for codex) into
 * the materialized runtime memory file.
 *
 * Claude Code already loads `~/.claude/CLAUDE.md` on its own whenever the launch
 * cwd sits under $HOME — verified: it appears as its own distinct memory source
 * in the running session even though cue relocates CLAUDE_CONFIG_DIR to the
 * runtime dir. So cue's appended copy is byte-for-byte redundant there (~9KB
 * injected twice, every session, on every profile). Skip it in that case.
 *
 * Still append (cue is the only source) when:
 *   - agent is codex (its memory-load model isn't verified here), or
 *   - cwd is outside $HOME (the harness project-walk never reaches ~/.claude), or
 *   - CUE_APPEND_USER_CLAUDEMD=1|true forces the legacy always-append behavior.
 *
 * Net effect is no-regression: worst case (claude-code, cwd outside $HOME, or
 * forced) is identical to today; the common case (cwd under $HOME) drops the
 * duplicate.
 */
export function shouldAppendUserClaudeMd(opts: {
  agent: "claude-code" | "codex";
  cwd: string;
  home: string;
  env?: Record<string, string | undefined>;
}): boolean {
  const force = (opts.env ?? process.env).CUE_APPEND_USER_CLAUDEMD;
  if (force === "1" || force === "true") return true;
  if (opts.agent !== "claude-code") return true;
  return !isInsideHome(opts.cwd, opts.home);
}

/** True when `cwd` is `home` itself or nested under it (separator-aware so
 *  `/home/user2` is not treated as inside `/home/user`). */
function isInsideHome(cwd: string, home: string): boolean {
  const c = resolve(cwd);
  const h = resolve(home);
  // `h + sep` is the safe boundary: for a normal home it matches nested paths;
  // for the pathological home === "/" it becomes "//" (which a resolved path
  // never starts with), so we fall back to appending — the safe default when
  // we can't be sure the harness loads the file itself.
  return c === h || c.startsWith(h + sep);
}

async function readUserClaudeMd(
  agent: "claude-code" | "codex",
): Promise<string> {
  const path =
    agent === "claude-code"
      ? join(homedir(), ".claude", "CLAUDE.md")
      : join(canonicalCodexHome(), "AGENTS.md");
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Find the real agent binary on PATH. cue's own shim dir is skipped wholesale;
 * everywhere else shims are detected by CONTENT (small script containing a cue
 * `launch` call), never by skipping a directory: the native Claude installer
 * puts the REAL binary in ~/.local/bin — where cue's legacy shim also lived —
 * and the npm package no longer ships a `claude` bin, so a directory skip there
 * can leave zero candidates on a healthy machine.
 * Pure PATH walk — launch deliberately ignores $CLAUDE_CODE_EXECPATH /
 * $CUE_REAL_CLAUDE (those serve in-session helpers like `cue quick`), so the
 * binary the user's PATH points at is the one that execs.
 *
 * $CUE_REAL_CODEX is the one exception, and it is a dispatch hook rather than a
 * discovery hint: it exists so a wrapper (oh-my-codex, …) can sit BEHIND the
 * picker instead of shadowing it in the shell. `viaOverride` tells the caller to
 * hand that wrapper a sanitized env — see `wrapperEnv`.
 */
async function findRealBinary(
  name: string,
): Promise<{ bin: string; viaOverride: boolean } | null> {
  const { codexExecOverride, findRealAgentBin } =
    await import("../lib/claude-binary");
  if (name === "codex") {
    const override = codexExecOverride();
    if (override) return { bin: override, viaOverride: true };
  }
  const bin = findRealAgentBin(name);
  return bin ? { bin, viaOverride: false } : null;
}

/**
 * Child env for a wrapper exec ($CUE_REAL_CODEX). Two loop-breakers:
 *
 *  - Drop cue's shim dir from PATH, so the wrapper's bare `codex` spawn reaches
 *    the real binary instead of re-entering `cue launch`.
 *  - Unset the override, so a nested `cue launch codex` that slips through some
 *    other shim can't dispatch back into the wrapper a second time.
 */
function wrapperEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { CUE_REAL_CODEX: _override, ...rest } = env;
  return { ...rest, PATH: stripShimDirFromPath(env.PATH, shimDir()) };
}

/**
 * Pick the Claude credentials source for runtime materialization.
 *
 * Priority:
 *   1. $CLAUDE_CONFIG_DIR (explicit override — claude-account2 alias, etc.)
 *   2. ~/.claude if it has .credentials.json
 *   3. authmux parallel profile with the freshest .credentials.json mtime
 *      (so users who manage Claude accounts only via authmux don't have to
 *      re-login per cue profile — every cue profile inherits whichever
 *      account they touched most recently)
 *   4. ~/.claude as last-resort fallback (materializer will skip the copy if
 *      .credentials.json isn't there)
 *
 * Once the source is chosen, we run a "freshness sweep": Anthropic's OAuth
 * rotates the refresh token on every refresh, so any per-profile cue runtime
 * that ran more recently than the source has *the* live refresh token, and
 * source's copy is dead. Without healing, materializing a new profile would
 * copy the dead token in and force a re-login. `syncFreshestToSource` looks
 * across `runtime/<profile>/claude/.credentials.json` for matching
 * accountUuid and copies the freshest one back to source.
 */
async function resolveClaudeCredentialsSource(
  options: { runtimeDir?: string } = {},
): Promise<string> {
  return resolveSharedClaudeCredentialsSource({
    healFromRuntime: true,
    runtimeDir: options.runtimeDir,
  });
}

/**
 * Fallback reconcile cadence, used only if the credentials-sync import itself
 * fails. Matches `RECONCILE_IDLE_MS` there, which owns the real schedule.
 *
 * Polling (rather than watching) is deliberate throughout: the atomic
 * tmp→rename rewrite that replaces `.credentials.json` also breaks an inode
 * watch.
 */
const CREDENTIAL_RECONCILE_FALLBACK_MS = 60_000;

/**
 * Keep a running session's tokens in step with every other session on the same
 * account, for as long as it runs.
 *
 * Concurrent sessions on different profiles hold separate copies of one refresh
 * token, and Anthropic rotates that token on each refresh — so whichever
 * session refreshes first silently revokes the others, and they hit a login
 * prompt mid-session. Rescue-on-exit was too late to help: by then the other
 * session has already been dropped. Each session now republishes its own
 * rotation and adopts anyone else's within a minute.
 *
 * The cadence is not fixed: it tightens across the window where every copy's
 * access token expires at once (see `nextReconcileDelayMs`), because that is
 * precisely when a rotation is contended and a minute of lag loses the race.
 *
 * Best-effort throughout, and unref'd so it can never hold the process open.
 * Returns a stop function.
 */
function startCredentialReconciler(runtimeKey: string): () => void {
  // basename() pins the path inside the runtime tree — this writes token
  // files, so a runtime key carrying a separator must not escape it.
  const runtimeClaudeDir = join(
    configDir(),
    "runtime",
    basename(runtimeKey),
    "claude",
  );
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Self-chaining rather than setInterval: the delay varies per tick, and a
  // slow disk can no longer stack overlapping reconciles.
  const tick = async (): Promise<void> => {
    let delayMs = CREDENTIAL_RECONCILE_FALLBACK_MS;
    try {
      const {
        listKnownAccountDirs,
        reconcileCredentials,
        readExpiresAt,
        nextReconcileDelayMs,
      } = await import("../lib/credentials-sync");
      await reconcileCredentials(
        runtimeClaudeDir,
        await listKnownAccountDirs(homedir()),
      );
      delayMs = nextReconcileDelayMs(
        await readExpiresAt(runtimeClaudeDir),
        Date.now(),
      );
    } catch (err) {
      debug("launch:cred-reconcile", err);
    }
    if (stopped) return;
    timer = setTimeout(() => void tick(), delayMs);
    timer.unref();
  };

  // Reconcile once up front: a session launched while a sibling is mid-rotation
  // should adopt the live token now, not a minute from now.
  void tick();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

/**
 * Write the runtime's login-fresh `.credentials.json` back to the account
 * dir that owns it (matched by accountUuid). Runs (a) before materialization
 * — so the account-identity guard can't destroy the only live copy of the
 * OTHER account's rotated token when two authmux accounts alternate on one
 * profile — and (b) after the agent exits, so a `/login` done inside the
 * session lands in the account's CLAUDE_CONFIG_DIR immediately instead of
 * waiting for that account's next launch. Best-effort: never blocks launch.
 */
async function rescueRuntimeCredsToOwner(runtimeKey: string): Promise<void> {
  try {
    const { listKnownAccountDirs, rescueRuntimeCredentials } =
      await import("../lib/credentials-sync");
    // basename() pins the path inside the runtime tree — this helper WRITES
    // token files, so a runtime key with a path separator must not escape.
    const runtimeClaudeDir = join(
      configDir(),
      "runtime",
      basename(runtimeKey),
      "claude",
    );
    const result = await rescueRuntimeCredentials(
      runtimeClaudeDir,
      await listKnownAccountDirs(homedir()),
    );
    if (result.rescued) {
      process.stderr.write(
        `▸ cue: wrote login-fresh credentials back to ${result.to}\n`,
      );
    }
  } catch (err) {
    debug("launch:cred-rescue", err);
  }
}

/**
 * When cue launches under an authmux parallel account, CLAUDE_CONFIG_DIR points
 * at that account's dir (`~/.claude-accounts/<name>`) or its per-run session
 * copy (`~/.claude-accounts-sessions/<name>/<ts>-<pid>`). Derive a stable
 * per-account tag so the runtime dir can be keyed by profile + account. Without
 * it, two accounts sharing a cue profile share ONE runtime `.credentials.json` /
 * `.claude.json` and collapse into a single Anthropic login (the credential is
 * copied, not symlinked, so the shared runtime is the source of truth). Returns
 * undefined for the default `~/.claude` and any non-authmux config dir, which
 * preserves the plain per-profile runtime.
 */
export function authmuxAccountTag(
  configDirEnv: string | undefined,
  homeDir: string,
): string | undefined {
  if (!configDirEnv) return undefined;
  const resolved = resolve(configDirEnv);
  for (const root of [
    join(homeDir, ".claude-accounts-sessions"),
    join(homeDir, ".claude-accounts"),
  ]) {
    const prefix = root + sep;
    if (resolved.startsWith(prefix)) {
      const name = resolved.slice(prefix.length).split(sep)[0];
      // Filesystem-safe, and can't inject the `profile@tag` separator or a path
      // separator into the runtime dir name. LIMITATION: names differing only in
      // non-`[A-Za-z0-9._-]` characters (e.g. `a@b` vs `a_b`) sanitize to the same
      // tag and would share a runtime. authmux account names are simple, user-chosen
      // ids (`parallel --add <name>`), so this is a theoretical edge, not a live risk.
      if (name) return name.replace(/[^A-Za-z0-9._-]/g, "_");
    }
  }
  return undefined;
}

interface ResolveNpxSkillSourcesOptions {
  resolveNpx?: (profile: ResolvedProfile) => Promise<LinkPlan[]>;
  /**
   * Called when some remote skills could not be fetched and the launch is
   * continuing without them. Not called on a clean resolve.
   */
  onDegraded?: (failures: NpxEntryFailure[]) => void;
}

/**
 * Locate profile npx skills for either Claude Code or Codex materialization.
 *
 * A remote skill repo is a network dependency, and the network is not a
 * launch-blocking dependency: when a fetch fails after its retries, the entry
 * degrades to whatever is already cached (often everything, since the cache is
 * keyed by repo+pin) and the launch proceeds. Missing skills are reported to
 * `onDegraded`, never thrown — losing one skill must not cost the session.
 */
export async function resolveNpxSkillSources(
  profile: ResolvedProfile,
  opts: ResolveNpxSkillSourcesOptions = {},
): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  if (profile.skills.npx.length === 0) return sources;

  // Always honor the profile's repo+pin through Cue's cache. A same-named
  // marketplace skill has no trustworthy provenance and must not override it.
  if (opts.resolveNpx) {
    for (const plan of await opts.resolveNpx(profile)) {
      sources.set(basename(plan.target), plan.source);
    }
    return sources;
  }

  const { plans, failures } = await resolveNpxDetailed(profile, {
    tolerateFetchFailure: true,
  });
  for (const plan of plans) {
    sources.set(basename(plan.target), plan.source);
  }
  if (failures.length > 0) opts.onDegraded?.(failures);

  return sources;
}

/** "5h48m" / "12m" / "40s" — coarse on purpose, this is a hint, not a clock. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}

/**
 * Human-readable lines for skills dropped by a failed remote fetch.
 *
 * A skipped entry is reported differently from a failed one: nothing was tried
 * this launch, so saying "unreachable" would be a fresh claim we did not make.
 * The line names the remembered reason and when the retry happens on its own,
 * because otherwise a user watching a skill stay missing has no way to tell a
 * cooling-down repo from a permanently broken profile entry.
 */
export function formatNpxDegraded(failures: NpxEntryFailure[]): string[] {
  const lines: string[] = [];
  for (const f of failures) {
    const reason = f.error.message.replace(
      /^npx fetch (?:failed|skipped) for \S+: /,
      "",
    );
    const outcome =
      f.skills.length > 0
        ? `launching without ${f.skills.join(", ")}`
        : "using cached copy";
    if (f.skipped) {
      const retry =
        f.retryInMs === undefined
          ? "auto-retry later"
          : `auto-retry in ${formatDuration(f.retryInMs)}`;
      lines.push(
        `[cue] skills: ${f.repo} skipped — earlier fetch failed (${reason}), ${retry} — ${outcome}`,
      );
    } else {
      lines.push(`[cue] skills: ${f.repo} unreachable (${reason}) — ${outcome}`);
    }
  }
  if (lines.length > 0) {
    // Always the forcing form: a fetch that just failed has left a marker, so
    // a plain `cue launch` would skip it rather than retry — advertising that
    // command would send the user to a no-op.
    lines.push(
      "[cue] retry the fetch now with: CUE_NPX_FORCE=1 cue launch (or cue doctor)",
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function run(args: string[]): Promise<number> {
  // Recursion guard. See MAX_LAUNCH_DEPTH for why this counts instead of
  // tripping on the first nested launch.
  const depth = launchDepth();
  if (depth >= MAX_LAUNCH_DEPTH) {
    process.stderr.write(
      `cue: launch nested ${depth} deep — refusing to go further.\n` +
        "  A shim loop looks like this: cue resolved the agent binary back to its own\n" +
        "  shim, so check that cue's shim dir does NOT shadow the real claude/codex.\n" +
        `  A legitimate nested agent is allowed up to ${MAX_LAUNCH_DEPTH - 1} deep; past that it is a loop.\n`,
    );
    return 2;
  }

  const parsed = parse(args);
  if (!parsed.agent) {
    process.stderr.write(
      "cue launch: missing agent (use 'claude' or 'codex')\n",
    );
    return 1;
  }

  // CUE_BYPASS=1 — the documented escape hatch (docs/launch.md,
  // docs/shell-install.md): exec the real binary and nothing else. No resolve,
  // no picker, no materialize, no profile, no relocated config dir. cue flags
  // are still stripped from the argv, because they are cue's, not the agent's.
  //
  // This is the whole contract, and for a long time nothing implemented it:
  // three readers each did something narrow with the flag (the loader dropped
  // its spinner, `parse` refused the CUE_SMART_SUBSET fold) while the pipeline
  // ran in full. That gap is what #133 tripped over — the classifier set
  // CUE_BYPASS on its spawn, believed it made cue's shim transparent, and
  // re-entered `cue launch` instead of reaching a raw agent.
  //
  // The depth guard above deliberately runs FIRST. If `findRealBinary()` ever
  // handed back a cue shim, bypassing would exec it, land straight back here,
  // and loop unbounded; carrying the counter into the child keeps that bounded
  // the same way the normal path is.
  if (isBypassEnabled()) {
    const realBin = await findRealBinary(parsed.agent);
    if (!realBin) {
      process.stderr.write(
        `cue launch: CUE_BYPASS=1 but couldn't find the real '${parsed.agent}' binary on PATH=${process.env.PATH}\n`,
      );
      return 127;
    }
    debug("launch:bypass", realBin.bin);
    const bypassEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CUE_LAUNCHING: String(depth + 1),
    };
    return execAgent(
      realBin.bin,
      parsed.passthrough,
      realBin.viaOverride ? wrapperEnv(bypassEnv) : bypassEnv,
    );
  }

  if (isAgentHelpPassthrough(parsed)) {
    const realBin = await findRealBinary(parsed.agent);
    if (!realBin) {
      process.stderr.write(
        `cue launch: couldn't find the real '${parsed.agent}' binary on PATH=${process.env.PATH}\n`,
      );
      return 127;
    }
    return execAgent(
      realBin.bin,
      parsed.passthrough,
      realBin.viaOverride ? wrapperEnv(process.env) : process.env,
    );
  }
  const agentKind = parsed.agent === "claude" ? "claude-code" : "codex";

  // Resolve profile.
  const cwd = process.cwd();
  // Normalize paths (resolve symlinks, strip trailing slashes) so an explicit
  // CLAUDE_CONFIG_DIR=$HOME/.claude (or $HOME/.claude/) doesn't trigger
  // account-alias mode.
  const ccd = process.env.CLAUDE_CONFIG_DIR;
  let isAccountAlias = false;
  if (ccd) {
    const defaultDir = resolve(homedir(), ".claude");
    const setDir = resolve(ccd);
    isAccountAlias = setDir !== defaultDir;
  }
  const existingResolved = await resolveProfileForCwd({
    cwd,
    homeDir: homedir(),
    configDir: configDir(),
    override: parsed.override,
  });
  const isTTY = process.stdin.isTTY === true;
  const forcePicker = shouldForcePicker({
    forcePick: parsed.forcePick,
    alwaysPickEnv: process.env.CUE_ALWAYS_PICK,
    hasOverride: Boolean(parsed.override),
    isAccountAlias,
    isTTY,
    isBareLaunch: parsed.passthrough.length === 0,
  });
  const resolvedForCwd = forcePicker
    ? { source: "none" as const }
    : existingResolved;
  let inheritedProfile: string | null = null;
  if (
    shouldInheritSessionProfile({
      resolvedNone: resolvedForCwd.source === "none",
      forcePick: parsed.forcePick,
      isTTY,
    })
  ) {
    const { detectActiveProfile } = await import("./summon");
    inheritedProfile = detectActiveProfile();
    if (inheritedProfile)
      debug("launch:inherited-session-profile", inheritedProfile);
  }
  const resolved = inheritedProfile
    ? { source: "session" as const, profile: inheritedProfile }
    : resolvedForCwd;
  const existingProfile =
    existingResolved.source !== "none"
      ? (existingResolved as { source: string; profile: string }).profile
      : undefined;

  let profileName: string;
  // The picker's `details` callback loads + expands the chosen profile so the
  // shown summary matches reality. We stash it here so the post-picker path
  // can reuse it instead of re-loading from disk.
  let cachedProfile: ResolvedProfile | undefined;
  if (resolved.source === "none") {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        "cue launch: no profile resolved and stdin is not a TTY; pass --cue-profile <name>\n",
      );
      return 1;
    }

    // First-launch onboarding. When the user installs cue and runs `claude`
    // for the first time without ever invoking `cue init`, fire the same
    // global wizard so they pick a default profile + opt into telemetry
    // (defaulted ON — every analytics-driven feature reads from it). Marker
    // file gates this so it only runs once. Failure is non-fatal; the picker
    // still opens after.
    try {
      const { onboardedMarkerPath, runGlobalOnboarding } =
        await import("./init");
      const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
      const marker = onboardedMarkerPath();
      if (!existsSync(marker)) {
        process.stdout.write("\n");
        const ok = await runGlobalOnboarding();
        if (ok) {
          try {
            mkdirSync(configDir(), { recursive: true });
            writeFileSync(marker, new Date().toISOString() + "\n");
          } catch {
            /* non-fatal */
          }
          process.stdout.write("\n");
        }
      }
    } catch {
      /* never block launch on onboarding failure */
    }

    const optionSet = await listProfileOptions(existingProfile, parsed.agent);
    const options = optionSet.options;
    // Mine local session history for "you usually pair X with Y" suggestions.
    // The picker pre-checks empirical partners in the combine multiselect.
    // Best-effort: any failure (missing log, malformed lines) yields empty.
    let pairSuggestions: Map<string, string[]> | undefined;
    // Affinity map (own-pick + co-occurrence counts) is mined once here and
    // reused by the cross-profile frequency suggestions below.
    let affinity: Map<string, ProfileAffinity> = new Map();
    try {
      const { computeAffinityMap, suggestionsByProfile } =
        await import("../lib/pair-suggestions");
      affinity = computeAffinityMap();
      // Partners are scoped to this repository: `growStack` grafts one onto
      // every suggested stack with no reason line of its own, so a pairing
      // mined from an unrelated project would silently ride along. Cross-repo
      // habits still surface — as `universalSuggestions` below, which say where
      // they came from — and in `cue suggest-pairs`.
      const localAffinity = computeAffinityMap(undefined, { cwd });
      // Surface a partner after a *single* prior combo: these now render
      // unchecked + hinted ("you paired these before"), so a low bar is a gentle
      // recommendation, not an auto-pin. (The stricter defaults still apply to
      // `cue suggest-pairs`, which reports rather than pre-fills.)
      const sug = suggestionsByProfile(localAffinity, {
        minCount: 1,
        minAffinity: 0,
        limit: 6,
      });
      pairSuggestions = new Map();
      for (const [name, partners] of sug) {
        pairSuggestions.set(
          name,
          partners.map((p) => p.name),
        );
      }
    } catch (err) {
      debug("launch:pair-suggestions", err);
    }
    // Installed profile names and detections were already collected while
    // building options. Reuse them here so v2 receives cached AI advice too,
    // without a second directory scan or listProfiles() walk.
    const knownProfileNames = new Set(optionSet.profileNames);
    // Merged cwd signals, forwarded to runPicker so it can offer a
    // "switch to <X>?" nudge when the user picks a profile that conflicts
    // with what the directory actually looks like (e.g. picking medusa-next
    // in a vite.config.ts project).
    const detected = optionSet.detected.map((d) => ({
      name: d.profile,
      reasons: d.reasons,
      confidence: d.confidence,
    }));
    const rawDetections = optionSet.deterministic;
    const repositoryDetected = rawDetections.map((d) => ({
      name: d.profile,
      reasons: d.reasons,
      confidence: d.confidence,
    }));
    // Content-aware combine companions: scan the cwd for asset/draft/brand
    // signals and feed matching profiles into the combine multiselect — plus
    // dep-detected service profiles (stripe, @aws-sdk/*, …), which join as
    // pre-checked rows (see serviceCompanions).
    let companions: CompanionSignal[] = [];
    try {
      companions = detectCompanions({
        cwd,
        knownProfiles: knownProfileNames,
        brands: listPostizzBrands(),
      });
      companions = companions.concat(
        serviceCompanions(rawDetections, knownProfileNames),
      );
    } catch (err) {
      debug("launch:companions", err);
    }
    // Cross-profile combine suggestions offered under every primary: the curated
    // `_featured.yaml` set (improver, secops, builder, …) plus the profiles the
    // user picks most often (from the affinity map above). Offered unchecked.
    let universalSuggestions: UniversalSuggestion[] = [];
    try {
      const { buildUniversalSuggestions } =
        await import("../lib/pair-suggestions");
      const featured = await listFeaturedProfiles();
      universalSuggestions = buildUniversalSuggestions({
        featured,
        affinity,
        known: knownProfileNames,
      });
    } catch (err) {
      debug("launch:universal-suggestions", err);
    }
    // Per-profile resource tally for the combine multiselect's live preview +
    // per-row hints. Memoized so each offered profile loads at most once.
    // A shared skill-token reader feeds the always-on estimate (frontmatter
    // bytes ÷4 ≈ tokens) — same approximation as the post-launch overhead
    // banner below, so the picker's heads-up and the banner agree.
    const { readFileSync: readSkillFile } = await import("node:fs");
    const skillsRootForTally = join(
      process.env.CUE_REPO_ROOT ??
        resolve(new URL(import.meta.url).pathname, "..", "..", ".."),
      "resources",
      "skills",
      "skills",
    );
    const skillTokenCache = new Map<string, SkillTokens>();
    const tokensForSkill = (id: string): SkillTokens => {
      const c = skillTokenCache.get(id);
      if (c) return c;
      let result: SkillTokens = { frontmatter: 0, body: 0 };
      try {
        const { frontmatter, body } = splitSkillBytes(
          readSkillFile(join(skillsRootForTally, id, "SKILL.md"), "utf8"),
        );
        result = {
          frontmatter: Math.ceil(frontmatter / 4),
          body: Math.ceil(body / 4),
        };
      } catch {
        /* skill missing on disk → counts as 0 */
      }
      skillTokenCache.set(id, result);
      return result;
    };
    const tallyCache = new Map<string, ProfileTally>();
    const resourceTally = async (value: string): Promise<ProfileTally> => {
      const hit = tallyCache.get(value);
      if (hit) return hit;
      const prof = await loadProfile(value);
      await expandWildcards(prof);
      const tally: ProfileTally = {
        skills: profileSkillIds(prof),
        mcps: prof.mcps.map((m) => m.id),
        plugins: prof.plugins.map((pl) => pl.id),
        commands: (prof.commands ?? []).slice(),
        // This profile's own always-on frontmatter cost (parts=undefined → just
        // its own skills). The picker sums these across the selection.
        alwaysOn: computeTokenBreakdown(prof, undefined, tokensForSkill)
          .alwaysOn,
      };
      tallyCache.set(value, tally);
      return tally;
    };
    // Stacks the user confirmed here before. Feeds the v2 suggestion engine
    // ("you launched this stack 4×"); best-effort like every other signal.
    let combos: ComboUsage[] = [];
    try {
      const { readCombos } = await import("../lib/combo-history");
      // Scoped to the launch directory: stacks confirmed in this repo lead,
      // stacks from other repos drop to a hint.
      combos = readCombos(undefined, { cwd });
    } catch (err) {
      debug("launch:combo-history", err);
    }
    const picked = await runPicker({
      cwd,
      options,
      noPin: isAccountAlias,
      pairSuggestions,
      detected,
      repositoryDetected,
      companions,
      universalSuggestions,
      resourceTally,
      recents: optionSet.recents,
      recentsAreCwdScoped: optionSet.recentsAreCwdScoped,
      combos,
      featured: optionSet.featured,
      defaultSelector: optionSet.defaultSelector,
      details: async (name) => {
        const loaded = await loadProfile(name);
        await expandWildcards(loaded);
        cachedProfile = loaded;
        const partNames = parseProfileSelector(name);
        let parts: ResolvedProfile[] | undefined;
        if (partNames.length > 1) {
          parts = await Promise.all(partNames.map((p) => loadProfile(p)));
        }
        return formatProfileSummary(loaded, parts);
      },
    });
    profileName = picked.profile;
  } else {
    profileName = (resolved as { source: string; profile: string }).profile;
  }

  // Pre-launch gate-health warning. Reads the persisted Stop-hook result
  // for this profile (written by resources/hooks/cue-quality-gates.sh) and
  // prints a single yellow line when the last run failed. Never blocks the
  // launch — the user already knows what they're doing, this is just a
  // heads-up that the prior session ended in a red state.
  try {
    const { readGateStatus } = await import("../lib/gate-status");
    const lastRun = readGateStatus(profileName);
    if (lastRun && lastRun.overall === "fail") {
      const failed = lastRun.results.filter((r) => !r.ok).map((r) => r.name);
      const tail =
        failed.length > 2
          ? `${failed.slice(0, 2).join(", ")} +${failed.length - 2}`
          : failed.join(", ");
      process.stderr.write(
        `\x1b[33m⚠\x1b[0m cue: last gate run for "${profileName}" failed (${tail}). ` +
          `Inspect: cue gates status\n`,
      );
    }
  } catch {
    /* non-fatal */
  }

  // Load + materialize. Reuse the picker-cached profile when available.
  let profile!: ResolvedProfile;
  if (cachedProfile && cachedProfile.name === profileName) {
    profile = cachedProfile;
  } else {
    // Try manifest cache first (skips YAML parse + inheritance resolution)
    const profilesDir = join(
      process.env.CUE_REPO_ROOT ??
        resolve(new URL(import.meta.url).pathname, "..", "..", ".."),
      "profiles",
    );
    let fromCache = false;
    try {
      const { getCachedManifest } = await import("../lib/manifest-cache");
      const cached = getCachedManifest(profileName, profilesDir);
      if (cached) {
        profile = cached;
        fromCache = true;
      }
    } catch {
      /* cache miss — fall through */
    }

    if (!fromCache) {
      try {
        profile = await loadProfile(profileName);
      } catch (err) {
        process.stderr.write(`cue launch: ${(err as Error).message}\n`);
        return 1;
      }
      await expandWildcards(profile);

      // Populate manifest cache for next launch
      try {
        const { putCachedManifest } = await import("../lib/manifest-cache");
        putCachedManifest(profile, profilesDir);
      } catch {
        /* non-fatal */
      }
    }
  }

  // Per-account runtime isolation. When launched under an authmux parallel
  // account, key the runtime dir by profile + account so account1/account2
  // never share one `.credentials.json` and collapse into a single login.
  // `profileName` still drives profile source, pins, MCP overrides, and
  // telemetry — only the physical runtime path switches to `runtimeKey`.
  //
  // Resolved BEFORE the credentials source below, which needs to know the dir
  // this launch will write in order to refuse it as its own overlay source.
  const accountTag =
    agentKind === "claude-code" ? authmuxAccountTag(ccd, homedir()) : undefined;
  const runtimeKey = runtimePathKey(
    accountTag ? `${profileName}@${accountTag}` : profileName,
  );
  if (accountTag)
    debug("launch:account-runtime", { profileName, accountTag, runtimeKey });

  // Credentials source resolution (Claude only):
  //   1. Honor explicit CLAUDE_CONFIG_DIR (set by claude-account2 alias, etc.)
  //      — except when it names the runtime dir this launch is about to
  //      rebuild, which is what a nested launch of the SAME profile inherits.
  //      Overlaying that dir onto itself leaves every unmanaged entry a
  //      symlink to its own path.
  //   2. Use ~/.claude if it already has .credentials.json
  //   3. Fall back to authmux's most-recently-used parallel profile — so users
  //      who manage Claude accounts via authmux don't have to re-login per
  //      cue profile. authmux's `parallel --list --json` returns each profile's
  //      configDir; we pick the one whose .credentials.json was touched most
  //      recently as a proxy for "the one you actually use."
  const credentialsSource =
    agentKind === "claude-code"
      ? await resolveClaudeCredentialsSource({
          runtimeDir: runtimeDirFor(runtimeKey, "claude-code"),
        })
      : undefined;

  // Pin dir: the directory holding the resolving `.cue.profile`, else cwd
  // (a freshly-picked profile was just pinned to cwd). Keys both the project
  // loadout and the remembered MCP override below.
  const pinDir =
    existingResolved.source === "pin-file"
      ? dirname((existingResolved as { pinPath: string }).pinPath)
      : cwd;
  const codexExternalSkillPaths =
    agentKind === "codex"
      ? discoverCodexSkillFiles({ cwd, pinDir, homeDir: homedir() })
      : undefined;

  // ── Project loadout ───────────────────────────────────────────────────
  // Project-aware skill loading: classify each local skill as full (project
  // signals match — materialized as today) or deferred (excluded from the
  // skills dir, which is what removes its always-on frontmatter cost, but
  // listed in one generated index skill so it stays loadable on demand).
  // Deterministic + remembered per pinDir; recomputed when the profile's
  // skill set or the project's signals change. Runs BEFORE the MCP block so
  // `needed` (skill→MCP dependencies) reflects only full skills, and before
  // materialization so the runtime hash covers the filtered profile.
  // Fail-open: any error keeps the full profile. Escapes: `--cue-full`
  // (once), CUE_LOADOUT=off (globally), `cue loadout off` (this project).
  let loadoutActive = false;
  const loadoutEnvOff = ["off", "0", "false"].includes(
    (process.env.CUE_LOADOUT ?? "").trim().toLowerCase(),
  );
  if (!parsed.fullLoad && !loadoutEnvOff) {
    try {
      const { applyProjectLoadout } = await import("../lib/project-loadout");
      const { parseMetadataFromContent } = await import("./optimizer");
      const { readFile: readSkillFile } = await import("node:fs/promises");
      // Direct-path read (skills live at <root>/<category>/<slug>/SKILL.md);
      // fuzzy-resolved ids just yield empty metadata — classification then
      // falls back to id-token matching, and the index row omits the path.
      const skillsRoot = join(
        process.env.CUE_REPO_ROOT ??
          resolve(new URL(import.meta.url).pathname, "..", "..", ".."),
        "resources",
        "skills",
        "skills",
      );
      const result = await applyProjectLoadout({
        profile,
        cwd,
        pinDir,
        readSkill: async (id) => {
          const path = join(skillsRoot, id, "SKILL.md");
          const content = await readSkillFile(path, "utf8").catch(() => "");
          if (!content) return { description: "", path: "" };
          return {
            description: parseMetadataFromContent(content).description,
            path,
          };
        },
      });
      if (result) {
        profile = result.profile;
        loadoutActive = true;
        const top = result.signals.slice(0, 4).join(", ");
        process.stderr.write(
          `[cue] loadout: ${result.full.length} skills full · ${result.deferred.length} deferred` +
            (top ? ` (${top}${result.signals.length > 4 ? ", …" : ""})` : "") +
            ` · --cue-full loads all · cue loadout to edit\n`,
        );
      }
    } catch (err) {
      debug("launch:loadout", err); // fail-open — full profile on any error
    }
  }

  // Skill conflict detection is opt-in via `cue skills conflicts` — the
  // regex-based detector produces too many false positives on natural-language
  // SKILL.md prose to be useful as an inline launch-time warning.

  // --rematerialize: force rebuild by deleting the hash file first
  if (parsed.rematerialize) {
    const { rm: rmFile } = await import("node:fs/promises");
    const hashPath = join(
      configDir(),
      "runtime",
      runtimeKey,
      agentKind === "claude-code" ? "claude" : "codex",
      ".cue-hash",
    );
    try {
      await rmFile(hashPath, { force: true });
    } catch {
      /* ok */
    }
  } else {
    // Auto-rematerialize on staleness: if profile.yaml is newer than the stored
    // hash (doctor's D5 predicate), the user edited the profile after the last
    // build. Drop the hash so materializeRuntime rebuilds, instead of execing a
    // stale runtime where a freshly-added skill would look "missing". Deleting
    // the hash reuses the same forced-rebuild path as --rematerialize; the
    // rebuild writes a fresh .cue-hash with a current mtime, so it won't loop.
    try {
      const { isRuntimeStale } = await import("../lib/runtime-materializer");
      if (
        await isRuntimeStale(
          profileName,
          agentKind,
          join(configDir(), "runtime"),
          runtimeKey,
        )
      ) {
        const { rm: rmFile } = await import("node:fs/promises");
        const hashPath = join(
          configDir(),
          "runtime",
          runtimeKey,
          agentKind === "claude-code" ? "claude" : "codex",
          ".cue-hash",
        );
        try {
          await rmFile(hashPath, { force: true });
        } catch {
          /* ok */
        }
        process.stderr.write(`[cue] profile changed, rebuilding runtime...\n`);
      }
    } catch (err) {
      debug("launch:staleness", err); /* fail-open — never blocks launch */
    }
  }

  // Lazy-MCP: ids the user disabled, forwarded to the materializer so the stale
  // keys are evicted from the runtime .claude.json (which the rebuild preserves).
  let mcpDisabledIds: string[] = [];
  // ── Lazy MCP loading ──────────────────────────────────────────────────
  // Prune the profile's MCP servers to what the chosen skills actually need
  // (smart-prune) and let the user disable individual servers interactively.
  // The choice is remembered per pinned directory; later launches apply it
  // silently until the profile's MCP set changes (fingerprint mismatch).
  //
  // Runs BEFORE the loader so the interactive toggle owns a clean TTY, and
  // BEFORE smart-subset — so `needed` reflects the pre-subset skill set. That
  // only ever over-keeps an MCP (safe); subset's copy-on-write preserves the
  // pruned `mcps`. Pruning `profile.mcps` changes the materializer content
  // hash, so the smaller `.claude.json` rebuilds automatically.
  if (agentKind === "claude-code" && profile.mcps.length > 0) {
    try {
      const { getNeededMcps } = await import("../lib/skill-dependencies");
      const {
        readMcpOverride,
        writeMcpOverride,
        mcpFingerprint,
        reconcileDisabledWithNeeded,
        autoPrunableMcps,
        mcpPruneMode,
        isRecognizedPruneEnv,
        readRuntimeMcpServerIds,
        withAutoPrunedGlobals,
      } = await import("../lib/mcp-overrides");

      const allMcpIds = profile.mcps.map((m) => m.id);
      const fingerprint = mcpFingerprint(allMcpIds);
      const pinned = new Set(
        profile.mcps.filter((m) => m.pin).map((m) => m.id.toLowerCase()),
      );
      const needed = getNeededMcps(profile.skills.local.map((s) => s.id));

      const keepNonPinned = (drop: Set<string>): Set<string> =>
        new Set(
          allMcpIds.filter(
            (id) => pinned.has(id.toLowerCase()) || !drop.has(id.toLowerCase()),
          ),
        );

      let kept: Set<string> | null = null;
      let reviewed = false;

      // Effective non-interactive prune mode: a RECOGNIZED `CUE_PRUNE_MCPS` env
      // (including an explicit `off`) overrides the profile's declared default;
      // otherwise the profile's `mcpPrune:` applies — this is what makes a heavy
      // profile auto-prune with no env var. A non-empty but UNRECOGNIZED env
      // (e.g. a typo like `profil`) must NOT silently suppress the profile
      // default: warn and fall through, so the typo is a no-op, not a foot-gun.
      const pruneEnv = process.env.CUE_PRUNE_MCPS;
      const pruneEnvSet = pruneEnv != null && pruneEnv !== "";
      const pruneFromEnv = pruneEnvSet && isRecognizedPruneEnv(pruneEnv);
      if (pruneEnvSet && !pruneFromEnv) {
        process.stderr.write(
          `[cue] CUE_PRUNE_MCPS="${pruneEnv}" not recognized (use off|profile|all) — using the profile default\n`,
        );
      }
      const pruneMode = pruneFromEnv
        ? mcpPruneMode(pruneEnv)
        : (profile.mcpPrune ?? "off");
      const pruneSource = pruneFromEnv ? "CUE_PRUNE_MCPS" : "profile mcpPrune";

      if (parsed.disableMcp.length > 0) {
        // Non-interactive flag path: drop named ids (pinned ones excepted) for
        // THIS launch only. `reviewed` stays false so the choice is NOT written
        // as a remembered per-dir override — a one-shot `--disable-mcp` in a CI
        // run or a debug session must not silently stick on later launches. Use
        // the interactive picker (or `--cue-pick-mcps`) to persist a choice.
        kept = keepNonPinned(
          new Set(parsed.disableMcp.map((s) => s.toLowerCase())),
        );
      } else {
        const override = readMcpOverride(pinDir);
        const overrideValid =
          override !== undefined && override.fingerprint === fingerprint;
        const interactive = process.stdin.isTTY === true && !parsed.dryRun;

        // Replay a remembered disable-list, cross-checked against what active
        // skills now need: a skill added since the override was captured may
        // need an MCP the user disabled. Re-enable those (honor the dependency)
        // and say so, rather than silently starving the skill. The override is
        // keyed only by the MCP id set (fingerprint), so it won't re-prompt.
        const applyRememberedOverride = (): Set<string> => {
          const { keepDisabled, reEnabled } = reconcileDisabledWithNeeded(
            override!.disabled,
            needed.keys(),
          );
          if (reEnabled.length > 0) {
            process.stderr.write(
              `[cue] MCPs: re-enabled ${reEnabled.length} now needed by active skills (${reEnabled.join(", ")}) · --cue-pick-mcps to change\n`,
            );
          }
          return keepNonPinned(new Set(keepDisabled));
        };

        // The toggle opens on --cue-pick-mcps and when there's no valid
        // remembered choice (first launch of this MCP set, or the set changed —
        // the fingerprint invalidates the override). It does NOT re-open just
        // because the profile was picked interactively this launch: a remembered
        // choice is honored, so picking `core` from the startup menu no longer
        // forces an MCP dialog every time. Re-review explicitly with
        // --cue-pick-mcps. A valid override seeds the checkboxes when it does open.
        if (
          shouldOpenMcpPicker({
            interactive,
            forcePickMcps: parsed.forcePickMcps,
            overrideValid,
          })
        ) {
          const { pickMcps } = await import("../lib/mcp-picker");
          // Initial checkbox state, best first: the remembered override (this
          // is a re-review), else — when a loadout is active — the project-
          // aware suggestion (unpinned MCPs no full skill needs start
          // unchecked; Enter persists it as the normal override), else the
          // picker's built-in defaults.
          kept = await pickMcps({
            profileMcpIds: allMcpIds,
            pinned,
            needed,
            initialDisabled: overrideValid
              ? new Set(override!.disabled.map((s) => s.toLowerCase()))
              : loadoutActive
                ? new Set(autoPrunableMcps(allMcpIds, pinned, needed.keys()))
                : undefined,
          });
          reviewed = kept !== null; // null = user cancelled → persist nothing
          // Cancelling the review must not silently re-enable everything when a
          // remembered choice exists — fall back to it, same as a non-picking launch.
          if (kept === null && overrideValid) kept = applyRememberedOverride();
        } else if (overrideValid) {
          kept = applyRememberedOverride();
        } else if (pruneMode !== "off") {
          // Non-interactive prune, from CUE_PRUNE_MCPS or the profile's mcpPrune
          // default. Self-contained: it sets mcpDisabledIds directly (so it can
          // drop GLOBAL servers that aren't in profile.mcps and thus invisible to
          // the shared block below) and leaves `kept` null to skip that block.
          // Recomputed each launch; never persisted, so the picker's remembered
          // overrides stay intact.
          //
          //   profile mode → drop unused PROFILE MCPs only (cue's invariant that
          //                  user-global servers are never touched holds).
          //   all mode     → also drop unused GLOBAL servers present in the
          //                  runtime .claude.json (the heavy ones a coding
          //                  profile never calls). Removes config set globally.
          const universe = [...allMcpIds];
          if (pruneMode === "all") {
            const rtClaudeJson = join(
              configDir(),
              "runtime",
              runtimeKey,
              "claude",
              ".claude.json",
            );
            for (const id of readRuntimeMcpServerIds(rtClaudeJson)) {
              if (!universe.some((p) => p.toLowerCase() === id.toLowerCase()))
                universe.push(id);
            }
          }
          const drop = new Set(
            autoPrunableMcps(universe, pinned, needed.keys()),
          );
          debug("launch:mcp-prune", {
            mode: pruneMode,
            source: pruneSource,
            universe,
            pinned: [...pinned],
            needed: [...needed.keys()],
            drop: [...drop],
          });
          if (drop.size > 0) {
            profile = {
              ...profile,
              mcps: profile.mcps.filter((m) => !drop.has(m.id.toLowerCase())),
            };
            mcpDisabledIds = [...drop];
            process.stderr.write(
              `[cue] MCPs: auto-pruned ${drop.size} unused (${[...drop].join(", ")}) · ${pruneSource}=${pruneMode} · --cue-pick-mcps to keep\n`,
            );
          }
        }
        // else: non-interactive with no valid override → keep all (kept stays null).
      }

      debug("launch:mcp-prune", {
        all: allMcpIds,
        pinned: [...pinned],
        needed: [...needed.keys()],
        reviewed,
        kept: kept ? [...kept] : null,
      });
      if (kept !== null) {
        const keptSet = kept;
        let disabled = allMcpIds
          .filter((id) => !keptSet.has(id))
          .map((id) => id.toLowerCase());
        if (pruneMode === "all") {
          const rtClaudeJson = join(
            configDir(),
            "runtime",
            runtimeKey,
            "claude",
            ".claude.json",
          );
          disabled = withAutoPrunedGlobals(
            disabled,
            allMcpIds,
            readRuntimeMcpServerIds(rtClaudeJson),
            pinned,
            needed.keys(),
          );
        }
        if (disabled.length > 0) {
          profile = {
            ...profile,
            mcps: profile.mcps.filter((m) => keptSet.has(m.id)),
          };
          mcpDisabledIds = disabled;
          process.stderr.write(
            `[cue] MCPs: ${keptSet.size} on · ${disabled.length} disabled (${disabled.join(", ")}) · --cue-pick-mcps to change\n`,
          );
        }
        // Persist whenever the user actively reviewed (keeps the remembered set
        // fresh, and clears a stale override when they re-enable everything).
        // `disabled` may be [] here — that's intentional: it records "reviewed,
        // nothing disabled" so a later launch doesn't re-prompt.
        if (reviewed)
          writeMcpOverride(pinDir, {
            profile: profileName,
            fingerprint,
            disabled,
          });
      }
    } catch (err) {
      debug("launch:mcp-prune", err); // fail-open — never blocks a launch
    }
  }

  // ── Launch loader ─────────────────────────────────────────────────────
  // Animate the two genuinely slow steps of the handoff — smart-subset LLM
  // classification (cold miss ~2s) and runtime materialization — then fully
  // restore the terminal before any warning prints or the agent execs.
  //
  // The loader returns null (no animation) for --dry-run / --rematerialize and
  // any non-TTY context. While it animates it OWNS one stderr line, so every
  // progress message inside the bracket routes through `progress()`: the
  // loader's setMessage when animating, plain stderr.write otherwise (CI logs,
  // dry-run). This is what keeps the spinner from interleaving with output.
  const loader =
    parsed.dryRun || parsed.rematerialize
      ? null
      : startLoader({
          logoPath:
            agentKind === "claude-code"
              ? (ensureClaudeLogoPath() ?? undefined)
              : undefined,
          message: agentLaunchMessage(agentKind),
          accentColor: agentLaunchAccent(agentKind),
        });
  const progress = (active: string, fallback: string): void => {
    if (loader) loader.setMessage(active);
    else if (fallback) process.stderr.write(fallback);
  };

  let runtime!: Awaited<ReturnType<typeof materializeRuntime>>;
  const npxDegraded: NpxEntryFailure[] = [];
  try {
    // Skill subsetting runs ONLY when this launch carries a real prompt:
    //   - explicit `--subset "<text>"`, or
    //   - `CUE_SMART_SUBSET=1` + a passthrough prompt (`claude -p "…"`), which
    //     parse() folds into `parsed.subset`.
    // A bare TUI launch (no prompt) classifies NOTHING — it keeps the full skill
    // set with zero LLM call and zero wait. Lazy skill loading already keeps the
    // always-on cost low (~3K for 21 skills), so there's nothing to gain by
    // guessing relevance from a stale prompt. This deliberately drops the old
    // "reuse the first prompt captured in a prior session for this cwd" path:
    // it made every TUI start depend on a background `claude --print` and could
    // reuse an unrelated prompt (e.g. a one-off `--version` run) as the classifier
    // input. Fails open — any error below keeps the full skill set.
    const subsetPrompt: string | null = parsed.subset;

    if (subsetPrompt && profile.skills.local.length > 4) {
      try {
        const { selectRelevantSkills } = await import("../lib/skill-subset");
        const ids = profile.skills.local.map((s) => s.id);
        // Explicit --subset bypasses the keep-set cache (the user is overriding
        // deliberately); an env-folded `-p` prompt uses the cache so repeat
        // launches don't re-call the classifier.
        const result = await selectRelevantSkills(ids, subsetPrompt, {
          noCache: parsed.subsetExplicit,
        });
        progress(
          `Skills: ${result.reason}`,
          `  🎯 smart-subset: ${result.reason}\n`,
        );
        if (result.classified && result.selected.length < ids.length) {
          const keep = new Set(result.selected);
          // Copy-on-write: never mutate the (possibly manifest-cached) profile
          // object in place — a shared reference would poison sibling reads.
          profile = {
            ...profile,
            skills: {
              ...profile.skills,
              local: profile.skills.local.filter((s) => keep.has(s.id)),
            },
          };
          // Force a rebuild so the smaller skill set actually lands on disk.
          const { rm: rmFile } = await import("node:fs/promises");
          const hashPath = join(
            configDir(),
            "runtime",
            runtimeKey,
            agentKind === "claude-code" ? "claude" : "codex",
            ".cue-hash",
          );
          try {
            await rmFile(hashPath, { force: true });
          } catch {
            /* ok */
          }
        }
      } catch (err) {
        progress(
          "Loading skills…",
          `  ⚠️  smart-subset failed (${(err as Error).message}) — kept full skill set\n`,
        );
      }
    }

    // Rescue-before-wipe: if this runtime's credentials belong to a different
    // account than credentialsSource, the materializer's identity guard is
    // about to discard them — return them to their owning account dir first.
    if (agentKind === "claude-code")
      await rescueRuntimeCredsToOwner(runtimeKey);

    // The materializer only symlinks profile.skills.local, so resolve remote
    // npx entries and promote their concrete source paths before materializing.
    // Apply after skill filtering and workspace persona replacement so Codex's
    // default guidance survives both, without changing the selected runtime key.
    profile = await withCodexPonytail(await applyWorkspaceOverrides(profile), agentKind);
    const npxSkillMap = await resolveNpxSkillSources(profile, {
      onDegraded: (failures) => {
        // Deferred: the loader owns the terminal until the finally below.
        npxDegraded.push(...failures);
      },
    });
    if (npxSkillMap.size > 0) {
      const existingIds = new Set(profile.skills.local.map((skill) => skill.id));
      const newSkills = [...npxSkillMap.keys()]
        .filter((id) => !existingIds.has(id))
        .map((id) => ({ id }));
      if (newSkills.length > 0) {
        profile = {
          ...profile,
          skills: {
            ...profile.skills,
            local: [...profile.skills.local, ...newSkills],
          },
        };
      }
    }

    progress("Preparing runtime…", "");
    runtime = await materializeRuntime({
      profile,
      agent: agentKind,
      runtimeRoot: join(configDir(), "runtime"),
      runtimeKey,
      skillSourceLookup: (id) => {
        const npxPath = npxSkillMap.get(id);
        if (npxPath) return Promise.resolve(npxPath);
        return resolveLocalSkill(id);
      },
      mcpRegistry: await loadMcpRegistry(agentKind),
      userClaudeMd: await buildUserClaudeMd(profile, agentKind),
      credentialsSource,
      codexBaseConfig: canonicalCodexConfigPath(),
      codexExternalSkillPaths,
      disabledMcpIds: mcpDisabledIds,
    });
  } finally {
    // Always restore the terminal before the warning block / exec, even if
    // materialize threw. stop() is idempotent and a no-op when loader is null.
    loader?.stop();
  }

  // Printed after the loader releases the terminal so the warning survives.
  for (const line of formatNpxDegraded(npxDegraded)) {
    process.stderr.write(`${line}\n`);
  }

  // Stamp the runtime as used NOW so the GC age signal is accurate even for a
  // long-lived session (a warm launch may not otherwise write anything). Marker
  // lives in the key dir, next to the `claude/`/`codex/` subdirs GC scans.
  touchRuntime(join(configDir(), "runtime", runtimeKey), Date.now());

  // Run quickDiagnose on every launch — it's cheap (filesystem checks) and
  // the result feeds both the first-build inline print AND the tmux health
  // badge. Print is still gated by .doctor-done so subsequent launches stay
  // quiet; the badge stays current regardless.
  let healthBadge = "";
  try {
    const { quickDiagnose } = await import("./status");
    const warnings = quickDiagnose(profileName, profile);
    if (warnings.length > 0) healthBadge = "!";

    if (runtime.rebuilt) {
      try {
        const { existsSync, writeFileSync } = await import("node:fs");
        const doctorFlag = join(
          configDir(),
          "runtime",
          runtimeKey,
          ".doctor-done",
        );
        if (!existsSync(doctorFlag)) {
          const lines = formatDoctorWarnings(warnings);
          if (lines.length > 0) {
            process.stderr.write("\n");
            for (const l of lines) process.stderr.write(`${l}\n`);
            process.stderr.write("\n");
          }
          writeFileSync(doctorFlag, new Date().toISOString());
        }
      } catch {
        /* non-fatal */
      }
    }
  } catch {
    /* non-fatal */
  }

  // W6/W7 description-lint surface — runs on rebuild only, so skill-writer
  // sees weak triggers/capability at the moment the profile materializes,
  // not just on explicit `cue validate`. Capped at 5 lines to avoid spam.
  //
  // `npxOffline: true` is critical for launch latency: we only consume W6/W7
  // (local-skill description) issues below, but the linter's npx-fetchability
  // check otherwise shells `npx skills add` into a throwaway temp dir on every
  // cache miss — ~8s per npx repo, discarded immediately (it produces E3/W5,
  // never W6/W7). Offline mode turns that into a cheap cache lookup, cutting
  // npx-heavy profile launches from ~30s to sub-second. `cue validate` still
  // does the full online fetchability check.
  if (runtime.rebuilt) {
    try {
      const { lintProfile } = await import("../lib/profile-linter");
      const lint = await lintProfile(profileName, { npxOffline: true });
      const descIssues = lint.issues.filter(
        (i) => i.rule === "W6" || i.rule === "W7",
      );
      if (descIssues.length > 0) {
        const c = colorFns();
        const n = descIssues.length;
        process.stderr.write(
          `${c.yellow(`⚠ ${n} skill description issue${n > 1 ? "s" : ""}`)} ${c.dim(`→ cue validate ${profileName}`)}\n`,
        );
      }
    } catch {
      /* non-fatal — lint is observability, not a gate */
    }
  }

  // --rematerialize: report and exit (no exec)
  if (parsed.rematerialize) {
    process.stdout.write(
      JSON.stringify(
        {
          profile: profileName,
          agent: agentKind,
          runtimeDir: runtime.runtimeDir,
          rebuilt: runtime.rebuilt,
          hash: runtime.hash,
        },
        null,
        2,
      ) + "\n",
    );
    process.stdout.write(
      runtime.rebuilt ? "✅ Rematerialized.\n" : "ℹ️  Already up to date.\n",
    );
    return 0;
  }

  // Auto-ruler: when CUE_RULER_AUTO is on, mirror the profile's rules into the
  // project's agent rule files (CLAUDE.md, AGENTS.md, .cursorrules, …) in SAFE
  // mode — it never clobbers a hand-written file and no-ops when already current.
  // Fail-open: a ruler error must never block the launch.
  try {
    const { isRulerAutoEnabled, runAutoRuler } = await import("../lib/ruler");
    if (isRulerAutoEnabled(process.env.CUE_RULER_AUTO)) {
      const actions = runAutoRuler({
        profile,
        targetDir: cwd,
        dryRun: parsed.dryRun,
      });
      // dry-run yields "dry-write"; a real run yields "write" (mutually exclusive).
      const wrote = actions.filter(
        (a) => a.kind === "write" || a.kind === "dry-write",
      ).length;
      const skipped = actions.filter(
        (a) => a.kind === "skip-foreign-safe",
      ).length;
      if (wrote || skipped) {
        process.stderr.write(
          `[cue] ruler: ${parsed.dryRun ? "would sync" : "synced"} rules → ${wrote} agent file(s)` +
            (skipped
              ? `; left ${skipped} hand-written file(s) untouched`
              : "") +
            "\n",
        );
      }
    }
  } catch (err) {
    debug("launch:auto-ruler", err); /* fail-open — never blocks launch */
  }

  const envKey =
    agentKind === "claude-code" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const persistentCodexHome =
    agentKind === "codex" ? canonicalCodexHome() : undefined;
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    [envKey]: runtime.runtimeDir,
    ...(persistentCodexHome
      ? { CUE_CANONICAL_CODEX_HOME: persistentCodexHome }
      : {}),
    // Depth, not a boolean — see launchDepth(). The agent's whole process tree
    // inherits this, so a subtask that shells out to `claude` lands one deeper
    // rather than being refused.
    CUE_LAUNCHING: String(depth + 1),
  };

  // Per-profile claude-mem memory: point the (cue-managed) claude-mem plugin at
  // an isolated, SQLite-only store + its own worker/server ports so one profile's
  // memory never bleeds into another's. Best-effort — a failure here must never
  // block the launch. Opt out with CUE_CLAUDE_MEM_ISOLATE=0. See lib/claude-mem-env.ts.
  //
  // SCOPE NOTE: keyed by `profileName`, NOT `runtimeKey` — deliberately. The
  // per-account runtime isolation above only splits credential/session state so
  // authmux accounts don't collapse into one login. claude-mem memory stays
  // shared across accounts on the same profile (re-keying it here would silently
  // relocate every existing per-profile memory store). Two accounts running the
  // SAME profile concurrently therefore still share one memory data dir + port
  // slot; making memory per-account is a separate follow-up.
  try {
    const { resolveClaudeMemEnv } = await import("../lib/claude-mem-env");
    const memEnv = resolveClaudeMemEnv(profileName, {
      existingEnv: process.env,
    });
    if (memEnv) Object.assign(childEnv, memEnv);
  } catch {
    /* non-fatal — memory isolation is an enhancement, not a gate */
  }

  if (parsed.dryRun) {
    process.stdout.write(
      JSON.stringify(
        {
          profile: profileName,
          agent: agentKind,
          runtimeDir: runtime.runtimeDir,
          rebuilt: runtime.rebuilt,
          hash: runtime.hash,
          env: {
            [envKey]: childEnv[envKey],
            CUE_CANONICAL_CODEX_HOME: childEnv.CUE_CANONICAL_CODEX_HOME,
            CLAUDE_MEM_DATA_DIR: childEnv.CLAUDE_MEM_DATA_DIR,
            CLAUDE_MEM_CHROMA_ENABLED: childEnv.CLAUDE_MEM_CHROMA_ENABLED,
            CLAUDE_MEM_WORKER_PORT: childEnv.CLAUDE_MEM_WORKER_PORT,
            CLAUDE_MEM_SERVER_PORT: childEnv.CLAUDE_MEM_SERVER_PORT,
          },
          command: [
            parsed.agent,
            ...parsed.passthrough,
          ],
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  // Exec the real agent binary.
  const realBin = await findRealBinary(parsed.agent);
  if (!realBin) {
    process.stderr.write(
      `cue launch: couldn't find the real '${parsed.agent}' binary on PATH=${process.env.PATH}\n`,
    );
    return 127;
  }

  // Token budget warning — accurate measurement, actionable advice
  const skillCount = profile.skills.local.length;

  // Skill → MCP dependency check (non-fatal)
  try {
    const { detectMissingDependencies } =
      await import("../lib/skill-dependencies");
    const skillIds = profile.skills.local.map((s: any) => s.id);
    const mcpIds = profile.mcps.map((m: any) => m.id);
    const missing = detectMissingDependencies(profileName, skillIds, mcpIds);
    if (missing.length > 0) {
      const unique = [...new Set(missing.map((m) => m.mcpId))];
      const c = colorFns();
      process.stderr.write(
        `${c.yellow(`⚠ missing MCP${unique.length > 1 ? "s" : ""}: ${unique.join(", ")}`)} ${c.dim(`→ cue mcps add ${unique[0]} --profile ${profileName}`)}\n`,
      );
    }
  } catch {
    /* non-fatal */
  }

  // Tracks the breakdown so the tmux badge below can reuse what the CLI
  // banner already computed. Undefined when skillCount is too small to bother
  // — in that case the badge just isn't set, which is fine.
  let alwaysOnForBadge: number | undefined;
  if (skillCount > 5) {
    try {
      const { readFileSync } = await import("node:fs");
      const skillsRoot = join(
        process.env.CUE_REPO_ROOT ??
          resolve(new URL(import.meta.url).pathname, "..", "..", ".."),
        "resources",
        "skills",
        "skills",
      );
      const tokenCache = new Map<string, SkillTokens>();
      const tokensForSkill = (id: string): SkillTokens => {
        const cached = tokenCache.get(id);
        if (cached) return cached;
        let result: SkillTokens = { frontmatter: 0, body: 0 };
        try {
          const src = readFileSync(join(skillsRoot, id, "SKILL.md"), "utf8");
          const { frontmatter, body } = splitSkillBytes(src);
          result = {
            frontmatter: Math.ceil(frontmatter / 4),
            body: Math.ceil(body / 4),
          };
        } catch {
          /* skill missing on disk; counts as 0 */
        }
        tokenCache.set(id, result);
        return result;
      };

      // For composite selectors, load each part so we can attribute tokens.
      const partNames = parseProfileSelector(profileName);
      let parts: ResolvedProfile[] | undefined;
      if (partNames.length > 1) {
        try {
          parts = await Promise.all(partNames.map((p) => loadProfile(p)));
        } catch {
          /* breakdown unavailable, total still shown */
        }
      }

      const breakdown = computeTokenBreakdown(profile, parts, tokensForSkill);
      alwaysOnForBadge = breakdown.alwaysOn;
      const lines = formatTokenWarning(breakdown);

      // Model-aware startup budget: skills frontmatter + MCP tool-schema cost
      // should stay under 50% of the model's context window so the other half
      // is free for the conversation. Window precedence: profile
      // contextWindow/model → env (CUE_CONTEXT_WINDOW/CUE_MODEL) → 256K default.
      const budget = computeContextBudget({
        skillTokens: breakdown.alwaysOn,
        mcpCount: profile.mcps.length,
        window: profile.contextWindow,
        model: profile.model,
      });
      const bc = colorFns();
      lines.push(
        ...formatContextBudgetWarning(budget, {
          yellow: bc.yellow,
          bold: bc.bold,
          dim: bc.dim,
        }),
      );

      if (lines.length > 0) {
        process.stderr.write("\n");
        for (const l of lines) process.stderr.write(`${l}\n`);
        process.stderr.write("\n");
      }
    } catch {
      /* non-fatal */
    }
  }

  // First-run: prompt to star the repo (once ever, non-blocking)
  try {
    const { maybePromptStar } = await import("../lib/star-prompt");
    await maybePromptStar();
  } catch {
    /* non-fatal */
  }

  // Analytics: record session start
  try {
    const { recordEvent } = await import("../lib/analytics");
    const startTs = new Date().toISOString();
    recordEvent({
      ts: startTs,
      event: "start",
      profile: profileName,
      agent: agentKind,
      cwd: process.cwd(),
    });
    // Record end on exit
    process.on("exit", () => {
      try {
        const duration_s = Math.round(
          (Date.now() - new Date(startTs).getTime()) / 1000,
        );
        recordEvent({
          ts: new Date().toISOString(),
          event: "end",
          profile: profileName,
          agent: agentKind,
          cwd: process.cwd(),
          duration_s,
        });
      } catch {
        /* best-effort */
      }
      // Sync refreshed credentials back to source so next launch has valid tokens.
      // Freshness guard (mirrors the materializer's preserve step at
      // runtime-materializer.ts:704): write back ONLY when the runtime token is
      // strictly newer than source. Without it, a stale runtime — e.g. a sibling
      // profile rotated the shared source mid-session — would drag a dead, rotated
      // token over a live one and force a re-login. Anthropic rotates the refresh
      // token on every refresh, so the highest expiresAt holds the live token.
      // Must stay synchronous: process.on("exit") handlers cannot await.
      if (credentialsSource) {
        try {
          const {
            copyFileSync,
            readFileSync: rf,
            existsSync: ex,
          } = require("node:fs");
          const runtimeCreds = join(runtime.runtimeDir, ".credentials.json");
          const sourceCreds = join(credentialsSource, ".credentials.json");
          const expiresAt = (p: string): number => {
            try {
              const v = JSON.parse(rf(p, "utf8"))?.claudeAiOauth?.expiresAt;
              return typeof v === "number" ? v : 0;
            } catch {
              return 0;
            }
          };
          if (
            ex(runtimeCreds) &&
            expiresAt(runtimeCreds) > expiresAt(sourceCreds)
          ) {
            copyFileSync(runtimeCreds, sourceCreds);
          }
        } catch {
          /* best-effort */
        }
      }
    });
  } catch {
    /* analytics non-fatal */
  }

  // Resolve one icon per profile part for the tmux status line. Single-part
  // profiles use `profile.icon` directly; composites load each part so every
  // logo shows up (e.g. 📮✍️📡 for postizz+blog-writer+trendradar). Best-effort
  // — a failed load just drops that icon from the strip.
  let profileIcons: string[] = [];
  try {
    const partNames = parseProfileSelector(profileName);
    if (partNames.length <= 1) {
      profileIcons = profile.icon ? [profile.icon] : [];
    } else {
      profileIcons = await Promise.all(
        partNames.map(async (p) => {
          try {
            const part = await loadProfile(p);
            return part.icon ?? "";
          } catch {
            return "";
          }
        }),
      );
    }
  } catch {
    /* best-effort */
  }

  // One-line startup identity banner (stderr). Always prints on a real launch
  // so you can see what you landed in — agent, profile (collapsed to `primary
  // +N` for composites), skill/MCP counts, and always-on token cost. dry-run
  // and --rematerialize return earlier, so this never pollutes their JSON.
  {
    const friendly = agentKind === "claude-code" ? "claude" : agentKind;
    process.stderr.write(
      `${formatStartupBanner({
        title: formatTmuxTitle(friendly, profileName, profileIcons),
        skills: countProfileSkills(profile),
        mcps: profile.mcps.length,
        alwaysOn: alwaysOnForBadge,
      })}\n`,
    );
  }

  const overhead =
    alwaysOnForBadge !== undefined && alwaysOnForBadge >= 2000
      ? {
          dot: tokenLevelEmoji(alwaysOnForBadge),
          size: `${Math.round(alwaysOnForBadge / 1000)}K`,
        }
      : undefined;

  announceTmuxProfile(profileName, agentKind, profileIcons, childEnv, {
    overhead,
    health: healthBadge,
  });

  // Project brief — verified facts about THIS directory (package manager, the
  // real test/build commands, layout). Delivered per process, never through the
  // materialized memory file: that file is keyed by profile and shared by every
  // directory and parallel session using it, so repo-specific text there would
  // leak across projects. Best-effort in every step — a launch never fails
  // because a scan did. `CUE_BRIEF=0` opts out.
  let briefArgs: string[] = [];
  if (process.env.CUE_BRIEF !== "0") {
    try {
      const { scanBrief, renderBrief, buildBriefInjection } =
        await import("../lib/project-brief");
      const scanned = scanBrief(cwd);
      const rendered = scanned ? renderBrief(scanned) : "";
      if (rendered) {
        const injection = buildBriefInjection({
          agent: agentKind,
          brief: rendered,
          briefDir: join(configDir(), "briefs"),
          cwd,
        });
        if (injection.file) {
          const { mkdir, writeFile } = await import("node:fs/promises");
          await mkdir(dirname(injection.file.path), { recursive: true });
          await writeFile(injection.file.path, injection.file.content);
        }
        Object.assign(childEnv, injection.env);
        briefArgs = injection.args;
      }
    } catch (err) {
      debug("launch:brief", err);
    }
  }

  // Keep tokens in step with sibling sessions *while* this one runs — a
  // rotation elsewhere would otherwise revoke ours and force a mid-session
  // re-login.
  const stopReconciler =
    agentKind === "claude-code"
      ? startCredentialReconciler(runtimeKey)
      : undefined;
  const canonicalCodexAuth = canonicalCodexAuthPath();
  const runtimeCodexAuth = join(runtime.runtimeDir, "auth.json");
  if (agentKind === "codex") {
    await syncCodexAuth(canonicalCodexAuth, runtimeCodexAuth);
  }
  let exitCode: number;
  try {
    exitCode = await execAgent(
      realBin.bin,
      [...briefArgs, ...parsed.passthrough],
      realBin.viaOverride ? wrapperEnv(childEnv) : childEnv,
    );
  } finally {
    stopReconciler?.();
  }
  // Persist any /login done inside the session to its account dir now —
  // don't leave the only live rotated token stranded in the per-account runtime.
  if (agentKind === "claude-code") await rescueRuntimeCredsToOwner(runtimeKey);
  if (agentKind === "codex") {
    await syncCodexAuth(runtimeCodexAuth, canonicalCodexAuth);
  }
  // Post-session runtime GC: the child has exited, so this costs zero launch
  // latency. Throttled (~once/day) and never touches the runtime we just used.
  try {
    await maybeAutoGc(runtimeKey);
  } catch {
    /* GC is best-effort */
  }
  return exitCode;
}
