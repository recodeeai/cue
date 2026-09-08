/**
 * Dashboard HTTP server — read-only JSON endpoints over the same data the
 * `cue status`, `cue gates`, `cue skill-report`, `cue suggest-pairs`, and
 * `cue trigger-gaps` commands consume.
 *
 * MVP (this turn): server + endpoints. React UI lives under `web/` and ships
 * in a follow-up turn; today the endpoints can be curled / scripted against.
 *
 * Bind to 127.0.0.1 only by default. The data on disk includes user prompts
 * and skill activations — there is no auth layer in v1, and binding to a
 * public interface would be a privacy footgun.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readFile, stat as statAsync } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { configDir } from "./config-paths";
import { collectLocalInventory } from "./local-inventory";
import { computeStats, computeDailyActivity, sessionDurationSummary } from "./analytics";
import { discoverInstalledPlugins } from "./plugin-discovery";
import { listWorkflows, loadWorkflow, saveWorkflow } from "./workflow-store";
import { listActiveSessions, supportsProcScan } from "./active-sessions";
import { readGateStatus, readAllGateStatus } from "./gate-status";
import { computeAffinityMap, suggestionsByProfile } from "./pair-suggestions";
import { computeSkillUsage } from "./skill-report";
import { computeTriggerGaps } from "./trigger-gaps";
import { loadProfile, listProfiles } from "./profile-loader";
import { countProfileSkills } from "./profile-capabilities";
import {
  mergeProfiles,
  renderMerged,
  writeMergedProfile,
  MergedProfileExists,
  type OptimizeAction,
  type MergeMode,
} from "./profile-merge";
import { validateProfileName } from "./profile-generator";
import { loadMcpCatalog, addMcpToProfile } from "./mcp-catalog";
import { installMarketItem, type MarketAddKind } from "./market-install";
import { aggregateProfileClis, type ProfileCli } from "./skill-clis";
import { collectPermissions } from "./permissions";
import { reposForProfile, resolveRepoStars } from "./repos";
import { parseSkillFromContent, parseSkillFromDir } from "./skill-router";
import { resolveLocalSkill } from "./resolver-local";
import { resolveProfileForCwd } from "./cwd-resolver";
import { quickDiagnose } from "../commands/status";
import { isEnabled as telemetryEnabled } from "./telemetry-consent";
import { collectUserPrompts } from "../commands/trigger-gaps";
import { computeVersionInfo, type NoticePayload, type VersionInfo } from "./dashboard-version";

export { computeVersionInfo, semverGt } from "./dashboard-version";

const REPO_ROOT = resolve(new URL(import.meta.url).pathname, "..", "..", "..");
const WEB_DIST = join(REPO_ROOT, "web", "dist");

/** Standard envelope so the UI doesn't have to special-case per-endpoint shape. */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };


/**
 * Resolve a `?profile=...` query against precedence: explicit → cwd pin →
 * CUE_PROFILE env. Returns null when nothing's set so the handler can
 * return a useful "no profile" error instead of throwing.
 */
function resolveProfileQuery(explicit: string | null): string | null {
  if (explicit) return explicit;
  const pin = join(process.cwd(), ".cue.profile");
  if (existsSync(pin)) {
    try {
      const txt = readFileSync(pin, "utf8").trim().split("\n")[0]?.trim();
      if (txt) return txt;
    } catch { /* ignore */ }
  }
  return process.env.CUE_PROFILE ?? null;
}

function parseSinceDays(raw: string | null, fallback = 30): number {
  if (!raw) return fallback;
  const m = raw.match(/^(\d+)\s*d?$/);
  return m ? Math.max(1, parseInt(m[1]!, 10)) : fallback;
}

// ---------------------------------------------------------------------------
// Handlers — each takes URLSearchParams, returns ApiResult<unknown>.
// Pulled out as plain functions so they're trivially unit-testable without
// going through the HTTP layer.
// ---------------------------------------------------------------------------

interface ProfilePartSummary {
  name: string;
  description: string;
  skills: number;
  mcps: number;
  plugins: number;
}

export async function handleStatus(): Promise<ApiResult<unknown>> {
  const resolved = await resolveProfileForCwd({
    cwd: process.cwd(),
    homeDir: homedir(),
    configDir: configDir(),
  });
  const hasProfile = resolved.source !== "none";
  let profile: ProfilePartSummary | null = null;
  let parts: ProfilePartSummary[] = [];
  let warnings: unknown[] = [];
  let gateRun = null;
  if (hasProfile) {
    const profileName = (resolved as { profile: string }).profile;
    try {
      const loaded = await loadProfile(profileName);
      profile = {
        name: loaded.name,
        description: loaded.description,
        skills: countProfileSkills(loaded),
        mcps: loaded.mcps.length,
        plugins: loaded.plugins.length,
      };
      warnings = quickDiagnose(profileName, loaded);

      // Composite breakdown — when the active selector is `a+b+c`, load each
      // part independently so the dashboard can show the per-part skill /
      // MCP / plugin counts. The composite's totals (in `profile` above)
      // already reflect dedupe + merge; the parts pre-dedupe row sums will
      // exceed them, which is the whole point — it shows what each part
      // contributes. Failures per-part are silent: better to show one part
      // missing than to fall back to no breakdown.
      const partNames = profileName.split("+").map((s) => s.trim()).filter(Boolean);
      if (partNames.length > 1) {
        for (const partName of partNames) {
          try {
            const part = await loadProfile(partName);
            parts.push({
              name: part.name,
              description: part.description,
              skills: countProfileSkills(part),
              mcps: part.mcps.length,
              plugins: part.plugins.length,
            });
          } catch {
            parts.push({
              name: partName,
              description: "(failed to load)",
              skills: 0, mcps: 0, plugins: 0,
            });
          }
        }
      }
    } catch (err) {
      warnings = [{ code: "D0", message: `cannot load profile: ${(err as Error).message}` }];
    }
    gateRun = readGateStatus(profileName);
  }
  const stats = computeStats();
  return {
    ok: true,
    data: {
      profile,
      parts,
      source: resolved.source,
      warnings,
      gates: gateRun
        ? {
            ts: gateRun.ts,
            overall: gateRun.overall,
            failed: gateRun.results.filter((r) => !r.ok).map((r) => r.name),
          }
        : null,
      totalProfiles: (await listProfiles()).length,
      totalSessions: stats.reduce((a, s) => a + s.sessions, 0),
      durations: sessionDurationSummary(),
      telemetryEnabled: telemetryEnabled(),
    },
  };
}

export async function handleProfiles(): Promise<ApiResult<unknown>> {
  const names = await listProfiles();
  const runtimeRoot = join(configDir(), "runtime");
  const rows = names.map((name) => {
    const claudeMd = join(runtimeRoot, name, "claude", "CLAUDE.md");
    let sizeBytes: number | null = null;
    try {
      if (existsSync(claudeMd)) sizeBytes = statSync(claudeMd).size;
    } catch { /* ignore */ }
    return { name, claudeMdBytes: sizeBytes };
  });
  return { ok: true, data: rows };
}

/** Profiles dir the merge engine writes to — honors the same env override. */
function mergeProfilesDir(): string {
  return process.env.CUE_PROFILES_DIR ?? join(REPO_ROOT, "profiles");
}

/**
 * Serve a profile's logo image (`profiles/<name>/<iconImage>`) as raw bytes.
 * Read-only and path-traversal-safe: the profile name is restricted to a
 * single dir segment, the iconImage must be a bare filename, and the resolved
 * path must stay inside the profiles dir. 404 when the profile has no logo.
 */
async function serveProfileIcon(rawName: string | null): Promise<Response> {
  if (!rawName) return new Response("missing profile", { status: 400 });
  // Composite selectors (a+b) → use the first part's logo.
  const name = rawName.split("+")[0]!.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) {
    return new Response("bad profile", { status: 400 });
  }
  let iconImage: string | undefined;
  try {
    iconImage = (await loadProfile(name)).iconImage;
  } catch {
    return new Response("not found", { status: 404 });
  }
  if (!iconImage || iconImage.includes("/") || iconImage.includes("\\") || iconImage.includes("..")) {
    return new Response("no icon", { status: 404 });
  }
  const dir = mergeProfilesDir();
  const file = resolve(join(dir, name, iconImage));
  if (!file.startsWith(resolve(dir))) return new Response("forbidden", { status: 403 });
  if (!existsSync(file) || !statSync(file).isFile()) return new Response("not found", { status: 404 });
  return new Response(readFileSync(file), {
    headers: { "Content-Type": contentTypeFor(file), "Cache-Control": "max-age=3600" },
  });
}

/** Directory holding generated plugin logos, keyed by `<plugin-name>.png`. */
function pluginLogosDir(): string {
  return process.env.CUE_PLUGIN_LOGOS_DIR ?? join(REPO_ROOT, "resources", "plugin-logos");
}

/** Directory holding playbook markdown docs, keyed by `<slug>.md`. */
function playbooksDir(): string {
  return process.env.CUE_PLAYBOOKS_DIR ?? join(REPO_ROOT, "resources", "playbooks");
}

/** Directory holding slash-command markdown docs, keyed by `<ref>.md`. */
function commandsDir(): string {
  return process.env.CUE_COMMANDS_DIR ?? join(REPO_ROOT, "resources", "commands");
}

