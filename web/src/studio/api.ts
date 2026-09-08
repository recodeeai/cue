/**
 * cue studio data layer. Thin TanStack Query hooks over the existing
 * `fetcher` (local Bun dashboard server `/api/v1/*`, or the Vercel demo
 * blob). Every view reads from here — no component touches `fetch` directly.
 *
 * The studio's "live" data (skills, profiles, sessions, gates, activity)
 * comes from these endpoints. Fields the proxy has no source for (MCP tool
 * inventories / latency, workflows) are filled from `./curated.ts`, which is
 * clearly labelled so real vs. curated never blurs.
 */

import { useQuery } from "@tanstack/react-query";

import { fetcher, postJson } from "../lib/fetcher";
export { fetcher, postJson } from "../lib/fetcher";
export type { ProfileRow, MergePreview, PreviewResponse, SaveResponse, OptimizeAction } from "../lib/fetcher";

// ---------------------------------------------------------------------------
// Endpoint payload shapes (mirror src/lib/dashboard-server.ts handlers)
// ---------------------------------------------------------------------------

export interface StudioSkill {
  id: string;
  ns: string;
  name: string;
  desc: string;
  sizeK: number;
  body: string;
  uses: string[];
  missing: boolean;
}

export interface StudioMcpRef {
  id: string;
  status: string;
}

export interface StudioPluginRef {
  id: string;
  name: string;
  marketplace: string;
  status: string;
}

/** A profile slash-command, resolved from its on-disk markdown source. */
export interface StudioCommand {
  /** Display name with the leading slash, e.g. "/goal". */
  name: string;
  /** Bare ref / file stem, e.g. "goal". */
  ref: string;
  /** One-line description from frontmatter ("" when absent / unresolved). */
  desc: string;
  /** Optional argument hint from frontmatter. */
  argHint: string | null;
  /** Full markdown body for the editor preview. */
  body: string;
  /** KB size of the source file (0 when unresolved). */
  sizeK: number;
  /** True when no source .md resolved (built-in / plugin-provided command). */
  missing: boolean;
}

/** A plugin installed in Claude Code itself, discovered from its real store. */
export interface DiscoveredPlugin {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  enabled: boolean;
  known: boolean;
  installedAt: string | null;
  installPath: string | null;
  description: string;
  skills: number;
}

/** One `##` heading of a playbook, rendered as a step chip. */
export interface PlaybookStep {
  name: string;
  detail: string;
}

/** A profile's playbook, shaped for the Workflows page. */
export interface PlaybookWorkflow {
  id: string;
  name: string;
  title: string;
  emoji: string;
  trigger: string;
  est: string;
  desc: string;
  steps: PlaybookStep[];
}

/** A delegatable subagent ref, split into division + slug for grouping. */
export interface SubagentRef {
  id: string;
  division: string;
  name: string;
}

export interface ProfileCli {
  name: string;
  install: string;
  known: boolean;
  usedBy: string[];
}

export interface ProfileDetail {
  profile: string;
  parts: string[];
  counts: { skills: number; mcps: number; plugins: number; commands: number; subagents: number; clis: number };
  skills: StudioSkill[];
  mcps: StudioMcpRef[];
  plugins: StudioPluginRef[];
  commands: StudioCommand[];
  /** Real on-disk workflows: the playbooks this profile declares, parsed. */
  playbooks: PlaybookWorkflow[];
  /** Delegatable specialists this profile wires into `.claude/agents/`. */
  subagents: SubagentRef[];
  /** External CLI tools the profile's skills declare (frontmatter Bash refs). */
  clis: ProfileCli[];
  /** Companion profiles this profile recommends pairing with. */
  recommends: string[];
}

export interface PartSummary {
  name: string;
  description: string;
  skills: number;
  mcps: number;
  plugins: number;
}

export interface StatusData {
  profile: PartSummary | null;
  parts: PartSummary[];
  source: string;
  warnings: { code?: string; message?: string }[];
  gates: { ts: string; overall: string; failed: string[] } | null;
  totalProfiles: number;
  totalSessions: number;
  durations: { avgS: number; totalS: number; ended: number };
  telemetryEnabled: boolean;
}

