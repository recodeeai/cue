/** Local, read-only inventory. Never executes servers or returns their config values. */
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { canonicalCodexHome } from "./codex-config";
import { cacheDir, configDir } from "./config-paths";
import { cacheSkillPath } from "./cache";
import { cacheKey } from "./resolver-npx";
import { listProfiles, loadProfile, profileYamlPath } from "./profile-loader";
import { repoRoot } from "./repo-root";
import { createLocalSkillResolver, listAllSkillIds } from "./resolver-local";
import { parseSkillFromContent } from "./skill-router";

import type { InventoryItem, InventorySource, LocalInventoryData } from "./local-inventory-types";
interface InventoryProfile {
  name: string;
  description: string;
  path?: string;
  error?: boolean;
  skills: { ref: string; path?: string }[];
  mcps: string[];
}
interface ScanOptions {
  skillRoots: string[];
  mcpFiles: string[];
  catalogFiles?: string[];
  profiles: InventoryProfile[];
}

// Stable across refreshes without repeating absolute paths in every edge.
function fileId(kind: "skill" | "mcp", path: string): string {
  return `${kind}:${createHash("sha256").update(path).digest("hex")}`;
}

// Metadata only: standard TOML table names, not config values. Ignore quoted
// multi-line bodies so a prompt containing a fake table cannot create an MCP.
function codexMcpNames(text: string): string[] {
  const names = new Set<string>();
  let multiline = "";
  for (const line of text.split(/\r?\n/)) {
    if (!multiline) {
      const match = line.match(/^\s*\[\s*mcp_servers\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+)\s*\]\s*(?:#.*)?$/);
      if (match) {
        const token = match[1]!;
        names.add(token.startsWith('"') ? JSON.parse(token) : token.startsWith("'") ? token.slice(1, -1) : token);
      }
    }
    let quote = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (multiline) {
        if (multiline === '"""' && ch === "\\") { i++; continue; }
        if (line.startsWith(multiline, i)) { i += 2; multiline = ""; }
      } else if (quote) {
        if (quote === '"' && ch === "\\") i++;
        else if (ch === quote) quote = "";
      } else if (ch === "#") break;
      else if (line.startsWith('"""', i) || line.startsWith("'''", i)) { multiline = line.slice(i, i + 3); i += 2; }
      else if (ch === '"' || ch === "'") quote = ch;
    }
  }
  return [...names];
}

