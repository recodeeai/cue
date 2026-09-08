/**
 * Builder for the Codex runtime `config.toml`.
 *
 * cue points `CODEX_HOME` at the per-profile runtime dir, so
 * `$CODEX_HOME/config.toml` is the ONLY config a cue-launched Codex reads — the
 * canonical `~/.codex/config.toml` is invisible to it. Writing just
 * `[mcp_servers.*]` there (the original behavior) therefore dropped every
 * autonomy knob the user had configured: `model`, `model_reasoning_effort`,
 * `model_context_window`, `model_auto_compact_token_limit`, `[features]`. The
 * observable symptom was Codex sessions running at the model's default
 * reasoning effort instead of the configured one, which makes turns much
 * shorter than the equivalent Claude session.
 *
 * The file is rebuilt from three layers, last wins:
 *   1. base — top-level scalars, `[features]`, and `[[skills.config]]` from
 *      the user's persistent `$CODEX_HOME/config.toml`
 *   2. the profile's `codex:` block (per-profile override)
 *   3. cue-owned `[mcp_servers.*]` — never inherited, cue owns MCP wiring
 *
 * Base values are carried as their VERBATIM TOML source text, so we never have
 * to round-trip Codex's value types (dates, floats, multi-line arrays, inline
 * tables) through a parser we'd have to keep in step with Codex.
 */

import {
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, relative, resolve, sep, win32 } from "node:path";

import type { CodexProfileConfig, CodexScalar } from "../../profiles/_types";
import { configDir } from "./config-paths";

export type { CodexProfileConfig, CodexScalar };

export interface CanonicalCodexHomeOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  runtimeRoot?: string;
  platform?: NodeJS.Platform;
}

function isInsideRuntime(
  candidate: string,
  runtimeRoot: string,
  platform: NodeJS.Platform,
): boolean {
  const pathApi = platform === "win32" ? win32 : posix;
  let root = pathApi.resolve(runtimeRoot);
  let path = pathApi.resolve(candidate);
  if (platform === "win32") {
    root = root.toLowerCase();
    path = path.toLowerCase();
  }
  const rel = pathApi.relative(root, path);
  return rel === "" || (
    rel !== ".." &&
    !rel.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(rel)
  );
}

/**
 * The user's persistent Codex home.
 *
 * Honor an explicit `CODEX_HOME` so installs that keep credentials outside
 * `~/.codex` continue using the same account. A cue-managed runtime is never a
 * persistent source: nested launches inherit that temporary `CODEX_HOME`, so
 * accepting it would make generated state inherit from itself. The outer
 * launch carries the original home in `CUE_CANONICAL_CODEX_HOME` for that case.
 */
export function canonicalCodexHome(
  options: CanonicalCodexHomeOptions = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const fallback = pathApi.join(options.homeDir ?? homedir(), ".codex");
  const configured = env.CODEX_HOME?.trim();
  if (!configured) return fallback;

  const runtimeRoot = options.runtimeRoot ?? join(configDir(), "runtime");
  if (!isInsideRuntime(configured, runtimeRoot, platform)) return configured;

  const preserved = env.CUE_CANONICAL_CODEX_HOME?.trim();
  return preserved && !isInsideRuntime(preserved, runtimeRoot, platform)
    ? preserved
    : fallback;
}

/** The user's own `config.toml` — the base a runtime config inherits from. */
export function canonicalCodexConfigPath(
  options: CanonicalCodexHomeOptions = {},
): string {
  const pathApi = (options.platform ?? process.platform) === "win32" ? win32 : posix;
  return pathApi.join(canonicalCodexHome(options), "config.toml");
}

/** The user's persistent Codex authentication file. */
export function canonicalCodexAuthPath(
  options: CanonicalCodexHomeOptions = {},
): string {
  const pathApi = (options.platform ?? process.platform) === "win32" ? win32 : posix;
  return pathApi.join(canonicalCodexHome(options), "auth.json");
}

/** Inheritable slice of a base `config.toml`: raw value text, keyed by key. */
export interface BaseCodexConfig {
  top: Record<string, string>;
  features: Record<string, string>;
  /** Verbatim `[[skills.config]]` blocks from the user's canonical config. */
  skillsConfig: string[];
}