export interface TimelineData {
  windowDays: number;
  daily: { date: string; sessions: number }[];
  profiles: { profile: string; sessions: number; lastUsed: string | null }[];
}

export interface ActiveSession {
  pid: number;
  profile: string;
  profileSource: "env" | "config-dir" | "cwd-pin" | "unpinned";
  agent: string | null;
  cwd: string | null;
  startedAt: string;
}

export interface ActiveSessionsData {
  supported: boolean;
  sessions: ActiveSession[];
}

export interface McpCatalogEntry {
  id: string;
  description: string;
  transport: "stdio" | "sse" | "http" | "unknown";
  install: string;
  /** Profiles that wire this MCP (resolved) — rendered as icons by the studio. */
  usedBy: { name: string; icon: string | null; iconImage: string | null }[];
}

export interface AddMcpResult {
  id: string;
  profile: string;
  alreadyPresent: boolean;
}

/**
 * One marketplace item — shared byte-for-byte with the backend `/market`
 * handler's `data.items[]`. `source` distinguishes shared hosted-registry
 * entries from this checkout's local library; `add` is the copy-paste install
 * command and `addKind` routes the "Add to profile" picker.
 */
export interface MarketItem {
  sourceUrl?: string;
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

export interface MarketData {
  items: MarketItem[];
  counts: Record<string, number>;
}

/** Result of POST /market/install — the profile.yaml edit that backs "Add to profile". */
export interface MarketInstallResult {
  id: string;
  profile: string;
  addKind: MarketItem["addKind"];
  /** True when the profile.yaml was actually edited. */
  changed: boolean;
  /** True when the item was already wired into the profile. */
  alreadyPresent: boolean;
  detail: string;
  /** Present for a bare CLI (no profile.yaml home) — the command to run instead. */
  manual?: { command: string };
}

/**
 * Install a marketplace item into one of the user's profiles. Edits the target
 * profile.yaml server-side (skill → skills.npx, mcp → mcps, plugin → plugins,
 * profile → inherits, workflow → playbooks). A bare CLI comes back with
 * `manual` set so the caller can show the command instead.
 */
export function installMarketItem(item: Pick<MarketItem, "id" | "addKind" | "add">, profile: string) {
  return postJson<MarketInstallResult>("/market/install", {
    id: item.id,
    addKind: item.addKind,
    add: item.add,
    profile,
  });
}

export interface SkillUsageRow {
  id: string;
  hits: number;
  lastUsed: string | null;
  zombie: boolean;
}
export interface SkillReportData {
  profile: string;
  windowDays: number;
  rows: SkillUsageRow[];
}

export interface HookEntry {
  event: string;
  matcher: string;
  command: string;
  description: string;
  id: string;
  source: "profile" | "global";
  /** Absolute path of the script the command runs, or null when it isn't one. */
  scriptPath: string | null;
}

/** One hook's resolved script source, for the studio's source viewer. */
export interface HookSource {
  path: string;
  displayPath: string;
  filename: string;
  dir: string;
  language: string;
  content: string;
}
export interface HooksData {
  profile: string | null;
  total: number;
  events: { event: string; hooks: HookEntry[] }[];
}

/** A real Claude Code tool-permission rule from settings.json. */
export type PermMode = "allow" | "ask" | "deny";
export interface PermRule {
  tool: string;
  pattern: string;
  mode: PermMode;
  sources: string[];
}
export interface PermSourceFile { label: string; path: string; present: boolean }
export interface PermissionsData {
  rules: PermRule[];
  counts: Record<PermMode, number>;
  defaultMode: string | null;
  sources: PermSourceFile[];
}

/** A GitHub source repo for a profile's components, with a live star count. */
export type RepoKind = "profile" | "skill" | "mcp" | "plugin" | "workflow" | "cli";
export interface RepoEntry {
  repo: string;
  url: string;
  desc: string;
  kinds: RepoKind[];
  /** Live stargazer count, or null when GitHub couldn't be reached. */
  stars: number | null;
}
export interface ReposData {
  profile: string;
  repos: RepoEntry[];
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Probe `/status` — also the offline detector the shell uses. */
export function useStatus(refetchMs = 5000) {
  return useQuery({
    queryKey: ["status"],
    queryFn: () => fetcher<StatusData>("/status"),
    refetchInterval: refetchMs,
  });
}

/** Maintainer broadcast baked into the published package.json `cue.notice`. */
export interface VersionNotice { message?: string; command?: string }
/** Update-banner payload from /version (npm registry, cached + fail-soft). */
export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  notice: VersionNotice | null;
}

/** Installed vs latest cue-ai version + maintainer notice. Polls hourly. */
export function useVersion() {
  return useQuery({
    queryKey: ["version"],
    queryFn: () => fetcher<VersionInfo>("/version"),
    staleTime: 60 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000,
  });
}

/** Full skill/mcp/plugin/command catalogue for a profile (or the active one). */
export function useProfileDetail(profile?: string) {
  const qs = profile ? `?profile=${encodeURIComponent(profile)}` : "";
  return useQuery({
    queryKey: ["profile-detail", profile ?? "@active"],
    queryFn: () => fetcher<ProfileDetail>(`/profile-detail${qs}`),
  });
}

/** Every profile with resolved counts — drives the explorer switcher + merge palette. */
export function useProfilesFull() {
  return useQuery({
    queryKey: ["profiles-full"],
    queryFn: () => fetcher<import("../lib/fetcher").ProfileRow[]>("/profiles/full"),
  });
}

/**
 * Full MCP catalog — every server cue can wire into a profile. The Mcps view
 * diffs this against the active profile's connected mcps to show the
 * not-yet-connected "Available in cue" set. Rarely changes, so it caches long.
 */
export function useMcpCatalog() {
  return useQuery({
    queryKey: ["mcp-catalog"],
    queryFn: () => fetcher<McpCatalogEntry[]>("/mcps/catalog"),
    staleTime: 60_000,
  });
}

/** Add a catalog MCP to a single physical part-profile's profile.yaml. */
export function addMcp(id: string, profile: string) {
  return postJson<AddMcpResult>("/mcps/add", { id, profile });
}

/** Sessions-per-day + per-profile counts for the dashboard activity chart. */
export function useTimeline(since = 30, refetchMs: number | false = 5000) {
  return useQuery({
    queryKey: ["timeline", since],
    queryFn: () => fetcher<TimelineData>(`/telemetry/timeline?since=${since}`),
    refetchInterval: refetchMs,
  });
}

/** Live agent sessions (Linux /proc scan). */
export function useActiveSessions(refetchMs = 5000) {
  return useQuery({
    queryKey: ["active-sessions"],
    queryFn: () => fetcher<ActiveSessionsData>("/active-sessions"),
    refetchInterval: refetchMs,
  });
}

/**
 * Per-skill activation telemetry (hits / last-used / zombie) for a profile.
 * Errors when telemetry is disabled ("telemetry-disabled") — callers treat a
 * failed query as "no usage data" and fall back to body-derived stats.
 */
export function useSkillReport(profile?: string, since = 30) {
  const qs = profile ? `?profile=${encodeURIComponent(profile)}&since=${since}` : `?since=${since}`;
  return useQuery({
    queryKey: ["skill-report", profile ?? "@active", since],
    queryFn: () => fetcher<SkillReportData>(`/skill-report${qs}`),
    retry: false,
  });
}

/**
 * The profile's real Claude Code hooks (from the materialized runtime
 * settings.json + global ~/.claude/settings.json), grouped by lifecycle event.
 */
export function useHooks(profile?: string) {
  const qs = profile ? `?profile=${encodeURIComponent(profile)}` : "";
  return useQuery({
    queryKey: ["hooks", profile ?? "@active"],
    queryFn: () => fetcher<HooksData>(`/hooks${qs}`),
  });
}

/** One hook's script source for the viewer. Only fetches when a path is set. */
export function useHookSource(scriptPath: string | null, profile?: string) {
  const qs = `?path=${encodeURIComponent(scriptPath ?? "")}` + (profile ? `&profile=${encodeURIComponent(profile)}` : "");
  return useQuery({
    queryKey: ["hook-source", scriptPath],
    queryFn: () => fetcher<HookSource>(`/hook-source${qs}`),
    enabled: !!scriptPath,
    staleTime: 30_000,
  });
}

/** Real Claude Code tool-permission rules (allow/ask/deny) from settings.json. */
export function usePermissions() {
  return useQuery({
    queryKey: ["permissions"],
    queryFn: () => fetcher<PermissionsData>("/permissions"),
  });
}

/**
 * GitHub source repos for a profile's components, with live star counts. The
 * server caches stars 6h; the hook refetches hourly so counts auto-update
 * without a reload.
 */
export function useRepos(profile?: string) {
  const qs = profile ? `?profile=${encodeURIComponent(profile)}` : "";
  return useQuery({
    queryKey: ["repos", profile ?? "@active"],
    queryFn: () => fetcher<ReposData>(`/repos${qs}`),
    staleTime: 60 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000,
  });
}

/**
 * Every Claude Code plugin installed on this machine (enabled or not),
 * auto-discovered from Claude Code's real store — a superset of the active
 * profile's declared plugins.
 */
export function useDiscoveredPlugins() {
  return useQuery({
    queryKey: ["plugins-discovered"],
    queryFn: () => fetcher<{ plugins: DiscoveredPlugin[] }>("/plugins/discovered"),
  });
}

/**
 * Marketplace catalog — the shared hosted registry merged with this checkout's
 * local library, plus per-type counts for the filter chips. Source of truth for
 * the Market view's browse list (the view prepends the user's locally-published
 * drafts on top). Rarely changes, so it caches a minute.
 */
export function useMarket() {
  return useQuery({
    queryKey: ["market"],
    queryFn: () => fetcher<MarketData>("/market"),
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Environment variables (per-folder .env, secrets masked server-side)
// ---------------------------------------------------------------------------

export type EnvKind = "secret" | "url" | "bool" | "num" | "plain";
/** One parsed var. `masked` true → `value` is the dotted mask, not the secret. */
export interface EnvVarRow { key: string; value: string; kind: EnvKind; masked: boolean }
export interface EnvFolderRow { path: string; tag: string; count: number }
export interface EnvFoldersData { folders: EnvFolderRow[] }
export interface EnvData { folder: string; tag: string; exists: boolean; vars: EnvVarRow[] }

/** The allowlisted project folders + their .env var counts (rail list). */
export function useEnvFolders() {
  return useQuery({
    queryKey: ["env-folders"],
    queryFn: () => fetcher<EnvFoldersData>("/env/folders"),
    staleTime: 30_000,
  });
}

/** Parsed vars for one folder's .env. ALWAYS masked — revealed plaintext is
 *  never cached. Both per-row and global reveal go through the one-shot
 *  fetch* helpers below into transient component state. Empty folder → no fetch. */
export function useEnv(folder: string | null) {
  return useQuery({
    queryKey: ["env", folder],
    queryFn: () => fetcher<EnvData>(`/env?folder=${encodeURIComponent(folder ?? "")}`),
    enabled: Boolean(folder),
  });
}

/**
 * One-shot fetch of a single secret's RAW value (reveal click). Kept off the
 * react-query cache so revealed plaintext never lingers in the query store; the
 * caller holds it transiently in component state.
 */
export async function fetchEnvReveal(folder: string, key: string): Promise<string> {
  const data = await fetcher<EnvData>(`/env?folder=${encodeURIComponent(folder)}&reveal=${encodeURIComponent(key)}`);
  return data.vars.find((v) => v.key === key)?.value ?? "";
}

/**
 * One-shot fetch of EVERY secret's RAW value (the global "Reveal secrets"
 * toggle). Like fetchEnvReveal, plaintext is returned for transient component
 * state and never enters the react-query cache. Returns a key→raw-value map of
 * the secret rows only (non-secrets are already unmasked in the cached query).
 */
export async function fetchEnvRevealAll(folder: string): Promise<Record<string, string>> {
  const data = await fetcher<EnvData>(`/env?folder=${encodeURIComponent(folder)}&reveal=*`);
  const out: Record<string, string> = {};
  for (const v of data.vars) if (v.kind === "secret") out[v.key] = v.value;
  return out;
}