/**
 * Serve a plugin's logo image as raw bytes. Two sources, tried in order:
 *   1. Reuse — a cue profile sharing the plugin's bare name that ships its own
 *      logo (the `resend` / `vercel` / `stripe` plugins map straight onto
 *      profiles/<name>/<iconImage>).
 *   2. Generated — a PNG under the plugin-logos dir keyed by the plugin name.
 * Path-traversal-safe exactly like serveProfileIcon. 404 when neither exists.
 */
async function servePluginIcon(rawId: string | null): Promise<Response> {
  if (!rawId) return new Response("missing plugin", { status: 400 });
  // Plugin ids are "name@marketplace" — the logo keys off the bare name.
  const name = rawId.split("@")[0]!.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) {
    return new Response("bad plugin", { status: 400 });
  }

  // 1. Reuse a same-named profile's logo when it ships one.
  try {
    const iconImage = (await loadProfile(name)).iconImage;
    if (iconImage && !iconImage.includes("/") && !iconImage.includes("\\") && !iconImage.includes("..")) {
      const pdir = mergeProfilesDir();
      const pfile = resolve(join(pdir, name, iconImage));
      if (pfile.startsWith(resolve(pdir)) && existsSync(pfile) && statSync(pfile).isFile()) {
        return new Response(readFileSync(pfile), {
          headers: { "Content-Type": contentTypeFor(pfile), "Cache-Control": "max-age=3600" },
        });
      }
    }
  } catch {
    // No same-named profile — fall through to generated art.
  }

  // 2. Generated logo under the plugin-logos dir.
  const gdir = pluginLogosDir();
  const gfile = resolve(join(gdir, name + ".png"));
  if (!gfile.startsWith(resolve(gdir))) return new Response("forbidden", { status: 403 });
  if (existsSync(gfile) && statSync(gfile).isFile()) {
    return new Response(readFileSync(gfile), {
      headers: { "Content-Type": "image/png", "Cache-Control": "max-age=3600" },
    });
  }
  return new Response("not found", { status: 404 });
}

/**
 * Full profile inventory for the Merge Studio source list: every profile's
 * resolved skill/MCP/plugin counts plus its `bundles`/`conflicts` hints.
 * Resolution failures (offline npx, missing MCP) degrade to a per-row error
 * rather than failing the whole list.
 */
export async function handleProfilesFull(): Promise<ApiResult<unknown>> {
  const names = await listProfiles();
  const rows = await Promise.all(
    names.map(async (name) => {
      try {
        const p = await loadProfile(name);
        return {
          name,
          icon: p.icon ?? null,
          // Filename (relative to the profile dir) of a real logo, when set —
          // served by GET /api/v1/profile-icon?profile=<name>. null = emoji only.
          // iconImage is inheritable, so a base like core would otherwise leak
          // its logo to every child; only report it when the file actually
          // exists in THIS profile's own dir (also hides dangling refs).
          iconImage:
            p.iconImage && existsSync(join(mergeProfilesDir(), name, p.iconImage))
              ? p.iconImage
              : null,
          description: p.description,
          skills: p.skills.local.length,
          npx: p.skills.npx.length,
          mcps: p.mcps.length,
          plugins: p.plugins.length,
          subagents: p.subagents?.length ?? 0,
          bundles: p.bundles ?? [],
          conflicts: p.conflicts ?? [],
          inheritsCore: p.inheritanceChain.includes("core"),
          error: null as string | null,
        };
      } catch (err) {
        // Degraded row: keep the full ProfileRow shape so consumers can rely
        // on array fields (e.g. conflicts.some(...)) without guarding.
        return {
          name,
          icon: null,
          iconImage: null as string | null,
          description: "",
          skills: 0,
          npx: 0,
          mcps: 0,
          plugins: 0,
          subagents: 0,
          bundles: [] as string[],
          conflicts: [] as string[],
          inheritsCore: false,
          error: (err as Error).message,
        };
      }
    }),
  );
  return { ok: true, data: rows };
}

// ---------------------------------------------------------------------------
// Profile detail — the explorer/search/mcps data source for cue studio.
//
// Returns a profile's full skill catalogue grouped by namespace, each skill's
// SKILL.md body + byte size + connected-MCP hints, plus the profile's MCP,
// plugin, and command refs. Reuses the same loader + resolver + parser the CLI
// uses so the studio reads real on-disk data, never a mock.
//
// Reading 50+ SKILL.md files per request is the heaviest read on the server,
// so the result is cached briefly (keyed by profile selector).
// ---------------------------------------------------------------------------

interface StudioSkill {
  id: string;
  ns: string;
  name: string;
  desc: string;
  sizeK: number;
  body: string;
  uses: string[];
  missing: boolean;
}

/** One `##` heading of a playbook, rendered as a step chip in the studio. */
interface PlaybookStep {
  name: string;
  detail: string;
}

/** A profile's playbook, shaped for the studio Workflows page. */
interface PlaybookWorkflow {
  id: string;
  name: string;
  title: string;
  emoji: string;
  trigger: string;
  est: string;
  desc: string;
  steps: PlaybookStep[];
}

/** A delegatable subagent ref, split into its division + slug for grouping. */
interface SubagentRef {
  /** The raw ref, e.g. "design/design-ui-designer". */
  id: string;
  /** First path segment — the agency division (design, finance, sales…). */
  division: string;
  /** Trailing slug — the agent name. */
  name: string;
}

/** A profile slash-command, resolved from its on-disk markdown source. */
interface StudioCommand {
  /** Display name with the leading slash, e.g. "/goal". */
  name: string;
  /** Bare ref / file stem used to resolve the source, e.g. "goal". */
  ref: string;
  /** One-line `description:` from frontmatter ("" when absent / unresolved). */
  desc: string;
  /** Optional `argument-hint:` from frontmatter. */
  argHint: string | null;
  /** Full markdown body, rendered in the studio editor preview. */
  body: string;
  /** KB size of the source file (0 when unresolved). */
  sizeK: number;
  /** True when no source .md resolved (built-in / plugin-provided command). */
  missing: boolean;
}

interface ProfileDetail {
  profile: string;
  parts: string[];
  counts: { skills: number; mcps: number; plugins: number; commands: number; subagents: number; clis: number };
  skills: StudioSkill[];
  mcps: { id: string; status: string }[];
  plugins: { id: string; name: string; marketplace: string; status: string }[];
  commands: StudioCommand[];
  /** Real on-disk workflows: the playbooks this profile declares, parsed. */
  playbooks: PlaybookWorkflow[];
  /** Delegatable specialists this profile wires into `.claude/agents/`. */
  subagents: SubagentRef[];
  /** External CLI tools the profile's skills declare (frontmatter Bash refs). */
  clis: ProfileCli[];
  /** Companion profiles the active profile recommends pairing with. */
  recommends: string[];
}

/** Pull a `uses:` (or `mcps:`) frontmatter list out of a SKILL.md, if present. */
function parseUsesFromFrontmatter(content: string): string[] {
  const lines = content.split("\n");
  if (lines[0] !== "---") return [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") break;
    const m = lines[i]!.match(/^(?:uses|mcps):\s*\[([^\]]*)\]/);
    if (m) {
      return m[1]!
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
  }
  return [];
}