const KEY_VALUE = /^\s*([A-Za-z0-9_.\-"']+)\s*=\s*(.*)$/;
const TABLE_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?/;
const SKILLS_CONFIG_HEADER = /^\s*\[\[\s*skills\.config\s*\]\]\s*(?:#.*)?$/;

/** Preserve Codex-written approvals in this runtime only, never from the base config.
 * Copy table blocks verbatim: do not manufacture approvals or migrate hook hashes.
 */
export function extractRuntimeCodexState(text: string): string {
  const blocks: string[] = [];
  const localTable = /^\s*\[\s*(?:projects\s*(?:\.|\])|hooks\s*\.\s*state\s*(?:\.|\]))/;
  let block: string[] = [];
  let copying = false;
  let quote = "";
  let depth = 0;
  const flush = () => {
    while (block.at(-1)?.trim() === "") block.pop();
    if (block.length > 0) blocks.push(block.join("\n"));
    block = [];
  };
  for (const line of text.split("\n")) {
    if (!quote && depth === 0 && TABLE_HEADER.test(line)) {
      flush();
      copying = localTable.test(line);
    }
    if (copying) block.push(line);
    // Lexical boundaries only, not a TOML reserializer. In particular a
    // table-looking line inside a multiline string is never an approval.
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quote) {
        if (quote[0] === '"' && ch === "\\") { i++; continue; }
        if (line.startsWith(quote, i)) {
          i += quote.length - 1;
          if (quote.length === 3) while (line[i + 1] === quote[0]) i++;
          quote = "";
        }
      } else if (ch === "#") break;
      else if (ch === '"' || ch === "'") {
        quote = line.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
        i += quote.length - 1;
      } else if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
    }
    if (quote.length === 1 || depth < 0) throw new TypeError("Invalid runtime Codex TOML boundaries");
  }
  if (quote || depth !== 0) throw new TypeError("Unterminated runtime Codex TOML value");
  flush();
  return blocks.length > 0 ? blocks.join("\n\n") + "\n" : "";
}

/** Keep user-authored skill enablement blocks without round-tripping TOML. */
function extractSkillsConfigBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!SKILLS_CONFIG_HEADER.test(lines[i]!)) continue;
    const block = [lines[i]!.trimEnd()];
    while (i + 1 < lines.length && !TABLE_HEADER.test(lines[i + 1]!)) {
      block.push(lines[++i]!.trimEnd());
    }
    while (block.at(-1) === "") block.pop();
    blocks.push(block.join("\n"));
  }
  return blocks;
}

/**
 * Net bracket/brace depth a line adds, ignoring quoted spans and `#` comments.
 * Used to pull multi-line arrays and inline tables in whole.
 */
function structuralDepth(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "#") break;
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
  }
  return depth;
}

/**
 * Extract the inheritable slice of a `config.toml`: top-level keys (everything
 * before the first table header), `[features]`, and `[[skills.config]]`. Every
 * other table is dropped on purpose — `[mcp_servers.*]` stays cue-owned, and
 * the rest (`[projects.*]`, `[model_providers.*]`, …) is machine-local state we
 * don't want fanned out into every profile runtime.
 */
export function parseBaseCodexConfig(text: string): BaseCodexConfig {
  const top: Record<string, string> = {};
  const features: Record<string, string> = {};
  const skillsConfig = extractSkillsConfigBlocks(text);
  const lines = text.split("\n");
  let table: string | null = null; // null = top-level region

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const header = TABLE_HEADER.exec(line);
    if (header) {
      table = header[1]!;
      continue;
    }
    if (table !== null && table !== "features") continue;

    const kv = KEY_VALUE.exec(line);
    if (!kv) continue;
    const key = kv[1]!.replace(/^["']|["']$/g, "");
    let value = kv[2]!.trim();

    // Pull continuation lines while the value has an unclosed [ or {.
    let depth = structuralDepth(value);
    while (depth > 0 && i + 1 < lines.length) {
      const next = lines[++i]!;
      value += "\n" + next;
      depth += structuralDepth(next);
    }
    if (table === "features") features[key] = value;
    else top[key] = value;
  }
  return { top, features, skillsConfig };
}

export interface DiscoverCodexSkillFilesInput {
  cwd: string;
  /** Directory containing the resolving `.cue.profile`; normally the repo root. */
  pinDir: string;
  homeDir?: string;
}

const SKILL_SCAN_SKIP_DIRS = new Set(["node_modules"]);

function collectSkillFiles(root: string, output: Set<string>): void {
  const stack = [root];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
      continue;
    }
    if (visited.has(realDir)) continue;
    visited.add(realDir);

    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKILL_SCAN_SKIP_DIRS.has(entry.name)) {
          stack.push(path);
        }
        continue;
      }
      if (entry.isSymbolicLink()) {
        try {
          if (statSync(path).isDirectory()) {
            if (!entry.name.startsWith(".") && !SKILL_SCAN_SKIP_DIRS.has(entry.name)) {
              stack.push(path);
            }
            continue;
          }
        } catch {
          continue;
        }
      }
      if (entry.name === "SKILL.md") {
        try {
          const info = lstatSync(path);
          if (info.isFile() || info.isSymbolicLink()) {
            output.add(resolve(path));
          }
        } catch {
          /* raced with an install/uninstall — ignore this entry */
        }
      }
    }
  }
}