export async function scanLocalInventory(options: ScanOptions): Promise<LocalInventoryData> {
  const items = new Map<string, InventoryItem>();
  const sources: InventorySource[] = [];
  const mcpFiles = [...options.mcpFiles];
  const missingState = (err: unknown): InventorySource["state"] => (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  for (const root of new Set(options.skillRoots.map(x => resolve(x)))) {
    const source: InventorySource = { path: root, state: "scanned" };
    sources.push(source);
    const visited = new Set<string>();
    let budget = 12000;
    async function walk(dir: string, depth: number): Promise<void> {
      if (--budget < 0 || depth > 12) { source.state = "partial"; return; }
      try {
        const canonical = await realpath(dir);
        if (visited.has(canonical)) return;
        visited.add(canonical);
        const entries = await readdir(dir, { withFileTypes: true });
        if (entries.some(e => e.name === ".mcp.json" && e.isFile())) mcpFiles.push(join(dir, ".mcp.json"));
        if (entries.some(e => e.name === "SKILL.md")) {
          const file = await realpath(join(dir, "SKILL.md"));
          const id = fileId("skill", file);
          const existing = items.get(id);
          if (existing) { if (!existing.sources.includes(root)) existing.sources.push(root); return; }
          if ((await stat(file)).size > 1024 * 1024) { source.state = "partial"; return; }
          const parsed = parseSkillFromContent(basename(dir), await readFile(file, "utf8"));
          items.set(id, { id, path: file, kind: "skill", name: parsed.name, description: parsed.rawDescription.slice(0, 500), state: "installed", sources: [root], related: [] });
          return; // A skill's own examples/vendor tree isn't another installation root.
        }
        for (const entry of entries) {
          if (["node_modules", ".git", ".omx", "dist", "coverage"].includes(entry.name)) continue;
          if (entry.isDirectory() || entry.isSymbolicLink()) await walk(join(dir, entry.name), depth + 1);
        }
      } catch (err) { source.state = dir === root ? missingState(err) : "partial"; }
    }
    await walk(root, 0);
  }
  for (const file of new Set(mcpFiles.map(x => resolve(x)))) {
    const source: InventorySource = { path: file, state: "scanned" };
    sources.push(source);
    try {
      if ((await stat(file)).size > 2 * 1024 * 1024) { source.state = "partial"; continue; }
      const text = await readFile(file, "utf8");
      let names: string[];
      if (file.endsWith(".toml")) {
        names = codexMcpNames(text);
        source.state = "partial"; // Table declarations only; not a full TOML validator.
      } else {
        const raw: unknown = JSON.parse(text);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid-config");
        const obj = raw as Record<string, unknown>;
        const servers = obj.mcpServers ?? obj.servers ?? (basename(file) === ".mcp.json" ? obj : {});
        if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("invalid-servers");
        names = Object.keys(servers).filter(name => {
          const value = (servers as Record<string, unknown>)[name];
          return value !== null && typeof value === "object" && !Array.isArray(value);
        });
      }
      for (const name of names) {
        const id = fileId("mcp", JSON.stringify([file, name]));
        const catalog = options.catalogFiles?.includes(file);
        items.set(id, { id, kind: "mcp", name, description: catalog ? "Bundled catalog entry · not an active installation" : "Configuration found · availability not probed", state: catalog ? "available" : "configured", sources: [file], related: [] });
      }
    } catch (err) { source.state = missingState(err); }
  }
  for (const profile of options.profiles) {
    const id = `profile:${profile.name}`;
    const item: InventoryItem = { id, kind: "profile", name: profile.name, description: profile.description, state: profile.error ? "unreadable" : "installed", sources: profile.path ? [profile.path] : [], related: [] };
    items.set(id, item);
    if (profile.path) sources.push({ path: profile.path, state: profile.error ? "unreadable" : "scanned" });
    const link = (target: InventoryItem) => {
      if (!target.related.includes(id)) target.related.push(id);
      if (!item.related.includes(target.id)) item.related.push(target.id);
    };
    for (const skill of profile.skills) {
      let target: InventoryItem | undefined;
      if (skill.path) {
        try { target = items.get(fileId("skill", await realpath(skill.path))); } catch { /* unresolved reference */ }
      }
      const refId = `skill-ref:${skill.ref}`;
      target ??= items.get(refId);
      if (!target) {
        target = { id: refId, kind: "skill", name: skill.ref, description: "Profile reference · no matching local file resolved", state: "referenced", sources: [], related: [] };
        items.set(refId, target);
      }
      link(target);
    }
    for (const name of profile.mcps) {
      const matches = [...items.values()].filter(x => x.kind === "mcp" && x.name === name);
      if (!matches.length) {
        const target: InventoryItem = { id: `mcp-ref:${name}`, kind: "mcp", name, description: "Profile reference · no matching configuration found", state: "referenced", sources: [], related: [] };
        items.set(target.id, target);
        matches.push(target);
      }
      matches.forEach(link);
    }
  }
  return { items: [...items.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), sources, scannedAt: new Date().toISOString() };
}

export async function collectLocalInventory(): Promise<LocalInventoryData> {
  const home = homedir();
  const cwd = process.cwd();
  const codex = canonicalCodexHome();
  const claude = process.env.CUE_CLAUDE_HOME ?? join(home, ".claude");
  const agentHomes = [...new Set([codex, join(home, ".codex"), claude, process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR].filter((x): x is string => !!x))];
  try {
    for (const entry of await readdir(join(configDir(), "runtime"), { withFileTypes: true })) {
      if (entry.isDirectory()) for (const agent of ["codex", "claude"]) agentHomes.push(join(configDir(), "runtime", entry.name, agent));
    }
  } catch { /* runtime may not have been materialized */ }
  const skillRoots = [join(repoRoot(), "resources/skills/skills"), join(cacheDir(), "npx"), join(home, ".agents/skills"), join(cwd, ".agents/skills"), join(cwd, ".claude/skills"), join(cwd, ".codex/skills")];
  const mcpFiles = [join(home, ".claude.json"), join(cwd, ".mcp.json"), join(home, ".cursor/mcp.json"), join(cwd, ".cursor/mcp.json")];
  for (const dir of new Set(agentHomes)) {
    skillRoots.push(join(dir, "skills"), join(dir, "plugins/cache"));
    mcpFiles.push(join(dir, "config.toml"), join(dir, ".mcp.json"), join(dir, "settings.json"));
  }
  const catalogFiles = ["claude.sanitized.json", "claude_runtime.sanitized.json", "codex.sanitized.json"].map(file => join(repoRoot(), "resources/mcps/configs", file));
  mcpFiles.push(...catalogFiles);
  const resolveSkill = createLocalSkillResolver();
  let allSkillIds: string[] | undefined;
  const profiles: InventoryProfile[] = [];
  for (const name of await listProfiles()) {
    const path = profileYamlPath(name);
    try {
      const p = await loadProfile(name);
      const localRefs: string[] = [];
      for (const ref of p.skills.local) {
        if (ref.id === "*/*") { allSkillIds ??= await listAllSkillIds(); localRefs.push(...allSkillIds); }
        else localRefs.push(ref.id);
      }
      const skills = await Promise.all(localRefs.map(async ref => {
        try { return { ref, path: join(await resolveSkill(ref), "SKILL.md") }; }
        catch { return { ref }; }
      }));
      const remote = p.skills.npx.flatMap(ref => ref.skills.map(skill => ({ ref: `${ref.repo}/${skill}`, path: join(cacheSkillPath({}, cacheKey(ref.repo, ref.pin), skill), "SKILL.md") })));
      profiles.push({ name, path, description: p.description, skills: [...skills, ...remote], mcps: p.mcps.map(m => m.id) });
    } catch { profiles.push({ name, path, description: "Profile could not be loaded", error: true, skills: [], mcps: [] }); }
  }
  return scanLocalInventory({ skillRoots, mcpFiles, catalogFiles, profiles });
}