/** Strip a single matched pair of wrapping quotes — never an unbalanced lone quote. */
function stripWrappingQuotes(s: string): string {
  return s.replace(/^(['"])([\s\S]*)\1$/, "$2");
}

/** Pull `description:` and `argument-hint:` out of a command markdown's frontmatter. */
function parseCommandFrontmatter(content: string): { desc: string; argHint: string | null } {
  // Normalize CRLF so an externally-authored (Windows) command file's "---\r"
  // fence still matches the delimiter check below.
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return { desc: "", argHint: null };
  let desc = "";
  let argHint: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") break;
    const d = lines[i]!.match(/^description:\s*(.+)$/);
    if (d) desc = stripWrappingQuotes(d[1]!.trim());
    const a = lines[i]!.match(/^argument-hint:\s*(.+)$/);
    if (a) argHint = stripWrappingQuotes(a[1]!.trim());
  }
  return { desc, argHint };
}

/** Placeholder body for a command with no on-disk source (plugin / built-in). */
function stubCommandBody(name: string): string {
  return `---
command: ${name}
source: plugin or built-in
---

# ${name}

This command has no markdown source in \`resources/commands/\` — it is contributed by an installed plugin or built in to the agent, so its body isn't stored locally. Invoke it by typing \`${name}\` in the prompt.`;
}

/** Map a playbook slug/title to a stable emoji for its workflow card. */
function playbookEmoji(hint: string): string {
  const s = hint.toLowerCase();
  // Specific themes first — generic "ship/deploy" verbs appear in many titles.
  if (/bug|triage|debug/.test(s)) return "🐛";
  if (/sprint/.test(s)) return "🏃";
  if (/improve|clean|refactor|health/.test(s)) return "🔧";
  if (/skill/.test(s)) return "🧪";
  if (/research|analyze|investigate/.test(s)) return "🔍";
  if (/security|secops|cso/.test(s)) return "🛡";
  if (/doc|write/.test(s)) return "📝";
  if (/growth|market/.test(s)) return "📈";
  if (/vite|web|frontend|design/.test(s)) return "🎨";
  if (/medusa|shop|commerce/.test(s)) return "🛒";
  if (/ship|deploy|release|land|canary/.test(s)) return "🚀";
  return "📋";
}

/** Rough token estimate (~4 chars/token) → compact "~1.2K" label. */
function estTokensLabel(chars: number): string {
  const t = Math.max(1, Math.round(chars / 4));
  if (t < 1000) return `~${t}`;
  return `~${(t / 1000).toFixed(1).replace(/\.0$/, "")}K`;
}

/** Collapse whitespace and cap a string with an ellipsis. */
function collapse(s: string, cap = 160): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > cap ? t.slice(0, cap - 1).trimEnd() + "…" : t;
}

/** Strip leading markdown markers (bullets, numbers, bold) from a line. */
function cleanMdLine(s: string): string {
  return s.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").replace(/\*\*/g, "").trim();
}

/**
 * Parse a playbook markdown doc into a workflow-card model:
 *  - `title` from the `# Playbook: …` H1 (falls back to the prettified slug),
 *  - `desc` from the first "Use when …" paragraph (falls back to the first
 *    non-heading paragraph),
 *  - one `step` per `##` heading, numbered prefix stripped, with a one-line
 *    `detail` pulled from that section's first body line.
 */
function parsePlaybook(slug: string, content: string): PlaybookWorkflow {
  const lines = content.split("\n");

  let title = slug.replace(/[-_]/g, " ");
  const h1Idx = lines.findIndex((l) => /^#\s+/.test(l));
  if (h1Idx >= 0) {
    const m = lines[h1Idx]!.match(/^#\s+(?:Playbook:\s*)?(.+)$/);
    if (m) title = m[1]!.trim();
  }

  let desc = "";
  const gatherParagraph = (start: number): string => {
    const para: string[] = [];
    for (let i = start; i < lines.length && lines[i]!.trim() !== ""; i++) para.push(lines[i]!);
    return collapse(para.join(" "));
  };
  const useIdx = lines.findIndex((l) => /use when/i.test(l));
  if (useIdx >= 0) {
    desc = gatherParagraph(useIdx);
  } else {
    for (let i = h1Idx + 1; i < lines.length; i++) {
      const l = lines[i]!.trim();
      if (!l || l.startsWith("#")) continue;
      desc = gatherParagraph(i);
      break;
    }
  }

  const steps: PlaybookStep[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^##\s+(.+)$/);
    if (!m) continue;
    const name = collapse(m[1]!.replace(/^\d+\.\s*/, ""), 60);
    let detail = "";
    for (let j = i + 1; j < lines.length; j++) {
      if (/^##\s+/.test(lines[j]!)) break;
      const c = cleanMdLine(lines[j]!);
      if (c) { detail = collapse(c, 140); break; }
    }
    steps.push({ name, detail });
  }

  return {
    id: slug,
    name: slug,
    title,
    emoji: playbookEmoji(`${slug} ${title}`),
    trigger: "playbook",
    est: estTokensLabel(content.length),
    desc: desc || `Playbook: ${title}`,
    steps,
  };
}

const profileDetailCache = new Map<string, { ts: number; data: ProfileDetail }>();
const PROFILE_DETAIL_TTL_MS = 60_000;

export async function handleProfileDetail(params: URLSearchParams): Promise<ApiResult<unknown>> {
  // Default to the profile resolved for the server's cwd (same precedence as
  // /status), so the studio opens on the active profile with no query param.
  let name = resolveProfileQuery(params.get("profile"));
  if (!name) {
    const resolved = await resolveProfileForCwd({
      cwd: process.cwd(),
      homeDir: homedir(),
      configDir: configDir(),
    });
    if (resolved.source !== "none") name = (resolved as { profile: string }).profile;
  }
  if (!name) return { ok: false, error: "no-profile" };

  const cached = profileDetailCache.get(name);
  if (cached && Date.now() - cached.ts < PROFILE_DETAIL_TTL_MS) {
    return { ok: true, data: cached.data };
  }

  let profile;
  try {
    profile = await loadProfile(name);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  // Resolve + read each local skill. Failures degrade to a stub entry (kept in
  // the list so tree counts stay honest) rather than failing the whole call.
  const localSkills: StudioSkill[] = await Promise.all(
    profile.skills.local
      .map((s) => s.id)
      .filter((id) => !id.includes("*"))
      .map(async (id): Promise<StudioSkill> => {
        const ns = id.includes("/") ? id.split("/")[0]! : "skills";
        const slug = id.slice(id.lastIndexOf("/") + 1);
        try {
          const dir = await resolveLocalSkill(id);
          const path = join(dir, "SKILL.md");
          const content = await readFile(path, "utf8");
          const sizeK = +((await statAsync(path)).size / 1024).toFixed(1);
          const parsed = parseSkillFromContent(id, content, slug);
          const desc = parsed.capability || parsed.rawDescription || "";
          return { id, ns, name: parsed.name || slug, desc, sizeK, body: content, uses: parseUsesFromFrontmatter(content), missing: false };
        } catch {
          return { id, ns, name: slug, desc: "(SKILL.md could not be read)", sizeK: 0, body: `---\nname: ${slug}\n---\n\n# ${slug}\n\nThis skill could not be resolved on disk.`, uses: [], missing: true };
        }
      }),
  );

  // npx skills: referenced by repo + slug; bodies live in a remote package, so
  // surface them as catalogue entries under the "npx" namespace with a stub body.
  const npxSkills: StudioSkill[] = profile.skills.npx.flatMap((ref) =>
    (ref.skills ?? []).map((slug): StudioSkill => {
      const id = `${ref.repo}#${slug}`;
      const body = `---\nname: ${slug}\nnamespace: npx\nrepo: ${ref.repo}\n---\n\n# ${slug}\n\nProvided on demand via \`npx ${ref.repo}\`. The body is fetched at activation time, so it is not stored locally.`;
      return { id, ns: "npx", name: slug, desc: `npx skill from ${ref.repo}`, sizeK: 0, body, uses: [], missing: false };
    }),
  );

  const skills = [...localSkills, ...npxSkills];

  const plugins = profile.plugins.map((p) => {
    const at = p.id.lastIndexOf("@");
    const pname = at > 0 ? p.id.slice(0, at) : p.id;
    const marketplace = at > 0 ? p.id.slice(at + 1) : "";
    return { id: p.id, name: pname, marketplace, status: "loaded" };
  });

  // Playbooks the profile declares → real on-disk workflows for the studio's
  // Workflows page. Read + parse each; unreadable / oddly-named ones are skipped
  // so one bad file never fails the whole call.
  const pbDir = playbooksDir();
  const playbooks: PlaybookWorkflow[] = (
    await Promise.all(
      (profile.playbooks ?? []).map(async (slug): Promise<PlaybookWorkflow | null> => {
        if (!/^[A-Za-z0-9._-]+$/.test(slug)) return null;
        try {
          const content = await readFile(join(pbDir, `${slug}.md`), "utf8");
          return parsePlaybook(slug, content);
        } catch {
          return null;
        }
      }),
    )
  ).filter((p): p is PlaybookWorkflow => p !== null);

  // Subagents — the delegatable specialists the profile wires into agents/.
  // Refs are "<division>/<slug>"; split for grouped display in the studio.
  const subagents: SubagentRef[] = (profile.subagents ?? []).map((ref) => {
    const slash = ref.indexOf("/");
    const division = slash > 0 ? ref.slice(0, slash) : "other";
    const sname = ref.slice(ref.lastIndexOf("/") + 1);
    return { id: ref, division, name: sname };
  });

  // CLIs the profile's skills shell out to — parsed from the skill bodies we
  // already loaded above (no extra disk reads), enriched from cli-recipes.json.
  const clis = aggregateProfileClis(skills);

  // Commands — resolve each profile-declared slash command to its on-disk
  // markdown (resources/commands/<ref>.md), reading the frontmatter description
  // + argument-hint and the body for the studio's command preview. Refs come
  // from the profile definition, but the stem is validated (no separators, no
  // `..`) so a malformed ref can never read outside the commands dir. Built-in
  // or plugin-provided commands with no source .md degrade to a stub entry
  // (kept in the list so tree counts stay honest).
  const cmdDir = commandsDir();
  const commands: StudioCommand[] = await Promise.all(
    profile.commands.map(async (raw): Promise<StudioCommand> => {
      const ref = raw.replace(/^\//, "").replace(/\.md$/, "");
      const name = `/${ref}`;
      if (!/^[A-Za-z0-9._-]+$/.test(ref) || ref.includes("..")) {
        return { name, ref, desc: "", argHint: null, body: stubCommandBody(name), sizeK: 0, missing: true };
      }
      try {
        const path = join(cmdDir, `${ref}.md`);
        // Belt-and-suspenders containment, mirroring serveProfileIcon: the ref
        // regex already bars separators, but assert the resolved path stays
        // inside the commands dir so a loosened guard can never read outside it.
        if (!resolve(path).startsWith(resolve(cmdDir) + sep)) {
          return { name, ref, desc: "", argHint: null, body: stubCommandBody(name), sizeK: 0, missing: true };
        }
        const content = await readFile(path, "utf8");
        const sizeK = +((await statAsync(path)).size / 1024).toFixed(1);
        const { desc, argHint } = parseCommandFrontmatter(content);
        return { name, ref, desc, argHint, body: content, sizeK, missing: false };
      } catch {
        return { name, ref, desc: "", argHint: null, body: stubCommandBody(name), sizeK: 0, missing: true };
      }
    }),
  );

  const data: ProfileDetail = {
    profile: name,
    parts: name.split("+").map((s) => s.trim()).filter(Boolean),
    counts: {
      skills: skills.length,
      mcps: profile.mcps.length,
      plugins: profile.plugins.length,
      commands: profile.commands.length,
      subagents: subagents.length,
      clis: clis.length,
    },
    skills,
    mcps: profile.mcps.map((m) => ({ id: m.id, status: "connected" })),
    plugins,
    commands,
    playbooks,
    subagents,
    clis,
    recommends: profile.recommends ?? [],
  };

  profileDetailCache.set(name, { ts: Date.now(), data });
  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// Hooks — the active profile's real Claude Code hooks, read from the settings
// files that actually drive them: the cue-materialized runtime settings.json
// (per profile) plus the user's global ~/.claude/settings.json. Flattened and
// grouped by lifecycle event for the studio Hooks view. Read-only.
// ---------------------------------------------------------------------------

interface FlatHook {
  event: string;
  matcher: string;
  command: string;
  description: string;
  id: string;
  source: "profile" | "global";
  /** Absolute path of the script the command runs, if it resolves to one. */
  scriptPath: string | null;
}

interface SettingsHookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string; description?: string; id?: string }[];
}

/** The Claude config dir a hook's `${CLAUDE_CONFIG_DIR}` expands to, by source. */
function claudeDirForSource(source: FlatHook["source"], profileName: string | null): string | null {
  if (source === "global") return join(homedir(), ".claude");
  return profileName ? join(configDir(), "runtime", profileName, "claude") : null;
}

/**
 * Resolve the script file a hook command runs, if any. Expands the env vars cue
 * bakes into materialized hook commands (`${CLAUDE_CONFIG_DIR}` and `~`) and
 * returns an absolute path — or null when the command isn't a script invocation
 * or the path can't be fully resolved (so the UI hides the "view source" link).
 */
function resolveHookScript(command: string, source: FlatHook["source"], profileName: string | null): string | null {
  const m = command.match(/(\S+\.(?:sh|bash|zsh|js|mjs|cjs|ts|py|rb|pl))\b/);
  if (!m) return null;
  const claudeDir = claudeDirForSource(source, profileName);
  let p = m[1]!
    .replace(/\$\{CLAUDE_CONFIG_DIR\}|\$CLAUDE_CONFIG_DIR/g, claudeDir ?? "\0")
    .replace(/^~(?=\/)/, homedir());
  if (p.includes("\0") || p.includes("$")) return null; // unresolved variable
  if (!p.startsWith("/")) return null;                  // only absolute paths
  return resolve(p);
}

/** Extension → human language label for the source viewer's badge + highlighter. */
function hookLanguage(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    sh: "bash", bash: "bash", zsh: "bash",
    js: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", py: "python", rb: "ruby", pl: "perl",
  };
  return map[ext] ?? ext ?? "text";
}

/** Parse the `hooks` map out of one settings.json, tagging each with `source`. */
function readHooksFile(path: string, source: FlatHook["source"], profileName: string | null): FlatHook[] {
  if (!existsSync(path)) return [];
  let parsed: { hooks?: Record<string, SettingsHookEntry[]> };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const hooks = parsed.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  const out: FlatHook[] = [];
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const matcher = g.matcher && g.matcher.length > 0 ? g.matcher : "*";
      for (const h of g.hooks ?? []) {
        if (!h.command) continue;
        out.push({
          event,
          matcher,
          command: h.command,
          description: h.description ?? "",
          id: h.id ?? `${event}:${matcher}:${h.command}`,
          source,
          scriptPath: resolveHookScript(h.command, source, profileName),
        });
      }
    }
  }
  return out;
}

/** Resolve the profile a hooks query targets — explicit param, else cwd. */
async function resolveHooksProfile(profileParam: string | null): Promise<string | null> {
  const explicit = resolveProfileQuery(profileParam);
  if (explicit) return explicit;
  const resolved = await resolveProfileForCwd({ cwd: process.cwd(), homeDir: homedir(), configDir: configDir() });
  return resolved.source !== "none" ? (resolved as { profile: string }).profile : null;
}

/** All hooks (global + this profile's runtime), deduped by id — the shared
 *  source of truth for both the hooks list and the source-viewer allowlist. */
function enumerateHooks(profileName: string | null): FlatHook[] {
  const globalPath = join(homedir(), ".claude", "settings.json");
  const runtimePath = profileName ? join(configDir(), "runtime", profileName, "claude", "settings.json") : null;
  const flat: FlatHook[] = [
    ...readHooksFile(globalPath, "global", null),
    ...(runtimePath ? readHooksFile(runtimePath, "profile", profileName) : []),
  ];
  // Dedup by id (a profile hook overriding a global one wins — it appears later).
  const byId = new Map<string, FlatHook>();
  for (const h of flat) byId.set(h.id, h);
  return [...byId.values()];
}

export async function handleHooks(params: URLSearchParams): Promise<ApiResult<unknown>> {
  const name = await resolveHooksProfile(params.get("profile"));
  const deduped = enumerateHooks(name);

  // Group by event in a stable lifecycle order; unknown events sort last.
  const EVENT_ORDER = [
    "PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart",
    "SessionEnd", "Stop", "SubagentStop", "PreCompact", "Notification",
  ];
  const byEvent = new Map<string, FlatHook[]>();
  for (const h of deduped) {
    if (!byEvent.has(h.event)) byEvent.set(h.event, []);
    byEvent.get(h.event)!.push(h);
  }
  const events = [...byEvent.keys()]
    .sort((a, b) => {
      const ia = EVENT_ORDER.indexOf(a), ib = EVENT_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
    })
    .map((event) => ({ event, hooks: byEvent.get(event)! }));

  return { ok: true, data: { profile: name, total: deduped.length, events } };
}

const HOOK_SOURCE_MAX_BYTES = 256 * 1024;

/**
 * Read one hook's script source for the studio's source viewer. Security: the
 * requested path must be one of the *enumerated* hook script paths for this
 * profile (an allowlist rebuilt per request) — an arbitrary path, or any
 * `../` traversal, fails the membership check before any file is read.
 */
export async function handleHookSource(params: URLSearchParams): Promise<ApiResult<unknown>> {
  const requested = params.get("path");
  if (!requested) return { ok: false, error: "missing-path" };

  const name = await resolveHooksProfile(params.get("profile"));
  const allow = new Set(
    enumerateHooks(name).map((h) => h.scriptPath).filter((p): p is string => !!p),
  );
  const abs = resolve(requested);
  if (!allow.has(abs)) return { ok: false, error: "not-a-hook-script" };
  if (!existsSync(abs) || !statSync(abs).isFile()) return { ok: false, error: "not-found" };
  if (statSync(abs).size > HOOK_SOURCE_MAX_BYTES) return { ok: false, error: "too-large" };

  const home = homedir();
  const displayPath = abs.startsWith(home) ? "~" + abs.slice(home.length) : abs;
  const slash = displayPath.lastIndexOf("/");
  return {
    ok: true,
    data: {
      path: abs,
      displayPath,
      filename: displayPath.slice(slash + 1),
      dir: displayPath.slice(0, slash + 1),
      language: hookLanguage(abs),
      content: readFileSync(abs, "utf8"),
    },
  };
}

interface MergeRequest {
  names?: string[];
  name?: string;
  mode?: MergeMode;
  actions?: OptimizeAction[];
  budget?: number;
  force?: boolean;
}

/** Preview-only merge (no write). Returns the preview + both rendered modes. */
export async function handleMergePreview(body: MergeRequest | null): Promise<ApiResult<unknown>> {
  const names = body?.names;
  if (!Array.isArray(names) || names.length < 2) {
    return { ok: false, error: "need at least 2 source profiles" };
  }
  try {
    const preview = await mergeProfiles(names, {
      name: body?.name,
      optimize: body?.actions,
      budget: body?.budget,
    });
    return {
      ok: true,
      data: {
        preview,
        yaml: { static: renderMerged(preview, "static"), alias: renderMerged(preview, "alias") },
      },
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Write a merged profile to disk. Refuses overwrite unless `force`. */
export async function handleMergeSave(body: MergeRequest | null): Promise<ApiResult<unknown>> {
  const names = body?.names;
  const name = body?.name;
  if (!Array.isArray(names) || names.length < 2) {
    return { ok: false, error: "need at least 2 source profiles" };
  }
  if (!name || !validateProfileName(name)) {
    return { ok: false, error: "invalid profile name (use lowercase kebab-case)" };
  }
  const mode: MergeMode = body?.mode === "alias" ? "alias" : "static";
  try {
    const preview = await mergeProfiles(names, { name, optimize: body?.actions, budget: body?.budget });
    const yaml = renderMerged(preview, mode);
    const existingPath = join(mergeProfilesDir(), name, "profile.yaml");
    const previousYaml = existsSync(existingPath) ? readFileSync(existingPath, "utf8") : null;
    const path = await writeMergedProfile(name, yaml, { force: body?.force });
    return { ok: true, data: { path, mode, created: previousYaml === null, yaml, previousYaml } };
  } catch (err) {
    if (err instanceof MergedProfileExists) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Full MCP catalog — every server cue can wire into a profile, with inferred
 * transport + install hint. Drives the studio's "Available in cue" section.
 * Read-only; the client diffs this against the active profile's `mcps` to show
 * only the not-yet-connected entries.
 */
let mcpCatalogCache: { ts: number; data: unknown[] } | null = null;
const MCP_CATALOG_TTL_MS = 60_000;

export async function handleMcpCatalog(): Promise<ApiResult<unknown>> {
  // The usedBy map below scans every profile via loadProfile; cache the built
  // catalog briefly so a hard refresh / multiple clients don't re-scan all
  // ~77 profiles on every hit. Global data, so a single-slot TTL cache fits.
  if (mcpCatalogCache && Date.now() - mcpCatalogCache.ts < MCP_CATALOG_TTL_MS) {
    return { ok: true, data: mcpCatalogCache.data };
  }
  // Map each MCP id → the profiles that wire it (resolved, so bundle- and
  // core-inherited mcps count), each with its icon — lets the studio show
  // "used by <profile icons>" next to a catalog entry's add button.
  const profilesDir = mergeProfilesDir();
  const usedBy = new Map<
    string,
    { name: string; icon: string | null; iconImage: string | null }[]
  >();
  for (const name of await listProfiles()) {
    try {
      const p = await loadProfile(name);
      const iconImage =
        p.iconImage && existsSync(join(profilesDir, name, p.iconImage)) ? p.iconImage : null;
      for (const m of p.mcps) {
        const list = usedBy.get(m.id) ?? [];
        list.push({ name, icon: p.icon ?? null, iconImage });
        usedBy.set(m.id, list);
      }
    } catch {
      /* skip a profile that won't resolve */
    }
  }
  const data = loadMcpCatalog().map((e) => ({ ...e, usedBy: usedBy.get(e.id) ?? [] }));
  mcpCatalogCache = { ts: Date.now(), data };
  return { ok: true, data };
}

/**
 * Add a catalog MCP to a single physical profile's profile.yaml. The client
 * passes the chosen part-profile (composite runtime profiles have no file to
 * write), validated here against path traversal + catalog membership.
 */
export async function handleMcpAdd(
  body: { id?: unknown; profile?: unknown } | null,
): Promise<ApiResult<unknown>> {
  const id = typeof body?.id === "string" ? body.id : "";
  const profile = typeof body?.profile === "string" ? body.profile : "";
  if (!id) return { ok: false, error: "missing-id" };
  if (!profile) return { ok: false, error: "missing-profile" };
  try {
    const result = await addMcpToProfile(id, profile);
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function handleSkillReport(params: URLSearchParams): Promise<ApiResult<unknown>> {
  if (!telemetryEnabled()) return { ok: false, error: "telemetry-disabled" };
  const name = resolveProfileQuery(params.get("profile"));
  if (!name) return { ok: false, error: "no-profile" };
  const sinceDays = parseSinceDays(params.get("since"));
  try {
    const profile = await loadProfile(name);
    const rows = computeSkillUsage(profile, { windowDays: sinceDays });
    return { ok: true, data: { profile: name, windowDays: sinceDays, rows } };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function handlePairs(params: URLSearchParams): Promise<ApiResult<unknown>> {
  if (!telemetryEnabled()) return { ok: false, error: "telemetry-disabled" };
  const affinity = computeAffinityMap();
  const sug = suggestionsByProfile(affinity);
  const profileFilter = params.get("profile");
  const rows = [...sug.entries()]
    .filter(([profile]) => !profileFilter || profile === profileFilter)
    .map(([profile, partners]) => ({ profile, partners }))
    .sort((a, b) => a.profile.localeCompare(b.profile));
  return { ok: true, data: rows };
}

export async function handleGates(params: URLSearchParams): Promise<ApiResult<unknown>> {
  if (params.get("all") === "1" || params.get("all") === "true") {
    return { ok: true, data: readAllGateStatus() };
  }
  const name = resolveProfileQuery(params.get("profile"));
  if (!name) return { ok: false, error: "no-profile" };
  return { ok: true, data: readGateStatus(name) };
}

// Trigger-gaps is the dashboard's most expensive endpoint (it reads recent
// transcripts and runs skills × prompts matching). Cache the result briefly so
// a page load + auto-refetches don't recompute it back-to-back and stall the
// single-threaded server. Keyed by profile + window; 90s TTL.
const triggerGapsCache = new Map<string, { ts: number; data: unknown }>();
const TRIGGER_GAPS_TTL_MS = 90_000;

export async function handleTriggerGaps(params: URLSearchParams): Promise<ApiResult<unknown>> {
  if (!telemetryEnabled()) return { ok: false, error: "telemetry-disabled" };
  const name = resolveProfileQuery(params.get("profile"));
  if (!name) return { ok: false, error: "no-profile" };
  const sinceDays = parseSinceDays(params.get("since"));
  const cacheKey = `${name}:${sinceDays}`;
  const cached = triggerGapsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TRIGGER_GAPS_TTL_MS) {
    return { ok: true, data: cached.data };
  }
  try {
    const profile = await loadProfile(name);
    const skills = [];
    const skillRefs = (profile.skills?.local ?? [])
      .map((s) => typeof s === "string" ? s : s.id)
      .filter((id) => !id.includes("*"));
    for (const id of skillRefs) {
      try {
        const dir = await resolveLocalSkill(id);
        skills.push(await parseSkillFromDir(id, dir));
      } catch { /* skip unresolvable */ }
    }
    const userPrompts = collectUserPrompts(sinceDays);
    const usage = computeSkillUsage(profile, { windowDays: sinceDays });
    const hits = new Map<string, number>();
    for (const u of usage) hits.set(u.id, u.hits);
    const rows = computeTriggerGaps({ skills, userPrompts, hits });
    const data = { profile: name, windowDays: sinceDays, promptsScanned: userPrompts.length, rows };
    triggerGapsCache.set(cacheKey, { ts: Date.now(), data });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function handleActiveSessions(): Promise<ApiResult<unknown>> {
  // Linux-only via /proc. Returning `supported:false` so the UI can render
  // a clear "platform not supported" message instead of a confused empty list.
  if (!supportsProcScan()) {
    return { ok: true, data: { supported: false, sessions: [] } };
  }
  return { ok: true, data: { supported: true, sessions: listActiveSessions() } };
}

/**
 * Stop one cue-launched agent session by PID. Verifies the target is
 * actually one of ours (has `CUE_PROFILE` in /proc/<pid>/environ) before
 * sending the signal — refuses to kill arbitrary system processes even if
 * the dashboard is exposed beyond loopback.
 */
export async function handleKillSession(
  body: { pid?: number; signal?: NodeJS.Signals } | null,
): Promise<ApiResult<unknown>> {
  if (!body || typeof body.pid !== "number" || !Number.isFinite(body.pid)) {
    return { ok: false, error: "missing-pid" };
  }
  const pid = body.pid;
  if (pid === process.pid) return { ok: false, error: "refuses-to-kill-self" };

  // Authorization: target must be a cue-launched session right now.
  const session = listActiveSessions().find((s) => s.pid === pid);
  if (!session) {
    return { ok: false, error: "not-a-cue-session" };
  }

  const signal: NodeJS.Signals = body.signal === "SIGKILL" ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(pid, signal);
    return { ok: true, data: { pid, signal, profile: session.profile } };
  } catch (err) {
    return { ok: false, error: `kill failed: ${(err as Error).message}` };
  }
}

/**
 * The activity-chart payload (gap-filled sessions-per-day + per-profile counts)
 * for a window. Shared by the polling GET and the SSE stream so both emit the
 * exact same shape — the stream is just this, pushed on change.
 */
export function buildTimeline(sinceDays: number): {
  windowDays: number;
  daily: ReturnType<typeof computeDailyActivity>;
  profiles: { profile: string; sessions: number; lastUsed: string | null }[];
} {
  const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const events = computeStats({ since: cutoff });
  return {
    windowDays: sinceDays,
    daily: computeDailyActivity(sinceDays),
    profiles: events.map((e) => ({
      profile: e.profile,
      sessions: e.sessions,
      lastUsed: e.last_used,
    })),
  };
}

export async function handleTelemetryTimeline(params: URLSearchParams): Promise<ApiResult<unknown>> {
  if (!telemetryEnabled()) return { ok: false, error: "telemetry-disabled" };
  return { ok: true, data: buildTimeline(parseSinceDays(params.get("since"))) };
}

// SSE response headers — no caching, and X-Accel-Buffering: no so any reverse
// proxy (or vite's dev proxy) forwards each event instead of buffering it.
const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no",
} as const;
const STREAM_TICK_MS = 3000;
const STREAM_HEARTBEAT_MS = 20000;

/**
 * Live activity stream (Server-Sent Events). Sends the timeline payload on
 * connect, then re-sends it whenever it changes (recompute + diff every few
 * seconds; identical payloads are suppressed). A periodic comment heartbeat
 * keeps the connection from going idle. One-way + read-only; the browser's
 * EventSource handles reconnection. Returns a streaming Response —
 * `writeWebResponse` pipes text/event-stream bodies instead of buffering them.
 */
export function handleTelemetryStream(params: URLSearchParams): Response {
  const sinceDays = parseSinceDays(params.get("since"));
  const enabled = telemetryEnabled();
  const enc = new TextEncoder();
  let tick: ReturnType<typeof setInterval> | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;
  let lastSent = "";

  const stop = () => {
    if (tick) { clearInterval(tick); tick = null; }
    if (beat) { clearInterval(beat); beat = null; }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (frame: string) => {
        try { controller.enqueue(enc.encode(frame)); } catch { stop(); }
      };
      if (!enabled) {
        // Keep the connection open (heartbeat only) so EventSource doesn't
        // reconnect-spam; the polling GET surfaces "telemetry-disabled" itself.
        emit("event: error\ndata: telemetry-disabled\n\n");
      } else {
        const send = () => {
          let json: string;
          try { json = JSON.stringify(buildTimeline(sinceDays)); } catch { return; }
          if (json === lastSent) return; // suppress unchanged payloads
          lastSent = json;
          emit(`event: timeline\ndata: ${json}\n\n`);
        };
        send(); // initial snapshot, immediately
        tick = setInterval(send, STREAM_TICK_MS);
      }
      beat = setInterval(() => emit(": ping\n\n"), STREAM_HEARTBEAT_MS);
    },
    cancel() { stop(); },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

/**
 * Every Claude Code plugin installed on this machine (enabled or not), read
 * from Claude Code's real store — a superset of the active profile's declared
 * `plugins:`. Powers the studio Plugins page's auto-discovery view.
 */
export async function handleDiscoveredPlugins(): Promise<ApiResult<unknown>> {
  return { ok: true, data: { plugins: discoverInstalledPlugins() } };
}

// ── version / update banner ────────────────────────────────────────────────
// The studio's "update available" pill + maintainer broadcast. This is the one
// outbound call the dashboard makes — a GET of cue-ai's public version doc on
// the npm registry. No user data leaves the box; it's cached ~1h and fail-soft
// (any error → no banner), mirroring the CLI's existing 24h update check.

const NPM_LATEST_URL = "https://registry.npmjs.org/cue-ai/latest";
const VERSION_TTL_MS = 60 * 60 * 1000; // 1h — matches the answer's "cached ~1h".
let versionCache: { ts: number; data: VersionInfo } | null = null;

/** Installed cue-ai version, read from this package's own package.json. */
function localVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function handleVersion(): Promise<ApiResult<unknown>> {
  const current = localVersion();
  // Serve cached registry data but always refresh `current` from disk (cheap,
  // and stays correct across an in-place update without a server restart).
  if (versionCache && Date.now() - versionCache.ts < VERSION_TTL_MS) {
    return { ok: true, data: computeVersionInfo(current, { version: versionCache.data.latest ?? undefined, cue: versionCache.data.notice ? { notice: versionCache.data.notice } : undefined }) };
  }
  let doc: { version?: string; cue?: { notice?: NoticePayload } } | null = null;
  try {
    const res = await fetch(NPM_LATEST_URL, { signal: AbortSignal.timeout(3000) });
    if (res.ok) doc = (await res.json()) as typeof doc;
  } catch {
    // Offline / timeout / blocked → fail-soft: no banner this cycle.
  }
  const data = computeVersionInfo(current, doc);
  versionCache = { ts: Date.now(), data };
  return { ok: true, data };
}

// ── marketplace ─────────────────────────────────────────────────────────────
// One unified feed of everything addable to a profile: shared hosted-registry
// skills/mcps plus this checkout's local library (profiles, mcp catalog, CLIs,
// playbooks, plugins). Normalized into a single MarketItem shape the studio's
// Market page renders as one searchable grid. Read-only; cached 60s like the
// profile-detail cache since it scans the registry + every playbook + plugins.

interface MarketItem {
  id: string;
  type: "profile" | "workflow" | "skill" | "cli" | "mcp" | "plugin";
  name: string;
  author: string;
  handle: string;
  stars: number;
  installs: string;
  when: string;
  featured: boolean;
  desc: string;
  tags: string[];
  source: "registry" | "local";
  add: string;
  addKind: "mcp" | "skill" | "profile" | "cli" | "workflow" | "plugin";
}

interface MarketRegistrySkill {
  id?: string; name?: string; description?: string;
  repo?: string; tags?: string[]; stars?: number; installs?: string; featured?: boolean;
}
interface MarketRegistryMcp {
  id?: string; name?: string; description?: string;
  repo?: string; tags?: string[]; stars?: number; installs?: string; featured?: boolean;
}
interface MarketRegistry {
  skills?: MarketRegistrySkill[];
  mcps?: MarketRegistryMcp[];
}

/** Path to the shared registry doc in this checkout (may not exist). */
function registryIndexPath(): string {
  return join(REPO_ROOT, "docs", "registry", "index.json");
}

const REGISTRY_URL = "https://opencue.github.io/cue/registry/index.json";

/**
 * Load the shared registry — local doc first, then a short-timeout curl fetch,
 * mirroring `loadRegistry` in src/commands/marketplace.ts. Any failure is
 * tolerated (returns null) so the local-library part of the feed still renders
 * offline.
 */
function loadMarketRegistry(): MarketRegistry | null {
  const path = registryIndexPath();
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, "utf8")) as MarketRegistry; } catch { /* fall through */ }
  }
  try {
    const res = spawnSync("curl", ["-sfL", "--max-time", "5", REGISTRY_URL], { encoding: "utf8", timeout: 8000 });
    if (res.status === 0 && res.stdout) return JSON.parse(res.stdout) as MarketRegistry;
  } catch { /* offline / blocked */ }
  return null;
}

/** "owner/name" → display author. "" when the repo field is absent. */
function authorFromRepo(repo: string | undefined): string {
  if (!repo) return "";
  return repo.split("/")[0]!.trim();
}

/** Registry skills + mcps → MarketItem[] (source:"registry"). */
function registryItems(reg: MarketRegistry | null): MarketItem[] {
  if (!reg) return [];
  const items: MarketItem[] = [];
  for (const s of reg.skills ?? []) {
    if (!s.id || !s.repo) continue;
    const handle = authorFromRepo(s.repo);
    items.push({
      id: `skill:${s.id}`,
      type: "skill",
      name: s.name || s.id,
      author: handle || "cue",
      handle: handle || "cue",
      stars: typeof s.stars === "number" ? s.stars : 0,
      installs: s.installs ?? "",
      when: "",
      featured: s.featured === true,
      desc: s.description ?? "",
      tags: Array.isArray(s.tags) ? s.tags : [],
      source: "registry",
      add: `cue marketplace install-skill ${s.repo}`,
      addKind: "skill",
    });
  }
  for (const m of reg.mcps ?? []) {
    if (!m.id) continue;
    const handle = authorFromRepo(m.repo);
    items.push({
      id: `mcp:${m.id}`,
      type: "mcp",
      name: m.name || m.id,
      author: handle || "cue",
      handle: handle || "cue",
      stars: typeof m.stars === "number" ? m.stars : 0,
      installs: m.installs ?? "",
      when: "",
      featured: m.featured === true,
      desc: m.description ?? "",
      tags: Array.isArray(m.tags) ? m.tags : [],
      source: "registry",
      add: `cue marketplace install-mcp ${m.id}`,
      addKind: "mcp",
    });
  }
  return items;
}

/** Every parseable file in resources/playbooks → workflow MarketItem[]. */
function playbookMarketItems(): MarketItem[] {
  const dir = playbooksDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const items: MarketItem[] = [];
  for (const file of files) {
    const slug = file.replace(/\.md$/, "");
    if (!/^[A-Za-z0-9._-]+$/.test(slug)) continue;
    try {
      const content = readFileSync(join(dir, file), "utf8");
      const pb = parsePlaybook(slug, content);
      items.push({
        id: `workflow:${slug}`,
        type: "workflow",
        name: pb.title,
        author: "cue",
        handle: "cue",
        stars: 0,
        installs: "",
        when: "",
        featured: false,
        desc: pb.desc,
        tags: [],
        source: "local",
        add: "(playbook)",
        addKind: "workflow",
      });
    } catch { /* skip unreadable */ }
  }
  return items;
}

/** Local profiles → profile MarketItem[]. */
async function profileMarketItems(): Promise<MarketItem[]> {
  const names = await listProfiles();
  const items: MarketItem[] = [];
  for (const name of names) {
    let desc = "";
    let tags: string[] = [];
    try {
      const p = await loadProfile(name);
      desc = p.description ?? "";
      tags = p.bundles ?? [];
    } catch { /* keep a bare row */ }
    items.push({
      id: `profile:${name}`,
      type: "profile",
      name,
      author: "cue",
      handle: "cue",
      stars: 0,
      installs: "",
      when: "",
      featured: false,
      desc,
      tags,
      source: "local",
      add: `cue use ${name}`,
      addKind: "profile",
    });
  }
  return items;
}

/** Local MCP catalog → mcp MarketItem[], minus ids already in `registryMcpIds`. */
function localMcpMarketItems(registryMcpIds: Set<string>): MarketItem[] {
  return loadMcpCatalog()
    .filter((e) => !registryMcpIds.has(e.id))
    .map((e) => ({
      id: `mcp:${e.id}`,
      type: "mcp" as const,
      name: e.id,
      author: "cue",
      handle: "cue",
      stars: 0,
      installs: "",
      when: "",
      featured: false,
      desc: e.description ?? "",
      tags: [],
      source: "local" as const,
      add: `cue marketplace install-mcp ${e.id}`,
      addKind: "mcp" as const,
    }));
}

/** resources/cli-recipes.json → cli MarketItem[]. */
function cliMarketItems(): MarketItem[] {
  let recipes: Record<string, unknown>;
  try {
    recipes = JSON.parse(readFileSync(join(REPO_ROOT, "resources", "cli-recipes.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }
  const items: MarketItem[] = [];
  for (const [name, recipe] of Object.entries(recipes)) {
    // Skip the schema-doc key and any non-object entries.
    if (name.startsWith("$") || typeof recipe !== "object" || recipe === null) continue;
    const r = recipe as { needs?: unknown; apt?: unknown; brew?: unknown };
    const desc = typeof r.needs === "string" ? r.needs : "";
    items.push({
      id: `cli:${name}`,
      type: "cli",
      name,
      author: "cue",
      handle: "cue",
      stars: 0,
      installs: "",
      when: "",
      featured: false,
      desc,
      tags: [],
      source: "local",
      add: "(see recipe)",
      addKind: "cli",
    });
  }
  return items;
}

/** Installed Claude Code plugins → plugin MarketItem[]. */
function pluginMarketItems(): MarketItem[] {
  return discoverInstalledPlugins().map((p) => ({
    id: `plugin:${p.id}`,
    type: "plugin" as const,
    name: p.name,
    author: "cue",
    handle: "cue",
    stars: 0,
    installs: "",
    when: relativeAge(p.installedAt),
    featured: false,
    desc: p.description ?? "",
    tags: [],
    source: "local" as const,
    add: `cue marketplace install-plugin ${p.id}`,
    addKind: "plugin" as const,
  }));
}

/** ISO timestamp → compact relative age ("2d","1w","now"); "" when absent. */
function relativeAge(iso: string | null): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 60) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

interface MarketData { items: MarketItem[]; counts: Record<string, number> }
let marketCache: { ts: number; data: MarketData } | null = null;
const MARKET_TTL_MS = 60_000;

/**
 * Unified marketplace feed: shared-registry skills/mcps + the local library
 * (profiles, mcp catalog, CLIs, playbooks, plugins), normalized into one
 * MarketItem[] with per-type counts. Registry fetch failures degrade to the
 * local-only feed. Cached 60s. featured = any registry item flagged featured,
 * else the top 3 items by stars.
 */
export async function handleMarket(): Promise<ApiResult<unknown>> {
  if (marketCache && Date.now() - marketCache.ts < MARKET_TTL_MS) {
    return { ok: true, data: marketCache.data };
  }

  const reg = loadMarketRegistry();
  const regItems = registryItems(reg);
  const registryMcpIds = new Set(
    regItems.filter((i) => i.type === "mcp").map((i) => i.id.slice("mcp:".length)),
  );

  const items: MarketItem[] = [
    ...regItems,
    ...(await profileMarketItems()),
    ...localMcpMarketItems(registryMcpIds),
    ...cliMarketItems(),
    ...playbookMarketItems(),
    ...pluginMarketItems(),
  ];

  // Featured: honor any registry-flagged item; otherwise spotlight the top 3
  // by stars (only registry items carry stars, so this picks the most-starred
  // registry entries when nothing is explicitly flagged).
  const anyFlagged = items.some((i) => i.featured);
  if (!anyFlagged) {
    const top3 = [...items].sort((a, b) => b.stars - a.stars).slice(0, 3);
    const top3Ids = new Set(top3.map((i) => i.id));
    for (const i of items) i.featured = top3Ids.has(i.id) && i.stars > 0;
  }

  const counts: Record<string, number> = {
    all: items.length,
    profile: 0, workflow: 0, skill: 0, cli: 0, mcp: 0, plugin: 0,
  };
  for (const i of items) counts[i.type] = (counts[i.type] ?? 0) + 1;

  const data: MarketData = { items, counts };
  marketCache = { ts: Date.now(), data };
  return { ok: true, data };
}

const MARKET_ADD_KINDS = new Set<MarketAddKind>(["mcp", "skill", "profile", "cli", "workflow", "plugin"]);

/**
 * Install a marketplace item into a profile (the studio's "Add to profile"
 * picker). Validates the body, edits the target profile.yaml via
 * installMarketItem, and busts the market cache so the next browse reflects any
 * new profile membership. Returns `manual` for kinds with no profile.yaml home
 * (a bare CLI) so the studio can show the command instead of claiming success.
 */
export async function handleMarketInstall(
  body: { id?: unknown; addKind?: unknown; profile?: unknown; add?: unknown } | null,
): Promise<ApiResult<unknown>> {
  const id = typeof body?.id === "string" ? body.id : "";
  const addKind = typeof body?.addKind === "string" ? (body.addKind as MarketAddKind) : "";
  const profile = typeof body?.profile === "string" ? body.profile : "";
  const add = typeof body?.add === "string" ? body.add : undefined;
  if (!id) return { ok: false, error: "missing-id" };
  if (!addKind || !MARKET_ADD_KINDS.has(addKind as MarketAddKind)) return { ok: false, error: "invalid-add-kind" };
  if (!profile) return { ok: false, error: "missing-profile" };
  try {
    const result = await installMarketItem({ id, addKind: addKind as MarketAddKind, profile, add });
    if (result.changed) marketCache = null; // counts/membership may have shifted
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ── Workflows: the n8n-style canvas's saved DAGs (resources/workflows/*.json) ──
export async function handleWorkflows(): Promise<ApiResult<unknown>> {
  return { ok: true, data: listWorkflows() };
}

export async function handleWorkflow(params: URLSearchParams): Promise<ApiResult<unknown>> {
  const name = params.get("name");
  if (!name) return { ok: false, error: "missing-name" };
  try {
    const wf = loadWorkflow(name);
    return wf ? { ok: true, data: wf } : { ok: false, error: "not-found" };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function handleWorkflowSave(body: unknown): Promise<ApiResult<unknown>> {
  try {
    return { ok: true, data: saveWorkflow(body, new Date().toISOString()) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ════════ ENV VARIABLES ════════
// Per-folder .env viewer. Reads real `<folder>/.env` from an allowlist of
// project folders, parses KEY=value, classifies each var, and MASKS secret
// values server-side — a raw secret value is returned only when the request
// names that key in `reveal`. Loopback-only trust boundary (see binding note).

/** Project folders whose `.env` the studio may read. `~` expands to $HOME.
 *  Mirrors the design's folder list; the canonical home for the user's repos. */
const ENV_FOLDER_DEFS: ReadonlyArray<{ path: string; tag: string }> = [
  { path: "~/Documents/cue", tag: "cue" },
  { path: "~/Documents/recodee/authmux", tag: "authmux" },
  { path: "~/Documents/x-growth-bot", tag: "x-growth-bot" },
  { path: "~/work/medusa", tag: "medusa" },
  { path: "~/Documents/medusa-shops/marva", tag: "marva" },
  { path: "~/Documents/gitguardex", tag: "gitguardex" },
];

const expandHome = (p: string): string => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

const ENV_SECRET_RE = /(SECRET|_KEY|TOKEN|PASSWORD|PASSWD|_PASS|CREDENTIAL|DATABASE_URL|_DSN|PRIVATE)/i;
type EnvKind = "secret" | "url" | "bool" | "num" | "plain";
function classifyEnvVar(key: string, val: string): EnvKind {
  if (ENV_SECRET_RE.test(key)) return "secret";
  if (/^https?:\/\//.test(val)) return "url";
  if (/^(true|false)$/i.test(val)) return "bool";
  if (/^\d+$/.test(val)) return "num";
  return "plain";
}
interface EnvVarRow { key: string; value: string; kind: EnvKind; masked: boolean }
/** Mask all but the first/last 3 chars (mirrors the design's mask()). */
function maskSecretValue(v: string): string {
  return v.length <= 8 ? "•".repeat(v.length) : v.slice(0, 3) + "•".repeat(Math.min(18, v.length - 6)) + v.slice(-3);
}
function parseEnvText(raw: string, revealKey: string): EnvVarRow[] {
  const out: EnvVarRow[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip a single layer of surrounding quotes, like dotenv does.
    if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
      value = value.slice(1, -1);
    }
    const kind = classifyEnvVar(key, value);
    const isSecret = kind === "secret";
    // `reveal` names a single key, or "*" to reveal every secret at once.
    const reveal = isSecret && (revealKey === "*" || revealKey === key);
    out.push({ key, value: isSecret && !reveal ? maskSecretValue(value) : value, kind, masked: isSecret && !reveal });
  }
  return out;
}

/** GET /api/v1/env/folders → the allowlisted project folders + their var counts. */
export async function handleEnvFolders(): Promise<ApiResult<unknown>> {
  const folders = ENV_FOLDER_DEFS.map((f) => {
    const abs = join(expandHome(f.path), ".env");
    let count = 0;
    try { if (existsSync(abs)) count = parseEnvText(readFileSync(abs, "utf8"), "").length; } catch { /* unreadable → 0 */ }
    return { path: f.path, tag: f.tag, count };
  });
  return { ok: true, data: { folders } };
}

/** GET /api/v1/env?folder=<path>[&reveal=<KEY>] → parsed, masked vars for one
 *  allowlisted folder. `reveal` returns the raw value for that single key. */
export async function handleEnv(params: URLSearchParams): Promise<ApiResult<unknown>> {
  const folder = params.get("folder") ?? "";
  const reveal = params.get("reveal") ?? "";
  // Allowlist: the requested folder must be one we offer — no arbitrary paths.
  const def = ENV_FOLDER_DEFS.find((f) => f.path === folder);
  if (!def) return { ok: false, error: "unknown-folder" };
  const abs = join(expandHome(def.path), ".env");
  if (!existsSync(abs)) return { ok: true, data: { folder: def.path, tag: def.tag, exists: false, vars: [] } };
  let raw = "";
  try { raw = readFileSync(abs, "utf8"); } catch (err) { return { ok: false, error: `read failed: ${(err as Error).message}` }; }
  return { ok: true, data: { folder: def.path, tag: def.tag, exists: true, vars: parseEnvText(raw, reveal) } };
}

/**
 * GitHub source repos a profile's skills / MCPs / plugins originate from, with
 * live star counts. Derives the profile's namespace / MCP / plugin sets from
 * the resolved profile, filters the curated catalog to what it actually
 * contains, then resolves each repo's stargazers (cached 6h, fail-soft).
 */
export async function handleRepos(params: URLSearchParams): Promise<ApiResult<unknown>> {
  let name = resolveProfileQuery(params.get("profile"));
  if (!name) {
    const resolved = await resolveProfileForCwd({
      cwd: process.cwd(),
      homeDir: homedir(),
      configDir: configDir(),
    });
    if (resolved.source !== "none") name = (resolved as { profile: string }).profile;
  }
  if (!name) return { ok: false, error: "no-profile" };

  let profile;
  try {
    profile = await loadProfile(name);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const namespaces = new Set<string>();
  for (const s of profile.skills.local) {
    namespaces.add(s.id.includes("/") ? s.id.split("/")[0]! : "skills");
  }
  if (profile.skills.npx.length) namespaces.add("npx");
  const mcpIds = profile.mcps.map((m) => m.id);
  const pluginIds = profile.plugins.map((p) => p.id);

  const matched = reposForProfile({ namespaces, mcpIds, pluginIds });
  const repos = await resolveRepoStars(matched, Date.now());
  return { ok: true, data: { profile: name, repos } };
}

const ROUTES: Record<string, (params: URLSearchParams) => Promise<ApiResult<unknown>>> = {
  "/api/v1/status":             () => handleStatus(),
  "/api/v1/env/folders":        () => handleEnvFolders(),
  "/api/v1/env":                (p) => handleEnv(p),
  "/api/v1/plugins/discovered": () => handleDiscoveredPlugins(),
  "/api/v1/workflows":          () => handleWorkflows(),
  "/api/v1/workflow":           (p) => handleWorkflow(p),
  "/api/v1/profiles":           () => handleProfiles(),
  "/api/v1/profiles/full":      () => handleProfilesFull(),
  "/api/v1/profile-detail":     (p) => handleProfileDetail(p),
  "/api/v1/hooks":              (p) => handleHooks(p),
  "/api/v1/hook-source":        (p) => handleHookSource(p),
  "/api/v1/skill-report":       (p) => handleSkillReport(p),
  "/api/v1/pairs":              (p) => handlePairs(p),
  "/api/v1/gates":              (p) => handleGates(p),
  "/api/v1/trigger-gaps":       (p) => handleTriggerGaps(p),
  "/api/v1/active-sessions":    () => handleActiveSessions(),
  "/api/v1/telemetry/timeline": (p) => handleTelemetryTimeline(p),
  "/api/v1/mcps/catalog":       () => handleMcpCatalog(),
  "/api/v1/market":             () => handleMarket(),
  "/api/v1/version":            () => handleVersion(),
  "/api/v1/permissions":        () => Promise.resolve({ ok: true, data: collectPermissions() }),
  "/api/v1/repos":              (p) => handleRepos(p),
};

function contentTypeFor(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js"))   return "application/javascript; charset=utf-8";
  if (path.endsWith(".css"))  return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg"))  return "image/svg+xml";
  if (path.endsWith(".png"))  return "image/png";
  return "application/octet-stream";
}

/**
 * Build the request handler. Exported so tests can mount it without
 * actually binding a port.
 */
export function createHandler(): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (url.pathname === "/api/v1/inventory") {
      if (req.method !== "GET") return Response.json({ ok: false, error: "method-not-allowed" }, { status: 405, headers: { Allow: "GET" } });
      const site = req.headers.get("sec-fetch-site");
      if (site === "cross-site" || site === "same-site") return Response.json({ ok: false, error: "inventory-cross-origin-blocked" }, { status: 403 });
      if (url.search) return Response.json({ ok: false, error: "inventory-invalid-query" }, { status: 400 });
      try {
        return Response.json({ ok: true, data: await collectLocalInventory() }, { headers: { "Cache-Control": "no-store" } });
      } catch {
        return Response.json({ ok: false, error: "inventory-unavailable" }, { status: 500 });
      }
    }

    // Write-side endpoints (POST). Kept on a small, explicit allowlist so
    // the read-only GET surface stays clearly separated. 127.0.0.1 binding
    // is the v1 trust boundary — anyone hitting these from localhost is
    // assumed to be the user.
    if (req.method === "POST" && url.pathname === "/api/v1/sessions/kill") {
      let body: { pid?: number; signal?: NodeJS.Signals } | null = null;
      try { body = (await req.json()) as typeof body; } catch { /* malformed */ }
      const result = await handleKillSession(body);
      return Response.json(result, { status: result.ok ? 200 : 400 });
    }

    if (req.method === "POST" && url.pathname === "/api/v1/merge/preview") {
      let body: unknown = null;
      try { body = await req.json(); } catch { /* malformed */ }
      const result = await handleMergePreview(body as Parameters<typeof handleMergePreview>[0]);
      return Response.json(result, { status: result.ok ? 200 : 400 });
    }

    if (req.method === "POST" && url.pathname === "/api/v1/merge/save") {
      let body: unknown = null;
      try { body = await req.json(); } catch { /* malformed */ }
      const result = await handleMergeSave(body as Parameters<typeof handleMergeSave>[0]);
      return Response.json(result, { status: result.ok ? 200 : 400 });
    }

    if (req.method === "POST" && url.pathname === "/api/v1/mcps/add") {
      let body: unknown = null;
      try { body = await req.json(); } catch { /* malformed */ }
      const result = await handleMcpAdd(body as Parameters<typeof handleMcpAdd>[0]);
      return Response.json(result, { status: result.ok ? 200 : 400 });
    }

    if (req.method === "POST" && url.pathname === "/api/v1/market/install") {
      let body: unknown = null;
      try { body = await req.json(); } catch { /* malformed */ }
      const result = await handleMarketInstall(body as Parameters<typeof handleMarketInstall>[0]);
      return Response.json(result, { status: result.ok ? 200 : 400 });
    }

    if (req.method === "POST" && url.pathname === "/api/v1/workflows/save") {
      let body: unknown = null;
      try { body = await req.json(); } catch { /* malformed */ }
      const result = await handleWorkflowSave(body);
      return Response.json(result, { status: result.ok ? 200 : 400 });
    }

    // Live activity stream (Server-Sent Events, not JSON): pushes the timeline
    // payload on change so the dashboard chart auto-updates without polling.
    if (req.method === "GET" && url.pathname === "/api/v1/telemetry/stream") {
      return handleTelemetryStream(url.searchParams);
    }

    // Profile logo bytes (not JSON): GET /api/v1/profile-icon?profile=<name>.
    // Serves profiles/<name>/<iconImage> for profiles that set one.
    if (req.method === "GET" && url.pathname === "/api/v1/profile-icon") {
      return serveProfileIcon(url.searchParams.get("profile"));
    }

    // Plugin logo bytes (not JSON): GET /api/v1/plugin-icon?plugin=<id>.
    // Reuses a same-named profile's logo, else a generated PNG.
    if (req.method === "GET" && url.pathname === "/api/v1/plugin-icon") {
      return servePluginIcon(url.searchParams.get("plugin"));
    }

    if (url.pathname.startsWith("/api/v1/")) {
      // Defense-in-depth for the secret-revealing path: a `reveal` request to
      // /api/v1/env returns raw .env secrets. Even though the server has no
      // permissive CORS (so a cross-origin tab can't read the response) and
      // binds loopback by default, refuse a reveal whose Sec-Fetch-Site marks
      // it cross-origin — so a drive-by tab can't pull plaintext even if CORS
      // or the bind host were ever loosened. Same-origin (the studio SPA),
      // `none` (address-bar), and header-absent (curl / tests) are allowed.
      if (url.pathname === "/api/v1/env" && url.searchParams.get("reveal")) {
        const site = req.headers.get("sec-fetch-site");
        if (site === "cross-site" || site === "same-site") {
          return Response.json({ ok: false, error: "reveal-cross-origin-blocked" }, { status: 403 });
        }
      }
      const handler = ROUTES[url.pathname];
      if (!handler) {
        return Response.json({ ok: false, error: "not-found" }, { status: 404 });
      }
      try {
        const result = await handler(url.searchParams);
        return Response.json(result, {
          status: result.ok ? 200 : 400,
          headers: { "Cache-Control": "max-age=5" },
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: (err as Error).message },
          { status: 500 },
        );
      }
    }

    // Static file serving for the React app (when web/dist/ exists).
    if (existsSync(WEB_DIST)) {
      const requested = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = join(WEB_DIST, requested);
      // Prevent path traversal — the resolved path must stay inside WEB_DIST.
      const resolved2 = resolve(file);
      if (!resolved2.startsWith(WEB_DIST)) {
        return new Response("forbidden", { status: 403 });
      }
      if (existsSync(resolved2) && statSync(resolved2).isFile()) {
        return new Response(readFileSync(resolved2), {
          headers: { "Content-Type": contentTypeFor(resolved2) },
        });
      }
      // SPA fallback — any unknown path serves index.html so client-side
      // routing works.
      const indexHtml = join(WEB_DIST, "index.html");
      if (existsSync(indexHtml)) {
        return new Response(readFileSync(indexHtml), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }

    // No web build yet — emit a friendly JSON shaped like the API so curl
    // users see what they're getting.
    return Response.json(
      {
        ok: true,
        data: {
          message: "cue dashboard server running — UI not yet built (run a future release with web/dist)",
          api: Object.keys(ROUTES),
        },
      },
      { status: 200 },
    );
  };
}

/** Discover web build status without trying to start the server. */
export function webDistExists(): boolean {
  return existsSync(WEB_DIST);
}