/**
 * Discover skills Codex would auto-load outside `$CODEX_HOME/skills`.
 *
 * Codex scans `$HOME/.agents/skills` plus `.agents/skills` from the current
 * directory up to the repository root. cue owns the active profile, so these
 * paths are disabled in the generated runtime config to prevent unrelated
 * skills from bypassing the profile and exhausting Codex's description budget.
 */
export function discoverCodexSkillFiles(input: DiscoverCodexSkillFilesInput): string[] {
  const output = new Set<string>();
  collectSkillFiles(join(input.homeDir ?? homedir(), ".agents", "skills"), output);

  const cwd = resolve(input.cwd);
  const pinDir = resolve(input.pinDir);
  const rel = relative(pinDir, cwd);
  const pinContainsCwd = rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
  let dir = cwd;
  for (;;) {
    collectSkillFiles(join(dir, ".agents", "skills"), output);
    if (!pinContainsCwd || dir === pinDir) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return [...output].sort();
}

/** Render a JS value as TOML source. */
export function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => `${JSON.stringify(key)} = ${tomlValue(nested)}`);
    return `{ ${entries.join(", ")} }`;
  }
  throw new TypeError(`Unsupported TOML value: ${String(value)}`);
}

export interface BuildCodexConfigInput {
  /** Raw text of the base `config.toml` to inherit from. Omit for none. */
  baseText?: string;
  /** The profile's `codex:` block — wins over the base, key by key. */
  overrides?: CodexProfileConfig;
  /** cue-owned MCP servers, rendered as `[mcp_servers.<id>]` tables. */
  mcpServers: Record<string, unknown>;
  /** Auto-discovered user/repo skills excluded from this cue profile. */
  disabledSkillPaths?: string[];
  /** Materialized cue profile skills, emitted last so they win over base disables. */
  enabledSkillPaths?: string[];
}

/**
 * Compose the runtime `config.toml`. Top-level keys are emitted first (TOML
 * requires it — anything after a table header belongs to that table), then
 * `[features]`, skill enablement, then the MCP tables.
 */
export function buildCodexConfigToml(input: BuildCodexConfigInput): string {
  const base = input.baseText
    ? parseBaseCodexConfig(input.baseText)
    : { top: {}, features: {}, skillsConfig: [] };
  const overrides = input.overrides ?? {};

  const top = new Map<string, string>(Object.entries(base.top));
  const features = new Map<string, string>(Object.entries(base.features));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (key === "features") {
      for (const [flag, on] of Object.entries(value as Record<string, boolean>)) {
        features.set(flag, tomlValue(on));
      }
      continue;
    }
    top.set(key, tomlValue(value));
  }

  const out: string[] = [];
  for (const [key, value] of top) out.push(`${key} = ${value}`);
  if (top.size > 0) out.push("");
  if (features.size > 0) {
    out.push("[features]");
    for (const [key, value] of features) out.push(`${key} = ${value}`);
    out.push("");
  }
  for (const block of base.skillsConfig) {
    out.push(block, "");
  }
  const enabledSkillPaths = new Set(input.enabledSkillPaths ?? []);
  const appendSkillConfig = (path: string, enabled: boolean): void => {
    out.push("[[skills.config]]", `path = ${tomlValue(path)}`, `enabled = ${enabled}`, "");
  };
  for (const path of [...new Set(input.disabledSkillPaths ?? [])].sort()) {
    if (!enabledSkillPaths.has(path)) appendSkillConfig(path, false);
  }
  for (const path of [...enabledSkillPaths].sort()) appendSkillConfig(path, true);
  for (const [id, val] of Object.entries(input.mcpServers)) {
    out.push(`[mcp_servers.${id}]`);
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out.push(`${k} = ${tomlValue(v)}`);
    }
    out.push("");
  }
  return out.join("\n");
}
